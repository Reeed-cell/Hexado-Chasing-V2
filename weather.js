/* ═══════════════════════════════════════════════════════════════════════════
   weather.js  —  HEXADO CHASING v2.0
   Layer   : Systems (load order: 6th — after physics.js)
   Exports : window.HexEngine.WeatherSystem
   Deps    : HE.MathUtils (main-math.js) · HE.Noise (main-math.js)
             Three.js r128 (THREE.Vector3)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Owns the full storm lifecycle state machine and broadcasts every storm
   attribute downstream via EventBus. Nothing else in the project should
   track weather state — all modules subscribe to STORM_UPDATE.

     ┌──────────────────────────────────────────────────────────────────────┐
     │  STATE MACHINE                                                       │
     │    clear  →  forming  →  active  →  dissipating  →  clear  →  …    │
     │                                                                      │
     │  INTENSITY                                                           │
     │    clear=0 · forming: 0→1 (smootherstep) · active=1 · diss: 1→0   │
     │                                                                      │
     │  POSITION                                                            │
     │    Repositioned randomly at start of each clear phase               │
     │    Wanders slowly during active using Perlin-steered drift          │
     └──────────────────────────────────────────────────────────────────────┘

   Sub-systems (executed in order each update tick)
   ─────────────────────────────────────────────────
   1. State timer    — advance _stateElapsed, trigger transition when due
   2. Transition     — pick next state, randomise duration, reposition if needed
   3. Intensity ramp — smootherstep curve driven by progress through state
   4. Storm wander   — Perlin-noise heading drift during forming + active
   5. Emit throttle  — STORM_UPDATE fired at most at 20 Hz (same as physics)

   Public API  (matches SKILL.md contract)
   ──────────
     weather = new HE.WeatherSystem(bus)
     weather.update(dt)         ← called every frame by main.js._loop()
     weather.get pos()          → THREE.Vector3 (live ref — read-only)
     weather.get state()        → string
     weather.get intensity()    → 0..1

   STORM_UPDATE payload: { pos, intensity, visible, state }
     visible = true during forming / active / dissipating

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export — plain <script> tag
   • EventBus is the ONLY cross-module communication channel
   • THREE.Vector3 used for pos — Three.js guaranteed loaded before this file
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS  —  tune here, not buried in logic
   ═══════════════════════════════════════════════════════════════════════════ */

var _WX = {

  /* ─── State durations (seconds) ──────────────────────────── */
  // Each range is [min, max]; actual duration is randomised on transition.
  DUR_CLEAR:       [30,  80],
  DUR_FORMING:     [20,  35],
  DUR_ACTIVE:      [40, 130],
  DUR_DISSIPATING: [12,  24],

  /* ─── Storm spawn / wander world bounds ──────────────────── */
  // Storm always spawns at least SPAWN_MIN_DIST units from player origin.
  // Kept inside the Oklahoma terrain patch so it's always on-screen.
  SPAWN_MIN_DIST:  120,   // world units — minimum spawn distance from (0,0)
  SPAWN_MAX_DIST:  280,   // world units — maximum spawn distance
  SPAWN_X_RANGE:   90,    // ± X spread (wide plains)
  SPAWN_Z_RANGE:   220,   // ± Z spread (along the road corridor)

  /* ─── Storm wander (active / forming) ────────────────────── */
  // Storm drifts at a speed that scales with intensity — more intense = faster.
  WANDER_SPEED_MIN: 1.2,  // world units/s — calm wandering at EF0
  WANDER_SPEED_MAX: 4.5,  // world units/s — aggressive translation at EF5

  // Heading changes are driven by Perlin1 noise sampled at this frequency.
  WANDER_NOISE_FREQ: 0.04,   // lower = smoother heading changes
  WANDER_NOISE_SCALE: 1.8,   // radians — max heading perturbation per sample

  // Hard bounds: storm bounced back if it drifts outside these world coords.
  WANDER_X_LIMIT:  140,
  WANDER_Z_LIMIT:  280,

  /* ─── Emit throttle ──────────────────────────────────────── */
  // STORM_UPDATE fires at most once per EMIT_INTERVAL seconds.
  // Matches physics EMIT_INTERVAL (both at ~20 Hz) to avoid bus floods.
  EMIT_INTERVAL: 0.05

};


/* ═══════════════════════════════════════════════════════════════════════════
   STATE CONSTANTS  —  string literals in one place so typos are caught early
   ═══════════════════════════════════════════════════════════════════════════ */

