/* ═══════════════════════════════════════════════════════════════════════════
   environment.js  —  HEXADO CHASING v2.0
   Layer   : Rendering (load order: 10th — after terrain.js, before Render.js)
   Exports : window.HexEngine.EnvironmentGen
   Deps    : Three.js r128  ·  HE.TerrainGen (terrain.js)  ·  HE.MathUtils
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Procedurally places all static world props across the Oklahoma plains.
   Called ONCE by Render.js during init. Has NO update() method — all
   animation (cloud drift, etc.) is handled by Render.js after build().

   Props built (all Three.js geometry, zero external files):
   ──────────────────────────────────────────────────────────
     Road markings   — dashed centre line + solid edge lines
     Power poles     — CylinderGeometry poles + crossarms + LineSegments wires
     Farm buildings  — BoxGeometry barns + CylinderGeometry silos
     Trees           — ConeGeometry canopy + CylinderGeometry trunk, field clusters
     Hay bales       — CylinderGeometry lying flat, scattered in fields
     Fences          — thin BoxGeometry posts + rails along field edges
     Water tower     — CylinderGeometry legs + SphereGeometry tank + CylinderGeometry body
     Clouds          — merged SphereGeometry clusters at high Y (returned separately)

   Return contract (matches Render.js expectations exactly):
   ──────────────────────────────────────────────────────────
     { props, clouds }
       props  : THREE.Group  — all static objects, already added to scene
       clouds : THREE.Mesh[] — cloud meshes (Render.js drifts them per-frame)

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export
   • All prop Y = HE.TerrainGen.heightAt(x, z) — NEVER hardcoded
   • Three.js r128: no CapsuleGeometry — use Cylinder + Sphere combinations
   • environment.js is init-only — no per-frame state, no EventBus wiring
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════════════════ */

