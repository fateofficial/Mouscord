(function() {
  if (window.__dcDeleteEngine && window.__dcDeleteEngine.version === 9) {
    return 'already-mounted';
  }
  if (window.__dcDeleteEngine && typeof window.__dcDeleteEngine.destroy === 'function') {
    try { window.__dcDeleteEngine.destroy(); } catch (e) {}
  }

  const SIDEBAR_ROOT_ID  = 'dc-msg-sidebar-root';
  const DISCORD_EPOCH    = 1420070400000n;
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const SETTINGS_KEY     = 'dc_del_settings_v2';
  const LEARNED_KEY      = 'dc_del_learned_v2';

  const getBridge = () => window.__dcBridge || null;

  const PACING = {
    recent: {
      baseMs: 450,
      minMs: 320,
      maxMs: 3200,
      jitterMinMs: 80,
      jitterMaxMs: 180,
      bucketEvery: 5,
      bucketWindowMs: 5200,
      shortLabel: '<14d'
    },
    older: {
      baseMs: 950,
      minMs: 700,
      maxMs: 4800,
      jitterMinMs: 140,
      jitterMaxMs: 300,
      bucketEvery: 4,
      bucketWindowMs: 9000,
      shortLabel: '>14d'
    }
  };

  const BACKOFF_STEPS_MS = [3000, 6000, 12000];
  const STATUS_WORDS = new Set([
    'online', 'idle', 'do not disturb', 'invisible', 'offline', 'mobile', 'streaming'
  ]);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const norm  = (s) => clean(s).toLowerCase();
  const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

  // --- User-controlled Display & Behavior Options ---
  // speedSlider: 0.0 -> 0.45 (Human Normal / Evergreen), 0.45 -> 0.80 (Human Focused / Gold), 0.80 -> 1.00 (Max Risky / Red)
  const settings = {
    hideDiscordMenu: true,
    enableVfx: true,
    mineOnly: true,
    learnedPacing: true,
    mouseCursor: true,
    newestFirst: true,
    removeReactions: false,
    speedSlider: 0.55
  };
  try {
    const rawS = localStorage.getItem(SETTINGS_KEY);
    if (rawS) {
      const p = JSON.parse(rawS);
      if (typeof p.hideDiscordMenu === 'boolean') settings.hideDiscordMenu = p.hideDiscordMenu;
      if (typeof p.enableVfx === 'boolean') settings.enableVfx = p.enableVfx;
      if (typeof p.mineOnly === 'boolean') settings.mineOnly = p.mineOnly;
      if (typeof p.learnedPacing === 'boolean') settings.learnedPacing = p.learnedPacing;
      if (typeof p.mouseCursor === 'boolean') settings.mouseCursor = p.mouseCursor;
      if (typeof p.newestFirst === 'boolean') settings.newestFirst = p.newestFirst;
      if (typeof p.removeReactions === 'boolean') settings.removeReactions = p.removeReactions;
      if (typeof p.speedSlider === 'number' && Number.isFinite(p.speedSlider)) {
        settings.speedSlider = Math.max(0, Math.min(1, p.speedSlider));
      }
    }
  } catch (e) {}

  // 2-Anchor Human Rhythm Interpolation (Normal <-> Focused -> Max Risky)
  const HUMAN_ANCHORS = {
    normal:  { medianMs: 1150, sigma: 0.30, burstMin: 24, burstMax: 45, pauseMinMs: 1100, pauseMaxMs: 2600 },
    focused: { medianMs: 460,  sigma: 0.22, burstMin: 35, burstMax: 65, pauseMinMs: 700,  pauseMaxMs: 1700 },
    risky:   { medianMs: 240,  sigma: 0.14, burstMin: 999, burstMax: 999, pauseMinMs: 0, pauseMaxMs: 0 }
  };

  function getSpeedProfile(sliderVal) {
    const t = Math.max(0, Math.min(1, typeof sliderVal === 'number' ? sliderVal : settings.speedSlider));
    const lerp = (a, b, k) => a + (b - a) * k;
    let zone = 'normal', label = 'Human Normal', a, b, k;
    if (t <= 0.45) {
      zone = 'normal'; label = 'Human Normal';
      a = HUMAN_ANCHORS.normal; b = HUMAN_ANCHORS.focused; k = (t / 0.45) * 0.45;
    } else if (t <= 0.80) {
      zone = 'focused'; label = 'Human Focused';
      a = HUMAN_ANCHORS.normal; b = HUMAN_ANCHORS.focused; k = 0.45 + ((t - 0.45) / 0.35) * 0.55;
    } else {
      zone = 'risky'; label = 'Max (Risky)';
      a = HUMAN_ANCHORS.focused; b = HUMAN_ANCHORS.risky; k = (t - 0.80) / 0.20;
    }
    return {
      t, zone, label,
      medianMs: Math.round(lerp(a.medianMs, b.medianMs, k)),
      sigma: lerp(a.sigma, b.sigma, k),
      burstMin: Math.round(lerp(a.burstMin, b.burstMin, k)),
      burstMax: Math.round(lerp(a.burstMax, b.burstMax, k)),
      pauseMinMs: Math.round(lerp(a.pauseMinMs, b.pauseMinMs, k)),
      pauseMaxMs: Math.round(lerp(a.pauseMaxMs, b.pauseMaxMs, k))
    };
  }

  function sampleLogNormalMs(medianMs, sigma) {
    const u1 = Math.max(1e-6, Math.random());
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const val = medianMs * Math.exp(sigma * z);
    return Math.round(Math.max(medianMs * 0.55, Math.min(medianMs * 2.4, val)));
  }

  // --- AIMD Learned Pacing (persisted per age tier) ---
  const learned = {
    recentMs: PACING.recent.baseMs,
    olderMs: PACING.older.baseMs,
    recentStreak: 0,
    olderStreak: 0
  };
  try {
    const rawL = localStorage.getItem(LEARNED_KEY);
    if (rawL) {
      const p = JSON.parse(rawL);
      if (typeof p.recentMs === 'number') learned.recentMs = Math.max(PACING.recent.minMs, Math.min(PACING.recent.maxMs, p.recentMs));
      if (typeof p.olderMs === 'number') learned.olderMs = Math.max(PACING.older.minMs, Math.min(PACING.older.maxMs, p.olderMs));
    }
  } catch (e) {}

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }
  function saveLearned() {
    try { localStorage.setItem(LEARNED_KEY, JSON.stringify({ recentMs: learned.recentMs, olderMs: learned.olderMs })); } catch (e) {}
  }
  function getSettings() { return Object.assign({}, settings); }
  function setSettings(patch) {
    if (!patch || typeof patch !== 'object') return getSettings();
    if (typeof patch.hideDiscordMenu === 'boolean') settings.hideDiscordMenu = patch.hideDiscordMenu;
    if (typeof patch.enableVfx === 'boolean') settings.enableVfx = patch.enableVfx;
    if (typeof patch.mineOnly === 'boolean') settings.mineOnly = patch.mineOnly;
    if (typeof patch.learnedPacing === 'boolean') settings.learnedPacing = patch.learnedPacing;
    if (typeof patch.mouseCursor === 'boolean') settings.mouseCursor = patch.mouseCursor;
    if (typeof patch.newestFirst === 'boolean') settings.newestFirst = patch.newestFirst;
    if (typeof patch.removeReactions === 'boolean') settings.removeReactions = patch.removeReactions;
    if (typeof patch.speedSlider === 'number' && Number.isFinite(patch.speedSlider)) {
      settings.speedSlider = Math.max(0, Math.min(1, patch.speedSlider));
    }
    saveSettings();
    return getSettings();
  }
  function getLearnedPacing() {
    return { recentMs: learned.recentMs, olderMs: learned.olderMs };
  }
  function getVfx() {
    return (settings.enableVfx && window.__dcVfx) ? window.__dcVfx : null;
  }

  // --- Snowflake Age Detection ---
  function extractSnowflake(msgId) {
    if (!msgId) return null;
    const m = String(msgId).match(/(\d{15,22})$/);
    return m ? m[1] : null;
  }

  function getSnowflakeTimestampMs(msgId) {
    const sf = extractSnowflake(msgId);
    if (!sf) return null;
    try {
      return Number((BigInt(sf) >> 22n) + DISCORD_EPOCH);
    } catch (e) {
      return null;
    }
  }

  function classifyMessageAge(msgId) {
    const snowflake = extractSnowflake(msgId);
    const timestampMs = getSnowflakeTimestampMs(msgId);
    if (timestampMs === null) {
      return { snowflake, timestampMs: null, ageMs: null, isOlder: false, tier: 'recent' };
    }
    const ageMs = Math.max(0, Date.now() - timestampMs);
    const isOlder = ageMs > FOURTEEN_DAYS_MS;
    return { snowflake, timestampMs, ageMs, isOlder, tier: isOlder ? 'older' : 'recent' };
  }

  // --- Accurate Own-Account Identity Detection (Avatar User ID + Username/Display Name) ---
  function extractUserIdFromAvatarSrc(src) {
    if (!src) return '';
    const m = String(src).match(/\/avatars\/(\d{15,22})\//);
    return m ? m[1] : '';
  }

  function detectCurrentUserIdentity() {
    const names = new Set();
    let userId = '';

    const addName = (raw) => {
      const n = norm(raw);
      if (!n || n.length > 64) return;
      if (STATUS_WORDS.has(n)) return;
      if (/^(mute|deafen|user settings|set status|voice connected)/i.test(n)) return;
      names.add(n);
    };

    const panelSelectors = [
      'section[aria-label="User status and settings"]',
      'section[aria-label*="User status" i]',
      'section[aria-label*="User area" i]',
      'section[aria-label*="User" i]',
      '[class*="panels_"]'
    ];

    let panel = null;
    for (const sel of panelSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el.closest && el.closest('#' + SIDEBAR_ROOT_ID)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20 && r.bottom > window.innerHeight - 160 && r.left < 380) {
          panel = el;
          break;
        }
      }
      if (panel) break;
    }

    if (panel) {
      const imgs = panel.querySelectorAll('img');
      for (const img of imgs) {
        const uid = extractUserIdFromAvatarSrc(img.src || img.getAttribute('src'));
        if (uid) { userId = uid; break; }
      }

      const nameLines = String(panel.innerText || panel.textContent || '')
        .split(/\r?\n/)
        .map(s => clean(s))
        .filter(Boolean);
      for (const line of nameLines) {
        addName(line);
      }

      const specific = panel.querySelectorAll(
        '[class*="panelTitleContainer"], [class*="title_"], [class*="hovered_"], [class*="username"]'
      );
      for (const t of specific) {
        const txt = clean(t.innerText || t.textContent);
        if (txt && txt.indexOf('\n') === -1) addName(txt);
      }
    }

    // Also enrich from in-memory Discord UserStore via __dcBridge when available
    const br = getBridge();
    if (br && typeof br.getCurrentUser === 'function') {
      const u = br.getCurrentUser();
      if (u) {
        if (!userId && u.id) userId = String(u.id);
        if (u.username) addName(u.username);
        if (u.globalName) addName(u.globalName);
      }
    }

    return { userId, names };
  }

  function detectCurrentUser() {
    return detectCurrentUserIdentity().names;
  }

  // Detect ephemeral "Only you can see this" messages (Clyde, slash commands); these need Dismiss, not Delete.
  function findDismissButton(li) {
    if (!li) return null;
    const candidates = li.querySelectorAll('a, button, [role="button"]');
    for (const el of candidates) {
      const t = norm(el.textContent);
      if (t === 'dismiss message' || t === 'dismiss') return el;
    }
    return null;
  }

  // --- Read Visible Messages & Intelligently Classify Action ('delete' | 'dismiss' | 'readonly') ---
  function readVisibleMessages() {
    const identity = detectCurrentUserIdentity();
    const lis = document.querySelectorAll('li[id^="chat-messages-"]');
    const out = [];
    let lastAuthor = '';
    let lastAuthorId = '';
    let lastIsBot = false;

    for (let i = 0; i < lis.length; i++) {
      const li = lis[i];
      const isSystem = !!li.querySelector('[class*="systemMessage"]');
      const u = li.querySelector('[id^="message-username-"]');
      const av = li.querySelector('img[class*="avatar"]');
      const isEphemeral = !!findDismissButton(li);

      if (isSystem) {
        lastAuthor = '';
        lastAuthorId = '';
        lastIsBot = false;
      } else {
        if (u) {
          const botTag = u.querySelector('[class*="botTag"]');
          lastIsBot = !!botTag || /\b(VERIFIED APP|APP|BOT)\b/.test(u.innerText || '');
          const inner = u.querySelector('[class*="username"]') || u;
          const a = clean(inner.innerText || inner.textContent);
          if (a) lastAuthor = a;
        }
        if (av) {
          const uid = extractUserIdFromAvatarSrc(av.src || av.getAttribute('src'));
          lastAuthorId = uid || '';
        }
      }

      const c = li.querySelector('[id^="message-content-"]');
      const txt = clean(c ? (c.innerText || c.textContent) : (li.innerText || li.textContent)).slice(0, 140);
      const author = isSystem ? '' : lastAuthor;
      const authorKey = norm(author);

      let isMine = null;
      if (isSystem || lastIsBot) {
        isMine = false;
      } else if (identity.userId && lastAuthorId) {
        isMine = (lastAuthorId === identity.userId);
      } else if (identity.names.size > 0 && authorKey) {
        isMine = identity.names.has(authorKey);
      }

      const actionType = isEphemeral ? 'dismiss' : (isMine === false ? 'readonly' : 'delete');
      const hasLink  = /https?:\/\/\S+/i.test(txt) || !!li.querySelector('a[href^="http"]');
      const hasMedia = !!li.querySelector('img:not([class*="avatar"]), video, [class*="imageWrapper"], [class*="attachment"]');
      const hasEmbed = !!li.querySelector('[class*="embedWrapper"], article[class*="embed"]');

      out.push({
        id: li.id,
        rawId: extractSnowflake(li.id) || li.id,
        channelId: (getBridge() && getBridge().getCurrentChannelIdFromUrl) ? getBridge().getCurrentChannelIdFromUrl() : '',
        author,
        authorId: lastAuthorId,
        text: txt,
        isSystem,
        isBot: lastIsBot,
        isEphemeral,
        isMine,
        actionType,
        canRemove: actionType !== 'readonly',
        hasLink,
        hasMedia,
        hasEmbed
      });
    }
    return out;
  }

  // --- Per-Channel Background Index Cache & Instant History Scanner ---
  const channelIndexCache = new Map(); // channelId -> { channelId, label, path, totalResults, itemsMap: Map<rawId, msg>, oldestRawId, indexing, lastUpdated }
  const deletedTombstones = new Set(); // Permanent in-memory tombstone set of deleted raw snowflake IDs & DOM IDs
  const bridgeUnsubs = [];

  function markTombstone(rawOrDomId) {
    if (!rawOrDomId) return;
    deletedTombstones.add(String(rawOrDomId));
    const sf = extractSnowflake(rawOrDomId);
    if (sf) deletedTombstones.add(sf);
  }

  function isTombstoned(rawOrDomId) {
    if (!rawOrDomId) return false;
    if (deletedTombstones.has(String(rawOrDomId))) return true;
    const sf = extractSnowflake(rawOrDomId);
    return !!(sf && deletedTombstones.has(sf));
  }

  function getOrCreateChannelIndex(channelId) {
    const br = getBridge();
    const cid = String(channelId || (br && br.getCurrentChannelIdFromUrl ? br.getCurrentChannelIdFromUrl() : '') || 'current');
    if (!channelIndexCache.has(cid)) {
      const info = (br && br.getChannelInfo) ? br.getChannelInfo(cid) : { id: cid, label: readCurrentChannelLabel(), path: window.location.pathname };
      channelIndexCache.set(cid, {
        channelId: cid,
        label: info.label || 'Channel',
        path: info.path || window.location.pathname,
        totalResults: null,
        itemsMap: new Map(),
        oldestRawId: null,
        oldestMyRawId: null,
        reachedTop: false,
        autoIndexed: false,
        lastUpdated: 0
      });
    }
    return channelIndexCache.get(cid);
  }

  function mergeMessagesIntoChannelIndex(channelId, list, opts) {
    const entry = getOrCreateChannelIndex(channelId);
    if (!Array.isArray(list)) return entry;
    const trackCursor = !(opts && opts.trackDescCursor === false);
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || !m.id) continue;
      const key = m.rawId || extractSnowflake(m.id) || m.id;
      if (isTombstoned(key) || isTombstoned(m.id)) continue;
      entry.itemsMap.set(key, Object.assign({ rawId: key, channelId: entry.channelId }, m));
      if (trackCursor) {
        if (!entry.oldestRawId || ( /^\d+$/.test(key) && /^\d+$/.test(entry.oldestRawId) && BigInt(key) < BigInt(entry.oldestRawId) )) {
          entry.oldestRawId = key;
        }
        if (m.canRemove && (!entry.oldestMyRawId || ( /^\d+$/.test(key) && /^\d+$/.test(entry.oldestMyRawId) && BigInt(key) < BigInt(entry.oldestMyRawId) ))) {
          entry.oldestMyRawId = key;
        }
      }
    }
    entry.lastUpdated = Date.now();
    return entry;
  }

  function getChannelMessages(channelId) {
    const br = getBridge();
    const curCid = (br && br.getCurrentChannelIdFromUrl) ? br.getCurrentChannelIdFromUrl() : '';
    const cid = String(channelId || curCid || '');
    const entry = getOrCreateChannelIndex(cid);

    // Purge any tombstoned items from the map first
    for (const k of Array.from(entry.itemsMap.keys())) {
      if (isTombstoned(k)) entry.itemsMap.delete(k);
    }

    // When __dcBridge is available, MessageStore RAM cache is the single source of truth (avoids duplicates from DOM rows that still carry a SENDING nonce)
    const hasBridge = !!(br && typeof br.isAvailable === 'function' && br.isAvailable() && cid);
    if (hasBridge && typeof br.getCachedChannelMessages === 'function') {
      const ramMsgs = br.getCachedChannelMessages(cid).filter(m => !isTombstoned(m.rawId || m.id));
      mergeMessagesIntoChannelIndex(cid, ramMsgs);
    } else if (!cid || cid === curCid) {
      const domMsgs = readVisibleMessages().filter(m => !isTombstoned(m.id));
      mergeMessagesIntoChannelIndex(cid, domMsgs);
    }

    const arr = Array.from(entry.itemsMap.values()).filter(m => !isTombstoned(m.rawId || m.id));
    arr.sort((a, b) => {
      const sa = extractSnowflake(a.rawId || a.id);
      const sb = extractSnowflake(b.rawId || b.id);
      if (sa && sb) {
        const ba = BigInt(sa), bb = BigInt(sb);
        return ba < bb ? -1 : (ba > bb ? 1 : 0);
      }
      return 0;
    });
    return arr;
  }

  function getChannelIndexStats(channelId) {
    const entry = getOrCreateChannelIndex(channelId);
    return {
      channelId: entry.channelId,
      label: entry.label,
      path: entry.path,
      totalResults: entry.totalResults,
      indexedCount: entry.itemsMap.size,
      oldestRawId: entry.oldestRawId,
      oldestMyRawId: entry.oldestMyRawId,
      reachedTop: entry.reachedTop,
      autoIndexed: entry.autoIndexed
    };
  }

  // Translate filterQuery tokens (age:>14d, age:<24h, age:1d-1y, has:link, has:media) into server-side /search parameters.
  function buildServerSearchPushdown(filterQuery) {
    const out = {};
    if (!filterQuery || typeof filterQuery !== 'string') return out;
    const flt = window.__dcFilter;
    const br = getBridge();
    const toSf = (ms) => (br && br.timestampMsToSnowflake)
      ? br.timestampMsToSnowflake(ms)
      : String((BigInt(Math.max(Number(DISCORD_EPOCH) + 1, Math.round(ms))) - DISCORD_EPOCH) << 22n);

    const q = filterQuery.trim();
    const ageMatch = q.match(/(?:^|\s)age:([^\s]+)/i);
    if (ageMatch && flt && typeof flt.parseAgeSpec === 'function') {
      const spec = flt.parseAgeSpec(ageMatch[1]);
      if (spec) {
        const now = Date.now();
        if (typeof spec.minMs === 'number' && spec.minMs > 0) {
          out.maxId = toSf(now - spec.minMs);
        }
        if (typeof spec.maxMs === 'number' && Number.isFinite(spec.maxMs)) {
          out.minId = toSf(now - spec.maxMs);
        }
      }
    }
    if (/\bhas:link\b/i.test(q)) out.has = 'link';
    else if (/\bhas:(?:media|image)\b/i.test(q)) out.has = 'image';
    else if (/\bhas:embed\b/i.test(q)) out.has = 'embed';
    return out;
  }

  async function scanChannelInBackground(opts) {
    const options = opts || {};
    const br = getBridge();
    const cid = String(options.channelId || (br && br.getCurrentChannelIdFromUrl ? br.getCurrentChannelIdFromUrl() : '') || '');
    const entry = getOrCreateChannelIndex(cid);

    if (!br || !br.isAvailable || !br.isAvailable()) {
      const fallback = getChannelMessages(cid);
      return {
        ok: true,
        mode: 'dom',
        channelId: cid,
        totalResults: fallback.length,
        added: 0,
        items: fallback
      };
    }

    const beforeCount = entry.itemsMap.size;
    entry.autoIndexed = true;
    const pushdown = buildServerSearchPushdown(options.filterQuery);
    const effectiveMaxId = options.maxId || pushdown.maxId || (options.advanceCursor ? entry.oldestMyRawId : undefined);
    const effectiveMinId = options.minId || pushdown.minId || undefined;
    const effectiveHas   = options.has || pushdown.has || undefined;

    // Parallel Multi-Slice Execution with Singleflight coalescing + completed-slice ledger:
    // identical concurrent requests share one Promise; already-fetched slices are never refetched.
    if (!entry.inFlightSlices) entry.inFlightSlices = new Map();
    if (!entry.completedSlices) entry.completedSlices = new Set();
    const runSlice = (key, fn) => {
      if (entry.completedSlices.has(key)) return Promise.resolve(null);
      const pending = entry.inFlightSlices.get(key);
      if (pending) return pending;
      const p = Promise.resolve().then(fn).then((r) => {
        if (r && r.ok) entry.completedSlices.add(key);
        return r;
      }).finally(() => { entry.inFlightSlices.delete(key); });
      entry.inFlightSlices.set(key, p);
      return p;
    };
    const sk = (kind, extra) => [kind, effectiveMaxId || '', effectiveMinId || '', effectiveHas || '', options.content || '', extra || ''].join('|');
    const tasks = [];

    if (options.useSearch !== false) {
      const off0 = typeof options.offset === 'number' ? options.offset : 0;
      tasks.push(runSlice(sk('s', 'o' + off0), () =>
        br.searchChannelMessages({
          channelId: cid,
          maxId: effectiveMaxId,
          minId: effectiveMinId,
          has: effectiveHas,
          content: options.content || undefined,
          offset: off0
        }).then((sRes) => {
          if (sRes && sRes.ok) {
            if (typeof sRes.totalResults === 'number' && !effectiveMaxId && !effectiveMinId && !effectiveHas && (!entry.totalResults || sRes.totalResults > entry.totalResults)) {
              entry.totalResults = sRes.totalResults;
            }
            mergeMessagesIntoChannelIndex(cid, sRes.items);
          }
          return sRes;
        })
      ));

      if (options.parallelBurst) {
        tasks.push(
          runSlice(sk('s', 'o25'), () =>
            br.searchChannelMessages({
              channelId: cid, maxId: effectiveMaxId, minId: effectiveMinId, has: effectiveHas, offset: 25
            }).then((r) => { if (r && r.ok) mergeMessagesIntoChannelIndex(cid, r.items); return r; })
          ),
          runSlice(sk('s', 'asc'), () =>
            br.searchChannelMessages({
              channelId: cid, maxId: effectiveMaxId, minId: effectiveMinId, has: effectiveHas, sortOrder: 'asc'
            }).then((r) => { if (r && r.ok) mergeMessagesIntoChannelIndex(cid, r.items, { trackDescCursor: false }); return r; })
          )
        );
      }
    }

    // True channel start: /messages?after=0 returns the very first 100 messages ever sent (everyone's, not just search-indexed ones)
    if (options.parallelBurst && options.fetchHistoryPage !== false) {
      tasks.push(runSlice('h|after0', () =>
        br.fetchChannelHistoryPage({ channelId: cid, after: '0', limit: 100 })
          .then((r) => { if (r && r.ok) mergeMessagesIntoChannelIndex(cid, r.items, { trackDescCursor: false }); return r; })
      ));
    }

    if (options.fetchHistoryPage !== false) {
      // Dedicated contiguous history cursor: ONLY advanced by /messages pages, never by search/asc slices (prevents skipped gaps)
      const beforeId = options.before || entry.historyCursor || '';
      tasks.push(runSlice('h|b' + beforeId, () =>
        br.fetchChannelHistoryPage({
          channelId: cid,
          before: beforeId || undefined,
          limit: options.limit || 100
        }).then((hRes) => {
          if (hRes && hRes.ok) {
            mergeMessagesIntoChannelIndex(cid, hRes.items);
            if (hRes.oldestRawId && (!entry.historyCursor || BigInt(hRes.oldestRawId) < BigInt(entry.historyCursor))) {
              entry.historyCursor = hRes.oldestRawId;
            }
            if (hRes.reachedTop) entry.reachedTop = true;
          }
          return hRes;
        })
      ));
    }

    await Promise.all(tasks);

    const all = getChannelMessages(cid);
    if (br && br.emit) {
      br.emit('engine:index_updated', { channelId: cid, totalResults: entry.totalResults, count: all.length });
    }
    return {
      ok: true,
      mode: 'bridge',
      channelId: cid,
      totalResults: entry.totalResults !== null ? entry.totalResults : all.length,
      added: Math.max(0, entry.itemsMap.size - beforeCount),
      items: all
    };
  }

  // --- In-app router navigation and pinned cleaning channel (no page reload) ---
  const PINNED_KEY = 'dc_del_pinned_v1';
  let pinnedChannelPath  = '';
  let pinnedChannelLabel = '';
  let returnChannelPath  = '';
  let cachedRouterHistory = null;

  try {
    const rawP = localStorage.getItem(PINNED_KEY);
    if (rawP) {
      const p = JSON.parse(rawP);
      if (typeof p.path === 'string') pinnedChannelPath = p.path;
      if (typeof p.label === 'string') pinnedChannelLabel = p.label;
    }
  } catch (e) {}

  function savePinnedChannel() {
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify({ path: pinnedChannelPath, label: pinnedChannelLabel }));
    } catch (e) {}
  }

  function readCurrentChannelLabel() {
    const t = clean(document.title || '').replace(/\s*-\s*Discord$/i, '');
    return t || window.location.pathname.split('/').pop() || 'Channel';
  }

  function getDiscordRouterHistory() {
    if (cachedRouterHistory && typeof cachedRouterHistory.push === 'function') {
      return cachedRouterHistory;
    }
    const app = document.getElementById('app-mount');
    if (!app) return null;
    const fk = Object.keys(app).find(k => k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactContainer$') === 0);
    if (!fk || !app[fk]) return null;

    const q = [app[fk]];
    let visited = 0;
    while (q.length > 0 && visited < 300) {
      const f = q.shift();
      if (!f) continue;
      visited++;
      const p = f.memoizedProps;
      if (p && p.history && typeof p.history.push === 'function') {
        cachedRouterHistory = p.history;
        return cachedRouterHistory;
      }
      if (f.stateNode && f.stateNode.history && typeof f.stateNode.history.push === 'function') {
        cachedRouterHistory = f.stateNode.history;
        return cachedRouterHistory;
      }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }
    return null;
  }

  function navigateInMemory(targetPath) {
    if (!targetPath || typeof targetPath !== 'string') return false;
    let path = targetPath;
    const idx = path.indexOf('/channels/');
    if (idx !== -1) path = path.slice(idx);
    if (path === window.location.pathname) return true;

    const hist = getDiscordRouterHistory();
    if (hist && typeof hist.push === 'function') {
      try {
        hist.push(path);
        wakeAll();
        return true;
      } catch (e) {}
    }
    try {
      window.history.pushState(null, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
      wakeAll();
      return true;
    } catch (e) {
      return false;
    }
  }

  function pinCurrentChannel(customPath, customLabel) {
    pinnedChannelPath  = customPath || window.location.pathname;
    pinnedChannelLabel = customLabel || readCurrentChannelLabel();
    savePinnedChannel();
    return getPinnedChannel();
  }

  function getPinnedChannel() {
    return {
      path: pinnedChannelPath,
      label: pinnedChannelLabel || 'Pinned Tab',
      isHere: !!pinnedChannelPath && window.location.pathname === pinnedChannelPath
    };
  }

  // Swap between the pinned cleaning channel and the channel currently being browsed.
  function swapToPinnedOrReturn() {
    const cur = window.location.pathname;
    if (!pinnedChannelPath) {
      pinCurrentChannel(cur, readCurrentChannelLabel());
      return { action: 'pinned', path: pinnedChannelPath, label: pinnedChannelLabel };
    }
    if (cur !== pinnedChannelPath) {
      returnChannelPath = cur;
      navigateInMemory(pinnedChannelPath);
      return { action: 'to-pinned', path: pinnedChannelPath, label: pinnedChannelLabel };
    }
    if (returnChannelPath && returnChannelPath !== pinnedChannelPath) {
      const dst = returnChannelPath;
      navigateInMemory(dst);
      return { action: 'to-browsing', path: dst, label: 'Browsing' };
    }
    // Re-pin to current if no return path yet
    pinCurrentChannel(cur, readCurrentChannelLabel());
    return { action: 'pinned', path: pinnedChannelPath, label: pinnedChannelLabel };
  }

  // --- Chat Scroller & Automatic Older History Loader ---
  function findChatScroller() {
    const list = document.querySelector('[data-list-id="chat-messages"]');
    let cur = list ? list.parentElement : null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const style = window.getComputedStyle ? window.getComputedStyle(cur) : null;
      const oy = style ? style.overflowY : '';
      const cls = String(cur.className || '');
      if (oy === 'scroll' || oy === 'auto' || cls.indexOf('scrollerBase') !== -1 || cls.indexOf('scroller_') !== -1) {
        if (cur.clientHeight > 120) return cur;
      }
      cur = cur.parentElement;
    }
    const candidates = document.querySelectorAll('[class*="messagesWrapper"] [class*="scroller"]');
    for (const c of candidates) {
      if (c.clientHeight > 120) return c;
    }
    return null;
  }

  function isAtChannelStart(scroller) {
    const list = document.querySelector('[data-list-id="chat-messages"]');
    if (list) {
      // Discord renders a beginning-of-channel / DM header at the very top of the message list
      const header = list.querySelector('h3, [class*="emptyChannel"], [class*="header_"]');
      if (header && !header.closest('li[id^="chat-messages-"]')) {
        const txt = norm(header.textContent);
        if (txt.indexOf('beginning of') !== -1 || txt.indexOf('welcome to #') !== -1) {
          return true;
        }
      }
      // Also check top container text before the first message
      const firstChild = list.firstElementChild;
      if (firstChild && (!firstChild.id || !firstChild.id.startsWith('chat-messages-'))) {
        const txt = norm(firstChild.textContent);
        if (txt.indexOf('beginning of') !== -1 || txt.indexOf('welcome to #') !== -1) {
          return true;
        }
      }
    }
    if (scroller && scroller.scrollHeight <= scroller.clientHeight + 4) {
      return true;
    }
    return false;
  }

  async function loadOlderMessages(maxSteps, onStatus) {
    const scroller = findChatScroller();
    if (!scroller) return { loaded: 0, reachedTop: true, totalVisible: 0 };

    if (isAtChannelStart(scroller)) {
      return {
        loaded: 0,
        reachedTop: true,
        totalVisible: document.querySelectorAll('li[id^="chat-messages-"]').length
      };
    }

    const steps = Math.max(1, Math.min(10, Number(maxSteps) || 1));
    const seen = new Set(Array.from(document.querySelectorAll('li[id^="chat-messages-"]')).map(el => el.id));
    const startCount = seen.size;
    let reachedTop = false;

    for (let step = 0; step < steps; step++) {
      if (isAtChannelStart(scroller)) {
        reachedTop = true;
        break;
      }
      if (typeof onStatus === 'function') {
        try { onStatus(steps > 1 ? ('Loading (' + (step + 1) + '/' + steps + ')...') : 'Loading...'); } catch (e) {}
      }

      scroller.scrollTop = 0;
      try {
        scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
      } catch (e) {}

      let addedThisStep = 0;
      for (let waited = 0; waited < 1100; waited += 110) {
        await new Promise(r => setTimeout(r, 110));
        const curEls = document.querySelectorAll('li[id^="chat-messages-"]');
        for (let i = 0; i < curEls.length; i++) {
          if (!seen.has(curEls[i].id)) {
            seen.add(curEls[i].id);
            addedThisStep++;
          }
        }
        if (addedThisStep > 0) break;
      }

      if (addedThisStep === 0 || isAtChannelStart(scroller)) {
        reachedTop = true;
        break;
      }
    }

    return {
      loaded: seen.size - startCount,
      reachedTop,
      totalVisible: document.querySelectorAll('li[id^="chat-messages-"]').length
    };
  }

  // --- Live Server Rate-Limit Telemetry (populated by native CDP Network sniffer) ---
  let lastRateLimit = null;
  let rateLimitSeq = 0;

  function toFiniteNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function formatBucketLabel(rl) {
    if (!rl) return '';
    if (rl.status === 429) return '429 Limited';
    if (rl.remaining !== null) {
      return rl.limit !== null
        ? ('Live ' + rl.remaining + '/' + rl.limit)
        : ('Live ' + rl.remaining);
    }
    return '';
  }

  function onServerRateLimit(info) {
    if (!info || typeof info !== 'object') return;
    const status = toFiniteNum(info.status);
    const limit = toFiniteNum(info.limit);
    const remaining = toFiniteNum(info.remaining);
    const resetAfterMs = toFiniteNum(info.resetAfterMs);
    const retryAfterMs = toFiniteNum(info.retryAfterMs);
    const bucket = (typeof info.bucket === 'string' && info.bucket) ? info.bucket : null;
    const receivedAt = Date.now();

    if (status !== 429 && remaining === null && resetAfterMs === null && retryAfterMs === null) {
      return;
    }

    lastRateLimit = {
      status: status !== null ? Math.round(status) : null,
      limit: limit !== null ? Math.max(0, Math.round(limit)) : null,
      remaining: remaining !== null ? Math.max(0, Math.round(remaining)) : null,
      resetAfterMs: resetAfterMs !== null ? Math.max(0, Math.round(resetAfterMs)) : null,
      retryAfterMs: retryAfterMs !== null ? Math.max(0, Math.round(retryAfterMs)) : null,
      bucket,
      receivedAt,
      seq: ++rateLimitSeq
    };

    state.bucketLabel = formatBucketLabel(lastRateLimit);
    if (state.running) {
      emitProgress(activeOnProgress);
    }
  }

  function getRateLimitInfo() {
    if (!lastRateLimit) return null;
    return {
      status: lastRateLimit.status,
      limit: lastRateLimit.limit,
      remaining: lastRateLimit.remaining,
      resetAfterMs: lastRateLimit.resetAfterMs,
      retryAfterMs: lastRateLimit.retryAfterMs,
      bucket: lastRateLimit.bucket,
      receivedAt: lastRateLimit.receivedAt
    };
  }

  // --- Engine State & Interruptible Timing ---
  let stopRequested = false;
  let activeOnProgress = null;
  const wakeResolvers = new Set();

  const state = {
    running: false,
    paused: false,
    deleted: 0,
    skipped: 0,
    failed: 0,
    total: 0,
    processed: 0,
    currentLabel: '',
    cooldownMs: 0,
    pacingLabel: '',
    bucketLabel: '',
    mode: 'idle',
    stopped: false,
    done: false,
    lastDeletedId: ''
  };

  function getState() {
    return Object.assign({}, state);
  }

  function emitProgress(cb) {
    const fn = cb || activeOnProgress;
    if (typeof fn === 'function') {
      try { fn(getState()); } catch (e) {}
    }
  }

  function wakeAll() {
    for (const fn of Array.from(wakeResolvers)) {
      wakeResolvers.delete(fn);
      try { fn(); } catch (e) {}
    }
  }

  function interruptibleSleep(ms) {
    if (stopRequested || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        wakeResolvers.delete(onWake);
        resolve();
      };
      const onWake = () => {
        if (stopRequested) done();
      };
      const timer = setTimeout(done, ms);
      wakeResolvers.add(onWake);
    });
  }

  function waitWhilePaused() {
    if (!state.paused || stopRequested) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (!state.paused || stopRequested) {
          wakeResolvers.delete(check);
          resolve();
        }
      };
      wakeResolvers.add(check);
      check();
    });
  }

  async function waitWithCountdown(totalMs, labelPrefix, onProgress, fixedLabel) {
    let remaining = Math.max(0, Math.round(totalMs));
    const tick = 120;
    while (remaining > 0) {
      if (stopRequested) break;
      if (state.paused) {
        state.pacingLabel = 'Paused';
        emitProgress(onProgress);
        await waitWhilePaused();
        if (stopRequested) break;
      }
      state.cooldownMs = remaining;
      state.pacingLabel = fixedLabel || (labelPrefix + ' ' + (remaining / 1000).toFixed(1) + 's');
      emitProgress(onProgress);
      const step = Math.min(tick, remaining);
      await interruptibleSleep(step);
      remaining -= step;
    }
    state.cooldownMs = 0;
  }

  function resetState(mode, total) {
    stopRequested = false;
    state.running = true;
    state.paused = false;
    state.deleted = 0;
    state.skipped = 0;
    state.failed = 0;
    state.total = total;
    state.processed = 0;
    state.currentLabel = '';
    state.cooldownMs = 0;
    state.pacingLabel = '';
    state.bucketLabel = (lastRateLimit && (Date.now() - lastRateLimit.receivedAt) < 30000)
      ? formatBucketLabel(lastRateLimit)
      : '';
    state.mode = mode;
    state.stopped = false;
    state.done = false;
    state.lastDeletedId = '';
  }

  // --- Discord Menu Helpers ---
  function dismissContextMenu() {
    const active = document.querySelector('[role="menu"]') || document.activeElement || document;
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    try { active.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) {}
    try { document.dispatchEvent(new KeyboardEvent('keydown', init)); } catch (e) {}
    try { active.dispatchEvent(new KeyboardEvent('keyup', init)); } catch (e) {}
  }

  function findDeleteMenuItem() {
    let delItem = document.getElementById('message-delete') ||
                  document.getElementById('message-actions-delete');
    if (delItem) return delItem;
    const items = document.querySelectorAll('[role="menuitem"]');
    for (const it of items) {
      const t = norm(it.textContent);
      if (t === 'delete message' || t.startsWith('delete message')) return it;
    }
    return null;
  }

  function findDiscordConfirmDeleteButton() {
    const dialogs = document.querySelectorAll('[role="dialog"] button, [class*="modal"] button');
    for (const b of dialogs) {
      if (b.closest && b.closest('#' + SIDEBAR_ROOT_ID)) continue;
      if (b.offsetParent === null) continue;
      if (clean(b.textContent) === 'Delete') return b;
    }
    return null;
  }

  function removeMessageFromIndex(channelId, rawOrDomId) {
    markTombstone(rawOrDomId);
    const sf = extractSnowflake(rawOrDomId) || rawOrDomId;
    if (channelId) {
      const entry = channelIndexCache.get(String(channelId));
      if (entry) {
        const had = entry.itemsMap.delete(sf) || entry.itemsMap.delete(rawOrDomId);
        if (had && typeof entry.totalResults === 'number' && entry.totalResults > 0) {
          entry.totalResults = Math.max(0, entry.totalResults - 1);
        }
      }
    }
    // Also sweep all cached channels in case channelId was omitted or mismatched
    for (const entry of channelIndexCache.values()) {
      entry.itemsMap.delete(sf);
      entry.itemsMap.delete(rawOrDomId);
    }
  }

  // Subscribe to Discord FluxDispatcher MESSAGE_DELETE / MESSAGE_CREATE so deletes made elsewhere (UI, other clients) keep our index in sync.
  const brInit = getBridge();
  if (brInit && typeof brInit.on === 'function') {
    bridgeUnsubs.push(brInit.on('discord:message_delete', (ev) => {
      if (ev && ev.id) {
        removeMessageFromIndex(ev.channelId, ev.id);
      }
    }));
    bridgeUnsubs.push(brInit.on('discord:message_create', (ev) => {
      if (ev && ev.channelId && ev.message) {
        mergeMessagesIntoChannelIndex(ev.channelId, [ev.message]);
      }
    }));
  }

  function triggerDissolveOnSidebarRow(rawOrDomId) {
    const vfx = getVfx();
    if (!vfx) return;
    const root = document.getElementById(SIDEBAR_ROOT_ID);
    if (!root || !root.querySelectorAll) return;
    const sf = extractSnowflake(rawOrDomId);
    const rows = root.querySelectorAll('.dc-sb-row');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rid = r.dataset ? r.dataset.id : '';
      if (rid === rawOrDomId || (sf && rid && rid.endsWith(sf))) {
        try {
          if (typeof vfx.previewOnElement === 'function') {
            vfx.previewOnElement(r);
          }
        } catch (e) {}
        break;
      }
    }
  }

  // --- Single Message Delete (In-Memory Direct API Fast Path -> Shift+Hover -> Stealth ContextMenu Fallback) ---
  async function attemptDeleteMessage(msgId, explicitChannelId, isEphemeralHint) {
    const br = getBridge();
    const curCid = (br && br.getCurrentChannelIdFromUrl) ? br.getCurrentChannelIdFromUrl() : '';
    const targetCid = String(explicitChannelId || curCid || '');
    const sf = extractSnowflake(msgId);
    const li = document.getElementById(msgId) || (sf ? document.querySelector(`li[id$="-${sf}"]`) : null);
    const vfx = getVfx();

    // 1. Bridge path: delete via Discord internals; no DOM needed, works while another channel is open.
    if (br && typeof br.isAvailable === 'function' && br.isAvailable() && targetCid && sf) {
      if (li && vfx) vfx.setTargeting(li);
      if (settings.mouseCursor && window.__dcMouseCursor && typeof window.__dcMouseCursor.moveToElement === 'function') {
        // The mouse animation is confined to the Mouse Env tab; it never touches the Controls list.
        const pop = window.__dcPopoutChat;
        const btnTarget = (pop && typeof pop.getDeleteButton === 'function') ? pop.getDeleteButton(msgId) : null;
        if (btnTarget) {
          const prof = getSpeedProfile(settings.speedSlider);
          const glideMs = prof.zone === 'risky' ? 75 : (prof.zone === 'focused' ? 180 : 320);
          const pressMs = prof.zone === 'risky' ? 35 : (prof.zone === 'focused' ? 65 : 95);
          if (window.__dcMouseCursor.show) window.__dcMouseCursor.show();
          await window.__dcMouseCursor.moveToElement(btnTarget, { aimCenter: true, durationMs: glideMs });
          btnTarget.classList.add('dc-pressed');
          btnTarget.style.background = '#da373c';
          btnTarget.style.color = '#fff';
          btnTarget.style.transform = 'scale(0.84)';
          await interruptibleSleep(pressMs);
          btnTarget.classList.remove('dc-pressed');
        } else if ((!pop || !pop.isOpen || !pop.isOpen() || (pop.isMinimized && pop.isMinimized())) && window.__dcMouseCursor.hide) {
          window.__dcMouseCursor.hide();
        }
        if (stopRequested) {
          if (vfx) vfx.clearTargeting();
          return 'stopped';
        }
      }
      const armedDissolve = (li && vfx) ? vfx.armDissolveOnRemoval(li) : null;
      const isEph = !!isEphemeralHint || !!(li && findDismissButton(li));

      // Only dissolve the card in Controls when the Mouse Env tab is not showing it.
      if (!(window.__dcPopoutChat && window.__dcPopoutChat.isOpen && window.__dcPopoutChat.isOpen())) {
        triggerDissolveOnSidebarRow(msgId);
      }

      const res = await br.deleteMessageInMemory(targetCid, sf, isEph);
      if (vfx) vfx.clearTargeting();

      if (res && res.ok) {
        const wasLocalDismiss = isEph || res.mode === 'local-dismiss' || res.mode === 'flux-dismiss';
        removeMessageFromIndex(targetCid, msgId);
        if (armedDissolve && !armedDissolve.hasFired()) {
          armedDissolve.triggerNow();
        }
        if (br.emit) {
          br.emit('engine:message_deleted', { channelId: targetCid, id: msgId, rawId: sf, isEphemeral: wasLocalDismiss });
        }
        return wasLocalDismiss ? 'dismissed' : 'deleted';
      }

      if (res && res.status === 403) {
        if (armedDissolve) armedDissolve.cancel();
        removeMessageFromIndex(targetCid, msgId);
        return 'no-permission';
      }

      if (res && res.status === 429) {
        if (armedDissolve) armedDissolve.cancel();
        onServerRateLimit({
          status: 429,
          remaining: 0,
          retryAfterMs: res.retryAfterMs || 3500
        });
        return 'rate-limited';
      }

      if (armedDissolve) armedDissolve.cancel();
      // If we are not viewing this channel in the DOM, we cannot use DOM click fallback
      if (!li) return 'still-present';
    }

    if (!li) return 'missing';

    // Scroll only if the message is actually offscreen, to avoid jumping the user's view.
    const preRect = li.getBoundingClientRect ? li.getBoundingClientRect() : null;
    const isOffscreen = preRect && (preRect.top < 48 || preRect.bottom > window.innerHeight - 64);
    if (isOffscreen) {
      li.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      await interruptibleSleep(60);
      if (stopRequested) return 'stopped';
    }

    const curLi = document.getElementById(li.id) || li;
    if (!curLi) return 'missing';

    if (vfx) vfx.setTargeting(curLi);
    triggerDissolveOnSidebarRow(msgId);

    // Take the placeholder and pixel snapshot before dismiss/delete, while the row still exists.
    const armedDissolve = vfx ? vfx.armDissolveOnRemoval(curLi) : null;

    // Path 0: ephemeral message (Clyde etc.) is dismissed locally rather than deleted.
    const dismissBtn = findDismissButton(curLi);
    if (dismissBtn) {
      try { dismissBtn.click(); } catch (e) {}
      await interruptibleSleep(120);
      if (vfx) vfx.clearTargeting();
      if (!document.getElementById(msgId)) {
        removeMessageFromIndex(targetCid, msgId);
        if (armedDissolve && !armedDissolve.hasFired()) armedDissolve.triggerNow();
        if (br && br.emit) br.emit('engine:message_deleted', { channelId: targetCid, id: msgId, rawId: sf, isEphemeral: true });
        return 'dismissed';
      }
      if (armedDissolve) armedDissolve.cancel();
      return 'still-present';
    }

    const target = curLi.querySelector('[role="article"]') || curLi.firstElementChild || curLi;
    const rect = target.getBoundingClientRect();
    const cx = Math.max(12, Math.min(window.innerWidth - 12, Math.round(rect.left + Math.min(rect.width * 0.5, 120))));
    const cy = Math.max(12, Math.min(window.innerHeight - 12, Math.round(rect.top + rect.height * 0.5)));

    const useStealth = !!settings.hideDiscordMenu;
    if (useStealth && document.body) {
      document.body.classList.add('dc-vfx-stealth-menu');
    }

    let usedFastShiftHover = false;
    try {
      // Fast path: Shift + Hover reveals Discord's 1-click Delete Message icon directly
      const shiftDown = { key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, shiftKey: true, bubbles: true };
      const shiftUp   = { key: 'Shift', code: 'ShiftLeft', keyCode: 16, which: 16, shiftKey: false, bubbles: true };
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', shiftDown));
        document.dispatchEvent(new KeyboardEvent('keydown', shiftDown));
      } catch (e) {}

      const hoverOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, shiftKey: true };
      for (const el of [curLi, target]) {
        try {
          el.dispatchEvent(new PointerEvent('pointerover', hoverOpts));
          el.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, hoverOpts, { bubbles: false })));
          el.dispatchEvent(new MouseEvent('mouseover', hoverOpts));
          el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, hoverOpts, { bubbles: false })));
          el.dispatchEvent(new MouseEvent('mousemove', hoverOpts));
        } catch (e) {}
      }

      await interruptibleSleep(95);
      if (stopRequested) {
        try { window.dispatchEvent(new KeyboardEvent('keyup', shiftUp)); } catch (e) {}
        if (armedDissolve) armedDissolve.cancel();
        if (vfx) vfx.clearTargeting();
        return 'stopped';
      }

      const directDelBtn = curLi.querySelector('[aria-label="Delete Message"], [aria-label="Delete"]');
      if (directDelBtn) {
        usedFastShiftHover = true;
        directDelBtn.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          shiftKey: true
        }));
        await interruptibleSleep(110);
        try {
          window.dispatchEvent(new KeyboardEvent('keyup', shiftUp));
          document.dispatchEvent(new KeyboardEvent('keyup', shiftUp));
        } catch (e) {}
      } else {
        try {
          window.dispatchEvent(new KeyboardEvent('keyup', shiftUp));
          document.dispatchEvent(new KeyboardEvent('keyup', shiftUp));
        } catch (e) {}

        // Fallback: stealth context menu path
        target.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          view: window,
          button: 2,
          buttons: 2,
          clientX: cx,
          clientY: cy
        }));
        await interruptibleSleep(145);
        if (stopRequested) {
          dismissContextMenu();
          if (armedDissolve) armedDissolve.cancel();
          if (vfx) vfx.clearTargeting();
          return 'stopped';
        }

        const delItem = findDeleteMenuItem();
        if (!delItem) {
          dismissContextMenu();
          await interruptibleSleep(55);
          if (armedDissolve) armedDissolve.cancel();
          if (vfx) {
            vfx.clearTargeting();
            vfx.flashSkipped(curLi);
          }
          return 'no-permission';
        }

        delItem.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          shiftKey: true
        }));
        await interruptibleSleep(155);
        if (stopRequested) {
          if (armedDissolve) armedDissolve.cancel();
          if (vfx) vfx.clearTargeting();
          return 'stopped';
        }
      }

      const confirmBtn = findDiscordConfirmDeleteButton();
      if (confirmBtn) {
        confirmBtn.click();
        await interruptibleSleep(120);
        if (stopRequested) {
          if (armedDissolve) armedDissolve.cancel();
          if (vfx) vfx.clearTargeting();
          return 'stopped';
        }
      }
    } finally {
      if (useStealth && document.body) {
        document.body.classList.remove('dc-vfx-stealth-menu');
      }
    }

    await interruptibleSleep(usedFastShiftHover ? 190 : 230);
    if (stopRequested) {
      if (armedDissolve) armedDissolve.cancel();
      if (vfx) vfx.clearTargeting();
      return 'stopped';
    }

    const stillThere = !!document.getElementById(msgId);
    if (vfx) vfx.clearTargeting();

    if (!stillThere) {
      removeMessageFromIndex(targetCid, msgId);
      if (armedDissolve && !armedDissolve.hasFired()) {
        armedDissolve.triggerNow();
      }
      if (br && br.emit) br.emit('engine:message_deleted', { channelId: targetCid, id: msgId, rawId: sf, isEphemeral: false });
      return 'deleted';
    }

    if (armedDissolve) armedDissolve.cancel();
    return 'still-present';
  }

  // --- Live Header + Adaptive AIMD + Human-Rhythm Pacing Controller ---
  function createPacingController() {
    let bucketDeletes = 0;
    let bucketWindowStartTs = 0;
    let backoffStep = 0;
    let burstCount = 0;
    let nextBurstLimit = randInt(20, 42);

    function currentBaseMs(tier) {
      if (!settings.learnedPacing) return PACING[tier].baseMs;
      return tier === 'older' ? learned.olderMs : learned.recentMs;
    }

    function recordSuccess(tier) {
      if (!settings.learnedPacing) return;
      const cfg = PACING[tier];
      if (tier === 'older') {
        learned.olderStreak++;
        if (learned.olderStreak >= 10) {
          learned.olderStreak = 0;
          learned.olderMs = Math.max(cfg.minMs, learned.olderMs - 30);
          saveLearned();
        }
      } else {
        learned.recentStreak++;
        if (learned.recentStreak >= 10) {
          learned.recentStreak = 0;
          learned.recentMs = Math.max(cfg.minMs, learned.recentMs - 25);
          saveLearned();
        }
      }
    }

    function recordThrottle(tier) {
      if (!settings.learnedPacing) return;
      const cfg = PACING[tier];
      if (tier === 'older') {
        learned.olderStreak = 0;
        learned.olderMs = Math.min(1850, Math.round(learned.olderMs * 1.18));
      } else {
        learned.recentStreak = 0;
        learned.recentMs = Math.min(1400, Math.round(learned.recentMs * 1.18));
      }
      saveLearned();
    }

    function getFreshRateLimit(deleteStartTs, deleteStartSeq) {
      if (!lastRateLimit) return null;
      if (lastRateLimit.receivedAt < deleteStartTs) return null;
      if (typeof deleteStartSeq === 'number' && lastRateLimit.seq <= deleteStartSeq) return null;
      return lastRateLimit;
    }

    return {
      async deleteWithVerification(msgId, onProgress, explicitChannelId, isEphemeralHint) {
        const age = classifyMessageAge(msgId);
        const cfg = PACING[age.tier];
        const base = currentBaseMs(age.tier);
        const prof = getSpeedProfile(settings.speedSlider);
        if (lastRateLimit && (Date.now() - lastRateLimit.receivedAt) < 15000 && state.bucketLabel) {
          state.pacingLabel = state.bucketLabel + ' \u2022 ' + prof.label;
        } else {
          state.pacingLabel = prof.label + ' (~' + (prof.medianMs / 1000).toFixed(2) + 's)';
        }
        emitProgress(onProgress);

        // Retry up to 5 times on 429 or transient failure so rate-limited messages are not skipped.
        const MAX_ATTEMPTS = 5;
        let lastStartTs = Date.now();
        let lastStartSeq = rateLimitSeq;
        let waitedOnRetry = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (stopRequested) return { status: 'stopped', age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq };
          if (attempt > 1) {
            state.pacingLabel = 'Retry ' + attempt + '/' + MAX_ATTEMPTS + '...';
            emitProgress(onProgress);
          }

          lastStartTs = Date.now();
          lastStartSeq = rateLimitSeq;
          const res = await attemptDeleteMessage(msgId, explicitChannelId, isEphemeralHint);
          if (res === 'dismissed') {
            return { status: 'dismissed', age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq, alreadyWaited: waitedOnRetry };
          }
          if (res === 'deleted') {
            if (bucketDeletes === 0) bucketWindowStartTs = lastStartTs;
            backoffStep = 0;
            bucketDeletes++;
            if (state.bucketLabel === '429 Limited' || state.bucketLabel === 'Rate Limited') state.bucketLabel = '';
            recordSuccess(age.tier);
            return { status: 'deleted', age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq, alreadyWaited: false };
          }
          if (res === 'missing' || res === 'no-permission' || res === 'stopped') {
            return { status: res, age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq };
          }

          // Rate-limited (429) or transient failure -> wait the server-provided retry_after / reset_after, then retry.
          const rl = getFreshRateLimit(lastStartTs, lastStartSeq);
          waitedOnRetry = true;
          if ((rl && rl.status === 429) || res === 'rate-limited') {
            state.rateLimits = (state.rateLimits || 0) + 1;
            recordThrottle(age.tier);
            const rawWait = (rl && rl.retryAfterMs && rl.retryAfterMs > 0)
              ? rl.retryAfterMs
              : ((rl && rl.resetAfterMs && rl.resetAfterMs > 0) ? rl.resetAfterMs : (2500 * attempt));
            bucketDeletes = 0;
            bucketWindowStartTs = 0;
            await waitWithCountdown(rawWait + 350, '429 Retry ' + attempt + '/' + MAX_ATTEMPTS, onProgress);
          } else if (rl && rl.remaining === 0) {
            const rawReset = (rl.resetAfterMs && rl.resetAfterMs > 0) ? rl.resetAfterMs : 4200;
            const limTxt = rl.limit !== null ? String(rl.limit) : '?';
            bucketDeletes = 0;
            bucketWindowStartTs = 0;
            await waitWithCountdown(rawReset + 220, 'Bucket 0/' + limTxt + ' \u2022 Reset', onProgress);
          } else {
            recordThrottle(age.tier);
            const delayMs = BACKOFF_STEPS_MS[Math.min(backoffStep, BACKOFF_STEPS_MS.length - 1)];
            backoffStep = Math.min(backoffStep + 1, BACKOFF_STEPS_MS.length - 1);
            bucketDeletes = 0;
            bucketWindowStartTs = 0;
            await waitWithCountdown(delayMs, 'Retry Backoff', onProgress);
          }
          if (stopRequested) return { status: 'stopped', age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq };

          // Check if message actually vanished during the wait
          const br = getBridge();
          const isInMemoryMode = !!(br && br.isAvailable && br.isAvailable() && explicitChannelId);
          if (!isInMemoryMode && !document.getElementById(msgId)) {
            bucketDeletes++;
            return { status: 'deleted', age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq, alreadyWaited: true };
          }
        }
        return { status: 'failed', age, deleteStartTs: lastStartTs, deleteStartSeq: lastStartSeq };
      },

      async paceAfterDelete(age, onProgress, deleteStartTs, deleteStartSeq, alreadyWaited) {
        if (alreadyWaited) return;
        const prof = getSpeedProfile(settings.speedSlider);
        const spentMs = deleteStartTs ? Math.max(0, Date.now() - deleteStartTs) : 0;

        // 1. Exact live server rate-limit header pacing when fresh telemetry arrived
        const rl = getFreshRateLimit(deleteStartTs || 0, deleteStartSeq);
        if (rl) {
          if (rl.status === 429) {
            state.rateLimits = (state.rateLimits || 0) + 1;
            recordThrottle(age.tier);
            const rawWait = (rl.retryAfterMs && rl.retryAfterMs > 0)
              ? rl.retryAfterMs
              : ((rl.resetAfterMs && rl.resetAfterMs > 0) ? rl.resetAfterMs : 3500);
            bucketDeletes = 0;
            bucketWindowStartTs = 0;
            await waitWithCountdown(rawWait + 350, '429 Retry', onProgress);
            return;
          }
          if (rl.remaining === 0) {
            const rawReset = (rl.resetAfterMs && rl.resetAfterMs > 0) ? rl.resetAfterMs : 4200;
            const limTxt = rl.limit !== null ? String(rl.limit) : '?';
            bucketDeletes = 0;
            bucketWindowStartTs = 0;
            await waitWithCountdown(rawReset + 220, 'Bucket 0/' + limTxt + ' \u2022 Reset', onProgress);
            return;
          }
          if (rl.remaining !== null && rl.remaining > 0) {
            const targetMs = prof.zone === 'risky' ? randInt(160, 260) : Math.max(220, sampleLogNormalMs(prof.medianMs, prof.sigma));
            const remMs = Math.max(30, targetMs - spentMs);
            const limTxt = rl.limit !== null ? String(rl.limit) : '?';
            const liveLabel = 'Live ' + rl.remaining + '/' + limTxt + ' \u2022 ' + (prof.zone === 'risky' ? 'Max' : prof.label);
            await waitWithCountdown(remMs, liveLabel, onProgress, liveLabel);
            burstCount++;
            if (prof.pauseMaxMs > 0 && burstCount >= nextBurstLimit) {
              burstCount = 0;
              nextBurstLimit = randInt(prof.burstMin, prof.burstMax);
              await waitWithCountdown(randInt(prof.pauseMinMs, prof.pauseMaxMs), 'Human Pause', onProgress);
            }
            return;
          }
        }

        // 2. Fallback without live rate-limit headers: slider-driven cadence with an AIMD-adjusted floor.
        // At 100% Max, it automatically locks onto Discord's exact zero-429 ceiling instead of slamming 429s.
        const sliderMs = prof.zone === 'risky'
          ? randInt(180, 280)
          : Math.max(240, sampleLogNormalMs(prof.medianMs, prof.sigma));
        const safeFloorMs = settings.learnedPacing ? currentBaseMs(age.tier) : 0;
        const targetMs = Math.max(sliderMs, safeFloorMs);
        const remMs = Math.max(30, targetMs - spentMs);
        await waitWithCountdown(remMs, prof.label, onProgress);
        burstCount++;
        if (prof.pauseMaxMs > 0 && burstCount >= nextBurstLimit) {
          burstCount = 0;
          nextBurstLimit = randInt(prof.burstMin, prof.burstMax);
          await waitWithCountdown(randInt(prof.pauseMinMs, prof.pauseMaxMs), 'Human Pause', onProgress);
        }
      }
    };
  }

  // --- Mode 1: delete selected items (works for any channel, not only the one on screen) ---
  async function runSelected(items, onProgress, opts) {
    if (state.running) return getState();
    const list = Array.isArray(items) ? (settings.newestFirst ? items.slice().reverse() : items.slice()) : [];
    const options = opts || {};
    const br = getBridge();
    const hasInMemoryBridge = !!(br && br.isAvailable && br.isAvailable());
    const startPath = options.channelPath || window.location.pathname;
    const targetChannelId = String(options.channelId || (br && br.getCurrentChannelIdFromUrl ? br.getCurrentChannelIdFromUrl(startPath) : '') || '');

    activeOnProgress = typeof onProgress === 'function' ? onProgress : null;
    resetState('selected', list.length);
    emitProgress(activeOnProgress);

    const pacer = createPacingController();
    pinCurrentChannel(startPath, options.channelLabel || readCurrentChannelLabel());

    try {
      for (let i = 0; i < list.length; i++) {
        if (stopRequested) break;
        if (!hasInMemoryBridge && window.location.pathname !== startPath) {
          await waitWhileOffPinnedChannel(startPath, activeOnProgress);
          if (stopRequested) break;
        }
        if (state.paused) {
          state.pacingLabel = 'Paused';
          emitProgress(activeOnProgress);
          await waitWhilePaused();
          if (stopRequested) break;
        }

        const item = typeof list[i] === 'string' ? { id: list[i], author: '', text: '' } : list[i];
        const itemChannelId = String(item.channelId || targetChannelId || '');
        const isEph = item.actionType === 'dismiss' || !!item.isEphemeral;
        const age = classifyMessageAge(item.id);
        state.currentLabel = 'Deleting ' + (i + 1) + ' of ' + list.length + (age.isOlder ? ' (>14d)' : ' (<14d)');
        state.lastDeletedId = '';
        emitProgress(activeOnProgress);

        const res = await pacer.deleteWithVerification(item.id, activeOnProgress, itemChannelId, isEph);
        if (res.status === 'stopped') break;

        state.processed++;
        if (res.status === 'deleted' || res.status === 'dismissed') {
          state.deleted++;
          state.lastDeletedId = item.id;
        } else if (res.status === 'failed') {
          state.failed++;
          state.skipped++;
        } else {
          state.skipped++;
        }
        emitProgress(activeOnProgress);

        if (i + 1 < list.length && !stopRequested) {
          if (res.status === 'deleted' || res.status === 'failed') {
            await pacer.paceAfterDelete(res.age, activeOnProgress, res.deleteStartTs, res.deleteStartSeq, res.alreadyWaited);
          } else if (res.status === 'dismissed') {
            const prof = getSpeedProfile(settings.speedSlider);
            const targetMs = prof.zone === 'risky' ? 120 : sampleLogNormalMs(prof.medianMs, prof.sigma);
            const spentMs = res.deleteStartTs ? Math.max(0, Date.now() - res.deleteStartTs) : 0;
            const remMs = Math.max(20, targetMs - spentMs);
            await interruptibleSleep(remMs);
          } else {
            await interruptibleSleep(80);
          }
        }
      }
    } finally {
      // Automatic post-run reconciliation: flush any tombstoned local/optimistic messages still lingering in MessageStore
      if (hasInMemoryBridge && targetChannelId && br && br.resolveInternals && br.getCachedChannelMessages) {
        try {
          const core = br.resolveInternals(false);
          if (core && core.FluxDispatcher) {
            for (const m of br.getCachedChannelMessages(targetChannelId)) {
              if (isTombstoned(m.rawId) || isTombstoned(m.id)) {
                core.FluxDispatcher.dispatch({ type: 'MESSAGE_DELETE', id: m.rawId, channelId: targetChannelId });
              }
            }
          }
        } catch (e) {}
      }
      state.running = false;
      state.paused = false;
      state.cooldownMs = 0;
      state.stopped = stopRequested;
      state.done = !stopRequested;
      state.pacingLabel = stopRequested ? 'Stopped' : 'Done';
      state.currentLabel = (stopRequested ? 'Stopped. ' : 'Completed. ') +
        'Deleted ' + state.deleted + (state.skipped ? (', skipped ' + state.skipped) : '') + '.';
      emitProgress(activeOnProgress);
      activeOnProgress = null;
    }

    return getState();
  }

  // --- Channel guard: without the bridge, pause while the user is in another channel; resume on return (Alt+W). ---
  async function waitWhileOffPinnedChannel(startPath, onProgress) {
    if (!startPath || window.location.pathname === startPath || stopRequested) return;
    while (window.location.pathname !== startPath && !stopRequested) {
      returnChannelPath = window.location.pathname;
      state.pacingLabel = 'Pinned (Alt+W)';
      state.currentLabel = 'Browsing other tab \u2014 press Alt+W to return to ' + (pinnedChannelLabel || 'pinned tab') + ' & resume';
      emitProgress(onProgress);
      await interruptibleSleep(180);
    }
    if (!stopRequested) {
      state.pacingLabel = 'Resuming...';
      emitProgress(onProgress);
      await interruptibleSleep(220);
    }
  }

  // --- Mode 2: Delete All Your Messages in Target Tab (Background In-Memory Search + New-Message Fence + DOM Fallback) ---
  async function runAllInCurrentTab(onProgress, opts) {
    if (state.running) return getState();
    const options = opts || {};
    const br = getBridge();
    const flt = window.__dcFilter || null;
    const hasInMemoryBridge = !!(br && br.isAvailable && br.isAvailable());
    const startPath = options.channelPath || window.location.pathname;
    const targetChannelId = String(options.channelId || (br && br.getCurrentChannelIdFromUrl ? br.getCurrentChannelIdFromUrl(startPath) : '') || '');
    const filterQuery = typeof options.filterQuery === 'string' ? options.filterQuery.trim() : '';

    // Fence: never delete messages sent after this job started.
    const fenceSnowflake = (br && br.timestampMsToSnowflake)
      ? br.timestampMsToSnowflake(Date.now() + 500)
      : String(((BigInt(Date.now() + 500) - DISCORD_EPOCH) << 22n));

    activeOnProgress = typeof onProgress === 'function' ? onProgress : null;
    resetState('all', 0);
    state.currentLabel = 'Indexing your messages in background...';
    emitProgress(activeOnProgress);

    const pacer = createPacingController();
    const processedIds = new Set();
    pinCurrentChannel(startPath, options.channelLabel || readCurrentChannelLabel());

    let emptyScrolls = 0;
    let searchCursorMaxId = fenceSnowflake;
    let historyCursorBefore = null;
    let reachedBackgroundEnd = false;
    let verificationSweeps = 0;

    const passesActiveFilter = (msg) => {
      if (!msg || !msg.canRemove) return false;
      const sf = extractSnowflake(msg.rawId || msg.id);
      if (sf && fenceSnowflake && /^\d+$/.test(sf) && /^\d+$/.test(fenceSnowflake)) {
        if (BigInt(sf) > BigInt(fenceSnowflake)) return false; // newer than the job fence
      }
      if (filterQuery && flt && typeof flt.filterMessages === 'function') {
        const res = flt.filterMessages([msg], filterQuery);
        return Array.isArray(res.items) && res.items.length > 0;
      }
      return true;
    };

    try {
      // Initial instant parallel multi-slice background scan when bridge is available
      if (hasInMemoryBridge && targetChannelId) {
        const initialScan = await scanChannelInBackground({
          channelId: targetChannelId,
          maxId: searchCursorMaxId,
          filterQuery,
          parallelBurst: true,
          useSearch: true,
          fetchHistoryPage: true
        });
        if (initialScan && typeof initialScan.totalResults === 'number' && initialScan.totalResults > 0) {
          state.total = initialScan.totalResults;
          emitProgress(activeOnProgress);
        }
      }

      while (!stopRequested) {
        if (!hasInMemoryBridge && window.location.pathname !== startPath) {
          await waitWhileOffPinnedChannel(startPath, activeOnProgress);
          if (stopRequested) break;
        }

        if (state.paused) {
          state.pacingLabel = 'Paused';
          emitProgress(activeOnProgress);
          await waitWhilePaused();
          if (stopRequested) break;
        }

        const pool = hasInMemoryBridge && targetChannelId
          ? getChannelMessages(targetChannelId)
          : readVisibleMessages();

        // Pick newest (bottom-most) or oldest (top-most) unprocessed removable message based on settings.newestFirst
        let targetMsg = null;
        const startIdx = settings.newestFirst ? pool.length - 1 : 0;
        const stepIdx  = settings.newestFirst ? -1 : 1;
        for (let i = startIdx; settings.newestFirst ? (i >= 0) : (i < pool.length); i += stepIdx) {
          const m = pool[i];
          const key = m.rawId || extractSnowflake(m.id) || m.id;
          if (processedIds.has(key) || processedIds.has(m.id)) continue;
          if (!passesActiveFilter(m)) {
            processedIds.add(key);
            processedIds.add(m.id);
            continue;
          }
          targetMsg = m;
          break;
        }

        if (targetMsg) {
          emptyScrolls = 0;
          const rawKey = targetMsg.rawId || extractSnowflake(targetMsg.id) || targetMsg.id;
          processedIds.add(rawKey);
          processedIds.add(targetMsg.id);
          if (state.total < state.deleted + 1) {
            state.total = Math.max(state.total, state.deleted + 1);
          }
          state.lastDeletedId = '';

          if (rawKey && /^\d+$/.test(rawKey)) {
            searchCursorMaxId = rawKey;
          }

          const age = classifyMessageAge(targetMsg.id);
          const snippet = targetMsg.text ? targetMsg.text.slice(0, 32) : '(attachment)';
          const isEph = targetMsg.actionType === 'dismiss' || !!targetMsg.isEphemeral;
          state.currentLabel = isEph
            ? ('Dismissing ephemeral: ' + snippet)
            : ('Deleting (' + (age.isOlder ? '>14d' : '<14d') + '): ' + snippet);
          emitProgress(activeOnProgress);

          const res = await pacer.deleteWithVerification(
            targetMsg.id,
            activeOnProgress,
            targetMsg.channelId || targetChannelId,
            isEph
          );
          if (res.status === 'stopped') break;

          state.processed++;
          if (res.status === 'dismissed') {
            state.deleted++;
            state.lastDeletedId = targetMsg.id;
            const prof = getSpeedProfile(settings.speedSlider);
            const targetMs = prof.zone === 'risky' ? 120 : sampleLogNormalMs(prof.medianMs, prof.sigma);
            const spentMs = res.deleteStartTs ? Math.max(0, Date.now() - res.deleteStartTs) : 0;
            const remMs = Math.max(20, targetMs - spentMs);
            state.pacingLabel = prof.label + ' (~' + (targetMs / 1000).toFixed(2) + 's)';
            emitProgress(activeOnProgress);
            await interruptibleSleep(remMs);
          } else if (res.status === 'deleted') {
            state.deleted++;
            state.lastDeletedId = targetMsg.id;
            emitProgress(activeOnProgress);
            await pacer.paceAfterDelete(res.age, activeOnProgress, res.deleteStartTs, res.deleteStartSeq, res.alreadyWaited);
          } else if (res.status === 'failed') {
            state.failed++;
            state.skipped++;
            emitProgress(activeOnProgress);
            await pacer.paceAfterDelete(res.age, activeOnProgress, res.deleteStartTs, res.deleteStartSeq, res.alreadyWaited);
          } else {
            state.skipped++;
            emitProgress(activeOnProgress);
          }
          continue;
        }

        // Local queue empty -> fetch the next batch in the background if the bridge is available.
        if (hasInMemoryBridge && targetChannelId && !reachedBackgroundEnd) {
          state.currentLabel = 'Fetching older messages in background...';
          state.pacingLabel = 'Indexing...';
          emitProgress(activeOnProgress);

          const idxEntry = getOrCreateChannelIndex(targetChannelId);
          const nextBefore = idxEntry.historyCursor || undefined;
          const bgRes = await scanChannelInBackground({
            channelId: targetChannelId,
            maxId: searchCursorMaxId,
            before: nextBefore,
            filterQuery,
            advanceCursor: true,
            useSearch: true,
            fetchHistoryPage: true,
            limit: 100
          });

          if (stopRequested) break;
          if (idxEntry.oldestRawId && idxEntry.oldestRawId !== historyCursorBefore) {
            historyCursorBefore = idxEntry.oldestRawId;
          }
          if (bgRes && bgRes.added > 0) {
            continue;
          }
          // Final server-side sweep, bypassing the slice cache, to catch anything skipped.
          if (verificationSweeps < 2 && br && typeof br.searchChannelMessages === 'function') {
            verificationSweeps++;
            state.currentLabel = 'Verifying with Discord server (' + verificationSweeps + '/2)...';
            emitProgress(activeOnProgress);
            const verifyRes = await br.searchChannelMessages({
              channelId: targetChannelId,
              maxId: fenceSnowflake
            });
            if (verifyRes && verifyRes.ok && Array.isArray(verifyRes.items)) {
              const leftovers = verifyRes.items.filter(m => passesActiveFilter(m) && !isTombstoned(m.rawId || m.id));
              if (leftovers.length > 0) {
                mergeMessagesIntoChannelIndex(targetChannelId, leftovers, { trackDescCursor: false });
                for (const m of leftovers) {
                  processedIds.delete(m.rawId || m.id);
                  processedIds.delete(m.id);
                }
                continue;
              }
            }
          }
          // Optional: Remove own reactions placed on OTHER users' messages when Remove Emotes is ON
          if (settings.removeReactions && !stopRequested && br && typeof br.removeOwnReactionInMemory === 'function') {
            const allMsgs = getChannelMessages(targetChannelId);
            const otherWithMyReacts = allMsgs.filter(m => !m.isMine && Array.isArray(m.myReactions) && m.myReactions.length > 0);
            for (const om of otherWithMyReacts) {
              if (stopRequested) break;
              for (const emoji of om.myReactions) {
                if (stopRequested) break;
                state.currentLabel = 'Removing emote ' + (emoji.name || '') + ' from ' + (om.author || 'message');
                emitProgress(activeOnProgress);
                for (let att = 1; att <= 3 && !stopRequested; att++) {
                  const rRes = await br.removeOwnReactionInMemory(targetChannelId, om.rawId || om.id, emoji);
                  if (rRes && rRes.ok) break;
                  if (rRes && rRes.status === 429) {
                    state.rateLimits = (state.rateLimits || 0) + 1;
                    await waitWithCountdown((rRes.retryAfterMs || 2500) + 300, 'Emote Retry', activeOnProgress);
                  } else break;
                }
                await interruptibleSleep(320);
              }
              om.myReactions = [];
            }
          }
          reachedBackgroundEnd = true;
          state.currentLabel = 'Verified clean — reached top of channel history.';
          break;
        }

        // DOM fallback (no bridge): check for channel start before scrolling further.
        const scroller = findChatScroller();
        if (!scroller || isAtChannelStart(scroller)) {
          state.currentLabel = 'Reached top of channel.';
          break;
        }

        state.currentLabel = 'Loading older messages...';
        state.pacingLabel = 'Scrolling up...';
        emitProgress(activeOnProgress);

        scroller.scrollTop = 0;
        try {
          scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
        } catch (e) {}

        let foundNew = false;
        for (let waited = 0; waited < 1100 && !stopRequested; waited += 110) {
          if (state.paused) {
            state.pacingLabel = 'Paused';
            emitProgress(activeOnProgress);
            await waitWhilePaused();
            if (stopRequested) break;
          }
          await interruptibleSleep(110);
          const after = document.querySelectorAll('li[id^="chat-messages-"]');
          for (let i = 0; i < after.length; i++) {
            if (!processedIds.has(after[i].id)) {
              foundNew = true;
              break;
            }
          }
          if (foundNew) break;
        }

        if (stopRequested) break;
        if (foundNew) {
          emptyScrolls = 0;
        } else {
          emptyScrolls++;
          if (emptyScrolls >= 1) {
            state.currentLabel = 'Reached top of channel.';
            break;
          }
        }
      }
    } finally {
      // Automatic post-run reconciliation: flush any tombstoned local/optimistic messages still lingering in MessageStore
      if (hasInMemoryBridge && targetChannelId && br && br.resolveInternals && br.getCachedChannelMessages) {
        try {
          const core = br.resolveInternals(false);
          if (core && core.FluxDispatcher) {
            for (const m of br.getCachedChannelMessages(targetChannelId)) {
              if (isTombstoned(m.rawId) || isTombstoned(m.id)) {
                core.FluxDispatcher.dispatch({ type: 'MESSAGE_DELETE', id: m.rawId, channelId: targetChannelId });
              }
            }
          }
        } catch (e) {}
      }
      state.running = false;
      state.paused = false;
      state.cooldownMs = 0;
      state.stopped = stopRequested;
      state.done = !stopRequested;
      state.pacingLabel = stopRequested ? 'Stopped' : 'Done';
      if (stopRequested) {
        state.currentLabel = 'Cancelled. Deleted ' + state.deleted + '.';
      } else {
        state.currentLabel = 'Done \u2014 deleted ' + state.deleted + ' message(s).';
      }
      emitProgress(activeOnProgress);
      activeOnProgress = null;
    }

    return getState();
  }

  function pause() {
    if (!state.running || state.paused) return false;
    state.paused = true;
    state.pacingLabel = 'Paused';
    emitProgress(activeOnProgress);
    return true;
  }

  function resume() {
    if (!state.running || !state.paused) return false;
    state.paused = false;
    state.pacingLabel = 'Resuming...';
    emitProgress(activeOnProgress);
    wakeAll();
    return true;
  }

  function stop() {
    if (!state.running) return false;
    stopRequested = true;
    state.paused = false;
    state.pacingLabel = 'Stopping...';
    emitProgress(activeOnProgress);
    wakeAll();
    return true;
  }

  function destroy() {
    stopRequested = true;
    state.running = false;
    state.paused = false;
    state.bucketLabel = '';
    lastRateLimit = null;
    activeOnProgress = null;
    for (const unsub of bridgeUnsubs.splice(0)) {
      try { unsub(); } catch (e) {}
    }
    if (document.body) document.body.classList.remove('dc-vfx-stealth-menu');
    wakeAll();
    delete window.__dcDeleteEngine;
  }

  window.__dcDeleteEngine = {
    version: 9,
    runSelected,
    runAllInCurrentTab,
    loadOlderMessages,
    isAtChannelStart,
    readVisibleMessages,
    getChannelMessages,
    getChannelIndexStats,
    scanChannelInBackground,
    findChatScroller,
    pinCurrentChannel,
    getPinnedChannel,
    swapToPinnedOrReturn,
    navigateInMemory,
    pause,
    resume,
    stop,
    getState,
    getSettings,
    setSettings,
    getSpeedProfile,
    getLearnedPacing,
    onServerRateLimit,
    getRateLimitInfo,
    classifyMessageAge,
    detectCurrentUser,
    detectCurrentUserIdentity,
    destroy
  };

  return 'mounted';
})();
