/* ═══════════════════════════════════════════════════════════════════════════
   tornado.js  —  HEXADO CHASING v2.0
   Layer   : Systems (load order: 7th — after weather.js)
   Exports : window.HexEngine.Tornado
   Deps    : Three.js r128 · HE.VortexMath (main-math.js) · HE.MathUtils
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Owns all Three.js geometry and animation for the tornado visual:

     ┌────────────────────────────────────────────────────────────────┐
     │  FUNNEL  —  10 stacked rings, Rankine-shaped, rotating CCW     │
     │  DEBRIS  —  BufferGeometry Points spiral via VortexMath        │
     │  SHADOW  —  Ellipse ground decal, scales with intensity        │
     │  SKIRT   —  Wide condensation cone at ground contact           │
     └────────────────────────────────────────────────────────────────┘

   Sub-systems (executed each update())
   ─────────────────────────────────────
   1. Funnel rotation    — Y-axis spin rate scales with intensity
   2. Ring radii rebuild — funnelRadius() called each frame (cheap, no GC)
   3. Opacity / colour   — transitions through forming → active → dissipating
   4. Debris spiral      — VortexMath.spiralPos() drives each particle
   5. Ground shadow      — scales XZ with intensity, stays at ground level
   6. Skirt wobble       — oscillates scale.x/z for turbulent ground contact

   Public API (matches contract in SKILL.md)
   ──────────
     tornado = new HE.Tornado(scene, vortex)
     tornado.mesh        → THREE.Group  (funnel + shadow + skirt)
     tornado.debrisPts   → THREE.Points (spiral debris)
     tornado.update(dt, pos, intensity)
     tornado.setVisible(bool)

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export
   • Three.js r128: no CapsuleGeometry — rings use TorusGeometry
   • EventBus consumed via constructor injection (bus param optional here;
     tornado listens for PERFORMANCE_ADJUST via the bus passed in)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

var _TORN = {

  /* ─── Funnel geometry ─────────────────────────────────────── */
  RING_COUNT:      10,   // stacked horizontal rings building the funnel silhouette
  RING_SEGS:       20,   // radial segments per ring (cheap, tornado is far away)
  RING_TUBE_R:     0.38, // tube radius of each torus ring (world units)
  FUNNEL_HEIGHT:   52,   // total world-unit height from ground to cloud base

  /* ─── Debris particles ────────────────────────────────────── */
  DEBRIS_COUNT:    280,  // default particle budget (PerformanceOptimizer may lower)
  DEBRIS_HEIGHT:   38,   // max height of debris column
  DEBRIS_SIZE:     1.6,  // base point sprite size

  /* ─── Rotation ────────────────────────────────────────────── */
  // Funnel spins CCW (negative Y axis). Speed scales with intensity.
  ROT_MIN:         0.55, // rad/s at EF0
  ROT_MAX:         3.80, // rad/s at EF5

  /* ─── Skirt (ground contact condensation) ────────────────── */
  SKIRT_HEIGHT:    6.0,  // height of the wide cone at ground contact
  SKIRT_SEGS:      16,
  SKIRT_WOBBLE_F:  2.1,  // wobble frequency (Hz)
  SKIRT_WOBBLE_A:  0.14, // wobble amplitude (fractional scale change)

  /* ─── Shadow decal ────────────────────────────────────────── */
  SHADOW_MAX_R:    28,   // max shadow ellipse radius at full intensity
  SHADOW_OPACITY:  0.48,

  /* ─── Colour transitions ──────────────────────────────────── */
  // Funnel colour lerps white → dark grey → near-black through lifecycle
  COL_FORMING:     0xd8d8d8,
  COL_ACTIVE:      0x4a4a4a,
  COL_DISSIPATE:   0xaaaaaa,

  /* ─── Opacity ─────────────────────────────────────────────── */
  OPACITY_FORMING: 0.55,
  OPACITY_ACTIVE:  0.82,
  OPACITY_DISSIPATE: 0.28,

  /* ─── LOD thresholds (set by PerformanceOptimizer) ──────── */
  // lodLevel 0 = full, 1 = reduced rings+debris, 2 = minimal
  LOD_RING_COUNTS: [10, 7, 4]
};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.Tornado
   ═══════════════════════════════════════════════════════════════════════════ */