var _ENV = {

  /* ─── Road markings ──────────────────────────────────────────────────── */
  DASH_LENGTH:    6.0,    // world units — length of each centre-line dash
  DASH_GAP:       5.0,    // gap between dashes
  DASH_WIDTH:     0.18,   // dash stripe width
  DASH_THICK:     0.04,   // height above road surface (prevent Z-fight)
  EDGE_LINE_X:    4.8,    // |x| position of solid edge lines
  EDGE_LINE_W:    0.14,
  ROAD_Z_MIN:    -250,    // road markings Z extent
  ROAD_Z_MAX:     250,

  /* ─── Power poles ────────────────────────────────────────────────────── */
  POLE_SPACING:   28,     // world units between poles along Z
  POLE_SIDE_X:    14.5,   // |x| offset from centreline (just off shoulder)
  POLE_HEIGHT:    9.5,
  POLE_RADIUS:    0.16,
  POLE_CROSSARM:  3.8,    // half-length of crossarm
  POLE_INSULATOR: 0.22,   // tiny cylinder at each wire attachment point
  WIRE_SAG:       0.55,   // wire sag at midpoint (LineSegments, 6 segments)
  POLE_Z_MIN:    -220,
  POLE_Z_MAX:     220,

  /* ─── Farm buildings ─────────────────────────────────────────────────── */
  // Barns placed in pairs (left + right side of road), spaced irregularly
  BARN_POSITIONS: [
    { z: -90,  side:  1, scaleX: 1.0, scaleZ: 1.2 },
    { z: -90,  side: -1, scaleX: 0.8, scaleZ: 1.0 },
    { z:  60,  side:  1, scaleX: 1.1, scaleZ: 0.9 },
    { z: 160,  side: -1, scaleX: 0.9, scaleZ: 1.1 },
    { z: -180, side:  1, scaleX: 1.0, scaleZ: 1.0 }
  ],
  BARN_OFFSET_X:  28,     // world units from road centre
  BARN_W:         9,
  BARN_D:         14,
  BARN_WALL_H:    4.5,
  BARN_ROOF_H:    3.0,
  SILO_R:         2.2,
  SILO_H:         10,
  SILO_OFFSET:    6.5,    // X offset from barn centre

  /* ─── Trees ──────────────────────────────────────────────────────────── */
  TREE_CLUSTERS: [
    { cx:  35, cz: -70,  count: 9,  spread: 18 },
    { cx: -42, cz:  30,  count: 7,  spread: 14 },
    { cx:  55, cz:  110, count: 11, spread: 22 },
    { cx: -60, cz: -130, count: 8,  spread: 16 },
    { cx:  80, cz:  -30, count: 6,  spread: 12 },
    { cx: -75, cz:  180, count: 10, spread: 20 },
    { cx:  20, cz:  200, count: 5,  spread: 10 }
  ],
  TREE_TRUNK_R:   0.22,
  TREE_TRUNK_H_MIN: 1.8,
  TREE_TRUNK_H_MAX: 3.2,
  TREE_CANOPY_R_MIN: 1.8,
  TREE_CANOPY_R_MAX: 3.4,
  TREE_CANOPY_H_MIN: 4.0,
  TREE_CANOPY_H_MAX: 7.5,

  /* ─── Hay bales ──────────────────────────────────────────────────────── */
  BALE_POSITIONS: [
    { x:  22, z:  -55 }, { x:  26, z:  -58 }, { x:  23, z:  -52 },
    { x: -24, z:   80 }, { x: -28, z:   77 },
    { x:  40, z:  130 }, { x:  43, z:  127 }, { x:  39, z:  133 },
    { x: -35, z: -140 }, { x: -38, z: -143 },
    { x:  18, z:  -10 }, { x:  62, z:   50 }
  ],
  BALE_R:    1.3,   // cylinder radius (it's a round bale)
  BALE_H:    1.5,   // cylinder height (bale width)

  /* ─── Fences ─────────────────────────────────────────────────────────── */
  // Simple fence rows along field edges near barn clusters
  FENCE_RUNS: [
    { x:  16, zStart: -100, zEnd: -70,  side:  1 },
    { x: -16, zStart: -100, zEnd: -70,  side: -1 },
    { x:  16, zStart:   50, zEnd:  80,  side:  1 },
    { x: -16, zStart:  145, zEnd: 175,  side: -1 }
  ],
  FENCE_POST_SPACING: 5.0,
  FENCE_POST_W:  0.18,
  FENCE_POST_H:  1.4,
  FENCE_RAIL_H:  0.08,
  FENCE_RAIL_W:  0.06,
  FENCE_RAIL_OFFSETS: [0.45, 1.05],  // Y offsets for two horizontal rails

  /* ─── Water tower ────────────────────────────────────────────────────── */
  TOWER_X:        -52,
  TOWER_Z:         95,
  TOWER_LEG_COUNT: 6,
  TOWER_LEG_R:     0.18,
  TOWER_LEG_H:     8.0,
  TOWER_LEG_SPREAD: 3.2,
  TOWER_BODY_R:    3.6,
  TOWER_BODY_H:    4.8,
  TOWER_DOME_R:    3.8,   // sphere cap on top

  /* ─── Clouds ─────────────────────────────────────────────────────────── */
  CLOUD_COUNT:     14,
  CLOUD_Y_MIN:     72,
  CLOUD_Y_MAX:     95,
  CLOUD_X_RANGE:  200,
  CLOUD_Z_RANGE:  220,
  CLOUD_PUFF_MIN:  3,     // puffs per cloud
  CLOUD_PUFF_MAX:  7,
  CLOUD_PUFF_R_MIN: 6,
  CLOUD_PUFF_R_MAX: 14
};


/* ═══════════════════════════════════════════════════════════════════════════
   SHARED MATERIALS
   Pre-built once, reused across all geometry that shares the same look.
   This keeps draw call count and GC pressure low.
   ═══════════════════════════════════════════════════════════════════════════ */

var _MAT;   // initialised lazily inside build() so THREE is guaranteed ready

