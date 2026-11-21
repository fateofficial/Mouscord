(function() {
  if (window.__dcBridge && window.__dcBridge.version === 1) {
    return 'already-mounted';
  }
  if (window.__dcBridge && typeof window.__dcBridge.destroy === 'function') {
    try { window.__dcBridge.destroy(); } catch (e) {}
  }

  const DISCORD_EPOCH = 1420070400000n;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  // --- Shared Event Bus (Engine <-> UI <-> VFX) ---
  const busListeners = new Map();

  function on(event, handler) {
    if (!event || typeof handler !== 'function') return () => {};
    if (!busListeners.has(event)) busListeners.set(event, new Set());
    busListeners.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    const set = busListeners.get(event);
    if (set) set.delete(handler);
  }

  function emit(event, payload) {
    const set = busListeners.get(event);
    if (set) {
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (e) {}
      }
    }
    if (window.__dcCore && window.__dcCore.bus && typeof window.__dcCore.bus.emit === 'function') {
      window.__dcCore.bus.emit(event, payload);
    }
  }

  // --- Snowflake Utilities ---
  function extractSnowflake(rawId) {
    if (!rawId) return null;
    const m = String(rawId).match(/(\d{15,22})$/);
    return m ? m[1] : null;
  }

  function snowflakeToTimestampMs(rawId) {
    const sf = extractSnowflake(rawId);
    if (!sf) return null;
    try {
      return Number((BigInt(sf) >> 22n) + DISCORD_EPOCH);
    } catch (e) {
      return null;
    }
  }

  function timestampMsToSnowflake(tsMs) {
    const ms = Math.max(Number(DISCORD_EPOCH) + 1, Math.round(Number(tsMs) || Date.now()));
    try {
      return String((BigInt(ms) - DISCORD_EPOCH) << 22n);
    } catch (e) {
      return null;
    }
  }

  // --- Multi-Runtime Rspack / Webpack Discovery ---
  let cachedInternals = null;
  let fluxUnsubscribers = [];

  function resolveInternals(forceRefresh) {
    if (cachedInternals && cachedInternals.RestAPI && cachedInternals.MessageActions && !forceRefresh) {
      return cachedInternals;
    }

    const chunks = window.webpackChunkdiscord_app;
    if (!chunks || typeof chunks.push !== 'function') {
      return null;
    }

    let wpRequire = null;
    let maxCacheSize = -1;
    const probeSym = Symbol('dc_bridge_probe');

    try {
      chunks.push([[probeSym], {}, (r) => {
        if (r && r.c && typeof r.c === 'object') {
          const count = Object.keys(r.c).length;
          if (count > maxCacheSize) {
            maxCacheSize = count;
            wpRequire = r;
          }
        }
      }]);
      chunks.pop();
    } catch (e) {
      return null;
    }

    if (!wpRequire || !wpRequire.c) return null;

    let RestAPI = null;
    let MessageActions = null;
    let MessageStore = null;
    let UserStore = null;
    let ChannelStore = null;
    let PermissionStore = null;
    let FluxDispatcher = null;

    const coreWp = window.__dcCore && window.__dcCore.webpack;
    if (coreWp) {
      MessageStore = coreWp.findByStoreName(wpRequire.c, 'MessageStore');
      UserStore = coreWp.findByStoreName(wpRequire.c, 'UserStore');
      ChannelStore = coreWp.findByStoreName(wpRequire.c, 'ChannelStore');
      PermissionStore = coreWp.findByStoreName(wpRequire.c, 'PermissionStore');
    }

    const modules = Object.values(wpRequire.c);
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      if (!m || !m.exports) continue;
      const exp = m.exports;
      if (typeof exp !== 'object' && typeof exp !== 'function') continue;

      if (!RestAPI && exp.Bo && typeof exp.Bo.get === 'function' && typeof exp.Bo.del === 'function') {
        RestAPI = exp.Bo;
      }

      const keys = Object.keys(exp);
      for (let j = 0; j < keys.length; j++) {
        let v;
        try { v = exp[keys[j]]; } catch (e) { continue; }
        if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
        const proto = Object.getPrototypeOf(v) || {};

        if (!MessageActions &&
            typeof v.deleteMessage === 'function' &&
            typeof v.fetchMessages === 'function' &&
            typeof v.sendMessage === 'function' &&
            typeof v.dismissAutomatedMessage === 'function' &&
            String(v.deleteMessage).includes('MESSAGE_DELETE')) {
          MessageActions = v;
        }
        if (!RestAPI &&
            keys[j] === 'Bo' &&
            typeof v.get === 'function' &&
            typeof v.del === 'function' &&
            typeof v.post === 'function' &&
            !String(v.get).startsWith('r=>e.get')) {
          RestAPI = v;
        }
        if (!MessageStore && typeof proto.getMessages === 'function' && typeof proto.getMessage === 'function' && typeof proto.hasPresent === 'function') {
          MessageStore = v;
        }
        if (!UserStore && typeof proto.getCurrentUser === 'function' && typeof proto.getUser === 'function') {
          UserStore = v;
        }
        if (!ChannelStore && typeof proto.getChannel === 'function' && typeof proto.getDMFromUserId === 'function') {
          ChannelStore = v;
        }
        if (!FluxDispatcher && typeof proto.dispatch === 'function' && typeof proto.subscribe === 'function' && v._actionHandlers) {
          FluxDispatcher = v;
        }
      }
    }

    cachedInternals = {
      wpRequire,
      cacheSize: maxCacheSize,
      RestAPI,
      MessageActions,
      MessageStore,
      UserStore,
      ChannelStore,
      PermissionStore,
      FluxDispatcher
    };

    hookFluxDispatcher(FluxDispatcher);
    return cachedInternals;
  }

  function hookFluxDispatcher(dispatcher) {
    if (!dispatcher || fluxUnsubscribers.length > 0) return;
    const onMessageCreate = (ev) => {
      if (!ev || !ev.message) return;
      emit('discord:message_create', {
        channelId: ev.channelId || ev.message.channel_id,
        message: normalizeRawMessage(ev.message)
      });
    };
    const onMessageDelete = (ev) => {
      if (!ev || !ev.id) return;
      emit('discord:message_delete', {
        channelId: ev.channelId,
        id: String(ev.id),
        domId: 'chat-messages-' + (ev.channelId ? (ev.channelId + '-') : '') + ev.id
      });
    };
    try {
      dispatcher.subscribe('MESSAGE_CREATE', onMessageCreate);
      dispatcher.subscribe('MESSAGE_DELETE', onMessageDelete);
      fluxUnsubscribers.push(() => {
        try { dispatcher.unsubscribe('MESSAGE_CREATE', onMessageCreate); } catch (e) {}
        try { dispatcher.unsubscribe('MESSAGE_DELETE', onMessageDelete); } catch (e) {}
      });
    } catch (e) {}
  }

  function isAvailable() {
    const core = resolveInternals(false);
    return !!(core && core.RestAPI && core.MessageActions);
  }

  function getCurrentUser() {
    const core = resolveInternals(false);
    if (core && core.UserStore && typeof core.UserStore.getCurrentUser === 'function') {
      try {
        const u = core.UserStore.getCurrentUser();
        if (u && u.id) {
          return {
            id: String(u.id),
            username: String(u.username || ''),
            globalName: String(u.globalName || u.global_name || u.username || '')
          };
        }
      } catch (e) {}
    }
    return null;
  }

  function getCurrentChannelIdFromUrl(pathname) {
    const p = String(pathname || window.location.pathname || '');
    const parts = p.split('/').filter(Boolean);
    if (parts[0] === 'channels' && parts.length >= 3) {
      return parts[2];
    }
    return parts.length > 0 ? parts[parts.length - 1] : '';
  }

  function canManageMessages(channelId) {
    const core = resolveInternals(false);
    if (!core || !core.PermissionStore || !core.ChannelStore || !channelId) return false;
    try {
      const ch = core.ChannelStore.getChannel(String(channelId));
      // Only guild (server) channels have MANAGE_MESSAGES (1n << 13n = 8192n); DMs never allow deleting others' messages
      if (!ch || !ch.guild_id) return false;
      if (typeof core.PermissionStore.can === 'function') {
        return !!core.PermissionStore.can(8192n, ch);
      }
    } catch (e) {}
    return false;
  }

  function getChannelInfo(channelId) {
    const cid = String(channelId || getCurrentChannelIdFromUrl() || '');
    if (!cid) return { id: '', label: 'Channel', path: window.location.pathname, type: 0 };

    const core = resolveInternals(false);
    if (core && core.ChannelStore && typeof core.ChannelStore.getChannel === 'function') {
      try {
        const ch = core.ChannelStore.getChannel(cid);
        if (ch) {
          let label = clean(ch.name || '');
          if (!label && Array.isArray(ch.rawRecipients) && ch.rawRecipients.length > 0) {
            label = '@' + ch.rawRecipients.map(r => r.global_name || r.username).filter(Boolean).join(', ');
          } else if (!label && Array.isArray(ch.recipients) && ch.recipients.length > 0 && core.UserStore) {
            const names = ch.recipients.map(uid => {
              const u = core.UserStore.getUser(uid);
              return u ? (u.globalName || u.username) : '';
            }).filter(Boolean);
            if (names.length > 0) label = '@' + names.join(', ');
          } else if (label && ch.guild_id) {
            label = '#' + label;
          }
          const path = ch.guild_id ? `/channels/${ch.guild_id}/${cid}` : `/channels/@me/${cid}`;
          return {
            id: cid,
            guildId: ch.guild_id ? String(ch.guild_id) : null,
            label: label || ('Channel ' + cid.slice(-4)),
            path,
            type: ch.type
          };
        }
      } catch (e) {}
    }

    const docTitle = clean(document.title || '').replace(/\s*-\s*Discord$/i, '');
    return {
      id: cid,
      guildId: null,
      label: docTitle || ('Channel ' + cid.slice(-4)),
      path: window.location.pathname.includes(cid) ? window.location.pathname : `/channels/@me/${cid}`,
      type: 1
    };
  }

  function normalizeRawMessage(raw, currentUserId) {
    if (!raw || !raw.id) return null;
    // Skip optimistic 'SENDING' copies; they carry a temporary nonce ID and would duplicate the real message.
    if (raw.state === 'SENDING') return null;
    const me = currentUserId || (getCurrentUser() && getCurrentUser().id) || '';
    const msgId = String(raw.id);
    const channelId = String(raw.channel_id || getCurrentChannelIdFromUrl() || '');
    const authorObj = raw.author || {};
    const authorId = String(authorObj.id || '');
    const authorName = clean(authorObj.global_name || authorObj.globalName || authorObj.username || 'User');
    const isBot = !!authorObj.bot;
    const flags = Number(raw.flags) || 0;
    const isSendFailed = raw.state === 'SEND_FAILED';
    const isEphemeral = ((flags & 64) === 64) || isSendFailed;
    const isSystem = (typeof raw.type === 'number' && raw.type !== 0 && raw.type !== 19 && raw.type !== 20 && raw.type !== 21);
    const isMine = !isSystem && !isBot && !!me && authorId === me;

    const text = clean(raw.content || '');
    const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
    const embeds = Array.isArray(raw.embeds) ? raw.embeds : [];
    const rawReactions = Array.isArray(raw.reactions) ? raw.reactions : [];
    const myReactions = rawReactions
      .filter(r => r && r.me && r.emoji)
      .map(r => ({ name: r.emoji.name || '', id: r.emoji.id ? String(r.emoji.id) : null }));
    const hasLink = /https?:\/\/\S+/i.test(text) || embeds.some(e => e && e.url);
    const hasMedia = attachments.length > 0 || embeds.some(e => e && (e.image || e.video || e.thumbnail));
    const hasEmbed = embeds.length > 0;

    let displaySnippet = text;
    if (!displaySnippet && attachments.length > 0) {
      displaySnippet = '[Attachment: ' + (attachments[0].filename || 'file') + ']';
    } else if (!displaySnippet && embeds.length > 0) {
      displaySnippet = '[Embed: ' + clean(embeds[0].title || embeds[0].description || 'card').slice(0, 60) + ']';
    }

    const canManage = !isSystem && canManageMessages(channelId);
    const actionType = isEphemeral ? 'dismiss' : ((isMine || canManage) ? 'delete' : 'readonly');
    const domEl = document.getElementById('chat-messages-' + channelId + '-' + msgId) ||
                  document.getElementById('chat-messages-' + msgId) ||
                  document.querySelector(`li[id$="-${msgId}"]`);

    return {
      id: domEl ? domEl.id : ('chat-messages-' + channelId + '-' + msgId),
      rawId: msgId,
      channelId,
      author: authorName,
      authorId,
      text: displaySnippet.slice(0, 180),
      rawContent: text,
      timestamp: raw.timestamp || null,
      isSystem,
      isBot,
      isEphemeral,
      isMine,
      actionType,
      canRemove: actionType !== 'readonly',
      hasLink,
      hasMedia,
      hasEmbed,
      myReactions
    };
  }

  function getCachedChannelMessages(channelId) {
    const cid = String(channelId || getCurrentChannelIdFromUrl() || '');
    if (!cid) return [];
    const core = resolveInternals(false);
    if (!core || !core.MessageStore || typeof core.MessageStore.getMessages !== 'function') {
      return [];
    }
    try {
      const col = core.MessageStore.getMessages(cid);
      const arr = (col && typeof col.toArray === 'function') ? col.toArray() : [];
      const me = getCurrentUser();
      const meId = me ? me.id : '';
      return arr.map(m => normalizeRawMessage(m, meId)).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // --- Background search and pagination over channel history ---
  async function searchChannelMessages(opts) {
    const core = resolveInternals(false);
    if (!core || !core.RestAPI) {
      return { ok: false, reason: 'no-rest-api', totalResults: 0, items: [] };
    }

    const options = opts || {};
    const channelId = String(options.channelId || getCurrentChannelIdFromUrl() || '');
    if (!channelId) return { ok: false, reason: 'no-channel', totalResults: 0, items: [] };

    const me = getCurrentUser();
    const authorId = options.authorId !== undefined ? options.authorId : (me ? me.id : null);
    const query = {};
    if (authorId) query.author_id = String(authorId);
    if (options.maxId) query.max_id = String(extractSnowflake(options.maxId) || options.maxId);
    if (options.minId) query.min_id = String(extractSnowflake(options.minId) || options.minId);
    if (options.has) query.has = String(options.has);
    if (options.content) query.content = String(options.content);
    if (options.sortOrder === 'asc' || options.sortOrder === 'desc') {
      query.sort_by = 'timestamp';
      query.sort_order = options.sortOrder;
    }
    if (typeof options.offset === 'number' && options.offset > 0) query.offset = options.offset;

    const chanInfo = getChannelInfo(channelId);
    const isGuild = !!chanInfo.guildId;
    const url = isGuild
      ? `/guilds/${chanInfo.guildId}/messages/search`
      : `/channels/${channelId}/messages/search`;
    if (isGuild) query.channel_id = channelId;

    try {
      const res = await core.RestAPI.get({ url, query });
      const body = (res && res.body) ? res.body : {};
      if (res && res.status === 202) {
        return {
          ok: false,
          indexing: true,
          retryAfterMs: (Number(body.retry_after) || 2) * 1000,
          totalResults: 0,
          items: []
        };
      }
      const groups = Array.isArray(body.messages) ? body.messages : [];
      const meId = me ? me.id : '';
      const items = [];
      const seen = new Set();

      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const hit = Array.isArray(g) ? (g.find(x => x && x.hit) || g[0]) : g;
        if (!hit || !hit.id || seen.has(hit.id)) continue;
        if (authorId && hit.author && String(hit.author.id) !== String(authorId)) continue;
        seen.add(hit.id);
        const normMsg = normalizeRawMessage(hit, meId);
        if (normMsg) items.push(normMsg);
      }

      return {
        ok: true,
        totalResults: typeof body.total_results === 'number' ? body.total_results : items.length,
        items
      };
    } catch (err) {
      const status = err && (err.status || (err.body && err.body.status));
      return {
        ok: false,
        status: status || 0,
        reason: String((err && err.message) || 'search-failed'),
        totalResults: 0,
        items: []
      };
    }
  }

  // --- Background History Page Fetcher (/channels/{id}/messages?before=...&limit=100) ---
  async function fetchChannelHistoryPage(opts) {
    const core = resolveInternals(false);
    if (!core || !core.RestAPI) {
      return { ok: false, items: [], reachedTop: false };
    }
    const options = opts || {};
    const channelId = String(options.channelId || getCurrentChannelIdFromUrl() || '');
    if (!channelId) return { ok: false, items: [], reachedTop: true };

    const limit = Math.max(1, Math.min(100, Number(options.limit) || 100));
    const query = { limit };
    if (options.before) query.before = String(extractSnowflake(options.before) || options.before);
    else if (options.after !== undefined && options.after !== null) query.after = String(options.after);

    try {
      const res = await core.RestAPI.get({
        url: `/channels/${channelId}/messages`,
        query
      });
      const rawList = (res && Array.isArray(res.body)) ? res.body : [];
      const me = getCurrentUser();
      const meId = me ? me.id : '';
      const items = rawList.map(m => normalizeRawMessage(m, meId)).filter(Boolean);
      const oldestRawId = rawList.length > 0 ? String(rawList[rawList.length - 1].id) : null;
      return {
        ok: true,
        items,
        rawCount: rawList.length,
        oldestRawId,
        reachedTop: rawList.length < limit
      };
    } catch (err) {
      return {
        ok: false,
        status: err && err.status,
        items: [],
        reachedTop: false
      };
    }
  }

  // --- Message delete / ephemeral dismiss via Discord internals (works for any channel) ---
  async function deleteMessageInMemory(channelId, rawOrDomId, isEphemeral) {
    const core = resolveInternals(false);
    const cid = String(channelId || getCurrentChannelIdFromUrl() || '');
    const msgId = extractSnowflake(rawOrDomId);
    if (!cid || !msgId || !core) {
      return { ok: false, reason: 'unavailable' };
    }

    let isLocalOnly = !!isEphemeral;
    if (!isLocalOnly && core.MessageStore && typeof core.MessageStore.getMessage === 'function') {
      try {
        const storedMsg = core.MessageStore.getMessage(cid, msgId);
        if (storedMsg && (storedMsg.state === 'SEND_FAILED' || ((Number(storedMsg.flags) || 0) & 64) === 64)) {
          isLocalOnly = true;
        }
      } catch (e) {}
    }

    try {
      if (isLocalOnly) {
        if (core.MessageActions && typeof core.MessageActions.deleteMessage === 'function') {
          await core.MessageActions.deleteMessage(cid, msgId, true);
        }
        // Remove from MessageStore explicitly; rapid channel switches can otherwise leave a stale copy.
        if (core.FluxDispatcher && (!core.MessageStore || (typeof core.MessageStore.getMessage === 'function' && core.MessageStore.getMessage(cid, msgId)))) {
          try { core.FluxDispatcher.dispatch({ type: 'MESSAGE_DELETE', id: msgId, channelId: cid }); } catch (e) {}
        }
        return { ok: true, status: 204, mode: 'local-dismiss' };
      }

      // Use RestAPI.del directly: MessageActions swallows 429 / 403 / 404, and we need those statuses.
      if (core.RestAPI && typeof core.RestAPI.del === 'function') {
        await core.RestAPI.del({
          url: `/channels/${cid}/messages/${msgId}`,
          oldFormErrors: true
        });
        if (core.FluxDispatcher) {
          try {
            core.FluxDispatcher.dispatch({ type: 'MESSAGE_DELETE', id: msgId, channelId: cid });
          } catch (e) {}
        }
        return { ok: true, status: 204, mode: 'rest-api' };
      }

      if (core.MessageActions && typeof core.MessageActions.deleteMessage === 'function') {
        await core.MessageActions.deleteMessage(cid, msgId, false);
        return { ok: true, status: 204, mode: 'message-actions' };
      }

      return { ok: false, reason: 'no-delete-fn' };
    } catch (err) {
      const status = Number(err && (err.status || (err.httpStatus))) || 0;
      const body = (err && err.body) || {};
      const retryAfterSec = Number(body.retry_after || (err && err.headers && err.headers['retry-after'])) || 0;
      if (status === 404) {
        return { ok: true, status: 404, mode: 'already-deleted' };
      }
      if (status === 403) {
        return { ok: false, status: 403, reason: 'no-permission' };
      }
      if (status === 429) {
        return {
          ok: false,
          status: 429,
          reason: 'rate-limited',
          retryAfterMs: retryAfterSec > 0 ? Math.round(retryAfterSec * 1000) : 3500
        };
      }
      return {
        ok: false,
        status,
        reason: String((err && err.message) || 'delete-error')
      };
    }
  }

  async function removeOwnReactionInMemory(channelId, rawOrDomId, emoji) {
    const core = resolveInternals(false);
    const cid = String(channelId || getCurrentChannelIdFromUrl() || '');
    const msgId = extractSnowflake(rawOrDomId);
    if (!cid || !msgId || !emoji || !core || !core.RestAPI || typeof core.RestAPI.del !== 'function') {
      return { ok: false, reason: 'unavailable' };
    }
    const emojiKey = emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name;
    try {
      await core.RestAPI.del({
        url: `/channels/${cid}/messages/${msgId}/reactions/${encodeURIComponent(emojiKey)}/@me`
      });
      return { ok: true, status: 204 };
    } catch (err) {
      const status = Number(err && (err.status || err.httpStatus)) || 0;
      const body = (err && err.body) || {};
      const retryAfterSec = Number(body.retry_after || (err && err.headers && err.headers['retry-after'])) || 0;
      if (status === 404) return { ok: true, status: 404 };
      if (status === 429) return { ok: false, status: 429, retryAfterMs: retryAfterSec > 0 ? Math.round(retryAfterSec * 1000) : 2500 };
      return { ok: false, status, reason: 'reaction-error' };
    }
  }

  async function jumpToMessage(channelId, rawOrDomId) {
    const core = resolveInternals(false);
    const cid = String(channelId || getCurrentChannelIdFromUrl() || '');
    const msgId = extractSnowflake(rawOrDomId);
    if (!cid || !msgId) return { ok: false, reason: 'invalid-id' };

    const domEl = document.getElementById('chat-messages-' + cid + '-' + msgId) ||
                  document.getElementById('chat-messages-' + msgId) ||
                  document.querySelector(`li[id^="chat-messages-"][id$="-${msgId}"]`);
    if (domEl) {
      try {
        domEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return { ok: true, mode: 'dom' };
      } catch (e) {}
    }

    if (core && core.MessageActions && typeof core.MessageActions.jumpToMessage === 'function') {
      try {
        await core.MessageActions.jumpToMessage({
          channelId: cid,
          messageId: msgId,
          flash: true,
          jumpType: 'INSTANT'
        });
        return { ok: true, mode: 'message-actions' };
      } catch (e) {}
    }
    return { ok: false, reason: 'unavailable' };
  }

  function destroy() {
    for (const unsub of fluxUnsubscribers.splice(0)) {
      try { unsub(); } catch (e) {}
    }
    busListeners.clear();
    cachedInternals = null;
    delete window.__dcBridge;
  }

  // Eagerly resolve on mount if Discord's chunks are already present
  try { resolveInternals(false); } catch (e) {}

  window.__dcBridge = {
    version: 1,
    on,
    off,
    emit,
    isAvailable,
    resolveInternals,
    getCurrentUser,
    getCurrentChannelIdFromUrl,
    getChannelInfo,
    normalizeRawMessage,
    getCachedChannelMessages,
    searchChannelMessages,
    fetchChannelHistoryPage,
    deleteMessageInMemory,
    removeOwnReactionInMemory,
    jumpToMessage,
    extractSnowflake,
    snowflakeToTimestampMs,
    timestampMsToSnowflake,
    destroy
  };

  return 'mounted';
})();