var _ST = {
  CLEAR:       'clear',
  FORMING:     'forming',
  ACTIVE:      'active',
  DISSIPATING: 'dissipating'
};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.WeatherSystem
   ═══════════════════════════════════════════════════════════════════════════ */

HE.WeatherSystem = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(bus)
     bus : HE.EventBus instance — injected by main.js
  ───────────────────────────────────────────────────────────────────── */
  constructor(bus) {
    if (!bus || typeof bus.emit !== 'function') {
      console.error('[WeatherSystem] EventBus is required.');
    }
    this._bus = bus;

    /* ── State machine ── */
    this._state        = _ST.CLEAR;
    this._stateElapsed = 0;       // seconds elapsed in current state
    this._stateDur     = this._randomDur(_WX.DUR_CLEAR);
    this._stateProgress = 0;      // 0..1 progress through current state

    /* ── Intensity ── */
    // Smoothed output 0..1 — set each frame from _stateProgress + curve.
    this._intensity    = 0;

    /* ── Storm world position ── */
    // THREE.Vector3 kept at Y=0 (ground level). Listeners read .x and .z.
    // Initialised off-screen; repositioned on first clear → forming transition.
    this._pos          = new THREE.Vector3(180, 0, 200);

    /* ── Wander heading ── */
    // Current travel heading (radians). Updated each frame during active/forming.
    this._wanderHeading = Math.random() * Math.PI * 2;

    /* ── Accumulated time (used as noise seed) ── */
    this._time         = 0;

    /* ── Emit throttle ── */
    this._emitTimer    = 0;

    /* ── Perform an immediate repositioning so the storm has a valid
          starting position before the first transition. ── */
    this._repositionStorm();

    console.log('[WeatherSystem] Ready — first storm in '
      + this._stateDur.toFixed(1) + 's.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt)
     Main per-frame tick. Called by main.js._loop().

     dt : frame delta time in seconds (already capped to 0.05 by main.js)

     Runs 5 sub-systems in order:
       state timer → transition check → intensity ramp → wander → emit
  ═══════════════════════════════════════════════════════════════════════ */

  update(dt) {

    /* Guard: if bus went away (teardown), do nothing. */
    if (!this._bus) return;

    this._time         += dt;
    this._stateElapsed += dt;
    this._stateProgress = HE.MathUtils.clamp(
      this._stateElapsed / this._stateDur, 0, 1
    );

    /* ── 1. STATE TRANSITION CHECK ── */
    if (this._stateElapsed >= this._stateDur) {
      this._advanceState();
    }

    /* ── 2. INTENSITY RAMP ── */
    this._updateIntensity();

    /* ── 3. STORM WANDER ── */
    // Storm only moves when it's actually present in the world.
    if (this._state === _ST.FORMING || this._state === _ST.ACTIVE) {
      this._updateWander(dt);
    }

    /* ── 4. EMIT STORM_UPDATE (throttled to 20 Hz) ── */
    this._emitTimer += dt;
    if (this._emitTimer >= _WX.EMIT_INTERVAL) {
      this._emitTimer = 0;
      this._emitUpdate();
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _advanceState()
     Called when _stateElapsed reaches _stateDur.
     Transitions to next state, resets timer, picks new duration.

     Transition table:
       clear       → forming       (storm starts)
       forming     → active        (full tornado on ground)
       active      → dissipating   (tornado weakens)
       dissipating → clear         (calm returns)
  ═══════════════════════════════════════════════════════════════════════ */

  _advanceState() {
    var prev = this._state;

    switch (this._state) {
      case _ST.CLEAR:
        this._state    = _ST.FORMING;
        this._stateDur = this._randomDur(_WX.DUR_FORMING);
        /* Storm position already set; pick a fresh travel heading. */
        this._wanderHeading = Math.random() * Math.PI * 2;
        break;

      case _ST.FORMING:
        this._state    = _ST.ACTIVE;
        this._stateDur = this._randomDur(_WX.DUR_ACTIVE);
        break;

      case _ST.ACTIVE:
        this._state    = _ST.DISSIPATING;
        this._stateDur = this._randomDur(_WX.DUR_DISSIPATING);
        break;

      case _ST.DISSIPATING:
        this._state    = _ST.CLEAR;
        this._stateDur = this._randomDur(_WX.DUR_CLEAR);
        /* Reposition for the next cycle while the storm is invisible. */
        this._repositionStorm();
        break;

      default:
        this._state    = _ST.CLEAR;
        this._stateDur = this._randomDur(_WX.DUR_CLEAR);
        this._repositionStorm();
    }

    /* Reset elapsed counter for the new state. */
    this._stateElapsed  = 0;
    this._stateProgress = 0;

    console.log('[WeatherSystem] ' + prev + ' → ' + this._state
      + '  (duration: ' + this._stateDur.toFixed(1) + 's)');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateIntensity()
     Maps state + progress to a smooth 0..1 intensity value.

     • clear       → always 0
     • forming     → smootherstep 0..1  (ramps up as funnel descends)
     • active      → holds at 1.0  (with a very slight noise shimmer)
     • dissipating → smootherstep 1..0  (ramps down as funnel ropes out)

     Using smootherstep (6t⁵-15t⁴+10t³) — the highest-order Ken Perlin
     fade — so the intensity has zero derivative at both ends. This means
     tornado.js never sees an abrupt jump in funnel radius or debris speed.
  ═══════════════════════════════════════════════════════════════════════ */

  _updateIntensity() {
    var p = this._stateProgress;

    switch (this._state) {
      case _ST.CLEAR:
        /* Always exactly 0 during calm — no shimmer, no leakage. */
        this._intensity = 0;
        break;

      case _ST.FORMING:
        /* Ramp 0 → 1 over the full forming duration. */
        this._intensity = HE.MathUtils.smootherstep(0, 1, p);
        break;

      case _ST.ACTIVE:
        /* Hold at full intensity. Tiny Perlin shimmer (±0.04) keeps
           the funnel alive without ever dropping below 0.92.          */
        var shimmer = HE.Noise.perlin1(this._time * 0.6) * 0.04;
        this._intensity = HE.MathUtils.clamp(1.0 + shimmer, 0.92, 1.0);
        break;

      case _ST.DISSIPATING:
        /* Ramp 1 → 0. Mirror the forming curve. */
        this._intensity = HE.MathUtils.smootherstep(0, 1, 1 - p);
        break;

      default:
        this._intensity = 0;
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateWander(dt)
     Drifts the storm's world position during forming and active states.

     Heading changes are driven by Perlin1 noise so the path is organic
     and non-repeating. A boundary-bounce rule keeps the storm inside
     the playable terrain patch.

     Speed scales linearly with intensity — the stronger the storm,
     the faster it translates across the plains. This is intentional:
     EF5 tornadoes in Oklahoma can travel at 50+ mph (22 m/s), while
     weak EF0 twisters often stall and drift.
  ═══════════════════════════════════════════════════════════════════════ */

  _updateWander(dt) {
    /* ── Heading perturbation via Perlin noise ── */
    // Sample noise at two slightly different frequencies for richer turns.
    var noiseVal = HE.Noise.perlin1(this._time * _WX.WANDER_NOISE_FREQ)
                 + HE.Noise.perlin1(this._time * _WX.WANDER_NOISE_FREQ * 2.3) * 0.4;

    this._wanderHeading += noiseVal * _WX.WANDER_NOISE_SCALE * dt;
    /* Keep heading in -π..+π to avoid float drift over long sessions. */
    this._wanderHeading = HE.MathUtils.wrapAngle(this._wanderHeading);

    /* ── Speed: scales with intensity ── */
    var speed = HE.MathUtils.lerp(
      _WX.WANDER_SPEED_MIN,
      _WX.WANDER_SPEED_MAX,
      this._intensity
    );

    /* ── Integrate position ── */
    var dx = Math.sin(this._wanderHeading) * speed * dt;
    var dz = Math.cos(this._wanderHeading) * speed * dt;

    this._pos.x += dx;
    this._pos.z += dz;

    /* ── Boundary bounce ──
       If the storm would exit the playable world, reflect its heading
       so it turns back inward. This prevents the tornado from silently
       wandering off-screen during a long active phase.               */
    if (Math.abs(this._pos.x) > _WX.WANDER_X_LIMIT) {
      /* Flip X component of heading, drift back toward centre. */
      this._wanderHeading = Math.PI - this._wanderHeading;
      /* Hard-clamp so we never start a frame outside bounds. */
      this._pos.x = HE.MathUtils.clamp(
        this._pos.x, -_WX.WANDER_X_LIMIT, _WX.WANDER_X_LIMIT
      );
    }

    if (Math.abs(this._pos.z) > _WX.WANDER_Z_LIMIT) {
      /* Flip Z component of heading. */
      this._wanderHeading = -this._wanderHeading;
      this._pos.z = HE.MathUtils.clamp(
        this._pos.z, -_WX.WANDER_Z_LIMIT, _WX.WANDER_Z_LIMIT
      );
    }

    /* Y always stays at 0 — storm lives on the ground plane. */
    this._pos.y = 0;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _repositionStorm()
     Picks a new random spawn position for the storm.
     Called at the start of each clear phase so the next cycle
     surprises the player from a different direction.

     Spawn rules:
       • Minimum SPAWN_MIN_DIST from player origin (0,0) so it's never
         already on top of them when it starts forming.
       • Maximum SPAWN_MAX_DIST — must be visible on the horizon.
       • Within the terrain X/Z patch so it doesn't spawn in empty space.
       • Weighted toward being south-east or north-west of the player,
         matching how Oklahoma storm systems historically track.
  ═══════════════════════════════════════════════════════════════════════ */

  _repositionStorm() {
    var attempts = 0;
    var x, z, dist;

    /* Keep trying until we land in the valid annular spawn zone. */
    do {
      x = HE.MathUtils.randRange(-_WX.SPAWN_X_RANGE, _WX.SPAWN_X_RANGE);
      z = HE.MathUtils.randRange(-_WX.SPAWN_Z_RANGE, _WX.SPAWN_Z_RANGE);
      dist = Math.sqrt(x * x + z * z);
      attempts++;
    } while (
      (dist < _WX.SPAWN_MIN_DIST || dist > _WX.SPAWN_MAX_DIST)
      && attempts < 40
    );

    /* Fallback: if random sampling keeps missing, force a valid position
       at a fixed bearing so the game never locks up. */
    if (dist < _WX.SPAWN_MIN_DIST || dist > _WX.SPAWN_MAX_DIST) {
      var angle = Math.random() * Math.PI * 2;
      var r     = HE.MathUtils.randRange(_WX.SPAWN_MIN_DIST, _WX.SPAWN_MAX_DIST);
      x = Math.sin(angle) * r;
      z = Math.cos(angle) * r;
    }

    this._pos.set(x, 0, z);

    console.log('[WeatherSystem] Storm repositioned → ('
      + x.toFixed(1) + ', 0, ' + z.toFixed(1) + ')');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _emitUpdate()
     Broadcasts STORM_UPDATE on the EventBus. Called at ~20 Hz.

     Payload fields:
       pos       : THREE.Vector3  (live ref — listeners must not mutate)
       intensity : 0..1
       visible   : bool — true whenever the funnel should be rendered
       state     : string — current state name
  ═══════════════════════════════════════════════════════════════════════ */

  _emitUpdate() {
    var visible = (
      this._state === _ST.FORMING     ||
      this._state === _ST.ACTIVE      ||
      this._state === _ST.DISSIPATING
    );

    this._bus.emit('STORM_UPDATE', {
      pos:       this._pos,
      intensity: this._intensity,
      visible:   visible,
      state:     this._state
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════════════════════════════════════ */

  /* Pick a random float in [range[0], range[1]]. */
  _randomDur(range) {
    return HE.MathUtils.randRange(range[0], range[1]);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     READ-ONLY GETTERS  (match SKILL.md contract)
  ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Current storm world position as a THREE.Vector3.
   * Y is always 0 — storm lives on the ground plane.
   * LIVE REFERENCE — callers must treat as read-only.
   */
  get pos() { return this._pos; }

  /**
   * Current state name: 'clear' | 'forming' | 'active' | 'dissipating'
   */
  get state() { return this._state; }

  /**
   * Smooth intensity 0..1.
   * 0 = calm, 1 = full EF5.
   * Driven by smootherstep curves — always has zero derivative at transitions.
   */
  get intensity() { return this._intensity; }

  /**
   * True whenever the tornado mesh should be rendered.
   * Convenience wrapper around the state check used in _emitUpdate().
   */
  get visible() {
    return (
      this._state === _ST.FORMING     ||
      this._state === _ST.ACTIVE      ||
      this._state === _ST.DISSIPATING
    );
  }

  /**
   * How far through the current state we are (0..1).
   * Useful for Render.js to time sky colour transitions independently.
   */
  get stateProgress() { return this._stateProgress; }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP  — call on hot-reload or game restart
  ═══════════════════════════════════════════════════════════════════════ */

  dispose() {
    this._bus = null;
    console.log('[WeatherSystem] Disposed.');
  }

};
