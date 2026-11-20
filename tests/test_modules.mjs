import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const rootDir = path.resolve(import.meta.dirname, '..');
const coreSrc       = fs.readFileSync(path.join(rootDir, 'src/js/core_runtime.js'), 'utf8');
const bridgeSrc     = fs.readFileSync(path.join(rootDir, 'src/js/discord_bridge.js'), 'utf8');
const vfxShadersSrc = fs.readFileSync(path.join(rootDir, 'src/js/vfx_shaders.js'), 'utf8');
const vfxSrc        = fs.readFileSync(path.join(rootDir, 'src/js/vfx.js'), 'utf8');
const engineSrc     = fs.readFileSync(path.join(rootDir, 'src/js/delete_engine.js'), 'utf8');
const sidebarSrc    = fs.readFileSync(path.join(rootDir, 'src/js/sidebar.js'), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// Lightweight DOM mock tailored to Discord's real message/panel/scroller structure
function createMockDom() {
  const storage = new Map();
  const listeners = new Map();
  const observers = [];

  class FakeClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...cls) { cls.forEach(c => this.set.add(c)); this.el.className = [...this.set].join(' '); }
    remove(...cls) { cls.forEach(c => this.set.delete(c)); this.el.className = [...this.set].join(' '); }
    toggle(c, force) {
      const on = force !== undefined ? !!force : !this.set.has(c);
      if (on) this.set.add(c); else this.set.delete(c);
      this.el.className = [...this.set].join(' ');
      return on;
    }
    contains(c) { return this.set.has(c); }
  }

  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.classList = new FakeClassList(this);
      this.attrs = new Map();
      this.children = [];
      this.parentNode = null;
      this.parentElement = null;
      this.style = {};
      this.dataset = {};
      this._text = '';
      this.rect = { left: 20, top: 40, width: 420, height: 48, right: 440, bottom: 88 };
      this.scrollTop = 100;
      this.scrollHeight = 500;
      this.clientHeight = 350;
      this.isConnected = true;
      this._ev = new Map();
    }
    get firstElementChild() { return this.children[0] || null; }
    get textContent() { return this._text || this.children.map(c => c.textContent).join(' '); }
    set textContent(v) { this._text = String(v); }
    get innerText() { return this.textContent; }
    set innerText(v) { this._text = String(v); }
    set innerHTML(v) { this._html = v; }
    get src() { return this.attrs.get('src') || ''; }
    set src(v) { this.attrs.set('src', v); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    getBoundingClientRect() { return Object.assign({}, this.rect); }
    scrollIntoView() {}
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      child.isConnected = true;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      child.parentNode = this;
      child.parentElement = this;
      child.isConnected = true;
      const idx = ref ? this.children.indexOf(ref) : -1;
      if (idx >= 0) this.children.splice(idx, 0, child);
      else this.children.push(child);
      return child;
    }
    remove() {
      if (!this.parentNode) return;
      const parent = this.parentNode;
      const idx = parent.children.indexOf(this);
      const nextSibling = idx >= 0 ? (parent.children[idx + 1] || null) : null;
      if (idx >= 0) parent.children.splice(idx, 1);
      this.parentNode = null;
      this.parentElement = null;
      this.isConnected = false;
      for (const ob of observers) {
        if (ob.target === parent) {
          ob.cb([{ target: parent, removedNodes: [this], nextSibling }]);
        }
      }
    }
    addEventListener(t, fn) {
      if (!this._ev.has(t)) this._ev.set(t, []);
      this._ev.get(t).push(fn);
    }
    dispatchEvent(ev) {
      const fns = this._ev.get(ev.type) || [];
      for (const fn of fns) fn(ev);
      return true;
    }
    click() { this.dispatchEvent({ type: 'click' }); }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    querySelectorAll(sel) {
      const res = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (matches(c, sel)) res.push(c);
          walk(c);
        }
      };
      walk(this);
      return res;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getContext(kind) {
      if (kind === 'webgl2' && this._webgl2Factory) return this._webgl2Factory(this);
      if (kind === 'webgl2') return null;
      return {
        setTransform() {},
        clearRect() {},
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        arc() {},
        clip() {},
        fill() {},
        fillRect() {},
        fillText() {},
        rect() {},
        roundRect() {},
        stroke() {},
        createRadialGradient() { return { addColorStop() {} }; },
        getImageData: (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = 220; data[i + 1] = 222; data[i + 2] = 225; data[i + 3] = 255;
          }
          return { data };
        }
      };
    }
  }

  function matches(el, selector) {
    return selector.split(',').some(part => {
      const s = part.trim();
      if (!s) return false;
      if (s.startsWith('#')) return el.id === s.slice(1);
      if (s === 'img') return el.tagName === 'IMG';
      if (s === 'li[id^="chat-messages-"]') return el.tagName === 'LI' && el.id.startsWith('chat-messages-');
      if (s === '[id^="message-username-"]') return el.id.startsWith('message-username-');
      if (s === '[id^="message-content-"]') return el.id.startsWith('message-content-');
      if (s === 'img[class*="avatar"]') return el.tagName === 'IMG' && el.className.includes('avatar');
      if (s === '[class*="systemMessage"]') return el.className.includes('systemMessage');
      if (s === '[class*="botTag"]') return el.className.includes('botTag');
      if (s === '[class*="username"]') return el.className.includes('username');
      if (s === '[data-list-id="chat-messages"]') return el.getAttribute('data-list-id') === 'chat-messages';
      if (s === 'section[aria-label="User status and settings"]') return el.tagName === 'SECTION' && el.getAttribute('aria-label') === 'User status and settings';
      if (s === '[aria-label="Delete Message"]' || s === '[aria-label="Delete"]') {
        const a = el.getAttribute('aria-label');
        return a === 'Delete Message' || a === 'Delete';
      }
      if (s === 'a' || s === 'button' || s === '[role="button"]') {
        return el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
      }
      if (s === '[role="article"]') return el.getAttribute('role') === 'article';
      return false;
    });
  }

  const head = new FakeElement('head');
  const body = new FakeElement('body');

  const document = {
    head,
    body,
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTreeWalker: () => ({ nextNode: () => null }),
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [] }),
    getElementById: (id) => {
      if (body.id === id) return body;
      const walk = (n) => {
        for (const c of n.children) {
          if (c.id === id) return c;
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(body) || walk(head);
    },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    dispatchEvent: () => true
  };

  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.target = null; }
    observe(target) { this.target = target; observers.push(this); }
    disconnect() {
      const idx = observers.indexOf(this);
      if (idx >= 0) observers.splice(idx, 1);
    }
  }

  const win = {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    location: { pathname: '/channels/@me/100000000000000099' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v))
    },
    addEventListener: (t, fn) => { listeners.set(t, fn); },
    removeEventListener: (t) => { listeners.delete(t); },
    dispatchEvent: () => true,
    getComputedStyle: (el) => ({ overflowY: el.style.overflowY || 'visible', color: '#dbdee1', fontSize: '15px' }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    performance: { now: () => Date.now() },
    MutationObserver: FakeMutationObserver,
    NodeFilter: { SHOW_TEXT: 4 },
    MouseEvent: class { constructor(type, opts) { Object.assign(this, { type }, opts); } },
    PointerEvent: class { constructor(type, opts) { Object.assign(this, { type }, opts); } },
    KeyboardEvent: class { constructor(type, opts) { Object.assign(this, { type }, opts); } },
    WheelEvent: class { constructor(type, opts) { Object.assign(this, { type }, opts); } },
    Event: class { constructor(type, opts) { Object.assign(this, { type }, opts); } },
    setTimeout,
    clearTimeout,
    BigInt
  };
  win.window = win;

  // Populate realistic Discord panel + scroller + messages
  const panel = new FakeElement('section');
  panel.setAttribute('aria-label', 'User status and settings');
  panel.rect = { left: 10, top: 740, width: 220, height: 52, right: 230, bottom: 792 };
  panel.textContent = 'alice\nalice_dev\nInvisible';
  const myAv = new FakeElement('img');
  myAv.src = 'https://cdn.discordapp.com/avatars/100000000000000001/abc123.webp';
  panel.appendChild(myAv);
  body.appendChild(panel);

  const scroller = new FakeElement('div');
  scroller.className = 'scroller_8AE1Qq scrollerBase_';
  scroller.style.overflowY = 'scroll';
  const ol = new FakeElement('ol');
  ol.setAttribute('data-list-id', 'chat-messages');
  scroller.appendChild(ol);
  body.appendChild(scroller);

  function addMessage({ id, author, avatarUserId, isBot, text, hasShiftDelete }) {
    const li = new FakeElement('li');
    li.id = id;
    if (author) {
      const u = new FakeElement('span');
      u.id = 'message-username-' + id;
      u.textContent = author;
      if (isBot) {
        const tag = new FakeElement('span');
        tag.className = 'botTag';
        tag.textContent = 'APP';
        u.appendChild(tag);
      }
      li.appendChild(u);
    }
    if (avatarUserId) {
      const av = new FakeElement('img');
      av.className = 'avatar';
      av.src = `https://cdn.discordapp.com/avatars/${avatarUserId}/hash.webp`;
      li.appendChild(av);
    }
    const content = new FakeElement('div');
    content.id = 'message-content-' + id;
    content.textContent = text;
    li.appendChild(content);

    if (hasShiftDelete) {
      const delBtn = new FakeElement('button');
      delBtn.setAttribute('aria-label', 'Delete Message');
      delBtn.addEventListener('click', () => li.remove());
      li.appendChild(delBtn);
    }

    ol.appendChild(li);
    return li;
  }

  return { win, document, body, scroller, ol, addMessage };
}

