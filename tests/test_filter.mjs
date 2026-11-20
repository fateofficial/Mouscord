import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const rootDir = path.resolve(import.meta.dirname, '..');
const filterSrc = fs.readFileSync(path.join(rootDir, 'src/js/filter.js'), 'utf8');

const DISCORD_EPOCH = 1420070400000n;
const SEC  = 1000;
const MIN  = 60 * SEC;
const HOUR = 3600 * SEC;
const DAY  = 86400 * SEC;
const WEEK = 7 * DAY;
const MON  = 30 * DAY;
const YEAR = 365 * DAY;

// Fixed reference "now" so all snowflake age tests are 100% deterministic
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0, 0);

function makeSnowflake(tsMs, lowBits = 0n) {
  const offset = BigInt(Math.trunc(tsMs)) - DISCORD_EPOCH;
  return ((offset << 22n) | lowBits).toString();
}

function makeChatId(tsMs, channelId = '112233445566778899', lowBits = 17n) {
  return `chat-messages-${channelId}-${makeSnowflake(tsMs, lowBits)}`;
}

function loadFilter() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  const res = vm.runInContext(filterSrc, sandbox);
  return { sandbox, filter: sandbox.window.__dcFilter, mountResult: res };
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    failed++;
    process.exitCode = 1;
  }
}

// Shared rich message fixture covering all shapes & edge cases
function buildSampleMessages() {
  return [
    {
      id: makeChatId(NOW - 10 * MIN),
      author: 'DemoUser',
      text: 'Just posted a quick update https://example.com/docs',
      isMine: true,
      isEphemeral: false,
      actionType: 'delete',
      canRemove: true,
      hasLink: false, // link should still be detected via URL regex in text
      hasMedia: false,
      hasEmbed: false
    },
    {
      id: makeChatId(NOW - 5 * HOUR),
      author: 'DemoUser',
      text: 'Screenshot of the build',
      isMine: true,
      isEphemeral: false,
      actionType: 'delete',
      canRemove: true,
      hasLink: false,
      hasMedia: true,
      hasEmbed: false
    },
    {
      id: makeChatId(NOW - 3 * DAY),
      author: 'Clyde',
      text: 'Only you can see this — invalid command /shrug',
      isMine: false,
      isEphemeral: true,
      actionType: 'dismiss',
      canRemove: true,
      hasLink: false,
      hasMedia: false,
      hasEmbed: false
    },
    {
      id: makeChatId(NOW - 15 * DAY),
      author: 'DemoUser',
      text: 'Old project milestone notes with spam alert',
      isMine: true,
      isEphemeral: false,
      actionType: 'delete',
      canRemove: true,
      hasLink: true,
      hasMedia: false,
      hasEmbed: true
    },
    {
      id: makeChatId(NOW - 60 * DAY),
      author: 'Alice Smith',
      text: '(embed / attachment)',
      isMine: false,
      isEphemeral: false,
      actionType: 'readonly',
      canRemove: false,
      hasLink: false,
      hasMedia: false, // media should still be detected via "(embed / attachment)"
      hasEmbed: false
    },
    {
      id: makeChatId(NOW - 200 * DAY),
      author: 'Bob',
      text: 'Check http://legacy.site/path at 12:30 today',
      isMine: false,
      isEphemeral: false,
      actionType: 'readonly',
      canRemove: false,
      hasLink: false,
      hasMedia: false,
      hasEmbed: true
    },
    {
      id: makeChatId(NOW - 400 * DAY),
      author: 'DemoUser',
      text: 'Very old archive message from over a year ago',
      isMine: true,
      isEphemeral: false,
      actionType: 'delete',
      canRemove: true,
      hasLink: false,
      hasMedia: false,
      hasEmbed: false
    }
  ];
}

console.log('Running filter.js unit tests...\n');

