(function() {
  if (window.__dcVfx && window.__dcVfx.version === 5) return 'already-mounted';
  if (window.__dcVfx && typeof window.__dcVfx.destroy === 'function') {
    try { window.__dcVfx.destroy(); } catch (e) {}
  }

  const STYLE_ID = 'dc-vfx-style', CANVAS_ID = 'dc-vfx-canvas', PRESET_KEY = 'dc_vfx_preset_v1';
  const shaderReg = window.__dcVfxShaders || {};
  const PRESETS = shaderReg.PRESETS || [
    { id: 'fairy',   label: 'Fairy Dust',      styleId: 0 },
    { id: 'sakura',  label: 'Sakura Petals',   styleId: 1 },
    { id: 'ember',   label: 'Ember Ash',       styleId: 2 },
    { id: 'glitch',  label: 'Cyber Glitch',    styleId: 3 },
    { id: 'vortex',  label: 'Void Vortex',     styleId: 4 },
    { id: 'shatter', label: 'Crystal Shatter', styleId: 5 },
    { id: 'random',  label: 'Random',          styleId: -1 }
  ];

  const css = `#${CANVAS_ID}{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:99985;}
.dc-vfx-deleting{position:relative!important;border-radius:8px!important;outline:1.5px solid rgba(180,155,255,0.85)!important;outline-offset:-1px!important;background:linear-gradient(105deg,rgba(120,110,255,0.08) 0%,rgba(230,170,255,0.24) 45%,rgba(120,235,255,0.16) 65%,rgba(120,110,255,0.06) 100%)!important;background-size:220% 100%!important;animation:dcVfxShimmer 0.72s linear infinite!important;}
@keyframes dcVfxShimmer{0%{background-position:180% 0;}100%{background-position:-60% 0;}}
.dc-vfx-placeholder{list-style:none!important;pointer-events:none!important;overflow:hidden!important;margin:0!important;padding:0!important;box-sizing:border-box!important;will-change:height,opacity;transition:height 0.38s cubic-bezier(0.22,1,0.36,1),opacity 0.32s ease!important;}
.dc-vfx-skipped{animation:dcVfxShake 0.28s ease!important;outline:1.5px solid rgba(255,160,120,0.6)!important;border-radius:6px!important;}
@keyframes dcVfxShake{0%,100%{transform:translateX(0);}25%{transform:translateX(-4px);}75%{transform:translateX(4px);}}
body.dc-vfx-stealth-menu [role="menu"],body.dc-vfx-stealth-menu [class*="menu_"][role="menu"],body.dc-vfx-stealth-menu [class*="layerContainer_"] [role="dialog"],body.dc-vfx-stealth-menu [class*="backdrop_"]{opacity:0!important;transition:none!important;}`;

  const PALETTES = shaderReg.PALETTES || [
    [[175,188,255],[238,178,255],[135,242,255],[255,232,162],[255,180,218],[255,255,255]],
    [[255,209,224],[255,182,206],[255,234,242],[248,152,186],[255,245,250],[255,196,214]],
    [[255,245,195],[255,175,55],[255,92,24],[225,38,18],[255,210,96],[255,128,42]],
    [[0,245,255],[255,32,168],[130,80,255],[60,255,190],[255,255,255],[0,175,255]],
    [[155,85,255],[95,230,255],[215,110,255],[85,120,255],[245,240,255],[190,140,255]],
    [[210,248,255],[150,224,255],[255,255,255],[195,212,255],[110,200,255],[235,252,255]]
  ];
  const PAL_NORM = PALETTES.map(p => p.map(([r, g, b]) => [r / 255, g / 255, b / 255]));
  const FAIRY_PAL = PALETTES[0], FAIRY_NORM = PAL_NORM[0];
  const packKind = (sid, kind) => sid * 4.0 + kind;

  // --- GLSL ES 3.00 Multi-Shader Dissolve Pipeline (Loaded from modular src/js/vfx_shaders.js) ---
  const VERT_SRC = shaderReg.VERT_SRC || `#version 300 es\nvoid main(){gl_Position=vec4(0.0);}`;
  const FRAG_SRC = shaderReg.FRAG_SRC || `#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(1.0);}`;

  const MAX_GPU = 8000, FPP = 16, BPP = FPP * 4;

  // --- DOM & Module State (declared before init to prevent TDZ) ---
  const styleEl = document.createElement('style');
  styleEl.id = STYLE_ID; styleEl.textContent = css;
  document.head.appendChild(styleEl);

  let canvas = document.createElement('canvas');
  canvas.id = CANVAS_ID;
  document.body.appendChild(canvas);

  let activePreset = 'fairy', lastRandomStyle = -1;
  try {
    const saved = window.localStorage && window.localStorage.getItem(PRESET_KEY);
    if (saved && PRESETS.some(p => p.id === saved)) activePreset = saved;
  } catch (e) {}

  let backend = 'canvas2d', gl = null, glProg = null, glVao = null, glVbo = null;
  let uResLoc = null, uDprLoc = null, uTimeLoc = null;
  let gpuData = null, gpuWriteCursor = 0, gpuActiveCount = 0;
  let gpuEpochMs = 0, gpuMaxEndTime = 0, gpuContextLost = false;
  let gpuDirtyMin = MAX_GPU, gpuDirtyMax = 0;

  let ctx = null, width = 0, height = 0, dpr = 1;
  const particles = [], ripples = [];
  const activePlaceholders = new Set(), activeWatchers = new Set(), activeTimers = new Set();
  let rafId = null, lastTs = 0, activeTargetEl = null;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const rgbaStr = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`;
  const nowMs = () => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? performance.now() : Date.now();
  const listPresets = () => PRESETS.map(({ id, label }) => ({ id, label }));
  const getPreset = () => activePreset;
  function setPreset(id) {
    const f = PRESETS.find(p => p.id === id);
    if (f) {
      activePreset = f.id;
      try { if (window.localStorage) window.localStorage.setItem(PRESET_KEY, activePreset); } catch (e) {}
    }
    return activePreset;
  }
  function resolveStyleId(ov) {
    const f = PRESETS.find(p => p.id === (ov || activePreset));
    if (f && f.styleId >= 0) return f.styleId;
    let sid = Math.floor(Math.random() * 6);
    if (sid === lastRandomStyle) sid = (sid + 1 + Math.floor(Math.random() * 5)) % 6;
    lastRandomStyle = sid;
    return sid;
  }
  function parseCssRgb(str, fb) {
    const m = str && String(str).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fb;
  }
  function scheduleTimer(fn, ms) {
    let tid = null;
    tid = setTimeout(() => { activeTimers.delete(tid); fn(); }, ms);
    activeTimers.add(tid); return tid;
  }

  // --- WebGL2 Initialization ---
  function compileShader(g, type, src) {
    const sh = g.createShader(type); if (!sh) return null;
    g.shaderSource(sh, src); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) { g.deleteShader(sh); return null; }
    return sh;
  }

  function initWebGL2() {
    let g = null;
    try { g = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' }); } catch (e) { return false; }
    if (!g || typeof g.createShader !== 'function' || typeof g.createProgram !== 'function' || typeof g.createBuffer !== 'function' || typeof g.createVertexArray !== 'function') return false;

    let vs = null, fs = null, prog = null, vao = null, vbo = null;
    try {
      vs = compileShader(g, g.VERTEX_SHADER, VERT_SRC);
      fs = compileShader(g, g.FRAGMENT_SHADER, FRAG_SRC);
      if (!vs || !fs) throw new Error('shader');
      prog = g.createProgram(); g.attachShader(prog, vs); g.attachShader(prog, fs); g.linkProgram(prog);
      g.deleteShader(vs); g.deleteShader(fs); vs = fs = null;
      if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error('link');

      vao = g.createVertexArray(); vbo = g.createBuffer();
      gpuData = new Float32Array(MAX_GPU * FPP);
      g.bindVertexArray(vao); g.bindBuffer(g.ARRAY_BUFFER, vbo);
      g.bufferData(g.ARRAY_BUFFER, gpuData.byteLength, g.DYNAMIC_DRAW);
      for (const [loc, sz, off] of [[0,2,0],[1,3,8],[2,3,20],[3,4,32],[4,1,48],[5,3,52]]) {
        g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, sz, g.FLOAT, false, BPP, off);
      }
      g.bindVertexArray(null); g.bindBuffer(g.ARRAY_BUFFER, null);
      uResLoc = g.getUniformLocation(prog, 'uResolution');
      uDprLoc = g.getUniformLocation(prog, 'uDpr');
      uTimeLoc = g.getUniformLocation(prog, 'uTime');
      g.disable(g.DEPTH_TEST); g.enable(g.BLEND); g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
      g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT);
      gl = g; glProg = prog; glVao = vao; glVbo = vbo; backend = 'webgl2';
      return true;
    } catch (e) {
      try { if (vs) g.deleteShader(vs); if (fs) g.deleteShader(fs); if (prog) g.deleteProgram(prog); if (vbo) g.deleteBuffer(vbo); if (vao) g.deleteVertexArray(vao); } catch (err) {}
      gpuData = null;
      try {
        const fresh = document.createElement('canvas'); fresh.id = CANVAS_ID;
        if (canvas.parentNode) { canvas.parentNode.insertBefore(fresh, canvas); canvas.remove(); } else document.body.appendChild(fresh);
        canvas = fresh;
      } catch (err) {}
      return false;
    }
  }

  function onContextLost(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    gpuContextLost = true; gpuActiveCount = gpuWriteCursor = gpuMaxEndTime = 0;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
  }
  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, window.innerWidth || 1); height = Math.max(1, window.innerHeight || 1);
    canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
    if (backend === 'webgl2' && gl && !gpuContextLost) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      if (rafId === null) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    } else if (ctx && typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  if (initWebGL2()) {
    if (canvas && typeof canvas.addEventListener === 'function') canvas.addEventListener('webglcontextlost', onContextLost, false);
  } else { ctx = canvas.getContext('2d', { alpha: true }); backend = 'canvas2d'; }
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // --- GPU Ring Buffer & Render Loop ---
  function gpuNowSec() {
    const tMs = nowMs();
    if (gpuActiveCount === 0) { gpuEpochMs = tMs; gpuMaxEndTime = gpuWriteCursor = gpuDirtyMax = 0; gpuDirtyMin = MAX_GPU; return 0; }
    return Math.max(0, (tMs - gpuEpochMs) * 0.001);
  }
  function pushGpu(x, y, r, g, b, mag, st, life, sz, pk, vx, vy, vz) {
    const idx = gpuWriteCursor, o = idx * FPP;
    gpuData[o] = x; gpuData[o+1] = y; gpuData[o+2] = r; gpuData[o+3] = g; gpuData[o+4] = b;
    gpuData[o+5] = mag[0]; gpuData[o+6] = mag[1]; gpuData[o+7] = mag[2];
    gpuData[o+8] = st; gpuData[o+9] = life; gpuData[o+10] = sz; gpuData[o+11] = Math.random();
    gpuData[o+12] = pk; gpuData[o+13] = vx; gpuData[o+14] = vy; gpuData[o+15] = vz;
    if (idx < gpuDirtyMin) gpuDirtyMin = idx;
    if (idx + 1 > gpuDirtyMax) gpuDirtyMax = idx + 1;
    gpuWriteCursor = (idx + 1) % MAX_GPU;
    if (gpuActiveCount < MAX_GPU) gpuActiveCount++;
    if (st + life > gpuMaxEndTime) gpuMaxEndTime = st + life;
  }
  function startLoop() {
    if (rafId !== null) return;
    if (backend === 'webgl2') { if (gl && !gpuContextLost) rafId = requestAnimationFrame(tickWebGL2); }
    else { lastTs = nowMs(); rafId = requestAnimationFrame(tickCanvas2D); }
  }
  function tickWebGL2() {
    if (!gl || gpuContextLost) { rafId = null; return; }
    const tSec = Math.max(0, (nowMs() - gpuEpochMs) * 0.001);
    if (gpuActiveCount === 0 || tSec > gpuMaxEndTime + 0.06) {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gpuActiveCount = gpuWriteCursor = gpuMaxEndTime = gpuDirtyMax = 0; gpuDirtyMin = MAX_GPU;
      rafId = null; return;
    }
    if (gpuDirtyMin < gpuDirtyMax) {
      gl.bindBuffer(gl.ARRAY_BUFFER, glVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, gpuDirtyMin * BPP, gpuData.subarray(gpuDirtyMin * FPP, gpuDirtyMax * FPP));
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gpuDirtyMin = MAX_GPU; gpuDirtyMax = 0;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(glProg);
    gl.uniform2f(uResLoc, width, height); gl.uniform1f(uDprLoc, dpr); gl.uniform1f(uTimeLoc, tSec);
    gl.bindVertexArray(glVao); gl.drawArrays(gl.POINTS, 0, gpuActiveCount); gl.bindVertexArray(null);
    rafId = requestAnimationFrame(tickWebGL2);
  }

  // --- Canvas2D Fallback Renderer (all 6 themes) ---
  function drawPoly(x, y, rot, sx, pts) {
    if (!ctx.translate || !ctx.rotate || !ctx.moveTo || !ctx.lineTo) { ctx.fillRect(x - 2, y - 2, 4, 4); return; }
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
    if (sx !== 1 && ctx.scale) ctx.scale(sx, 1);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) { if (i === 0) ctx.moveTo(pts[i], pts[i + 1]); else ctx.lineTo(pts[i], pts[i + 1]); }
    if (ctx.closePath) ctx.closePath();
    ctx.fill(); ctx.restore();
  }
  const drawStar = (x, y, r, rot) => {
    const pts = [];
    for (let i = 0; i < 8; i++) { const a = (i * Math.PI) / 4, d = (i % 2 === 0) ? r : r * 0.28; pts.push(Math.cos(a) * d, Math.sin(a) * d); }
    drawPoly(x, y, rot, 1, pts);
  };
  const drawPetal = (x, y, r, rot, roll) => drawPoly(x, y, rot, 0.45 + 0.55 * Math.abs(Math.cos(roll)),
    [0, r * 0.72, -r * 0.55, 0, -r * 0.36, -r * 0.68, 0, -r * 0.36, r * 0.36, -r * 0.68, r * 0.55, 0]);
  const drawShard = (x, y, r, rot) => drawPoly(x, y, rot, 1, [0, -r, r * 0.48, 0, 0, r, -r * 0.42, r * 0.15]);
  const lerpRgb = (a, b, m) => {
    const k = Math.max(0, Math.min(1, m));
    return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
  };

  function tickCanvas2D(ts) {
    if (!ctx) { rafId = null; return; }
    const dt = Math.min(0.05, Math.max(0.001, (ts - lastTs) / 1000)); lastTs = ts;
    ctx.clearRect(0, 0, width, height);

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      if (p.delay > 0) {
        p.delay -= dt;
        if (p.kind === 'pixel') { ctx.fillStyle = rgbaStr(p.rgb, p.maxAlpha); ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size); }
        continue;
      }
      p.age += dt; const t = p.age / p.life;
      if (t >= 1) { particles.splice(i, 1); continue; }

      if (p.style === 4 && p.cx !== undefined) {
        const pull = Math.pow(Math.max(t, 0.0001), 1.55);
        const r = p.r0 * Math.exp(-3.4 * pull) * (1 - Math.max(0, (t - 0.78) / 0.22));
        const th = p.ang0 + p.swirlSpeed * (p.age * 0.85 + 1.8 * pull * pull);
        p.x = p.cx + Math.cos(th) * r; p.y = p.cy + Math.sin(th) * r; p.rot = th + Math.PI * 0.5;
      } else if (p.style === 3) {
        const qs = Math.floor(p.age * 18), qa = qs / 18, rt = Math.max(0, qa - 0.1);
        p.x = p.sx + Math.sin(p.phase + qs * 1.9) * (1 - Math.min(1, t * 1.6)) * 24 + p.vx * qa * 0.45;
        p.y = p.sy + p.vy * rt + 0.5 * p.gravity * rt * rt;
      } else {
        p.vx = (p.vx + Math.sin(p.age * p.freq + p.phase) * p.swirlAmp * dt) * Math.pow(p.drag || 0.955, dt * 60);
        p.vy = (p.vy + p.gravity * dt) * Math.pow(p.dragY || 0.968, dt * 60);
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.rotSpeed * dt;
      }

      if (p.kind === 'pixel') {
        const a0 = Math.max(0, Math.pow(1 - t, 1.32) * p.maxAlpha), sz = Math.max(1, p.size * (1.1 - t * 0.45));
        if (p.style === 1) { ctx.fillStyle = rgbaStr(lerpRgb(p.rgb, p.magicRgb, t * 1.8), a0); drawPetal(p.x, p.y, Math.max(2, p.size * (0.9 + t * 0.9)), p.rot, p.age * 4 + p.phase); }
        else if (p.style === 2) {
          const hot = t < 0.22 ? [255,240,180] : (t < 0.55 ? [255,110,22] : [65,52,50]);
          ctx.fillStyle = rgbaStr(lerpRgb(p.rgb, hot, t * 2.4), a0 * (0.65 + 0.35 * Math.sin(p.age * 22 + p.phase)));
          ctx.fillRect(p.x - sz * 0.5, p.y - sz * 0.5, sz, sz);
        } else if (p.style === 3) {
          ctx.fillStyle = rgbaStr([255,45,110], a0 * 0.6); ctx.fillRect(p.x - sz * 0.5 - 3, p.y - sz * 0.5, sz, sz * 0.85);
          ctx.fillStyle = rgbaStr([0,240,255], a0 * 0.6); ctx.fillRect(p.x - sz * 0.5 + 3, p.y - sz * 0.5, sz, sz * 0.85);
          ctx.fillStyle = rgbaStr(lerpRgb(p.rgb, p.magicRgb, t * 1.4), a0); ctx.fillRect(p.x - sz * 0.5, p.y - sz * 0.5, sz, sz * 0.85);
        } else if (p.style === 4) {
          ctx.fillStyle = rgbaStr(lerpRgb(p.rgb, t > 0.72 ? [230,250,255] : p.magicRgb, t * 1.45), a0);
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.8, sz * 0.65), 0, Math.PI * 2); ctx.fill();
        } else if (p.style === 5) { ctx.fillStyle = rgbaStr(lerpRgb(p.rgb, p.magicRgb, t * 1.15), a0); drawShard(p.x, p.y, Math.max(2, sz * 1.1), p.rot); }
        else { ctx.fillStyle = rgbaStr(lerpRgb(p.rgb, p.magicRgb, t * 1.15), a0 * (0.72 + 0.28 * Math.sin(p.age * 18 + p.phase))); ctx.fillRect(p.x - sz * 0.5, p.y - sz * 0.5, sz, sz); }
      }
    }

    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i]; rp.age += dt; const t = rp.age / rp.life;
      if (t >= 1) { ripples.splice(i, 1); continue; }
      const pad = rp.contract ? -(t * rp.expand) : (1 - Math.pow(1 - t, 3)) * rp.expand;
      ctx.strokeStyle = rgbaStr(rp.rgb, (1 - t) * rp.alpha); ctx.lineWidth = Math.max(0.6, (1 - t) * 2.0);
      ctx.beginPath();
      const rx = rp.x - pad, ry = rp.y - pad * 0.35, rw = Math.max(2, rp.w + pad * 2), rh = Math.max(2, rp.h + pad * 0.7);
      if (ctx.roundRect) ctx.roundRect(rx, ry, rw, rh, 8); else ctx.rect(rx, ry, rw, rh);
      ctx.stroke();
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; if (p.kind === 'pixel' || p.delay > 0) continue;
      const t = p.age / p.life; if (t >= 1) continue;
      const a = Math.max(0, Math.min(1, t * 6) * Math.pow(1 - t, 1.45) * (p.twinkle ? (0.55 + 0.45 * Math.sin(p.age * 16 + p.phase)) : 1) * p.maxAlpha);
      const sz = Math.max(1, p.size * (1 - t * 0.38));
      ctx.fillStyle = rgbaStr(p.rgb, a);
      if (p.kind === 'star') drawStar(p.x, p.y, sz, p.rot);
      else if (p.kind === 'petal') drawPetal(p.x, p.y, sz, p.rot, p.age * 3.8 + p.phase);
      else if (p.kind === 'shard') drawShard(p.x, p.y, sz, p.rot);
      else if (p.kind === 'bar') ctx.fillRect(p.x - sz * 1.4, p.y - sz * 0.25, sz * 2.8, Math.max(1.5, sz * 0.5));
      else if (p.kind === 'glow') {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, sz * 2.3);
        g.addColorStop(0, rgbaStr(p.rgb, a * 0.88)); g.addColorStop(0.45, rgbaStr(p.rgb, a * 0.28)); g.addColorStop(1, rgbaStr(p.rgb, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, sz * 2.3, 0, Math.PI * 2); ctx.fill();
      } else { ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.7, sz), 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
    if (particles.length > 0 || ripples.length > 0) rafId = requestAnimationFrame(tickCanvas2D);
    else { ctx.clearRect(0, 0, width, height); rafId = null; }
  }

  // --- Rasterize Real Discord Message into Sampled Pixels + RGB ---
  function captureMessageSnapshot(li) {
    if (!li || !li.getBoundingClientRect) return null;
    const rect = li.getBoundingClientRect(), w = Math.round(rect.width), h = Math.round(rect.height);
    if (w < 8 || h < 8) return null;
    const isGpu = (backend === 'webgl2'), snapW = Math.min(w, 860), snapH = Math.min(h, 400), samples = [];
    let pixelStep = isGpu ? 2 : 3;
    try {
      const off = document.createElement('canvas'); off.width = snapW; off.height = snapH;
      const octx = off.getContext('2d', { willReadFrequently: true });
      if (octx) {
        const av = li.querySelector('img[class*="avatar"]');
        if (av) {
          const ar = av.getBoundingClientRect(), ax = ar.left - rect.left, ay = ar.top - rect.top;
          if (ar.width > 6 && ar.height > 6 && ax < snapW && ay < snapH) {
            const rad = Math.min(ar.width, ar.height) / 2;
            octx.save(); octx.beginPath(); octx.arc(ax + ar.width / 2, ay + ar.height / 2, rad, 0, Math.PI * 2); octx.clip();
            let ok = false;
            try { if (av.complete && av.naturalWidth > 0) { octx.drawImage(av, ax, ay, ar.width, ar.height); octx.getImageData(0, 0, 1, 1); ok = true; } } catch (e) { off.width = snapW; off.height = snapH; }
            if (!ok) { octx.beginPath(); octx.arc(ax + ar.width / 2, ay + ar.height / 2, rad, 0, Math.PI * 2); octx.fillStyle = '#5865f2'; octx.fill(); }
            octx.restore();
          }
        }
        const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, null);
        let tn = walker.nextNode(), drawn = 0;
        while (tn && drawn < 80) {
          const val = (tn.nodeValue || '').trim(), par = tn.parentElement;
          if (val && par && !par.closest('[class*="buttonContainer"]')) {
            const cs = getComputedStyle(par), rng = document.createRange();
            rng.selectNodeContents(tn);
            const rects = rng.getClientRects();
            if (rects.length > 0) {
              octx.font = `${cs.fontWeight || '400'} ${cs.fontSize || '15px'} ${cs.fontFamily || 'sans-serif'}`;
              octx.fillStyle = cs.color || '#dbdee1'; octx.textBaseline = 'top';
              if (rects.length === 1) {
                const tx = rects[0].left - rect.left, ty = rects[0].top - rect.top;
                if (tx < snapW && ty < snapH) { octx.fillText(val.slice(0, 140), tx, ty); drawn++; }
              } else {
                const cap = Math.min(rects.length, 8); let totW = 0, pos = 0;
                for (let ri = 0; ri < cap; ri++) totW += Math.max(1, rects[ri].width);
                for (let ri = 0; ri < cap && pos < val.length; ri++) {
                  const rr = rects[ri], sh = (ri === cap - 1) ? (val.length - pos) : Math.max(1, Math.round((rr.width / totW) * val.length));
                  const seg = val.slice(pos, pos + sh).trim(); pos += sh;
                  const tx = rr.left - rect.left, ty = rr.top - rect.top;
                  if (seg && tx < snapW && ty < snapH) octx.fillText(seg, tx, ty);
                }
                drawn++;
              }
            }
          }
          tn = walker.nextNode();
        }
        const media = li.querySelectorAll('img:not([class*="avatar"]), video, [class*="embedWrapper"], [class*="attachment"]');
        for (let i = 0; i < media.length && i < 8; i++) {
          const mr = media[i].getBoundingClientRect(), mx = mr.left - rect.left, my = mr.top - rect.top;
          if (mr.width > 12 && mr.height > 12 && mx < snapW && my < snapH) {
            const cs = getComputedStyle(media[i]);
            octx.fillStyle = rgbaStr(parseCssRgb(cs.borderLeftColor || cs.backgroundColor, [110,130,215]), 0.88);
            octx.fillRect(mx, my, Math.min(mr.width, snapW - mx), Math.min(mr.height, snapH - my));
          }
        }
        const img = octx.getImageData(0, 0, snapW, snapH).data, area = snapW * snapH;
        const step = isGpu ? (area > 120000 ? 3 : 2) : (area > 60000 ? 4 : 3); pixelStep = step;
        const maxPx = isGpu ? 1200 : 260, cands = [];
        for (let py = 0; py < snapH; py += step) {
          for (let px = 0; px < snapW; px += step) {
            const idx = (py * snapW + px) * 4;
            if (img[idx + 3] > 55) cands.push({ rx: px, ry: py, rgb: [img[idx], img[idx + 1], img[idx + 2]] });
          }
        }
        if (cands.length <= maxPx) { for (let i = 0; i < cands.length; i++) samples.push(cands[i]); }
        else { const r = cands.length / maxPx; for (let i = 0; i < maxPx; i++) samples.push(cands[Math.floor(i * r)]); }
      }
    } catch (e) {}
    return { rect: { left: rect.left, top: rect.top, width: w, height: h }, pixelStep, samples };
  }

  // --- Multi-Theme Pixel Dissolve Spawner (WebGL2 + Canvas2D) ---
  const GPU_ACC = [
    [[22,54,1400,2,0.29,0,0.09,0.66,1.15,11,24,10,48,-48,-10,-20,-4],[32,86,900,1,0.30,0.01,0.14,0.72,1.28,6.5,15,14,72,-84,-22,-28,-6]],
    [[34,78,950,1,0.28,0,0.10,0.92,1.48,11,21,42,128,-24,42,10,34],[18,42,1600,2,0.28,0.02,0.12,0.75,1.25,5.5,13,25,85,-32,24,-12,14]],
    [[42,96,800,1,0.34,0,0.08,0.62,1.18,5.5,13,-30,58,-175,-72,-220,-90],[24,56,1300,2,0.34,0,0.06,0.45,0.85,14,28,-14,28,-65,-18,-70,-25]],
    [[32,76,1000,1,0,0,0.24,0.46,0.90,12,26,-45,45,35,140,160,380],[28,64,1100,2,0,0.04,0.28,0.56,1.05,9,19,-10,10,90,220,240,480]]
  ];
  const GPU_PIX = [
    [0.30,-0.035,0.055,0.68,1.18,0.95,1.32,18,86,-68,-14,-34,-8],
    [0.28,0.09,0.06,0.84,1.38,0.96,1.35,38,118,-18,38,12,36],
    [0.34,-0.06,0.07,0.72,1.28,0.95,1.34,-18,44,-108,-32,-150,-52]
  ];

  function spawnPixelDissolve(snapshot, presetOverride) {
    if (!snapshot || !snapshot.rect) return;
    const { left, top, width: w, height: h } = snapshot.rect;
    if (w < 4 || h < 4) return;
    if (typeof window.__dcNativeHost === 'function') {
      const dpr = window.devicePixelRatio || 1;
      const pName = String(presetOverride || activePreset || 'fairy');
      try {
        window.__dcNativeHost(JSON.stringify({
          cmd: 'burst',
          x: Math.round(left * dpr),
          y: Math.round(top * dpr),
          w: Math.round(w * dpr),
          h: Math.round(h * dpr),
          preset: pName
        }));
      } catch (e) {}
      return;
    }
    const sid = resolveStyleId(presetOverride), palN = PAL_NORM[sid] || FAIRY_NORM, palR = PALETTES[sid] || FAIRY_PAL;
    let samples = snapshot.samples || [];
    if (samples.length === 0) {
      const n = Math.min(backend === 'webgl2' ? 260 : 90, Math.max(48, Math.round((w * h) / 280)));
      samples = Array.from({ length: n }, () => ({ rx: Math.random() * w, ry: Math.random() * h, rgb: pick(palR) }));
    }
    const cx = left + w * (sid === 5 ? rand(0.32, 0.68) : 0.5), cy = top + h * (sid === 5 ? rand(0.35, 0.65) : 0.5);
    const maxRad = Math.max(12, Math.hypot(w * 0.55, h * 0.55)), swSign = Math.random() < 0.5 ? 1 : -1;

    if (backend === 'webgl2' && gl && !gpuContextLost) {
      // Adaptive LOD: reduce effect detail when deletes arrive quickly (Max speed).
      const lodStride = gpuActiveCount > 5200 ? 3 : (gpuActiveCount > 2800 ? 2 : 1);
      const tNow = gpuNowSec(), basePx = Math.max(2.1, snapshot.pixelStep || 2.4) * (lodStride > 1 ? 1.2 : 1), area = w * h;
      const k0 = packKind(sid, 0), k1 = packKind(sid, 1), k2 = packKind(sid, 2);

      for (let i = 0; i < samples.length; i += lodStride) {
        const s = samples[i], px = left + s.rx, py = top + s.ry;
        const nx = w > 0 ? Math.min(1, s.rx / w) : 0, ny = h > 0 ? Math.min(1, s.ry / h) : 0.5;
        const r0 = s.rgb[0] / 255, g0 = s.rgb[1] / 255, b0 = s.rgb[2] / 255;
        if (sid < 3) {
          const [dx, dy, dj, l0, l1, s0, s1, x0, x1, y0, y1, z0, z1] = GPU_PIX[sid];
          const yTerm = dy < 0 ? (1 - ny) * (-dy) : ny * dy;
          pushGpu(px, py, r0, g0, b0, pick(palN), tNow + nx * dx + yTerm + rand(0, dj), rand(l0, l1), basePx * rand(s0, s1), k0, rand(x0, x1), rand(y0, y1), rand(z0, z1));
        } else if (sid === 3) {
          const bh = Math.abs(Math.sin(Math.floor(py / 6) * 78.233)) % 1;
          pushGpu(px, py, r0, g0, b0, pick(palN), tNow + bh * 0.22 + nx * 0.10 + rand(0, 0.03), rand(0.58, 1.04), basePx * rand(0.96, 1.30), k0, rand(-28, 28), rand(45, 165), rand(180, 420));
        } else if (sid === 4) {
          const rn = Math.min(1, Math.hypot(px - cx, py - cy) / maxRad);
          pushGpu(px, py, r0, g0, b0, pick(palN), tNow + (1 - rn) * 0.14 + rand(0, 0.06), rand(0.74, 1.12), basePx * rand(0.95, 1.32), k0, cx, cy, swSign * rand(5.2, 8.8));
        } else {
          const dx = px - cx, dy = py - cy, d = Math.max(1, Math.hypot(dx, dy)), spd = rand(65, 225);
          pushGpu(px, py, r0, g0, b0, pick(palN), tNow + Math.min(1, d / maxRad) * 0.16 + rand(0, 0.04), rand(0.70, 1.18), basePx * rand(1.0, 1.42), k0, (dx / d) * spd + rand(-25, 25), (dy / d) * spd - rand(30, 105), rand(420, 680));
        }
      }

      if (sid < 4) {
        for (const [lo, hi, div, k, dm, d0, d1, l0, l1, s0, s1, x0, x1, y0, y1, z0, z1] of GPU_ACC[sid]) {
          const cnt = Math.min(hi, Math.max(lo, Math.round(area / div))), pk = packKind(sid, k);
          for (let i = 0; i < cnt; i++) {
            const rx = Math.random() * w, ry = Math.random() * h, c1 = pick(palN);
            pushGpu(left + rx, top + ry, c1[0], c1[1], c1[2], pick(palN), tNow + (w > 0 ? rx / w : 0) * dm + rand(d0, d1), rand(l0, l1), rand(s0, s1), pk, rand(x0, x1), rand(y0, y1), rand(z0, z1));
          }
        }
      } else if (sid === 4) {
        const sc = Math.min(92, Math.max(44, Math.round(area / 850)));
        for (let i = 0; i < sc; i++) {
          const c1 = pick(palN);
          pushGpu(left + Math.random() * w, top + Math.random() * h, c1[0], c1[1], c1[2], pick(palN), tNow + rand(0, 0.22), rand(0.66, 1.06), rand(8, 17), k1, cx, cy, swSign * rand(7.0, 11.5));
        }
        const coreSz = Math.min(76, Math.max(42, Math.min(w, h) * 1.15));
        for (let i = 0; i < 4; i++) {
          const c1 = palN[i % palN.length];
          pushGpu(cx, cy, c1[0], c1[1], c1[2], pick(palN), tNow + 0.04 + i * 0.03, rand(0.84, 1.04), coreSz * rand(0.88, 1.18), k2, cx, cy, swSign * 6.0);
        }
      } else {
        const sc = Math.min(84, Math.max(36, Math.round(area / 900)));
        for (let i = 0; i < sc; i++) {
          const px = left + Math.random() * w, py = top + Math.random() * h, dx = px - cx, dy = py - cy, d = Math.max(1, Math.hypot(dx, dy)), spd = rand(110, 295), c1 = pick(palN);
          pushGpu(px, py, c1[0], c1[1], c1[2], pick(palN), tNow + Math.min(1, d / maxRad) * 0.14 + rand(0, 0.04), rand(0.68, 1.18), rand(9, 19), k1, (dx / d) * spd + rand(-35, 35), (dy / d) * spd - rand(45, 130), rand(460, 740));
        }
        const fc = Math.min(14, Math.max(8, Math.round(w / 55)));
        for (let i = 0; i < fc; i++) {
          const a = (i / fc) * Math.PI * 2 + rand(-0.2, 0.2), spd = rand(30, 110), c1 = pick(palN);
          pushGpu(cx + rand(-18, 18), cy + rand(-10, 10), c1[0], c1[1], c1[2], pick(palN), tNow + rand(0, 0.05), rand(0.28, 0.48), rand(20, 42), k2, Math.cos(a) * spd, Math.sin(a) * spd, 0);
        }
      }
      startLoop(); return;
    }

    // --- Canvas2D Fallback Spawner ---
    ripples.push({ x: left, y: top, w, h, age: 0, life: sid === 4 ? 0.62 : 0.52, expand: sid === 4 ? Math.min(w * 0.4, 34) : 10, contract: sid === 4, alpha: 0.44, rgb: palR[0] || [215,185,255] });
    const makeP = (kind, px, py, nx, rgb, isAcc) => {
      const p = {
        kind, style: sid, x: px, y: py, sx: px, sy: py, vx: rand(10, 64), vy: rand(-60, -10), gravity: rand(-26, -4),
        drag: 0.955, dragY: 0.968, swirlAmp: rand(24, 75), freq: rand(3.5, 7.2), phase: rand(0, Math.PI * 2),
        size: isAcc ? ((kind === 'petal' || kind === 'shard') ? rand(4.5, 8.8) : ((kind === 'star' || kind === 'bar') ? rand(3.5, 7.2) : (kind === 'glow' ? rand(2.6, 5.4) : rand(1.4, 2.8)))) : rand(2.2, 3.6),
        rot: rand(0, Math.PI * 2), rotSpeed: rand(-4.2, 4.2), delay: nx * 0.27 + rand(0, 0.1), life: rand(0.62, 1.14),
        age: 0, maxAlpha: kind === 'glow' ? rand(0.42, 0.75) : 0.96, twinkle: isAcc && kind !== 'glow', rgb, magicRgb: pick(palR)
      };
      if (sid === 1) { p.vx = rand(36, 115); p.vy = rand(-18, 36); p.gravity = rand(12, 34); p.life = rand(0.82, 1.32); }
      else if (sid === 2) { p.vx = rand(-20, 46); p.vy = isAcc ? rand(-150, -55) : rand(-98, -28); p.gravity = rand(-155, -48); p.delay = nx * 0.32 + rand(0, 0.07); }
      else if (sid === 3) { p.vx = rand(-28, 28); p.vy = rand(45, 165); p.gravity = rand(180, 400); p.delay = rand(0, 0.24); p.life = rand(0.56, 0.98); }
      else if (sid === 4) { const dx = px - cx, dy = py - cy; p.cx = cx; p.cy = cy; p.r0 = Math.hypot(dx, dy); p.ang0 = Math.atan2(dy, dx); p.swirlSpeed = swSign * (isAcc ? rand(6.5, 10.5) : rand(5.2, 8.6)); p.delay = rand(0, 0.16); p.life = rand(0.72, 1.08); }
      else if (sid === 5) { const dx = px - cx, dy = py - cy, d = Math.max(1, Math.hypot(dx, dy)), spd = isAcc ? rand(105, 250) : rand(70, 210); p.vx = (dx / d) * spd; p.vy = (dy / d) * spd - rand(30, 105); p.gravity = rand(380, 650); p.drag = 0.985; p.dragY = 0.992; p.swirlAmp = 0; p.rotSpeed = rand(-9, 9); p.delay = Math.min(1, d / maxRad) * 0.15 + rand(0, 0.04); }
      return p;
    };
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      particles.push(makeP('pixel', left + s.rx, top + s.ry, w > 0 ? Math.min(1, s.rx / w) : 0, s.rgb, false));
    }
    const accCnt = Math.min(58, Math.max(24, Math.round((w * h) / 1100)));
    for (let i = 0; i < accCnt; i++) {
      const rx = Math.random() * w, ry = Math.random() * h, r = Math.random();
      const k = sid === 1 ? (r < 0.68 ? 'petal' : 'glow') : sid === 2 ? (r < 0.55 ? 'mote' : 'glow') : sid === 3 ? (r < 0.65 ? 'bar' : 'mote') : sid === 4 ? (r < 0.50 ? 'glow' : 'mote') : sid === 5 ? (r < 0.72 ? 'shard' : 'star') : (r < 0.30 ? 'star' : (r < 0.55 ? 'glow' : 'mote'));
      particles.push(makeP(k, left + rx, top + ry, w > 0 ? rx / w : 0, pick(palR), true));
    }
    startLoop();
  }

  const spawnFairyDust = (rect) => spawnPixelDissolve({ rect, samples: [] });

  // Hold the deleted <li>'s exact vertical slot (~520ms) while pixels lift off, then glide to 0px (380ms)
  function armDissolveOnRemoval(li) {
    if (!li || !li.parentNode) return { hasFired: () => false, cancel: () => {}, triggerNow: () => {} };
    const parent = li.parentNode, msgId = li.id, snapshot = captureMessageSnapshot(li);
    const holdHeight = snapshot ? snapshot.rect.height : Math.round(li.getBoundingClientRect().height);
    let fired = false, cancelled = false, placeholder = null, watcher = null, timeoutId = null;

    function cleanupWatcher() {
      if (watcher) { try { watcher.disconnect(); } catch (e) {} activeWatchers.delete(watcher); watcher = null; }
      if (timeoutId) { clearTimeout(timeoutId); activeTimers.delete(timeoutId); timeoutId = null; }
    }
    function fireDissolveAt(anchorNext) {
      if (fired || cancelled) return;
      fired = true; cleanupWatcher();
      // Only hold a slot when we know exactly where the message was (next sibling anchor).
      // Appending to the end piled placeholders + particles at the bottom during fast deletes.
      const hasAnchor = !!(anchorNext && anchorNext.parentNode === parent);
      if (hasAnchor && parent.isConnected && holdHeight >= 6) {
        placeholder = document.createElement('li'); placeholder.className = 'dc-vfx-placeholder';
        placeholder.style.height = holdHeight + 'px'; placeholder.style.opacity = '1';
        try {
          parent.insertBefore(placeholder, anchorNext);
          activePlaceholders.add(placeholder);
          const pr = placeholder.getBoundingClientRect();
          if (snapshot && pr.width > 4 && pr.height > 4) { snapshot.rect.left = pr.left; snapshot.rect.top = pr.top; }
        } catch (e) { placeholder = null; }
      }
      // Skip particles for messages that were scrolled off-screen (they'd spawn at clamped edges)
      const vh = window.innerHeight || 0;
      if (snapshot && snapshot.rect.top + snapshot.rect.height > 0 && snapshot.rect.top < vh) spawnPixelDissolve(snapshot);
      if (placeholder) {
        const ph = placeholder;
        scheduleTimer(() => {
          if (!ph.isConnected) { activePlaceholders.delete(ph); return; }
          ph.style.height = '0px'; ph.style.opacity = '0';
          scheduleTimer(() => { try { ph.remove(); } catch (e) {} activePlaceholders.delete(ph); }, 400);
        }, 520);
      }
    }
    if (typeof MutationObserver !== 'undefined') {
      watcher = new MutationObserver((muts) => {
        for (const m of muts) {
          if (!m.removedNodes || m.removedNodes.length === 0) continue;
          for (let i = 0; i < m.removedNodes.length; i++) {
            const node = m.removedNodes[i];
            if (node === li || (node.id && node.id === msgId)) { fireDissolveAt(m.nextSibling); return; }
          }
        }
      });
      watcher.observe(parent, { childList: true }); activeWatchers.add(watcher);
    }
    timeoutId = scheduleTimer(() => cleanupWatcher(), 4000);
    return { hasFired: () => fired, cancel: () => { cancelled = true; cleanupWatcher(); }, triggerNow: () => fireDissolveAt(null) };
  }

  function previewOnElement(li) {
    if (!li || !li.isConnected) return false;
    const snap = captureMessageSnapshot(li); if (!snap) return false;
    const prevVis = li.style.visibility === 'hidden' ? '' : li.style.visibility, prevTrans = li.style.transition, prevOp = li.style.opacity;
    li.style.visibility = 'hidden'; spawnPixelDissolve(snap);
    scheduleTimer(() => {
      if (!li.isConnected) return;
      li.style.opacity = '0'; li.style.visibility = prevVis; li.style.transition = 'opacity 0.35s ease';
      void li.offsetWidth; li.style.opacity = prevOp || '1';
      scheduleTimer(() => { if (li.isConnected) { li.style.transition = prevTrans; li.style.opacity = prevOp; } }, 360);
    }, 1020);
    return true;
  }

  // Radial impact burst at (cx, cy)
  function spawnImpactBurst(cx, cy) {
    if (backend === 'webgl2' && gl && !gpuContextLost) {
      const tNow = gpuNowSec();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rand(-0.2, 0.2), spd = rand(12, 48), c1 = FAIRY_NORM[i % FAIRY_NORM.length];
        pushGpu(cx + Math.cos(a) * rand(0, 6), cy + Math.sin(a) * rand(0, 6), c1[0], c1[1], c1[2], FAIRY_NORM[(i + 2) % FAIRY_NORM.length], tNow, rand(0.28, 0.48), rand(18, 34), packKind(0, 2), Math.cos(a) * spd, Math.sin(a) * spd, -12);
      }
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + rand(-0.14, 0.14), spd = rand(135, 250), c1 = pick(FAIRY_NORM);
        pushGpu(cx, cy, c1[0], c1[1], c1[2], pick(FAIRY_NORM), tNow, rand(0.42, 0.72), rand(9.5, 16.5), packKind(0, 1), Math.cos(a) * spd, Math.sin(a) * spd - 22, 75);
      }
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2 + rand(-0.12, 0.12), spd = rand(95, 295);
        pushGpu(cx, cy, 1.0, 0.96, 0.86, pick(FAIRY_NORM), tNow, rand(0.36, 0.66), rand(2.6, 4.4), packKind(0, 0), Math.cos(a) * spd, Math.sin(a) * spd - 28, 140);
      }
      for (let i = 0; i < 16; i++) {
        const a = rand(0, Math.PI * 2), spd = rand(28, 95), c1 = pick(FAIRY_NORM);
        pushGpu(cx + rand(-8, 8), cy + rand(-8, 8), c1[0], c1[1], c1[2], pick(FAIRY_NORM), tNow + rand(0.02, 0.08), rand(0.60, 0.96), i % 2 === 0 ? rand(6.5, 11) : rand(10, 17), packKind(0, i % 2 === 0 ? 1 : 2), Math.cos(a) * spd, Math.sin(a) * spd - 35, -24);
      }
      startLoop(); return;
    }
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + rand(-0.15, 0.15), spd = rand(65, 195), kind = i % 5 === 0 ? 'glow' : (i % 3 === 0 ? 'star' : 'mote');
      particles.push({ kind, style: 0, x: cx, y: cy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 20, gravity: kind === 'glow' ? -15 : 95, swirlAmp: 20, freq: 5, phase: rand(0, Math.PI * 2), size: kind === 'star' ? rand(4.5, 8.2) : (kind === 'glow' ? rand(3.5, 6.2) : rand(1.4, 2.8)), rot: rand(0, Math.PI), rotSpeed: rand(-5, 5), delay: 0, life: rand(0.42, 0.85), age: 0, maxAlpha: kind === 'glow' ? 0.65 : 1, twinkle: kind !== 'glow', rgb: pick(FAIRY_PAL) });
    }
    startLoop();
  }

  const clearTargeting = () => { if (activeTargetEl) { activeTargetEl.classList.remove('dc-vfx-deleting'); activeTargetEl = null; } };
  const setTargeting = (el) => { clearTargeting(); if (el && el.classList) { el.classList.add('dc-vfx-deleting'); activeTargetEl = el; } };
  const flashSkipped = (el) => {
    if (!el || !el.classList) return;
    el.classList.remove('dc-vfx-skipped'); void el.offsetWidth; el.classList.add('dc-vfx-skipped');
    scheduleTimer(() => { try { el.classList.remove('dc-vfx-skipped'); } catch (e) {} }, 320);
  };

  window.__dcVfx = {
    version: 5,
    getBackend: () => backend,
    listPresets, getPreset, setPreset,
    captureMessageSnapshot, spawnPixelDissolve, spawnFairyDust,
    armDissolveOnRemoval, previewOnElement, spawnImpactBurst,
    setTargeting, clearTargeting, flashSkipped,
    destroy: () => {
      clearTargeting();
      for (const tid of Array.from(activeTimers)) clearTimeout(tid); activeTimers.clear();
      for (const w of Array.from(activeWatchers)) { try { w.disconnect(); } catch (e) {} } activeWatchers.clear();
      for (const ph of Array.from(activePlaceholders)) { try { ph.remove(); } catch (e) {} } activePlaceholders.clear();
      if (rafId !== null) cancelAnimationFrame(rafId); rafId = null;
      particles.length = 0; ripples.length = 0;
      if (gl) {
        try { if (glVbo) gl.deleteBuffer(glVbo); if (glVao) gl.deleteVertexArray(glVao); if (glProg) gl.deleteProgram(glProg); } catch (e) {}
        gl = glVbo = glVao = glProg = gpuData = null; gpuActiveCount = gpuWriteCursor = gpuMaxEndTime = 0;
      }
      if (canvas && typeof canvas.removeEventListener === 'function') { try { canvas.removeEventListener('webglcontextlost', onContextLost, false); } catch (e) {} }
      window.removeEventListener('resize', resizeCanvas);
      const c = document.getElementById(CANVAS_ID); if (c) c.remove();
      const s = document.getElementById(STYLE_ID); if (s) s.remove();
      delete window.__dcVfx;
    }
  };
  return 'mounted';
})();
