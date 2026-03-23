/* ═══════════════════════════════════════════════════════════════════════════
   main.js  —  HEXADO CHASING v2.0
   Layer   : Orchestration (load order: 14th — last script in index.html)
   Exports : window.game (HexadoEngine instance, exposed for devtools)
   Deps    : ALL other HE.* modules must be loaded first

   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   HexadoEngine is the single top-level game class. It:

     1.  Instantiates every HE.* module in strict dependency order
     2.  Runs the animated loading sequence (progress bar + status text)
     3.  Owns the requestAnimationFrame loop and dispatches per-frame calls
     4.  Manages the inVehicle ↔ on-foot player state transition (E key)
     5.  Provides the single wiring point between EventBus events

   Game Loop Order (per frame)
   ───────────────────────────
     dt cap → weather → wind → physics/walker → vehicle mesh sync →
     tornado → camera → renderer → stats + HUD → perf optimizer

   Player Mode State Machine
   ──────────────────────────
     inVehicle = true  (default)
       PhysicsEngine drives position + heading
       FPVCamera sits inside cab (eye at 1.15wu above vehicle Y)
       Cockpit visible · driver mesh visible

     inVehicle = false
       Walker drives position + heading (WASD via physics.keys)
       ThirdPersonCamera follows walker
       Walker mesh visible · driver mesh hidden
       [E] available if walker is within 4.5wu of parked vehicle

   Left-side exit vector maths
   ────────────────────────────
     Forward unit vector : (sin h,  cos h)  in (x, z)
     Left perpendicular  : (−cos h, sin h)  in (x, z)
     Spawn = pos + left × EXIT_OFFSET

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export — plain <script> tag
   • EventBus is the ONLY cross-module communication channel
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS  —  tuning numbers live here, not buried in methods
   ═══════════════════════════════════════════════════════════════════════════ */

var _MAIN = {

  /* ─── Player mode transitions ─────────────────────────────────────── */
  ENTER_RANGE:      4.5,   // world units — walker must be within this to re-enter
  EXIT_OFFSET:      1.8,   // world units — walker spawns this far left of vehicle

  /* ─── Loop ────────────────────────────────────────────────────────── */
  DT_MAX:           0.05,  // seconds — caps dt to prevent physics explosion on tab-switch

  /* ─── Loading screen ──────────────────────────────────────────────── */
  LOAD_FADE_DELAY:  700,   // ms — pause after 100% so the bar is readable before hiding

  /* ─── Wheel geometry ─────────────────────────────────────────────── */
  // Must match Characters.js: WHEEL_R = 0.44 world units
  WHEEL_RADIUS:     0.44

};


/* ═══════════════════════════════════════════════════════════════════════════
   HexadoEngine
   ═══════════════════════════════════════════════════════════════════════════ */

class HexadoEngine {