// 1. Lifecycle & Exports
test('mounts window.__dcFilter v1 idempotently and supports destroy()', () => {
  const { sandbox, filter, mountResult } = loadFilter();
  assert.equal(mountResult, 'mounted');
  assert.ok(filter);
  assert.equal(filter.version, 1);
  assert.equal(filter.DISCORD_EPOCH, 1420070400000);

  // Idempotent second evaluation
  const second = vm.runInContext(filterSrc, sandbox);
  assert.equal(second, 'already-mounted');
  assert.strictEqual(sandbox.window.__dcFilter, filter);

  // Destroy removes global and allows clean remount
  filter.destroy();
  assert.equal(sandbox.window.__dcFilter, undefined);
  const third = vm.runInContext(filterSrc, sandbox);
  assert.equal(third, 'mounted');
  assert.equal(sandbox.window.__dcFilter.version, 1);

  // Upgrading from an older version calls prior destroy()
  let oldDestroyed = false;
  sandbox.window.__dcFilter = { version: 0, destroy() { oldDestroyed = true; } };
  const upgraded = vm.runInContext(filterSrc, sandbox);
  assert.equal(upgraded, 'mounted');
  assert.equal(oldDestroyed, true);
  assert.equal(sandbox.window.__dcFilter.version, 1);
});

test('exports exact QUICK_CHIPS presets', () => {
  const { filter } = loadFilter();
  assert.deepEqual(
    Array.from(filter.QUICK_CHIPS, c => ({ id: c.id, label: c.label, token: c.token })),
    [
      { id: 'mine',     label: 'Mine',        token: 'is:mine' },
      { id: 'recent24', label: '<24h',        token: 'age:<24h' },
      { id: 'old14',    label: '>14d',        token: 'age:>14d' },
      { id: 'range',    label: '1d-1y',       token: 'age:1d-1y' },
      { id: 'links',    label: 'Links',       token: 'has:link' },
      { id: 'media',    label: 'Media',       token: 'has:media' },
      { id: 'dismiss',  label: 'Dismissible', token: 'is:dismiss' }
    ]
  );
});

// 2. Snowflake timestamp extraction
test('extractSnowflake and getSnowflakeTimestampMs decode exact milliseconds', () => {
  const { filter } = loadFilter();
  const exactMs = Date.UTC(2025, 4, 15, 8, 23, 45, 789);
  const sf = makeSnowflake(exactMs, 0x3fffffn); // max low bits should shift off cleanly
  const chatId = `chat-messages-987654321098765432-${sf}`;

  assert.equal(filter.extractSnowflake(chatId), sf);
  assert.equal(filter.extractSnowflake(sf), sf);
  assert.equal(filter.getSnowflakeTimestampMs(chatId), exactMs);
  assert.equal(filter.getSnowflakeTimestampMs(sf), exactMs);
  assert.equal(filter.getMessageTimestampMs({ id: chatId }), exactMs);
  assert.equal(filter.getMessageTimestampMs({ id: 'bad', timestampMs: 1700000000123 }), 1700000000123);

  assert.equal(filter.extractSnowflake(''), null);
  assert.equal(filter.extractSnowflake(null), null);
  assert.equal(filter.extractSnowflake('chat-messages-abc-123'), null);
  assert.equal(filter.getSnowflakeTimestampMs('not-a-snowflake'), null);
});

// 3. Duration parser
test('parseDurationMs handles all units, decimals, compounds, case-insensitivity, and invalid inputs', () => {
  const { filter } = loadFilter();
  assert.equal(filter.parseDurationMs('1s'), SEC);
  assert.equal(filter.parseDurationMs('45s'), 45 * SEC);
  assert.equal(filter.parseDurationMs('1m'), MIN);
  assert.equal(filter.parseDurationMs('30m'), 30 * MIN);
  assert.equal(filter.parseDurationMs('1h'), HOUR);
  assert.equal(filter.parseDurationMs('24H'), 24 * HOUR);
  assert.equal(filter.parseDurationMs('1d'), DAY);
  assert.equal(filter.parseDurationMs('14D'), 14 * DAY);
  assert.equal(filter.parseDurationMs('1w'), WEEK);
  assert.equal(filter.parseDurationMs('2w'), 2 * WEEK);
  assert.equal(filter.parseDurationMs('1mo'), MON);
  assert.equal(filter.parseDurationMs('6MO'), 6 * MON);
  assert.equal(filter.parseDurationMs('1y'), YEAR);
  assert.equal(filter.parseDurationMs('1.5h'), 90 * MIN);
  assert.equal(filter.parseDurationMs('1h30m'), 90 * MIN);
  assert.equal(filter.parseDurationMs('0s'), 0);

  // Invalid inputs return null
  for (const bad of ['', '   ', '14', '10x', '-5d', '1d-1y', '1ms', 'abc', null, undefined, 1000]) {
    assert.equal(filter.parseDurationMs(bad), null, `expected null for ${String(bad)}`);
  }
});