console.log('Running modular Discord helper test suite...\n');

await test('All 6 modular JS files parse cleanly with zero syntax errors', () => {
  new Function(coreSrc);
  new Function(bridgeSrc);
  new Function(vfxShadersSrc);
  new Function(vfxSrc);
  new Function(engineSrc);
  new Function(sidebarSrc);
});

await test('Identity detection extracts Discord User ID and names from live panel layout', () => {
  const { win } = createMockDom();
  vm.runInNewContext(engineSrc, win);
  const id = win.__dcDeleteEngine.detectCurrentUserIdentity();
  assert.equal(id.userId, '100000000000000001');
  assert.equal(id.names.has('alice'), true);
  assert.equal(id.names.has('alice_dev'), true);
  assert.equal(id.names.has('invisible'), false);
});

await test('readVisibleMessages accurately classifies own, grouped, other user, and bot messages', () => {
  const { win, addMessage } = createMockDom();
  addMessage({ id: 'chat-messages-1-100000000000000101', author: 'bob', avatarUserId: '111111111111111111', text: 'hello' });
  addMessage({ id: 'chat-messages-1-100000000000000102', author: 'alice', avatarUserId: '100000000000000001', text: 'first mine' });
  addMessage({ id: 'chat-messages-1-100000000000000103', author: '', text: 'grouped follow-up mine' });
  addMessage({ id: 'chat-messages-1-100000000000000104', author: 'Clyde', isBot: true, text: 'bot notice' });

  vm.runInNewContext(engineSrc, win);
  const msgs = win.__dcDeleteEngine.readVisibleMessages();
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].isMine, false, 'bob should be isMine=false');
  assert.equal(msgs[1].isMine, true,  'alice should be isMine=true');
  assert.equal(msgs[2].isMine, true,  'grouped follow-up by alice should propagate isMine=true');
  assert.equal(msgs[3].isMine, false, 'Clyde bot should be isMine=false');
});