function _initMaterials() {
  if (_MAT) return;   // already built

  _MAT = {
    /* Road markings */
    dashWhite:  new THREE.MeshBasicMaterial({ color: 0xeeeedd }),
    edgeLine:   new THREE.MeshBasicMaterial({ color: 0xddddcc }),

    /* Power poles — creosote-stained timber brown */
    pole:       new THREE.MeshLambertMaterial({ color: 0x5a4030 }),
    wire:       new THREE.LineBasicMaterial({ color: 0x222222, linewidth: 1 }),
    insulator:  new THREE.MeshLambertMaterial({ color: 0x3a5a88 }),   // glass insulator

    /* Barns — weathered red + grey roof */
    barnWall:   new THREE.MeshLambertMaterial({ color: 0x8b2a1a }),   // faded red
    barnRoof:   new THREE.MeshLambertMaterial({ color: 0x5a5040 }),   // grey weathered tin
    silo:       new THREE.MeshLambertMaterial({ color: 0xc0b090 }),   // concrete tan

    /* Trees — two green shades for variety */
    trunkMat:   new THREE.MeshLambertMaterial({ color: 0x4a3218 }),
    canopyA:    new THREE.MeshLambertMaterial({ color: 0x3a6020 }),
    canopyB:    new THREE.MeshLambertMaterial({ color: 0x2e5018 }),

    /* Hay bales — golden straw */
    bale:       new THREE.MeshLambertMaterial({ color: 0xd4a83a }),

    /* Fences — pale weathered timber */
    fence:      new THREE.MeshLambertMaterial({ color: 0xc8b890 }),

    /* Water tower — dark steel */
    towerSteel: new THREE.MeshLambertMaterial({ color: 0x607878 }),   // oxidised steel
    towerTank:  new THREE.MeshLambertMaterial({ color: 0x506868 }),

    /* Clouds — bright white */
    cloud:      new THREE.MeshLambertMaterial({
                  color:       0xfafafa,
                  transparent: true,
                  opacity:     0.92
                })
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   HE.EnvironmentGen
   ──────────────────
   Static-only class. Call HE.EnvironmentGen.build(scene).
   ═══════════════════════════════════════════════════════════════════════════ */

HE.EnvironmentGen = class {

  /* ═══════════════════════════════════════════════════════════════════════
     build(scene)
     ─────────────
     Entry point — called once by Render.js.
     Returns { props, clouds } as per the module contract.
  ═══════════════════════════════════════════════════════════════════════ */
  static build(scene) {
    _initMaterials();

    var t0 = performance.now();

    /* All static props go in one Group for easy scene management */
    var props = new THREE.Group();
    props.name = 'environment';

    /* Clouds are returned separately so Render.js can animate them */
    var clouds = [];

    /* ── Build each prop category ── */
    HE.EnvironmentGen._buildRoadMarkings(props);
    HE.EnvironmentGen._buildPowerPoles(props);
    HE.EnvironmentGen._buildFarms(props);
    HE.EnvironmentGen._buildTrees(props);
    HE.EnvironmentGen._buildHayBales(props);
    HE.EnvironmentGen._buildFences(props);
    HE.EnvironmentGen._buildWaterTower(props);
    HE.EnvironmentGen._buildClouds(scene, clouds);   // clouds added directly to scene

    scene.add(props);

    var ms = (performance.now() - t0).toFixed(1);
    console.log('[EnvironmentGen] Built — ' + clouds.length + ' clouds  |  '
      + ms + ' ms');

    return { props: props, clouds: clouds };
  }


  /* ═══════════════════════════════════════════════════════════════════════
     ROAD MARKINGS
     Dashed white centre line + solid edge lines along the road corridor.
     All placed at road surface Y + DASH_THICK so they sit on top cleanly.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildRoadMarkings(group) {
    var dashGeo = new THREE.BoxGeometry(
      _ENV.DASH_WIDTH,
      _ENV.DASH_THICK,
      _ENV.DASH_LENGTH
    );

    var z = _ENV.ROAD_Z_MIN;
    var stride = _ENV.DASH_LENGTH + _ENV.DASH_GAP;

    while (z < _ENV.ROAD_Z_MAX) {
      var dash = new THREE.Mesh(dashGeo, _MAT.dashWhite);
      var gy   = HE.TerrainGen.heightAt(0, z + _ENV.DASH_LENGTH * 0.5);
      dash.position.set(0, gy + _ENV.DASH_THICK, z + _ENV.DASH_LENGTH * 0.5);
      group.add(dash);
      z += stride;
    }

    /* Solid edge lines — one long box per side */
    var edgeLen = _ENV.ROAD_Z_MAX - _ENV.ROAD_Z_MIN;
    var edgeGeo = new THREE.BoxGeometry(_ENV.EDGE_LINE_W, _ENV.DASH_THICK, edgeLen);

    for (var side = -1; side <= 1; side += 2) {
      var ex   = side * _ENV.EDGE_LINE_X;
      var midZ = (_ENV.ROAD_Z_MIN + _ENV.ROAD_Z_MAX) * 0.5;
      var ey   = HE.TerrainGen.heightAt(ex, midZ);
      var edge = new THREE.Mesh(edgeGeo, _MAT.edgeLine);
      edge.position.set(ex, ey + _ENV.DASH_THICK, midZ);
      group.add(edge);
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     POWER POLES
     Timber poles with crossarms and sagging wires both sides of the road.
     Placed every POLE_SPACING wu from POLE_Z_MIN to POLE_Z_MAX.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildPowerPoles(group) {
    var poleGeo    = new THREE.CylinderGeometry(
      _ENV.POLE_RADIUS * 0.7,   // top radius (slight taper)
      _ENV.POLE_RADIUS,          // base radius
      _ENV.POLE_HEIGHT,
      6                          // hexagonal cross-section — cheap + fitting the game name
    );
    var crossGeo   = new THREE.CylinderGeometry(0.10, 0.10, _ENV.POLE_CROSSARM * 2, 5);
    var insulGeo   = new THREE.CylinderGeometry(0.10, 0.10, 0.28, 5);

    for (var z = _ENV.POLE_Z_MIN; z <= _ENV.POLE_Z_MAX; z += _ENV.POLE_SPACING) {

      for (var side = -1; side <= 1; side += 2) {
        var px = side * _ENV.POLE_SIDE_X;
        var gy = HE.TerrainGen.heightAt(px, z);

        /* ── Pole shaft ── */
        var pole = new THREE.Mesh(poleGeo, _MAT.pole);
        pole.position.set(px, gy + _ENV.POLE_HEIGHT * 0.5, z);
        pole.castShadow = true;
        group.add(pole);

        /* ── Crossarm (horizontal, perpendicular to road = X axis) ── */
        var cross = new THREE.Mesh(crossGeo, _MAT.pole);
        cross.rotation.z = Math.PI / 2;   // lay it horizontal along X
        cross.position.set(px, gy + _ENV.POLE_HEIGHT - 0.6, z);
        group.add(cross);

        /* ── Insulators at crossarm tips ── */
        for (var tip = -1; tip <= 1; tip += 2) {
          var ins = new THREE.Mesh(insulGeo, _MAT.insulator);
          ins.position.set(
            px + tip * _ENV.POLE_CROSSARM,
            gy + _ENV.POLE_HEIGHT - 0.6,
            z
          );
          group.add(ins);
        }
      }
    }

    /* ── Wires ── (LineSegments connecting insulators between poles) */
    HE.EnvironmentGen._buildWires(group);
  }

  static _buildWires(group) {
    /* For each span between adjacent poles, draw a sagging wire
       using LineSegments with WIRE_SEGS intermediate points.      */
    var WIRE_SEGS = 6;

    for (var z = _ENV.POLE_Z_MIN; z < _ENV.POLE_Z_MAX; z += _ENV.POLE_SPACING) {
      var zNext = z + _ENV.POLE_SPACING;

      for (var side = -1; side <= 1; side += 2) {
        var px   = side * _ENV.POLE_SIDE_X;

        for (var tip = -1; tip <= 1; tip += 2) {
          var wx = px + tip * _ENV.POLE_CROSSARM;

          /* Start and end Y (may differ if terrain slopes between poles) */
          var y0 = HE.TerrainGen.heightAt(px, z)     + _ENV.POLE_HEIGHT - 0.6;
          var y1 = HE.TerrainGen.heightAt(px, zNext) + _ENV.POLE_HEIGHT - 0.6;

          var points = [];
          for (var s = 0; s <= WIRE_SEGS; s++) {
            var t   = s / WIRE_SEGS;
            var wz  = z + t * _ENV.POLE_SPACING;
            var wy  = HE.MathUtils.lerp(y0, y1, t);
            /* Catenary sag: parabolic approximation */
            var sag = _ENV.WIRE_SAG * Math.sin(t * Math.PI);
            points.push(new THREE.Vector3(wx, wy - sag, wz));
          }

          var geo = new THREE.BufferGeometry().setFromPoints(points);
          var line = new THREE.Line(geo, _MAT.wire);
          group.add(line);
        }
      }
    }
  }


  /* ═══════════════════════════════════════════════════════════════════════
     FARM BUILDINGS
     Barn (box body + pitched roof) + silo (cylinder) pairs.
     Placed at positions defined in _ENV.BARN_POSITIONS.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildFarms(group) {

    _ENV.BARN_POSITIONS.forEach(function(bp) {
      var bx = bp.side * (_ENV.BARN_OFFSET_X + HE.MathUtils.randRange(-4, 4));
      var bz = bp.z;
      var gy = HE.TerrainGen.heightAt(bx, bz);

      var bw = _ENV.BARN_W  * bp.scaleX;
      var bd = _ENV.BARN_D  * bp.scaleZ;
      var bh = _ENV.BARN_WALL_H;

      /* ── Barn walls ── */
      var wallGeo  = new THREE.BoxGeometry(bw, bh, bd);
      var wall     = new THREE.Mesh(wallGeo, _MAT.barnWall);
      wall.position.set(bx, gy + bh * 0.5, bz);
      wall.castShadow    = true;
      wall.receiveShadow = true;
      group.add(wall);

      /* ── Pitched gable roof ──
         Each slope panel goes from the central ridge down to one eave.
         Ridge: y = gy + bh + ridgeH,  z = bz
         Eave:  y = gy + bh,           z = bz ± roofHalfD
         Correct geometry: box depth = true hypotenuse of (ridgeH, roofHalfD).
         Pivot is the box centre (midpoint between ridge and eave), so:
           +Z end of each rotated box → ridge,  -Z / +Z end → eave.     */
      var roofW     = bw + 0.4;
      var roofHalfD = bd * 0.5 + 0.3;       // half-depth including eave overhang
      var ridgeH    = _ENV.BARN_ROOF_H;
      /* True slope length (hypotenuse) — not an approximation */
      var slopeLen  = Math.sqrt(ridgeH * ridgeH + roofHalfD * roofHalfD);
      var angle     = Math.atan2(ridgeH, roofHalfD);

      var slopeGeo  = new THREE.BoxGeometry(roofW, 0.22, slopeLen);

      /* Left slope (toward -Z).  Centre = midpoint of ridge↔left-eave. */
      var slopeL = new THREE.Mesh(slopeGeo, _MAT.barnRoof);
      slopeL.rotation.x =  angle;
      slopeL.position.set(bx, gy + bh + ridgeH * 0.5, bz - roofHalfD * 0.5);
      slopeL.castShadow = true;
      group.add(slopeL);

      /* Right slope (toward +Z). */
      var slopeR = new THREE.Mesh(slopeGeo, _MAT.barnRoof);
      slopeR.rotation.x = -angle;
      slopeR.position.set(bx, gy + bh + ridgeH * 0.5, bz + roofHalfD * 0.5);
      slopeR.castShadow = true;
      group.add(slopeR);

      /* ── Silo alongside barn ── */
      var sx  = bx + bp.side * _ENV.SILO_OFFSET;
      var szy = HE.TerrainGen.heightAt(sx, bz);
      var siloGeo  = new THREE.CylinderGeometry(
        _ENV.SILO_R * 0.82,   // slightly narrower at top
        _ENV.SILO_R,
        _ENV.SILO_H,
        10
      );
      var silo = new THREE.Mesh(siloGeo, _MAT.silo);
      silo.position.set(sx, szy + _ENV.SILO_H * 0.5, bz + bd * 0.3);
      silo.castShadow = true;
      group.add(silo);

      /* Silo dome cap */
      var domeGeo = new THREE.SphereGeometry(_ENV.SILO_R * 0.85, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
      var dome    = new THREE.Mesh(domeGeo, _MAT.barnRoof);
      dome.position.set(sx, szy + _ENV.SILO_H + 0.05, bz + bd * 0.3);
      group.add(dome);
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     TREES
     Each cluster: N trees scattered in a disc of radius `spread`.
     Two canopy material variants alternated for visual variety.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildTrees(group) {

    _ENV.TREE_CLUSTERS.forEach(function(cl) {

      for (var i = 0; i < cl.count; i++) {

        /* Random position within cluster disc */
        var angle  = Math.random() * Math.PI * 2;
        var dist   = Math.random() * cl.spread;
        var tx     = cl.cx + Math.cos(angle) * dist;
        var tz     = cl.cz + Math.sin(angle) * dist;
        var gy     = HE.TerrainGen.heightAt(tx, tz);

        /* Randomised size within spec range */
        var trunkH = HE.MathUtils.randRange(_ENV.TREE_TRUNK_H_MIN, _ENV.TREE_TRUNK_H_MAX);
        var canH   = HE.MathUtils.randRange(_ENV.TREE_CANOPY_H_MIN, _ENV.TREE_CANOPY_H_MAX);
        var canR   = HE.MathUtils.randRange(_ENV.TREE_CANOPY_R_MIN, _ENV.TREE_CANOPY_R_MAX);

        /* ── Trunk ── */
        var trunkGeo = new THREE.CylinderGeometry(
          _ENV.TREE_TRUNK_R * 0.7,
          _ENV.TREE_TRUNK_R,
          trunkH,
          5
        );
        var trunk = new THREE.Mesh(trunkGeo, _MAT.trunkMat);
        trunk.position.set(tx, gy + trunkH * 0.5, tz);
        trunk.castShadow = true;
        group.add(trunk);

        /* ── Canopy — ConeGeometry for a classic pine/elm silhouette ── */
        var canMat   = (i % 2 === 0) ? _MAT.canopyA : _MAT.canopyB;
        var canopyGeo = new THREE.ConeGeometry(canR, canH, 7);
        var canopy   = new THREE.Mesh(canopyGeo, canMat);
        canopy.position.set(tx, gy + trunkH + canH * 0.5, tz);
        canopy.castShadow = true;

        /* Slight random lean (up to 4°) for organic variation */
        canopy.rotation.z = HE.MathUtils.randRange(-0.07, 0.07);
        canopy.rotation.x = HE.MathUtils.randRange(-0.06, 0.06);

        group.add(canopy);
      }
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     HAY BALES
     Round hay bales — CylinderGeometry lying on its side (rotation.z = 90°).
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildHayBales(group) {

    var baleGeo = new THREE.CylinderGeometry(
      _ENV.BALE_R,
      _ENV.BALE_R,
      _ENV.BALE_H,
      12
    );

    _ENV.BALE_POSITIONS.forEach(function(bp) {
      var gy   = HE.TerrainGen.heightAt(bp.x, bp.z);
      var bale = new THREE.Mesh(baleGeo, _MAT.bale);

      /* Lay flat: rotate cylinder 90° so it rests on curved side */
      bale.rotation.z = Math.PI / 2;
      bale.position.set(
        bp.x,
        gy + _ENV.BALE_R,   // resting on ground
        bp.z
      );

      /* Slight random yaw so bales aren't perfectly aligned */
      bale.rotation.y = Math.random() * Math.PI;

      bale.castShadow    = true;
      bale.receiveShadow = true;
      group.add(bale);
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     FENCES
     Rows of posts + two horizontal rails along defined field edges.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildFences(group) {

    var postGeo = new THREE.BoxGeometry(
      _ENV.FENCE_POST_W,
      _ENV.FENCE_POST_H,
      _ENV.FENCE_POST_W
    );
    var railGeo = new THREE.BoxGeometry(
      _ENV.FENCE_RAIL_W,
      _ENV.FENCE_RAIL_H,
      _ENV.FENCE_POST_SPACING   // will be repositioned per span
    );

    _ENV.FENCE_RUNS.forEach(function(run) {
      var z = run.zStart;

      while (z <= run.zEnd) {
        var gy   = HE.TerrainGen.heightAt(run.x, z);

        /* Post */
        var post = new THREE.Mesh(postGeo, _MAT.fence);
        post.position.set(run.x, gy + _ENV.FENCE_POST_H * 0.5, z);
        group.add(post);

        /* Rails to next post (if not at end) */
        var zNext = z + _ENV.FENCE_POST_SPACING;
        if (zNext <= run.zEnd + _ENV.FENCE_POST_SPACING) {
          var midZ  = (z + Math.min(zNext, run.zEnd)) * 0.5;
          var spanZ = Math.min(zNext, run.zEnd) - z;
          var gy2   = HE.TerrainGen.heightAt(run.x, midZ);

          _ENV.FENCE_RAIL_OFFSETS.forEach(function(yOff) {
            var rGeo = new THREE.BoxGeometry(
              _ENV.FENCE_RAIL_W,
              _ENV.FENCE_RAIL_H,
              spanZ
            );
            var rail = new THREE.Mesh(rGeo, _MAT.fence);
            rail.position.set(run.x, gy2 + yOff, midZ);
            group.add(rail);
          });
        }

        z += _ENV.FENCE_POST_SPACING;
      }
    });
  }


  /* ═══════════════════════════════════════════════════════════════════════
     WATER TOWER
     Classic Oklahoma small-town water tower: 6 tapered legs, cylindrical
     tank body, spherical dome cap. Placed at TOWER_X, TOWER_Z.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildWaterTower(group) {

    var tx = _ENV.TOWER_X;
    var tz = _ENV.TOWER_Z;
    var gy = HE.TerrainGen.heightAt(tx, tz);

    var legH     = _ENV.TOWER_LEG_H;
    var legTop   = gy + legH;   // Y where legs meet the tank base ring

    /* ── Legs — arranged in a circle ── */
    var legGeo = new THREE.CylinderGeometry(
      _ENV.TOWER_LEG_R * 0.6,   // tapers toward top
      _ENV.TOWER_LEG_R,
      legH,
      5
    );

    for (var i = 0; i < _ENV.TOWER_LEG_COUNT; i++) {
      var ang = (i / _ENV.TOWER_LEG_COUNT) * Math.PI * 2;
      var lx  = tx + Math.cos(ang) * _ENV.TOWER_LEG_SPREAD;
      var lz  = tz + Math.sin(ang) * _ENV.TOWER_LEG_SPREAD;
      var lgy = HE.TerrainGen.heightAt(lx, lz);

      var leg = new THREE.Mesh(legGeo, _MAT.towerSteel);
      leg.position.set(lx, lgy + legH * 0.5, lz);

      /* Tilt legs slightly inward to converge at the tank ring */
      var tiltAng = Math.atan2(_ENV.TOWER_LEG_SPREAD, legH) * 0.5;
      leg.rotation.z =  Math.cos(ang) * tiltAng;
      leg.rotation.x = -Math.sin(ang) * tiltAng;

      leg.castShadow = true;
      group.add(leg);
    }

    /* ── Cross-bracing ring (flat torus at mid-height) ── */
    var braceGeo = new THREE.TorusGeometry(
      _ENV.TOWER_LEG_SPREAD * 0.95,
      0.12,
      4,
      _ENV.TOWER_LEG_COUNT * 2
    );
    var brace = new THREE.Mesh(braceGeo, _MAT.towerSteel);
    brace.rotation.x = Math.PI / 2;
    brace.position.set(tx, gy + legH * 0.55, tz);
    group.add(brace);

    /* ── Tank body (cylinder) ── */
    var tankGeo  = new THREE.CylinderGeometry(
      _ENV.TOWER_BODY_R,
      _ENV.TOWER_BODY_R * 1.05,
      _ENV.TOWER_BODY_H,
      14
    );
    var tank = new THREE.Mesh(tankGeo, _MAT.towerTank);
    tank.position.set(tx, legTop + _ENV.TOWER_BODY_H * 0.5, tz);
    tank.castShadow = true;
    group.add(tank);

    /* ── Dome cap ── */
    var domeGeo  = new THREE.SphereGeometry(
      _ENV.TOWER_DOME_R,
      12,
      8,
      0,
      Math.PI * 2,
      0,
      Math.PI * 0.48   // just over half-sphere for a shallow dome
    );
    var dome = new THREE.Mesh(domeGeo, _MAT.towerTank);
    dome.position.set(tx, legTop + _ENV.TOWER_BODY_H, tz);
    group.add(dome);

    /* ── Access ladder (thin box running up one leg side) ── */
    var ladderGeo = new THREE.BoxGeometry(0.12, legH + _ENV.TOWER_BODY_H, 0.06);
    var ladder    = new THREE.Mesh(ladderGeo, _MAT.towerSteel);
    ladder.position.set(
      tx + _ENV.TOWER_DOME_R * 0.85,
      gy + (legH + _ENV.TOWER_BODY_H) * 0.5,
      tz
    );
    group.add(ladder);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     CLOUDS
     Fluffy cloud meshes built from merged SphereGeometry puffs.
     Added DIRECTLY to scene (not to props group) and returned in the
     clouds[] array so Render.js can drift them per-frame.
     Each cloud gets a userData.baseY for Render.js's storm-descent lerp.
  ═══════════════════════════════════════════════════════════════════════ */
  static _buildClouds(scene, cloudsOut) {

    for (var c = 0; c < _ENV.CLOUD_COUNT; c++) {

      var cx   = HE.MathUtils.randRange(-_ENV.CLOUD_X_RANGE, _ENV.CLOUD_X_RANGE);
      var cy   = HE.MathUtils.randRange(_ENV.CLOUD_Y_MIN, _ENV.CLOUD_Y_MAX);
      var cz   = HE.MathUtils.randRange(-_ENV.CLOUD_Z_RANGE, _ENV.CLOUD_Z_RANGE);

      var puffCount = HE.MathUtils.randInt(_ENV.CLOUD_PUFF_MIN, _ENV.CLOUD_PUFF_MAX);

      /* Merge puffs into a single geometry for one draw call per cloud */
      var mergedGeo = new THREE.BufferGeometry();
      var allPos    = [];
      var allNorm   = [];
      var allIdx    = [];
      var vertOffset = 0;

      for (var p = 0; p < puffCount; p++) {
        var pr  = HE.MathUtils.randRange(_ENV.CLOUD_PUFF_R_MIN, _ENV.CLOUD_PUFF_R_MAX);
        var px  = HE.MathUtils.randRange(-pr * 1.8, pr * 1.8);
        var py  = HE.MathUtils.randRange(-pr * 0.3, pr * 0.5);
        var pz  = HE.MathUtils.randRange(-pr * 0.8, pr * 0.8);

        var sg  = new THREE.SphereGeometry(pr, 6, 5);
        var spa = sg.attributes.position;
        var sna = sg.attributes.normal;
        var sia = sg.index;

        for (var v = 0; v < spa.count; v++) {
          allPos.push(
            spa.getX(v) + px,
            spa.getY(v) + py,
            spa.getZ(v) + pz
          );
          allNorm.push(sna.getX(v), sna.getY(v), sna.getZ(v));
        }

        for (var ii = 0; ii < sia.count; ii++) {
          allIdx.push(sia.getX(ii) + vertOffset);
        }

        vertOffset += spa.count;
        sg.dispose();   // free after merging
      }

      mergedGeo.setAttribute(
        'position', new THREE.BufferAttribute(new Float32Array(allPos), 3)
      );
      mergedGeo.setAttribute(
        'normal',   new THREE.BufferAttribute(new Float32Array(allNorm), 3)
      );
      mergedGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(allIdx), 1));
      mergedGeo.computeBoundingSphere();

      var cloudMesh      = new THREE.Mesh(mergedGeo, _MAT.cloud.clone());
      cloudMesh.name     = 'cloud_' + c;
      cloudMesh.position.set(cx, cy, cz);
      cloudMesh.userData.baseY = cy;   // Render.js uses this for storm descent

      scene.add(cloudMesh);
      cloudsOut.push(cloudMesh);
    }
  }

};