HE.Tornado = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(scene, vortex, bus)
     scene  : THREE.Scene — tornado group added directly
     vortex : HE.VortexMath instance — drives funnel shape + debris math
     bus    : HE.EventBus (optional) — listens for PERFORMANCE_ADJUST
  ───────────────────────────────────────────────────────────────────── */
  constructor(scene, vortex, bus) {
    if (!scene || !vortex) {
      console.error('[Tornado] scene and vortex are required.');
      return;
    }

    this._scene  = scene;
    this._vortex = vortex;
    this._bus    = bus || null;

    /* ── Mutable state ── */
    this._intensity  = 0;
    this._time       = 0;       // accumulated time for spiral animation
    this._rotY       = 0;       // current funnel Y rotation (radians)
    this._lodLevel   = 0;       // 0=full, 1=reduced, 2=minimal
    this._debrisBudget = _TORN.DEBRIS_COUNT;
    this._visible    = false;

    /* ── Build all geometry ── */
    this._group = new THREE.Group();
    this._group.name = 'tornado';

    this._buildShadow();
    this._buildSkirt();
    this._buildFunnel();
    this._buildDebris();

    this._group.visible = false;
    this._scene.add(this._group);

    /* ── Listen for performance adjustments ── */
    if (this._bus) {
      this._bus.on('PERFORMANCE_ADJUST', this._onPerfAdjust.bind(this));
    }

    console.log('[Tornado] Ready — ' + _TORN.DEBRIS_COUNT + ' debris particles, '
      + _TORN.RING_COUNT + ' funnel rings.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     GEOMETRY BUILDERS — called once in constructor
  ═══════════════════════════════════════════════════════════════════════ */

  /* ── Ground shadow decal ─────────────────────────────────────────────── */
  _buildShadow() {
    // Flat ellipse just above ground (Y = 0.05) so it never z-fights terrain
    var geo = new THREE.CircleGeometry(1, 32);
    var mat = new THREE.MeshBasicMaterial({
      color:       0x1a0e00,
      transparent: true,
      opacity:     _TORN.SHADOW_OPACITY,
      depthWrite:  false,
      side:        THREE.DoubleSide
    });
    this._shadow = new THREE.Mesh(geo, mat);
    this._shadow.name = 'shadow';
    this._shadow.rotation.x = -Math.PI / 2;
    this._shadow.position.y = 0.05;
    this._group.add(this._shadow);
  }

  /* ── Ground contact skirt (wide condensation cone) ───────────────────── */
  _buildSkirt() {
    // ConeGeometry: open at top (radius 0) and wide at base — inverted
    // In Three.js r128 ConeGeometry(radiusTop, radiusBottom, height, segs, openEnded)
    // We want wide base at Y=0, narrow top at Y=skirtHeight
    var geo = new THREE.ConeGeometry(
      7.5,                  // base radius (world units)
      _TORN.SKIRT_HEIGHT,   // height
      _TORN.SKIRT_SEGS,     // radial segments
      1,                    // height segments
      true                  // open ended — no caps
    );

    var mat = new THREE.MeshBasicMaterial({
      color:       _TORN.COL_FORMING,
      transparent: true,
      opacity:     0.22,
      depthWrite:  false,
      side:        THREE.DoubleSide,
      wireframe:   false
    });

    this._skirt = new THREE.Mesh(geo, mat);
    this._skirt.name = 'skirt';
    // Pivot at ground: offset by half height so base sits at Y=0
    this._skirt.position.y = _TORN.SKIRT_HEIGHT * 0.5;
    this._group.add(this._skirt);

    // Store mat ref for colour transitions
    this._skirtMat = mat;
  }

  /* ── Main funnel — stacked torus rings ───────────────────────────────── */
  _buildFunnel() {
    this._funnelGroup = new THREE.Group();
    this._funnelGroup.name = 'funnel';
    this._group.add(this._funnelGroup);

    this._rings    = [];  // THREE.Mesh[]
    this._ringMats = [];  // THREE.MeshBasicMaterial[] (one per ring for opacity gradient)

    for (var i = 0; i < _TORN.RING_COUNT; i++) {
      var normH = i / (_TORN.RING_COUNT - 1);  // 0 = ground, 1 = cloud base

      /* Per-ring material: rings near ground are slightly more opaque */
      var mat = new THREE.MeshBasicMaterial({
        color:       _TORN.COL_FORMING,
        transparent: true,
        opacity:     _TORN.OPACITY_FORMING * (0.65 + 0.35 * (1 - normH)),
        depthWrite:  false,
        side:        THREE.DoubleSide,
        wireframe:   false
      });

      /* Radius driven by VortexMath.funnelRadius() — syncs with physics */
      var radius = this._vortex.funnelRadius(normH);

      var geo = new THREE.TorusGeometry(
        radius,          // torus radius
        _TORN.RING_TUBE_R, // tube radius
        6,               // tubular segments (low = hex cross-section look)
        _TORN.RING_SEGS  // radial segments
      );

      var ring = new THREE.Mesh(geo, mat);
      ring.name = 'ring_' + i;
      ring.position.y = normH * _TORN.FUNNEL_HEIGHT;

      // Slight random phase offset per ring so they're not perfectly aligned
      ring.rotation.y = (i / _TORN.RING_COUNT) * Math.PI * 2;

      this._funnelGroup.add(ring);
      this._rings.push(ring);
      this._ringMats.push(mat);
    }
  }

  /* ── Debris point cloud ──────────────────────────────────────────────── */
  _buildDebris() {
    var count = _TORN.DEBRIS_COUNT;

    /* Pre-allocate Float32Arrays — reused every frame, no GC */
    this._debrisPositions = new Float32Array(count * 3);
    this._debrisColors    = new Float32Array(count * 3);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.BufferAttribute(this._debrisPositions, 3));
    geo.setAttribute('color',
      new THREE.BufferAttribute(this._debrisColors, 3));

    /* Seed initial positions (spiral will overwrite each frame) */
    for (var i = 0; i < count; i++) {
      this._debrisPositions[i * 3    ] = (Math.random() - 0.5) * 4;
      this._debrisPositions[i * 3 + 1] = Math.random() * _TORN.DEBRIS_HEIGHT;
      this._debrisPositions[i * 3 + 2] = (Math.random() - 0.5) * 4;

      /* Colour: dark earthy debris — browns, greys */
      this._debrisColors[i * 3    ] = 0.22 + Math.random() * 0.18;
      this._debrisColors[i * 3 + 1] = 0.17 + Math.random() * 0.12;
      this._debrisColors[i * 3 + 2] = 0.10 + Math.random() * 0.08;
    }

    var mat = new THREE.PointsMaterial({
      size:            _TORN.DEBRIS_SIZE,
      vertexColors:    true,
      transparent:     true,
      opacity:         0.85,
      depthWrite:      false,
      sizeAttenuation: true
    });

    this._debrisMesh = new THREE.Points(geo, mat);
    this._debrisMesh.name = 'debris';

    /* Debris is added directly to scene (not the group) so it positions
       via absolute world coords set in update() — easier than group-local. */
    this._scene.add(this._debrisMesh);
    this._debrisMesh.visible = false;

    this._debrisMat = mat;
    this._debrisGeo = geo;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt, pos, intensity)
     Called every frame by main.js._loop()

     dt        : delta time (seconds)
     pos       : THREE.Vector3 — current tornado world position
     intensity : 0..1 — from WeatherSystem
  ═══════════════════════════════════════════════════════════════════════ */

  update(dt, pos, intensity) {
    this._time      += dt;
    this._intensity  = HE.MathUtils.clamp(intensity, 0, 1);

    /* Sync VortexMath so funnelRadius() returns correct values */
    this._vortex.setIntensity(this._intensity);

    /* Move the group to storm position (Y stays 0 — ground) */
    this._group.position.set(pos.x, 0, pos.z);

    /* ── 1. Funnel rotation ── */
    var rotRate = HE.MathUtils.lerp(_TORN.ROT_MIN, _TORN.ROT_MAX, this._intensity);
    this._rotY -= rotRate * dt;  // negative = CCW from above
    this._funnelGroup.rotation.y = this._rotY;

    /* ── 2. Rebuild ring radii ── */
    this._updateRings();

    /* ── 3. Opacity / colour transitions ── */
    this._updateMaterials();

    /* ── 4. Skirt wobble ── */
    this._updateSkirt();

    /* ── 5. Shadow scale ── */
    this._updateShadow();

    /* ── 6. Debris spiral ── */
    if (this._visible) {
      this._updateDebris(pos);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     _updateRings()
     Resize each ring's torus radius to match current funnel shape.
     We rebuild geometry in-place — dispose old geo and create new one.
     This is cheap because RING_COUNT is small (4-10).
  ───────────────────────────────────────────────────────────────────── */
  _updateRings() {
    var count = _TORN.LOD_RING_COUNTS[this._lodLevel];

    for (var i = 0; i < _TORN.RING_COUNT; i++) {
      var ring = this._rings[i];
      if (!ring) continue;

      /* Hide rings beyond current LOD count */
      if (i >= count) {
        ring.visible = false;
        continue;
      }
      ring.visible = true;

      var normH  = i / (_TORN.RING_COUNT - 1);
      var radius = this._vortex.funnelRadius(normH);

      /* Only rebuild if radius changed significantly (avoids GC thrash) */
      var currentR = ring.geometry.parameters
        ? ring.geometry.parameters.radius
        : -1;

      if (Math.abs(currentR - radius) > 0.25) {
        ring.geometry.dispose();
        ring.geometry = new THREE.TorusGeometry(
          radius,
          _TORN.RING_TUBE_R,
          6,
          _TORN.RING_SEGS
        );
      }

      /* Slight per-ring oscillation for organic turbulence */
      var wobble = 1 + 0.06 * Math.sin(this._time * 2.3 + i * 0.9);
      ring.scale.set(wobble, 1, wobble);
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     _updateMaterials()
     Lerp funnel colour and opacity based on intensity.
     Rings near the ground are always slightly darker.
  ───────────────────────────────────────────────────────────────────── */
  _updateMaterials() {
    /* Target colour: lerp between forming-white and active-dark based on intensity */
    var targetHex = this._lerpColor(
      _TORN.COL_FORMING, _TORN.COL_ACTIVE, this._intensity
    );
    var targetOpacity = HE.MathUtils.lerp(
      _TORN.OPACITY_FORMING, _TORN.OPACITY_ACTIVE, this._intensity
    );

    var col = new THREE.Color(targetHex);

    for (var i = 0; i < this._ringMats.length; i++) {
      var mat   = this._ringMats[i];
      var normH = i / (this._ringMats.length - 1);

      /* Ground rings are always ~20% more opaque */
      mat.opacity = targetOpacity * (0.65 + 0.35 * (1 - normH));
      mat.color.set(col);
      mat.needsUpdate = true;
    }

    /* Skirt opacity */
    if (this._skirtMat) {
      this._skirtMat.opacity = HE.MathUtils.lerp(0.10, 0.30, this._intensity);
      this._skirtMat.color.set(col);
      this._skirtMat.needsUpdate = true;
    }

    /* Debris opacity */
    if (this._debrisMat) {
      this._debrisMat.opacity = HE.MathUtils.lerp(0.3, 0.88, this._intensity);
      this._debrisMat.needsUpdate = true;
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     _updateSkirt()
     Wobbly ground-contact cone — scale XZ oscillates on two frequencies.
  ───────────────────────────────────────────────────────────────────── */
  _updateSkirt() {
    var t  = this._time;
    var f  = _TORN.SKIRT_WOBBLE_F;
    var a  = _TORN.SKIRT_WOBBLE_A * this._intensity;

    var sx = 1 + a * Math.sin(t * f * Math.PI * 2);
    var sz = 1 + a * Math.sin(t * f * Math.PI * 2 + 1.3);

    this._skirt.scale.set(sx, 1, sz);

    /* Base radius of skirt grows with intensity */
    var baseR = HE.MathUtils.lerp(3.5, 12.0, this._intensity);
    this._skirt.scale.x = sx * (baseR / 7.5);
    this._skirt.scale.z = sz * (baseR / 7.5);
  }

  /* ─────────────────────────────────────────────────────────────────────
     _updateShadow()
     Ellipse ground decal scales with intensity.
  ───────────────────────────────────────────────────────────────────── */
  _updateShadow() {
    var r = HE.MathUtils.lerp(5, _TORN.SHADOW_MAX_R, this._intensity);
    this._shadow.scale.set(r, r, r);
    this._shadow.material.opacity = _TORN.SHADOW_OPACITY * this._intensity;
  }

  /* ─────────────────────────────────────────────────────────────────────
     _updateDebris(tornadoPos)
     Drive each particle position via VortexMath.spiralPos().
     Writes directly into the BufferAttribute arrays (no new allocations).
  ───────────────────────────────────────────────────────────────────── */
  _updateDebris(tornadoPos) {
    var budget = Math.min(this._debrisBudget, _TORN.DEBRIS_COUNT);
    var pos    = this._debrisPositions;

    for (var i = 0; i < budget; i++) {
      var sp = this._vortex.spiralPos(i, budget, _TORN.DEBRIS_HEIGHT, this._time);

      pos[i * 3    ] = tornadoPos.x + sp.x;
      pos[i * 3 + 1] = sp.y;
      pos[i * 3 + 2] = tornadoPos.z + sp.z;
    }

    /* Zero-out unused particles (past budget) by pushing them underground */
    for (var j = budget; j < _TORN.DEBRIS_COUNT; j++) {
      pos[j * 3 + 1] = -999;
    }

    this._debrisGeo.attributes.position.needsUpdate = true;

    /* Keep debris mesh centred near storm for frustum culling */
    this._debrisMesh.position.set(0, 0, 0);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     setVisible(bool)
     Called by main.js when storm state changes.
     Funnel group + debris points both toggle.
  ═══════════════════════════════════════════════════════════════════════ */

  setVisible(bool) {
    this._visible = bool;
    this._group.visible = bool;
    this._debrisMesh.visible = bool;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     PERFORMANCE ADJUST
     Called when PerformanceOptimizer emits PERFORMANCE_ADJUST.
  ═══════════════════════════════════════════════════════════════════════ */

  _onPerfAdjust(data) {
    if (typeof data.particleBudget === 'number') {
      this._debrisBudget = HE.MathUtils.clamp(
        data.particleBudget, 40, _TORN.DEBRIS_COUNT
      );
    }
    if (typeof data.lodLevel === 'number') {
      this._lodLevel = HE.MathUtils.clamp(data.lodLevel, 0, 2);
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════════════════════════════════════ */

  /* Linear interpolate between two hex colour values */
  _lerpColor(hexA, hexB, t) {
    var ca = new THREE.Color(hexA);
    var cb = new THREE.Color(hexB);
    ca.lerp(cb, t);
    return ca.getHex();
  }


  /* ═══════════════════════════════════════════════════════════════════════
     READ-ONLY GETTERS  (match SKILL.md contract)
  ═══════════════════════════════════════════════════════════════════════ */

  /** THREE.Group containing funnel rings + skirt + shadow */
  get mesh()       { return this._group; }

  /** THREE.Points — debris particle cloud */
  get debrisPts()  { return this._debrisMesh; }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP
  ═══════════════════════════════════════════════════════════════════════ */

  dispose() {
    /* Dispose ring geometries */
    for (var i = 0; i < this._rings.length; i++) {
      this._rings[i].geometry.dispose();
    }
    for (var i = 0; i < this._ringMats.length; i++) {
      this._ringMats[i].dispose();
    }

    /* Dispose skirt */
    if (this._skirt) {
      this._skirt.geometry.dispose();
      this._skirtMat.dispose();
    }

    /* Dispose shadow */
    if (this._shadow) {
      this._shadow.geometry.dispose();
      this._shadow.material.dispose();
    }

    /* Dispose debris */
    if (this._debrisGeo)  this._debrisGeo.dispose();
    if (this._debrisMat)  this._debrisMat.dispose();

    /* Remove from scene */
    this._scene.remove(this._group);
    this._scene.remove(this._debrisMesh);

    /* Unsubscribe */
    if (this._bus) {
      this._bus.off('PERFORMANCE_ADJUST', this._onPerfAdjust.bind(this));
    }

    console.log('[Tornado] Disposed.');
  }

};
