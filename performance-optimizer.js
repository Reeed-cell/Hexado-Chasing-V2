/* ═══════════════════════════════════════════════════════════════════════════
   performance-optimizer.js  —  HEXADO CHASING v2.0
   Layer   : Optimizer (load order: 13th — after HUD.js, before main.js)
   Exports : window.HexEngine.PerformanceOptimizer
   Deps    : HE.MathUtils (main-math.js)  ·  EventBus (constructor injection)
             THREE.WebGLRenderer (constructor injection — read .info only)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Monitors per-frame render time and emits PERFORMANCE_ADJUST on the
   EventBus when the rolling average crosses quality thresholds. Never
   mutates scene state directly — all changes flow through the event.

     ┌──────────────────────────────────────────────────────────────────────┐
     │  INPUT  : update(dt) called by main.js._loop() each frame           │
     │  OUTPUT : PERFORMANCE_ADJUST { particleBudget, lodLevel }           │
     │            → tornado.js   reduces debris particles + funnel rings   │
     │            → Render.js    reduces rain / ambient debris budget      │
     └──────────────────────────────────────────────────────────────────────┘

   Algorithm — rolling window + hysteresis
   ─────────────────────────────────────────
   1. Push dt (seconds) into a circular buffer of WINDOW_SIZE samples.
   2. Compute rolling average frame time (ms).
   3. Apply FPS thresholds with deadband hysteresis:
        avgMs > THRESHOLD_DOWN  →  attempt LOD downgrade
        avgMs < THRESHOLD_UP    →  attempt LOD upgrade
   4. Gate every level change behind COOLDOWN_S seconds to prevent
      rapid oscillation (the "thrash" problem on borderline GPUs).
   5. On any level change, emit PERFORMANCE_ADJUST with the new
      particleBudget and lodLevel.

   LOD level table
   ────────────────
     0 = Full      280 debris · 10 funnel rings  (target > 50fps / < 20ms)
     1 = Reduced   160 debris ·  7 funnel rings  (40-50fps   / 20-25ms)
     2 = Minimal    60 debris ·  4 funnel rings  (< 40fps    / > 25ms)

   Thresholds (ms per frame)
   ──────────────────────────
     THRESHOLD_DOWN : 20.0ms  =  50fps  →  triggers downgrade
     THRESHOLD_UP   : 14.0ms  =  71fps  →  triggers upgrade (with hysteresis)
   The 6ms deadband prevents hunting around 50fps.

   Debug access
   ─────────────
   window.game.perfOpt.debugInfo() — logs rolling avg, current LOD + budget.

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export — plain <script> tag
   • EventBus is the ONLY cross-module communication channel
   • THREE.WebGLRenderer is passed in, never imported
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

var _PERF = {

  /* ─── Rolling window ──────────────────────────────────────────────── */
  WINDOW_SIZE:       60,     // samples — one second at 60fps

  /* ─── FPS thresholds (frame time in ms) ──────────────────────────── */
  // Downgrade fires when rolling avg EXCEEDS this:
  THRESHOLD_DOWN:    20.0,   // 50fps — performance is suffering
  // Upgrade fires when rolling avg DROPS BELOW this:
  THRESHOLD_UP:      14.0,   // ~71fps — GPU has headroom to spare

  /* ─── Cooldown between LOD changes ───────────────────────────────── */
  // Prevents rapid oscillation on borderline hardware.
  COOLDOWN_S:         3.0,   // seconds

  /* ─── LOD levels 0-2 ─────────────────────────────────────────────── */
  LOD_MIN:            0,
  LOD_MAX:            2,

  /* ─── Particle budgets per LOD level ─────────────────────────────── */
  // Index = LOD level. Must match tornado.js DEBRIS_COUNT bounds.
  PARTICLE_BUDGETS:  [280, 160, 60],

  /* ─── Startup grace period ────────────────────────────────────────── */
  // Terrain generation, shader compilation, and environment build all
  // happen during init(). The first few frames carry that one-off cost
  // and would trigger a false downgrade without this guard.
  STARTUP_GRACE_S:    2.0    // seconds before first adjustment is allowed
};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.PerformanceOptimizer
   ═══════════════════════════════════════════════════════════════════════════ */

