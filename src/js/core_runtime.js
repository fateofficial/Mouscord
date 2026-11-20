(function() {
  if (window.__dcCore && window.__dcCore.version === 1) {
    return 'already-mounted';
  }

  // --- 1. Pub/Sub Event Bus Factory ---
  function createBus() {
    const map = new Map();
    const on = (event, fn) => {
      if (!event || typeof fn !== 'function') return () => {};
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => off(event, fn);
    };
    const off = (event, fn) => {
      const s = map.get(event);
      if (s) s.delete(fn);
    };
    const emit = (event, payload) => {
      const s = map.get(event);
      if (!s) return;
      for (const fn of Array.from(s)) {
        try { fn(payload); } catch (e) {}
      }
    };
    const clear = () => map.clear();
    return { on, off, emit, clear };
  }

  // --- 2. Reactive Observable State Store Factory ---
  function createStore(initialState, storageKey) {
    const state = Object.assign({}, initialState || {});
    if (storageKey) {
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const k of Object.keys(state)) {
              if (typeof parsed[k] === typeof state[k]) state[k] = parsed[k];
            }
          }
        }
      } catch (e) {}
    }
    const subs = new Set();
    const get = () => Object.assign({}, state);
    const set = (patch) => {
      if (!patch || typeof patch !== 'object') return get();
      let changed = false;
      for (const k of Object.keys(patch)) {
        if (state[k] !== patch[k]) {
          state[k] = patch[k];
          changed = true;
        }
      }
      if (changed) {
        if (storageKey) {
          try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (e) {}
        }
        const snap = get();
        for (const fn of Array.from(subs)) {
          try { fn(snap); } catch (e) {}
        }
      }
      return get();
    };
    const subscribe = (fn) => {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => subs.delete(fn);
    };
    return { get, set, subscribe };
  }

  // --- 3. Update-Proof Discord Webpack / Rspack Registry (Vencord / BD Pattern) ---
  function getPrimaryRspackCache() {
    const chunks = window.webpackChunkdiscord_app;
    if (!chunks || typeof chunks.push !== 'function') return null;

    let wpRequire = null;
    let maxCacheSize = -1;
    const sym = Symbol('dc_core_wp');
    try {
      chunks.push([[sym], {}, (r) => {
        if (r && r.c && typeof r.c === 'object') {
          const n = Object.keys(r.c).length;
          if (n > maxCacheSize) {
            maxCacheSize = n;
            wpRequire = r;
          }
        }
      }]);
      chunks.pop();
    } catch (e) {
      return null;
    }
    return (wpRequire && wpRequire.c) ? { wpRequire, cache: wpRequire.c, size: maxCacheSize } : null;
  }

  // Guard against Discord's Intl localization Proxy objects (which return `r=>e.get(t,r)` for any property lookup)
  function isIntlProxy(obj, propName) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return false;
    try {
      const fn = propName ? obj[propName] : obj.get;
      if (typeof fn === 'function') {
        const s = String(fn);
        if (s.startsWith('r=>e.get(') || s.startsWith('e=>t.get(')) return true;
      }
    } catch (e) {
      return true;
    }
    return false;
  }

  function walkModuleExports(cacheObj, predicate) {
    if (!cacheObj) return null;
    const mods = Object.values(cacheObj);
    for (let i = 0; i < mods.length; i++) {
      const m = mods[i];
      if (!m || !m.exports) continue;
      const exp = m.exports;
      if (typeof exp !== 'object' && typeof exp !== 'function') continue;

      try {
        if (predicate(exp, 'exports')) return exp;
      } catch (e) {}

      const keys = Object.keys(exp);
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        let v;
        try { v = exp[k]; } catch (e) { continue; }
        if (!v || (typeof v !== 'object' && typeof v !== 'function')) continue;
        try {
          if (predicate(v, k)) return v;
        } catch (e) {}
      }
    }
    return null;
  }

  // Discord never minifies Flux Store names (.getName() === "MessageStore" | "UserStore" | "ChannelStore")
  function findByStoreName(cacheObj, storeName) {
    return walkModuleExports(cacheObj, (v) => {
      if (typeof v.getName === 'function') {
        try {
          if (v.getName() === storeName) return true;
        } catch (e) {}
      }
      const proto = Object.getPrototypeOf(v);
      if (proto && typeof proto.getName === 'function') {
        try {
          if (v.getName() === storeName) return true;
        } catch (e) {}
      }
      return false;
    });
  }

  function findByProps(cacheObj, propNames, codeAnchor) {
    return walkModuleExports(cacheObj, (v) => {
      for (let i = 0; i < propNames.length; i++) {
        const p = propNames[i];
        const proto = Object.getPrototypeOf(v) || {};
        const fn = v[p] !== undefined ? v[p] : proto[p];
        if (typeof fn !== 'function' && fn === undefined) return false;
        if (isIntlProxy(v, p)) return false;
      }
      if (codeAnchor) {
        const anchorFn = v[propNames[0]];
        if (typeof anchorFn !== 'function' || !String(anchorFn).includes(codeAnchor)) {
          return false;
        }
      }
      return true;
    });
  }

  // --- 4. Declarative DOM Hyperscript Helper h(tag, props, ...children) ---
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props && typeof props === 'object') {
      for (const [k, val] of Object.entries(props)) {
        if (val === undefined || val === null || val === false) continue;
        if (k === 'className' || k === 'class') {
          el.className = String(val);
        } else if (k === 'text') {
          el.textContent = String(val);
        } else if (k === 'html') {
          el.innerHTML = String(val);
        } else if (k === 'dataset' && typeof val === 'object') {
          for (const [dk, dv] of Object.entries(val)) {
            if (el.dataset) el.dataset[dk] = String(dv);
          }
        } else if (k === 'style' && typeof val === 'object') {
          Object.assign(el.style, val);
        } else if (k.startsWith('on') && typeof val === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), val);
        } else if (k === 'disabled') {
          el.disabled = !!val;
        } else if (typeof el.setAttribute === 'function') {
          el.setAttribute(k, String(val));
        } else {
          el[k] = val;
        }
      }
    }
    const appendChild = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) {
        for (let i = 0; i < c.length; i++) appendChild(c[i]);
      } else if (typeof c === 'string' || typeof c === 'number') {
        if (typeof document.createTextNode === 'function') {
          el.appendChild(document.createTextNode(String(c)));
        } else {
          el.textContent = (el.textContent || '') + String(c);
        }
      } else {
        el.appendChild(c);
      }
    };
    for (let i = 0; i < children.length; i++) appendChild(children[i]);
    return el;
  }

  const globalBus = createBus();

  window.__dcCore = {
    version: 1,
    bus: globalBus,
    createBus,
    createStore,
    h,
    webpack: {
      getPrimaryRspackCache,
      isIntlProxy,
      walkModuleExports,
      findByStoreName,
      findByProps
    }
  };

  return 'mounted';
})();