  /* ─────────────────────────────────────────────────────────────────────
     constructor()
     Declares all instance slots. Actual construction happens in init()
     once the DOM is ready. All slots start null so devtools shows the
     full object graph from frame 0 without misleading undefined entries.
  ───────────────────────────────────────────────────────────────────── */
  constructor() {

    /* ── Foundation ── */
    this.bus         = null;   // HE.EventBus  — single shared event bus
    this.vortex      = null;   // HE.VortexMath — Rankine vortex aerodynamics

    /* ── Systems ── */
    this.weather     = null;   // HE.WeatherSystem — storm state machine
    this.physics     = null;   // HE.PhysicsEngine — vehicle dynamics + key state
    this.tornado     = null;   // HE.Tornado — funnel mesh, debris spiral

    /* ── Rendering ── */
    this.renderer    = null;   // HE.Renderer — 3D engine, terrain, environment, particles
    this.hud         = null;   // HE.HUD — DOM stat boxes, EF bar, minimap
    this.stats       = null;   // HE.PlayerStats — speed, distance, proximity, score
    this.tracker     = null;   // HE.StormTracker — EF scale, wind speed, path trail
    this.perfOpt     = null;   // HE.PerformanceOptimizer — LOD + particle budget

    /* ── Characters ── */
    this.vehicleMesh = null;   // THREE.Group — F-150 pickup body
    this.cockpit     = null;   // THREE.Group — FPV interior (dash, wheel, needle)
    this.driverMesh  = null;   // THREE.Group — seated chaser figure
    this.walkerMesh  = null;   // THREE.Group — on-foot chaser figure
    this.fpvCam      = null;   // HE.FPVCamera — first-person view inside cab
    this.tpcCam      = null;   // HE.ThirdPersonCamera — smooth follow cam on foot
    this.walker      = null;   // HE.Walker — on-foot locomotion controller

    /* ── Player state ── */
    this.inVehicle   = true;   // starts in the truck

    /* ── Loop state ── */
    this._lastTime   = 0;      // previous frame timestamp (ms)
    this._wheelAngle = 0;      // accumulated wheel rotation (radians)

    /* ── Cached storm data ─────────────────────────────────────────────
       STORM_UPDATE fires at 20 Hz; the loop runs at 60 Hz.
       We cache the last payload so every loop iteration has consistent
       storm data without being blocked on the EventBus timing.         */
    this._stormPos       = null;   // THREE.Vector3 ref from WeatherSystem
    this._stormIntensity = 0;
    this._stormVisible   = false;
    this._stormState     = 'clear';

    /* ── Bound listeners ── */
    this._onEKey = this._handleEKey.bind(this);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     init()
     Async boot sequence. Shows animated loading bar with status messages.
     Awaited by the window.load handler at the bottom of this file.

     Step order is strictly dictated by the module dependency graph:
       Foundation → Systems → Renderer (heavy: terrain + env + compile) →
       Tornado → Characters → HUD → Optimizer → key bindings
  ═══════════════════════════════════════════════════════════════════════ */

  async init() {

    /* ── Step 1: EventBus + pure math (synchronous, instant) ── */
    this._setLoading(8, 'Initialising event bus…');
    this.bus    = new HE.EventBus();
    this.vortex = new HE.VortexMath();

    /* ── Step 2: Storm system ── */
    this._setLoading(16, 'Spawning storm cell…');
    this.weather = new HE.WeatherSystem(this.bus);

    /* ── Step 3: Vehicle physics + key bindings ── */
    this._setLoading(24, 'Calibrating vehicle dynamics…');
    this.physics = new HE.PhysicsEngine(this.bus);
    this.physics.bindKeys();

    /* ── Step 4: 3D engine + terrain + environment (most expensive) ──
       Renderer.init() calls:
         HE.Engine.init(canvas)       → scene, camera, WebGLRenderer
         HE.TerrainGen.generate(scene)→ 120×120 vertex-coloured terrain
         HE.EnvironmentGen.build(scene)→ poles, barns, trees, clouds …
         new HE.ParticleEngine(scene) → rain + ambient debris
       Progress jumps from 34 → 70 once the await resolves.            */
    this._setLoading(34, 'Building 3D engine…');
    var canvas    = document.getElementById('canvas');
    this.renderer = new HE.Renderer(canvas, this.bus);
    this.renderer.setVortex(this.vortex);
    await this.renderer.init();
    this._setLoading(70, 'Plains generated…');

    /* ── Step 5: Tornado ──
       Needs scene (from renderer) and vortex (for funnelRadius).       */
    this._setLoading(78, 'Conjuring tornado…');
    this.tornado = new HE.Tornado(
      this.renderer.scene,
      this.vortex,
      this.bus
    );

    /* ── Step 6: Characters ── */
    this._setLoading(85, 'Placing storm chaser…');
    this._buildCharacters();

    /* ── Step 7: HUD + stat trackers ── */
    this._setLoading(91, 'Calibrating HUD…');
    this.stats   = new HE.PlayerStats();
    this.tracker = new HE.StormTracker();
    this.hud     = new HE.HUD();
    this.hud.init(this.bus);   // wires ENTER_VEHICLE + EXIT_VEHICLE for mode label

    /* ── Step 8: Performance optimizer ──
       Receives the THREE.WebGLRenderer via renderer.renderer so it can
       read .info.render.triangles for the LOD decisions.               */
    this._setLoading(97, 'Optimising performance…');
    this.perfOpt = new HE.PerformanceOptimizer(this.bus, this.renderer.renderer);

    /* ── Step 9: Bindings ── */
    document.addEventListener('keydown', this._onEKey, { passive: true });
    this._wireStormCache();

    /* ── Done — fade out the loader overlay ── */
    this._setLoading(100, 'Ready — good luck out there.');
    await this._sleep(_MAIN.LOAD_FADE_DELAY);

    var loader = document.getElementById('loader');
    if (loader) loader.classList.add('hidden');

    console.log('[HexadoEngine] Init complete. All systems nominal.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     start()
     Kicks off the requestAnimationFrame loop.
     Called immediately after await init() in the window.load handler.
  ═══════════════════════════════════════════════════════════════════════ */

  start() {
    this._lastTime = performance.now();
    requestAnimationFrame(this._loop.bind(this));
    console.log('[HexadoEngine] Loop started.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _loop(now)
     Main per-frame tick. Dispatches to every sub-system in dependency
     order. requestAnimationFrame is scheduled at the top so a thrown
     error in one frame doesn't kill the loop.

     Sub-system order
     ─────────────────
      1. dt cap             — clamp to DT_MAX (0.05s) preventing teleport on stall
      2. weather.update()   — advance storm state machine, emits STORM_UPDATE
      3. wind → physics     — sample VortexMath for per-frame push force
      4. physics/walker     — integrate motion (one or the other, never both)
      5. vehicle mesh sync  — copy physics pos/heading → THREE.Group transform
      6. tornado.update()   — funnel spin, ring radii, debris spiral
      7. camera             — FPV or TPC, steering wheel, speedo needle
      8. renderer.update()  — sky, fog, sun, particles, WebGL render call
      9. HUD                — stat boxes, EF bar, minimap, alert flash
     10. perfOpt.update()   — rolling frame budget, LOD + particle budget
  ═══════════════════════════════════════════════════════════════════════ */

  _loop(now) {

    /* Re-schedule before any work so the loop survives an exception */
    requestAnimationFrame(this._loop.bind(this));

    /* ── 1. dt cap ── */
    var dt = Math.min((now - this._lastTime) / 1000, _MAIN.DT_MAX);
    this._lastTime = now;
    if (dt <= 0) return;   // guard against degenerate first frame

    /* ── 2. Weather ── */
    this.weather.update(dt);

    /* Read directly from getters after the update so we always have the
       freshest values, even if STORM_UPDATE hasn't fired this frame. */
    var stormPos   = this.weather.pos;
    var intensity  = this.weather.intensity;
    var visible    = this.weather.visible;
    var stormState = this.weather.state;

    /* Keep cache in sync for any code that reads _stormPos directly */
    this._stormPos       = stormPos;
    this._stormIntensity = intensity;
    this._stormVisible   = visible;
    this._stormState     = stormState;

    /* Current player position — live Vector3 ref from the active controller */
    var playerPos = this.inVehicle ? this.physics.pos : this.walker.pos;

    /* ── 3. Wind → physics ──
       Wind forces are only applied while the storm is actually present.
       VortexMath.worldWind() converts cylindrical vortex velocity at the
       player's offset from tornado centre into a world-space XZ impulse.
       physics.applyWind() buffers it; physics.update() integrates it.   */
    if (visible && intensity > 0.01) {
      var dx   = playerPos.x - stormPos.x;
      var dz   = playerPos.z - stormPos.z;
      var wind = this.vortex.worldWind(dx, dz);
      this.physics.applyWind(wind.x, wind.z, intensity);
    }

    /* ── 4. Physics or walker update ──
       heightFn is HE.TerrainGen.heightAt — single source of truth for
       ground Y. Passed in rather than imported directly so it can be
       swapped in tests without touching the modules.                    */
    var heightFn = this.renderer.heightAt;

    if (this.inVehicle) {
      /* Vehicle mode: PhysicsEngine drives throttle → drag → steer → snap */
      this.physics.update(dt, heightFn);
    } else {
      /* On-foot mode: Walker reads same physics.keys (WASD + arrows) */
      this.walker.update(dt, this.physics.keys, heightFn);
    }

    /* ── 5. Vehicle mesh sync ── */
    this._syncVehicleMesh(dt);

    /* ── 6. Tornado ──
       setIntensity() must precede update() so funnelRadius() returns
       values consistent with the current storm intensity.              */
    this.vortex.setIntensity(intensity);
    this.tornado.update(dt, stormPos, intensity);
    this.tornado.setVisible(visible);

    /* ── 7. Camera ── */
    if (this.inVehicle) {

      /* FPV: camera locked inside cab at driver's eye point */
      this.fpvCam.update(dt, this.physics);

      /* Animate cockpit instruments */
      if (this.cockpit) {
        this.fpvCam.animateWheel(
          dt,
          this.cockpit.userData.steeringWheel,
          this.physics.keys
        );
        this.fpvCam.animateNeedle(
          this.cockpit.userData.speedNeedle,
          this.physics.speedKmh
        );
      }

    } else {

      /* Third-person: smooth follow cam behind/above the walker */
      var tpcPos     = this.walker.active ? this.walker.pos     : this.physics.pos;
      var tpcHeading = this.walker.active ? this.walker.heading : this.physics.heading;
      this.tpcCam.update(dt, tpcPos, tpcHeading, heightFn);
    }

    /* ── 8. Renderer ── */
    this.renderer.update(dt, stormPos, intensity, visible);

    /* ── 9. HUD ──
       Proximity: horizontal world-space distance to tornado centre.
       Infinity when storm is clear (PlayerStats treats Infinity as "no storm"). */
    var prox = Infinity;
    if (visible && stormPos) {
      prox = HE.MathUtils.dist2(
        playerPos.x, playerPos.z,
        stormPos.x,  stormPos.z
      );
    }

    this.stats.update(
      dt,
      this.physics.speedKmh,   // always from physics (0 when parked)
      this.physics.distDelta,
      prox
    );

    this.tracker.update(dt, intensity, stormPos);

    /* playerHeading for the minimap heading arrow */
    this.hud.playerHeading = this.inVehicle
      ? this.physics.heading
      : this.walker.heading;

    this.hud.update(
      this.stats,
      this.tracker,
      playerPos,
      this.inVehicle,
      this._canEnterVehicle(),
      stormState
    );

    /* ── 10. Performance optimizer ── */
    this.perfOpt.update(dt);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _syncVehicleMesh(dt)
     Mirrors the PhysicsEngine's authoritative pos + heading onto the
     THREE.Group transforms. Also accumulates and applies wheel spin.

     Wheel spin formula:
       angular velocity (rad/s) = linear speed (m/s) / wheel radius (m)
       ∆angle = ω × dt

     The tyre CylinderGeometry has rotation.z = PI/2 so its axis runs
     along the vehicle's X axis. Rolling forward means spinning around
     the wheel group's local X — so we set wGroup.rotation.x.
  ═══════════════════════════════════════════════════════════════════════ */

  _syncVehicleMesh(dt) {
    if (!this.vehicleMesh) return;

    var pos     = this.physics.pos;
    var heading = this.physics.heading;
    var kmh     = this.physics.speedKmh;

    /* ── Position + heading ── */
    this.vehicleMesh.position.copy(pos);
    /* +PI: vehicle model front is at -Z, but heading 0 = +Z world direction.
       Walker.js uses the same offset (Characters.js line ~1266). */
    this.vehicleMesh.rotation.y = heading + Math.PI;

    /* ── Wheel spin ── */
    var speedMs        = kmh / 3.6;
    var angularVel     = speedMs / _MAIN.WHEEL_RADIUS;   // rad/s
    this._wheelAngle  += angularVel * dt;

    var wheels = this.vehicleMesh.userData.wheelGroups;
    if (wheels) {
      for (var i = 0; i < wheels.length; i++) {
        if (wheels[i]) {
          wheels[i].rotation.x = this._wheelAngle;
        }
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _buildCharacters()
     Creates all character meshes + camera controllers and adds them to
     the scene. Called once during init() after renderer.init() returns.

     Hierarchy added to scene:
       vehicleMesh
         └─ cockpit     (FPV interior)
         └─ driverMesh  (seated chaser, visible in driving mode)
       walkerMesh       (on-foot chaser, hidden until _exitVehicle)
  ═══════════════════════════════════════════════════════════════════════ */

  _buildCharacters() {
    var scene  = this.renderer.scene;
    var camera = this.renderer.camera;

    /* ── Vehicle group ── */
    this.vehicleMesh = HE.VehicleFactory.createVehicle();
    this.cockpit     = HE.VehicleFactory.createCockpit();
    this.driverMesh  = HE.VehicleFactory.createDriver();

    /* Cockpit and driver move with the truck automatically */
    this.vehicleMesh.add(this.cockpit);
    this.vehicleMesh.add(this.driverMesh);
    scene.add(this.vehicleMesh);

    /* ── Walker (hidden until exit) ── */
    this.walkerMesh = HE.VehicleFactory.createWalker();
    scene.add(this.walkerMesh);  // createWalker() returns with visible=false

    /* ── Cameras ── */
    this.fpvCam = new HE.FPVCamera(camera);
    this.tpcCam = new HE.ThirdPersonCamera(camera);

    /* ── Walker controller ── */
    this.walker = new HE.Walker(this.walkerMesh, scene, this.bus);

    /* ── Initial visibility state ── */
    this.inVehicle          = true;
    this.driverMesh.visible = true;   // player is in the seat
    this.walkerMesh.visible = false;  // already set by createWalker(), but explicit

    console.log('[HexadoEngine] Characters built and added to scene.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _handleEKey(e)
     Keydown listener for the [E] key. Toggles between in-vehicle and
     on-foot mode depending on current state and enter-range check.
  ═══════════════════════════════════════════════════════════════════════ */

  _handleEKey(e) {
    if (e.code !== 'KeyE') return;

    if (this.inVehicle) {
      this._exitVehicle();
    } else if (this._canEnterVehicle()) {
      this._tryEnterVehicle();
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _exitVehicle()
     Switches from FPV (in-vehicle) to on-foot (ThirdPerson) mode.

     Walker spawns 1.8wu to the driver's left:
       Left perp to heading (sin h, cos h) = (−cos h, sin h) in (x, z)
       spawnX = pos.x + (−cos h) × EXIT_OFFSET
       spawnZ = pos.z + ( sin h) × EXIT_OFFSET
  ═══════════════════════════════════════════════════════════════════════ */

  _exitVehicle() {
    if (!this.inVehicle) return;

    var pos     = this.physics.pos;
    var heading = this.physics.heading;

    /* ── Spawn position — left of the vehicle ── */
    var spawnX = pos.x + (-Math.cos(heading)) * _MAIN.EXIT_OFFSET;
    var spawnZ = pos.z + ( Math.sin(heading)) * _MAIN.EXIT_OFFSET;
    var spawnY = this.renderer.heightAt(spawnX, spawnZ);

    var spawnPos = new THREE.Vector3(spawnX, spawnY, spawnZ);

    /* ── Switch mode ── */
    this.inVehicle = false;

    /* Hide seated driver — player has stepped out of the cab */
    this.driverMesh.visible = false;

    /* Activate walker at spawn position, facing same direction as vehicle */
    this.walker.activate(spawnPos, heading);

    /* Snap TPC so it doesn't lerp from the old in-cab position */
    this.tpcCam.snapTo(spawnPos, heading);

    /* Notify HUD (mode label) and any future listeners */
    this.bus.emit('EXIT_VEHICLE', { pos: spawnPos });

    console.log('[HexadoEngine] Exit vehicle — walker at ('
      + spawnX.toFixed(1) + ', ' + spawnZ.toFixed(1) + ')');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _tryEnterVehicle()
     Switches from on-foot (ThirdPerson) back to FPV (in-vehicle) mode.
     Guard: only callable when _canEnterVehicle() returns true.
  ═══════════════════════════════════════════════════════════════════════ */

  _tryEnterVehicle() {
    if (this.inVehicle)              return;
    if (!this._canEnterVehicle())    return;

    /* ── Switch mode ── */
    this.inVehicle = true;

    /* Deactivate walker mesh + controller */
    this.walker.deactivate();

    /* Show driver back in the seat */
    this.driverMesh.visible = true;

    /* Notify HUD (mode label) */
    this.bus.emit('ENTER_VEHICLE', {});

    console.log('[HexadoEngine] Entered vehicle.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _canEnterVehicle()
     Returns true if the walker is active AND within ENTER_RANGE world
     units of the vehicle's current physics position.
  ═══════════════════════════════════════════════════════════════════════ */

  _canEnterVehicle() {
    if (this.inVehicle)                       return false;
    if (!this.walker || !this.walker.active)  return false;

    var dist = HE.MathUtils.dist2(
      this.walker.pos.x, this.walker.pos.z,
      this.physics.pos.x, this.physics.pos.z
    );

    return dist < _MAIN.ENTER_RANGE;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _wireStormCache()
     Subscribes to STORM_UPDATE (20 Hz) to keep _stormPos / _stormIntensity
     in sync between EventBus calls. The loop reads these cached values at
     60 Hz so storm data is never stale by more than one bus interval.

     Note: the loop also reads weather getters directly after weather.update()
     so this cache is mostly for any code that runs outside the hot loop.
  ═══════════════════════════════════════════════════════════════════════ */

  _wireStormCache() {
    var self = this;

    this.bus.on('STORM_UPDATE', function(data) {
      if (data.pos)                           self._stormPos       = data.pos;
      if (typeof data.intensity === 'number') self._stormIntensity = data.intensity;
      if (typeof data.visible   === 'boolean') self._stormVisible  = data.visible;
      if (data.state)                         self._stormState     = data.state;
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _setLoading(pct, msg)
     Updates the loading bar and status text in the #loader overlay.

     pct : 0..100 — bar width percentage
     msg : string — status line below the bar
  ═══════════════════════════════════════════════════════════════════════ */

  _setLoading(pct, msg) {
    var bar    = document.getElementById('load-bar');
    var status = document.getElementById('load-status');
    if (bar)    bar.style.width    = pct + '%';
    if (status) status.textContent = msg;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     _sleep(ms)
     Promise-based delay. Used in init() to let the 100% loading bar
     render visibly before the loader fades out.
  ═══════════════════════════════════════════════════════════════════════ */

  _sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

}


/* ═══════════════════════════════════════════════════════════════════════════
   BOOT
   ─────
   window.load fires after every <script> has parsed and all synchronous
   module code has run — guaranteeing all HE.* classes are defined before
   HexadoEngine calls them.

   window.game is exposed on the global so devtools can inspect game state
   live: window.game.physics.pos, window.game.weather.state, etc.

   A try/catch wraps the full boot so an unexpected error surfaces in both
   the console AND in the visible loading screen (red bar + message),
   rather than silently leaving a black canvas.
   ═══════════════════════════════════════════════════════════════════════════ */

window.addEventListener('load', async function() {
  try {
    window.game = new HexadoEngine();
    await window.game.init();
    window.game.start();
  } catch (err) {
    console.error('[HexadoEngine] Fatal boot error:', err);

    /* Surface the error visually so the player isn't left on a black screen */
    var status = document.getElementById('load-status');
    var bar    = document.getElementById('load-bar');
    if (status) status.textContent = 'Boot error — see console (F12)';
    if (bar)    bar.style.background = '#ff2222';
  }
});
