/* ═══════════════════════════════════════════════════════════════════════════
   terrain.js  —  HEXADO CHASING v2.0
   Layer   : Rendering (load order: 9th — after Characters.js, before environment.js)
   Exports : window.HexEngine.TerrainGen
   Deps    : Three.js r128  ·  HE.Noise (main-math.js)  ·  HE.MathUtils (main-math.js)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   TerrainGen owns the Oklahoma plains world geometry and the canonical height
   function. Every module that needs to know "what is the ground Y at (x, z)?"
   calls HE.TerrainGen.heightAt(x, z) — never computes its own height.

     ┌──────────────────────────────────────────────────────────────────────┐
     │  heightAt(wx, wz)  — SINGLE SOURCE OF TRUTH for ground Y            │
     │    Multi-octave fBm noise → gentle plains undulation                │
     │    Road corridor blend  → smoothstep flat strip along X ≈ 0        │
     │                                                                      │
     │  generate(scene)   — called ONCE by Render.js during boot           │
     │    PlaneGeometry  600 × 600 wu  ·  120 × 120 segments               │
     │    Vertex Y displaced via heightAt()                                 │
     │    Vertex colours: green plains  ·  grey road  ·  brown dirt       │
     └──────────────────────────────────────────────────────────────────────┘

   Terrain shape overview
   ──────────────────────
   The terrain is a rolling Oklahoma prairie. Height variation is gentle —
   max crest ~4.5 wu above the road baseline, shallow troughs at ~0 wu.
   A road corridor runs along X = 0 the full Z length of the patch. Inside
   the corridor the surface is flattened to ROAD_H = 0.68 (slightly raised
   above absolute zero to prevent Z-fighting with road markings placed by
   environment.js).

   Noise configuration (tuned for feel)
   ─────────────────────────────────────
   Layer 1 (macro shape):   fbm2, 4 octaves, freq 0.0025, amp 4.2
     → Long rolling hills visible on the horizon
   Layer 2 (micro detail):  fbm2, 2 octaves, freq 0.018,  amp 0.55
     → Close-range ground texture, subtle bumps under the wheels

   Road blend
   ──────────
   The road corridor is defined by |wx| < ROAD_HALF_W (9.5 wu).
   A smoothstep with 8 wu overlap on each side merges the noisy field
   height into a flat ROAD_H strip. This produces a gentle shoulder on
   both sides rather than a hard cliff edge.

   Vertex colours
   ──────────────
   Three paint zones, blended on the CPU so no shader needed:
     Road  (|x| < 6)       → warm grey  #878070
     Dirt shoulder (6-14)  → sandy tan  #c8a86c
     Plains (|x| > 14)     → dry grass  #7a9045
   Each zone has a small per-vertex noise offset so the colour field
   looks organic rather than banded.

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export
   • Three.js r128: no CapsuleGeometry, no r129+ APIs
   • heightAt() is pure (no side effects, no Three.js) — called from
     physics.js, Characters.js, environment.js, and inside generate()
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS  —  all geometry numbers live here, never buried in logic
   ═══════════════════════════════════════════════════════════════════════════ */