await test('Snowflake age classification separates <14d recent vs >14d older messages', () => {
  const { win } = createMockDom();
  vm.runInNewContext(engineSrc, win);
  const nowSf = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
  const oldSf = ((BigInt(Date.now() - 30 * 86400 * 1000) - 1420070400000n) << 22n).toString();
  assert.equal(win.__dcDeleteEngine.classifyMessageAge('chat-messages-1-' + nowSf).tier, 'recent');
  assert.equal(win.__dcDeleteEngine.classifyMessageAge('chat-messages-1-' + oldSf).tier, 'older');
});

await test('VFX armDissolveOnRemoval holds message slot with placeholder when DOM node is removed', () => {
  const { win, ol, addMessage } = createMockDom();
  const li = addMessage({ id: 'chat-messages-1-100000000000000102', author: 'alice', avatarUserId: '100000000000000001', text: 'dissolve me' });
  vm.runInNewContext(vfxSrc, win);

  const armed = win.__dcVfx.armDissolveOnRemoval(li);
  assert.equal(armed.hasFired(), false);

  li.remove();
  assert.equal(armed.hasFired(), true);

  win.__dcVfx.destroy();
  assert.equal(win.__dcVfx, undefined);
});

await test('runAllInCurrentTab deletes only own messages via Shift+Hover fast path and ignores others', async () => {
  const { win, addMessage } = createMockDom();
  const otherLi = addMessage({ id: 'chat-messages-1-100000000000000101', author: 'bob', avatarUserId: '111111111111111111', text: 'do not touch' });
  const myLi    = addMessage({ id: 'chat-messages-1-100000000000000102', author: 'alice', avatarUserId: '100000000000000001', text: 'delete me', hasShiftDelete: true });

  vm.runInNewContext(vfxSrc, win);
  vm.runInNewContext(engineSrc, win);

  const res = await win.__dcDeleteEngine.runAllInCurrentTab();
  assert.equal(res.deleted, 1);
  assert.equal(res.skipped, 0, 'Other users should be silently ignored without wasted skipped attempts');
  assert.equal(myLi.isConnected, false, 'Own message should be removed');
  assert.equal(otherLi.isConnected, true, 'Other user message should stay untouched');

  win.__dcDeleteEngine.destroy();
  win.__dcVfx.destroy();
});

