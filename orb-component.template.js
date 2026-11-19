/*!
 * Voice Orb, web component <voice-orb>
 * __STAMP__
 *
 * One file, no dependencies. Works in plain HTML and in any framework (Ionic Angular / React / Vue),
 * including Capacitor native builds, because it only needs a WebView with WebGL2.
 *
 * ---- Use ----
 *   import './voice-orb.js';                         // once, anywhere (e.g. main.ts)
 *   <voice-orb></voice-orb>                          // the look chosen in the Voice Orb page is the default
 *   <voice-orb state="thinking"></voice-orb>         // attributes override it: state, orb, theme, sens, size, speed, background
 *
 *   const orb = document.querySelector('voice-orb');
 *   orb.state = 'speaking';                          // 'idle' | 'speaking' | 'thinking' | 'error' (eases over 1.4 s)
 *   await orb.useMicrophone();                       // user's voice -> drives Idle (call from a tap on iOS)
 *   orb.stopMicrophone();
 *   orb.attachAIVoice(audioElOrMediaStream);         // assistant's voice -> drives Speaking
 *   orb.playIntro();                                 // replay the opening (a few dots or glass beads -> voice waveform -> orb, ~4 s)
 *   <voice-orb intro="off"></voice-orb>              // the opening plays when the element first appears; this skips it
 *
 * ---- Size ----
 *   The orb fills the element. Default is width 100% and square; set width/height in CSS to change it.
 *   `size` scales the orb inside that box (1 = same framing as the Voice Orb page).
 *
 * ---- Ionic Angular ----
 *   Add CUSTOM_ELEMENTS_SCHEMA to the component or module that uses <voice-orb>.
 * ---- Capacitor (native) ----
 *   The microphone needs the native permission: NSMicrophoneUsageDescription in iOS Info.plist,
 *   RECORD_AUDIO in the Android manifest.
 */