// 4. Age spec parser & boundary precision
test('parseAgeSpec supports ranges, reversed bounds, comparisons, shorthand, and rejects invalid specs', () => {
  const { filter } = loadFilter();

  // Ranges
  const r1 = filter.parseAgeSpec('1d-1y');
  assert.equal(r1.kind, 'range');
  assert.equal(r1.minMs, DAY);
  assert.equal(r1.maxMs, YEAR);
  assert.equal(filter.matchesAgeSpec(DAY, r1), true);
  assert.equal(filter.matchesAgeSpec(YEAR, r1), true);
  assert.equal(filter.matchesAgeSpec(DAY - 1, r1), false);
  assert.equal(filter.matchesAgeSpec(YEAR + 1, r1), false);

  // Reversed range normalized gracefully
  const rRev = filter.parseAgeSpec('1y-1d');
  assert.equal(rRev.kind, 'range');
  assert.equal(rRev.minMs, DAY);
  assert.equal(rRev.maxMs, YEAR);
  assert.equal(filter.matchesAgeSpec(10 * DAY, rRev), true);
  assert.equal(filter.matchesAgeSpec(12 * HOUR, rRev), false);

  const r2 = filter.parseAgeSpec('2h-7d');
  assert.equal(r2.minMs, 2 * HOUR);
  assert.equal(r2.maxMs, 7 * DAY);

  const r3 = filter.parseAgeSpec('14d-6mo');
  assert.equal(r3.minMs, 14 * DAY);
  assert.equal(r3.maxMs, 6 * MON);

  // Comparisons
  const gt = filter.parseAgeSpec('>14d');
  assert.equal(filter.matchesAgeSpec(14 * DAY, gt), false);
  assert.equal(filter.matchesAgeSpec(14 * DAY + 1, gt), true);

  const gte = filter.parseAgeSpec('>=7d');
  assert.equal(filter.matchesAgeSpec(7 * DAY - 1, gte), false);
  assert.equal(filter.matchesAgeSpec(7 * DAY, gte), true);

  const lt = filter.parseAgeSpec('<24h');
  assert.equal(filter.matchesAgeSpec(24 * HOUR, lt), false);
  assert.equal(filter.matchesAgeSpec(24 * HOUR - 1, lt), true);
  assert.equal(filter.matchesAgeSpec(-500, lt), true); // slight clock skew clamped to 0

  const lte = filter.parseAgeSpec('<=30m');
  assert.equal(filter.matchesAgeSpec(30 * MIN, lte), true);
  assert.equal(filter.matchesAgeSpec(30 * MIN + 1, lte), false);

  // Exact shorthand (age:7d => <= 7d)
  const sh = filter.parseAgeSpec('7d');
  assert.equal(sh.shorthand, true);
  assert.equal(filter.matchesAgeSpec(0, sh), true);
  assert.equal(filter.matchesAgeSpec(7 * DAY, sh), true);
  assert.equal(filter.matchesAgeSpec(7 * DAY + 1, sh), false);

  // Invalid specs
  for (const bad of ['', 'abc', '>', '>=', '1d-', '-1d', '1d-2d-3d', '>1d-2d', '10z', null]) {
    assert.equal(filter.parseAgeSpec(bad), null, `expected null for ${String(bad)}`);
  }
});

// 5. user: / from: directives
test('user: and from: directives match author substring, quoted names, and :me', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();

  const mine1 = filter.filterMessages(msgs, 'user:me', NOW);
  assert.equal(mine1.error, null);
  assert.equal(mine1.items.length, 4);
  assert.ok(mine1.items.every(m => m.isMine === true));

  const mine2 = filter.filterMessages(msgs, 'FROM:ME', NOW);
  assert.equal(mine2.items.length, 4);

  const clyde = filter.filterMessages(msgs, 'user:clyde', NOW);
  assert.equal(clyde.items.length, 1);
  assert.equal(clyde.items[0].author, 'Clyde');

  const alice = filter.filterMessages(msgs, 'from:"Alice Smith"', NOW);
  assert.equal(alice.items.length, 1);
  assert.equal(alice.items[0].author, 'Alice Smith');

  // Quoted "me" matches author text literally rather than isMine shorthand
  const quotedMe = filter.filterMessages(
    [{ id: makeChatId(NOW), author: 'Melissa', text: 'hi', isMine: false }, msgs[0]],
    'user:"me"',
    NOW
  );
  assert.equal(quotedMe.items.length, 1);
  assert.equal(quotedMe.items[0].author, 'Melissa');

  // Negated user filters
  const noClyde = filter.filterMessages(msgs, '-user:clyde', NOW);
  assert.equal(noClyde.items.length, 6);
  assert.ok(noClyde.items.every(m => m.author !== 'Clyde'));

  const notMe = filter.filterMessages(msgs, '-from:me', NOW);
  assert.equal(notMe.items.length, 3);
  assert.ok(notMe.items.every(m => m.isMine !== true));
});