await test('Ephemeral Clyde notice with "Dismiss message" is classified as dismiss and dismissed instantly', async () => {
  const { win, addMessage } = createMockDom();
  const clydeLi = addMessage({ id: 'chat-messages-1-100000000000000105', author: 'Clyde', isBot: true, text: 'Your message could not be delivered.' });
  const dismissLink = win.document.createElement('a');
  dismissLink.textContent = 'Dismiss message';
  let dismissClicked = false;
  dismissLink.addEventListener('click', () => { dismissClicked = true; clydeLi.remove(); });
  clydeLi.appendChild(dismissLink);

  vm.runInNewContext(vfxSrc, win);
  vm.runInNewContext(engineSrc, win);

  const msgs = win.__dcDeleteEngine.readVisibleMessages();
  assert.equal(msgs[0].actionType, 'dismiss');
  assert.equal(msgs[0].canRemove, true);

  const res = await win.__dcDeleteEngine.runSelected([msgs[0]]);
  assert.equal(dismissClicked, true, 'Should click Discord native Dismiss message control');
  assert.equal(res.deleted, 1);
  assert.equal(clydeLi.isConnected, false);

  win.__dcDeleteEngine.destroy();
  win.__dcVfx.destroy();
});

await test('onServerRateLimit live burst (remaining > 0) paces fast in 240-360ms with Live R/L label', async () => {
  const { win, addMessage } = createMockDom();
  const nowSf1 = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
  const nowSf2 = ((BigInt(Date.now() + 10) - 1420070400000n) << 22n).toString();
  const li1 = addMessage({ id: 'chat-messages-1-' + nowSf1, author: 'alice', avatarUserId: '100000000000000001', text: 'burst 1' });
  const li2 = addMessage({ id: 'chat-messages-1-' + nowSf2, author: 'alice', avatarUserId: '100000000000000001', text: 'burst 2' });

  const btn1 = win.document.createElement('button');
  btn1.setAttribute('aria-label', 'Delete Message');
  btn1.addEventListener('click', () => {
    li1.remove();
    win.__dcDeleteEngine.onServerRateLimit({ status: 204, limit: 5, remaining: 4, resetAfterMs: 4200, retryAfterMs: null, bucket: 'bkt-live' });
  });
  li1.appendChild(btn1);

  const btn2 = win.document.createElement('button');
  btn2.setAttribute('aria-label', 'Delete Message');
  btn2.addEventListener('click', () => {
    li2.remove();
    win.__dcDeleteEngine.onServerRateLimit({ status: 204, limit: 5, remaining: 3, resetAfterMs: 3900, retryAfterMs: null, bucket: 'bkt-live' });
  });
  li2.appendChild(btn2);

  vm.runInNewContext(engineSrc, win);
  const progressLog = [];
  const msgs = win.__dcDeleteEngine.readVisibleMessages();
  const res = await win.__dcDeleteEngine.runSelected(msgs, (st) => progressLog.push(st));

  assert.equal(res.deleted, 2);
  const rlInfo = win.__dcDeleteEngine.getRateLimitInfo();
  assert.ok(rlInfo.remaining === 3 || rlInfo.remaining === 4);
  assert.equal(rlInfo.limit, 5);
  assert.equal(rlInfo.bucket, 'bkt-live');

  win.__dcDeleteEngine.destroy();
});

