(function() {
  if (window.__dcFilter && window.__dcFilter.version === 1) {
    return 'already-mounted';
  }
  if (window.__dcFilter && typeof window.__dcFilter.destroy === 'function') {
    try { window.__dcFilter.destroy(); } catch (e) {}
  }

  const DISCORD_EPOCH_BIGINT = 1420070400000n;
  const DISCORD_EPOCH = 1420070400000;

  const UNIT_MS = Object.freeze({
    s:  1000,
    m:  60 * 1000,
    h:  3600 * 1000,
    d:  86400 * 1000,
    w:  7 * 86400 * 1000,
    mo: 30 * 86400 * 1000,
    y:  365 * 86400 * 1000
  });

  const QUICK_CHIPS = Object.freeze([
    Object.freeze({ id: 'mine',     label: 'Mine',        token: 'is:mine' }),
    Object.freeze({ id: 'recent24', label: '<24h',        token: 'age:<24h' }),
    Object.freeze({ id: 'old14',    label: '>14d',        token: 'age:>14d' }),
    Object.freeze({ id: 'range',    label: '1d-1y',       token: 'age:1d-1y' }),
    Object.freeze({ id: 'links',    label: 'Links',       token: 'has:link' }),
    Object.freeze({ id: 'media',    label: 'Media',       token: 'has:media' }),
    Object.freeze({ id: 'dismiss',  label: 'Dismissible', token: 'is:dismiss' })
  ]);

  const DIRECTIVE_KEYS = new Set(['user', 'from', 'age', 'is', 'has']);
  const VALID_REGEX_FLAGS = /^[dgimsuvy]*$/;
  const URL_RE = /https?:\/\//i;
  const MEDIA_PLACEHOLDER = '(embed / attachment)';

  // --- 1. Snowflake Timestamp Helpers ---
  function extractSnowflake(msgId) {
    if (msgId === null || msgId === undefined) return null;
    const s = String(msgId).trim();
    if (!s) return null;
    const chatMatch = s.match(/^chat-messages-\d+-(\d{15,22})$/);
    if (chatMatch) return chatMatch[1];
    const tailMatch = s.match(/(\d{15,22})$/);
    return tailMatch ? tailMatch[1] : null;
  }

  function getSnowflakeTimestampMs(msgId) {
    const sf = extractSnowflake(msgId);
    if (!sf) return null;
    try {
      return Number((BigInt(sf) >> 22n) + DISCORD_EPOCH_BIGINT);
    } catch (e) {
      return null;
    }
  }

  function getMessageTimestampMs(msg) {
    if (msg === null || msg === undefined) return null;
    if (typeof msg === 'string' || typeof msg === 'number') {
      return getSnowflakeTimestampMs(msg);
    }
    if (typeof msg === 'object') {
      if (typeof msg.timestampMs === 'number' && Number.isFinite(msg.timestampMs)) {
        return msg.timestampMs;
      }
      return getSnowflakeTimestampMs(msg.id);
    }
    return null;
  }

  // --- 2. Duration & Age Range Parser ---
  function parseDurationMs(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;

    const tokenRe = /(\d+(?:\.\d+)?)(mo|y|w|d|h|m|s)/g;
    let total = 0;
    let lastIndex = 0;
    let matched = false;
    let match;

    while ((match = tokenRe.exec(s)) !== null) {
      if (match.index !== lastIndex) return null;
      const num = Number(match[1]);
      const mult = UNIT_MS[match[2]];
      if (!Number.isFinite(num) || num < 0 || !mult) return null;
      total += num * mult;
      lastIndex = tokenRe.lastIndex;
      matched = true;
    }

    if (!matched || lastIndex !== s.length || !Number.isFinite(total)) return null;
    return Math.round(total);
  }

  function parseAgeSpec(spec) {
    if (typeof spec !== 'string') return null;
    const raw = spec.trim();
    if (!raw) return null;

    // Comparisons: >=, <=, >, <
    const cmpMatch = raw.match(/^(>=|<=|>|<)\s*(.+)$/);
    if (cmpMatch) {
      const op = cmpMatch[1];
      const ms = parseDurationMs(cmpMatch[2]);
      if (ms === null) return null;
      if (op === '>') {
        return { kind: 'gt', op, ms, minMs: ms, maxMs: null, minInclusive: false, maxInclusive: true, raw };
      }
      if (op === '>=') {
        return { kind: 'gte', op, ms, minMs: ms, maxMs: null, minInclusive: true, maxInclusive: true, raw };
      }
      if (op === '<') {
        return { kind: 'lt', op, ms, minMs: null, maxMs: ms, minInclusive: true, maxInclusive: false, raw };
      }
      return { kind: 'lte', op, ms, minMs: null, maxMs: ms, minInclusive: true, maxInclusive: true, raw };
    }

    // Range: 1d-1y, 2h-7d, 14d-6mo (normalizes reversed bounds like 1y-1d)
    const dashIdx = raw.indexOf('-');
    if (dashIdx !== -1) {
      // Reject multiple dashes (e.g. 1d-2d-3d) or leading/trailing dash
      if (raw.indexOf('-', dashIdx + 1) !== -1) return null;
      const leftStr = raw.slice(0, dashIdx).trim();
      const rightStr = raw.slice(dashIdx + 1).trim();
      if (!leftStr || !rightStr) return null;
      const a = parseDurationMs(leftStr);
      const b = parseDurationMs(rightStr);
      if (a === null || b === null) return null;
      const minMs = Math.min(a, b);
      const maxMs = Math.max(a, b);
      return { kind: 'range', op: 'range', minMs, maxMs, minInclusive: true, maxInclusive: true, raw };
    }

    // Exact shorthand: age:7d -> <= 7d (within last 7 days)
    const ms = parseDurationMs(raw);
    if (ms === null) return null;
    return { kind: 'lte', op: '<=', ms, minMs: null, maxMs: ms, minInclusive: true, maxInclusive: true, shorthand: true, raw };
  }

  function matchesAgeSpec(ageMs, spec) {
    if (!spec || typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return false;
    const clamped = ageMs < 0 ? 0 : ageMs;
    if (spec.minMs !== null && spec.minMs !== undefined) {
      if (spec.minInclusive ? clamped < spec.minMs : clamped <= spec.minMs) return false;
    }
    if (spec.maxMs !== null && spec.maxMs !== undefined) {
      if (spec.maxInclusive ? clamped > spec.maxMs : clamped >= spec.maxMs) return false;
    }
    return true;
  }

  // --- 3. Tokenizer & Query Parser ---
  function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
  }

  function readQuoted(s, start) {
    let value = '';
    let i = start + 1;
    const len = s.length;
    let closed = false;
    while (i < len) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < len) {
        const next = s[i + 1];
        if (next === '"' || next === '\\') {
          value += next;
          i += 2;
          continue;
        }
      }
      if (ch === '"') {
        closed = true;
        i++;
        break;
      }
      value += ch;
      i++;
    }
    return { value, end: i, closed };
  }

  function tryReadRegex(s, start) {
    const len = s.length;
    let escaped = false;
    let inClass = false;
    let crossedWs = false;
    let closeOutside = -1;
    let closeInside = -1;
    let closeInsideCrossedWs = false;

    for (let j = start + 1; j < len; j++) {
      const ch = s[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (isWhitespace(ch)) {
        crossedWs = true;
      }
      if (ch === '[' && !inClass) {
        inClass = true;
        continue;
      }
      if (ch === ']' && inClass) {
        inClass = false;
        continue;
      }
      if (ch === '/') {
        if (!inClass) {
          closeOutside = j;
          break;
        } else if (closeInside === -1) {
          closeInside = j;
          closeInsideCrossedWs = crossedWs;
        }
      }
    }

    let closeIdx = -1;
    let didCrossWs = false;
    if (closeOutside !== -1) {
      closeIdx = closeOutside;
      didCrossWs = crossedWs;
    } else if (inClass && closeInside !== -1) {
      closeIdx = closeInside;
      didCrossWs = closeInsideCrossedWs;
    }

    if (closeIdx === -1) return null;

    const pattern = s.slice(start + 1, closeIdx);
    if (pattern.length === 0) return null;

    let end = closeIdx + 1;
    while (end < len && !isWhitespace(s[end])) {
      end++;
    }
    const flags = s.slice(closeIdx + 1, end);

    // Avoid merging two separate slash-words like `/shrug /wave`
    if (didCrossWs && isWhitespace(s[closeIdx - 1]) && !VALID_REGEX_FLAGS.test(flags)) {
      return null;
    }

    return { pattern, flags, end };
  }

  function scanRawTokens(rawQuery) {
    const s = typeof rawQuery === 'string' ? rawQuery : '';
    const len = s.length;
    const out = [];
    let i = 0;

    while (i < len) {
      while (i < len && isWhitespace(s[i])) i++;
      if (i >= len) break;

      const start = i;
      let negated = false;
      if (s[i] === '-' && i + 1 < len && !isWhitespace(s[i + 1])) {
        negated = true;
        i++;
      }

      // Quoted string
      if (s[i] === '"') {
        const q = readQuoted(s, i);
        i = q.end;
        out.push({
          kind: 'quoted',
          negated,
          value: q.value,
          start,
          end: i,
          raw: s.slice(start, i)
        });
        continue;
      }

      // Regex literal /pattern/flags
      if (s[i] === '/') {
        const rx = tryReadRegex(s, i);
        if (rx) {
          i = rx.end;
          out.push({
            kind: 'regex',
            negated,
            pattern: rx.pattern,
            flags: rx.flags,
            start,
            end: i,
            raw: s.slice(start, i)
          });
          continue;
        }
      }

      // Key:value directive
      let k = i;
      while (k < len && ((s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z'))) {
        k++;
      }
      if (k > i && k < len && s[k] === ':') {
        const maybeKey = s.slice(i, k).toLowerCase();
        if (DIRECTIVE_KEYS.has(maybeKey)) {
          const valStart = k + 1;
          let value = '';
          let valQuoted = false;
          if (valStart < len && s[valStart] === '"') {
            const q = readQuoted(s, valStart);
            value = q.value;
            valQuoted = true;
            i = q.end;
          } else {
            let vEnd = valStart;
            while (vEnd < len && !isWhitespace(s[vEnd])) vEnd++;
            value = s.slice(valStart, vEnd);
            i = vEnd;
          }
          out.push({
            kind: 'directive',
            negated,
            key: maybeKey,
            value,
            valQuoted,
            start,
            end: i,
            raw: s.slice(start, i)
          });
          continue;
        }
      }

      // Plain word
      let wEnd = i;
      while (wEnd < len && !isWhitespace(s[wEnd])) wEnd++;
      const word = s.slice(i, wEnd);
      i = wEnd;
      out.push({
        kind: 'word',
        negated,
        value: word,
        start,
        end: i,
        raw: s.slice(start, i)
      });
    }

    return out;
  }

  function normalizeIsFlag(val) {
    const v = val.toLowerCase();
    if (v === 'mine') return 'mine';
    if (v === 'other') return 'other';
    if (v === 'dismiss' || v === 'ephemeral' || v === 'dismissible') return 'dismiss';
    if (v === 'deletable' || v === 'removable') return 'deletable';
    if (v === 'readonly') return 'readonly';
    if (v === 'bot') return 'bot';
    if (v === 'system') return 'system';
    return null;
  }

  function normalizeHasFlag(val) {
    const v = val.toLowerCase();
    if (v === 'link' || v === 'url') return 'link';
    if (v === 'media' || v === 'image' || v === 'img' || v === 'attachment' || v === 'file') return 'media';
    if (v === 'embed') return 'embed';
    return null;
  }

  function parseQuery(rawQuery) {
    const raw = typeof rawQuery === 'string' ? rawQuery : '';
    const scanned = scanRawTokens(raw);
    const tokens = [];
    const errors = [];

    for (let i = 0; i < scanned.length; i++) {
      const t = scanned[i];

      if (t.kind === 'quoted' || t.kind === 'word') {
        tokens.push({
          type: 'text',
          value: t.value,
          valueLower: t.value.toLowerCase(),
          quoted: t.kind === 'quoted',
          negated: t.negated,
          raw: t.raw
        });
        continue;
      }

      if (t.kind === 'regex') {
        let execRegex = null;
        let rxError = null;
        try {
          // Validate full flags first (so invalid flags throw and are caught)
          new RegExp(t.pattern, t.flags);
          // Strip stateful g/y flags for fast stateless .test() across messages
          const safeFlags = t.flags.replace(/[gy]/g, '');
          execRegex = new RegExp(t.pattern, safeFlags);
        } catch (e) {
          rxError = 'Invalid regex ' + t.raw + ': ' + (e && e.message ? e.message : 'syntax error');
          errors.push(rxError);
        }
        tokens.push({
          type: 'regex',
          pattern: t.pattern,
          flags: t.flags,
          regex: execRegex,
          negated: t.negated,
          raw: t.raw,
          error: rxError
        });
        continue;
      }

      if (t.kind === 'directive') {
        const key = t.key;
        const val = t.value;

        if (!val) {
          const msg = 'Missing value for ' + key + ': filter';
          errors.push(msg);
          tokens.push({ type: 'invalid', key, value: val, negated: t.negated, raw: t.raw, error: msg });
          continue;
        }

        if (key === 'user' || key === 'from') {
          const valLower = val.toLowerCase();
          const isMe = !t.valQuoted && valLower === 'me';
          tokens.push({
            type: 'user',
            key,
            isMe,
            value: val,
            valueLower: valLower,
            negated: t.negated,
            raw: t.raw
          });
          continue;
        }

        if (key === 'age') {
          const spec = parseAgeSpec(val);
          if (!spec) {
            const msg = 'Invalid age filter "' + val + '"';
            errors.push(msg);
            tokens.push({ type: 'age', spec: null, value: val, negated: t.negated, raw: t.raw, error: msg });
          } else {
            tokens.push({
              type: 'age',
              spec,
              value: val,
              negated: t.negated,
              raw: t.raw
            });
          }
          continue;
        }

        if (key === 'is') {
          const flag = normalizeIsFlag(val);
          if (!flag) {
            const msg = 'Unknown is: filter "' + val + '"';
            errors.push(msg);
            tokens.push({ type: 'is', flag: null, value: val, negated: t.negated, raw: t.raw, error: msg });
          } else {
            tokens.push({
              type: 'is',
              flag,
              value: val,
              negated: t.negated,
              raw: t.raw
            });
          }
          continue;
        }

        if (key === 'has') {
          const flag = normalizeHasFlag(val);
          if (!flag) {
            const msg = 'Unknown has: filter "' + val + '"';
            errors.push(msg);
            tokens.push({ type: 'has', flag: null, value: val, negated: t.negated, raw: t.raw, error: msg });
          } else {
            tokens.push({
              type: 'has',
              flag,
              value: val,
              negated: t.negated,
              raw: t.raw
            });
          }
          continue;
        }
      }
    }

    return {
      raw,
      tokens,
      error: errors.length > 0 ? errors[0] : null,
      errors
    };
  }

  // --- 4. Quick-Chip Token Toggle Helpers ---
  function hasTokenInQuery(query, token) {
    if (typeof token !== 'string') return false;
    const target = token.trim().toLowerCase();
    if (!target) return false;
    const scanned = scanRawTokens(query);
    for (let i = 0; i < scanned.length; i++) {
      if (scanned[i].raw.toLowerCase() === target) return true;
    }
    return false;
  }

  function toggleTokenInQuery(query, token) {
    const qStr = typeof query === 'string' ? query : '';
    const target = typeof token === 'string' ? token.trim() : '';
    if (!target) return qStr.trim();

    const targetLower = target.toLowerCase();
    const scanned = scanRawTokens(qStr);
    let found = false;
    const kept = [];

    for (let i = 0; i < scanned.length; i++) {
      if (scanned[i].raw.toLowerCase() === targetLower) {
        found = true;
      } else {
        kept.push(scanned[i].raw);
      }
    }

    if (found) {
      return kept.join(' ');
    }

    const trimmed = qStr.trim();
    return trimmed ? (trimmed + ' ' + target) : target;
  }

  // --- 5. Fast Filtering API ---
  function evalIsFlag(msg, flag) {
    switch (flag) {
      case 'mine':
        return msg.isMine === true;
      case 'other':
        return msg.isMine !== true;
      case 'dismiss':
        return Boolean(msg.isEphemeral || msg.actionType === 'dismiss');
      case 'deletable':
        if (typeof msg.canRemove === 'boolean') return msg.canRemove;
        if (typeof msg.actionType === 'string') return msg.actionType !== 'readonly';
        return Boolean(msg.isMine || msg.isEphemeral);
      case 'readonly':
        if (typeof msg.canRemove === 'boolean') return !msg.canRemove;
        if (typeof msg.actionType === 'string') return msg.actionType === 'readonly';
        return !msg.isMine && !msg.isEphemeral;
      case 'bot':
        return Boolean(msg.isBot);
      case 'system':
        return Boolean(msg.isSystem);
      default:
        return false;
    }
  }

  function matchesMessage(msg, parsed, nowMs) {
    if (!msg || typeof msg !== 'object') return false;
    const p = typeof parsed === 'string' ? parseQuery(parsed) : parsed;
    if (!p) return true;
    if (p.error) return false;
    const tokens = p.tokens;
    if (!tokens || tokens.length === 0) return true;

    const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();

    // Lazily extracted fields per message for speed
    let text = null;
    let author = null;
    let textLower = null;
    let authorLower = null;
    let tsComputed = false;
    let msgTs = null;

    function getText() {
      if (text === null) text = msg.text == null ? '' : String(msg.text);
      return text;
    }
    function getAuthor() {
      if (author === null) author = msg.author == null ? '' : String(msg.author);
      return author;
    }
    function getTextLower() {
      if (textLower === null) textLower = getText().toLowerCase();
      return textLower;
    }
    function getAuthorLower() {
      if (authorLower === null) authorLower = getAuthor().toLowerCase();
      return authorLower;
    }
    function getTs() {
      if (!tsComputed) {
        tsComputed = true;
        msgTs = getMessageTimestampMs(msg);
      }
      return msgTs;
    }

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      let matched = false;

      switch (tok.type) {
        case 'text': {
          const needle = tok.valueLower;
          matched = getTextLower().indexOf(needle) !== -1 || getAuthorLower().indexOf(needle) !== -1;
          break;
        }
        case 'regex': {
          if (!tok.regex) return false;
          matched = tok.regex.test(getText()) || tok.regex.test(getAuthor());
          break;
        }
        case 'user': {
          if (tok.isMe) {
            matched = msg.isMine === true;
          } else {
            matched = getAuthorLower().indexOf(tok.valueLower) !== -1;
          }
          break;
        }
        case 'age': {
          if (!tok.spec) return false;
          const ts = getTs();
          matched = ts !== null && matchesAgeSpec(now - ts, tok.spec);
          break;
        }
        case 'is': {
          matched = evalIsFlag(msg, tok.flag);
          break;
        }
        case 'has': {
          if (tok.flag === 'link') {
            matched = Boolean(msg.hasLink) || URL_RE.test(getText());
          } else if (tok.flag === 'media') {
            matched = Boolean(msg.hasMedia) || getTextLower().indexOf(MEDIA_PLACEHOLDER) !== -1;
          } else if (tok.flag === 'embed') {
            matched = Boolean(msg.hasEmbed);
          }
          break;
        }
        default:
          return false;
      }

      if (tok.negated) matched = !matched;
      if (!matched) return false;
    }

    return true;
  }

  function filterMessages(messages, rawQuery, nowMs) {
    const parsed = (rawQuery && typeof rawQuery === 'object' && Array.isArray(rawQuery.tokens))
      ? rawQuery
      : parseQuery(rawQuery);

    if (parsed.error) {
      return { items: [], parsed, error: parsed.error };
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return { items: [], parsed, error: null };
    }

    if (parsed.tokens.length === 0) {
      return { items: messages.slice(), parsed, error: null };
    }

    const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
    const items = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (matchesMessage(m, parsed, now)) {
        items.push(m);
      }
    }

    return { items, parsed, error: null };
  }

  function destroy() {
    delete window.__dcFilter;
  }

  window.__dcFilter = {
    version: 1,
    DISCORD_EPOCH,
    UNIT_MS,
    QUICK_CHIPS,
    extractSnowflake,
    getSnowflakeTimestampMs,
    getMessageTimestampMs,
    parseDurationMs,
    parseAgeSpec,
    matchesAgeSpec,
    scanRawTokens,
    parseQuery,
    matchesMessage,
    filterMessages,
    hasTokenInQuery,
    toggleTokenInQuery,
    destroy
  };

  return 'mounted';
})();
