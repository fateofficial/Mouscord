// Modular Docked Popout Chat Window for the Mouse/Agent (window.__dcPopoutChat v1)
// Only opens while a cleanup is running; dockable & minimizable; looks like a mini Discord chat.
(function() {
  if (window.__dcPopoutChat && window.__dcPopoutChat.version === 1) {
    return 'already-mounted';
  }
  if (window.__dcPopoutChat && typeof window.__dcPopoutChat.destroy === 'function') {
    try { window.__dcPopoutChat.destroy(); } catch (e) {}
  }

  let winEl = null, feedEl = null, titleEl = null, countEl = null, minBtn = null;
  let minimized = false, activeChannelId = '';

  function ensureWindow() {
    if (winEl && winEl.isConnected) return winEl;
    if (!document.getElementById('dc-mc-style')) {
      const st = document.createElement('style');
      st.id = 'dc-mc-style';
      st.textContent = `
        #dc-mouse-chat-window .dc-mc-feed::-webkit-scrollbar { width: 6px; }
        #dc-mouse-chat-window .dc-mc-feed::-webkit-scrollbar-track { background: transparent; }
        #dc-mouse-chat-window .dc-mc-feed::-webkit-scrollbar-thumb { background: var(--scrollbar-thin-thumb, #1a1b1e); border-radius: 999px; }
        #dc-mouse-chat-window .dc-mc-row:hover { background: var(--background-message-hover, rgba(255,255,255,0.03)); }
      `;
      document.head.appendChild(st);
    }
    winEl = document.createElement('div');
    winEl.id = 'dc-mouse-chat-window';
    // Docked cleanly below the 2-tab bar (top: 66px) and flush with the Pause/Cancel live bar (bottom: 82px)
    winEl.style.cssText = [
      'position:fixed;right:0;top:66px;bottom:82px;width:360px;display:none;flex-direction:column;',
      'background:var(--background-primary,#1a1a1e);border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,0.08));',
      'border-left:1px solid var(--background-modifier-accent,rgba(255,255,255,0.08));z-index:99993;overflow:hidden;',
      'font-family:var(--font-primary,"gg sans","Segoe UI",system-ui,sans-serif);color:var(--text-normal,#f2f3f5);'
    ].join('');

    winEl.innerHTML = `
      <div class="dc-mc-bar" style="display:flex;align-items:center;justify-content:space-between;padding:9px 11px;background:var(--background-secondary,#141417);border-bottom:1px solid var(--background-modifier-accent,rgba(255,255,255,0.08));user-select:none;">
        <div style="display:flex;align-items:center;gap:7px;min-width:0;">
          <span>🐭</span>
          <span class="dc-mc-title" style="font-weight:700;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Cleaning</span>
          <span class="dc-mc-count" style="font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px;background:rgba(218,55,60,0.25);color:#ff9ea1;">0</span>
        </div>
        <button class="dc-mc-min" title="Switch to Controls / Minimize" style="border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.06);color:#dbdee1;font-size:11px;font-weight:600;padding:3px 8px;border-radius:5px;cursor:pointer;">&#9881; Controls</button>
      </div>
      <div class="dc-mc-feed" style="flex:1;overflow-y:auto;padding:10px 6px;display:flex;flex-direction:column;gap:4px;background:var(--background-primary,#1a1a1e);"></div>
    `;
    document.body.appendChild(winEl);
    titleEl = winEl.querySelector('.dc-mc-title');
    countEl = winEl.querySelector('.dc-mc-count');
    feedEl  = winEl.querySelector('.dc-mc-feed');
    minBtn  = winEl.querySelector('.dc-mc-min');

    const toggleMin = () => {
      minimized = !minimized;
      if (minimized) {
        winEl.style.top = 'auto';
        winEl.style.bottom = '12px';
        winEl.style.right = '12px';
        winEl.style.height = '38px';
        winEl.style.width = '240px';
        winEl.style.borderRadius = '8px';
        feedEl.style.display = 'none';
        minBtn.textContent = '🐭 View Chat';
      } else {
        winEl.style.top = '32px';
        winEl.style.bottom = '0';
        winEl.style.right = '0';
        winEl.style.height = 'auto';
        winEl.style.width = '340px';
        winEl.style.borderRadius = '0';
        feedEl.style.display = 'flex';
        minBtn.textContent = '\u2699 Controls';
      }
    };
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMin(); });
    return winEl;
  }

  function open(channelId, label, messages) {
    const w = ensureWindow();
    activeChannelId = String(channelId || '');
    minimized = false;
    w.style.display = 'flex';
    w.style.top = '66px';
    w.style.bottom = '82px';
    w.style.right = '0';
    w.style.height = 'auto';
    w.style.width = '360px';
    w.style.borderRadius = '0';
    feedEl.style.display = 'flex';
    minBtn.textContent = '\u2699 Controls';
    titleEl.textContent = label || 'Cleaning Chat';

    const list = Array.isArray(messages) ? messages.slice(-45) : [];
    const mineCount = list.filter(m => m.canRemove).length;
    countEl.textContent = mineCount + ' left';

    feedEl.innerHTML = '';
    const ol = document.createElement('ol');
    ol.style.cssText = 'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;';
    const frag = document.createDocumentFragment();
    for (const m of list) {
      const realLi = document.getElementById(m.id) || (m.rawId ? document.querySelector(`li[id$="-${m.rawId}"]`) : null);
      let row;
      if (realLi) {
        // Clone of Discord's message DOM so avatars, timestamps, links and theme match.
        row = realLi.cloneNode(true);
        row.removeAttribute('id');
        row.classList.add('dc-mc-row');
        row.dataset.id = m.id;
        if (m.rawId) row.dataset.rawId = m.rawId;
        row.style.position = 'relative';
        row.style.listStyle = 'none';
      } else {
        row = document.createElement('li');
        row.className = 'dc-mc-row';
        row.dataset.id = m.id;
        row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:6px 12px;position:relative;list-style:none;';
        const init = (m.author || '?').slice(0, 1).toUpperCase();
        row.innerHTML = `
          <div style="width:36px;height:36px;border-radius:50%;background:${m.isMine ? '#5865f2' : '#3ba55d'};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;color:#fff;">${init}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:${m.isMine ? '#ff9ea1' : '#f2f3f5'};">${(m.author || 'User').replace(/</g, '&lt;')}</div>
            <div style="font-size:13.5px;color:#dbdee1;line-height:1.375;word-break:break-word;">${(m.text || '(attachment)').replace(/</g, '&lt;')}</div>
          </div>
        `;
      }
      if (m.canRemove) {
        const delBtn = document.createElement('button');
        delBtn.className = 'dc-mc-del';
        delBtn.innerHTML = '&times;';
        delBtn.title = 'Delete message';
        delBtn.style.cssText = 'position:absolute;right:10px;top:6px;width:24px;height:24px;border:1px solid rgba(255,255,255,0.1);border-radius:6px;background:var(--background-secondary,#1e1f22);color:#b5bac1;font-size:14px;cursor:pointer;z-index:2;transition:transform 0.08s,background 0.1s;';
        row.appendChild(delBtn);
      }
      frag.appendChild(row);
    }
    ol.appendChild(frag);
    feedEl.appendChild(ol);
    feedEl.scrollTop = feedEl.scrollHeight;
  }

  function getDeleteButton(msgId) {
    if (!winEl || winEl.style.display === 'none' || minimized || !feedEl) return null;
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(msgId) : msgId;
    const sfMatch = String(msgId || '').match(/(\d{17,20})$/);
    const sf = sfMatch ? sfMatch[1] : '';
    let row = feedEl.querySelector(`.dc-mc-row[data-id="${esc}"]`) || (sf ? feedEl.querySelector(`.dc-mc-row[data-raw-id="${sf}"]`) : null);
    // Sliding-window auto-refill: if msgId is older than our current 250-row slice, load the next window from delete_engine.
    if (!row && activeChannelId && window.__dcDeleteEngine && window.__dcDeleteEngine.getChannelMessages) {
      const all = window.__dcDeleteEngine.getChannelMessages(activeChannelId);
      const idx = all.findIndex(m => m.id === msgId);
      if (idx >= 0) {
        const start = Math.max(0, idx - 35);
        const end = Math.min(all.length, idx + 10);
        open(activeChannelId, titleEl ? titleEl.textContent : 'Cleaning', all.slice(start, end));
        row = feedEl.querySelector(`.dc-mc-row[data-id="${esc}"]`);
      }
    }
    if (row) {
      try { row.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    }
    return row ? row.querySelector('.dc-mc-del') : null;
  }

  function removeMessage(msgId) {
    if (!feedEl) return;
    const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(msgId) : msgId;
    const row = feedEl.querySelector(`.dc-mc-row[data-id="${esc}"]`);
    if (row) row.remove();
    const realLeft = (activeChannelId && window.__dcDeleteEngine && window.__dcDeleteEngine.getChannelMessages)
      ? window.__dcDeleteEngine.getChannelMessages(activeChannelId).filter(m => m.canRemove).length
      : feedEl.querySelectorAll('.dc-mc-del').length;
    if (countEl) countEl.textContent = realLeft + ' left';
  }

  function close() {
    if (winEl) winEl.style.display = 'none';
    activeChannelId = '';
  }

  function destroy() {
    close();
    if (winEl) { try { winEl.remove(); } catch (e) {} winEl = null; }
    delete window.__dcPopoutChat;
  }

  window.__dcPopoutChat = {
    version: 1,
    open,
    close,
    getDeleteButton,
    removeMessage,
    isOpen: () => !!(winEl && winEl.style.display !== 'none'),
    isMinimized: () => minimized,
    destroy
  };

  return 'mounted';
})();