// 6. age: filtering on messages via snowflakes
test('age: filters messages accurately by snowflake timestamp', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();
  // Ages in fixture: 10m, 5h, 3d, 15d, 60d, 200d, 400d

  const recent24 = filter.filterMessages(msgs, 'age:<24h', NOW);
  assert.equal(recent24.items.length, 2); // 10m, 5h

  const lte30m = filter.filterMessages(msgs, 'age:<=30m', NOW);
  assert.equal(lte30m.items.length, 1); // 10m

  const shorthand7d = filter.filterMessages(msgs, 'age:7d', NOW);
  assert.equal(shorthand7d.items.length, 3); // 10m, 5h, 3d

  const old14 = filter.filterMessages(msgs, 'age:>14d', NOW);
  assert.equal(old14.items.length, 4); // 15d, 60d, 200d, 400d

  const range1d1y = filter.filterMessages(msgs, 'age:1d-1y', NOW);
  assert.equal(range1d1y.items.length, 4); // 3d, 15d, 60d, 200d

  const reversedRange = filter.filterMessages(msgs, 'age:1y-1d', NOW);
  assert.deepEqual(reversedRange.items, range1d1y.items);

  const range14d6mo = filter.filterMessages(msgs, 'age:14d-6mo', NOW);
  assert.equal(range14d6mo.items.length, 2); // 15d, 60d (6mo = 180d, so 200d excluded)

  const negRecent = filter.filterMessages(msgs, '-age:<1d', NOW);
  assert.equal(negRecent.items.length, 5); // 3d, 15d, 60d, 200d, 400d

  // Invalid age syntax returns error safely and fails closed (0 items)
  const badAge = filter.filterMessages(msgs, 'age:nonsense', NOW);
  assert.ok(badAge.error);
  assert.equal(badAge.items.length, 0);

  // Message without a valid snowflake does not match positive age: filter
  const noSf = [{ id: 'invalid-id', author: 'Test', text: 'hi', isMine: true }];
  assert.equal(filter.filterMessages(noSf, 'age:<24h', NOW).items.length, 0);
  assert.equal(filter.filterMessages(noSf, '-age:<24h', NOW).items.length, 1);
});

// 7. is: directives
test('is: directives support mine, other, dismiss/ephemeral, deletable, and negation', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();

  assert.equal(filter.filterMessages(msgs, 'is:mine', NOW).items.length, 4);
  assert.equal(filter.filterMessages(msgs, 'is:other', NOW).items.length, 3);

  const dismiss = filter.filterMessages(msgs, 'is:dismiss', NOW);
  assert.equal(dismiss.items.length, 1);
  assert.equal(dismiss.items[0].author, 'Clyde');

  const ephemeral = filter.filterMessages(msgs, 'is:ephemeral', NOW);
  assert.deepEqual(ephemeral.items, dismiss.items);

  const deletable = filter.filterMessages(msgs, 'is:deletable', NOW);
  assert.equal(deletable.items.length, 5); // 4 mine + 1 dismissible Clyde

  const notDeletable = filter.filterMessages(msgs, '-is:deletable', NOW);
  assert.equal(notDeletable.items.length, 2); // Alice + Bob readonly

  const notDismiss = filter.filterMessages(msgs, '-is:dismiss', NOW);
  assert.equal(notDismiss.items.length, 6);

  // Unknown is: flag fails safely with error
  const badIs = filter.filterMessages(msgs, 'is:unknownflag', NOW);
  assert.ok(badIs.error);
  assert.equal(badIs.items.length, 0);
});