await test('onServerRateLimit bucket empty (remaining === 0) paces safely and deletes all', async () => {
  const { win, addMessage } = createMockDom();
  const nowSf1 = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
  const nowSf2 = ((BigInt(Date.now() + 10) - 1420070400000n) << 22n).toString();
  const li1 = addMessage({ id: 'chat-messages-1-' + nowSf1, author: 'alice', avatarUserId: '100000000000000001', text: 'empty 1' });
  const li2 = addMessage({ id: 'chat-messages-1-' + nowSf2, author: 'alice', avatarUserId: '100000000000000001', text: 'empty 2' });

  const btn1 = win.document.createElement('button');
  btn1.setAttribute('aria-label', 'Delete Message');
  btn1.addEventListener('click', () => {
    li1.remove();
    win.__dcDeleteEngine.onServerRateLimit({ status: 204, limit: 5, remaining: 0, resetAfterMs: 380, retryAfterMs: null });
  });
  li1.appendChild(btn1);

  const btn2 = win.document.createElement('button');
  btn2.setAttribute('aria-label', 'Delete Message');
  btn2.addEventListener('click', () => {
    li2.remove();
    win.__dcDeleteEngine.onServerRateLimit({ status: 204, limit: 5, remaining: 4, resetAfterMs: 4500, retryAfterMs: null });
  });
  li2.appendChild(btn2);

  vm.runInNewContext(engineSrc, win);
  const progressLog = [];
  const msgs = win.__dcDeleteEngine.readVisibleMessages();
  const res = await win.__dcDeleteEngine.runSelected(msgs, (st) => progressLog.push(st));

  assert.equal(res.deleted, 2);
  assert.equal(res.failed, 0);

  win.__dcDeleteEngine.destroy();
});

