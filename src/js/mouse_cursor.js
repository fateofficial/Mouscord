// Articulated 2D Mouse Cursor Rig (window.__dcMouseCursor v3)
// Hierarchical bone skeleton (pelvis, spine, chest, head, ear, 3-bone Santa hat, thick haunch, paws, 7-node tail)
// rendered inside a lightweight 180x180 GPU-translated canvas.
(function() {
  if (window.__dcMouseCursor && window.__dcMouseCursor.version === 7) {
    return 'already-mounted';
  }
  if (window.__dcMouseCursor && typeof window.__dcMouseCursor.destroy === 'function') {
    try { window.__dcMouseCursor.destroy(); } catch (e) {}
  }

  const COL = {
    ink: '#23242b', fur: '#ffffff', furShade: '#cfd8e6',
    pink: '#f7a6b4', pinkHi: '#fcd4dc', pinkDark: '#d97a8e',
    hatRed: '#d8232d', hatDark: '#9e141c', hatHi: '#f27470',
    eye: '#241a20', whisker: '#766f78'
  };

  let canvas = null, ctx = null, raf = 0;
  let visible = false;
  let season = 'christmas';
  let boopStyle = 'nose'; // 'nose' | 'paw' | 'random'
  let activeBoopKind = 'nose';

  const BOX = 180, HALF = 90, ZOOM = 0.85;
  let x = window.innerWidth * 0.5, y = window.innerHeight * 0.5;
  let vx = 0, vy = 0, facing = 1;
  let speedBlend = 0, gaitPhase = 0;
  let boopT = 0, flipT = 0, danceT = 0, recoilX = 0, recoilY = 0;
  let jumpPhase = 'none', jumpT = 0, jumpHeight = 0;
  let napMode = false, napBlend = 0, zzzTimer = 0, napAnchorEl = null;
  let blinkTimer = 2.2, blinkDur = 0, earTwitchTimer = 3.0, earTwitch = 0;
  let hatAng = 0, hatVel = 0, hatTipAng = 0, hatTipVel = 0, earAng = 0, earVel = 0;
  let lastTs = 0, lastActionTs = 0, nextWanderDelayMs = 260;
  let userX = window.innerWidth * 0.4, userY = window.innerHeight * 0.5;
  let glide = null, dancing = false;

  const idleTail = [
    { x: -18.0, y: -4.5 }, { x: -27.0, y: -3.2 }, { x: -35.5, y: -5.5 },
    { x: -40.5, y: -13.0 }, { x: -38.0, y: -22.5 }, { x: -33.5, y: -30.5 }, { x: -42.5, y: -32.8 }
  ];
  const runTail = [
    { x: -20.0, y: -12.0 }, { x: -29.0, y: -11.5 }, { x: -38.0, y: -12.8 },
    { x: -47.0, y: -14.2 }, { x: -55.5, y: -13.5 }, { x: -63.5, y: -11.8 }, { x: -71.0, y: -12.5 }
  ];
  const napTail = [
    { x: -17.0, y: -3.0 }, { x: -24.0, y: -1.5 }, { x: -25.5, y: 0.5 },
    { x: -18.0, y: 1.8 }, { x: -8.0, y: 2.2 }, { x: 2.5, y: 1.8 }, { x: 10.5, y: 0.2 }
  ];
  const tail = idleTail.map(p => ({ x: p.x, y: p.y }));
  const sparkles = [];

  const onUserMove = (e) => { userX = e.clientX; userY = e.clientY; };
  window.addEventListener('pointermove', onUserMove, { passive: true });

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rotPt = (px, py, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: px * c - py * s, y: px * s + py * c }; };

  function ensureCanvas() {
    if (canvas && canvas.isConnected) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'dc-mouse-cursor-canvas';
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
  window.addEventListener('resize', resize);

  function spawnSparkles(lx, ly, count, text) {
    const cols = ['#ffd97d', '#f7a6b4', '#ffffff', '#8ea1e1'];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const spd = text ? 10 : (28 + Math.random() * 65);
      sparkles.push({
        x: lx, y: ly,
        vx: text ? facing * 10 : Math.cos(a) * spd,
        vy: text ? -26 : (Math.sin(a) * spd - 24),
        r: text ? 11 : (1.8 + Math.random() * 2.4),
        life: 1.0,
        col: text ? '#b5bac1' : cols[i % cols.length],
        text: text || null
      });
    }
  }

  function computePose(t) {
    const sp = speedBlend, ph = gaitPhase;
    const breath = Math.sin(t * 2.8) * (1 - sp) * 0.8;
    let spineLen = lerp(19, 26, sp);
    let bodyPitch = lerp(-0.46, -0.06, sp);
    let pelvisX = lerp(-12, -16, sp), pelvisY = lerp(-16, -15, sp);
    let squashX = 1.0, squashY = 1.0;
    let hindHipAng = lerp(0.05, 0.0, sp), hindAnkleExt = 0;
    let frontArmNearAng = lerp(0.95, 0.2, sp), frontArmFarAng = lerp(1.05, 0.2, sp);
    let headPitch = lerp(0.32, 0.04, sp), bodyBobY = 0;

    if (sp > 0.02 && jumpPhase === 'none') {
      const runMix = clamp((sp - 0.35) / 0.65, 0, 1);
      const s1 = Math.sin(ph);
      const compress = Math.max(0, -s1) * runMix, extend = Math.max(0, s1) * runMix;
      spineLen += (extend * 6.5 - compress * 5.5);
      bodyPitch += (-0.18 * extend + 0.26 * compress) + s1 * 0.06 * (1 - runMix);
      bodyBobY = -Math.abs(s1) * lerp(2.5, 8.5, runMix) + compress * 2.5;
      hindHipAng = lerp(s1 * 0.55, -0.65 * compress + 0.95 * extend, runMix);
      hindAnkleExt = clamp(extend * 1.15 + Math.max(0, s1) * 0.4 * (1 - runMix), 0, 1);
      frontArmNearAng = lerp(Math.sin(ph + 2.2) * 0.75 + 0.3, -0.75 * extend + 0.75 * compress + 0.15, runMix);
      frontArmFarAng = lerp(Math.sin(ph + 2.2 + Math.PI) * 0.75 + 0.3, -0.55 * extend + 0.60 * compress + 0.25, runMix);
      headPitch += -bodyPitch * 0.45 - extend * 0.12 + compress * 0.1;
    }

    if (jumpPhase === 'air') {
      const p = clamp(jumpT, 0, 1);
      if (p < 0.35) {
        const k = 1 - p / 0.35;
        squashX = 1 + 0.16 * k; squashY = 1 - 0.10 * k; spineLen = 29;
        bodyPitch = -0.52 * k - 0.15; hindHipAng = 1.15; hindAnkleExt = 1.0;
        frontArmNearAng = -0.75; frontArmFarAng = -0.55; headPitch = 0.28;
      } else if (p < 0.72) {
        const k = (p - 0.35) / 0.37;
        spineLen = lerp(28, 22, Math.sin(k * Math.PI));
        bodyPitch = lerp(-0.18, 0.32, k); hindHipAng = lerp(1.0, 0.25, k); hindAnkleExt = lerp(0.9, 0.45, k);
        frontArmNearAng = lerp(-0.65, 0.45, k); frontArmFarAng = lerp(-0.5, 0.35, k); headPitch = -bodyPitch * 0.35;
      } else {
        const k = (p - 0.72) / 0.28;
        spineLen = lerp(23, 25, k); bodyPitch = lerp(0.32, 0.42, k);
        hindHipAng = lerp(0.25, -0.15, k); hindAnkleExt = lerp(0.45, 0.2, k);
        frontArmNearAng = lerp(0.45, 0.95, k); frontArmFarAng = lerp(0.35, 0.85, k); headPitch = -0.25;
      }
    }

    if (napBlend > 0.01 && jumpPhase === 'none' && flipT <= 0.01) {
      const n = napBlend * napBlend * (3 - 2 * napBlend);
      bodyPitch = lerp(bodyPitch, 0.06, n); spineLen = lerp(spineLen, 23, n);
      pelvisY = lerp(pelvisY, -10.5 + Math.sin(t * 1.8) * 0.6, n);
      squashX = lerp(squashX, 1.12, n); squashY = lerp(squashY, 0.84 + Math.sin(t * 1.8) * 0.03, n);
      headPitch = lerp(headPitch, 0.04, n);
      frontArmNearAng = lerp(frontArmNearAng, 0.15, n); frontArmFarAng = lerp(frontArmFarAng, 0.15, n);
      hindHipAng = lerp(hindHipAng, -0.15, n);
    }

    if (flipT > 0.01) {
      const p = 1.0 - flipT;
      if (p < 0.15) {
        const k = p / 0.15; squashX = lerp(1, 1.2, k); squashY = lerp(1, 0.76, k); pelvisY += 4 * k; hindHipAng = -0.5 * k;
      } else if (p < 0.85) {
        hindHipAng = 0.85; hindAnkleExt = 0.95; frontArmNearAng = -0.65; frontArmFarAng = -0.5; spineLen = 20;
      } else {
        const b = Math.sin(((p - 0.85) / 0.15) * Math.PI);
        squashX = 1 + 0.18 * b; squashY = 1 - 0.16 * b; pelvisY += 3.5 * b;
      }
    }

    if (boopT > 0.01) {
      const b = Math.sin(boopT * Math.PI);
      if (activeBoopKind === 'nose') {
        spineLen += 7.5 * b; bodyPitch += 0.14 * b; headPitch += 0.24 * b;
        squashX = 1 + 0.14 * b; squashY = 1 - 0.10 * b; frontArmNearAng = lerp(frontArmNearAng, 0.75, b);
      } else {
        bodyPitch -= 0.34 * b; squashX = 1 - 0.08 * b; squashY = 1 + 0.12 * b;
        frontArmNearAng = lerp(frontArmNearAng, -1.05, b); headPitch += 0.15 * b;
      }
    }

    const pelvis = { x: pelvisX, y: pelvisY + bodyBobY };
    const spVec = rotPt(spineLen, 0, bodyPitch);
    const chest = { x: pelvis.x + spVec.x, y: pelvis.y + spVec.y - breath };
    const headBaseAng = bodyPitch + headPitch;
    const neckVec = rotPt(11, -3, headBaseAng);
    const head = { x: chest.x + neckVec.x, y: chest.y + neckVec.y };
    const earOff = rotPt(-11, -9, headBaseAng);
    const ear = { x: head.x + earOff.x, y: head.y + earOff.y, ang: headBaseAng + earAng + earTwitch * 0.28 };
    const hatBaseOff = rotPt(-3, -13, headBaseAng);
    const hatBase = { x: head.x + hatBaseOff.x, y: head.y + hatBaseOff.y, ang: headBaseAng - 0.14 + hatAng };
    const hatMidOff = rotPt(-17, -18, hatBase.ang);
    const hatMid = { x: hatBase.x + hatMidOff.x, y: hatBase.y + hatMidOff.y };
    const hatTipOff = rotPt(-13, 14, hatBase.ang + hatTipAng);
    const hatTip = { x: hatMid.x + hatTipOff.x, y: hatMid.y + hatTipOff.y };
    const hip = { x: pelvis.x + 2, y: pelvis.y + 3 };
    const footReachX = lerp(3, -15, hindAnkleExt) + Math.sin(hindHipAng) * -8;
    const footReachY = lerp(14, 19, hindAnkleExt);
    const hindFoot = { x: hip.x + footReachX, y: jumpPhase === 'air' ? hip.y + footReachY : Math.min(0, hip.y + footReachY) };
    const shoulder = { x: chest.x + 2, y: chest.y + 7 };
    const armLen = lerp(8.5, 11.5, sp);
    const pawNearVec = rotPt(armLen, 1, frontArmNearAng), pawFarVec = rotPt(armLen - 1, 1, frontArmFarAng);
    const pawNear = { x: shoulder.x + pawNearVec.x, y: shoulder.y + pawNearVec.y };
    const pawFar = { x: shoulder.x + 4 + pawFarVec.x, y: shoulder.y - 1 + pawFarVec.y };
    const eyeOff = rotPt(5, -2.5, headBaseAng), noseOff = rotPt(17.5, 0.5, headBaseAng);
    return {
      pelvis, chest, head, headBaseAng, bodyPitch, squashX, squashY,
      ear, hatBase, hatMid, hatTip, hip, hindHipAng, hindAnkleExt, hindFoot,
      shoulder, pawNear, pawFar, frontArmNearAng,
      eye: { x: head.x + eyeOff.x, y: head.y + eyeOff.y },
      nose: { x: head.x + noseOff.x, y: head.y + noseOff.y }
    };
  }

  function drawFluffPuffs(pts, strokeW) {
    ctx.lineWidth = strokeW * 2;
    ctx.strokeStyle = COL.ink;
    ctx.beginPath();
    for (const p of pts) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); }
    ctx.stroke();
    ctx.fillStyle = '#d7dfec';
    ctx.beginPath();
    for (const p of pts) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); }
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    for (const p of pts) { ctx.moveTo(p.x + p.r * 0.9, p.y - p.r * 0.15); ctx.arc(p.x, p.y - p.r * 0.15, p.r * 0.9, 0, Math.PI * 2); }
    ctx.fill();
  }

  function drawMouse(t) {
    if (!ctx || !canvas) return;
    canvas.style.transform = `translate3d(${Math.round(x + recoilX - HALF)}px, ${Math.round(y + recoilY - HALF - 10)}px, 0)`;
    ctx.clearRect(0, 0, BOX, BOX);

    const pose = computePose(t);
    ctx.save();
    ctx.translate(HALF, HALF + 24 - jumpHeight);
    ctx.scale(facing * ZOOM, ZOOM);
    ctx.scale(pose.squashX, pose.squashY);
    if (flipT > 0.01) {
      const p = 1.0 - flipT;
      const spin = p < 0.15 ? 0 : (p < 0.85 ? -((p - 0.15) / 0.70) * Math.PI * 2 : 0);
      ctx.translate(0, -16); ctx.rotate(spin); ctx.translate(0, 16);
    }

    const SW = 2.3;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';

    // Smooth 24-sample Catmull-Rom tail
    const smoothTail = [];
    for (let i = 0; i < tail.length - 1; i++) {
      const p0 = tail[Math.max(0, i - 1)], p1 = tail[i], p2 = tail[i + 1], p3 = tail[Math.min(tail.length - 1, i + 2)];
      for (let s = 0; s < 4; s++) {
        const u = s / 4, u2 = u * u, u3 = u2 * u;
        smoothTail.push({
          x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
          y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3)
        });
      }
    }
    smoothTail.push(tail[tail.length - 1]);

    const drawTail = () => {
      const strokeT = (extraW, color) => {
        ctx.strokeStyle = color; ctx.lineCap = 'round';
        for (let i = 0; i < smoothTail.length - 1; i++) {
          const frac = i / (smoothTail.length - 1);
          const w = lerp(3.4, 0.45, Math.pow(frac, 0.85)) + extraW * lerp(1.0, 0.5, frac);
          ctx.lineWidth = w * 2;
          ctx.beginPath(); ctx.moveTo(smoothTail[i].x, smoothTail[i].y); ctx.lineTo(smoothTail[i + 1].x, smoothTail[i + 1].y); ctx.stroke();
        }
      };
      strokeT(SW * 0.72, COL.ink);
      strokeT(0, COL.pink);
      ctx.beginPath(); ctx.moveTo(smoothTail[0].x, smoothTail[0].y - 0.8);
      for (let i = 1; i < smoothTail.length - 3; i++) ctx.lineTo(smoothTail[i].x, smoothTail[i].y - 0.8);
      ctx.strokeStyle = COL.pinkHi; ctx.lineWidth = 1.2; ctx.stroke();
    };
    const tailInFront = napBlend >= 0.55;
    if (!tailInFront) drawTail();

    // Far limbs
    ctx.fillStyle = COL.pinkDark; ctx.strokeStyle = COL.ink; ctx.lineWidth = SW * 0.9;
    ctx.beginPath(); ctx.ellipse(pose.hindFoot.x + 11, pose.hindFoot.y - 1.5, 5.5, 2.4, 0.05, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(pose.shoulder.x + 3, pose.shoulder.y - 2); ctx.quadraticCurveTo(pose.shoulder.x + 9, pose.shoulder.y + 3, pose.pawFar.x, pose.pawFar.y);
    ctx.strokeStyle = COL.ink; ctx.lineWidth = 7.2; ctx.stroke();
    ctx.strokeStyle = COL.furShade; ctx.lineWidth = 3.2; ctx.stroke();

    // Body silhouette
    const p = pose.pelvis, ch = pose.chest, hd = pose.head, ns = pose.nose;
    const backUp = rotPt(0, -18, pose.bodyPitch), rumpBack = rotPt(-15, -3, pose.bodyPitch);
    const headTop = rotPt(2, -14, pose.headBaseAng), snoutTop = rotPt(14, -8, pose.headBaseAng);
    const chinPt = rotPt(11, 8, pose.headBaseAng), bellyPt = rotPt(2, 13, pose.bodyPitch);
    const traceBody = () => {
      ctx.beginPath();
      ctx.moveTo(p.x - 4, p.y + 13);
      ctx.bezierCurveTo(p.x + rumpBack.x - 4, p.y + rumpBack.y + 9, p.x + backUp.x - 10, p.y + backUp.y + 4, ch.x + backUp.x * 0.6, ch.y + backUp.y * 0.85);
      ctx.bezierCurveTo(hd.x + headTop.x - 4, hd.y + headTop.y, hd.x + snoutTop.x, hd.y + snoutTop.y, ns.x, ns.y);
      ctx.bezierCurveTo(ns.x - 1, ns.y + 6.5, hd.x + chinPt.x, hd.y + chinPt.y + 1, ch.x + 10, ch.y + 10);
      ctx.bezierCurveTo(ch.x + 6, ch.y + 16, p.x + bellyPt.x + 8, p.y + bellyPt.y + 2, p.x - 4, p.y + 13);
      ctx.closePath();
    };
    traceBody(); ctx.fillStyle = COL.fur; ctx.fill();
    ctx.save(); traceBody(); ctx.clip();
    ctx.fillStyle = COL.furShade;
    ctx.beginPath(); ctx.ellipse(p.x + 4, p.y + 14, 34, 10, pose.bodyPitch * 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(hd.x + 6, hd.y + 11, 14, 6, pose.headBaseAng, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    traceBody(); ctx.strokeStyle = COL.ink; ctx.lineWidth = SW; ctx.stroke();

    // Thick back thigh (haunch) + hind foot
    ctx.save();
    ctx.fillStyle = COL.pink; ctx.strokeStyle = COL.ink; ctx.lineWidth = SW * 0.9;
    ctx.beginPath(); ctx.ellipse(pose.hindFoot.x + 3, pose.hindFoot.y - 2, lerp(6.8, 8.2, pose.hindAnkleExt), 2.8, lerp(0, 0.72, pose.hindAnkleExt), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.translate(pose.hip.x, pose.hip.y); ctx.rotate(pose.hindHipAng * 0.52);
    ctx.fillStyle = COL.fur; ctx.beginPath(); ctx.ellipse(0, 3.2, 12.6, 10.6, -0.15, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 3.2, 12.6, 10.6, -0.15, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = COL.furShade; ctx.beginPath(); ctx.ellipse(-2, 9.8, 13.5, 6.8, -0.1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    ctx.strokeStyle = COL.ink; ctx.lineWidth = SW;
    ctx.beginPath(); ctx.ellipse(0, 3.2, 12.6, 10.6, -0.15, -0.95, 2.75); ctx.stroke();
    ctx.restore();

    // Near front paw
    ctx.save();
    ctx.beginPath(); ctx.moveTo(pose.shoulder.x - 1, pose.shoulder.y - 4); ctx.quadraticCurveTo(pose.shoulder.x + 4, pose.shoulder.y + 4, pose.pawNear.x, pose.pawNear.y);
    ctx.strokeStyle = COL.ink; ctx.lineWidth = 8.4; ctx.stroke();
    ctx.strokeStyle = COL.fur; ctx.lineWidth = 4.2; ctx.stroke();
    ctx.fillStyle = COL.fur; ctx.beginPath(); ctx.arc(pose.shoulder.x - 1.5, pose.shoulder.y - 3, 4.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.pink; ctx.strokeStyle = COL.ink; ctx.lineWidth = SW * 0.78;
    ctx.beginPath(); ctx.ellipse(pose.pawNear.x + 1.8, pose.pawNear.y + 0.5, 3.4, 2.1, pose.frontArmNearAng * 0.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();

    // Drooping Santa hat
    if (season === 'christmas') {
      const hb = pose.hatBase, hm = pose.hatMid, ht = pose.hatTip;
      const traceCap = () => {
        ctx.beginPath(); ctx.moveTo(hb.x + 8, hb.y - 1);
        ctx.bezierCurveTo(hb.x + 1, hb.y - 23, hm.x - 10, hm.y - 4, ht.x, ht.y);
        ctx.bezierCurveTo(hm.x - 2, hm.y + 8, hb.x - 11, hb.y + 4, hb.x - 10, hb.y + 6);
        ctx.closePath();
      };
      ctx.save();
      traceCap(); ctx.fillStyle = COL.hatRed; ctx.fill();
      ctx.save(); traceCap(); ctx.clip();
      ctx.strokeStyle = COL.hatHi; ctx.lineWidth = 3.2;
      ctx.beginPath(); ctx.moveTo(hb.x + 6, hb.y - 4); ctx.quadraticCurveTo(hm.x + 2, hm.y - 8, ht.x + 2, ht.y - 2); ctx.stroke();
      ctx.fillStyle = COL.hatDark;
      ctx.beginPath(); ctx.moveTo(hm.x + 2, hm.y - 1); ctx.quadraticCurveTo(hm.x - 4, hm.y + 5, ht.x - 2, ht.y + 4);
      ctx.lineTo(hb.x - 13, hb.y + 9); ctx.lineTo(hb.x - 4, hb.y + 4); ctx.closePath(); ctx.fill();
      ctx.restore();
      traceCap(); ctx.strokeStyle = COL.ink; ctx.lineWidth = SW; ctx.stroke();
      const bPts = [];
      for (let i = 0; i < 5; i++) {
        const u = (i / 4) - 0.5, off = rotPt(u * 18, Math.abs(u) * 2.5 + 1, hb.ang);
        bPts.push({ x: hb.x + off.x, y: hb.y + off.y, r: i === 2 ? 4.3 : 3.6 });
      }
      drawFluffPuffs(bPts, SW * 0.95);
      drawFluffPuffs([
        { x: ht.x - 2.2, y: ht.y - 1.5, r: 3.3 }, { x: ht.x + 2.0, y: ht.y - 1.8, r: 3.1 },
        { x: ht.x - 1.8, y: ht.y + 2.0, r: 3.2 }, { x: ht.x + 1.8, y: ht.y + 1.8, r: 3.0 }, { x: ht.x, y: ht.y, r: 3.8 }
      ], SW * 0.9);
      ctx.restore();
    }

    // Front ear
    ctx.save(); ctx.translate(pose.ear.x, pose.ear.y); ctx.rotate(pose.ear.ang);
    ctx.fillStyle = COL.fur; ctx.beginPath(); ctx.ellipse(0, 0, 10.2, 11.2, -0.25, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.pink; ctx.beginPath(); ctx.ellipse(1.0, 0.5, 6.8, 7.8, -0.22, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.pinkHi; ctx.beginPath(); ctx.ellipse(-0.8, -2.0, 3.8, 4.4, -0.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COL.ink; ctx.lineWidth = SW; ctx.beginPath(); ctx.ellipse(0, 0, 10.2, 11.2, -0.25, 0.72, Math.PI * 2 - 0.12); ctx.stroke();
    ctx.restore();

    // Eye
    ctx.save(); ctx.translate(pose.eye.x, pose.eye.y); ctx.rotate(pose.headBaseAng);
    const happyEyes = (boopT > 0.18 || danceT > 0.1 || flipT > 0.05);
    if (napMode && !happyEyes) {
      ctx.strokeStyle = COL.eye; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(0, -1, 3.6, 0.2, Math.PI - 0.2); ctx.stroke();
    } else if (happyEyes) {
      ctx.strokeStyle = COL.eye; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.arc(0, 1.5, 3.6, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    } else if (blinkDur > 0) {
      ctx.strokeStyle = COL.eye; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(0, -1, 3.5, 0.2, Math.PI - 0.2); ctx.stroke();
    } else {
      ctx.fillStyle = COL.eye; ctx.beginPath(); ctx.ellipse(0, 0, 4.1, 4.3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(1.4, -1.4, 1.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,220,230,0.55)'; ctx.beginPath(); ctx.arc(-1.3, 1.5, 0.65, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // Whiskers + upturned pink nose
    ctx.save(); ctx.translate(pose.head.x, pose.head.y); ctx.rotate(pose.headBaseAng);
    ctx.strokeStyle = COL.whisker; ctx.lineWidth = 1.35;
    ctx.beginPath(); ctx.moveTo(4.2, 4.4); ctx.quadraticCurveTo(8.5, 2.2, 13.5, 1.6); ctx.moveTo(4.4, 6.2); ctx.quadraticCurveTo(9.0, 4.2, 13.8, 3.5); ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.translate(pose.nose.x, pose.nose.y); ctx.rotate(pose.headBaseAng - 0.15);
    ctx.fillStyle = COL.pink; ctx.strokeStyle = COL.pinkDark; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(0, 0, 3.3, 2.4, -0.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = COL.pinkHi; ctx.beginPath(); ctx.ellipse(0.5, -0.7, 1.4, 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    if (tailInFront) drawTail();
    ctx.restore();

    // Sparkles & zZz bubbles in box-local coords
    for (let i = sparkles.length - 1; i >= 0; i--) {
      const s = sparkles[i];
      if (s.life <= 0) { sparkles.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = s.life; ctx.fillStyle = s.col;
      if (s.text) {
        ctx.font = `bold ${Math.round(s.r)}px "Segoe UI", sans-serif`;
        ctx.fillText(s.text, HALF + s.x, HALF + s.y);
      } else {
        ctx.beginPath(); ctx.arc(HALF + s.x, HALF + s.y, s.r * s.life, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  function tick(ts) {
    if (!visible) { raf = 0; return; }
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    const t = ts * 0.001;
    const prevX = x, prevY = y;

    if (glide) {
      napMode = false;
      const u = Math.min(1, (ts - glide.t0) / Math.max(1, glide.dur));
      const e = u * u * u * (u * (u * 6 - 15) + 10);
      const inv = 1 - e;
      x = inv * inv * inv * glide.sx + 3 * inv * inv * e * glide.cx1 + 3 * inv * e * e * glide.cx2 + e * e * e * glide.tx;
      y = inv * inv * inv * glide.sy + 3 * inv * inv * e * glide.cy1 + 3 * inv * e * e * glide.cy2 + e * e * e * glide.ty;
      if (glide.isJump) {
        jumpPhase = 'air'; jumpT = u; jumpHeight = Math.sin(u * Math.PI) * 34;
      } else {
        jumpPhase = 'none'; jumpHeight = 0;
        speedBlend += (1.0 - speedBlend) * Math.min(1, dt * 14);
        gaitPhase += dt * 17.0;
      }
      if (u >= 1) {
        const cb = glide.onArrive; glide = null; jumpPhase = 'none'; jumpHeight = 0; lastActionTs = ts;
        if (cb) cb();
      }
    } else {
      speedBlend += (0 - speedBlend) * Math.min(1, dt * 10);
      if (ts - lastActionTs > 4200 && !dancing && flipT <= 0.01) {
        napMode = true;
      } else if (ts - lastActionTs > nextWanderDelayMs && !dancing && !napMode) {
        lastActionTs = ts; nextWanderDelayMs = 450 + Math.random() * 600;
        if (Math.random() < 0.35 && userX > 40 && userY > 40) {
          const ang = Math.random() * Math.PI * 2;
          moveTo(clamp(userX + Math.cos(ang) * 34, 36, window.innerWidth - 36), clamp(userY + Math.sin(ang) * 34, 44, window.innerHeight - 36), { boop: false, durationMs: 360 });
        }
      }
    }

    vx = dt > 0 ? (x - prevX) / dt : 0; vy = dt > 0 ? (y - prevY) / dt : 0;
    if (Math.abs(vx) > 20) facing = vx > 0 ? 1 : -1;

    if (flipT > 0) {
      flipT = Math.max(0, flipT - dt * 1.45);
      const p = 1.0 - flipT;
      jumpHeight = p < 0.12 ? 0 : Math.sin(clamp((p - 0.12) / 0.78, 0, 1) * Math.PI) * 44;
      if (Math.abs(p - 0.5) < 0.04) spawnSparkles(0, -18, 4);
    }
    if (boopT > 0) {
      boopT = Math.max(0, boopT - dt * 2.8);
      // Punchy nose-boop ricochet: forward impact -> spring kickback left & hop!
      const p = 1.0 - boopT;
      recoilX = p < 0.25 ? facing * (p / 0.25) * 6 : -facing * Math.sin(((p - 0.25) / 0.75) * Math.PI) * 16;
      recoilY = p < 0.25 ? 0 : -Math.sin(((p - 0.25) / 0.75) * Math.PI) * 9;
    } else {
      recoilX *= 0.8; recoilY *= 0.8;
    }
    if (danceT > 0) danceT = Math.max(0, danceT - dt);

    napBlend += ((napMode ? 1 : 0) - napBlend) * Math.min(1, dt * 4.5);
    if (napMode && napBlend > 0.7) {
      zzzTimer -= dt;
      if (zzzTimer <= 0) { zzzTimer = 0.95; spawnSparkles(facing * 18, -14, 1, 'z'); }
    }

    blinkTimer -= dt; if (blinkTimer <= 0) { blinkDur = 0.13; blinkTimer = 2.4 + Math.random() * 3.5; }
    if (blinkDur > 0) blinkDur = Math.max(0, blinkDur - dt);
    earTwitchTimer -= dt; if (earTwitchTimer <= 0) { earTwitch = 1.0; earTwitchTimer = 2.5 + Math.random() * 4.0; }
    if (earTwitch > 0) earTwitch *= Math.pow(0.002, dt);

    const velDrag = clamp(-vx * facing * 0.00045, -0.22, 0.22);
    const jumpDrag = jumpPhase === 'air' ? clamp((jumpT - 0.35) * 0.8, -0.18, 0.22) : 0;
    hatVel += (clamp(velDrag + jumpDrag * 0.5, -0.24, 0.24) - hatAng) * 160 * dt;
    hatVel *= Math.pow(0.06, dt); hatAng = clamp(hatAng + hatVel * dt, -0.28, 0.28);
    hatTipVel += (clamp(velDrag * 1.2 + jumpDrag * 0.9 + Math.sin(t * 3.5) * 0.08, -0.35, 0.35) - hatTipAng) * 110 * dt;
    hatTipVel *= Math.pow(0.08, dt); hatTipAng = clamp(hatTipAng + hatTipVel * dt, -0.38, 0.38);
    earVel += (velDrag * 0.65 - earAng) * 200 * dt; earVel *= Math.pow(0.05, dt); earAng += earVel * dt;

    // Update 7-node spring tail
    const idleW = (1 - speedBlend) * (jumpPhase === 'none' ? 1 : 0);
    for (let i = 0; i < 7; i++) {
      const frac = i / 6;
      const wave = Math.sin(t * (idleW > 0.5 ? 3.2 : 14.0) - i * 0.7) * (idleW > 0.5 ? 2.2 : 3.2) * frac * (1 - napBlend * 0.85);
      const ix = lerp(idleTail[i].x, napTail[i].x, napBlend);
      const iy = lerp(idleTail[i].y, napTail[i].y, napBlend);
      const tx = lerp(runTail[i].x, ix, idleW) + wave * (idleW > 0.5 ? 0.8 : 0.2);
      const ty = lerp(runTail[i].y, iy, idleW) + wave * (idleW > 0.5 ? 0.45 : 1.0);
      const stiff = i === 0 ? 1.0 : Math.min(1, dt * (18 - i * 1.4));
      tail[i].x += (tx - tail[i].x) * stiff; tail[i].y += (ty - tail[i].y) * stiff;
    }

    for (let i = sparkles.length - 1; i >= 0; i--) {
      const s = sparkles[i];
      s.life -= dt * (s.text ? 0.7 : 2.2);
      s.x += s.vx * dt; s.y += s.vy * dt; if (!s.text) s.vy += 180 * dt;
    }

    if (napMode && napAnchorEl && napAnchorEl.isConnected && !glide && flipT <= 0.01) {
      const r = napAnchorEl.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) { x = r.left + r.width * 0.5; y = r.top + r.height * 0.62 - 14; }
    }
    drawMouse(t);
    raf = requestAnimationFrame(tick);
  }

  function show() {
    if (typeof window.__dcNativeHost === 'function') {
      try { window.__dcNativeHost(JSON.stringify({ cmd: 'mouse', show: false })); } catch (e) {}
    }
    const c = ensureCanvas();
    visible = true; napMode = false; napBlend = 0;
    c.style.opacity = '1';
    lastTs = performance.now(); lastActionTs = lastTs;
    if (!raf) raf = requestAnimationFrame(tick);
  }

  function hide() {
    visible = false;
    if (glide && glide.onResolve) { const r = glide.onResolve; glide = null; r(); }
    glide = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (canvas) { canvas.style.opacity = '0'; if (ctx) ctx.clearRect(0, 0, BOX, BOX); }
  }

  function boop() {
    napMode = false;
    activeBoopKind = (boopStyle === 'random') ? (Math.random() < 0.5 ? 'nose' : 'paw') : boopStyle;
    boopT = 1.0;
    spawnSparkles(facing * 26, -6, 9);
  }

  function moveTo(tx, ty, opts) {
    if (!visible) return Promise.resolve();
    napMode = false;
    const o = opts || {};
    const sx = x, sy = y, dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy);
    const isJump = dist > 280;
    const arc = (Math.random() < 0.5 ? 1 : -1) * Math.min(54, Math.max(12, dist * 0.16));
    return new Promise((resolve) => {
      if (glide && glide.onResolve) { const prev = glide.onResolve; glide = null; prev(); }
      let settled = false;
      const done = () => { if (settled) return; settled = true; clearTimeout(safety); resolve(); };
      const dur = o.durationMs || Math.max(150, Math.min(340, 140 + dist * 0.35));
      const safety = setTimeout(() => { x = tx; y = ty; if (o.faceRight) facing = 1; glide = null; if (o.boop !== false) boop(); done(); }, dur + 160);
      glide = {
        sx, sy, tx, ty, isJump,
        cx1: sx + dx * 0.33 + arc * 0.4, cy1: sy + dy * 0.25 - arc,
        cx2: sx + dx * 0.72 - arc * 0.3, cy2: sy + dy * 0.85 + arc * 0.3,
        t0: performance.now(), dur, onResolve: done,
        onArrive: () => { if (o.faceRight) facing = 1; if (o.boop !== false) boop(); done(); }
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
    // Aim his pink nose tip (~+28px right, ~-7px up from anchor) directly onto the button/message!
    const bx = o.aimCenter ? (r.left + r.width * 0.5) : Math.max(48, Math.min(window.innerWidth - 20, r.right - 16));
    const by = r.top + r.height * 0.5;
    const tx = bx - 28;
    const ty = by + 7;
    return moveTo(tx, ty, Object.assign({ boop: true, faceRight: true }, o));
  }

  function napAt(nx, ny, anchorEl) {
    show();
    napAnchorEl = anchorEl || null;
    x = nx; y = ny - 14; facing = 1;
    napMode = true; napBlend = 1.0;
    glide = null; jumpPhase = 'none'; jumpHeight = 0;
  }

  function backflip() {
    if (!visible) return;
    napMode = false; napBlend = 0; napAnchorEl = null;
    flipT = 1.0;
    spawnSparkles(0, -12, 12);
  }

  async function victoryDance(closeBtnEl) {
    if (!visible) return;
    dancing = true; napMode = false; danceT = 1.8;
    // Joyful 360 backflip celebration!
    flipT = 1.0;
    spawnSparkles(0, -12, 12);
    await new Promise(r => setTimeout(r, 760));
    if (closeBtnEl && visible) {
      await moveToElement(closeBtnEl, { aimCenter: true, durationMs: 260, boop: true });
      await new Promise(r => setTimeout(r, 180));
    }
    dancing = false;
  }

  function setSeason(s) { season = s || 'none'; }
  function getSeason() { return season; }
  function setBoopStyle(s) { boopStyle = s || 'nose'; }
  function destroy() {
    hide();
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onUserMove);
    if (canvas) { try { canvas.remove(); } catch (e) {} canvas = null; ctx = null; }
    delete window.__dcMouseCursor;
  }

  window.__dcMouseCursor = {
    version: 7, show, hide, moveTo, moveToElement, boop, victoryDance, napAt, backflip,
    setSeason, getSeason, setBoopStyle, destroy
  };
  return 'mounted';
})();
