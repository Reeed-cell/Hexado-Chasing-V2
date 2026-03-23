/* ═══════════════════════════════════════════════════════════════════════════
   HUD.js  —  HEXADO CHASING v2.0
   Layer   : Rendering (load order: 12th — after Render.js)
   Exports : window.HexEngine.HUD
             window.HexEngine.PlayerStats
             window.HexEngine.StormTracker
   Deps    : HE.MathUtils (main-math.js)  ·  EventBus injected via hud.init(bus)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Owns all HUD rendering: stat box readouts, EF intensity bar, minimap canvas,
   alert flash system, mode label, and vehicle prompt. Three cooperating classes:

     ┌────────────────────────────────────────────────────────────────────┐
     │  PlayerStats  — pure data accumulator (speed, dist, score, prox)  │
     │  StormTracker — accumulates intensity, EF scale, path trail       │
     │  HUD          — reads both, writes all DOM, renders minimap       │
     └────────────────────────────────────────────────────────────────────┘

   Public API (matches SKILL.md contract exactly)
   ──────────
     stats   = new HE.PlayerStats()
     stats.update(dt, speedKmh, distDelta, prox)
     → exposes: speed · distanceTraveled · proximity · score · maxSpeed · closestApproach

     tracker = new HE.StormTracker()
     tracker.update(dt, intensity, pos)
     → exposes: intensity · efScale · windSpeed · path[] · pos

     hud = new HE.HUD()
     hud.init(bus)      // optional — wires ENTER_VEHICLE / EXIT_VEHICLE events
     hud.update(stats, tracker, playerPos, inVehicle, canEnter, stormState)
     hud.playerHeading  // Number (rad) — set by main.js each frame before update()

   DOM IDs required (all present in index.html)
   ──────────────────────────────────────────────
     s-speed · s-dist · s-prox · s-score
     ef-seg-0 through ef-seg-5   (CSS class lit-N applied when lit)
     ef-label · ef-fill (hidden compat)
     alert · enter-prompt · mode-label
     mm-canvas  (112×112 px Canvas 2D — minimap)

   Scoring formula
   ────────────────
   Accrues only when storm is visible (prox is finite and < SCORE_RANGE).
   Rate = (max(0, SCORE_RANGE − prox) / SCORE_RANGE)² × SCORE_BASE pts/sec
   Examples: prox 50m → 174 pts/sec · prox 150m → 50 pts/sec · prox 299m → 0

   Minimap design
   ───────────────
   112×112 px player-centred canvas; MM_EXTENT = 250 wu half-extent (500 wu total).
   Scale: MM_SIZE / (MM_EXTENT × 2) = 0.224 px/wu.
   Coordinate mapping: world +X → minimap right · world +Z → minimap down (south).
   Layers: bg fill → grid → road corridor → storm path trail →
           storm pulsing ring → player dot + heading arrow → compass 'N'.

   EF segment mapping
   ───────────────────
   6 segments, one per EF level 0-5. Lit count = min(6, floor(intensity×6)+1).
   The CSS stylesheet handles all segment colours via .lit-N classes.
   This file only adds / removes those classes — never sets inline colour.

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export — plain <script> tag
   • HUD.js has NO Three.js dependency — DOM + Canvas 2D only
   • EventBus wired via init(bus) rather than constructor arg (contract requires no-arg ctor)
   • Bound handler refs stored in _onEnterBound / _onExitBound for clean off() in dispose()
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

var _HUD = {

  /* ─── Scoring ─────────────────────────────────────────────────────── */
  SCORE_RANGE:    300,    // world units — beyond this earns nothing
  SCORE_BASE:     200,    // pts/sec at point-blank with storm
  SCORE_LERP:     0.10,   // animated display lerp rate per frame

  /* ─── Alert proximity thresholds (world units) ────────────────────── */
  ALERT_CRITICAL:  20,    // ☠ red strobe — inside the core
  ALERT_DANGER:    50,    // ⚠ fast-pulse red — genuinely dangerous
  ALERT_CHASE:    100,    // ⚡ amber pulse — optimal scoring zone
  ALERT_NEARBY:   200,    // TORNADO NEARBY — amber steady

  /* ─── Alert animation (ms-domain timing) ─────────────────────────── */
  PULSE_FAST:     0.006,  // ms⁻¹ × π × 2 = radians/ms for fast pulse
  PULSE_SLOW:     0.003,
  STROBE_PERIOD:  120,    // ms — strobe on/off period for critical

  /* ─── Minimap ────────────────────────────────────────────────────── */
  MM_SIZE:        112,    // canvas px (must match HTML/CSS dimensions)
  MM_EXTENT:      250,    // world units, half-extent of viewport
  MM_GRID_WU:      50,    // world unit spacing for grid lines
  MM_ROAD_MIN_PX:   5,    // minimum road band width in px (legibility floor)
  MM_PATH_MAX:     60,    // rolling storm path point count
  MM_PATH_INTERVAL: 2.0,  // seconds between path point records

  /* ─── EF label text — indices match EF scale 0-5 ─────────────────── */
  EF_LABELS: [
    'EF0  ·  65-85 mph',
    'EF1  ·  86-110 mph',
    'EF2  ·  111-135 mph',
    'EF3  ·  136-165 mph',
    'EF4  ·  166-200 mph',
    'EF5  ·  200+ mph'
  ],

  /* ─── EF colours — must match CSS .lit-N rules ────────────────────── */
  EF_COLOURS: [
    '#00cc44',   // EF0
    '#88cc00',   // EF1
    '#ffcc00',   // EF2
    '#ff8800',   // EF3
    '#ff4400',   // EF4
    '#cc0000'    // EF5
  ]

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.PlayerStats
   ───────────────
   Pure data accumulator. No DOM, no Three.js dependency.
   main.js creates one instance, calls update() each frame,
   then passes the whole object to HUD.update().
   ═══════════════════════════════════════════════════════════════════════════ */