// 8. has: directives
test('has: directives match link, media/image, embed, fallback detectors, and negation', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();

  // has:link checks m.hasLink OR https?:// in m.text -> msg[0] (https://), msg[3] (hasLink:true), msg[5] (http://)
  const links = filter.filterMessages(msgs, 'has:link', NOW);
  assert.equal(links.items.length, 3);

  const noLinks = filter.filterMessages(msgs, '-has:link', NOW);
  assert.equal(noLinks.items.length, 4);

  // has:media / has:image checks m.hasMedia OR "(embed / attachment)" -> msg[1] (hasMedia:true), msg[4] (placeholder text)
  const media = filter.filterMessages(msgs, 'has:media', NOW);
  assert.equal(media.items.length, 2);

  const image = filter.filterMessages(msgs, 'has:image', NOW);
  assert.deepEqual(image.items, media.items);

  const noMedia = filter.filterMessages(msgs, '-has:media', NOW);
  assert.equal(noMedia.items.length, 5);

  // has:embed -> msg[3] and msg[5]
  const embeds = filter.filterMessages(msgs, 'has:embed', NOW);
  assert.equal(embeds.items.length, 2);

  const noEmbeds = filter.filterMessages(msgs, '-has:embed', NOW);
  assert.equal(noEmbeds.items.length, 5);

  // Unknown has: flag fails safely with error
  const badHas = filter.filterMessages(msgs, 'has:bogus', NOW);
  assert.ok(badHas.error);
  assert.equal(badHas.items.length, 0);
});

// 9. Regex literals & invalid regex safety
test('/regex/flags matches text & author, supports spaces/escapes/g-flag, negation, and catches invalid regex safely', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();

  // Case-insensitive regex matching text
  const spam = filter.filterMessages(msgs, '/SPAM/i', NOW);
  assert.equal(spam.error, null);
  assert.equal(spam.items.length, 1);
  assert.ok(spam.items[0].text.includes('spam'));

  // Case-sensitive regex does not match different case
  const spamSensitive = filter.filterMessages(msgs, '/SPAM/', NOW);
  assert.equal(spamSensitive.items.length, 0);

  // Regex matching author
  const authorRx = filter.filterMessages(msgs, '/^Alice\\s+Smith$/', NOW);
  assert.equal(authorRx.items.length, 1);
  assert.equal(authorRx.items[0].author, 'Alice Smith');

  // Regex with spaces inside pattern
  const spaceRx = filter.filterMessages(msgs, '/quick update/i', NOW);
  assert.equal(spaceRx.items.length, 1);

  // Escaped slash inside regex
  const urlRx = filter.filterMessages(msgs, '/https?:\\/\\/example\\.com\\/docs/i', NOW);
  assert.equal(urlRx.items.length, 1);

  // Slash inside character class [...] must NOT prematurely close the regex literal
  const charClassRx = filter.filterMessages(msgs, '/embed [\\s/] attachment/i', NOW);
  assert.equal(charClassRx.error, null);
  assert.equal(charClassRx.items.length, 1);
  assert.equal(charClassRx.items[0].author, 'Alice Smith');

  // Escaped backslash immediately before closing slash
  const slashEndRx = filter.filterMessages(
    [{ id: makeChatId(NOW), author: 'A', text: 'path\\', isMine: true }],
    '/path\\\\/',
    NOW
  );
  assert.equal(slashEndRx.error, null);
  assert.equal(slashEndRx.items.length, 1);

  // Global flag /g must NOT suffer stateful lastIndex alternation across messages
  const globalRx = filter.filterMessages(msgs, '/DemoUser/gi', NOW);
  assert.equal(globalRx.error, null);
  assert.equal(globalRx.items.length, 4);

  // Negated regex
  const noSpam = filter.filterMessages(msgs, '-/spam/i', NOW);
  assert.equal(noSpam.error, null);
  assert.equal(noSpam.items.length, 6);

  // Invalid regex patterns must NEVER throw and must return { error } with empty items
  for (const badQuery of ['/[unclosed/', '/[unclosed/i', '/(abc/', '/foo/z', '-/[broken/', 'user:me /[bad/']) {
    const parsed = filter.parseQuery(badQuery);
    assert.ok(parsed.error, `expected error for ${badQuery}`);
    const res = filter.filterMessages(msgs, badQuery, NOW);
    assert.ok(res.error, `expected filterMessages error for ${badQuery}`);
    assert.deepEqual(Array.from(res.items), []);
  }
});