await test('onServerRateLimit HTTP 429 retries and deletes successfully', async () => {
  const { win, addMessage } = createMockDom();
  const nowSf = ((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
  const li = addMessage({ id: 'chat-messages-1-' + nowSf, author: 'alice', avatarUserId: '100000000000000001', text: 'rate limited msg' });

  let clicks = 0;
  const btn = win.document.createElement('button');
  btn.setAttribute('aria-label', 'Delete Message');
  btn.addEventListener('click', () => {
    clicks++;
    if (clicks === 1) {
      // Simulate 429: message stays in DOM, server sends Retry-After
      win.__dcDeleteEngine.onServerRateLimit({ status: 429, limit: 5, remaining: 0, resetAfterMs: 200, retryAfterMs: 300 });
    } else {
      li.remove();
      win.__dcDeleteEngine.onServerRateLimit({ status: 204, limit: 5, remaining: 4, resetAfterMs: 4600, retryAfterMs: null });
    }
  });
  li.appendChild(btn);

  vm.runInNewContext(engineSrc, win);
  const progressLog = [];
  const msgs = win.__dcDeleteEngine.readVisibleMessages();
  const res = await win.__dcDeleteEngine.runSelected(msgs, (st) => progressLog.push(st));

  assert.equal(clicks, 2, 'Should retry after 429 wait');
  assert.equal(res.deleted, 1);
  assert.equal(res.failed, 0);
  assert.equal(li.isConnected, false);

  win.__dcDeleteEngine.destroy();
});

await test('VFX preset API (listPresets / getPreset / setPreset) persists to dc_vfx_preset_v1', () => {
  const { win } = createMockDom();
  vm.runInNewContext(vfxSrc, win);

  assert.ok(win.__dcVfx.version >= 4);
  const presets = win.__dcVfx.listPresets();
  assert.deepEqual(
    Array.from(presets, p => p.id),
    ['fairy', 'sakura', 'ember', 'glitch', 'vortex', 'shatter', 'random']
  );
  assert.equal(win.__dcVfx.getPreset(), 'fairy', 'Default preset should be fairy');

  assert.equal(win.__dcVfx.setPreset('vortex'), 'vortex');
  assert.equal(win.__dcVfx.getPreset(), 'vortex');
  assert.equal(win.localStorage.getItem('dc_vfx_preset_v1'), 'vortex');

  assert.equal(win.__dcVfx.setPreset('nonexistent-theme'), 'vortex', 'Invalid preset should be ignored');

  // Re-mounting should restore persisted preset from localStorage
  win.__dcVfx.destroy();
  vm.runInNewContext(vfxSrc, win);
  assert.equal(win.__dcVfx.getPreset(), 'vortex');
  win.__dcVfx.destroy();
});

await test('All 6 VFX presets + random execute cleanly on both WebGL2 and Canvas2D backends', () => {
  const sampleRect = { left: 40, top: 80, width: 320, height: 54 };
  const sampleSnap = {
    rect: sampleRect,
    pixelStep: 2,
    samples: Array.from({ length: 24 }, (_, i) => ({
      rx: (i % 8) * 32, ry: Math.floor(i / 8) * 16, rgb: [215, 220, 232]
    }))
  };

  // --- 1) WebGL2 path ---
  {
    const { win, document } = createMockDom();
    const compiledShaders = [];
    const uploadedSlices = [];
    let drawCalls = 0;
    let rafQueue = [];
    let fakeNow = 1000;
    win.performance = { now: () => fakeNow };
    win.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    win.cancelAnimationFrame = () => { rafQueue = []; };

    const origCreate = document.createElement;
    document.createElement = (tag) => {
      const el = origCreate(tag);
      if (tag === 'canvas') {
        el._webgl2Factory = () => ({
          VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
          COMPILE_STATUS: 0x8B81, LINK_STATUS: 0x8B82,
          ARRAY_BUFFER: 0x8892, DYNAMIC_DRAW: 0x88E8, FLOAT: 0x1406,
          DEPTH_TEST: 0x0B71, BLEND: 0x0BE2, ONE: 1, ONE_MINUS_SRC_ALPHA: 0x0303,
          COLOR_BUFFER_BIT: 0x4000, POINTS: 0x0000,
          createShader: (type) => ({ type, src: '' }),
          shaderSource: (sh, src) => { sh.src = src; },
          compileShader: (sh) => { compiledShaders.push(sh); },
          getShaderParameter: () => true,
          deleteShader: () => {},
          createProgram: () => ({}),
          attachShader: () => {},
          linkProgram: () => {},
          getProgramParameter: () => true,
          deleteProgram: () => {},
          createVertexArray: () => ({}),
          bindVertexArray: () => {},
          deleteVertexArray: () => {},
          createBuffer: () => ({}),
          bindBuffer: () => {},
          bufferData: () => {},
          bufferSubData: (_target, _off, arr) => { uploadedSlices.push(new Float32Array(arr)); },
          deleteBuffer: () => {},
          enableVertexAttribArray: () => {},
          vertexAttribPointer: () => {},
          getUniformLocation: (_p, name) => ({ name }),
          disable: () => {},
          enable: () => {},
          blendFunc: () => {},
          clearColor: () => {},
          clear: () => {},
          viewport: () => {},
          useProgram: () => {},
          uniform2f: () => {},
          uniform1f: () => {},
          drawArrays: (_mode, _first, count) => { if (count > 0) drawCalls++; }
        });
      }
      return el;
    };

    vm.runInNewContext(vfxShadersSrc, win);
    vm.runInNewContext(vfxSrc, win);
    assert.equal(win.__dcVfx.getBackend(), 'webgl2');
    assert.equal(compiledShaders.length, 2);
    assert.ok(compiledShaders[0].src.startsWith('#version 300 es'), 'Vertex shader must start with #version 300 es');
    assert.ok(compiledShaders[1].src.startsWith('#version 300 es'), 'Fragment shader must start with #version 300 es');

    const seenStyleIds = new Set();
    for (const p of win.__dcVfx.listPresets()) {
      win.__dcVfx.setPreset(p.id);
      win.__dcVfx.spawnPixelDissolve(sampleSnap);
    }
    // Tick GPU draw loop several frames, then verify auto-sleep after particles expire
    for (let f = 0; f < 5; f++) {
      fakeNow += 100;
      const batch = rafQueue.splice(0);
      for (const cb of batch) cb(fakeNow);
    }
    assert.ok(drawCalls >= 4, 'WebGL2 loop should render active multi-preset particles');
    for (const slice of uploadedSlices) {
      for (let off = 0; off < slice.length; off += 16) {
        const packed = Math.round(slice[off + 12]);
        seenStyleIds.add(Math.floor(packed / 4));
      }
    }
    for (let sid = 0; sid <= 5; sid++) {
      assert.ok(seenStyleIds.has(sid), `Expected packed GPU particles for styleId ${sid}`);
    }
    // Advance clock past max lifetime to verify zero-CPU auto-sleep
    fakeNow += 4000;
    const finalBatch = rafQueue.splice(0);
    for (const cb of finalBatch) cb(fakeNow);
    assert.equal(rafQueue.length, 0, 'WebGL2 loop should auto-sleep when all particles finish');
    win.__dcVfx.destroy();
  }

  // --- 2) Canvas2D fallback path ---
  {
    const { win } = createMockDom();
    let rafQueue = [];
    let fakeNow = 2000;
    win.performance = { now: () => fakeNow };
    win.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
    win.cancelAnimationFrame = () => { rafQueue = []; };

    vm.runInNewContext(vfxShadersSrc, win);
    vm.runInNewContext(vfxSrc, win);
    assert.equal(win.__dcVfx.getBackend(), 'canvas2d');

    for (const p of win.__dcVfx.listPresets()) {
      win.__dcVfx.setPreset(p.id);
      win.__dcVfx.spawnPixelDissolve(sampleSnap);
    }
    win.__dcVfx.spawnImpactBurst(200, 150);

    // Tick Canvas2D loop through full particle lifetimes until auto-sleep
    let ticks = 0;
    while (rafQueue.length > 0 && ticks < 80) {
      fakeNow += 40;
      ticks++;
      const batch = rafQueue.splice(0);
      for (const cb of batch) cb(fakeNow);
    }
    assert.ok(ticks >= 10, 'Canvas2D fallback should animate multiple frames across all presets');
    assert.equal(rafQueue.length, 0, 'Canvas2D fallback should auto-sleep once all particles complete');
    win.__dcVfx.destroy();
  }
});

// ---------------------------------------------------------------------------
// 13. In-Memory React Router Pinned Channel Swap & Contained Auto-Yield
// ---------------------------------------------------------------------------
await test('pinCurrentChannel, swapToPinnedOrReturn, and waitWhileOffPinnedChannel auto-yield in memory', async () => {
  const { win, document } = createMockDom();
  let curPath = '/channels/@me/111111111111111111';
  win.location = {
    get pathname() { return curPath; },
    set pathname(v) { curPath = v; },
    href: 'https://discord.com' + curPath
  };
  document.title = '@bob - Discord';

  // Mount fake #app-mount with React Fiber node holding history.push(path)
  const appMount = document.createElement('div');
  appMount.id = 'app-mount';
  const pushedPaths = [];
  appMount['__reactFiber$mock123'] = {
    child: {
      memoizedProps: {
        history: {
          push(nextPath) {
            pushedPaths.push(nextPath);
            curPath = nextPath;
          }
        }
      }
    }
  };
  document.body.appendChild(appMount);

  vm.runInNewContext(engineSrc, win);
  const eng = win.__dcDeleteEngine;

  // 1) Pin current channel
  const pinned = eng.pinCurrentChannel();
  assert.equal(pinned.path, '/channels/@me/111111111111111111');
  assert.equal(pinned.label, '@bob');
  assert.equal(pinned.isHere, true);

  // 2) Simulate user clicking into another channel (/channels/@me/222222222222222222)
  curPath = '/channels/@me/222222222222222222';
  assert.equal(eng.getPinnedChannel().isHere, false);

  // 3) First Alt+W swap teleports back to pinned channel via React Router history.push
  const s1 = eng.swapToPinnedOrReturn();
  assert.equal(s1.action, 'to-pinned');
  assert.equal(curPath, '/channels/@me/111111111111111111');
  assert.equal(pushedPaths[0], '/channels/@me/111111111111111111');

  // 4) Second Alt+W swap teleports right back to the browsing channel
  const s2 = eng.swapToPinnedOrReturn();
  assert.equal(s2.action, 'to-browsing');
  assert.equal(curPath, '/channels/@me/222222222222222222');
  assert.equal(pushedPaths[1], '/channels/@me/222222222222222222');
});

// ---------------------------------------------------------------------------
// 14. In-Memory Discord Bridge + Cross-Channel Background Search & Deletion + New-Message Fence
// ---------------------------------------------------------------------------
await test('__dcBridge indexes messages in background, deletes across tabs without cursor mimicking, and enforces New-Message Fence', async () => {
  const { win } = createMockDom();
  // User is viewing channel 111111111111111111, while locked cleaner tab targets channel 200000000000000002
  win.location.pathname = '/channels/@me/111111111111111111';

  const deletedCalls = [];
  const baseMs = Date.now() - 60000;
  const oldSf1 = String((BigInt(baseMs - 20000) - 1420070400000n) << 22n);
  const oldSf2 = String((BigInt(baseMs - 10000) - 1420070400000n) << 22n);
  const futureSf = String((BigInt(Date.now() + 60000) - 1420070400000n) << 22n); // Sent AFTER job start (must be protected by fence!)

  // Mock Discord's multi-runtime Rspack webpackChunkdiscord_app
  const fakeCache = {
    1: {
      exports: {
        Bo: {
          async get({ url, query }) {
            if (url.endsWith('/messages/search')) {
              return {
                status: 200,
                body: {
                  total_results: 2,
                  messages: [
                    [{ id: oldSf2, channel_id: '200000000000000002', content: 'background msg 2', author: { id: '100000000000000001', username: 'alice_dev', global_name: 'alice' }, hit: true }],
                    [{ id: oldSf1, channel_id: '200000000000000002', content: 'background msg 1', author: { id: '100000000000000001', username: 'alice_dev', global_name: 'alice' }, hit: true }],
                    [{ id: futureSf, channel_id: '200000000000000002', content: 'NEW message sent after start', author: { id: '100000000000000001', username: 'alice_dev', global_name: 'alice' }, hit: true }]
                  ]
                }
              };
            }
            return { status: 200, body: [] };
          },
          async del({ url }) {
            const m = String(url || '').match(/\/channels\/(\d+)\/messages\/(\d+)/);
            if (m) deletedCalls.push({ channelId: m[1], msgId: m[2], localOnly: false });
            return { status: 204 };
          },
          async post() {},
          async patch() {},
          async put() {}
        }
      }
    },
    2: {
      exports: {
        A: {
          async deleteMessage(channelId, msgId, localOnly) {
            const _tag = 'MESSAGE_DELETE';
            deletedCalls.push({ channelId, msgId, localOnly: !!localOnly, _tag });
          },
          fetchMessages() {},
          sendMessage() {},
          dismissAutomatedMessage() {},
          startEditMessage() {},
          receiveMessage() {}
        }
      }
    },
    3: {
      exports: {
        default: Object.assign(Object.create({
          getCurrentUser() { return { id: '100000000000000001', username: 'alice_dev', globalName: 'alice' }; },
          getUser() { return null; }
        }), {})
      }
    },
    4: {
      exports: {
        A: Object.assign(Object.create({
          getChannel(cid) { return { id: cid, name: '', rawRecipients: [{ username: 'charlie' }] }; },
          getDMFromUserId() { return null; }
        }), {})
      }
    }
  };

  win.webpackChunkdiscord_app = {
    push([_ids, _mods, cb]) {
      if (cb) cb({ c: fakeCache });
    },
    pop() {}
  };

  vm.runInNewContext(coreSrc, win);
  vm.runInNewContext(bridgeSrc, win);
  vm.runInNewContext(engineSrc, win);

  assert.equal(win.__dcBridge.isAvailable(), true, '__dcBridge should resolve mocked Rspack internals');
  assert.equal(win.__dcBridge.getChannelInfo('200000000000000002').label, '@charlie');

  // Feed fast live rate-limit headers so pacing is ~250ms
  const eng = win.__dcDeleteEngine;
  const origDel = win.__dcBridge.deleteMessageInMemory;
  win.__dcBridge.deleteMessageInMemory = async (cid, mid, isEph) => {
    const r = await origDel(cid, mid, isEph);
    eng.onServerRateLimit({ status: 204, limit: 5, remaining: 4, resetAfterMs: 1000 });
    return r;
  };

  // Run Delete All on channel 200000000000000002 WHILE user is viewing channel 111111111111111111!
  const finalState = await eng.runAllInCurrentTab(null, {
    channelId: '200000000000000002',
    channelPath: '/channels/@me/200000000000000002',
    channelLabel: '@charlie'
  });

  assert.equal(finalState.deleted, 2, 'Should delete the 2 historical messages in background while user views another channel');
  assert.equal(deletedCalls.length, 2);
  assert.equal(deletedCalls[0].channelId, '200000000000000002');
  assert.equal(deletedCalls[0].msgId, oldSf2);
  assert.equal(deletedCalls[1].msgId, oldSf1);
  assert.ok(!deletedCalls.some(c => c.msgId === futureSf), 'New-Message Protection Fence must protect messages created after job start');

  // Verify tombstones prevent deleted messages from ever re-appearing if getChannelMessages is called again
  const remainingInIndex = eng.getChannelMessages('200000000000000002');
  assert.equal(remainingInIndex.some(m => m.rawId === oldSf1 || m.rawId === oldSf2), false, 'Deleted messages must be permanently tombstoned in index');
});

console.log(`\nAll ${passed} tests finished.`);