HE.PerformanceOptimizer = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(bus, renderer)

     bus      : HE.EventBus instance — used to emit PERFORMANCE_ADJUST
     renderer : THREE.WebGLRenderer  — read .info.render for triangle
                counts (available in r128 as renderer.info.render.triangles)
                Passed in rather than imported to keep coupling minimal.
  ───────────────────────────────────────────────────────────────────── */
  constructor(bus, renderer) {
    if (!bus || typeof bus.emit !== 'function') {
      console.error('[PerformanceOptimizer] EventBus is required.');
    }

    this._bus      = bus;
    this._renderer = renderer || null;   // optional — used for devtools readout

    /* ── Rolling frame-time buffer (circular) ── */
    // Pre-allocated Float32Array: no GC allocation on every push.
    this._samples     = new Float32Array(_PERF.WINDOW_SIZE);
    this._sampleIdx   = 0;     // next write position
    this._sampleCount = 0;     // how many valid samples are in the buffer

    /* ── Rolling sum — maintained incrementally to avoid per-frame scan ── */
    this._sum = 0;

    /* ── Current LOD state ── */
    this._lodLevel       = _PERF.LOD_MIN;
    this._particleBudget = _PERF.PARTICLE_BUDGETS[_PERF.LOD_MIN];

    /* ── Cooldown / grace timers ── */
    this._cooldownTimer = 0;   // seconds elapsed since last LOD change
    this._startupTimer  = 0;   // seconds elapsed since construction

    /* ── Statistics (exposed via debugInfo) ── */
    this._avgMs       = 0;
    this._peakMs      = 0;     // session high — useful for diagnosing spikes
    this._adjustCount = 0;     // total PERFORMANCE_ADJUST events emitted

    console.log('[PerformanceOptimizer] Ready — '
      + 'down: '   + _PERF.THRESHOLD_DOWN + 'ms  '
      + 'up: '     + _PERF.THRESHOLD_UP   + 'ms  '
      + 'window: ' + _PERF.WINDOW_SIZE    + ' samples  '
      + 'cooldown: ' + _PERF.COOLDOWN_S   + 's');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt)
     Called every frame from main.js._loop() AFTER all other sub-systems.
     Placing it last ensures dt accurately reflects the full frame cost.

     dt : frame delta (seconds, already capped to 0.05 by main.js)

     Sub-systems in order:
       1. Sample push   — add dt (in ms) to circular buffer, update sum
       2. Rolling avg   — sum / sample count
       3. Startup grace — ignore adjustments for first STARTUP_GRACE_S
       4. Cooldown tick — advance timer since last level change
       5. FPS judge     — compare avgMs to thresholds, attempt change
       6. Emit          — if level changed, broadcast PERFORMANCE_ADJUST
  ═══════════════════════════════════════════════════════════════════════ */

  update(dt) {

    /* ── 1. Sample push ── */
    var dtMs = dt * 1000;

    /* Evict the oldest sample from the running sum before overwriting it */
    this._sum -= this._samples[this._sampleIdx];

    /* Write new sample into the circular slot */
    this._samples[this._sampleIdx] = dtMs;
    this._sum += dtMs;

    /* Advance write head with wrap-around */
    this._sampleIdx = (this._sampleIdx + 1) % _PERF.WINDOW_SIZE;

    /* Track valid sample count (ramps up to WINDOW_SIZE on first cycle) */
    if (this._sampleCount < _PERF.WINDOW_SIZE) {
      this._sampleCount++;
    }

    /* ── 2. Rolling average ── */
    this._avgMs = this._sum / this._sampleCount;

    /* Session peak (only after buffer is warm — first frames carry init cost) */
    if (this._sampleCount >= 10 && dtMs > this._peakMs) {
      this._peakMs = dtMs;
    }

    /* ── 3. Startup grace period ── */
    this._startupTimer += dt;
    if (this._startupTimer < _PERF.STARTUP_GRACE_S) return;

    /* ── 4. Cooldown tick ── */
    this._cooldownTimer += dt;
    var cooledDown = (this._cooldownTimer >= _PERF.COOLDOWN_S);

    /* ── 5. FPS judge ──
       Only evaluate when:
         • Cooldown has elapsed since last change (no oscillation)
         • At least half the window is filled (30 samples = 0.5s of data)
       Both conditions must hold.                                         */
    if (!cooledDown || this._sampleCount < _PERF.WINDOW_SIZE * 0.5) return;

    var newLevel = this._lodLevel;

    if (this._avgMs > _PERF.THRESHOLD_DOWN && this._lodLevel < _PERF.LOD_MAX) {
      /* ── Downgrade: fps is suffering ── */
      newLevel = this._lodLevel + 1;

    } else if (this._avgMs < _PERF.THRESHOLD_UP && this._lodLevel > _PERF.LOD_MIN) {
      /* ── Upgrade: GPU has clear headroom ── */
      newLevel = this._lodLevel - 1;
    }

    /* ── 6. Emit if level changed ── */
    if (newLevel !== this._lodLevel) {
      this._applyLevel(newLevel);
    }
  }


  /* ─────────────────────────────────────────────────────────────────────
     _applyLevel(newLevel)
     Writes the new LOD state, resets the cooldown timer, and fires the
     PERFORMANCE_ADJUST event that tornado.js and Render.js listen for.

     newLevel : 0 | 1 | 2
  ───────────────────────────────────────────────────────────────────── */
  _applyLevel(newLevel) {
    var prev = this._lodLevel;

    this._lodLevel       = HE.MathUtils.clamp(newLevel, _PERF.LOD_MIN, _PERF.LOD_MAX);
    this._particleBudget = _PERF.PARTICLE_BUDGETS[this._lodLevel];

    /* Reset cooldown so we don't immediately re-evaluate */
    this._cooldownTimer = 0;
    this._adjustCount++;

    var direction = (newLevel > prev) ? 'DOWNGRADE' : 'UPGRADE';
    var levelNames = ['full', 'reduced', 'minimal'];

    console.log('[PerformanceOptimizer] '
      + direction
      + '  LOD ' + prev + ' (' + levelNames[prev] + ')'
      + ' → '
      + this._lodLevel + ' (' + levelNames[this._lodLevel] + ')'
      + '  |  particles: ' + this._particleBudget
      + '  |  avg: '       + this._avgMs.toFixed(1) + 'ms'
      + '  |  adj #'       + this._adjustCount);

    /* Emit — tornado.js and Render.js both listen on 'PERFORMANCE_ADJUST' */
    this._bus.emit('PERFORMANCE_ADJUST', {
      particleBudget: this._particleBudget,
      lodLevel:       this._lodLevel
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     READ-ONLY GETTERS  — exposed for main.js devtools inspection
  ═══════════════════════════════════════════════════════════════════════ */

  /** Current LOD level: 0 = full quality, 1 = reduced, 2 = minimal */
  get lodLevel() { return this._lodLevel; }

  /** Current active debris particle budget */
  get particleBudget() { return this._particleBudget; }

  /** Rolling average frame time in milliseconds */
  get avgMs() { return this._avgMs; }

  /** Rolling average expressed as fps */
  get avgFps() { return (this._avgMs > 0) ? (1000 / this._avgMs) : 0; }


  /* ═══════════════════════════════════════════════════════════════════════
     debugInfo()
     Full performance snapshot printed to the console.
     Usage: window.game.perfOpt.debugInfo()
  ═══════════════════════════════════════════════════════════════════════ */

  debugInfo() {
    var levelNames = ['full', 'reduced', 'minimal'];

    console.group('[PerformanceOptimizer] Debug snapshot');
    console.log('LOD level     : ' + this._lodLevel + ' (' + levelNames[this._lodLevel] + ')');
    console.log('Particle budget: ' + this._particleBudget);
    console.log('Rolling avg   : ' + this._avgMs.toFixed(2) + ' ms  ≈  ' + this.avgFps.toFixed(1) + ' fps');
    console.log('Session peak  : ' + this._peakMs.toFixed(2) + ' ms');
    console.log('Sample count  : ' + this._sampleCount + ' / ' + _PERF.WINDOW_SIZE);
    console.log('Adjust count  : ' + this._adjustCount);
    console.log('Cooldown timer: ' + this._cooldownTimer.toFixed(2) + 's / ' + _PERF.COOLDOWN_S + 's');
    console.log('Startup timer : ' + this._startupTimer.toFixed(2) + 's');

    /* Optional: renderer triangle + draw call count if THREE.WebGLRenderer available */
    if (this._renderer && this._renderer.info && this._renderer.info.render) {
      var ri = this._renderer.info.render;
      console.log('Triangles     : ' + (ri.triangles || 'N/A'));
      console.log('Draw calls    : ' + (ri.calls     || 'N/A'));
    }

    console.groupEnd();
  }


  /* ═══════════════════════════════════════════════════════════════════════
     forceLevel(level)
     Dev-tools override — bypasses cooldown and threshold checks entirely.
     Useful for testing how the game looks and performs at each LOD tier.
     Usage: window.game.perfOpt.forceLevel(2)   // force minimal
            window.game.perfOpt.forceLevel(0)   // restore full quality
  ═══════════════════════════════════════════════════════════════════════ */

  forceLevel(level) {
    var l = HE.MathUtils.clamp(Math.floor(level), _PERF.LOD_MIN, _PERF.LOD_MAX);
    console.log('[PerformanceOptimizer] forceLevel(' + l + ') — bypassing normal thresholds.');
    this._applyLevel(l);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP  — call on hot-reload or game restart
  ═══════════════════════════════════════════════════════════════════════ */

  dispose() {
    this._bus      = null;
    this._renderer = null;
    this._samples  = null;
    console.log('[PerformanceOptimizer] Disposed.');
  }

};
