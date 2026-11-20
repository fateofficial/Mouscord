// High-Performance GPU WebGL2 Point-Sprite Snow Shader (window.__dcSnowShader v2)
// Draws 220 gl.POINTS instead of a fullscreen fragment pass to keep fill-rate low.
(function() {
  if (window.__dcSnowShader && window.__dcSnowShader.version === 3) {
    return 'already-mounted';
  }
  if (window.__dcSnowShader && typeof window.__dcSnowShader.destroy === 'function') {
    try { window.__dcSnowShader.destroy(); } catch (e) {}
  }

  const STORAGE_KEY = 'dc_snow_enabled_v1';
  const FLAKE_COUNT = 220;
  let enabled = false;
  try { enabled = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) {}

  let canvas = null, gl = null, prog = null, vao = null, uTime = null, uRes = null, raf = 0, t0 = 0;

  const VS = `#version 300 es
  layout(location=0) in vec4 a_seed; // x: baseX [0..1], y: baseY [0..1], z: depth [0.2..1.0], w: phase
  uniform float u_time;
  uniform vec2 u_res;
  out float v_alpha;

  void main() {
    float depth = a_seed.z;
    float speed = mix(0.025, 0.11, depth);
    float wind  = mix(0.012, 0.045, depth);
    float y = fract(a_seed.y - u_time * speed);
    float x = fract(a_seed.x + sin(u_time * (0.4 + depth * 0.5) + a_seed.w) * wind + u_time * wind * 0.35);
    gl_Position = vec4(x * 2.0 - 1.0, y * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = mix(2.2, 6.5, depth);
    float tw = 0.72 + 0.28 * sin(u_time * (1.8 + depth * 2.5) + a_seed.w);
    v_alpha = mix(0.16, 0.48, depth) * tw;
  }`;

  const FS = `#version 300 es
  precision mediump float;
  in float v_alpha;
  out vec4 o;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.12, d);
    float a = soft * v_alpha;
    o = vec4(vec3(0.92, 0.96, 1.0) * a, a);
  }`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  function initGl() {
    if (canvas && canvas.isConnected && gl) return true;
    canvas = document.createElement('canvas');
    canvas.id = 'dc-snow-shader-canvas';
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:99980;';
    document.body.appendChild(canvas);
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) { canvas.remove(); canvas = null; return false; }

    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    uTime = gl.getUniformLocation(prog, 'u_time');
    uRes  = gl.getUniformLocation(prog, 'u_res');

    const data = new Float32Array(FLAKE_COUNT * 4);
    for (let i = 0; i < FLAKE_COUNT; i++) {
      data[i * 4 + 0] = Math.random();
      data[i * 4 + 1] = Math.random();
      // Power curve puts more tiny distant flakes and fewer large near flakes
      data[i * 4 + 2] = 0.18 + Math.pow(Math.random(), 1.8) * 0.82;
      data[i * 4 + 3] = Math.random() * Math.PI * 2;
    }

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    resize();
    window.addEventListener('resize', resize);
    return true;
  }

  function resize() {
    if (!canvas || !gl) return;
    // Half-resolution canvas: less compositor bandwidth; snow is soft anyway.
    canvas.width = Math.max(1, Math.round(window.innerWidth * 0.5));
    canvas.height = Math.max(1, Math.round(window.innerHeight * 0.5));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function frame(now) {
    if (!enabled || !gl) { raf = 0; return; }
    if (!t0) t0 = now;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform1f(uTime, (now - t0) * 0.001);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.POINTS, 0, FLAKE_COUNT);
    raf = requestAnimationFrame(frame);
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (e) {}
    if (typeof window.__dcNativeHost === 'function') {
      try { window.__dcNativeHost(JSON.stringify({ cmd: 'snow', on: enabled })); } catch (e) {}
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (canvas) canvas.style.display = 'none';
      return enabled;
    }
    if (enabled) {
      if (initGl()) {
        canvas.style.display = 'block';
        if (!raf) raf = requestAnimationFrame(frame);
      }
    } else {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (canvas) canvas.style.display = 'none';
    }
    return enabled;
  }

  function destroy() {
    setEnabled(false);
    window.removeEventListener('resize', resize);
    if (canvas) { try { canvas.remove(); } catch (e) {} canvas = null; gl = null; }
    delete window.__dcSnowShader;
  }

  if (enabled) setEnabled(true);

  window.__dcSnowShader = {
    version: 3,
    isEnabled: () => enabled,
    setEnabled,
    toggle: () => setEnabled(!enabled),
    destroy
  };

  return 'mounted';
})();
