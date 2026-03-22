/* ═══════════════════════════════════════════════════════════════════════════
   physics.js  —  HEXADO CHASING v2.0
   Layer   : Systems (load order: 5th — after 3DEngine.js)
   Exports : window.HexEngine.PhysicsEngine
   Deps    : HE.MathUtils (main-math.js)  ·  EventBus (main.js injects)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Owns all vehicle driving forces and exposes the player's world state to
   every downstream module:

     ┌─────────────────────────────────────────────────────────┐
     │  Inputs: key state · wind · heightFn                    │
     │  Outputs: pos · heading · speedKmh · distDelta · keys   │
     └─────────────────────────────────────────────────────────┘

   Sub-systems (executed in order each update tick)
   ─────────────────────────────────────────────────
   1. Drive intent    — W/S → raw throttle / brake scalar
   2. Acceleration    — throttle × ACCEL_FORCE → Δspeed
   3. Braking         — brake or opposite-dir input → fast deceleration
   4. Drag / friction — exponential decay so coasting feels natural
   5. Speed clamp     — forward MAX_FWD, reverse MAX_REV
   6. Steering        — A/D → heading rate scaled by speed
   7. Wind impulse    — buffered wx/wz blended into velocity
   8. World-space move — integrate velocity along heading
   9. Terrain snap    — pos.y = heightFn(x,z) + VEHICLE_CLEARANCE
  10. Event emit      — PLAYER_MOVE { pos, speed }

   Public API
   ──────────
     physics = new HE.PhysicsEngine(bus)
     physics.bindKeys()
     physics.update(dt, heightFn)
     physics.applyWind(wx, wz, intensity)   // called by main.js each frame
     physics.pos        → THREE.Vector3
     physics.heading    → Number (radians)
     physics.speedKmh   → Number
     physics.distDelta  → Number (m traveled this frame, for distance accumulation)
     physics.keys       → Object  { [code]: bool }  (read by Characters.js for walk)

   Tuning constants are documented inline so future iterations can dial in
   the right "chunky Oklahoma truck" feel without hunting through the logic.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS  —  tweak here, not inside update()
   ═══════════════════════════════════════════════════════════════════════════ */

var _PHY = {

  /* ─── Speed limits ────────────────────────────────────── */
  MAX_FWD:  27.8,   // m/s  ≈ 100 km/h  (wide-open throttle cap)
  MAX_REV:   8.3,   // m/s  ≈  30 km/h  (reversing cap)

  /* ─── Drive forces (m/s² equivalent scalars) ─────────── */
  ACCEL:    11.0,   // forward/reverse throttle acceleration
  BRAKE:    22.0,   // active braking deceleration
  ENGINE_BRAKE: 6.5, // lift-off coast drag (engine compression)

  /* ─── Aerodynamic drag ───────────────────────────────── */
  // Applied multiplicatively: speed *= DRAG_K^(dt*60)
  // At 60fps this becomes speed *= DRAG_K per frame, which
  // produces a satisfying exponential bleed without dt-dependence hacks.
  DRAG_K:   0.978,

  /* ─── Steering ───────────────────────────────────────── */
  STEER_MAX:   1.75,  // rad/s maximum yaw rate (tight U-turn feel)
  // Yaw rate scales down at high speed: rate *= smoothstep(0, 8, |speed|)
  // so the truck is nimble from a standstill but stable on the highway.
  STEER_SPEED_LIMIT: 20.0, // m/s above which steering sensitivity halves

  /* ─── Terrain attachment ─────────────────────────────── */
  VEHICLE_CLEARANCE: 0.85, // world units above ground (axle mid-height)

  /* ─── Wind ───────────────────────────────────────────── */
  // Wind is blended into the XZ velocity each frame.
  // Low intensity = gentle shudder; EF5 = genuine push.
  WIND_BASE_SCALE: 0.06,  // multiplied by (wx or wz) — base contribution
  WIND_INTENSITY_CURVE: 2.4, // exponent: wind only really bites above EF2

  /* ─── Event throttle ─────────────────────────────────── */
  // PLAYER_MOVE fires at most once per EMIT_INTERVAL seconds
  // to avoid flooding the bus with 60 events/sec.
  EMIT_INTERVAL: 0.05  // 20 Hz

};


