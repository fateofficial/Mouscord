(function() {
  if (window.__dcMsgSidebar && window.__dcMsgSidebar.version === 14) {
    return 'already-mounted';
  }
  if (window.__dcMsgSidebar && window.__dcMsgSidebar.destroy) {
    try { window.__dcMsgSidebar.destroy(); } catch (e) {}
  }

  const STYLE_ID = 'dc-msg-sidebar-style';
  const ROOT_ID  = 'dc-msg-sidebar-root';

  // CSS is externalized into src/css/sidebar.css (injected as window.__dcSidebarCss by pack_payloads.ps1)
  const css = window.__dcSidebarCss || `#${ROOT_ID}{position:fixed;inset:0;pointer-events:none;z-index:99990;}`;

  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID;
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <div class="dc-sb-tab" title="Open Messages & Cleaner Drawer (Alt+M)">
      <div class="dc-sb-tab-chevron">&lsaquo;</div>
      <div class="dc-sb-tab-count">0</div>
    </div>
    <div class="dc-sb-float-pill">
      <span class="dc-sb-float-dot"></span>
      <span class="dc-sb-float-text">Deleting...</span>
      <button class="dc-sb-btn-pause dc-sb-float-swap" title="Jump back to active cleaning chat (Alt+W)">&#8644; Jump</button>
      <button class="dc-sb-btn-pause dc-sb-float-pause" title="Pause / Resume (Space)">Pause</button>
      <button class="dc-sb-btn-stop dc-sb-float-stop" title="Cancel Deletion (Shift+Esc)">Cancel Deletion</button>
    </div>
    <div class="dc-sb-drawer">
      <div class="dc-sb-chan-tabs"></div>
      <div class="dc-sb-header">
        <div class="dc-sb-title-wrap">
          <span class="dc-sb-title">Messages</span>
          <span class="dc-sb-badge">0</span>
        </div>
        <div class="dc-sb-header-actions">
          <button class="dc-sb-del-all-btn" title="Delete all your messages in this chat">Delete All</button>
          <button class="dc-sb-icon-btn dc-sb-opts-btn" title="Display & Pacing Options">&#9881;</button>
          <button class="dc-sb-icon-btn dc-sb-collapse" title="Collapse (Alt+M)">&rsaquo;</button>
        </div>
      </div>
      <div class="dc-sb-opts-bar">
        <button class="dc-sb-chip" data-opt="newestFirst" title="ON = Newest first, OFF = Oldest first">Newest</button>
        <button class="dc-sb-chip" data-opt="removeReactions" title="Also remove your reactions on other people's messages during Delete All">Remove Emotes: OFF</button>
        <button class="dc-sb-chip" data-opt="mouseCursor" title="Animated Mouse companion while deleting">Mouse: ON</button>
        <button class="dc-sb-chip" data-opt="enableVfx" title="Dissolve particles on message delete">Particles: ON</button>
        <button class="dc-sb-chip fx-preset" title="Cycle dissolve shader theme">FX: Fairy Dust</button>
        <button class="dc-sb-chip snow-toggle" title="Toggle native GPU overlay snowfall">&#10052; Snow</button>
        <button class="dc-sb-chip test-fx" title="Preview dissolve VFX without deleting">&#10024; Test</button>
        <button class="dc-sb-chip dev-toggle" title="Show/hide developer testing tools">Dev</button>
        <button class="dc-sb-chip sim-chat" style="display:none;" title="Inject 30 local-only test messages">+30 Sim Chat</button>
        <button class="dc-sb-chip sim-clear" style="display:none;" title="Clear local-only simulated messages">Clear Sim</button>
        <div class="dc-sb-speed-box">
          <div class="dc-sb-speed-head">
            <span>Pace Rhythm</span>
            <span class="dc-sb-speed-badge focused">Human Focused</span>
          </div>
          <input class="dc-sb-speed-slider" type="range" min="0" max="100" step="1" value="55" title="Interpolates between Human Normal, Human Focused, and Max (Risky)" />
          <div class="dc-sb-speed-ticks">
            <span>Normal</span>
            <span>Focused</span>
            <span style="color:#ff8e91;">Max (Risky)</span>
          </div>
        </div>
      </div>
      <div class="dc-sb-filter-wrap">
        <div class="dc-sb-filter-row">
          <input class="dc-sb-filter-input" type="text" placeholder="Filter: is:mine user:a,b age:>14d /regex/ -word" title="Available filters (combine any with spaces):
• is:mine / is:other / is:dismiss
• user:name or user:bob,alice (comma for multiple)
• age:<24h / age:>14d / age:1d-1y
• has:link / has:media / has:embed
• /regex/i or -/exclude/i (negate)
• &quot;exact phrase&quot; or -word" spellcheck="false" autocomplete="off" />
          <button class="dc-sb-filter-clear" title="Clear filter">&times;</button>
          <button class="dc-sb-filter-help" title="Show all filter patterns &amp; examples" style="background:none;border:none;color:#949ba4;font-weight:700;font-size:12px;cursor:pointer;padding:0 6px;">&#9432;</button>
        </div>
        <div class="dc-sb-help-box" style="display:none;margin-top:6px;padding:8px 10px;border-radius:8px;background:rgba(18,19,22,0.92);border:1px solid rgba(255,255,255,0.1);font-size:11px;line-height:1.6;color:#b5bac1;">
          <div style="font-weight:700;color:#f2f3f5;margin-bottom:4px;">Quick Filter Guide <span style="font-weight:400;color:#949ba4;">(combine with spaces)</span></div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 8px;align-items:center;">
            <span class="dc-sb-htag">is:mine</span><span>Only your messages (off = everyone)</span>
            <span class="dc-sb-htag">from:bob,alice</span><span>Messages by display name(s)</span>
            <span class="dc-sb-htag">id:123456...</span><span>Exact User ID (click any author name!)</span>
            <span class="dc-sb-htag">age:&gt;14d</span><span>Older than 14d (or <b>&lt;24h</b>, <b>1d-1y</b>)</span>
            <span class="dc-sb-htag">has:link</span><span>Has links (or <b>has:media</b>, <b>has:embed</b>)</span>
            <span class="dc-sb-htag">&quot;exact text&quot;</span><span>Matches an exact phrase</span>
            <span class="dc-sb-htag">/(a|b)/i</span><span>Matches &quot;a&quot; or &quot;b&quot; (any case)</span>
            <span class="dc-sb-htag">-filter</span><span><b>Protect / skip</b> (e.g. <b>-has:media</b>, <b>-user:bob</b>)</span>
          </div>
        </div>
        <div class="dc-sb-filter-err"></div>
        <div class="dc-sb-quick-chips"></div>
      </div>
      <div class="dc-sb-hint" style="display:flex;align-items:center;justify-content:space-between;min-height:36px;">
        <span class="dc-sb-stream-status" title="Alt+M: Toggle drawer | Ctrl+A: Select all | Del: Delete selected | Space: Pause/Resume | Shift+Esc: Cancel">Alt+M &bull; Shift+Click &bull; Del</span>
        <div class="dc-sb-bed-pad" style="width:76px;height:30px;border-radius:8px;" title="Mouscord naps here while idle"></div>
      </div>
      <div class="dc-sb-list"></div>
      <div class="dc-sb-footer">
        <div class="dc-sb-sel-info">
          <span class="dc-sb-sel-count">0 selected</span>
          <button class="dc-sb-clear" title="Clear selection (Esc)">Clear</button>
        </div>
        <button class="dc-sb-del-btn" title="Delete selected messages (Del)">Delete Selected</button>
      </div>
      <div class="dc-sb-live-bar">
        <div class="dc-sb-progress-bar"><div class="dc-sb-progress-fill"></div></div>
        <div class="dc-sb-live-meta">
          <div class="dc-sb-live-top">
            <div class="dc-sb-live-stats"></div>
            <span class="dc-sb-bucket-badge"></span>
          </div>
          <div class="dc-sb-live-sub"></div>
        </div>
        <div class="dc-sb-live-actions">
          <button class="dc-sb-btn-pause dc-sb-live-pause" title="Pause / Resume (Space)">Pause</button>
          <button class="dc-sb-btn-stop dc-sb-live-stop" title="Cancel Deletion (Shift+Esc)">Cancel Deletion</button>
        </div>
      </div>
      <div class="dc-sb-toast"></div>
    </div>
    <div class="dc-sb-modal-backdrop">
      <div class="dc-sb-modal">
        <div class="dc-sb-modal-body">
          <div class="dc-sb-modal-title">Delete Messages</div>
          <div class="dc-sb-modal-sub"></div>
          <div class="dc-sb-modal-previews"></div>
          <div class="dc-sb-modal-notice"></div>
        </div>
        <div class="dc-sb-modal-actions">
          <button class="dc-sb-btn-cancel">Cancel</button>
          <button class="dc-sb-btn-confirm">Delete</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const tab         = root.querySelector('.dc-sb-tab');
  const tabCount    = root.querySelector('.dc-sb-tab-count');
  const floatPill   = root.querySelector('.dc-sb-float-pill');
  const floatDot    = root.querySelector('.dc-sb-float-dot');
  const floatText   = root.querySelector('.dc-sb-float-text');
  const floatSwap   = root.querySelector('.dc-sb-float-swap');
  const floatPause  = root.querySelector('.dc-sb-float-pause');
  const floatStop   = root.querySelector('.dc-sb-float-stop');

  const drawer      = root.querySelector('.dc-sb-drawer');
  const chanTabsEl  = root.querySelector('.dc-sb-chan-tabs');
  const titleEl     = root.querySelector('.dc-sb-title');
  const badge       = root.querySelector('.dc-sb-badge');
  const delAllBtn   = root.querySelector('.dc-sb-del-all-btn');
  const optsBtn     = root.querySelector('.dc-sb-opts-btn');
  const optsBar     = root.querySelector('.dc-sb-opts-bar');
  const optChips    = root.querySelectorAll('.dc-sb-chip[data-opt]');
  const fxPresetBtn = root.querySelector('.dc-sb-chip.fx-preset');
  const snowBtn     = root.querySelector('.dc-sb-chip.snow-toggle');
  const testFxBtn   = root.querySelector('.dc-sb-chip.test-fx');
  const devToggleBtn = root.querySelector('.dc-sb-chip.dev-toggle');
  const simChatBtn  = root.querySelector('.dc-sb-chip.sim-chat');
  const simClearBtn = root.querySelector('.dc-sb-chip.sim-clear');
  const simInjectedIds = new Map(); // channelId -> Set<msgId>
  const speedSliderEl = root.querySelector('.dc-sb-speed-slider');
  const speedBadgeEl  = root.querySelector('.dc-sb-speed-badge');

  // Modular Mouse Cursor Engine (window.__dcMouseCursor, src/js/mouse_cursor.js)
  const xmasMouse = {
    show: () => window.__dcMouseCursor && window.__dcMouseCursor.show && window.__dcMouseCursor.show(),
    hide: () => window.__dcMouseCursor && window.__dcMouseCursor.hide && window.__dcMouseCursor.hide(),
    glideToElement: (id) => window.__dcMouseCursor && window.__dcMouseCursor.moveToElement && window.__dcMouseCursor.moveToElement(id),
    destroy: () => window.__dcMouseCursor && window.__dcMouseCursor.hide && window.__dcMouseCursor.hide()
  };
  const filterInput = root.querySelector('.dc-sb-filter-input');
  const filterClear = root.querySelector('.dc-sb-filter-clear');
  const filterErr   = root.querySelector('.dc-sb-filter-err');
  const quickChipsEl = root.querySelector('.dc-sb-quick-chips');
  const streamStatusEl = root.querySelector('.dc-sb-stream-status');
  const collapseBtn = root.querySelector('.dc-sb-collapse');
  const listEl      = root.querySelector('.dc-sb-list');
  const footer      = root.querySelector('.dc-sb-footer');
  const selCountEl  = root.querySelector('.dc-sb-sel-count');
  const clearBtn    = root.querySelector('.dc-sb-clear');
  const delSelBtn   = root.querySelector('.dc-sb-del-btn');

  const liveBar     = root.querySelector('.dc-sb-live-bar');
  const progFill    = root.querySelector('.dc-sb-progress-fill');
  const liveStats   = root.querySelector('.dc-sb-live-stats');
  const liveBucket  = root.querySelector('.dc-sb-bucket-badge');
  const liveSub     = root.querySelector('.dc-sb-live-sub');
  const livePause   = root.querySelector('.dc-sb-live-pause');
  const liveStop    = root.querySelector('.dc-sb-live-stop');
  const toastEl     = root.querySelector('.dc-sb-toast');

  const backdrop    = root.querySelector('.dc-sb-modal-backdrop');
  const modalTitle  = root.querySelector('.dc-sb-modal-title');
  const modalSub    = root.querySelector('.dc-sb-modal-sub');
  const modalList   = root.querySelector('.dc-sb-modal-previews');
  const modalNotice = root.querySelector('.dc-sb-modal-notice');
  const cancelBtn   = root.querySelector('.dc-sb-btn-cancel');
  const confirmBtn  = root.querySelector('.dc-sb-btn-confirm');

  let isOpen = false;
  let messages = [];
  let lastSignature = '';
  let filterQuery = 'is:mine';
  let activeChannelPath = window.location.pathname;
  const channelSelections = new Map(); // Per-channel selection isolation (no leaking when switching tabs/DMs)
  let selectedIds = new Set();
  let lastAnchorIndex = -1;
  let highlightedEl = null;

  // Channel lock is held only while a deletion job is running.
  let activeCleaningTarget = null; // { channelId, path, label } while deleting, null when idle
  let activeTabKey = 'live';       // 'cleaning' or 'live'
  let streamingChannelId = '';     // Currently streaming background history for this channelId

  let modalMode = 'selected';
  let pendingDeleteItems = [];
  let isDeleting = false;
  let toastTimer = null;

  const getEngine = () => window.__dcDeleteEngine || null;
  const getFilter = () => window.__dcFilter || null;
  const getBridge = () => window.__dcBridge || null;

  function getCurrentLiveChannelMeta() {
    const br = getBridge();
    const curPath = window.location.pathname;
    const cid = (br && br.getCurrentChannelIdFromUrl) ? br.getCurrentChannelIdFromUrl(curPath) : (curPath.split('/').pop() || '');
    if (br && br.getChannelInfo && cid) {
      const info = br.getChannelInfo(cid);
      return { channelId: cid, path: info.path || curPath, label: info.label || 'Current Chat' };
    }
    const docTitle = String(document.title || '').replace(/\s*-\s*Discord$/i, '').trim();
    return { channelId: cid, path: curPath, label: docTitle || 'Current Chat' };
  }

  function getFocusedTabMeta() {
    if (isDeleting && activeCleaningTarget && activeTabKey === 'cleaning') {
      return {
        channelId: activeCleaningTarget.channelId,
        path: activeCleaningTarget.path,
        label: activeCleaningTarget.label,
        isLockedTab: true
      };
    }
    const live = getCurrentLiveChannelMeta();
    return { channelId: live.channelId, path: live.path, label: live.label, isLockedTab: false };
  }

  // 2-Tab Separation while deleting: Tab 1 = Controls (human-only), Tab 2 = Mouse Env (cloned Discord chat where Mouse lives)
  function renderChannelTabs() {
    if (!chanTabsEl) return;
    chanTabsEl.innerHTML = '';
    const showBar = !!(isDeleting && activeCleaningTarget);
    chanTabsEl.classList.toggle('visible', showBar);
    if (!showBar) return;

    const ctrlBtn = document.createElement('button');
    ctrlBtn.className = 'dc-sb-chan-tab cleaning' + (activeTabKey !== 'mouse' ? ' active' : '');
    ctrlBtn.textContent = '\ud83e\uddf9 Controls';
    ctrlBtn.title = 'Human controls, filters, selection, and Pace Rhythm slider';
    ctrlBtn.addEventListener('click', () => {
      activeTabKey = 'cleaning';
      if (window.__dcPopoutChat && window.__dcPopoutChat.close) window.__dcPopoutChat.close();
      xmasMouse.hide();
      renderChannelTabs();
      scanMessages(true);
    });
    chanTabsEl.appendChild(ctrlBtn);

    const mouseBtn = document.createElement('button');
    mouseBtn.className = 'dc-sb-chan-tab' + (activeTabKey === 'mouse' ? ' active' : '');
    mouseBtn.textContent = '\ud83d\udc2d Mouse Env';
    mouseBtn.title = 'Open the Mouse environment (cloned Discord chat where the Mouse works)';
    mouseBtn.addEventListener('click', () => {
      activeTabKey = 'mouse';
      renderChannelTabs();
      const engine = getEngine();
      if (window.__dcPopoutChat && window.__dcPopoutChat.open && activeCleaningTarget) {
        const allForPop = (engine && engine.getChannelMessages) ? engine.getChannelMessages(activeCleaningTarget.channelId) : messages;
        window.__dcPopoutChat.open(activeCleaningTarget.channelId, activeCleaningTarget.label, allForPop);
        if (engine && engine.getSettings && engine.getSettings().mouseCursor) xmasMouse.show();
      }
    });
    chanTabsEl.appendChild(mouseBtn);
  }

  // Background history loader (parallel slices); runs only while the drawer is open.
  let filterPushdownTimer = null;
  function scheduleFilterServerSearch() {
    if (filterPushdownTimer) clearTimeout(filterPushdownTimer);
    if (!isOpen || !filterQuery) return;
    filterPushdownTimer = setTimeout(async () => {
      filterPushdownTimer = null;
      if (!isOpen || !filterQuery) return;
      const focusMeta = getFocusedTabMeta();
      const engine = getEngine();
      if (!focusMeta.channelId || !engine || typeof engine.scanChannelInBackground !== 'function') return;
      await engine.scanChannelInBackground({
        channelId: focusMeta.channelId,
        filterQuery,
        parallelBurst: true,
        useSearch: true,
        fetchHistoryPage: false
      });
      scanMessages(true);
    }, 220);
  }

  async function startBackgroundHistoryStream(channelId, maxPagesOverride) {
    if (!isOpen || !channelId) return;
    if (streamingChannelId === channelId) return;
    const engine = getEngine();
    const br = getBridge();
    if (!engine || typeof engine.scanChannelInBackground !== 'function' || !br || !br.isAvailable || !br.isAvailable()) {
      return;
    }

    const maxPages = typeof maxPagesOverride === 'number' ? maxPagesOverride : 400;
    const st0 = engine.getChannelIndexStats ? engine.getChannelIndexStats(channelId) : null;
    const firstVisit = !(st0 && st0.autoIndexed);
    streamingChannelId = channelId;
    try {
      for (let page = 0; page < maxPages; page++) {
        if (!isOpen) break;
        const focusMeta = getFocusedTabMeta();
        if (focusMeta.channelId !== channelId) break;

        const statsBefore = engine.getChannelIndexStats ? engine.getChannelIndexStats(channelId) : null;
        if (statsBefore && statsBefore.reachedTop && statsBefore.totalResults !== null && statsBefore.indexedCount >= statsBefore.totalResults) {
          break;
        }

        if (streamStatusEl) {
          const mineTxt = String(messages.length);
          const totalMineTxt = (statsBefore && statsBefore.totalResults) ? (' / ' + statsBefore.totalResults + ' yours') : ' yours';
          const allTxt = statsBefore ? (' (' + statsBefore.indexedCount + ' total)') : '';
          streamStatusEl.textContent = 'Indexing ' + mineTxt + totalMineTxt + allTxt + '...';
        }

        const res = await engine.scanChannelInBackground({
          channelId,
          filterQuery,
          parallelBurst: page === 0 && firstVisit,
          advanceCursor: !(page === 0 && firstVisit),
          useSearch: true,
          fetchHistoryPage: true,
          limit: 100
        });

        scanMessages(true);
        if (!res || (res.added === 0 && page > 0)) {
          break;
        }
        await new Promise(r => setTimeout(r, 85));
      }
    } finally {
      if (streamingChannelId === channelId) {
        streamingChannelId = '';
      }
      if (streamStatusEl) {
        streamStatusEl.textContent = 'Alt+M \u2022 Shift+Click \u2022 Del';
      }
      scanMessages(true);
    }
  }

  const OPT_LABELS = {
    mineOnly: 'Mine Only',
    enableVfx: 'Particles',
    mouseCursor: 'Mouse Cursor',
    newestFirst: 'Newest First',
    removeReactions: 'Remove Emotes'
  };

  function showToast(msg, durationMs) {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.classList.add('visible');
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('visible');
      toastTimer = null;
    }, durationMs || 2800);
  }

  function clearChatHighlight() {
    if (highlightedEl) {
      highlightedEl.classList.remove('dc-sb-msg-highlight');
      highlightedEl = null;
    }
  }

  function highlightMessageInChat(id) {
    clearChatHighlight();
    const li = document.getElementById(id);
    if (li) {
      li.classList.add('dc-sb-msg-highlight');
      highlightedEl = li;
    }
  }

  function syncLiveBarsVisibility() {
    liveBar.classList.toggle('visible', isDeleting);
    floatPill.classList.toggle('visible', isDeleting && !isOpen);
    updateFooter();
  }

  function syncMouseBed() {
    const eng = getEngine();
    const mouseOn = !!(eng && eng.getSettings && eng.getSettings().mouseCursor);
    const bedPad = drawer.querySelector('.dc-sb-bed-pad');
    if (bedPad) bedPad.style.display = mouseOn ? '' : 'none';
    if (isDeleting) return;
    if (!isOpen || !mouseOn) { xmasMouse.hide(); return; }
    requestAnimationFrame(() => {
      if (isDeleting || !isOpen) return;
      const r = bedPad ? bedPad.getBoundingClientRect() : null;
      if (r && r.width > 10 && r.height > 10 && window.__dcMouseCursor && window.__dcMouseCursor.napAt) {
        window.__dcMouseCursor.napAt(r.left + r.width * 0.5, r.top + r.height * 0.62, bedPad);
      }
    });
  }

  function setOpen(open) {
    isOpen = !!open;
    tab.classList.toggle('open', isOpen);
    drawer.classList.toggle('open', isOpen);
    if (document.body) document.body.classList.toggle('dc-sb-docked', isOpen);
    syncLiveBarsVisibility();
    if (isOpen) {
      shouldScrollBottom = true;
      scanMessages(true);
      const focusMeta = getFocusedTabMeta();
      if (focusMeta.channelId) {
        startBackgroundHistoryStream(focusMeta.channelId);
      }
      syncMouseBed();
      setTimeout(syncMouseBed, 240);
    } else {
      clearChatHighlight();
      if (!isDeleting) xmasMouse.hide();
    }
  }

  function updateFooter() {
    const n = selectedIds.size;
    footer.classList.toggle('visible', !isDeleting && n > 0);
    selCountEl.textContent = n + ' selected';
    delSelBtn.textContent = 'Delete Selected (' + n + ')';
  }

  function getActiveFxPresetLabel() {
    const vfx = window.__dcVfx;
    const presets = (vfx && typeof vfx.listPresets === 'function') ? vfx.listPresets() : [];
    const curId = (vfx && typeof vfx.getPreset === 'function') ? vfx.getPreset() : 'fairy';
    const match = presets.find(p => p.id === curId);
    return match ? match.label : 'Fairy Dust';
  }

  function syncFxPresetChip() {
    if (!fxPresetBtn) return;
    const label = getActiveFxPresetLabel();
    fxPresetBtn.textContent = 'FX: ' + label;
    fxPresetBtn.title = 'Dissolve shader: ' + label + ' (click to cycle)';
  }

  function syncSpeedSliderUI() {
    const engine = getEngine();
    const s = (engine && engine.getSettings) ? engine.getSettings() : { speedSlider: 0.55 };
    const val = typeof s.speedSlider === 'number' ? s.speedSlider : 0.55;
    if (speedSliderEl) speedSliderEl.value = String(Math.round(val * 100));
    const prof = (engine && engine.getSpeedProfile)
      ? engine.getSpeedProfile(val)
      : { zone: val > 0.8 ? 'risky' : (val > 0.45 ? 'focused' : 'normal'), label: val > 0.8 ? 'Max (Risky)' : (val > 0.45 ? 'Human Focused' : 'Human Normal') };
    if (speedBadgeEl) {
      speedBadgeEl.textContent = prof.label;
      speedBadgeEl.className = 'dc-sb-speed-badge ' + prof.zone;
    }
    if (tab) {
      tab.classList.remove('zone-normal', 'zone-focused', 'zone-risky');
      tab.classList.add('zone-' + prof.zone);
    }
  }

  function syncOptionChips() {
    const engine = getEngine();
    const s = (engine && engine.getSettings)
      ? engine.getSettings()
      : { mineOnly: true, hideDiscordMenu: true, enableVfx: true, mouseCursor: true, speedSlider: 0.55 };
    const SHORT = { mineOnly: 'Mine', newestFirst: 'Newest', removeReactions: 'Emotes', mouseCursor: 'Mouse', enableVfx: 'Particles' };
    optChips.forEach(chip => {
      const k = chip.dataset.opt;
      const on = !!s[k];
      chip.classList.toggle('on', on);
      chip.textContent = SHORT[k] || OPT_LABELS[k] || k;
    });
    syncFxPresetChip();
    syncSpeedSliderUI();
    syncMouseBed();
  }

  // --- Virtual scroller: DOM node count stays constant regardless of message count ---
  const VROW_H = 56;
  const VOVERSCAN = 8;
  let vSpacer = null, vWindow = null, vLastStart = -1, vLastEnd = -1, vRaf = 0;
  let shouldScrollBottom = true;

  let activeCtxMenu = null;
  function closeRowContextMenu() {
    if (activeCtxMenu) {
      activeCtxMenu.remove();
      activeCtxMenu = null;
    }
    window.removeEventListener('mousedown', onCtxOutside, true);
    window.removeEventListener('scroll', closeRowContextMenu, true);
    window.removeEventListener('resize', closeRowContextMenu);
  }
  function onCtxOutside(e) {
    if (activeCtxMenu && !activeCtxMenu.contains(e.target)) closeRowContextMenu();
  }
  function copyToClipboard(text, label) {
    const str = String(text || '');
    if (!str) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(str).then(
        () => showToast('Copied ' + label, 2000),
        () => fallbackCopy(str, label)
      );
    } else {
      fallbackCopy(str, label);
    }
  }
  function fallbackCopy(str, label) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      showToast('Copied ' + label, 2000);
    } catch (e) {
      showToast('Could not copy ' + label, 2400);
    }
  }
  function applyIdFilter(authorId, exclude, isOtherUser) {
    const flt = getFilter();
    const prefix = exclude ? '-id:' : 'id:';
    let nextQ = filterQuery;
    if (!exclude && isOtherUser && flt && typeof flt.hasTokenInQuery === 'function' && flt.hasTokenInQuery(nextQ, 'is:mine')) {
      nextQ = flt.toggleTokenInQuery(nextQ, 'is:mine');
    }
    const re = exclude ? /(^|\s)-id:([^\s]+)/i : /(^|\s)id:([^\s]+)/i;
    const m = nextQ.match(re);
    if (m) {
      const parts = m[2].split(',').map(s => s.trim()).filter(Boolean);
      const idx = parts.indexOf(authorId);
      if (idx >= 0) parts.splice(idx, 1);
      else parts.push(authorId);
      const repl = parts.length ? (m[1] + prefix + parts.join(',')) : '';
      nextQ = nextQ.replace(re, repl).replace(/\s+/g, ' ').trim();
    } else {
      nextQ = (nextQ ? (nextQ + ' ') : '') + prefix + authorId;
    }
    filterQuery = nextQ;
    filterInput.value = filterQuery;
    filterClear.classList.toggle('visible', filterQuery.length > 0);
    syncQuickChipStates();
    scanMessages(true);
    scheduleFilterServerSearch();
    showToast('Filter: ' + (filterQuery || 'All messages'), 2200);
  }
  function openRowContextMenu(e, m, locked, isDismiss) {
    closeRowContextMenu();
    const menu = document.createElement('div');
    menu.className = 'dc-sb-ctx-menu';
    const addItem = (label, onClick, isDanger) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dc-sb-ctx-item' + (isDanger ? ' danger' : '');
      btn.textContent = label;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeRowContextMenu();
        onClick();
      });
      menu.appendChild(btn);
    };
    const addSep = () => {
      const sep = document.createElement('div');
      sep.className = 'dc-sb-ctx-sep';
      menu.appendChild(sep);
    };

    const rawMsgId = String(m.rawId || m.id || '').replace(/^chat-messages-\d+-/, '');
    if (m.authorId) {
      addItem('Filter by User (id:' + m.authorId.slice(-4) + ')', () => applyIdFilter(m.authorId, false, !m.isMine));
      addItem('Exclude User (-id:' + m.authorId.slice(-4) + ')', () => applyIdFilter(m.authorId, true, false));
      addSep();
      addItem('Copy User ID', () => copyToClipboard(m.authorId, 'User ID: ' + m.authorId));
    }
    if (rawMsgId) {
      addItem('Copy Message ID', () => copyToClipboard(rawMsgId, 'Message ID'));
    }
    if (m.text) {
      addItem('Copy Message Text', () => copyToClipboard(m.text, 'Message Text'));
    }
    addSep();
    addItem('Jump to Message', () => {
      const br = getBridge();
      if (br && typeof br.jumpToMessage === 'function') {
        br.jumpToMessage(m.channelId || getFocusedTabMeta().channelId, m.rawId || m.id);
      }
    });
    if (!locked && !isDeleting) {
      addItem(isDismiss ? 'Dismiss Notice' : 'Delete Message', () => runEngineDeletion('selected', [m]), true);
    }

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(e.clientX, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(e.clientY, window.innerHeight - rect.height - 8));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    activeCtxMenu = menu;
    window.addEventListener('mousedown', onCtxOutside, true);
    window.addEventListener('scroll', closeRowContextMenu, true);
    window.addEventListener('resize', closeRowContextMenu);
  }

  function buildVirtualRow(m, idx) {
    const locked = (m.canRemove === false);
    const isDismiss = (m.actionType === 'dismiss');
    const row = document.createElement('div');
    row.className = 'dc-sb-row' + (selectedIds.has(m.id) ? ' selected' : '') + (locked ? ' locked' : '');
    row.dataset.id = m.id;
    row.dataset.idx = String(idx);

    const body = document.createElement('div');
    body.className = 'dc-sb-row-body';

    const authorEl = document.createElement('div');
    authorEl.className = 'dc-sb-author';
    authorEl.textContent = (m.author || 'Message') + (locked ? ' (read-only)' : (isDismiss ? ' \u2022 Dismiss' : ''));

    const textEl = document.createElement('div');
    textEl.className = 'dc-sb-text';
    textEl.textContent = m.text || '(embed / attachment)';

    body.appendChild(authorEl);
    body.appendChild(textEl);
    row.appendChild(body);

    if (!locked) {
      const xBtn = document.createElement('button');
      xBtn.className = 'dc-sb-del-x';
      xBtn.title = isDismiss ? 'Dismiss this notice' : 'Delete this message';
      xBtn.textContent = '\u00d7';
      xBtn.disabled = isDeleting;
      xBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isDeleting) return;
        runEngineDeletion('selected', [m]);
      });
      row.appendChild(xBtn);
    }

    row.addEventListener('mouseenter', () => highlightMessageInChat(m.id));
    row.addEventListener('mouseleave', () => clearChatHighlight());
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRowContextMenu(e, m, locked, isDismiss);
    });
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const br = getBridge();
      if (br && typeof br.jumpToMessage === 'function') {
        br.jumpToMessage(m.channelId || getFocusedTabMeta().channelId, m.rawId || m.id);
      }
    });

    if (!locked) {
      row.addEventListener('click', (e) => {
        const li = document.getElementById(m.id);
        if (li) li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

        if (e.shiftKey && lastAnchorIndex >= 0 && lastAnchorIndex < messages.length) {
          const start = Math.min(lastAnchorIndex, idx);
          const end   = Math.max(lastAnchorIndex, idx);
          if (!e.ctrlKey && !e.metaKey) selectedIds.clear();
          for (let i = start; i <= end; i++) {
            if (messages[i].canRemove !== false) selectedIds.add(messages[i].id);
          }
        } else if (e.ctrlKey || e.metaKey) {
          if (selectedIds.has(m.id)) selectedIds.delete(m.id);
          else selectedIds.add(m.id);
          lastAnchorIndex = idx;
        } else {
          if (selectedIds.size === 1 && selectedIds.has(m.id)) selectedIds.clear();
          else { selectedIds.clear(); selectedIds.add(m.id); }
          lastAnchorIndex = idx;
        }
        syncSelectionClasses();
        updateFooter();
      });
    }
    return row;
  }

  function renderVirtualSlice(force) {
    if (!vSpacer || !vWindow || messages.length === 0) return;
    const viewH = listEl.clientHeight || 520;
    const scrollTop = listEl.scrollTop || 0;
    const start = Math.max(0, Math.floor(scrollTop / VROW_H) - VOVERSCAN);
    const end = Math.min(messages.length, Math.ceil((scrollTop + viewH) / VROW_H) + VOVERSCAN);
    if (!force && start === vLastStart && end === vLastEnd) return;
    vLastStart = start;
    vLastEnd = end;
    vWindow.style.transform = `translate3d(0, ${start * VROW_H}px, 0)`;
    vWindow.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      frag.appendChild(buildVirtualRow(messages[i], i));
    }
    vWindow.appendChild(frag);
  }

  function renderList() {
    tabCount.textContent = String(messages.length);
    badge.textContent = String(messages.length);
    vLastStart = -1; vLastEnd = -1;

    if (messages.length === 0) {
      listEl.innerHTML = '';
      vSpacer = null; vWindow = null;
      const empty = document.createElement('div');
      empty.className = 'dc-sb-empty';
      empty.textContent = streamingChannelId
        ? 'Indexing your messages in background...'
        : 'No matching messages found in this chat.';
      listEl.appendChild(empty);
      updateFooter();
      return;
    }

    if (!vSpacer || !vSpacer.isConnected) {
      listEl.innerHTML = '';
      vSpacer = document.createElement('div');
      vSpacer.style.cssText = 'position:relative;width:100%;flex-shrink:0;';
      vWindow = document.createElement('div');
      vWindow.style.cssText = 'position:absolute;top:0;left:0;right:0;display:flex;flex-direction:column;gap:2px;will-change:transform;';
      vSpacer.appendChild(vWindow);
      listEl.appendChild(vSpacer);
    }
    vSpacer.style.height = (messages.length * VROW_H) + 'px';
    if (shouldScrollBottom) {
      shouldScrollBottom = false;
      listEl.scrollTop = 0;
    }
    renderVirtualSlice(true);
    updateFooter();
  }

  function syncSelectionClasses() {
    listEl.querySelectorAll('.dc-sb-row').forEach(r => {
      r.classList.toggle('selected', selectedIds.has(r.dataset.id));
    });
  }

  function renderQuickFilterChips() {
    const flt = getFilter();
    quickChipsEl.innerHTML = '';
    if (!flt || !Array.isArray(flt.QUICK_CHIPS)) return;
    flt.QUICK_CHIPS.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'dc-sb-qchip' + (flt.hasTokenInQuery(filterQuery, c.token) ? ' on' : '');
      btn.textContent = c.label;
      btn.title = 'Toggle ' + c.token;
      btn.addEventListener('click', () => {
        filterQuery = flt.toggleTokenInQuery(filterQuery, c.token);
        filterInput.value = filterQuery;
        filterClear.classList.toggle('visible', filterQuery.length > 0);
        syncQuickChipStates();
        scanMessages(true);
        scheduleFilterServerSearch();
      });
      quickChipsEl.appendChild(btn);
    });
  }

  function syncQuickChipStates() {
    const flt = getFilter();
    if (!flt) return;
    const btns = quickChipsEl.querySelectorAll('.dc-sb-qchip');
    (flt.QUICK_CHIPS || []).forEach((c, idx) => {
      if (btns[idx]) btns[idx].classList.toggle('on', flt.hasTokenInQuery(filterQuery, c.token));
    });
  }

  let lastTrackedLivePath = window.location.pathname;

  function scanMessages(force) {
    // State is kept per channel/DM so selections and modals don't leak across channels.
    const curLivePath = window.location.pathname;
    if (curLivePath !== lastTrackedLivePath) {
      lastTrackedLivePath = curLivePath;
      renderChannelTabs();
      if (activeTabKey === 'live') {
        channelSelections.set(activeChannelPath, new Set(selectedIds));
        activeChannelPath = curLivePath;
        selectedIds = new Set(channelSelections.get(curLivePath) || []);
        lastAnchorIndex = -1;
        shouldScrollBottom = true;
        clearChatHighlight();
        if (backdrop.classList.contains('open')) closeConfirmModal();
        force = true;
        if (isOpen) {
          const liveMeta = getCurrentLiveChannelMeta();
          const eng0 = getEngine();
          const st0 = (eng0 && eng0.getChannelIndexStats && liveMeta.channelId) ? eng0.getChannelIndexStats(liveMeta.channelId) : null;
          // Already-indexed channels render from RAM instantly: zero refetch on tab switch
          if (liveMeta.channelId && !(st0 && st0.autoIndexed)) startBackgroundHistoryStream(liveMeta.channelId);
        }
      }
    }

    const focusMeta = getFocusedTabMeta();
    const targetCid = focusMeta.channelId;
    const engine = getEngine();
    const flt = getFilter();
    const s = (engine && engine.getSettings) ? engine.getSettings() : { mineOnly: true };

    let raw = [];
    if (engine && typeof engine.getChannelMessages === 'function' && targetCid) {
      raw = engine.getChannelMessages(targetCid);
    } else if (engine && engine.readVisibleMessages) {
      raw = engine.readVisibleMessages();
    }

    const idxStats = (engine && typeof engine.getChannelIndexStats === 'function' && targetCid)
      ? engine.getChannelIndexStats(targetCid)
      : null;

    // Only load history in the background while the drawer is open.
    if (isOpen && idxStats && !idxStats.autoIndexed && targetCid) {
      idxStats.autoIndexed = true;
      startBackgroundHistoryStream(targetCid);
    }

    if (titleEl) {
      titleEl.textContent = focusMeta.isLockedTab
        ? ('\ud83e\uddf9 ' + (focusMeta.label || 'Cleaning').slice(0, 15))
        : (focusMeta.label || 'Messages').slice(0, 16);
    }

    // Filter bar (pre-toggled with is:mine) is the single source of truth for Mine vs All messages
    let pool = raw;

    let next = pool;
    let errText = '';
    if (filterQuery && flt && typeof flt.filterMessages === 'function') {
      const res = flt.filterMessages(pool, filterQuery);
      next = res.items;
      errText = res.error || '';
    }

    filterInput.classList.toggle('error', !!errText);
    filterErr.textContent = errText;
    filterErr.classList.toggle('visible', !!errText);

    const totalBadgeTxt = (idxStats && !idxStats.reachedTop && typeof idxStats.totalResults === 'number' && idxStats.totalResults > next.length && !filterQuery)
      ? String(idxStats.totalResults)
      : String(next.length);

    let sig = activeTabKey + '|' + focusMeta.path + '|' + totalBadgeTxt + '|' + next.length + '|' + (s.mineOnly ? '1:' : '0:') + filterQuery + '|' + errText + '|';
    for (let i = 0; i < next.length; i++) {
      sig += next[i].id + '|' + (next[i].text || '').slice(0, 20) + ';';
    }

    tabCount.textContent = totalBadgeTxt;
    badge.textContent = (idxStats && !idxStats.reachedTop && typeof idxStats.totalResults === 'number' && idxStats.totalResults > next.length && !filterQuery)
      ? (next.length + ' / ' + idxStats.totalResults)
      : String(next.length);
    if (!force && sig === lastSignature) return;
    lastSignature = sig;
    // Display newest messages first at the top of the right-hand list so it never jumps as older history streams in
    messages = next.slice().reverse();

    const validSet = new Set(messages.map(m => m.id));
    for (const id of Array.from(selectedIds)) {
      if (!validSet.has(id)) selectedIds.delete(id);
    }

    if (isOpen) {
      renderList();
      badge.textContent = (idxStats && !idxStats.reachedTop && typeof idxStats.totalResults === 'number' && idxStats.totalResults > next.length && !filterQuery)
        ? (next.length + ' / ' + idxStats.totalResults)
        : String(next.length);
      tabCount.textContent = totalBadgeTxt;
    }
  }

  function openSelectedConfirmModal(items) {
    if (!items || items.length === 0 || isDeleting) return;
    modalMode = 'selected';
    pendingDeleteItems = items.slice();

    const n = pendingDeleteItems.length;
    modalTitle.textContent = 'Delete ' + n + ' selected messages?';
    modalSub.textContent = 'Deletes live right in front of you with pixel dissolve and learned safe pacing. Cancel anytime.';
    modalNotice.classList.remove('visible');
    modalList.classList.remove('hidden');
    modalList.innerHTML = '';
    pendingDeleteItems.forEach(m => {
      const div = document.createElement('div');
      div.className = 'dc-sb-modal-item';
      const strong = document.createElement('strong');
      strong.textContent = (m.author || 'Message') + ':';
      div.appendChild(strong);
      div.appendChild(document.createTextNode(m.text || '(embed / attachment)'));
      modalList.appendChild(div);
    });

    confirmBtn.textContent = 'Delete (' + n + ')';
    backdrop.classList.add('open');
  }

  function openDeleteAllConfirmModal() {
    if (isDeleting) return;
    modalMode = 'all';
    pendingDeleteItems = [];

    const focus = getFocusedTabMeta();
    modalTitle.textContent = 'Delete all your messages in ' + (focus.label || 'this chat') + '?';
    modalSub.textContent = 'Deletes only your messages in the background while you keep using Discord. Other users and bots are never touched.';
    modalList.classList.add('hidden');
    modalList.innerHTML = '';
    modalNotice.classList.add('visible');
    modalNotice.textContent = 'Safe rate-limit pacing is active. You can pause or cancel at any time.';

    confirmBtn.textContent = 'Start Deleting';
    backdrop.classList.add('open');
  }

  function closeConfirmModal() {
    backdrop.classList.remove('open');
    pendingDeleteItems = [];
  }

  function updateBucketBadge(bucketLabel) {
    const label = bucketLabel || '';
    if (!label) {
      liveBucket.textContent = '';
      liveBucket.classList.remove('visible', 'warn', 'limit');
      return;
    }
    liveBucket.textContent = label;
    liveBucket.classList.add('visible');
    const is429 = label.indexOf('429') !== -1;
    const isEmpty = !is429 && /^Live\s+0(\/|$)/.test(label);
    liveBucket.classList.toggle('limit', is429);
    liveBucket.classList.toggle('warn', isEmpty);
  }

  function handleEngineProgress(st) {
    if (!st) return;

    if (st.lastDeletedId) {
      selectedIds.delete(st.lastDeletedId);
      if (window.__dcPopoutChat && typeof window.__dcPopoutChat.removeMessage === 'function') {
        window.__dcPopoutChat.removeMessage(st.lastDeletedId);
      }
      // Remove the single row instead of rebuilding the list, which would interrupt running VFX.
      const rowEl = listEl.querySelector(`.dc-sb-row[data-id="${CSS.escape ? CSS.escape(st.lastDeletedId) : st.lastDeletedId}"]`);
      if (rowEl) rowEl.remove();
      messages = messages.filter(m => m.id !== st.lastDeletedId);
      const countStr = String(messages.length);
      tabCount.textContent = countStr;
      badge.textContent = countStr;
      updateFooter();
    }

    const pacing = st.pacingLabel ||
      (st.paused ? 'Paused' : (st.cooldownMs > 0 ? (st.cooldownMs / 1000).toFixed(1) + 's' : 'Active'));

    const debugTail = (st.rateLimits > 0 ? (' \u2022 Retries: ' + st.rateLimits) : '') + (st.failed > 0 ? (' \u2022 Fail: ' + st.failed) : '');
    const statsLine = st.mode === 'all'
      ? ('Deleted: ' + st.deleted + debugTail + '  \u2022  ' + pacing)
      : ('Deleted: ' + st.deleted + '/' + st.total + debugTail + '  \u2022  ' + pacing);

    liveStats.textContent = statsLine;
    updateBucketBadge(st.bucketLabel);
    liveSub.textContent = st.currentLabel || '';
    floatText.textContent = st.paused
      ? ('Paused (' + st.deleted + ' deleted)')
      : ('Deleting... ' + st.deleted + (st.mode === 'selected' && st.total > 0 ? ('/' + st.total) : '') +
         (st.bucketLabel ? (' \u2022 ' + st.bucketLabel) : ''));

    if (st.mode === 'all') {
      if (st.running) {
        progFill.classList.add('indeterminate');
        progFill.classList.toggle('paused', !!st.paused);
      } else {
        progFill.classList.remove('indeterminate', 'paused');
        progFill.style.width = '100%';
      }
    } else {
      progFill.classList.remove('indeterminate');
      progFill.classList.toggle('paused', !!st.paused);
      const pct = st.total > 0 ? Math.min(100, Math.round((st.processed / st.total) * 100)) : 100;
      progFill.style.width = pct + '%';
    }

    const paused = !!st.paused;
    floatDot.classList.toggle('paused', paused);
    livePause.classList.toggle('is-paused', paused);
    floatPause.classList.toggle('is-paused', paused);
    livePause.textContent = paused ? 'Resume' : 'Pause';
    floatPause.textContent = paused ? 'Resume' : 'Pause';
  }

  async function runEngineDeletion(mode, items) {
    if (isDeleting) return;
    const engine = getEngine();
    if (!engine) {
      showToast('Delete engine not loaded.', 3000);
      return;
    }
    if (mode === 'selected' && (!items || items.length === 0)) return;

    backdrop.classList.remove('open');
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    toastEl.classList.remove('visible');

    // Lock onto the current channel when deletion starts.
    const focusMeta = getFocusedTabMeta();
    activeCleaningTarget = {
      channelId: focusMeta.channelId,
      path: focusMeta.path,
      label: focusMeta.label
    };
    activeTabKey = 'cleaning';

    isDeleting = true;
    delAllBtn.disabled = true;
    // Switch to the Mouse Env tab when the mouse cursor is enabled.
    if (engine.getSettings && engine.getSettings().mouseCursor && window.__dcPopoutChat && window.__dcPopoutChat.open) {
      activeTabKey = 'mouse';
      const allForPop = (engine.getChannelMessages && focusMeta.channelId) ? engine.getChannelMessages(focusMeta.channelId) : messages;
      window.__dcPopoutChat.open(focusMeta.channelId, focusMeta.label, allForPop);
      xmasMouse.show();
      if (window.__dcMouseCursor && window.__dcMouseCursor.backflip) window.__dcMouseCursor.backflip();
    }
    progFill.style.width = '0%';
    progFill.classList.remove('indeterminate', 'paused');
    liveStats.textContent = 'Starting deletion...';
    updateBucketBadge(engine.getState ? engine.getState().bucketLabel : '');
    liveSub.textContent = '';
    floatText.textContent = 'Deleting...';
    renderChannelTabs();
    syncLiveBarsVisibility();
    if (isOpen) renderList();

    let finalState = null;
    const runOpts = {
      channelId: activeCleaningTarget.channelId,
      channelPath: activeCleaningTarget.path,
      channelLabel: activeCleaningTarget.label,
      filterQuery
    };
    tab.classList.add('active-cleaning');
    try {
      if (mode === 'all') {
        finalState = await engine.runAllInCurrentTab(handleEngineProgress, runOpts);
      } else {
        finalState = await engine.runSelected(items, handleEngineProgress, runOpts);
      }
    } finally {
      if (finalState && !finalState.stopped && finalState.deleted > 0 && window.__dcMouseCursor && window.__dcMouseCursor.victoryDance) {
        const closeBtn = document.querySelector('#dc-mouse-chat-window .dc-mc-min');
        try { await window.__dcMouseCursor.victoryDance(closeBtn); } catch (e) {}
      }
      if (window.__dcPopoutChat && typeof window.__dcPopoutChat.close === 'function') {
        window.__dcPopoutChat.close();
      }
      tab.classList.remove('active-cleaning');
      isDeleting = false;
      activeCleaningTarget = null;
      activeTabKey = 'live';
      delAllBtn.disabled = false;
      renderChannelTabs();
      syncLiveBarsVisibility();
      scanMessages(true);
      if (isOpen) renderList();
      setTimeout(() => syncMouseBed(), 50);
    }

    if (finalState) {
      if (finalState.stopped) {
        showToast('Cancelled \u2014 deleted ' + finalState.deleted + ' message(s).', 3000);
      } else if (finalState.deleted === 0) {
        showToast('No deletable messages removed.', 2800);
      } else {
        const extra = (finalState.rateLimits > 0 ? (', ' + finalState.rateLimits + ' retries') : '') + (finalState.failed > 0 ? (', ' + finalState.failed + ' failed') : '');
        showToast('Done \u2014 deleted ' + finalState.deleted + ' message(s)' + extra + '.', 3200);
      }
    }
  }

  function togglePause() {
    const engine = getEngine();
    if (!engine || !isDeleting) return;
    const st = engine.getState();
    if (st.paused) engine.resume();
    else engine.pause();
  }

  function cancelActiveDeletion() {
    const engine = getEngine();
    if (!engine || !isDeleting) return;
    engine.stop();
    liveSub.textContent = 'Cancelling...';
    floatText.textContent = 'Cancelling...';
  }

  // Event bindings
  tab.addEventListener('click', () => setOpen(true));
  collapseBtn.addEventListener('click', () => setOpen(false));
  delAllBtn.addEventListener('click', () => openDeleteAllConfirmModal());

  optsBtn.addEventListener('click', () => {
    const open = !optsBar.classList.contains('open');
    optsBar.classList.toggle('open', open);
    syncMouseBed();
    optsBtn.classList.toggle('active', open);
    if (open) syncOptionChips();
  });

  optChips.forEach(chip => {
    chip.addEventListener('click', () => {
      const engine = getEngine();
      if (!engine || !engine.getSettings || !engine.setSettings) return;
      const k = chip.dataset.opt;
      const cur = engine.getSettings();
      const patch = {};
      patch[k] = !cur[k];
      engine.setSettings(patch);
      syncOptionChips();
      if (k === 'mineOnly') scanMessages(true);
    });
  });

  if (speedSliderEl) {
    speedSliderEl.addEventListener('input', () => {
      const engine = getEngine();
      if (!engine || !engine.setSettings) return;
      const v = Math.max(0, Math.min(1, Number(speedSliderEl.value) / 100));
      engine.setSettings({ speedSlider: v });
      syncSpeedSliderUI();
    });
  }

  if (fxPresetBtn) {
    fxPresetBtn.addEventListener('click', () => {
      const vfx = window.__dcVfx;
      if (!vfx || typeof vfx.listPresets !== 'function' || typeof vfx.setPreset !== 'function') return;
      const presets = vfx.listPresets();
      if (!presets.length) return;
      const curId = typeof vfx.getPreset === 'function' ? vfx.getPreset() : presets[0].id;
      const idx = presets.findIndex(p => p.id === curId);
      const next = presets[(idx + 1) % presets.length];
      vfx.setPreset(next.id);
      syncFxPresetChip();
      showToast('VFX Theme: ' + next.label + ' \u2014 click Test FX to preview.', 2000);
    });
  }

  if (devToggleBtn) {
    let devOn = false;
    devToggleBtn.addEventListener('click', () => {
      devOn = !devOn;
      devToggleBtn.classList.toggle('on', devOn);
      devToggleBtn.textContent = 'Dev';
      if (simChatBtn) simChatBtn.style.display = devOn ? '' : 'none';
      if (simClearBtn) simClearBtn.style.display = devOn ? '' : 'none';
      syncMouseBed();
    });
  }

  if (simChatBtn) {
    const SIM_POOL = [
      'yo are you around?', 'yeah whats up', 'testing the pace rhythm slider', 'nice does it skip mine?',
      'yep Mine Only ignores yours', 'check https://example.com for has:link', 'the dissolve shader is clean',
      'try switching to sakura petals', 'cyber glitch looks wild too', 'how fast is gold vs green?',
      'green is relaxed, gold is focused', 'red is max risky speed', 'docked sidebar feels native',
      'lol true no overlap now', 'ready for the next batch?', '3... 2... 1... wipe it!'
    ];
    simChatBtn.addEventListener('click', () => {
      const br = getBridge();
      const core = br && br.resolveInternals ? br.resolveInternals(false) : null;
      const cid = br && br.getCurrentChannelIdFromUrl ? br.getCurrentChannelIdFromUrl() : '';
      const me = br && br.getCurrentUser ? br.getCurrentUser() : null;
      if (!core || !core.FluxDispatcher || !cid || !me) {
        showToast('Bridge not ready for local sim chat.', 2200);
        return;
      }
      const other = { id: '234567890123456789', username: 'sim_friend', global_name: 'Sim Friend', avatar: null };
      const nowMs = Date.now();
      const base = BigInt(br.timestampMsToSnowflake(nowMs - 60000));
      for (let i = 0; i < 30; i++) {
        const isMine = (i % 2 === 0) ? (Math.random() < 0.78) : (Math.random() < 0.22);
        const text = SIM_POOL[Math.floor(Math.random() * SIM_POOL.length)] + ' #' + (i + 1);
        const msg = {
          id: String(base + BigInt(i) * 4194304n * 2n + BigInt(Math.floor(Math.random() * 500))),
          channel_id: cid,
          author: isMine ? { id: me.id, username: me.username, global_name: me.globalName, avatar: me.avatar } : other,
          content: text,
          timestamp: new Date(nowMs - (30 - i) * 1500).toISOString(),
          type: 0, flags: 0,
          state: isMine ? 'SEND_FAILED' : 'SENT',
          attachments: [], embeds: [], mentions: [], mention_roles: []
        };
        core.FluxDispatcher.dispatch({ type: 'MESSAGE_CREATE', channelId: cid, message: msg, optimistic: isMine, isPushNotification: false });
        if (!simInjectedIds.has(cid)) simInjectedIds.set(cid, new Set());
        simInjectedIds.get(cid).add(msg.id);
      }
      scanMessages(true);
      showToast('Added 30 local-only test messages (0 network calls).', 2200);
    });
  }

  if (simClearBtn) {
    simClearBtn.addEventListener('click', () => {
      const br = getBridge();
      const core = br && br.resolveInternals ? br.resolveInternals(false) : null;
      const cid = br && br.getCurrentChannelIdFromUrl ? br.getCurrentChannelIdFromUrl() : '';
      if (!core || !core.FluxDispatcher || !cid) return;
      const ids = new Set(simInjectedIds.get(cid) || []);
      // Also catch any sim_friend / :3 local fake messages from earlier injections
      if (br.getCachedChannelMessages) {
        for (const m of br.getCachedChannelMessages(cid)) {
          if (m.authorId === '234567890123456789') ids.add(m.rawId);
        }
      }
      for (const id of ids) {
        if (core.MessageActions && typeof core.MessageActions.deleteMessage === 'function') {
          try { core.MessageActions.deleteMessage(cid, id, true); } catch (e) {}
        }
        try { core.FluxDispatcher.dispatch({ type: 'MESSAGE_DELETE', id, channelId: cid }); } catch (e) {}
      }
      simInjectedIds.delete(cid);
      scanMessages(true);
      showToast('Cleared ' + ids.size + ' local sim message(s).', 2000);
    });
  }

  if (snowBtn) {
    const syncSnow = () => {
      const on = !!(window.__dcSnowShader && window.__dcSnowShader.isEnabled && window.__dcSnowShader.isEnabled());
      snowBtn.classList.toggle('on', on);
      snowBtn.textContent = '\u2744 Snow';
    };
    syncSnow();
    snowBtn.addEventListener('click', () => {
      if (window.__dcSnowShader && window.__dcSnowShader.toggle) {
        window.__dcSnowShader.toggle();
        syncSnow();
      }
    });
  }

  testFxBtn.addEventListener('click', () => {
    const vfx = window.__dcVfx;
    if (!vfx || !vfx.previewOnElement) return;
    const targetMsg = messages[0];
    const allVis = document.querySelectorAll('li[id^="chat-messages-"]');
    const li = (targetMsg && document.getElementById(targetMsg.id)) || (allVis.length ? allVis[allVis.length - 1] : null);
    if (li && vfx.previewOnElement(li)) {
      showToast('Previewing ' + getActiveFxPresetLabel() + ' VFX (no message deleted).', 2200);
    } else {
      showToast('No visible message to preview VFX on.', 2000);
    }
  });

  // Virtual Scroll + Infinite Background Streamer on scroll
  listEl.addEventListener('scroll', () => {
    if (!isOpen) return;
    if (!vRaf) {
      vRaf = requestAnimationFrame(() => {
        vRaf = 0;
        renderVirtualSlice(false);
      });
    }
    if (!isDeleting && listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 160) {
      const focusMeta = getFocusedTabMeta();
      if (focusMeta.channelId && !streamingChannelId) {
        startBackgroundHistoryStream(focusMeta.channelId);
      }
    }
  });

  clearBtn.addEventListener('click', () => {
    selectedIds.clear();
    syncSelectionClasses();
    updateFooter();
  });

  function triggerDeleteSelected() {
    if (isDeleting) return;
    const items = messages.filter(m => selectedIds.has(m.id) && m.canRemove !== false);
    if (items.length === 0) return;
    if (items.length === 1) runEngineDeletion('selected', items);
    else openSelectedConfirmModal(items);
  }

  function selectAllRemovable() {
    if (isDeleting) return;
    selectedIds.clear();
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].canRemove !== false) {
        selectedIds.add(messages[i].id);
      }
    }
    syncSelectionClasses();
    updateFooter();
  }

  function isEditableTarget(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (typeof el.getAttribute === 'function') {
      const ce = el.getAttribute('contenteditable');
      if (ce === '' || ce === 'true' || ce === 'plaintext-only') return true;
      if (el.getAttribute('role') === 'textbox') return true;
    }
    if (typeof el.closest === 'function') {
      if (el.closest('input, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]')) {
        return true;
      }
    }
    return false;
  }

  delSelBtn.addEventListener('click', triggerDeleteSelected);

  livePause.addEventListener('click', togglePause);
  floatPause.addEventListener('click', togglePause);
  liveStop.addEventListener('click', cancelActiveDeletion);
  floatStop.addEventListener('click', cancelActiveDeletion);

  cancelBtn.addEventListener('click', closeConfirmModal);
  confirmBtn.addEventListener('click', () => {
    const m = modalMode;
    const items = pendingDeleteItems.slice();
    pendingDeleteItems = [];
    runEngineDeletion(m, items);
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeConfirmModal();
  });

  const onKeyDown = (e) => {
    if (!e.isTrusted) return;

    // Alt + M: Toggle Messages Sidebar (always allowed, even while focused in chat input)
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM')) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!isOpen);
      return;
    }

    // Alt+W: switch between the pinned channel and the browsed channel via the in-app router.
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'w' || e.key === 'W' || e.code === 'KeyW')) {
      e.preventDefault();
      e.stopPropagation();
      triggerPinOrSwap();
      return;
    }

    // Escape / Shift + Escape (always allowed)
    if (e.key === 'Escape') {
      if (backdrop.classList.contains('open')) {
        e.preventDefault();
        closeConfirmModal();
      } else if (e.shiftKey && isDeleting) {
        e.preventDefault();
        cancelActiveDeletion();
      } else if (selectedIds.size > 0 && !isDeleting) {
        selectedIds.clear();
        syncSelectionClasses();
        updateFooter();
      }
      return;
    }

    // Never intercept typing shortcuts inside INPUT / TEXTAREA / contenteditable chat boxes
    if (isEditableTarget(document.activeElement) || isEditableTarget(e.target)) {
      return;
    }

    // Ignore background shortcuts while confirmation modal is open
    if (backdrop.classList.contains('open')) {
      return;
    }

    // Space: Pause / Resume active deletion
    if ((e.key === ' ' || e.code === 'Space') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (isDeleting) {
        e.preventDefault();
        e.stopPropagation();
        togglePause();
      }
      return;
    }

    // Delete: Delete selected message(s) when sidebar is open and selection > 0
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isOpen && !isDeleting && selectedIds.size > 0) {
        e.preventDefault();
        e.stopPropagation();
        triggerDeleteSelected();
      }
      return;
    }

    // Ctrl + A: Select all visible removable messages when sidebar is open
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A' || e.code === 'KeyA')) {
      if (isOpen && !isDeleting) {
        e.preventDefault();
        e.stopPropagation();
        selectAllRemovable();
      }
    }
  };
  window.addEventListener('keydown', onKeyDown, true);

  let scanTimer = null;
  const scheduleScan = () => {
    if (isDeleting || scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!isDeleting) scanMessages(false);
    }, 250);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      if (mut.target && mut.target.closest && mut.target.closest('#' + ROOT_ID)) continue;
      scheduleScan();
      break;
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function triggerPinOrSwap() {
    const engine = getEngine();
    if (!engine || !engine.swapToPinnedOrReturn) return;
    engine.swapToPinnedOrReturn();
    setTimeout(() => {
      renderChannelTabs();
      scanMessages(true);
    }, 60);
  }

  if (floatSwap) floatSwap.addEventListener('click', triggerPinOrSwap);

  filterInput.addEventListener('input', () => {
    filterQuery = filterInput.value || '';
    filterClear.classList.toggle('visible', filterQuery.length > 0);
    syncQuickChipStates();
    scanMessages(true);
    scheduleFilterServerSearch();
  });
  filterClear.addEventListener('click', () => {
    filterQuery = '';
    filterInput.value = '';
    filterClear.classList.remove('visible');
    syncQuickChipStates();
    scanMessages(true);
    filterInput.focus();
  });

  const bridgeUnsubscribers = [];
  const brInit = getBridge();
  if (brInit && typeof brInit.on === 'function') {
    bridgeUnsubscribers.push(brInit.on('discord:message_create', () => scanMessages(true)));
    bridgeUnsubscribers.push(brInit.on('discord:message_delete', () => scanMessages(true)));
    bridgeUnsubscribers.push(brInit.on('engine:message_deleted', () => scanMessages(true)));
    bridgeUnsubscribers.push(brInit.on('engine:index_updated', () => scanMessages(true)));
  }

  syncOptionChips();
  const filterHelpBtn = drawer.querySelector('.dc-sb-filter-help');
  const filterHelpBox = drawer.querySelector('.dc-sb-help-box');
  if (filterHelpBtn && filterHelpBox) {
    filterHelpBtn.addEventListener('click', () => {
      const show = filterHelpBox.style.display === 'none';
      filterHelpBox.style.display = show ? 'block' : 'none';
      filterHelpBtn.style.color = show ? '#5865f2' : '#949ba4';
      syncMouseBed();
    });
  }
  filterInput.value = filterQuery;
  filterClear.classList.toggle('visible', filterQuery.length > 0);
  renderQuickFilterChips();
  renderChannelTabs();
  scanMessages(true);

  window.__dcMsgSidebar = {
    version: 14,
    toggle: () => setOpen(!isOpen),
    swapPinned: () => triggerPinOrSwap(),
    open:   () => setOpen(true),
    close:  () => setOpen(false),
    refresh: () => scanMessages(true),
    destroy: () => {
      isOpen = false;
      if (document.body) document.body.classList.remove('dc-sb-docked');
      streamingChannelId = '';
      for (const unsub of bridgeUnsubscribers.splice(0)) {
        try { unsub(); } catch (e) {}
      }
      const engine = getEngine();
      if (engine && typeof engine.stop === 'function') {
        try { engine.stop(); } catch (e) {}
      }
      if (toastTimer) clearTimeout(toastTimer);
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
      window.removeEventListener('keydown', onKeyDown, true);
      closeRowContextMenu();
      clearChatHighlight();
      const r = document.getElementById(ROOT_ID);
      if (r) r.remove();
      const s = document.getElementById(STYLE_ID);
      if (s) s.remove();
      delete window.__dcMsgSidebar;
    }
  };

  return 'mounted';
})();