HE.PlayerStats = class {

  constructor() {

    /* ── Publicly-readable state ── */
    this.speed            = 0;          // km/h this frame
    this.distanceTraveled = 0;          // cumulative meters (never decrements)
    this.proximity        = Infinity;   // metres to tornado centre (Inf = no storm)
    this.score            = 0;          // integer score displayed on HUD
    this.maxSpeed         = 0;          // session high km/h
    this.closestApproach  = Infinity;   // closest recorded proximity

    /* ── Internal float accumulator for smooth integer score ── */
    this._scoreFloat = 0;
  }


  /* ─────────────────────────────────────────────────────────────────────
     update(dt, speedKmh, distDelta, prox)

     dt        : frame delta (seconds, already capped to 0.05 by main.js)
     speedKmh  : from PhysicsEngine.speedKmh  (always ≥ 0)
     distDelta : from PhysicsEngine.distDelta  (meters this frame)
     prox      : distance to tornado (world units); pass Infinity when clear
  ───────────────────────────────────────────────────────────────────── */
  update(dt, speedKmh, distDelta, prox) {

    this.speed = speedKmh;

    /* Distance: only accumulate forward movement (distDelta ≥ 0 always) */
    this.distanceTraveled += Math.max(0, distDelta);

    /* Proximity */
    this.proximity = (isFinite(prox) && prox >= 0) ? prox : Infinity;

    /* Session records */
    if (speedKmh > this.maxSpeed)       this.maxSpeed         = speedKmh;
    if (this.proximity < this.closestApproach) {
      this.closestApproach = this.proximity;
    }

    /* ── Score accrual ──
       Quadratic proximity factor: reward drops steeply beyond SCORE_RANGE.
       Only accrues when storm is actually present (prox is finite).     */
    if (isFinite(this.proximity) && this.proximity < _HUD.SCORE_RANGE) {
      var proxFactor = Math.max(
        0,
        (_HUD.SCORE_RANGE - this.proximity) / _HUD.SCORE_RANGE
      );
      this._scoreFloat += proxFactor * proxFactor * _HUD.SCORE_BASE * dt;
    }

    this.score = Math.floor(this._scoreFloat);
  }


  /* Hard reset — call at start of a new game session */
  reset() {
    this.distanceTraveled = 0;
    this.score            = 0;
    this.maxSpeed         = 0;
    this.closestApproach  = Infinity;
    this._scoreFloat      = 0;
    this.proximity        = Infinity;
    this.speed            = 0;
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.StormTracker
   ────────────────
   Accumulates storm telemetry and builds the path trail array for the minimap.
   Pure data — no DOM, no Three.js dependency.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.StormTracker = class {

  constructor() {

    /* ── Publicly-readable state ── */
    this.intensity = 0;         // 0..1  smooth, from WeatherSystem
    this.efScale   = 0;         // integer 0-5  (Fujita scale equivalent)
    this.windSpeed = 0;         // estimated surface wind in km/h
    this.path      = [];        // { x, z }[] rolling storm position trail
    this.pos       = null;      // THREE.Vector3 live ref (from WeatherSystem)

    /* ── Internal ── */
    this._pathTimer = 0;        // seconds since last path point was recorded
  }


  /* ─────────────────────────────────────────────────────────────────────
     update(dt, intensity, pos)

     dt        : frame delta (seconds)
     intensity : 0..1 from WeatherSystem.intensity
     pos       : THREE.Vector3 live storm position (do not mutate — read only)
  ───────────────────────────────────────────────────────────────────── */
  update(dt, intensity, pos) {

    this.intensity = HE.MathUtils.clamp(intensity, 0, 1);
    this.pos       = pos;   // store live ref for minimap rendering

    /* EF scale — 0-5 integer from MathUtils helper */
    this.efScale   = HE.MathUtils.efScale(this.intensity);

    /* Estimated wind speed in km/h.
       Quadratic curve: EF0 ≈ 100 km/h · EF5 ≈ 322+ km/h.
       Based on real Fujita scale surface wind bounds.               */
    this.windSpeed = Math.round(322 * this.intensity * this.intensity);

    /* ── Storm path recording for minimap trail ── */
    if (pos && this.intensity > 0.08) {
      this._pathTimer += dt;
      if (this._pathTimer >= _HUD.MM_PATH_INTERVAL) {
        this._pathTimer = 0;
        this.path.push({ x: pos.x, z: pos.z });
        /* Rolling window — oldest point evicted when limit reached */
        if (this.path.length > _HUD.MM_PATH_MAX) {
          this.path.shift();
        }
      }
    } else if (this.intensity < 0.01) {
      /* Storm cleared — reset timer so next cycle starts fresh */
      this._pathTimer = 0;
    }
  }


  /* Clear the path trail — call at storm cycle boundary if needed */
  clearPath() {
    this.path       = [];
    this._pathTimer = 0;
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.HUD
   ───────
   DOM + Canvas 2D rendering orchestrator.
   No Three.js dependency — everything is CSS classes, textContent, and Canvas.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.HUD = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor()
     No args — binds all DOM element refs immediately.
     Called once by main.js. DOM must be ready (call inside window.onload).
  ───────────────────────────────────────────────────────────────────── */
  constructor() {

    /* ── DOM element cache ── */
    this._el = {
      speed:   document.getElementById('s-speed'),
      dist:    document.getElementById('s-dist'),
      prox:    document.getElementById('s-prox'),
      score:   document.getElementById('s-score'),
      efLabel: document.getElementById('ef-label'),
      efFill:  document.getElementById('ef-fill'),      // hidden — legacy compat
      alert:   document.getElementById('alert'),
      prompt:  document.getElementById('enter-prompt'),
      mode:    document.getElementById('mode-label'),
      mmCvs:   document.getElementById('mm-canvas')
    };

    /* ── EF segment elements — one per EF level 0-5 ── */
    this._efSegs = [];
    for (var i = 0; i < 6; i++) {
      this._efSegs.push(document.getElementById('ef-seg-' + i));
    }

    /* ── Minimap 2D context + derived constants ── */
    this._mmCtx   = null;
    this._mmSize  = _HUD.MM_SIZE;
    this._mmHalf  = _HUD.MM_SIZE / 2;                          // 56
    this._mmScale = _HUD.MM_SIZE / (_HUD.MM_EXTENT * 2);       // 0.224 px/wu

    if (this._el.mmCvs) {
      this._mmCtx = this._el.mmCvs.getContext('2d');
    }

    /* ── Animated score display (exponential lerp toward stats.score) ── */
    this._displayScore = 0;

    /* ── Player heading (radians) — set by main.js each frame before update() ──
       Heading 0 = facing +Z (south = down on minimap).
       Three.js PhysicsEngine convention: sin(h)=X, cos(h)=Z.         */
    this.playerHeading = 0;

    /* ── EF segment change detection — only rebuild CSS when lit count changes ── */
    this._lastEfLit = -1;

    /* ── EventBus ref + stored bound handlers (for clean off() in dispose()) ── */
    this._bus            = null;
    this._onEnterBound   = this._onEnterVehicle.bind(this);
    this._onExitBound    = this._onExitVehicle.bind(this);

    /* ── Pre-built minimap colour strings (avoid GC-heavy string concat per frame) ── */
    this._mmColBg         = 'rgba(4, 6, 14, 0.90)';
    this._mmColGrid       = 'rgba(255, 255, 255, 0.045)';
    this._mmColRoadFill   = 'rgba(140, 128, 108, 0.22)';
    this._mmColRoadEdge   = 'rgba(200, 190, 160, 0.30)';
    this._mmColPlayerDot  = '#ffc828';
    this._mmColPlayerRim  = 'rgba(255, 255, 255, 0.55)';
    this._mmColArrow      = '#ffffff';
    this._mmColCompass    = 'rgba(255, 255, 255, 0.22)';
    this._mmColNorth      = 'rgba(255, 255, 255, 0.52)';

    console.log('[HUD] Ready — minimap scale: '
      + this._mmScale.toFixed(3) + ' px/wu  ·  '
      + _HUD.MM_EXTENT + ' wu half-extent.');
  }


  /* ─────────────────────────────────────────────────────────────────────
     init(bus)
     Optional EventBus subscription. Call after bus is constructed in main.js.
     Listens to ENTER_VEHICLE + EXIT_VEHICLE so mode label updates immediately
     on the frame the switch happens, not on the next HUD.update() call.

     bus : HE.EventBus — the single shared instance
  ───────────────────────────────────────────────────────────────────── */
  init(bus) {
    if (!bus || typeof bus.on !== 'function') {
      console.warn('[HUD] init() called without a valid EventBus — skipping event wiring.');
      return;
    }
    this._bus = bus;
    this._bus.on('ENTER_VEHICLE', this._onEnterBound);
    this._bus.on('EXIT_VEHICLE',  this._onExitBound);
    console.log('[HUD] EventBus wired — listening for ENTER_VEHICLE / EXIT_VEHICLE.');
  }

  _onEnterVehicle() {
    if (this._el.mode) this._el.mode.textContent = '🚗 DRIVING';
  }

  _onExitVehicle() {
    if (this._el.mode) this._el.mode.textContent = '🚶 ON FOOT';
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(stats, tracker, playerPos, inVehicle, canEnter, stormState)
     Main per-frame call from main.js._loop(). Drives all six sub-systems.

     stats      : HE.PlayerStats instance (populated this frame)
     tracker    : HE.StormTracker instance (populated this frame)
     playerPos  : THREE.Vector3 — current player world position (read-only)
     inVehicle  : bool — true = driving, false = on foot
     canEnter   : bool — walker is within enter-range of parked vehicle
     stormState : string — 'clear'|'forming'|'active'|'dissipating'
  ═══════════════════════════════════════════════════════════════════════ */
  update(stats, tracker, playerPos, inVehicle, canEnter, stormState) {

    /* Sub-systems ordered by visual priority (later = drawn on top in CSS Z order) */
    this._updateStatBoxes(stats);
    this._updateEFBar(tracker, stormState);
    this._updateModeLabel(inVehicle);
    this._updatePrompt(inVehicle, canEnter);
    this._updateAlert(stats, tracker, stormState);
    this._updateMinimap(playerPos, tracker);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateStatBoxes(stats)
     Writes speed / distance / proximity / score to the four sbox readouts.
     Score uses a one-pole exponential lerp (SCORE_LERP) for a satisfying
     count-up animation.
  ═══════════════════════════════════════════════════════════════════════ */
  _updateStatBoxes(stats) {
    if (!stats) return;

    /* Speed — integer km/h, no decimal noise */
    if (this._el.speed) {
      this._el.speed.textContent = Math.round(stats.speed);
    }

    /* Distance — metre display below 1 km; X.Xkm above */
    if (this._el.dist) {
      var d = stats.distanceTraveled;
      this._el.dist.textContent = (d >= 1000)
        ? (d / 1000).toFixed(1) + 'k'
        : Math.round(d).toString();
    }

    /* Proximity — '---' when no active storm */
    if (this._el.prox) {
      var p = stats.proximity;
      this._el.prox.textContent = (isFinite(p) && p < 9990)
        ? Math.round(p).toString()
        : '---';
    }

    /* Score — animated count-up via lerp toward integer target */
    if (this._el.score) {
      this._displayScore += (stats.score - this._displayScore) * _HUD.SCORE_LERP;
      this._el.score.textContent = Math.round(this._displayScore).toString();
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateEFBar(tracker, stormState)
     Lights N of 6 EF segments using CSS class lit-N (no inline colour).
     Updates the ef-label text with EF category and wind range.
     Updates the hidden ef-fill for any legacy compat consumers.
  ═══════════════════════════════════════════════════════════════════════ */
  _updateEFBar(tracker, stormState) {
    if (!tracker) return;

    var intensity = tracker.intensity;
    var ef        = HE.MathUtils.clamp(tracker.efScale, 0, 5);

    /* ── Segment lighting ──
       litCount 0 = all dark (clear sky).
       litCount N = segments 0..N-1 lit.
       The +1 ensures any non-zero intensity illuminates at least EF0.   */
    var litCount = (intensity < 0.01)
      ? 0
      : Math.min(6, Math.floor(intensity * 6) + 1);

    /* Rebuild CSS only when the count changes — avoids layout thrash */
    if (litCount !== this._lastEfLit) {
      this._lastEfLit = litCount;

      for (var i = 0; i < 6; i++) {
        var seg = this._efSegs[i];
        if (!seg) continue;

        /* Reset to base class only, then optionally add lit-N */
        seg.className = 'ef-seg';
        if (i < litCount) {
          seg.classList.add('lit-' + i);
        }
      }
    }

    /* ── EF label text ── */
    if (this._el.efLabel) {
      if (intensity < 0.01) {
        this._el.efLabel.textContent = 'Clear skies';
        this._el.efLabel.style.color = '';
      } else {
        /* State-aware prefix arrow for building / decay phases */
        var prefix = '';
        if (stormState === 'forming')     prefix = '▲  ';
        else if (stormState === 'dissipating') prefix = '▼  ';

        this._el.efLabel.textContent = prefix + _HUD.EF_LABELS[ef];
        this._el.efLabel.style.color = _HUD.EF_COLOURS[ef];
      }
    }

    /* Legacy hidden compat — ef-fill width mirrors intensity */
    if (this._el.efFill) {
      this._el.efFill.style.width = (intensity * 100).toFixed(1) + '%';
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateModeLabel(inVehicle)
     Updates the centre-top mode badge each frame.
     EventBus handlers also update this immediately on switch frames.
  ═══════════════════════════════════════════════════════════════════════ */
  _updateModeLabel(inVehicle) {
    if (!this._el.mode) return;
    this._el.mode.textContent = inVehicle ? '🚗 DRIVING' : '🚶 ON FOOT';
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updatePrompt(inVehicle, canEnter)
     Contextual [E] prompt above stat boxes.
     — While driving:   always show "[E] Exit vehicle"
     — On foot in range: show "[E] Enter vehicle"
     — On foot out of range: hide (opacity 0, CSS handles transition)
  ═══════════════════════════════════════════════════════════════════════ */
  _updatePrompt(inVehicle, canEnter) {
    if (!this._el.prompt) return;

    if (inVehicle) {
      this._el.prompt.textContent  = '[E] Exit vehicle';
      this._el.prompt.style.opacity = '1';
    } else if (canEnter) {
      this._el.prompt.textContent  = '[E] Enter vehicle';
      this._el.prompt.style.opacity = '1';
    } else {
      this._el.prompt.style.opacity = '0';
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateAlert(stats, tracker, stormState)
     Centre-screen situation-awareness banner. Four severity tiers.

     Design intent: player is a storm chaser — proximity is rewarded, not
     penalised. Alerts escalate with excitement, not evacuation urgency.
     Only the critical tier (< 20 m, inside core) signals real danger.
  ═══════════════════════════════════════════════════════════════════════ */
  _updateAlert(stats, tracker, stormState) {
    if (!this._el.alert) return;

    var prox      = stats   ? stats.proximity   : Infinity;
    var intensity = tracker ? tracker.intensity : 0;
    var now       = Date.now();

    /* No alert during clear sky phase or negligible intensity */
    if (intensity < 0.05 || stormState === 'clear') {
      this._el.alert.style.opacity = '0';
      return;
    }

    var msg     = '';
    var colour  = '#ffffff';
    var opacity = '0';

    if (isFinite(prox)) {

      if (prox < _HUD.ALERT_CRITICAL) {
        /* ─── ☠ CRITICAL — inside vortex core. Strobe every 120ms. ─── */
        msg    = '\u2620  CRITICAL DISTANCE';
        colour = '#ff2222';
        opacity = (Math.floor(now / _HUD.STROBE_PERIOD) % 2 === 0) ? '1' : '0.12';

      } else if (prox < _HUD.ALERT_DANGER) {
        /* ─── ⚠ DANGER — fast red pulse ─── */
        msg    = '\u26a0  DANGER CLOSE';
        colour = '#ff4422';
        var p1 = Math.sin(now * _HUD.PULSE_FAST * Math.PI * 2);
        opacity = (0.62 + p1 * 0.36).toFixed(2);

      } else if (prox < _HUD.ALERT_CHASE) {
        /* ─── ⚡ CHASE ZONE — amber pulse (sweet spot for max points) ─── */
        msg    = '\u26a1  CHASE ZONE';
        colour = '#ffc828';
        var p2 = Math.sin(now * _HUD.PULSE_SLOW * Math.PI * 2);
        opacity = (0.72 + p2 * 0.24).toFixed(2);

      } else if (prox < _HUD.ALERT_NEARBY) {
        /* ─── NEARBY — amber steady ─── */
        msg     = 'TORNADO NEARBY';
        colour  = '#ffaa00';
        opacity = '0.65';

      } else if (stormState === 'forming') {
        /* ─── Far but forming — ambient awareness ─── */
        msg     = '\u25b2  TORNADO FORMING';
        colour  = '#ff8800';
        opacity = '0.45';

      } else if (stormState === 'dissipating') {
        msg     = '\u25bc  DISSIPATING';
        colour  = '#aa9966';
        opacity = '0.38';
      }

    } else {
      /* Storm visible but proximity unknown — show state-level context */
      if (stormState === 'forming') {
        msg     = '\u25b2  STORM FORMING';
        colour  = '#ff8800';
        opacity = '0.45';
      } else if (stormState === 'active') {
        msg     = 'TORNADO ACTIVE';
        colour  = '#ffaa00';
        opacity = '0.50';
      }
    }

    this._el.alert.textContent   = msg;
    this._el.alert.style.color   = colour;
    this._el.alert.style.opacity = msg ? opacity : '0';
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _updateMinimap(playerPos, tracker)
     Renders the 112×112 minimap canvas each frame.

     Coordinate system (player-centred):
       mmX = mmHalf + (worldX − playerX) × scale
       mmY = mmHalf + (worldZ − playerZ) × scale   (+Z world = south = down)

     Player is always drawn at (mmHalf, mmHalf) = canvas centre.

     Draw order (back to front):
       1. Background  2. Grid  3. Road corridor  4. Storm path trail
       5. Storm marker (pulsing ring + EF label)
       6. Player dot + heading arrow  7. Compass 'N'
  ═══════════════════════════════════════════════════════════════════════ */
  _updateMinimap(playerPos, tracker) {
    var ctx = this._mmCtx;
    if (!ctx || !playerPos) return;

    var size  = this._mmSize;
    var half  = this._mmHalf;
    var scale = this._mmScale;
    var px    = playerPos.x;
    var pz    = playerPos.z;
    var now   = Date.now();

    /* Inline helper — converts a world (wx, wz) to minimap pixel coords */
    var toMM = function(wx, wz) {
      return {
        x: half + (wx - px) * scale,
        y: half + (wz - pz) * scale
      };
    };

    /* ── 1. Background ── */
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = this._mmColBg;
    ctx.fillRect(0, 0, size, size);

    /* ── 2. World-aligned grid ──
       Compute first grid line that falls within the current viewport window.
       This keeps the grid stable and world-anchored as the player moves.   */
    ctx.strokeStyle = this._mmColGrid;
    ctx.lineWidth   = 0.5;

    var gridWU   = _HUD.MM_GRID_WU;
    var leftWX   = px - _HUD.MM_EXTENT;
    var topWZ    = pz - _HUD.MM_EXTENT;
    var firstGX  = Math.ceil(leftWX  / gridWU) * gridWU;
    var firstGZ  = Math.ceil(topWZ   / gridWU) * gridWU;

    var gx, gz, mmGX, mmGZ;

    for (gx = firstGX; gx <= px + _HUD.MM_EXTENT; gx += gridWU) {
      mmGX = half + (gx - px) * scale;
      ctx.beginPath();
      ctx.moveTo(mmGX, 0);
      ctx.lineTo(mmGX, size);
      ctx.stroke();
    }

    for (gz = firstGZ; gz <= pz + _HUD.MM_EXTENT; gz += gridWU) {
      mmGZ = half + (gz - pz) * scale;
      ctx.beginPath();
      ctx.moveTo(0, mmGZ);
      ctx.lineTo(size, mmGZ);
      ctx.stroke();
    }

    /* ── 3. Road corridor — vertical band centred at world X = 0 ──
       Road runs along the Z axis. On the minimap it appears as a vertical
       strip. Width = ROAD_HALF_W × 2 × scale, min MM_ROAD_MIN_PX for legibility. */
    var roadMmX      = half + (0 - px) * scale;
    var roadHalfPx   = Math.max(_HUD.MM_ROAD_MIN_PX / 2, 9.5 * scale);

    /* Fill */
    ctx.fillStyle = this._mmColRoadFill;
    ctx.fillRect(roadMmX - roadHalfPx, 0, roadHalfPx * 2, size);

    /* Edge lines */
    ctx.strokeStyle = this._mmColRoadEdge;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    ctx.moveTo(roadMmX - roadHalfPx, 0);
    ctx.lineTo(roadMmX - roadHalfPx, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(roadMmX + roadHalfPx, 0);
    ctx.lineTo(roadMmX + roadHalfPx, size);
    ctx.stroke();

    /* ── 4. Storm path trail ──
       Faded amber polyline connecting recorded storm positions.
       Older segments are more transparent; recent segments brighter.       */
    if (tracker && tracker.path && tracker.path.length > 1) {
      var pathLen = tracker.path.length;

      ctx.lineCap = 'round';

      for (var pi = 1; pi < pathLen; pi++) {
        var segA   = tracker.path[pi - 1];
        var segB   = tracker.path[pi];
        var ma     = toMM(segA.x, segA.z);
        var mb     = toMM(segB.x, segB.z);

        /* Alpha: ramps from ~0.06 at oldest to ~0.38 at newest point */
        var ageFrac = pi / pathLen;
        var alpha   = 0.06 + ageFrac * 0.32;

        ctx.strokeStyle = 'rgba(255, 110, 0, ' + alpha.toFixed(2) + ')';
        ctx.lineWidth   = 1 + ageFrac;   // thicker toward tip

        ctx.beginPath();
        ctx.moveTo(ma.x, ma.y);
        ctx.lineTo(mb.x, mb.y);
        ctx.stroke();
      }

      /* Oldest end dot — indicates where the storm started this cycle */
      var oldest = toMM(tracker.path[0].x, tracker.path[0].z);
      ctx.beginPath();
      ctx.arc(oldest.x, oldest.y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 80, 0, 0.18)';
      ctx.fill();

      ctx.lineCap = 'butt';   // reset
    }

    /* ── 5. Storm position marker ──
       Pulsing concentric circles. Size + colour = current EF level.
       Only drawn when storm has meaningful intensity.                       */
    if (tracker && tracker.intensity > 0.04 && tracker.pos) {
      var sp      = toMM(tracker.pos.x, tracker.pos.z);
      var ef      = HE.MathUtils.clamp(tracker.efScale, 0, 5);
      var iVal    = tracker.intensity;

      /* Pulse parameters: frequency increases with intensity */
      var pulseHz = HE.MathUtils.lerp(0.8, 2.5, iVal);
      var pulse   = 0.82 + Math.sin(now * 0.001 * pulseHz * Math.PI * 2) * 0.18;

      /* Outer glow (faint, large) */
      var outerR = HE.MathUtils.lerp(5, 15, iVal) * pulse;
      var efColRGB = _HUD.EF_COLOURS[ef];   // e.g. '#ff4400'

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, outerR, 0, Math.PI * 2);
      ctx.fillStyle = this._hexToRGBA(efColRGB, 0.10 * pulse);
      ctx.fill();

      /* Middle ring */
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, outerR * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = this._hexToRGBA(efColRGB, 0.18 * pulse);
      ctx.fill();

      /* Core dot */
      var coreR = HE.MathUtils.lerp(2.2, 5.5, iVal) * pulse;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, coreR, 0, Math.PI * 2);
      ctx.fillStyle = efColRGB;
      ctx.globalAlpha = HE.MathUtils.lerp(0.75, 1.0, pulse);
      ctx.fill();
      ctx.globalAlpha = 1.0;

      /* EF rating label above the dot — only if it fits within canvas */
      var labelY = sp.y - coreR - 5;
      if (labelY > 8 && sp.x > 4 && sp.x < size - 4) {
        ctx.fillStyle  = 'rgba(255, 200, 40, 0.85)';
        ctx.font       = 'bold 7px Courier New';
        ctx.textAlign  = 'center';
        ctx.fillText('EF' + ef, sp.x, labelY);
        ctx.textAlign  = 'left';   // reset
      }
    }

    /* ── 6. Player dot + heading arrow ──
       Amber dot with white rim. Arrow shows current travel heading.
       this.playerHeading is set by main.js before calling update().

       In Three.js: heading 0 → facing +Z (south = down on minimap).
       Screen forward vector: (sin(h), cos(h)) in (mmX, mmY) space.       */
    {
      var h      = this.playerHeading;
      var sinH   = Math.sin(h);
      var cosH   = Math.cos(h);

      /* White rim */
      ctx.beginPath();
      ctx.arc(half, half, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = this._mmColPlayerRim;
      ctx.fill();

      /* Amber core */
      ctx.beginPath();
      ctx.arc(half, half, 3.8, 0, Math.PI * 2);
      ctx.fillStyle = this._mmColPlayerDot;
      ctx.fill();

      /* Heading arrow — line from centre toward travel direction */
      var arrowLen  = 10;
      var tipX      = half + sinH * arrowLen;
      var tipY      = half + cosH * arrowLen;

      ctx.beginPath();
      ctx.moveTo(half, half);
      ctx.lineTo(tipX, tipY);
      ctx.strokeStyle = this._mmColArrow;
      ctx.lineWidth   = 1.8;
      ctx.lineCap     = 'round';
      ctx.stroke();

      /* Arrowhead V-barbs.
         Perpendicular to forward: (-cosH, sinH) in screen space.
         Back point sits arrowLen-4 from centre along heading.           */
      var backX   = half + sinH * (arrowLen - 4);
      var backY   = half + cosH * (arrowLen - 4);
      var barbLen = 2.8;
      var bpX     = -cosH * barbLen;
      var bpY     =  sinH * barbLen;

      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(backX + bpX, backY + bpY);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(backX - bpX, backY - bpY);
      ctx.strokeStyle = this._mmColArrow;
      ctx.lineWidth   = 1.2;
      ctx.stroke();

      ctx.lineCap = 'butt';   // reset
    }

    /* ── 7. Compass 'N' ── */
    ctx.fillStyle  = this._mmNorth;
    ctx.font       = 'bold 8px Courier New';
    ctx.textAlign  = 'center';
    ctx.fillText('N', half, 9);

    /* Tick below 'N' */
    ctx.strokeStyle = this._mmColCompass;
    ctx.lineWidth   = 0.6;
    ctx.beginPath();
    ctx.moveTo(half, 11);
    ctx.lineTo(half, 15);
    ctx.stroke();

    ctx.textAlign = 'left';   // restore default
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _hexToRGBA(hex, alpha)
     Converts a '#rrggbb' hex string and alpha to an rgba() string.
     Used by minimap marker rendering to avoid per-frame string allocation.

     Caches last N conversions — hit rate is high since EF colour set is small.
  ═══════════════════════════════════════════════════════════════════════ */
  _hexToRGBA(hex, alpha) {
    /* Parse '#rrggbb' */
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha.toFixed(2) + ')';
  }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP
     Call on hot-reload or game restart.
  ═══════════════════════════════════════════════════════════════════════ */
  dispose() {
    if (this._bus) {
      this._bus.off('ENTER_VEHICLE', this._onEnterBound);
      this._bus.off('EXIT_VEHICLE',  this._onExitBound);
    }
    this._bus   = null;
    this._mmCtx = null;
    console.log('[HUD] Disposed.');
  }

};