/* ═══════════════════════════════════════════════════════════════════════════
   PhysicsEngine
   ═══════════════════════════════════════════════════════════════════════════ */

HE.PhysicsEngine = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(bus)
     bus : HE.EventBus instance, injected by main.js
  ───────────────────────────────────────────────────────────────────── */
  constructor(bus) {
    if (!bus || typeof bus.emit !== 'function') {
      console.error('[PhysicsEngine] EventBus is required.');
    }
    this._bus = bus;

    /* ── World state ── */
    // THREE is guaranteed loaded before this script runs.
    this._pos     = new THREE.Vector3(0, 0.85, 0);  // spawn on road at origin
    this._heading = 0;  // radians, Y-axis; 0 = facing +Z (south down road)
    this._speed   = 0;  // m/s, signed: + = forward, - = reverse

    /* ── Frame outputs ── */
    this._speedKmh   = 0;
    this._distDelta  = 0;  // meters traveled this frame (unsigned)

    /* ── Wind accumulator ── */
    // applyWind() writes here; update() reads and drains it.
    this._windX      = 0;
    this._windZ      = 0;
    this._windIntens = 0;

    /* ── Key state (public — Characters.js reads this for on-foot walk) ── */
    // Keyed by event.code so layout-independent (WASD + Arrows both work).
    this.keys = {};

    /* ── Event throttle ── */
    this._emitTimer = 0;

    /* ── Bound handlers stored for cleanup ── */
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp   = this._handleKeyUp.bind(this);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     bindKeys()
     Attaches document-level key listeners. Called once by main.js after
     the DOM is fully available. Uses event.code (hardware position) so
     WASD works on AZERTY keyboards too.
  ═══════════════════════════════════════════════════════════════════════ */

  bindKeys() {
    document.addEventListener('keydown', this._onKeyDown, { passive: true });
    document.addEventListener('keyup',   this._onKeyUp,   { passive: true });
    console.log('[PhysicsEngine] Key bindings active.');
  }

  _handleKeyDown(e) {
    this.keys[e.code] = true;
  }

  _handleKeyUp(e) {
    this.keys[e.code] = false;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     applyWind(wx, wz, intensity)
     Called by main.js each frame when the storm is active.
     Buffers the wind vector so update() can integrate it cleanly.

     wx, wz    : world-space wind impulse from VortexMath.worldWind()
     intensity : 0..1 storm strength (maps through WIND_INTENSITY_CURVE)
  ═══════════════════════════════════════════════════════════════════════ */

  applyWind(wx, wz, intensity) {
    this._windX      = wx;
    this._windZ      = wz;
    this._windIntens = HE.MathUtils.clamp(intensity, 0, 1);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt, heightFn)
     Main per-frame physics tick. Called by main.js._loop().

     dt       : frame delta time in seconds (capped to 0.05 by main.js)
     heightFn : (x, z) → Number  — terrain height at world position

     Runs 10 sub-systems in sequence:
       drive intent → accel → brake → drag → speed clamp →
       steering → wind impulse → world move → terrain snap → emit
  ═══════════════════════════════════════════════════════════════════════ */

  update(dt, heightFn) {

    /* ── Guard: cap dt so a stall frame doesn't teleport the truck ── */
    var safeDt = Math.min(dt, 0.05);

    /* ──────────────────────────────────────────────────────────────
       1. DRIVE INTENT
       Unified key check: WASD + Arrow keys both work.
    ────────────────────────────────────────────────────────────── */
    var accelInput = 0;  // +1 forward, -1 reverse
    var steerInput = 0;  // +1 right, -1 left

    if (this.keys['KeyW']     || this.keys['ArrowUp'])    accelInput =  1;
    if (this.keys['KeyS']     || this.keys['ArrowDown'])  accelInput = -1;
    if (this.keys['KeyD']     || this.keys['ArrowRight'])  steerInput =  1;
    if (this.keys['KeyA']     || this.keys['ArrowLeft'])   steerInput = -1;

    /* ──────────────────────────────────────────────────────────────
       2. ACCELERATION
       Throttle linearly ramps speed. Force is symmetric for
       forward/reverse; max speeds are different (see clamp below).
    ────────────────────────────────────────────────────────────── */
    if (accelInput !== 0) {
      this._speed += accelInput * _PHY.ACCEL * safeDt;
    }

    /* ──────────────────────────────────────────────────────────────
       3. BRAKING + COUNTER-STEER BRAKING
       If the player presses in the opposite direction to current
       motion, we apply hard braking force (not acceleration) until
       the truck stops, then let normal accel take over.
       This prevents instant direction reversal at speed.
    ────────────────────────────────────────────────────────────── */
    if (accelInput > 0 && this._speed < -0.5) {
      /* Pressing forward while rolling backward — brake hard */
      this._speed += _PHY.BRAKE * safeDt;
      if (this._speed > 0) this._speed = 0;
    } else if (accelInput < 0 && this._speed > 0.5) {
      /* Pressing back while rolling forward — brake hard */
      this._speed -= _PHY.BRAKE * safeDt;
      if (this._speed < 0) this._speed = 0;
    }

    /* ──────────────────────────────────────────────────────────────
       4. DRAG / COAST FRICTION
       Exponential drag always acts, plus an extra engine-braking
       term when the driver lifts off (no accel input).
    ────────────────────────────────────────────────────────────── */
    /* Compute drag exponent: drag factor raised to (dt × 60) so the
       decay rate is independent of frame rate. */
    var dragExp  = Math.pow(_PHY.DRAG_K, safeDt * 60);
    this._speed *= dragExp;

    /* Engine braking on lift-off — adds extra deceleration */
    if (accelInput === 0 && Math.abs(this._speed) > 0.05) {
      var engineBrake = _PHY.ENGINE_BRAKE * safeDt * Math.sign(this._speed);
      /* Only pull toward zero, never overshoot */
      if (Math.abs(engineBrake) >= Math.abs(this._speed)) {
        this._speed = 0;
      } else {
        this._speed -= engineBrake;
      }
    }

    /* Snap to zero below creep threshold to avoid infinite tiny drift */
    if (Math.abs(this._speed) < 0.04) this._speed = 0;

    /* ──────────────────────────────────────────────────────────────
       5. SPEED CLAMP
       Forward and reverse caps are different.
       Forward: absolute max for full-throttle chase.
       Reverse: much lower — you're not chasing a tornado backwards.
    ────────────────────────────────────────────────────────────── */
    if (this._speed >  _PHY.MAX_FWD)  this._speed =  _PHY.MAX_FWD;
    if (this._speed < -_PHY.MAX_REV)  this._speed = -_PHY.MAX_REV;

    /* ──────────────────────────────────────────────────────────────
       6. STEERING
       Heading change rate scales with both steer input and speed.
       Key behaviours:
         • No steering at rest (avoids spinning in place)
         • Full agility below STEER_SPEED_LIMIT/2
         • Sensitivity halves above STEER_SPEED_LIMIT (highway feel)
         • Steering reverses automatically in reverse gear
    ────────────────────────────────────────────────────────────── */
    if (steerInput !== 0 && Math.abs(this._speed) > 0.3) {

      /* Speed ramp-up: turn rate goes from 0 → full over the first ~5 m/s */
      var speedFraction = HE.MathUtils.clamp(Math.abs(this._speed) / 5.0, 0, 1);
      speedFraction = HE.MathUtils.smoothstep(0, 1, speedFraction);

      /* High-speed sensitivity reduction */
      var highSpeedPenalty = 1.0;
      if (Math.abs(this._speed) > _PHY.STEER_SPEED_LIMIT) {
        highSpeedPenalty = 0.5;
      } else if (Math.abs(this._speed) > _PHY.STEER_SPEED_LIMIT * 0.6) {
        var t = HE.MathUtils.smoothstep(
          _PHY.STEER_SPEED_LIMIT * 0.6,
          _PHY.STEER_SPEED_LIMIT,
          Math.abs(this._speed)
        );
        highSpeedPenalty = HE.MathUtils.lerp(1.0, 0.5, t);
      }

      var yawRate = steerInput * _PHY.STEER_MAX * speedFraction * highSpeedPenalty;

      /* Reverse flips steering direction (truck turns correctly going back) */
      if (this._speed < 0) yawRate = -yawRate;

      this._heading -= yawRate * safeDt;

      /* Keep heading in -π..+π to avoid float drift over long sessions */
      this._heading = HE.MathUtils.wrapAngle(this._heading);
    }

    /* ──────────────────────────────────────────────────────────────
       7. WIND IMPULSE
       VortexMath provides a world-space wind vector (wx, wz).
       We push the position directly rather than altering speed so
       wind can push the truck off-road without the speedometer lying.
       Nonlinear intensity curve — calm at low EF, dangerous at high EF.
    ────────────────────────────────────────────────────────────── */
    if (this._windIntens > 0.05) {
      var windScalar = Math.pow(this._windIntens, _PHY.WIND_INTENSITY_CURVE)
                       * _PHY.WIND_BASE_SCALE;
      this._pos.x += this._windX * windScalar * safeDt;
      this._pos.z += this._windZ * windScalar * safeDt;
    }

    /* ──────────────────────────────────────────────────────────────
       8. WORLD-SPACE MOVEMENT
       Integrate velocity along current heading direction.
       Heading 0 = +Z axis; this matches Three.js camera forward.
    ────────────────────────────────────────────────────────────── */
    var dx = Math.sin(this._heading) * this._speed * safeDt;
    var dz = Math.cos(this._heading) * this._speed * safeDt;

    this._pos.x += dx;
    this._pos.z += dz;

    /* Distance traveled this frame (used by HUD distance counter) */
    this._distDelta = Math.sqrt(dx * dx + dz * dz);

    /* ──────────────────────────────────────────────────────────────
       9. TERRAIN SNAP
       Pin the truck to the terrain surface at all times.
       VEHICLE_CLEARANCE = 0.85 world units (axle mid-height).
    ────────────────────────────────────────────────────────────── */
    if (typeof heightFn === 'function') {
      var groundY = heightFn(this._pos.x, this._pos.z);
      this._pos.y = groundY + _PHY.VEHICLE_CLEARANCE;
    }

    /* ──────────────────────────────────────────────────────────────
       10. STATS + EVENT EMIT
       Cache km/h for the HUD and emit PLAYER_MOVE at 20 Hz.
    ────────────────────────────────────────────────────────────── */
    this._speedKmh = Math.abs(this._speed) * 3.6;

    /* Throttled emit — avoids 60 bus events/sec */
    this._emitTimer += safeDt;
    if (this._emitTimer >= _PHY.EMIT_INTERVAL) {
      this._emitTimer = 0;
      this._bus.emit('PLAYER_MOVE', {
        pos:   this._pos,
        speed: this._speedKmh
      });
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     READ-ONLY GETTERS
     Characters.js, Render.js, and HUD.js all read from here.
     Returning the live Vector3 ref (not a clone) saves GC pressure —
     callers must treat it as read-only.
  ═══════════════════════════════════════════════════════════════════════ */

  /** Current world position (live reference — do not mutate) */
  get pos() { return this._pos; }

  /** Current heading in radians (Y-axis, CCW from +Z) */
  get heading() { return this._heading; }

  /** Absolute speed in km/h (always positive) */
  get speedKmh() { return this._speedKmh; }

  /** Distance traveled in meters during the last update() call */
  get distDelta() { return this._distDelta; }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP  — call when tearing down (hot-reload, game restart)
  ═══════════════════════════════════════════════════════════════════════ */

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup',   this._onKeyUp);
    this.keys = {};
    console.log('[PhysicsEngine] Disposed.');
  }

};