var _TRN = {

  /* ─── Terrain patch dimensions ───────────────────────────────────────── */
  PATCH_W:       600,   // world units — east-west (X axis)
  PATCH_D:       600,   // world units — north-south (Z axis)
  SEGS_W:        120,   // vertex columns — 5 wu between verts
  SEGS_D:        120,   // vertex rows

  /* ─── Road parameters ────────────────────────────────────────────────── */
  // Matches SKILL.md contract: ROAD_H = 0.68, ROAD_HALF_W = 9.5
  ROAD_H:        0.68,  // flat Y of the paved road surface
  ROAD_HALF_W:   9.5,   // half-width of the smoothstep blend zone
  ROAD_BLEND:    8.0,   // lateral blend overlap on each side of ROAD_HALF_W

  /* ─── Height noise — Layer 1: macro plains undulation ────────────────── */
  MACRO_FREQ:    0.0025,
  MACRO_AMP:     4.2,
  MACRO_OCTAVES: 4,

  /* ─── Height noise — Layer 2: micro surface detail ───────────────────── */
  MICRO_FREQ:    0.018,
  MICRO_AMP:     0.55,
  MICRO_OCTAVES: 2,

  /* ─── Vertex colour zones (world-space |x| thresholds) ──────────────── */
  ROAD_COL_W:    6.0,   // |x| < this  → road grey
  DIRT_COL_W:   14.0,   // |x| < this  → dirt tan shoulder

  /* ─── Vertex colours (linear RGB, 0..1) ──────────────────────────────── */
  COL_ROAD:   { r: 0.530, g: 0.502, b: 0.439 },   // warm grey asphalt
  COL_DIRT:   { r: 0.784, g: 0.659, b: 0.424 },   // sandy tan shoulder
  COL_GRASS:  { r: 0.478, g: 0.565, b: 0.271 },   // dry Oklahoma grass
  COL_GRASS2: { r: 0.420, g: 0.510, b: 0.220 },   // slightly darker variant

  /* ─── Geometry placement ─────────────────────────────────────────────── */
  TERRAIN_Y:     0.0,   // base world Y — terrain sits at ground origin
  RECEIVE_SHADOW: true  // receives shadows from vehicles + tornado

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.TerrainGen
   ──────────────
   Static-only class. Never instantiated — call methods directly:
     HE.TerrainGen.heightAt(x, z)
     HE.TerrainGen.generate(scene)
   ═══════════════════════════════════════════════════════════════════════════ */

HE.TerrainGen = class {

  /* ───────────────────────────────────────────────────────────────────────
     Static read-only constants — exposed so physics.js and Characters.js
     can reference them without hard-coding magic numbers.
  ─────────────────────────────────────────────────────────────────────── */

  /** Y height of the paved road surface (world units) */
  static get ROAD_H()      { return _TRN.ROAD_H; }

  /** Half-width of the road blend corridor (world units) */
  static get ROAD_HALF_W() { return _TRN.ROAD_HALF_W; }


  /* ═══════════════════════════════════════════════════════════════════════
     heightAt(wx, wz)
     ──────────────────
     THE SINGLE SOURCE OF TRUTH for ground Y at any world position (wx, wz).

     Called by:
       • physics.js     — terrain-snap step (sets vehicle Y each frame)
       • Characters.js  — walker feet placement on-foot mode
       • environment.js — ALL prop Y placement (poles, barns, trees, etc.)
       • generate()     — vertex displacement loop (see below)

     Algorithm:
       1. Sample macro fBm noise   → rolling plains shape
       2. Sample micro fBm noise   → close-range surface bumps
       3. Combine with ROAD_H baseline
       4. Smooth-blend result toward flat ROAD_H inside road corridor

     wx : world X coordinate
     wz : world Z coordinate
     Returns : Number — ground Y at that world position
  ═══════════════════════════════════════════════════════════════════════ */

  static heightAt(wx, wz) {

    /* ── Layer 1: macro rolling plains ── */
    var macro = HE.Noise.fbm2(
      wx * _TRN.MACRO_FREQ,
      wz * _TRN.MACRO_FREQ,
      _TRN.MACRO_OCTAVES,
      1.0,
      1.0
    ) * _TRN.MACRO_AMP;

    /* ── Layer 2: micro surface detail ── */
    /* Offset noise coords so the two layers don't spatially align */
    var micro = HE.Noise.fbm2(
      wx * _TRN.MICRO_FREQ + 7.3,
      wz * _TRN.MICRO_FREQ + 3.1,
      _TRN.MICRO_OCTAVES,
      1.0,
      1.0
    ) * _TRN.MICRO_AMP;

    /* ── Raw field height ──
       Noise returns values ~ -1..+1, so the field sits centred on ROAD_H.
       This keeps the road plausibly at-grade rather than in a canyon.    */
    var fieldY = _TRN.ROAD_H + macro + micro;

    /* ── Road corridor blend ──
       smoothstep: 0 at inner edge (pure road), 1 at outer edge (pure field).
       Blend range = [ROAD_HALF_W - ROAD_BLEND, ROAD_HALF_W]
                   = [1.5, 9.5]
       So: |x| < 1.5  → perfectly flat road surface
           1.5-9.5    → gentle shoulder blending road → field
           |x| > 9.5  → fully field height (noisy)              */
    var absX  = Math.abs(wx);
    var inner = _TRN.ROAD_HALF_W - _TRN.ROAD_BLEND;   // 1.5 wu
    var outer = _TRN.ROAD_HALF_W;                      // 9.5 wu
    var blend = HE.MathUtils.smoothstep(inner, outer, absX);

    return HE.MathUtils.lerp(_TRN.ROAD_H, fieldY, blend);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     generate(scene)
     ────────────────
     Builds the terrain PlaneGeometry, displaces all vertices via heightAt(),
     paints vertex colours, and adds the Mesh to the scene.
     Called ONCE by Render.js during its async init() sequence.

     scene  : THREE.Scene — the terrain Mesh is added directly
     Returns: THREE.Mesh  — for callers that need a ref (e.g., dispose())
  ═══════════════════════════════════════════════════════════════════════ */

  static generate(scene) {

    console.log('[TerrainGen] Building '
      + _TRN.PATCH_W + ' x ' + _TRN.PATCH_D + ' wu terrain, '
      + _TRN.SEGS_W  + ' x ' + _TRN.SEGS_D  + ' segments…');

    var t0 = performance.now();

    /* ── Create PlaneGeometry ──
       Three.js PlaneGeometry lies in the XY plane by default.
       We rotate it -90° around X (baked into geometry) so vertices
       lie in the world XZ plane — standard ground orientation.       */
    var geo = new THREE.PlaneGeometry(
      _TRN.PATCH_W,
      _TRN.PATCH_D,
      _TRN.SEGS_W,
      _TRN.SEGS_D
    );

    geo.rotateX(-Math.PI / 2);

    /* ── Access position buffer ── */
    var posAttr   = geo.attributes.position;
    var vertCount = posAttr.count;

    /* ── Pre-allocate colour buffer ── */
    var colArr = new Float32Array(vertCount * 3);

    /* ── Colour noise frequency — decorrelate from height noise ── */
    var cnFreq  = 0.045;
    var cnFreq2 = cnFreq * 1.7;

    /* ════════════════════════════════════════════════
       MAIN VERTEX LOOP — height + colour
    ════════════════════════════════════════════════ */
    for (var i = 0; i < vertCount; i++) {

      var wx = posAttr.getX(i);
      var wz = posAttr.getZ(i);

      /* ── Displace Y to terrain height ── */
      var wy = HE.TerrainGen.heightAt(wx, wz);
      posAttr.setY(i, wy);

      /* ── Vertex colour ── */
      var absX = Math.abs(wx);

      /* Per-vertex colour variation noise — makes zone boundaries organic */
      var cn  = HE.Noise.value2(wx * cnFreq,         wz * cnFreq);
      var cn2 = HE.Noise.value2(wx * cnFreq2 + 4.4,  wz * cnFreq2 + 2.1);

      var r, g, b;

      if (absX < _TRN.ROAD_COL_W) {

        /* ── Zone 1: Road surface — warm grey asphalt ── */
        var jR = (cn  - 0.5) * 0.06;
        var jG = (cn2 - 0.5) * 0.05;

        r = _TRN.COL_ROAD.r + jR;
        g = _TRN.COL_ROAD.g + jG;
        b = _TRN.COL_ROAD.b + jR * 0.5;

        /* Slight centreline darkening: fresh paint fade + oil stain feel */
        var cDark = HE.MathUtils.smoothstep(1.5, 4.0, absX) * 0.07;
        r -= cDark * 0.6;
        g -= cDark * 0.6;
        b -= cDark * 0.4;

      } else if (absX < _TRN.DIRT_COL_W) {

        /* ── Zone 2: Dirt shoulder — blend road grey → sandy tan ── */
        var t = HE.MathUtils.smoothstep(_TRN.ROAD_COL_W, _TRN.DIRT_COL_W, absX);
        var jR = (cn  - 0.5) * 0.09;
        var jG = (cn2 - 0.5) * 0.07;

        r = HE.MathUtils.lerp(_TRN.COL_ROAD.r, _TRN.COL_DIRT.r, t) + jR;
        g = HE.MathUtils.lerp(_TRN.COL_ROAD.g, _TRN.COL_DIRT.g, t) + jG;
        b = HE.MathUtils.lerp(_TRN.COL_ROAD.b, _TRN.COL_DIRT.b, t);

      } else {

        /* ── Zone 3: Grass plains — blend two grass shades via noise ── */
        var gBlend = HE.MathUtils.smoothstep(0.25, 0.75, cn);
        var jR = (cn  - 0.5) * 0.08;
        var jG = (cn2 - 0.5) * 0.07;

        r = HE.MathUtils.lerp(_TRN.COL_GRASS.r, _TRN.COL_GRASS2.r, gBlend) + jR;
        g = HE.MathUtils.lerp(_TRN.COL_GRASS.g, _TRN.COL_GRASS2.g, gBlend) + jG;
        b = HE.MathUtils.lerp(_TRN.COL_GRASS.b, _TRN.COL_GRASS2.b, gBlend);

        /* Height-based shading: valley floors slightly darker, crests lighter */
        var hShade = HE.MathUtils.remap(wy, -0.5, 4.5, -0.05, 0.07);
        r = r + hShade * 0.45;
        g = g + hShade;
        b = b + hShade * 0.25;
      }

      /* Clamp to valid [0, 1] before writing */
      colArr[i * 3    ] = HE.MathUtils.clamp(r, 0, 1);
      colArr[i * 3 + 1] = HE.MathUtils.clamp(g, 0, 1);
      colArr[i * 3 + 2] = HE.MathUtils.clamp(b, 0, 1);
    }

    /* ── Attach colour attribute ── */
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

    /* ── Recompute normals — critical after vertex Y displacement ──
       Without this, lighting on hilly terrain is completely wrong.   */
    geo.computeVertexNormals();

    /* ── Material: Lambert + vertex colours. No texture files. ── */
    var mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side:         THREE.FrontSide
    });

    /* ── Assemble Mesh ── */
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name          = 'terrain';
    mesh.receiveShadow = _TRN.RECEIVE_SHADOW;
    mesh.castShadow    = false;   // flat terrain shadow-casting: expensive & unneeded
    mesh.position.set(0, _TRN.TERRAIN_Y, 0);

    scene.add(mesh);

    var ms = (performance.now() - t0).toFixed(1);
    console.log('[TerrainGen] Done — '
      + vertCount + ' verts  |  build time: ' + ms + ' ms');

    return mesh;
  }

};