(() => {
  if (customElements.get('voice-orb')) return;

  // The look exported from the Voice Orb page. Attributes on the element override these.
  const DEFAULTS = /*__CONFIG__*/null || { orb: 'dots', theme: 'auto', state: 'idle', sens: 1, size: 1, speed: 1,
                                           background: null, edges: 'broken', sat: 1.45 };
  // Shaders, copied verbatim from the Voice Orb page at export time.
  const SH = /*__SHADERS__*/null;

  const STATES = ['idle', 'speaking', 'thinking', 'error'];
  const MERIDIANS = 140, PER_LINE = 110, COUNT = MERIDIANS * PER_LINE;
  const RIBBONS = 3, RIB_ALONG = 320, RIB_ACROSS = 24, SH_U = 160, SH_V = 80;
  const MORPH_SECS = 1.4;
  const INTRO_END = 4.1; // opening length in seconds
  const SPEECH = { syl: 4.2, phr: 0.3 };
  const BG = { dark: [0.027, 0.043, 0.078], light: [0.953, 0.961, 0.976] };
  const SILENT = { level: 0, bass: 0, mid: 0, high: 0 };

  function hexColor(s) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, c => c + c);
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  function speechEnv(s, f = SPEECH) {
    const syl = Math.pow(Math.abs(Math.sin(Math.PI * f.syl * s)), 1.6);
    const ph = Math.sin(2 * Math.PI * f.phr * s) + 0.5 * Math.sin(4 * Math.PI * f.phr * s + 1.7);
    const x = Math.min(1, Math.max(0, (ph + 0.6) / 1.0));
    return (0.25 + 0.75 * syl) * (0.15 + 0.85 * x * x * (3 - 2 * x));
  }

  class VoiceOrbElement extends HTMLElement {
    static get observedAttributes() { return ['state', 'orb', 'theme', 'sens', 'size', 'speed', 'background']; }

    constructor() {
      super();
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{display:block;width:100%;aspect-ratio:1/1;position:relative;contain:strict}'
        + ':host([hidden]){display:none}canvas{position:absolute;inset:0;width:100%;height:100%;display:block}</style>'
        + '<canvas part="canvas" aria-hidden="true"></canvas>';
      this._canvas = root.querySelector('canvas');
      this._raf = 0;
      this._visible = true;
      this._ctx = null; this._userBus = null; this._aiBus = null; this._stream = null; this._micSrc = null;
      this._aiElements = new Set(); this._aiStreams = new Set(); this._aiNodes = new Map();
      this.live = { level: 0, bass: 0, mid: 0, high: 0 };
      this._liveUser = { level: 0, bass: 0, mid: 0, high: 0 };
      this._liveAI = { level: 0, bass: 0, mid: 0, high: 0 };
    }

    // ---- Settings (attribute > exported default) ----
    _opt(name) {
      const a = this.getAttribute(name);
      return a == null ? DEFAULTS[name] : a;
    }
    _num(name, lo, hi) {
      const v = Number(this._opt(name));
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULTS[name];
    }
    get state() { return this._state || this._initialState(); }
    set state(name) { this.setState(name); }
    setState(name) {
      if (!STATES.includes(name)) throw new Error('Unknown state: ' + name + ' (use ' + STATES.join(', ') + ')');
      this._state = name;
      if (this.getAttribute('state') !== name) this.setAttribute('state', name);
    }
    _initialState() {
      const s = this._opt('state');
      return STATES.includes(s) ? s : 'idle';
    }

    attributeChangedCallback(name, oldV, newV) {
      if (name === 'state') { if (STATES.includes(newV)) this._state = newV; return; }
      if (!this.gl) return;
      if (name === 'theme' || name === 'background') this._applyTheme();
      if (name === 'size') this._resize();
    }

    // Replay the opening: a few dots (Dots) or glass beads (Glass) open into a voice waveform, then become the orb.
    playIntro() { this._introT = this._reduceMotion ? INTRO_END : 0; }

    connectedCallback() {
      if (!this.gl && !this._init()) return;
      if (this._introT == null) this._introT = this.getAttribute('intro') === 'off' || this._reduceMotion ? INTRO_END : 0;
      this._state = this._initialState();
      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(this);
      this._io = new IntersectionObserver(es => { this._visible = es.some(e => e.isIntersecting); });
      this._io.observe(this);
      this._mq = window.matchMedia('(prefers-color-scheme: dark)');
      this._onScheme = () => this._applyTheme();
      this._mq.addEventListener('change', this._onScheme);
      this._resize();
      this._applyTheme();
      this._last = performance.now();
      const loop = now => { this._raf = requestAnimationFrame(loop); this._frame(now); };
      this._raf = requestAnimationFrame(loop);
    }

    disconnectedCallback() {
      cancelAnimationFrame(this._raf);
      if (this._ro) this._ro.disconnect();
      if (this._io) this._io.disconnect();
      if (this._mq) this._mq.removeEventListener('change', this._onScheme);
      this.stopMicrophone();
      // Ionic keeps pages in the DOM while navigating, so the GL context is kept for a quick return.
      // Call orb.destroy() to free it for good.
    }

    destroy() {
      this.disconnectedCallback();
      this._aiNodes.forEach(n => n.disconnect());
      this._aiNodes.clear(); this._aiElements.clear(); this._aiStreams.clear();
      if (this._ctx) { this._ctx.close(); this._ctx = null; }
      const lose = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      this.gl = null;
    }

    // ---- WebGL setup (same programs and meshes as the page) ----
    _init() {
      const gl = this._canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
      if (!gl) { console.warn('<voice-orb>: WebGL2 is not available.'); return false; }
      this.gl = gl;
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        return sh;
      };
      const program = (v, f) => {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, v));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, f));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
      };

      // Dots
      const uv = new Float32Array(COUNT * 2);
      for (let m = 0, i = 0; m < MERIDIANS; m++) for (let k = 0; k < PER_LINE; k++, i += 2) { uv[i] = m / MERIDIANS; uv[i + 1] = (k + 0.5) / PER_LINE; }
      this.prog = program(SH.vs, SH.fs);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.U = {};
      ['uTimeL','uTimeT','uRotL','uSpinT','uFlowT','uMorph','uLevel','uBass','uMid','uHigh','uPass','uDpr','uFit','uLight','uLoopP','uSpeak','uSpeakE','uGray','uIntroOn','uIntroT'].forEach(n => this.U[n] = gl.getUniformLocation(this.prog, n));

      // Glass
      this.gprog = program(SH.gvs, SH.gfs);
      const gVerts = [], gIdx = [];
      const grid = (nu, nv, kind, vMap) => {
        const base = gVerts.length / 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) gVerts.push(i / nu, vMap(j / nv), kind);
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
          const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
          gIdx.push(a, b, c, b, d, c);
        }
      };
      grid(SH_U, SH_V, -1, v => v);
      for (let r = 0; r < RIBBONS; r++) grid(RIB_ALONG, RIB_ACROSS, r, v => v * 2 - 1);
      this.gvao = gl.createVertexArray();
      gl.bindVertexArray(this.gvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gVerts), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(gIdx), gl.STATIC_DRAW);
      this.G_COUNT = gIdx.length;
      gl.bindVertexArray(this.vao);
      this.GU = {};
      ['uTimeL','uTimeT','uSpinL','uSpinT','uFlowL','uFlowT','uLevel','uBass','uHigh','uMorph','uFit','uLight','uBreak','uLoopP','uLoopFT','uSpeak','uSpeakE','uGray','uIntroOn','uIntroT'].forEach(n => this.GU[n] = gl.getUniformLocation(this.gprog, n));
      const sat = Number(DEFAULTS.sat);
      this.glassSat = Number.isFinite(sat) && sat > 0 ? Math.min(3, sat) : 1.45;
      gl.useProgram(this.gprog);
      gl.uniform1f(this.GU.uBreak, DEFAULTS.edges === 'solid' ? 0 : 1);

      // Bloom (dark theme, glass only)
      this.blurProg = program(SH.postVs, SH.blurFs);
      this.compProg = program(SH.postVs, SH.compFs);
      this.BU = { tex: gl.getUniformLocation(this.blurProg, 'uTex'), dir: gl.getUniformLocation(this.blurProg, 'uDir') };
      const c = this.compProg;
      this.CU = { scene: gl.getUniformLocation(c, 'uScene'), bloom: gl.getUniformLocation(c, 'uBloom'), bg: gl.getUniformLocation(c, 'uBg'),
                  glow: gl.getUniformLocation(c, 'uGlow'), sat: gl.getUniformLocation(c, 'uSat'), flip: gl.getUniformLocation(c, 'uFlipY') };
      this.postVao = gl.createVertexArray();
      this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
      this.rt = null;

      gl.useProgram(this.prog);
      gl.enable(gl.BLEND);

      // Animation state
      const st = this._initialState();
      this._reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._rot = 0; this._motionTime = 0; this._spin = 0; this._flow = 0;
      this._morphP = st === 'thinking' || st === 'error' ? 1 : 0;
      this._speakP = st === 'speaking' ? 1 : 0; this._speakAmt = this._speakP;
      this._grayP = st === 'error' ? 1 : 0; this._grayAmt = this._grayP;
      this._canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); cancelAnimationFrame(this._raf); });
      return true;
    }

    _target(w, h) {
      const gl = this.gl, hdr = this.floatOK;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, hdr ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { tex, fbo, w, h };
    }

    _resize() {
      const gl = this.gl;
      if (!gl) return;
      this._dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, this._canvas.clientWidth), h = Math.max(1, this._canvas.clientHeight);
      const cw = Math.round(w * this._dpr), ch = Math.round(h * this._dpr);
      const s = 0.6 * this._num('size', 0.4, 1.6);
      this._fit = w > h ? [s * h / w, s] : [s, s * w / h];
      if (this._canvas.width === cw && this._canvas.height === ch && this.rt) return;
      this._canvas.width = cw; this._canvas.height = ch;
      if (this.rt) [this.rt.scene, this.rt.a, this.rt.b].forEach(t => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); });
      const qw = Math.max(1, cw >> 2), qh = Math.max(1, ch >> 2);
      this.rt = { scene: this._target(cw, ch), a: this._target(qw, qh), b: this._target(qw, qh) };
    }

    _applyTheme() {
      const gl = this.gl;
      if (!gl) return;
      const t = this._opt('theme');
      const light = t === 'light' || (t !== 'dark' && !window.matchMedia('(prefers-color-scheme: dark)').matches);
      this._light = light;
      this._bg = hexColor(this._opt('background')) || (light ? BG.light : BG.dark);
      gl.useProgram(this.gprog); gl.uniform1f(this.GU.uLight, light ? 1 : 0);
      gl.useProgram(this.prog); gl.uniform1f(this.U.uLight, light ? 1 : 0);
      gl.blendFunc(gl.ONE, light ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE);
      gl.clearColor(this._bg[0], this._bg[1], this._bg[2], 1);
    }

    // ---- Audio: two channels, user (mic -> Idle) and AI (assistant voice -> Speaking) ----
    _ensureAudio() {
      if (this._ctx) return;
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      const bus = () => {
        const an = this._ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.6;
        return { an, freq: new Uint8Array(an.frequencyBinCount), wave: new Uint8Array(an.fftSize) };
      };
      this._userBus = bus();
      this._aiBus = bus();
    }
    async useMicrophone() {
      if (this._stream) return;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Microphone needs a secure context (https or the native app).');
      this._ensureAudio();
      await this._ctx.resume();
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this._micSrc = this._ctx.createMediaStreamSource(this._stream);
      this._micSrc.connect(this._userBus.an); // not sent to the speakers, so no feedback
    }
    stopMicrophone() {
      if (this._stream) this._stream.getTracks().forEach(t => t.stop());
      if (this._micSrc) this._micSrc.disconnect();
      this._stream = null; this._micSrc = null;
    }
    // <audio>/<video> keeps playing through the speakers; a MediaStream (e.g. WebRTC) is only analysed.
    attachAIVoice(source) {
      this._ensureAudio();
      this._ctx.resume();
      if (this._aiNodes.has(source)) return this._aiNodes.get(source);
      let node;
      if (source instanceof MediaStream) {
        node = this._ctx.createMediaStreamSource(source);
        node.connect(this._aiBus.an);
        this._aiStreams.add(node);
        source.getAudioTracks().forEach(tr => tr.addEventListener('ended', () => this.detachAIVoice(source)));
      } else {
        node = this._ctx.createMediaElementSource(source);
        node.connect(this._aiBus.an);
        node.connect(this._ctx.destination);
        this._aiElements.add(source);
      }
      this._aiNodes.set(source, node);
      return node;
    }
    detachAIVoice(source) {
      const node = this._aiNodes.get(source);
      if (!node) return;
      this._aiStreams.delete(node);
      if (this._aiElements.has(source)) { this._aiElements.delete(source); node.disconnect(this._aiBus.an); } // keeps playing
      else node.disconnect();
      this._aiNodes.delete(source);
    }
    _userOn() { return !!this._stream; }
    _aiOn() { return this._aiStreams.size > 0 || [...this._aiElements].some(el => !el.paused && !el.ended); }
    _measure(bus) {
      bus.an.getByteFrequencyData(bus.freq);
      bus.an.getByteTimeDomainData(bus.wave);
      let rms = 0;
      for (let i = 0; i < bus.wave.length; i++) { const v = (bus.wave[i] - 128) / 128; rms += v * v; }
      const nyq = this._ctx.sampleRate / 2, n = bus.freq.length;
      const band = (lo, hi) => {
        const a = Math.max(1, Math.floor(lo / nyq * n)), b = Math.min(n - 1, Math.ceil(hi / nyq * n));
        let sum = 0;
        for (let i = a; i <= b; i++) sum += bus.freq[i];
        return sum / ((b - a + 1) * 255);
      };
      return { level: Math.sqrt(rms / bus.wave.length) * 4, bass: band(40, 250) * 1.6, mid: band(250, 2000) * 1.8, high: band(2000, 8000) * 2.6 };
    }
    _follow(into, target) {
      const k = this._num('sens', 0.3, 6);
      for (const key in into) {
        const v = Math.min(2.4, target[key] * k);
        into[key] += (v - into[key]) * (v > into[key] ? 0.45 : 0.07);
      }
    }

    // ---- One frame (same maths as the page) ----
    _advanceMorph(dt, speed) {
      const st = this.state;
      const step = this._reduceMotion ? 1 : dt / MORPH_SECS;
      const target = st === 'thinking' || st === 'error' ? 1 : 0;
      this._morphP += Math.max(-step, Math.min(step, target - this._morphP));
      this._speakP += Math.max(-step, Math.min(step, (st === 'speaking' ? 1 : 0) - this._speakP));
      this._speakAmt = this._speakP * this._speakP * (3 - 2 * this._speakP);
      this._grayP += Math.max(-step, Math.min(step, (st === 'error' ? 1 : 0) - this._grayP));
      this._grayAmt = this._grayP * this._grayP * (3 - 2 * this._grayP);
      const m = this._morphP * this._morphP * (3 - 2 * this._morphP);
      const tt = this._motionTime;
      const pace = 1 + 0.35 * m * (Math.sin(tt * 0.53) * 0.6 + Math.sin(tt * 1.37 + 0.8) * 0.4);
      this._spin += dt * speed * (0.18 + 0.3 * this.live.level) * (1 + 1.6 * m) * pace;
      this._flow += dt * speed * (0.35 + 0.9 * m) * (2 - pace);
      return m;
    }
    _liveSpeak() {
      const k = this._speakAmt, ai = this._aiOn(), user = this._userOn(), t = this._motionTime;
      const e = ai ? Math.min(1, this._liveAI.level * 1.6) : speechEnv(t);
      const calm = 0.06 * (0.6 + 0.4 * Math.sin(t * 0.9));
      const f = { level: 1, bass: 0.9, mid: 0.8, high: 0.7 };
      for (const key in this.live) {
        const u = user ? this._liveUser[key] : calm * f[key];
        const a = ai ? this._liveAI[key] : 0.55 * e * f[key];
        this.live[key] = (1 - k) * u + k * a;
      }
      const L = this.live;
      return { speak: k, speakE: e, gray: this._grayAmt, level: L.level, bass: L.bass, mid: L.mid, high: L.high };
    }
    _setSpeak(L, st) {
      const gl = this.gl;
      gl.uniform1f(L.uSpeak, st.speak || 0);
      gl.uniform1f(L.uSpeakE, st.speakE || 0);
      gl.uniform1f(L.uGray, st.gray || 0);
    }

    _frame(now) {
      const gl = this.gl;
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      if (!gl || !this._visible || document.hidden) return;
      if (this._ctx) {
        this._follow(this._liveUser, this._userOn() ? this._measure(this._userBus) : SILENT);
        this._follow(this._liveAI, this._aiOn() ? this._measure(this._aiBus) : SILENT);
      }
      const speed = this._num('speed', 0, 3) * (this._reduceMotion ? 0.3 : 1);
      this._motionTime += dt * speed;
      this._rot += dt * speed * (0.12 + this.live.level * 0.25);
      const W = this._canvas.width, H = this._canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const m = this._advanceMorph(dt, speed);
      const t = this._motionTime;
      this._introT = Math.min(INTRO_END, this._introT + dt);
      const intro = { introOn: this._introT < INTRO_END ? 1 : 0, introT: this._introT };
      if (this._opt('orb') === 'glass') {
        const st = Object.assign({ timeL: t, timeT: t, spinL: this._spin, spinT: this._spin, flowL: this._flow, flowT: this._flow,
                                   morph: m, fit: this._fit }, intro, this._liveSpeak());
        this._renderGlass(st, this._light ? null : this.rt, W, H);
      } else {
        this._renderDots(Object.assign({ timeL: t, timeT: t, rotL: this._rot, spinT: this._spin, flowT: this._flow, morph: m,
                                         fit: this._fit }, intro, this._liveSpeak()), W, H);
      }
    }

    _renderDots(st, w, h) {
      const gl = this.gl, U = this.U;
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.uniform1f(U.uTimeL, st.timeL); gl.uniform1f(U.uTimeT, st.timeT);
      gl.uniform1f(U.uRotL, st.rotL); gl.uniform1f(U.uSpinT, st.spinT); gl.uniform1f(U.uFlowT, st.flowT);
      gl.uniform1f(U.uMorph, st.morph);
      gl.uniform1f(U.uLoopP, 0);
      this._setSpeak(U, st);
      gl.uniform1f(U.uIntroOn, st.introOn || 0); gl.uniform1f(U.uIntroT, st.introT || 0);
      gl.uniform1f(U.uLevel, st.level); gl.uniform1f(U.uBass, st.bass); gl.uniform1f(U.uMid, st.mid); gl.uniform1f(U.uHigh, st.high);
      gl.uniform2f(U.uFit, st.fit[0], st.fit[1]);
      gl.uniform1f(U.uDpr, this._dpr);
      gl.uniform1f(U.uPass, 1); gl.drawArrays(gl.POINTS, 0, COUNT); // halo
      gl.uniform1f(U.uPass, 0); gl.drawArrays(gl.POINTS, 0, COUNT); // crisp lines
    }

    _renderGlass(st, rt, w, h) {
      const gl = this.gl, GU = this.GU;
      gl.useProgram(this.gprog);
      gl.bindVertexArray(this.gvao);
      gl.uniform2f(GU.uFit, st.fit[0], st.fit[1]);
      gl.uniform1f(GU.uTimeL, st.timeL); gl.uniform1f(GU.uTimeT, st.timeT);
      gl.uniform1f(GU.uSpinL, st.spinL); gl.uniform1f(GU.uSpinT, st.spinT);
      gl.uniform1f(GU.uFlowL, st.flowL); gl.uniform1f(GU.uFlowT, st.flowT);
      gl.uniform1f(GU.uLoopP, 0); gl.uniform1f(GU.uLoopFT, 0);
      gl.uniform1f(GU.uIntroOn, st.introOn || 0); gl.uniform1f(GU.uIntroT, st.introT || 0);
      this._setSpeak(GU, st);
      gl.uniform1f(GU.uLevel, st.level); gl.uniform1f(GU.uBass, st.bass); gl.uniform1f(GU.uHigh, st.high);
      gl.uniform1f(GU.uMorph, st.morph);
      if (!rt) { gl.drawElements(gl.TRIANGLES, this.G_COUNT, gl.UNSIGNED_SHORT, 0); return; } // light theme

      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.scene.fbo);
      gl.viewport(0, 0, rt.scene.w, rt.scene.h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawElements(gl.TRIANGLES, this.G_COUNT, gl.UNSIGNED_SHORT, 0);

      gl.disable(gl.BLEND);
      gl.useProgram(this.blurProg);
      gl.bindVertexArray(this.postVao);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.BU.tex, 0);
      const pass = (src, dst, dx, dy) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(this.BU.dir, dx / src.w, dy / src.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      pass(rt.scene, rt.a, 0, 0);
      pass(rt.a, rt.b, 1, 0); pass(rt.b, rt.a, 0, 1);
      pass(rt.a, rt.b, 2.5, 0); pass(rt.b, rt.a, 0, 2.5);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.compProg);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rt.scene.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, rt.a.tex);
      gl.uniform1i(this.CU.scene, 0); gl.uniform1i(this.CU.bloom, 1);
      const bg = this._bg;
      gl.uniform3f(this.CU.bg, bg[0], bg[1], bg[2]);
      gl.uniform1f(this.CU.glow, 0.6);
      gl.uniform1f(this.CU.sat, this.glassSat);
      gl.uniform1f(this.CU.flip, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
    }
  }

  customElements.define('voice-orb', VoiceOrbElement);
})();