// 10. Plain words, quoted phrases, negation, and colon/slash edge cases
test('plain words, quoted phrases, negation, and literal colons/slashes work cleanly', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();

  // Plain word (case-insensitive against text or author)
  assert.equal(filter.filterMessages(msgs, 'milestone', NOW).items.length, 1);
  assert.equal(filter.filterMessages(msgs, 'clyde', NOW).items.length, 1);

  // Negated plain word
  const noOld = filter.filterMessages(msgs, '-old', NOW);
  assert.equal(noOld.items.length, 5); // excludes msg[3] ("Old project...") and msg[6] ("Very old...")

  // Quoted phrase
  const phrase = filter.filterMessages(msgs, '"project milestone"', NOW);
  assert.equal(phrase.items.length, 1);
  assert.equal(filter.filterMessages(msgs, '"milestone project"', NOW).items.length, 0);

  // Negated quoted phrase
  const noPhrase = filter.filterMessages(msgs, '-"quick update"', NOW);
  assert.equal(noPhrase.items.length, 6);

  // Unknown key:value like 12:30 or http://... treated as plain text, not an error
  const timeMatch = filter.filterMessages(msgs, '12:30', NOW);
  assert.equal(timeMatch.error, null);
  assert.equal(timeMatch.items.length, 1);
  assert.equal(timeMatch.items[0].author, 'Bob');

  // Single slash command word like /shrug treated as plain text
  const slashWord = filter.filterMessages(msgs, '/shrug', NOW);
  assert.equal(slashWord.error, null);
  assert.equal(slashWord.items.length, 1);
  assert.equal(slashWord.items[0].author, 'Clyde');

  // Empty / whitespace query returns all messages (shallow copy)
  const all = filter.filterMessages(msgs, '   ', NOW);
  assert.equal(all.error, null);
  assert.equal(all.items.length, msgs.length);
  assert.notStrictEqual(all.items, msgs);
});

// 11. toggleTokenInQuery & hasTokenInQuery
test('hasTokenInQuery and toggleTokenInQuery cleanly toggle tokens without clobbering other filters', () => {
  const { filter } = loadFilter();

  // Add to empty
  assert.equal(filter.hasTokenInQuery('', 'is:mine'), false);
  assert.equal(filter.toggleTokenInQuery('', 'is:mine'), 'is:mine');

  // Remove sole token
  assert.equal(filter.hasTokenInQuery('is:mine', 'is:mine'), true);
  assert.equal(filter.toggleTokenInQuery('is:mine', 'is:mine'), '');

  // Preserve regex with spaces, quoted phrase, and other directives
  const complex = 'user:"Alice Smith" /hello  world/i age:1d-1y';
  const withLinks = filter.toggleTokenInQuery(complex, 'has:link');
  assert.equal(withLinks, 'user:"Alice Smith" /hello  world/i age:1d-1y has:link');
  assert.equal(filter.hasTokenInQuery(withLinks, 'has:link'), true);
  assert.equal(filter.hasTokenInQuery(withLinks, 'age:1d-1y'), true);

  // Toggling off removes ONLY that exact token and keeps everything else intact
  const withoutLinks = filter.toggleTokenInQuery(withLinks, 'has:link');
  assert.equal(withoutLinks, 'user:"Alice Smith" /hello  world/i age:1d-1y');

  // Toggling a different age chip does NOT clobber an existing age filter
  const withOld14 = filter.toggleTokenInQuery(complex, 'age:>14d');
  assert.equal(withOld14, 'user:"Alice Smith" /hello  world/i age:1d-1y age:>14d');

  // Case-insensitive match removes uppercase token
  assert.equal(filter.hasTokenInQuery('IS:MINE has:link', 'is:mine'), true);
  assert.equal(filter.toggleTokenInQuery('IS:MINE has:link', 'is:mine'), 'has:link');

  // Must NOT confuse negated -has:link or quoted "has:link" with bare has:link
  assert.equal(filter.hasTokenInQuery('-has:link "has:link" user:"has:link"', 'has:link'), false);
  assert.equal(
    filter.toggleTokenInQuery('-has:link "has:link"', 'has:link'),
    '-has:link "has:link" has:link'
  );

  // Duplicate occurrences removed cleanly
  assert.equal(filter.toggleTokenInQuery('is:mine user:bob IS:MINE', 'is:mine'), 'user:bob');
});

