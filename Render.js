/* ═══════════════════════════════════════════════════════════════════════════
   Render.js  —  HEXADO CHASING v2.0
   Layer   : Rendering (load order: 11th — after environment.js)
   Exports : window.HexEngine.Renderer
             window.HexEngine.AssetFactory
             window.HexEngine.ParticleEngine
   Deps    : Three.js r128
             HE.Engine      (3DEngine.js)
             HE.TerrainGen  (terrain.js)
             HE.EnvironmentGen (environment.js)
             HE.MathUtils   (main-math.js)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Render.js is the rendering orchestrator. It does NOT build terrain or place
   environment props — those live in terrain.js and environment.js respectively.
   What it owns:

     ┌─────────────────────────────────────────────────────────────────────┐
     │  Boot sequence  — HE.Engine → TerrainGen → EnvironmentGen →        │
     │                   ParticleEngine → EventBus wiring                 │
     │  Atmosphere     — sky colour, fog density, sun tint (storm lerps)  │
     │  Cloud drift    — slow per-frame translation of cloud meshes       │
     │  ParticleEngine — rain column + ambient debris, intensity-driven   │
     │  Render call    — renderer.render(scene, camera) every frame       │
     └─────────────────────────────────────────────────────────────────────┘

   Storm-driven atmosphere
   ────────────────────────
   Renderer listens to STORM_UPDATE (emitted by weather.js at ~20 Hz).
   Each frame, update() lerps sky colour, fog density, and sun tint from
   clear Oklahoma blue toward sickly EF5 green-grey using the cached
   intensity value. The ParticleEngine receives the same intensity to
   scale rain opacity and spawn rate.

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export — plain <script> tag
   • Three.js r128: no CapsuleGeometry anywhere
   • EventBus is the ONLY cross-module communication channel
   • TerrainGen and EnvironmentGen are CALLED here, not reimplemented
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

var _R = {

  /* ─── Sky palette ─────────────────────────────────────────── */
  SKY_CLEAR:          new THREE.Color(0x7aa0c0),   // bright Oklahoma afternoon
  SKY_OVERCAST:       new THREE.Color(0x5a7890),   // building clouds
  SKY_STORM:          new THREE.Color(0x2e3c28),   // sickly EF5 green-grey

  /* ─── Fog ─────────────────────────────────────────────────── */
  FOG_COL_CLEAR:      new THREE.Color(0x8aacbf),
  FOG_COL_STORM:      new THREE.Color(0x2e3c28),
  FOG_DENSITY_CLEAR:  0.0045,
  FOG_DENSITY_STORM:  0.0098,

  /* ─── Sun (DirectionalLight) ──────────────────────────────── */
  SUN_COL_CLEAR:      new THREE.Color(0xfff0cc),   // warm gold
  SUN_COL_STORM:      new THREE.Color(0x7a9944),   // cold olive
  SUN_INT_CLEAR:      1.15,
  SUN_INT_STORM:      0.38,

  /* ─── Atmosphere lerp speed ───────────────────────────────── */
  // How quickly sky/fog track target intensity. Too fast = jarring.
  // 0.92 per-frame at 60fps ≈ e-fold time of ~16 frames ≈ 0.27s.
  ATMO_LERP:          0.035,   // fraction per frame (independent of dt)

  /* ─── Cloud drift ─────────────────────────────────────────── */
  CLOUD_SPEED:        0.8,     // world units/s — very slow eastward drift
  CLOUD_RESET_X:     -220,     // X at which clouds wrap back to east side
  CLOUD_SPAWN_X:      220,     // X from which they spawn

  /* ─── Rain particles ─────────────────────────────────────── */
  RAIN_COUNT:         3500,
  RAIN_HEIGHT:        75,      // volume height (world units)
  RAIN_SPREAD:        160,     // XZ half-extent around player
  RAIN_SPEED_MIN:     22,      // world units/s at near-zero intensity
  RAIN_SPEED_MAX:     58,      // world units/s at EF5

  /* ─── Ambient debris (separate from tornado.js debris) ───── */
  AMBIENT_DEBRIS_COUNT: 180,
  AMBIENT_DEBRIS_RANGE: 90
};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.AssetFactory
   ────────────────
   Legacy helper. Returns a simple tornado silhouette group used as a
   placeholder before HE.Tornado is instantiated. main.js uses HE.Tornado
   directly — this class is kept for compatibility and potential reuse.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.AssetFactory = class {

  /* Creates a minimal 3-ring tornado Group for placeholder / HUD previews */
  static createTornadoMesh() {
    var group = new THREE.Group();
    group.name = 'tornadoAsset';

    var mat = new THREE.MeshBasicMaterial({
      color:       0x888888,
      transparent: true,
      opacity:     0.55,
      depthWrite:  false,
      side:        THREE.DoubleSide
    });

    var heights = [0, 18, 38];
    var radii   = [5.5, 3.0, 1.2];

    for (var i = 0; i < 3; i++) {
      var geo  = new THREE.TorusGeometry(radii[i], 0.4, 5, 16);
      var ring = new THREE.Mesh(geo, mat);
      ring.position.y = heights[i];
      group.add(ring);
    }

    return group;
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.ParticleEngine
   ──────────────────
   Owns two particle systems:

     rainPts    — vertical rain streaks that follow the player and intensify
                  with storm severity. Particles fall from RAIN_HEIGHT toward
                  ground and wrap back to the top when they pass y = 0.

     debrisPts  — slow-floating ambient dust/leaf particles outside the main
                  tornado debris. Visible during forming + active phases,
                  scattered randomly around the player.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.ParticleEngine = class {

  constructor(scene) {
    this._scene     = scene;
    this._intensity = 0;

    /* Per-particle state for rain (position + velocity) */
    this._rainVel = new Float32Array(_R.RAIN_COUNT);   // per-particle fall speed

    this._buildRain();
    this._buildAmbientDebris();

    console.log('[ParticleEngine] Ready — '
      + _R.RAIN_COUNT + ' rain, '
      + _R.AMBIENT_DEBRIS_COUNT + ' debris.');
  }


  /* ── Rain ────────────────────────────────────────────────────────────── */

  _buildRain() {
    var count = _R.RAIN_COUNT;
    var pos   = new Float32Array(count * 3);
    var col   = new Float32Array(count * 3);   // blue-grey streaks

    for (var i = 0; i < count; i++) {
      /* Scatter particles randomly inside the rain volume on init */
      pos[i * 3    ] = HE.MathUtils.randRange(-_R.RAIN_SPREAD, _R.RAIN_SPREAD);
      pos[i * 3 + 1] = Math.random() * _R.RAIN_HEIGHT;
      pos[i * 3 + 2] = HE.MathUtils.randRange(-_R.RAIN_SPREAD, _R.RAIN_SPREAD);

      /* Stagger individual fall speeds for depth variety */
      this._rainVel[i] = HE.MathUtils.randRange(0.85, 1.15);

      /* Colour: pale blue-grey, slightly varying per particle */
      col[i * 3    ] = 0.62 + Math.random() * 0.08;
      col[i * 3 + 1] = 0.70 + Math.random() * 0.08;
      col[i * 3 + 2] = 0.82 + Math.random() * 0.10;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    var mat = new THREE.PointsMaterial({
      size:            0.28,
      vertexColors:    true,
      transparent:     true,
      opacity:         0.0,    // starts invisible; fades in with intensity
      depthWrite:      false,
      sizeAttenuation: true
    });

    this.rainPts         = new THREE.Points(geo, mat);
    this.rainPts.name    = 'rain';
    this.rainPts.visible = false;
    this._scene.add(this.rainPts);

    this._rainPos = pos;
    this._rainGeo = geo;
    this._rainMat = mat;
  }


  /* ── Ambient debris ──────────────────────────────────────────────────── */

  _buildAmbientDebris() {
    var count = _R.AMBIENT_DEBRIS_COUNT;
    var pos   = new Float32Array(count * 3);
    var col   = new Float32Array(count * 3);

    for (var i = 0; i < count; i++) {
      var r  = _R.AMBIENT_DEBRIS_RANGE;
      pos[i * 3    ] = HE.MathUtils.randRange(-r, r);
      pos[i * 3 + 1] = HE.MathUtils.randRange(0.5, 12);
      pos[i * 3 + 2] = HE.MathUtils.randRange(-r, r);

      /* Earthy browns / tans */
      col[i * 3    ] = 0.35 + Math.random() * 0.25;
      col[i * 3 + 1] = 0.25 + Math.random() * 0.15;
      col[i * 3 + 2] = 0.10 + Math.random() * 0.10;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    var mat = new THREE.PointsMaterial({
      size:            1.8,
      vertexColors:    true,
      transparent:     true,
      opacity:         0.0,
      depthWrite:      false,
      sizeAttenuation: true
    });

    this.debrisPts         = new THREE.Points(geo, mat);
    this.debrisPts.name    = 'ambientDebris';
    this.debrisPts.visible = false;
    this._scene.add(this.debrisPts);

    this._debrisPos = pos;
    this._debrisGeo = geo;
    this._debrisMat = mat;
  }


  /* ── Per-frame update ────────────────────────────────────────────────── */

  /* update(dt, tornadoPos, vortex, intensity)
     ───────────────────────────────────────────
     dt         : delta time (seconds, already capped)
     tornadoPos : THREE.Vector3 — current storm world position
     vortex     : HE.VortexMath — for turbulence outside main vortex
     intensity  : 0..1 — drives visibility, rain speed, debris opacity     */
  update(dt, tornadoPos, vortex, intensity) {
    this._intensity = HE.MathUtils.clamp(intensity, 0, 1);

    this._updateRain(dt, tornadoPos);
    this._updateDebris(dt, tornadoPos, vortex);
  }


  /* Rain: falls toward ground, wraps to top, tracks tornado position */
  _updateRain(dt, tornadoPos) {
    var i      = this._intensity;
    var show   = (i > 0.05);

    this.rainPts.visible  = show;
    if (!show) return;

    /* Lerp opacity: 0 at i=0.05 → 0.65 at i=1 */
    this._rainMat.opacity = HE.MathUtils.lerp(0, 0.65, HE.MathUtils.smoothstep(0.05, 0.5, i));
    this._rainMat.needsUpdate = true;

    /* Fall speed scales with intensity */
    var speed = HE.MathUtils.lerp(_R.RAIN_SPEED_MIN, _R.RAIN_SPEED_MAX, i);

    var pos = this._rainPos;
    var tx  = tornadoPos ? tornadoPos.x : 0;
    var tz  = tornadoPos ? tornadoPos.z : 0;
    var spread = _R.RAIN_SPREAD;

    for (var p = 0; p < _R.RAIN_COUNT; p++) {
      /* Apply individual velocity multiplier for variety */
      pos[p * 3 + 1] -= speed * this._rainVel[p] * dt;

      /* Wrap: when past ground, teleport back to top of rain volume */
      if (pos[p * 3 + 1] < 0) {
        pos[p * 3    ] = tx + HE.MathUtils.randRange(-spread, spread);
        pos[p * 3 + 1] = _R.RAIN_HEIGHT;
        pos[p * 3 + 2] = tz + HE.MathUtils.randRange(-spread, spread);
      }
    }

    this._rainGeo.attributes.position.needsUpdate = true;
  }


  /* Ambient debris: slow chaotic drift, visible during storm */
  _updateDebris(dt, tornadoPos, vortex) {
    var i    = this._intensity;
    var show = (i > 0.08);

    this.debrisPts.visible  = show;
    if (!show) return;

    this._debrisMat.opacity = HE.MathUtils.lerp(0, 0.72, HE.MathUtils.smoothstep(0.08, 0.6, i));
    this._debrisMat.needsUpdate = true;

    var pos   = this._debrisPos;
    var count = _R.AMBIENT_DEBRIS_COUNT;
    var range = _R.AMBIENT_DEBRIS_RANGE;
    var tx    = tornadoPos ? tornadoPos.x : 0;
    var tz    = tornadoPos ? tornadoPos.z : 0;
    var time  = performance.now() * 0.001;

    for (var p = 0; p < count; p++) {
      var px = pos[p * 3    ];
      var py = pos[p * 3 + 1];
      var pz = pos[p * 3 + 2];

      /* Sample turbulence from VortexMath for wind influence */
      var turb = vortex
        ? vortex.turbulence(px, pz, time)
        : { x: 0, z: 0 };

      /* Gentle upward drift + turbulence + slow fall back down */
      pos[p * 3    ] += (turb.x * 0.5 + HE.MathUtils.randRange(-0.3, 0.3)) * dt * i;
      pos[p * 3 + 1] += (HE.MathUtils.lerp(0.4, 2.2, i) - 0.15) * dt;
      pos[p * 3 + 2] += (turb.z * 0.5 + HE.MathUtils.randRange(-0.3, 0.3)) * dt * i;

      /* Respawn when drifting out of range or above ceiling */
      if (py > 22 || Math.abs(px - tx) > range || Math.abs(pz - tz) > range) {
        pos[p * 3    ] = tx + HE.MathUtils.randRange(-range, range);
        pos[p * 3 + 1] = HE.MathUtils.randRange(0.5, 4);
        pos[p * 3 + 2] = tz + HE.MathUtils.randRange(-range, range);
      }
    }

    this._debrisGeo.attributes.position.needsUpdate = true;
  }


  /* ── Cleanup ─────────────────────────────────────────────────────────── */

  dispose() {
    this._rainGeo.dispose();
    this._rainMat.dispose();
    this._debrisGeo.dispose();
    this._debrisMat.dispose();
    this._scene.remove(this.rainPts);
    this._scene.remove(this.debrisPts);
    console.log('[ParticleEngine] Disposed.');
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.Renderer
   ────────────
   Top-level rendering orchestrator.

   Constructed by main.js with (canvas, bus). Calling await init() runs the
   full boot sequence, then main.js calls update(dt, ...) every frame from
   inside _loop().
   ═══════════════════════════════════════════════════════════════════════════ */

HE.Renderer = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(canvas, bus)
     canvas : HTMLCanvasElement — #canvas from index.html
     bus    : HE.EventBus instance — injected by main.js
  ───────────────────────────────────────────────────────────────────── */
  constructor(canvas, bus) {
    if (!canvas) console.error('[Renderer] canvas is required.');
    if (!bus)    console.error('[Renderer] EventBus is required.');

    this._canvas = canvas;
    this._bus    = bus;

    /* Filled by init() */
    this._engine   = null;
    this._scene    = null;
    this._camera   = null;
    this._renderer = null;

    /* Cloud meshes returned by EnvironmentGen.build() */
    this._clouds   = [];

    /* ParticleEngine instance */
    this._particles = null;

    /* Cached storm state (updated via STORM_UPDATE event at ~20 Hz) */
    this._stormIntensity  = 0;
    this._stormPos        = new THREE.Vector3(0, 0, 200);
    this._stormVisible    = false;
    this._stormState      = 'clear';

    /* Cached vortex ref (injected by main.js after init so we can pass
       it to ParticleEngine.update without Renderer needing to own it)  */
    this._vortex = null;

    /* Smooth atmosphere target (lerped toward storm intensity each frame) */
    this._atmoT  = 0;

    /* Temporary colour objects reused every frame — avoids GC */
    this._tmpSkyCol = new THREE.Color();
    this._tmpFogCol = new THREE.Color();
    this._tmpSunCol = new THREE.Color();

    /* Performance level: set via PERFORMANCE_ADJUST event */
    this._lodLevel = 0;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     init()
     Async boot sequence. Awaited by main.js before starting the loop.

     Steps (in strict order):
       1. HE.Engine.init(canvas)       → scene, camera, renderer
       2. HE.TerrainGen.generate(scene)→ terrain mesh
       3. HE.EnvironmentGen.build()    → { props, clouds }
       4. new HE.ParticleEngine(scene) → rain + debris
       5. EventBus subscriptions       → STORM_UPDATE, PERFORMANCE_ADJUST
  ═══════════════════════════════════════════════════════════════════════ */

  async init() {

    /* ── 1. Boot 3D engine ── */
    this._engine = new HE.Engine();
    var core = this._engine.init(this._canvas);

    this._scene    = core.scene;
    this._camera   = core.camera;
    this._renderer = core.renderer;

    console.log('[Renderer] 3DEngine booted.');

    /* ── 2. Generate terrain ── */
    HE.TerrainGen.generate(this._scene);
    console.log('[Renderer] Terrain generated.');

    /* ── 3. Build environment props ── */
    var env = HE.EnvironmentGen.build(this._scene);

    /* EnvironmentGen.build() returns { props, clouds }.
       Store clouds array for per-frame drift in update(). */
    if (env && Array.isArray(env.clouds)) {
      this._clouds = env.clouds;
      console.log('[Renderer] Environment built — ' + this._clouds.length + ' cloud meshes.');
    } else {
      /* If environment.js returns nothing or different shape, handle gracefully */
      this._clouds = [];
      console.warn('[Renderer] EnvironmentGen.build() did not return expected { props, clouds } shape.');
    }

    /* ── 4. Particle engine ── */
    this._particles = new HE.ParticleEngine(this._scene);

    /* ── 5. EventBus wiring ── */
    this._bus.on('STORM_UPDATE',      this._onStormUpdate.bind(this));
    this._bus.on('PERFORMANCE_ADJUST', this._onPerfAdjust.bind(this));

    console.log('[Renderer] Init complete.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt, stormPos, intensity, tornVisible)
     Per-frame call from main.js._loop().

     dt          : delta time (seconds, capped to 0.05)
     stormPos    : THREE.Vector3 — current tornado world position
     intensity   : 0..1 — current storm intensity from WeatherSystem
     tornVisible : bool — whether tornado mesh is currently visible
  ═══════════════════════════════════════════════════════════════════════ */

  update(dt, stormPos, intensity, tornVisible) {

    /* ── 1. Cloud drift ── */
    this._driftClouds(dt);

    /* ── 2. Smooth atmosphere tracking ──
       _atmoT lerps toward intensity at ATMO_LERP rate.
       This means the sky transition lags slightly behind the storm,
       which feels more natural than instant snapping. */
    var targetAtmo   = HE.MathUtils.clamp(intensity, 0, 1);
    this._atmoT += (targetAtmo - this._atmoT) * _R.ATMO_LERP * (dt * 60);
    this._atmoT  = HE.MathUtils.clamp(this._atmoT, 0, 1);

    /* ── 3. Sky, fog, sun ── */
    this._updateAtmosphere(this._atmoT);

    /* ── 4. Particle engine ── */
    if (this._particles) {
      this._particles.update(
        dt,
        stormPos || this._stormPos,
        this._vortex,
        this._atmoT
      );
    }

    /* ── 5. Render ── */
    if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }


  /* ─────────────────────────────────────────────────────────────────────
     _driftClouds(dt)
     Slowly translates all cloud meshes westward. When a cloud drifts past
     CLOUD_RESET_X it teleports back to CLOUD_SPAWN_X, creating a seamless
     infinite loop effect. Clouds also lower slightly during storm build-up
     (darkening overcast feel).
  ───────────────────────────────────────────────────────────────────── */
  _driftClouds(dt) {
    var drift = _R.CLOUD_SPEED * dt;
    for (var i = 0; i < this._clouds.length; i++) {
      var c = this._clouds[i];
      c.position.x -= drift;

      /* Wrap around */
      if (c.position.x < _R.CLOUD_RESET_X) {
        c.position.x = _R.CLOUD_SPAWN_X;
        /* Randomise Z on wrap so each pass feels different */
        c.position.z = HE.MathUtils.randRange(-180, 180);
      }

      /* Storm cloud darkening: lerp cloud colour toward storm-grey */
      if (c.material) {
        c.material.color.lerpColors(
          new THREE.Color(0xdde8ef),   // clear-day white cloud
          new THREE.Color(0x5a5a5a),   // storm anvil dark
          this._atmoT
        );
        /* Clouds also drop slightly as storm intensifies */
        c.position.y = HE.MathUtils.lerp(c.userData.baseY || 80, 50, this._atmoT);
      }
    }
  }


  /* ─────────────────────────────────────────────────────────────────────
     _updateAtmosphere(t)
     t : 0..1 smooth atmosphere intensity (not raw storm intensity —
         already passed through the ATMO_LERP smoothing above).

     Animates:
       • Scene background colour (sky dome)
       • FogExp2 colour + density
       • Sun DirectionalLight colour + intensity
  ───────────────────────────────────────────────────────────────────── */
  _updateAtmosphere(t) {
    var ts = HE.MathUtils.smoothstep(0, 1, t);   // sharpen the mid-range

    /* ── Sky colour: clear → overcast → storm ── */
    if (t < 0.5) {
      /* First half: clear → overcast (linear lerp between clear and overcast) */
      this._tmpSkyCol.lerpColors(_R.SKY_CLEAR, _R.SKY_OVERCAST, t * 2);
    } else {
      /* Second half: overcast → storm-green */
      this._tmpSkyCol.lerpColors(_R.SKY_OVERCAST, _R.SKY_STORM, (t - 0.5) * 2);
    }
    if (this._scene) {
      this._scene.background = this._tmpSkyCol.clone();
    }

    /* ── Fog ── */
    if (this._engine && this._engine.fogRef) {
      var fog = this._engine.fogRef;
      this._tmpFogCol.lerpColors(_R.FOG_COL_CLEAR, _R.FOG_COL_STORM, ts);
      fog.color.copy(this._tmpFogCol);
      fog.density = HE.MathUtils.lerp(
        _R.FOG_DENSITY_CLEAR,
        _R.FOG_DENSITY_STORM,
        ts
      );
    }

    /* ── Sun ── */
    if (this._engine && this._engine.sun) {
      var sun = this._engine.sun;
      this._tmpSunCol.lerpColors(_R.SUN_COL_CLEAR, _R.SUN_COL_STORM, ts);
      sun.color.copy(this._tmpSunCol);
      sun.intensity = HE.MathUtils.lerp(
        _R.SUN_INT_CLEAR,
        _R.SUN_INT_STORM,
        ts
      );
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     EVENT HANDLERS
  ═══════════════════════════════════════════════════════════════════════ */

  /* Fired by weather.js at ~20 Hz. Caches storm state so update() can
     use it every frame without depending on bus timing. */
  _onStormUpdate(data) {
    if (data.pos)       this._stormPos.copy(data.pos);
    if (typeof data.intensity === 'number') this._stormIntensity = data.intensity;
    if (typeof data.visible   === 'boolean') this._stormVisible  = data.visible;
    if (data.state)     this._stormState = data.state;
  }

  /* Fired by PerformanceOptimizer when fps drops below target. */
  _onPerfAdjust(data) {
    if (typeof data.lodLevel === 'number') {
      this._lodLevel = HE.MathUtils.clamp(data.lodLevel, 0, 2);
    }
    /* Pass particle budget to ParticleEngine if needed in future LOD work */
  }


  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC SETTERS — called by main.js after construction
  ═══════════════════════════════════════════════════════════════════════ */

  /* main.js injects the VortexMath instance so ParticleEngine can use
     turbulence() for debris wind without Renderer needing to construct it. */
  setVortex(vortex) {
    this._vortex = vortex;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     READ-ONLY GETTERS
  ═══════════════════════════════════════════════════════════════════════ */

  /** THREE.Scene */
  get scene()    { return this._scene; }

  /** THREE.PerspectiveCamera */
  get camera()   { return this._camera; }

  /**
   * HE.TerrainGen.heightAt — the single source of truth for ground Y.
   * main.js passes this to PhysicsEngine.update() and ThirdPersonCamera.
   * Exposed as a getter so callers get the bound static method directly.
   */
  get heightAt() { return HE.TerrainGen.heightAt; }

  /** THREE.WebGLRenderer — used by PerformanceOptimizer */
  get renderer() { return this._renderer; }

  /** ParticleEngine instance — visibility toggled by main.js */
  get particles() { return this._particles; }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP
  ═══════════════════════════════════════════════════════════════════════ */

  dispose() {
    this._bus.off('STORM_UPDATE',       this._onStormUpdate.bind(this));
    this._bus.off('PERFORMANCE_ADJUST', this._onPerfAdjust.bind(this));

    if (this._particles) this._particles.dispose();
    if (this._engine)    this._engine.dispose();

    this._clouds   = [];
    this._vortex   = null;
    this._scene    = null;
    this._camera   = null;
    this._renderer = null;

    console.log('[Renderer] Disposed.');
  }

};
