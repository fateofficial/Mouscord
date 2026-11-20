// Modular Animated Mouse Cursor Engine (window.__dcMouseCursor v1)
// Animated mouse cursor controller (forwards to native GPU overlay when available).
// Features: Minimum-jerk cubic Bezier steering, 5-segment Verlet physics tail, swappable seasonal hat socket.
(function() {
  if (window.__dcMouseCursor && window.__dcMouseCursor.version === 2) {
    return 'already-mounted';
  }
  if (window.__dcMouseCursor && typeof window.__dcMouseCursor.destroy === 'function') {
    try { window.__dcMouseCursor.destroy(); } catch (e) {}
  }

  let canvas = null, ctx = null, raf = 0;
  let visible = false;
  let season = 'christmas'; // 'christmas' | 'none'

  // Position & velocity state
  let x = window.innerWidth * 0.5, y = window.innerHeight * 0.5;
  let vx = 0, vy = 0, facing = 1; // 1 = right, -1 = left
  let boopAmt = 0, hatTilt = 0, hatVel = 0;
  let idleTime = 0, lastTs = 0;
  let lastActionTs = 0, nextWanderDelayMs = 220;
  let userX = window.innerWidth * 0.4, userY = window.innerHeight * 0.5;

  const onUserMove = (e) => { userX = e.clientX; userY = e.clientY; };
  window.addEventListener('pointermove', onUserMove, { passive: true });

  // Active Bezier glide state
  let glide = null;

  // 6-node (5-segment) Verlet physics tail chain
  const TAIL_NODES = 6;
  const SEG_LEN = 5.5;
  const tail = Array.from({ length: TAIL_NODES }, (_, i) => ({
    x: x - i * SEG_LEN, y, ox: x - i * SEG_LEN, oy: y
  }));

  // Playful sparkle trail particles for victory dance
  const sparkles = [];
  let dancing = false;

  const BOX = 140, HALF = 70;

  function ensureCanvas() {
    if (canvas && canvas.isConnected) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'dc-mouse-cursor-canvas';
    // Small 140x140 canvas moved with a transform instead of a fullscreen canvas.
    canvas.style.cssText = `position:fixed;left:0;top:0;width:${BOX}px;height:${BOX}px;pointer-events:none;z-index:99999;opacity:0;transition:opacity 0.2s ease;will-change:transform;`;
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    return canvas;
  }

  function resize() {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(BOX * dpr);
    canvas.height = Math.round(BOX * dpr);
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function stepTail(dt) {
    // Anchor node 0 to rear of mouse body
    const anchorX = x - facing * 13;
    const anchorY = y + 5;
    tail[0].x = anchorX;
    tail[0].y = anchorY;

    const damping = 0.88;
    const wag = Math.sin(idleTime * 5.2) * (Math.hypot(vx, vy) < 15 ? 0.35 : 0.08);

    for (let i = 1; i < TAIL_NODES; i++) {
      const n = tail[i];
      const dx = (n.x - n.ox) * damping;
      const dy = (n.y - n.oy) * damping;
      n.ox = n.x;
      n.oy = n.y;
      n.x += dx - facing * 0.15;
      n.y += dy + 0.12 + wag * (i / TAIL_NODES);
    }

    // Distance constraints (3 relaxation iterations)
    for (let iter = 0; iter < 3; iter++) {
      tail[0].x = anchorX;
      tail[0].y = anchorY;
      for (let i = 1; i < TAIL_NODES; i++) {
        const a = tail[i - 1], b = tail[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const diff = (d - SEG_LEN) / d;
        if (i === 1) {
          b.x -= dx * diff;
          b.y -= dy * diff;
        } else {
          a.x += dx * diff * 0.35;
          a.y += dy * diff * 0.35;
          b.x -= dx * diff * 0.65;
          b.y -= dy * diff * 0.65;
        }
      }
    }
  }

  function drawMouse() {
    if (typeof window.__dcNativeHost === 'function') {
      if (canvas) canvas.style.opacity = '0';
      const dpr = window.devicePixelRatio || 1;
      try {
        window.__dcNativeHost(JSON.stringify({
          cmd: 'mouse',
          show: visible,
          x: Math.round(x * dpr),
          y: Math.round(y * dpr),
          f: facing,
          b: Number(boopAmt.toFixed(2)),
          s: season === 'christmas' ? 1 : 0
        }));
      } catch (e) {}
      return;
    }
    if (!ctx || !canvas) return;
    canvas.style.transform = `translate3d(${Math.round(x - HALF)}px, ${Math.round(y - HALF)}px, 0)`;
    ctx.clearRect(0, 0, BOX, BOX);
    const ox = HALF - x, oy = HALF - y;

    // 0. Victory Dance Sparkle Trail (local box coords)
    for (let i = sparkles.length - 1; i >= 0; i--) {
      const sp = sparkles[i];
      sp.life -= 0.025;
      sp.x += sp.vx;
      sp.y += sp.vy;
      if (sp.life <= 0) { sparkles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, sp.life);
      ctx.fillStyle = sp.color;
      ctx.beginPath();
      ctx.arc(sp.x + ox, sp.y + oy, sp.r * sp.life, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 1. Physics Tail (smooth quadratic curve through Verlet nodes in local box coords)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tail[0].x + ox, tail[0].y + oy);
    for (let i = 1; i < TAIL_NODES - 1; i++) {
      const mx = (tail[i].x + tail[i + 1].x) * 0.5 + ox;
      const my = (tail[i].y + tail[i + 1].y) * 0.5 + oy;
      ctx.quadraticCurveTo(tail[i].x + ox, tail[i].y + oy, mx, my);
    }
    ctx.lineTo(tail[TAIL_NODES - 1].x + ox, tail[TAIL_NODES - 1].y + oy);
    ctx.strokeStyle = '#f2a7b8';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    // 2. Mouse Body + Head (centered at HALF, HALF)
    const sx = facing * (1 + boopAmt * 0.16);
    const sy = 1 - boopAmt * 0.18;
    const speedTilt = Math.max(-0.22, Math.min(0.22, vy * 0.0005)) * facing;

    ctx.save();
    ctx.translate(HALF, HALF);
    ctx.rotate(speedTilt);
    ctx.scale(sx, sy);

    // Flat ellipse shadow; shadowBlur is too slow in software.
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath(); ctx.ellipse(1, 10, 14, 5, 0, 0, Math.PI * 2); ctx.fill();

    // Back ear
    ctx.fillStyle = '#c5cbd6';
    ctx.strokeStyle = '#2b2d31';
    ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(-4, -10, 7.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f7b2c4';
    ctx.beginPath(); ctx.arc(-4, -10, 4.2, 0, Math.PI * 2); ctx.fill();

    // Plump mouse body
    ctx.fillStyle = '#e3e6ed';
    ctx.strokeStyle = '#2b2d31';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(0, 1, 15, 11.5, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    // Front ear
    ctx.fillStyle = '#d3d8e2';
    ctx.beginPath(); ctx.arc(-9, -8, 7.8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#f7b2c4';
    ctx.beginPath(); ctx.arc(-9, -8, 4.4, 0, Math.PI * 2); ctx.fill();

    // Eye + sparkle
    ctx.fillStyle = '#1e1f22';
    ctx.beginPath(); ctx.arc(6.5, -1.5, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(7.1, -2.2, 0.8, 0, Math.PI * 2); ctx.fill();

    // Pink nose (nudged slightly up)
    ctx.fillStyle = '#ff7a9e';
    ctx.beginPath(); ctx.ellipse(15.2, 0.0, 2.8, 2.1, 0, 0, Math.PI * 2); ctx.fill();

    // Whiskers (nudged slightly down)
    ctx.strokeStyle = '#5c6270';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(10.5, 4.0); ctx.lineTo(18.0, 2.8);
    ctx.moveTo(10.5, 5.8); ctx.lineTo(18.0, 7.0);
    ctx.stroke();

    // 3. Seasonal hat, tilted by a velocity spring.
    if (season === 'christmas') {
      ctx.save();
      ctx.translate(1, -10);
      ctx.rotate(hatTilt);
      // Red Santa hat cone
      ctx.fillStyle = '#da373c';
      ctx.strokeStyle = '#2b2d31';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-8, 1);
      ctx.quadraticCurveTo(-2, -16, 11, -7);
      ctx.lineTo(7, 1);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // White trim
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.roundRect(-9, -1.5, 17, 4.5, 2.2);
      ctx.fill(); ctx.stroke();
      // Pom-pom
      ctx.beginPath(); ctx.arc(11.5, -7, 3.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function tick(now) {
    if (!visible) { raf = 0; return; }
    const dt = Math.min(0.05, lastTs ? (now - lastTs) / 1000 : 0.016);
    lastTs = now;
    idleTime += dt;

    const prevX = x, prevY = y;
    if (glide) {
      const u = Math.min(1, (now - glide.t0) / glide.dur);
      // Minimum-jerk easing: 10u^3 - 15u^4 + 6u^5
      const t = u * u * u * (u * (6 * u - 15) + 10);
      const mt = 1 - t;
      x = mt*mt*mt*glide.sx + 3*mt*mt*t*glide.cx1 + 3*mt*t*t*glide.cx2 + t*t*t*glide.tx;
      y = mt*mt*mt*glide.sy + 3*mt*mt*t*glide.cy1 + 3*mt*t*t*glide.cy2 + t*t*t*glide.ty;
      if (u >= 1) {
        const cb = glide.onArrive;
        glide = null;
        lastActionTs = now;
        if (cb) cb();
      }
    } else if (now - lastActionTs > nextWanderDelayMs) {
      // Idle behaviour: wander, or move toward the user's real cursor.
      lastActionTs = now;
      nextWanderDelayMs = 220 + Math.random() * 380;
      const teaseUser = Math.random() < 0.38;
      if (teaseUser && userX > 40 && userY > 40) {
        const ang = Math.random() * Math.PI * 2;
        const tx = Math.max(36, Math.min(window.innerWidth - 36, userX + Math.cos(ang) * 34));
        const ty = Math.max(44, Math.min(window.innerHeight - 36, userY + Math.sin(ang) * 34));
        moveTo(tx, ty, { boop: true, durationMs: 420 });
      } else {
        const tx = Math.max(window.innerWidth - 310, Math.min(window.innerWidth - 36, x + (Math.random() * 140 - 70)));
        const ty = Math.max(80, Math.min(window.innerHeight - 80, y + (Math.random() * 140 - 70)));
        moveTo(tx, ty, { boop: false, durationMs: 480 });
      }
    }

    vx = dt > 0 ? (x - prevX) / dt : 0;
    vy = dt > 0 ? (y - prevY) / dt : 0;
    if (Math.abs(vx) > 25) facing = vx > 0 ? 1 : -1;

    // Spring physics for hat tilt & boop decay
    const targetTilt = Math.max(-0.45, Math.min(0.45, -vx * 0.0006 * facing));
    hatVel += (targetTilt - hatTilt) * 180 * dt;
    hatVel *= Math.pow(0.08, dt);
    hatTilt += hatVel * dt;
    if (boopAmt > 0.001) boopAmt *= Math.pow(0.002, dt); else boopAmt = 0;

    if (dancing && Math.random() < 0.75) {
      const cols = ['#ffd97d', '#ff9ea1', '#ffffff', '#7ef2a9'];
      sparkles.push({
        x: x + (Math.random() * 14 - 7),
        y: y + (Math.random() * 14 - 7),
        vx: (Math.random() - 0.5) * 0.9,
        vy: -0.4 - Math.random() * 0.8,
        r: 2.2 + Math.random() * 2.5,
        life: 1.0,
        color: cols[Math.floor(Math.random() * cols.length)]
      });
    }

    stepTail(dt);
    drawMouse();
    raf = requestAnimationFrame(tick);
  }

  function show() {
    const c = ensureCanvas();
    visible = true;
    c.style.opacity = '1';
    lastTs = performance.now();
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function hide() {
    visible = false;
    if (typeof window.__dcNativeHost === 'function') {
      try { window.__dcNativeHost(JSON.stringify({ cmd: 'mouse', show: false })); } catch (e) {}
    }
    if (glide && glide.onResolve) { const r = glide.onResolve; glide = null; r(); }
    glide = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (canvas) {
      canvas.style.opacity = '0';
      if (ctx) ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  function boop() {
    boopAmt = 1.0;
    hatVel += 3.2;
  }

  function moveTo(tx, ty, opts) {
    if (!visible) return Promise.resolve();
    const o = opts || {};
    const sx = x, sy = y;
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.hypot(dx, dy);
    const arc = (Math.random() < 0.5 ? 1 : -1) * Math.min(64, Math.max(14, dist * 0.18));
    return new Promise((resolve) => {
      if (glide && glide.onResolve) { const prev = glide.onResolve; glide = null; prev(); }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = 0; }
        resolve();
      };
      const dur = o.durationMs || (220 + Math.min(240, Math.round(dist * 0.45)));
      // Chromium throttles requestAnimationFrame when unfocused; don't let the animation stall.
      let safetyTimer = setTimeout(() => {
        x = tx; y = ty;
        glide = null;
        if (o.boop !== false) boop();
        done();
      }, dur + 90);
      glide = {
        sx, sy, tx, ty,
        cx1: sx + dx * 0.33 + arc * 0.4,
        cy1: sy + dy * 0.25 - arc,
        cx2: sx + dx * 0.72 - arc * 0.3,
        cy2: sy + dy * 0.85 + arc * 0.3,
        t0: performance.now(),
        dur,
        onResolve: done,
        onArrive: () => {
          if (o.boop !== false) boop();
          done();
        }
      };
    });
  }

  function moveToElement(domIdOrEl, opts) {
    if (!visible) return Promise.resolve();
    const el = typeof domIdOrEl === 'string' ? document.getElementById(domIdOrEl) : domIdOrEl;
    if (!el || !el.getBoundingClientRect) return Promise.resolve();
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight) return Promise.resolve();
    const o = opts || {};
    const tx = o.aimCenter
      ? (r.left + r.width * 0.5)
      : Math.max(36, Math.min(window.innerWidth - 72, r.right - 26 + (Math.random() * 6 - 3)));
    const ty = r.top + r.height * 0.5 + (o.aimCenter ? 0 : (Math.random() * 4 - 2));
    return moveTo(tx, ty, Object.assign({ boop: true }, o));
  }

  async function victoryDance(closeBtnEl) {
    if (!visible) return;
    dancing = true;
    const baseX = Math.max(window.innerWidth - 280, Math.min(window.innerWidth - 60, x));
    const baseY = Math.max(140, Math.min(window.innerHeight - 160, y));
    const hopCount = 7 + Math.floor(Math.random() * 3);
    for (let i = 0; i < hopCount; i++) {
      if (!visible) { dancing = false; return; }
      const side = (i % 2 === 0 ? -1 : 1);
      const hx = Math.max(window.innerWidth - 310, Math.min(window.innerWidth - 36, baseX + side * (28 + Math.random() * 44)));
      const hy = Math.max(100, Math.min(window.innerHeight - 130, baseY + (Math.random() * 70 - 35)));
      await moveTo(hx, hy, { durationMs: 170 + Math.round(Math.random() * 90), boop: true });
    }
    if (closeBtnEl && visible) {
      await moveToElement(closeBtnEl, { aimCenter: true, durationMs: 280, boop: true });
      await new Promise(r => setTimeout(r, 180));
    }
    dancing = false;
  }

  function setSeason(s) { season = s || 'none'; }
  function getSeason() { return season; }

  function destroy() {
    hide();
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onUserMove);
    if (canvas) { try { canvas.remove(); } catch (e) {} canvas = null; ctx = null; }
    delete window.__dcMouseCursor;
  }

  window.__dcMouseCursor = {
    version: 2,
    show,
    hide,
    moveTo,
    moveToElement,
    boop,
    victoryDance,
    setSeason,
    getSeason,
    destroy
  };

  return 'mounted';
})();