// 12. Combined multi-token queries & pre-parsed reuse
test('combined multi-token queries compose all directives accurately', () => {
  const { filter } = loadFilter();
  const msgs = buildSampleMessages();

  // Mine + age 1d-1y + has:link + not /archive/i -> only msg[3] (15d old, mine, hasLink, milestone)
  const q1 = filter.filterMessages(msgs, 'user:me age:1d-1y has:link -/archive/i "project milestone"', NOW);
  assert.equal(q1.error, null);
  assert.equal(q1.items.length, 1);
  assert.equal(q1.items[0], msgs[3]);

  // Deletable + not Clyde + age < 1y + no media -> msg[0] (10m) and msg[3] (15d)
  const q2 = filter.filterMessages(msgs, 'is:deletable -user:clyde age:<1y -has:media', NOW);
  assert.equal(q2.error, null);
  assert.equal(q2.items.length, 2);
  assert.deepEqual(Array.from(q2.items), [msgs[0], msgs[3]]);

  // Direct matchesMessage with pre-parsed query
  const parsed = filter.parseQuery('is:mine age:>14d -/spam/i');
  assert.equal(parsed.error, null);
  assert.equal(filter.matchesMessage(msgs[3], parsed, NOW), false); // contains "spam"
  assert.equal(filter.matchesMessage(msgs[6], parsed, NOW), true);  // 400d old, mine, no spam

  // Passing pre-parsed query into filterMessages works identically
  const q3 = filter.filterMessages(msgs, parsed, NOW);
  assert.equal(q3.items.length, 1);
  assert.equal(q3.items[0], msgs[6]);
});

// 13. Performance sanity check on 2,000 messages
test('filters 2,000 messages quickly with combined snowflake + regex + directive query', () => {
  const { filter } = loadFilter();
  const big = [];
  for (let i = 0; i < 2000; i++) {
    big.push({
      id: makeChatId(NOW - i * HOUR),
      author: i % 3 === 0 ? 'DemoUser' : 'OtherUser',
      text: i % 5 === 0 ? `Check https://example.com/${i} release` : `Plain chat message #${i}`,
      isMine: i % 3 === 0,
      isEphemeral: false,
      actionType: i % 3 === 0 ? 'delete' : 'readonly',
      canRemove: i % 3 === 0,
      hasLink: false,
      hasMedia: i % 7 === 0,
      hasEmbed: false
    });
  }

  const t0 = Date.now();
  const res = filter.filterMessages(big, 'is:mine age:1d-30d has:link /release/i -has:media', NOW);
  const elapsedMs = Date.now() - t0;

  assert.equal(res.error, null);
  assert.ok(res.items.length > 0);
  assert.ok(elapsedMs < 500, `expected <500ms, took ${elapsedMs}ms`);
});

// 14. Defensive edge cases (escaped/unclosed quotes, standalone dash, slash words, missing directive values, null safety)
test('defensive edge cases never throw and behave predictably', () => {
  const { filter } = loadFilter();
  const edgeMsgs = [
    { id: makeChatId(NOW), author: 'A', text: 'He said "hi" - ok /shrug /wave', isMine: true },
    { id: makeChatId(NOW), author: 'B', text: 'Normal message', isMine: false }
  ];

  // Escaped quotes inside quoted phrase
  const esc = filter.filterMessages(edgeMsgs, '"said \\"hi\\""', NOW);
  assert.equal(esc.error, null);
  assert.equal(esc.items.length, 1);

  // Unclosed quote while typing still matches prefix cleanly
  const unclosed = filter.filterMessages(edgeMsgs, '"Normal mess', NOW);
  assert.equal(unclosed.error, null);
  assert.equal(unclosed.items.length, 1);

  // Standalone dash acts as literal text "-"
  const dash = filter.filterMessages(edgeMsgs, '-', NOW);
  assert.equal(dash.error, null);
  assert.equal(dash.items.length, 1);

  // Two separate slash words do NOT falsely merge into an invalid regex
  const twoSlashes = filter.filterMessages(edgeMsgs, '/shrug /wave', NOW);
  assert.equal(twoSlashes.error, null);
  assert.equal(twoSlashes.items.length, 1);

  // Missing directive value returns clear error without throwing
  for (const emptyDir of ['user:', 'from:', 'age:', 'is:', 'has:']) {
    const res = filter.filterMessages(edgeMsgs, emptyDir, NOW);
    assert.ok(res.error, `expected error for ${emptyDir}`);
    assert.equal(res.items.length, 0);
  }

  // Null/non-array message lists and null messages handled safely
  assert.deepEqual(Array.from(filter.filterMessages(null, 'is:mine', NOW).items), []);
  assert.equal(filter.matchesMessage(null, 'is:mine', NOW), false);
});

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
