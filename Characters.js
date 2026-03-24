/* ═══════════════════════════════════════════════════════════════════════════
   Characters.js  —  HEXADO CHASING v2.0
   Layer   : Systems (load order: 8th — after tornado.js)
   Exports : window.HexEngine.VehicleFactory
             window.HexEngine.FPVCamera
             window.HexEngine.ThirdPersonCamera
             window.HexEngine.Walker
   Deps    : Three.js r128  ·  HE.MathUtils (main-math.js)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Characters.js owns all character geometry and camera control for the two
   player modes:

     ┌────────────────────────────────────────────────────────────────────┐
     │  VEHICLE MODE  (inVehicle = true)                                  │
     │    VehicleFactory.createVehicle()  → F-150 pickup group            │
     │    VehicleFactory.createCockpit()  → FPV dashboard + instruments   │
     │    VehicleFactory.createDriver()   → seated figure (FPV visible)   │
     │    FPVCamera.update()              → positions camera in cab        │
     │    FPVCamera.animateWheel()        → steering wheel rotation        │
     │    FPVCamera.animateNeedle()       → speedo needle sweep            │
     │                                                                    │
     │  ON-FOOT MODE  (inVehicle = false)                                 │
     │    VehicleFactory.createWalker()   → standing chaser figure        │
     │    Walker.update()                 → WASD locomotion + terrain snap │
     │    ThirdPersonCamera.update()      → smooth follow + orbit camera   │
     └────────────────────────────────────────────────────────────────────┘

   Geometry philosophy (ALL procedural — zero external files)
   ───────────────────────────────────────────────────────────
   Truck body   — layered BoxGeometry blocks (cab, bed, hood, bumpers)
   Wheels       — CylinderGeometry × 4 + thin disc hubs
   Cockpit      — BoxGeometry dash + TorusGeometry wheel + pivot needle
   Driver/Walker— BoxGeometry torso/limbs + SphereGeometry head (capsule-free)
   Note: Three.js r128 has NO CapsuleGeometry → Cylinder + Sphere combos.

   Camera system design
   ─────────────────────
   FPVCamera:
     Eye point sits 1.15 wu above vehicle Y, 0.25 wu forward of centre.
     Gentle speed-based head-bob (y-axis only, ±0.04 wu) for kinetic feel.
     Camera heading = physics.heading exactly (no lag — driver-seat realism).

   ThirdPersonCamera:
     Offset: 0 wu right, +4.5 wu up, −12 wu behind the vehicle.
     Smooth exponential lerp toward ideal position (lerp rate 8.0 per sec).
     Always looks at a point 1.5 wu above the vehicle centre.
     Terrain clearance: camera Y never falls below heightFn(x,z) + 1.0.

   Walker locomotion
   ─────────────────
   On-foot speed  : 4.8 m/s forward, 3.2 m/s sideways  (keyboard WASD)
   Heading input  : A/D steer (π rad/s rate)
   Terrain snap   : Y = heightFn(x, z)  each frame
   Leg animation  : left / right CylinderGeometry legs pivot ±15° on a
                    sinusoidal cycle proportional to move speed.

   Golden Rules obeyed
   ───────────────────
   • var HE = window.HexEngine — never const at top-level
   • No ES module import/export — plain <script> tag
   • Three.js r128: no CapsuleGeometry — all "capsule" shapes are
     Cylinder + capping Sphere combos
   • EventBus is the ONLY cross-module channel (Characters.js only reads
     physics.keys directly; it never emits events of its own)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   CONSTANTS — tune here, never buried in method bodies
   ═══════════════════════════════════════════════════════════════════════════ */

var _CH = {

  /* ─── Truck body dimensions (world units) ────────────────────────────── */
  TRUCK_CAB_W:    2.10,   // cab width (X)
  TRUCK_CAB_H:    1.42,   // cab wall height (Y above chassis)
  TRUCK_CAB_D:    2.20,   // cab depth (Z)
  TRUCK_BED_D:    2.40,   // open truck bed length (Z)
  TRUCK_BED_H:    0.68,   // bed side walls height
  TRUCK_CHASSIS_H: 0.32,  // chassis slab height (sits above wheels)
  TRUCK_CHASSIS_D: 4.80,  // total vehicle length
  TRUCK_CHASSIS_W: 2.10,
  TRUCK_HOOD_H:   0.40,
  TRUCK_HOOD_D:   1.20,
  TRUCK_ROOF_PEAK: 0.18,  // raised box on roof (extra head-room arc)

  /* ─── Wheel dimensions ───────────────────────────────────────────────── */
  WHEEL_R:        0.44,   // outer radius
  WHEEL_W:        0.28,   // tyre width
  WHEEL_X:        1.18,   // |x| distance from centreline
  WHEEL_Z_FRONT: -1.52,   // front axle Z offset from vehicle centre
  WHEEL_Z_REAR:   1.52,   // rear axle Z offset
  HUB_R:          0.20,   // inner hub disc radius
  HUB_W:          0.06,

  /* ─── Cockpit (FPV) dimensions ───────────────────────────────────────── */
  DASH_W:         1.80,
  DASH_H:         0.42,
  DASH_D:         0.28,
  DASH_Y:         0.62,   // Y above vehicle origin (seat level ref)
  DASH_Z:        -0.72,   // Z inside cab (forward of centre)
  STEER_R:        0.35,   // steering wheel torus outer radius
  STEER_TUBE:     0.035,  // steering wheel tube radius
  STEER_Y:        0.92,
  STEER_Z:       -0.55,
  STEER_TILT:     0.42,   // rad — wheel tilts toward driver
  NEEDLE_L:       0.15,   // speedo needle length
  NEEDLE_Y:       0.64,
  NEEDLE_Z:      -0.65,
  NEEDLE_X:       0.46,   // offset right of centre on dash

  /* ─── Camera — FPV ───────────────────────────────────────────────────── */
  FPV_EYE_Y:      1.28,   // eye height above vehicle Y (was 1.15 — now at head level)
  FPV_EYE_Z:      0.62,   // forward from centre toward windshield (was 0.22 — too shallow)
  FPV_SEAT_X:     0.24,   // driver sits left in cab → right in world after +PI rotation
  FPV_BOB_AMP:    0.030,  // reduced head-bob amplitude (was 0.038 — a bit much)
  FPV_BOB_FREQ:   1.55,   // head-bob frequency (Hz at max speed)

  /* ─── Camera — Third-person ──────────────────────────────────────────── */
  TPC_BEHIND:    11.5,    // world units behind vehicle
  TPC_UP:         4.5,    // world units above vehicle
  TPC_TARGET_Y:   1.5,    // Y offset above vehicle for look-target
  TPC_LERP_RATE:  8.0,    // exponential lerp coefficient (per second)
  TPC_MIN_CLEAR:  1.0,    // minimum ground clearance for camera Y

  /* ─── Walker ─────────────────────────────────────────────────────────── */
  WALK_SPEED_FWD:  4.8,   // m/s forward
  WALK_SPEED_SIDE: 3.2,   // m/s strafe
  WALK_STEER_RATE: Math.PI, // rad/s heading change from A/D
  WALK_BOB_AMP:   0.055,  // subtle vertical bob while moving
  WALK_BOB_FREQ:  2.20,   // Hz — two steps per second
  LEG_SWING_AMP:  0.27,   // rad — leg pivot amplitude (±15°)

  /* ─── Human figure proportions ──────────────────────────────────────── */
  HEAD_R:         0.22,
  TORSO_W:        0.42,
  TORSO_H:        0.64,
  TORSO_D:        0.22,
  LIMB_R:         0.09,   // cylinder radius for arms + legs
  ARM_H:          0.52,
  LEG_H:          0.60,
  SEATED_TORSO_Y: 0.68,   // torso base Y above vehicle origin (seated)
  STAND_TORSO_Y:  0.62,   // torso base Y above walker origin (standing)

  /* ─── Colours ────────────────────────────────────────────────────────── */
  COL_TRUCK_BODY:  0xcc2200,  // bright chaser red
  COL_TRUCK_CABIN: 0xb81e00,  // slightly darker cab
  COL_TRUCK_GLASS: 0x223344,  // dark tinted glass
  COL_WHEEL:       0x1a1a1a,  // near-black rubber
  COL_HUB:         0x888888,  // silver hub cap
  COL_CHROME:      0xcccccc,  // bumper chrome
  COL_DASH:        0x1c1c1c,  // dark dashboard
  COL_DASH_ACCENT: 0x333322,  // slightly lighter panel trim
  COL_STEER:       0x222222,
  COL_NEEDLE:      0xff4400,  // speedo needle — amber/red
  COL_BODY_SUIT:   0x3355aa,  // chaser jumpsuit blue
  COL_HELMET:      0xffa500,  // orange safety helmet
  COL_SKIN:        0xd4a47a,  // face / hands
  COL_BOOT:        0x222211   // dark work boots
};


/* ═══════════════════════════════════════════════════════════════════════════
   SHARED MATERIALS  — built lazily inside VehicleFactory.init()
   Reused across every vehicle + character so draw calls stay minimal.
   ═══════════════════════════════════════════════════════════════════════════ */

var _MATS = null;

function _ensureMats() {
  if (_MATS) return;
  _MATS = {
    body:      new THREE.MeshLambertMaterial({ color: _CH.COL_TRUCK_BODY }),
    cabin:     new THREE.MeshLambertMaterial({ color: _CH.COL_TRUCK_CABIN }),
    glass:     new THREE.MeshLambertMaterial({ color: _CH.COL_TRUCK_GLASS,
                  transparent: true, opacity: 0.55 }),
    wheel:     new THREE.MeshLambertMaterial({ color: _CH.COL_WHEEL }),
    hub:       new THREE.MeshLambertMaterial({ color: _CH.COL_HUB }),
    chrome:    new THREE.MeshLambertMaterial({ color: _CH.COL_CHROME }),
    dash:      new THREE.MeshLambertMaterial({ color: _CH.COL_DASH }),
    dashAccent:new THREE.MeshLambertMaterial({ color: _CH.COL_DASH_ACCENT }),
    steer:     new THREE.MeshLambertMaterial({ color: _CH.COL_STEER }),
    needle:    new THREE.MeshLambertMaterial({ color: _CH.COL_NEEDLE,
                  emissive: new THREE.Color(_CH.COL_NEEDLE), emissiveIntensity: 0.4 }),
    suit:      new THREE.MeshLambertMaterial({ color: _CH.COL_BODY_SUIT }),
    helmet:    new THREE.MeshLambertMaterial({ color: _CH.COL_HELMET }),
    skin:      new THREE.MeshLambertMaterial({ color: _CH.COL_SKIN }),
    boot:      new THREE.MeshLambertMaterial({ color: _CH.COL_BOOT })
  };
}


/* ═══════════════════════════════════════════════════════════════════════════
   HELPER  —  _box(w, h, d, mat)
   Creates a BoxGeometry Mesh. Extremely reused — keeps builder code terse.
   ═══════════════════════════════════════════════════════════════════════════ */
function _box(w, h, d, mat) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
}

function _cyl(rTop, rBot, h, segs, mat) {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), mat);
}

function _sphere(r, wSegs, hSegs, mat) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, wSegs, hSegs), mat);
}


/* ═══════════════════════════════════════════════════════════════════════════
   HE.VehicleFactory
   ──────────────────
   Pure static factory — call methods directly, never instantiate.
   All return a THREE.Group; caller adds to scene.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.VehicleFactory = class {

  /* ═══════════════════════════════════════════════════════════════════════
     createVehicle()
     ────────────────
     Builds a stylised F-150 pickup truck from layered BoxGeometry blocks.

     Hierarchy (all children of returned group):
       chassis      — wide low slab, full vehicle length
       hood         — sloped front section
       cab          — tall passenger compartment (front 40% of chassis)
       bed          — open truck bed (rear 50% of chassis)
       bedWalls     — three short wall slabs around the bed (L + R + rear)
       windshield   — dark box tilted in cab front face
       rearWindow   — flat dark box on cab rear
       roof         — box on top of cab
       frontBumper  — chrome box at very front
       rearBumper   — chrome box at very rear
       grill        — dark box recessed in front
       wheels × 4   — CylinderGeometry tyres + hub discs
       headlights   — small yellow BoxGeometry (pair)
       taillights   — small red BoxGeometry (pair)

     Origin: centre of chassis at ground level (Y = 0).
     Caller positions/rotates this group each frame.
  ═══════════════════════════════════════════════════════════════════════ */
  static createVehicle() {
    _ensureMats();

    var g = new THREE.Group();
    g.name = 'vehicle';

    /* ── Core dimensions ── */
    var CW    = _CH.TRUCK_CHASSIS_W;    // 2.10
    var CH    = _CH.TRUCK_CHASSIS_H;    // 0.32
    var CD    = _CH.TRUCK_CHASSIS_D;    // 4.80
    var cabW  = _CH.TRUCK_CAB_W;        // 2.10
    var cabH  = _CH.TRUCK_CAB_H;        // 1.42
    var cabD  = _CH.TRUCK_CAB_D;        // 2.20
    var bedD  = _CH.TRUCK_BED_D;        // 2.40
    var hoodD = _CH.TRUCK_HOOD_D;       // 1.20
    var hoodH = _CH.TRUCK_HOOD_H;       // 0.40
    var bedH  = _CH.TRUCK_BED_H;        // 0.68
    var roofH = _CH.TRUCK_ROOF_PEAK;    // 0.18

    /* ── Derived Z centres ── */
    var hoodZ = -CD * 0.5 + hoodD * 0.5;
    var cabZ  = -CD * 0.5 + hoodD + cabD * 0.5;
    var bedZ  =  cabZ + cabD * 0.5 + bedD * 0.5;

    /* ── Derived Y levels ── */
    var cabBaseY = CH;
    var cabTopY  = CH + cabH;

    /* ── Extra inline materials ── */
    var matFlatBlack = new THREE.MeshLambertMaterial({ color: 0x111111 });
    var matSkid      = new THREE.MeshLambertMaterial({ color: 0x282828 });
    var matAmber     = new THREE.MeshLambertMaterial({
      color: 0xff9900,
      emissive: new THREE.Color(0xdd6600), emissiveIntensity: 0.8
    });
    var matSteel     = new THREE.MeshLambertMaterial({ color: 0x3a3a3a });
    var matRotor     = new THREE.MeshLambertMaterial({ color: 0x4a4a4a });
    var matCenter    = new THREE.MeshLambertMaterial({ color: 0xcccccc });

    /* ══════════════════════════════════════════════════════════
       1. CHASSIS + FRAME RAILS
    ══════════════════════════════════════════════════════════ */
    var chassis = _box(CW, CH, CD, _MATS.body);
    chassis.name = 'chassis';
    chassis.position.y = CH * 0.5;
    chassis.castShadow = true;
    g.add(chassis);

    /* Longitudinal frame rails visible under body */
    for (var si = -1; si <= 1; si += 2) {
      var rail = _box(0.14, CH * 0.55, CD * 0.92, matFlatBlack);
      rail.name = 'frameRail_' + (si < 0 ? 'L' : 'R');
      rail.position.set(si * (CW * 0.5 - 0.12), CH * 0.22, 0);
      g.add(rail);
    }

    /* ══════════════════════════════════════════════════════════
       2. HOOD — center spine + side vent creases
    ══════════════════════════════════════════════════════════ */
    var hood = _box(CW, hoodH, hoodD, _MATS.body);
    hood.name = 'hood';
    hood.position.set(0, cabBaseY + hoodH * 0.5, hoodZ);
    hood.castShadow = true;
    g.add(hood);

    /* Center spine ridge running front-to-back */
    var hoodSpine = _box(0.26, 0.08, hoodD * 0.82, _MATS.cabin);
    hoodSpine.name = 'hoodSpine';
    hoodSpine.position.set(0, cabBaseY + hoodH + 0.04, hoodZ + 0.05);
    g.add(hoodSpine);

    /* Side vent scoops — raised creases flanking the spine */
    for (var si = -1; si <= 1; si += 2) {
      var vent = _box(0.20, 0.04, hoodD * 0.48, _MATS.cabin);
      vent.name = 'hoodVent_' + (si < 0 ? 'L' : 'R');
      vent.position.set(si * 0.52, cabBaseY + hoodH + 0.02, hoodZ + 0.08);
      g.add(vent);
    }

    /* ══════════════════════════════════════════════════════════
       3. CAB BODY + GREENHOUSE PILLARS
       Main cab box defines the opaque lower body.
       A/B/C pillar boxes frame the window openings,
       giving the silhouette depth and structure.
    ══════════════════════════════════════════════════════════ */
    var cab = _box(cabW, cabH, cabD, _MATS.cabin);
    cab.name = 'cab';
    cab.position.set(0, cabBaseY + cabH * 0.5, cabZ);
    cab.castShadow = true;
    g.add(cab);

    /* Roof slab — slightly narrowed for taper */
    var roof = _box(cabW - 0.10, roofH + 0.08, cabD - 0.20, _MATS.cabin);
    roof.name = 'roof';
    roof.position.set(0, cabTopY + roofH * 0.5, cabZ);
    roof.castShadow = true;
    g.add(roof);

    /* Roof drip rail — slim overhang lip all around */
    var roofLip = _box(cabW + 0.05, 0.04, cabD + 0.05, _MATS.cabin);
    roofLip.name = 'roofLip';
    roofLip.position.set(0, cabTopY + 0.02, cabZ);
    g.add(roofLip);

    /* ── A-Pillars (front uprights, angled with windshield) ── */
    for (var si = -1; si <= 1; si += 2) {
      var ap = _box(0.11, cabH * 0.78, 0.11, _MATS.cabin);
      ap.name = 'aPillar_' + (si < 0 ? 'L' : 'R');
      ap.position.set(
        si * (cabW * 0.5 - 0.055),
        cabBaseY + cabH * 0.50,
        cabZ - cabD * 0.5 + 0.07
      );
      g.add(ap);
    }

    /* ── B-Pillars (centre uprights between front/rear door) ── */
    for (var si = -1; si <= 1; si += 2) {
      var bp = _box(0.11, cabH * 0.88, 0.11, _MATS.cabin);
      bp.name = 'bPillar_' + (si < 0 ? 'L' : 'R');
      bp.position.set(si * (cabW * 0.5 - 0.055), cabBaseY + cabH * 0.50, cabZ + 0.06);
      g.add(bp);
    }

    /* ── C-Pillars (rear uprights, thick for structural feel) ── */
    for (var si = -1; si <= 1; si += 2) {
      var cp = _box(0.14, cabH * 0.82, 0.14, _MATS.cabin);
      cp.name = 'cPillar_' + (si < 0 ? 'L' : 'R');
      cp.position.set(
        si * (cabW * 0.5 - 0.07),
        cabBaseY + cabH * 0.50,
        cabZ + cabD * 0.5 - 0.08
      );
      g.add(cp);
    }

    /* ══════════════════════════════════════════════════════════
       4. GLASS — windshield, rear, side panes
    ══════════════════════════════════════════════════════════ */

    /* Windshield header (top framing bar above glass) */
    var wsHeader = _box(cabW - 0.28, 0.08, 0.10, _MATS.cabin);
    wsHeader.position.set(0, cabTopY - 0.07, cabZ - cabD * 0.5 + 0.06);
    g.add(wsHeader);

    /* Main windshield — tall, well-angled */
    var wsH = cabH * 0.74;
    var ws  = _box(cabW - 0.28, wsH, 0.07, _MATS.glass);
    ws.name = 'windshield';
    ws.position.set(0, cabBaseY + cabH * 0.52, cabZ - cabD * 0.5 + 0.05);
    ws.rotation.x = 0.28;
    g.add(ws);

    /* Rear window */
    var rw = _box(cabW - 0.30, wsH * 0.84, 0.07, _MATS.glass);
    rw.name = 'rearWindow';
    rw.position.set(0, cabBaseY + cabH * 0.48, cabZ + cabD * 0.5 - 0.05);
    rw.rotation.x = -0.18;
    g.add(rw);

    /* Side windows — front pane (larger, between A and B pillar) */
    for (var si = -1; si <= 1; si += 2) {
      var sfw = _box(0.06, wsH * 0.82, cabD * 0.40, _MATS.glass);
      sfw.name = 'sideWinFront_' + (si < 0 ? 'L' : 'R');
      sfw.position.set(si * (cabW * 0.5 + 0.02), cabBaseY + cabH * 0.54, cabZ - cabD * 0.12);
      g.add(sfw);

      /* Rear quarter window (smaller, between B and C pillar) */
      var sqw = _box(0.06, wsH * 0.68, cabD * 0.28, _MATS.glass);
      sqw.name = 'sideWinRear_' + (si < 0 ? 'L' : 'R');
      sqw.position.set(si * (cabW * 0.5 + 0.02), cabBaseY + cabH * 0.50, cabZ + cabD * 0.29);
      g.add(sqw);
    }

    /* ══════════════════════════════════════════════════════════
       5. SIDE MIRRORS — arm + face
    ══════════════════════════════════════════════════════════ */
    for (var si = -1; si <= 1; si += 2) {
      var mArm = _box(0.06, 0.06, 0.22, _MATS.cabin);
      mArm.name = 'mirrorArm_' + (si < 0 ? 'L' : 'R');
      mArm.position.set(
        si * (cabW * 0.5 + 0.10),
        cabBaseY + cabH * 0.78,
        cabZ - cabD * 0.5 + 0.30
      );
      g.add(mArm);

      var mFace = _box(0.05, 0.22, 0.14, _MATS.dash);
      mFace.name = 'mirrorFace_' + (si < 0 ? 'L' : 'R');
      mFace.position.set(
        si * (cabW * 0.5 + 0.13),
        cabBaseY + cabH * 0.80,
        cabZ - cabD * 0.5 + 0.34
      );
      g.add(mFace);
    }

    /* ══════════════════════════════════════════════════════════
       6. STORM CHASER ROOF RACK + LIGHT BAR
       Signature storm-chaser equipment rig.
    ══════════════════════════════════════════════════════════ */
    var rackY = cabTopY + roofH + 0.10;

    /* Two longitudinal rails */
    for (var si = -1; si <= 1; si += 2) {
      var rackRail = _box(0.06, 0.06, cabD * 0.74, _MATS.chrome);
      rackRail.name = 'rackRail_' + (si < 0 ? 'L' : 'R');
      rackRail.position.set(si * 0.54, rackY, cabZ);
      g.add(rackRail);
    }

    /* Three cross bars */
    var cbOffsets = [-0.54, 0.02, 0.58];
    for (var ci = 0; ci < cbOffsets.length; ci++) {
      var cbar = _box(cabW * 0.70, 0.06, 0.06, _MATS.chrome);
      cbar.name = 'rackCross_' + ci;
      cbar.position.set(0, rackY, cabZ + cbOffsets[ci]);
      g.add(cbar);
    }

    /* Amber light bar housing */
    var lbBody = _box(cabW * 0.66, 0.10, 0.20, matSkid);
    lbBody.name = 'lightBarBody';
    lbBody.position.set(0, rackY + 0.10, cabZ - cabD * 0.30);
    g.add(lbBody);

    /* Individual amber lights — 5 lenses */
    for (var li = 0; li < 5; li++) {
      var lbX     = ((li / 4) - 0.5) * (cabW * 0.54);
      var lbLight = _box(0.11, 0.08, 0.11, matAmber);
      lbLight.name = 'lbLight_' + li;
      lbLight.position.set(lbX, rackY + 0.14, cabZ - cabD * 0.30);
      g.add(lbLight);
    }

    /* Equipment boxes — sensor/laptop mounts on rack rear */
    var eq1 = _box(0.42, 0.15, 0.32, matSkid);
    eq1.name = 'equipBox1';
    eq1.position.set(-0.26, rackY + 0.12, cabZ + 0.20);
    g.add(eq1);

    var eq2 = _box(0.26, 0.11, 0.24, matSteel);
    eq2.name = 'equipBox2';
    eq2.position.set( 0.28, rackY + 0.10, cabZ + 0.24);
    g.add(eq2);

    /* Small antenna mast at rear of rack */
    var antBase = _cyl(0.04, 0.04, 0.10, 6, matSteel);
    antBase.position.set(0.50, rackY + 0.08, cabZ + cabD * 0.32);
    g.add(antBase);
    var antMast = _cyl(0.02, 0.02, 0.38, 6, _MATS.chrome);
    antMast.position.set(0.50, rackY + 0.34, cabZ + cabD * 0.32);
    g.add(antMast);

    /* ══════════════════════════════════════════════════════════
       7. DOOR PANEL DETAILS — body crease + handles
    ══════════════════════════════════════════════════════════ */
    for (var si = -1; si <= 1; si += 2) {
      /* Horizontal character line spanning cab + bed */
      var crease = _box(0.04, 0.05, cabD + bedD - 0.20, _MATS.cabin);
      crease.name = 'bodyCrease_' + (si < 0 ? 'L' : 'R');
      crease.position.set(
        si * (CW * 0.5 + 0.02),
        cabBaseY + cabH * 0.28,
        (cabZ + bedZ) * 0.5
      );
      g.add(crease);

      /* Door handle — small chrome pull */
      var dh = _box(0.05, 0.09, 0.24, _MATS.chrome);
      dh.name = 'doorHandle_' + (si < 0 ? 'L' : 'R');
      dh.position.set(si * (cabW * 0.5 + 0.04), cabBaseY + cabH * 0.55, cabZ + 0.12);
      g.add(dh);
    }

    /* ══════════════════════════════════════════════════════════
       8. TRUCK BED — floor + walls + liner + rail caps
    ══════════════════════════════════════════════════════════ */
    var bedFloor = _box(CW, 0.10, bedD, _MATS.body);
    bedFloor.name = 'bedFloor';
    bedFloor.position.set(0, cabBaseY + 0.05, bedZ);
    g.add(bedFloor);

    /* Dark bed liner inside walls */
    var bedLiner = _box(CW - 0.30, bedH - 0.06, bedD - 0.06, matFlatBlack);
    bedLiner.name = 'bedLiner';
    bedLiner.position.set(0, cabBaseY + (bedH - 0.06) * 0.5 + 0.02, bedZ);
    g.add(bedLiner);

    /* Bed side walls + chrome rail caps */
    for (var si = -1; si <= 1; si += 2) {
      var bsw = _box(0.12, bedH, bedD, _MATS.body);
      bsw.name = 'bedSide_' + (si < 0 ? 'L' : 'R');
      bsw.position.set(si * (CW * 0.5 - 0.06), cabBaseY + bedH * 0.5, bedZ);
      g.add(bsw);

      var railCap = _box(0.10, 0.07, bedD + 0.04, _MATS.chrome);
      railCap.name = 'bedRailCap_' + (si < 0 ? 'L' : 'R');
      railCap.position.set(si * (CW * 0.5 - 0.06), cabBaseY + bedH + 0.03, bedZ);
      g.add(railCap);
    }

    /* Tailgate */
    var tailgate = _box(CW - 0.08, bedH, 0.12, _MATS.body);
    tailgate.name = 'tailgate';
    tailgate.position.set(0, cabBaseY + bedH * 0.5, bedZ + bedD * 0.5 - 0.06);
    g.add(tailgate);

    /* Tailgate chrome handle bar */
    var tgHandle = _box(CW * 0.36, 0.06, 0.07, _MATS.chrome);
    tgHandle.name = 'tailgateHandle';
    tgHandle.position.set(0, cabBaseY + bedH * 0.52, bedZ + bedD * 0.5 + 0.04);
    g.add(tgHandle);

    /* ══════════════════════════════════════════════════════════
       9. FRONT END — skid plate + grille bars + bumper + hooks
    ══════════════════════════════════════════════════════════ */

    /* Heavy skid plate — flat black underbody protection */
    var skid = _box(CW + 0.24, 0.26, 0.30, matSkid);
    skid.name = 'skidPlate';
    skid.position.set(0, CH * 0.44, -CD * 0.5 - 0.13);
    skid.castShadow = true;
    g.add(skid);

    /* Front bumper — main chrome bar */
    var fBumper = _box(CW + 0.18, 0.14, 0.17, _MATS.chrome);
    fBumper.name = 'frontBumper';
    fBumper.position.set(0, cabBaseY + 0.28, -CD * 0.5 - 0.07);
    g.add(fBumper);

    /* Bumper end caps — flat black */
    for (var si = -1; si <= 1; si += 2) {
      var bec = _box(0.16, 0.24, 0.24, matSkid);
      bec.name = 'bumperEndCap_' + (si < 0 ? 'L' : 'R');
      bec.position.set(si * (CW * 0.5 + 0.06), cabBaseY + 0.20, -CD * 0.5 - 0.09);
      g.add(bec);
    }

    /* Grille surround frame */
    var grillFrame = _box(CW * 0.84, 0.40, 0.10, _MATS.cabin);
    grillFrame.name = 'grilleFrame';
    grillFrame.position.set(0, cabBaseY + hoodH * 0.54, -CD * 0.5 - 0.04);
    g.add(grillFrame);

    /* Grille background mesh */
    var grillBg = _box(CW * 0.70, 0.32, 0.06, _MATS.dash);
    grillBg.name = 'grilleBg';
    grillBg.position.set(0, cabBaseY + hoodH * 0.45, -CD * 0.5 - 0.02);
    g.add(grillBg);

    /* Grille horizontal bars — 4 chrome strips */
    for (var gi = 0; gi < 4; gi++) {
      var gy   = cabBaseY + 0.09 + gi * 0.08;
      var gbar = _box(CW * 0.68, 0.04, 0.09, _MATS.chrome);
      gbar.name = 'grilleBar_' + gi;
      gbar.position.set(0, gy, -CD * 0.5 - 0.01);
      g.add(gbar);
    }

    /* Tow hooks — chrome blocks at base of skid plate */
    for (var si = -1; si <= 1; si += 2) {
      var hook = _box(0.11, 0.11, 0.20, _MATS.chrome);
      hook.name = 'towHook_' + (si < 0 ? 'L' : 'R');
      hook.position.set(si * 0.50, CH * 0.22, -CD * 0.5 - 0.20);
      g.add(hook);
    }

    /* ══════════════════════════════════════════════════════════
       10. HEADLIGHTS — housing + main lamp + DRL strip
    ══════════════════════════════════════════════════════════ */
    var matHLHousing = new THREE.MeshLambertMaterial({ color: 0x1c1c1c });
    var matHLLamp    = new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: new THREE.Color(0xfff0cc), emissiveIntensity: 1.0
    });
    var matDRL = new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.65
    });

    for (var si = -1; si <= 1; si += 2) {
      var hlH = _box(0.40, 0.24, 0.11, matHLHousing);
      hlH.name = 'hlHousing_' + (si < 0 ? 'L' : 'R');
      hlH.position.set(si * 0.67, cabBaseY + hoodH * 0.68, -CD * 0.5 - 0.04);
      g.add(hlH);

      var hlL = _box(0.22, 0.13, 0.07, matHLLamp);
      hlL.name = 'hlLamp_' + (si < 0 ? 'L' : 'R');
      hlL.position.set(si * 0.67, cabBaseY + hoodH * 0.72, -CD * 0.5 - 0.06);
      g.add(hlL);

      /* DRL — thin white running strip below main lamp */
      var drl = _box(0.36, 0.04, 0.07, matDRL);
      drl.name = 'drl_' + (si < 0 ? 'L' : 'R');
      drl.position.set(si * 0.67, cabBaseY + hoodH * 0.44, -CD * 0.5 - 0.05);
      g.add(drl);
    }

    /* ══════════════════════════════════════════════════════════
       11. TAILLIGHTS — housing + red lamp + reverse strip + brake bar
    ══════════════════════════════════════════════════════════ */
    var matTLHousing = new THREE.MeshLambertMaterial({ color: 0x1a0000 });
    var matTLRed     = new THREE.MeshLambertMaterial({
      color: 0xff2200, emissive: new THREE.Color(0xcc1100), emissiveIntensity: 0.75
    });
    var matTLWhite   = new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: new THREE.Color(0xaaaaaa), emissiveIntensity: 0.4
    });

    for (var si = -1; si <= 1; si += 2) {
      var tlH = _box(0.32, 0.34, 0.11, matTLHousing);
      tlH.name = 'tlHousing_' + (si < 0 ? 'L' : 'R');
      tlH.position.set(si * 0.71, cabBaseY + bedH * 0.56, bedZ + bedD * 0.5 + 0.04);
      g.add(tlH);

      var tlL = _box(0.20, 0.20, 0.07, matTLRed);
      tlL.name = 'tlLamp_' + (si < 0 ? 'L' : 'R');
      tlL.position.set(si * 0.71, cabBaseY + bedH * 0.62, bedZ + bedD * 0.5 + 0.06);
      g.add(tlL);

      var tlRev = _box(0.22, 0.07, 0.07, matTLWhite);
      tlRev.name = 'tlReverse_' + (si < 0 ? 'L' : 'R');
      tlRev.position.set(si * 0.71, cabBaseY + bedH * 0.24, bedZ + bedD * 0.5 + 0.06);
      g.add(tlRev);
    }

    /* High brake light bar across tailgate top */
    var brakebar = _box(CW * 0.68, 0.05, 0.07, matTLRed);
    brakebar.name = 'brakeBar';
    brakebar.position.set(0, cabBaseY + bedH * 0.95, bedZ + bedD * 0.5 + 0.05);
    g.add(brakebar);

    /* ══════════════════════════════════════════════════════════
       12. REAR END — bumper + step + tow hitch + exhaust tip
    ══════════════════════════════════════════════════════════ */

    /* Rear chrome bumper */
    var rBumper = _box(CW + 0.18, 0.14, 0.17, _MATS.chrome);
    rBumper.name = 'rearBumper';
    rBumper.position.set(0, cabBaseY + 0.22, CD * 0.5 + 0.07);
    g.add(rBumper);

    /* Skid step surface on bumper */
    var rStep = _box(CW * 0.58, 0.06, 0.24, matSkid);
    rStep.name = 'rearStep';
    rStep.position.set(0, cabBaseY + 0.14, CD * 0.5 + 0.11);
    g.add(rStep);

    /* Tow hitch receiver + ball */
    var hitchR = _box(0.19, 0.15, 0.32, matSkid);
    hitchR.name = 'hitchReceiver';
    hitchR.position.set(0, CH * 0.54, CD * 0.5 + 0.24);
    g.add(hitchR);

    var hitchBall = _cyl(0.065, 0.085, 0.13, 10, _MATS.chrome);
    hitchBall.name = 'hitchBall';
    hitchBall.position.set(0, CH * 0.36, CD * 0.5 + 0.38);
    g.add(hitchBall);

    /* Exhaust tip — right side exit */
    var exhaust = _cyl(0.055, 0.070, 0.24, 10, matSteel);
    exhaust.name = 'exhaustTip';
    exhaust.rotation.x = Math.PI * 0.5;
    exhaust.position.set(0.58, CH * 0.36, CD * 0.5 + 0.10);
    g.add(exhaust);

    /* ══════════════════════════════════════════════════════════
       13. FENDER FLARES — arch over each wheel well
    ══════════════════════════════════════════════════════════ */
    var flareW = 0.18;
    var wzList = [_CH.WHEEL_Z_FRONT, _CH.WHEEL_Z_REAR];

    for (var wi = 0; wi < wzList.length; wi++) {
      var wz = wzList[wi];
      for (var si = -1; si <= 1; si += 2) {
        var outerX = si * (_CH.WHEEL_X + _CH.WHEEL_W * 0.5 + flareW * 0.40);

        /* Vertical outer face of flare */
        var flareBody = _box(flareW, 0.24, _CH.WHEEL_W * 2.20, matFlatBlack);
        flareBody.name = 'flare_' + wi + '_' + (si < 0 ? 'L' : 'R');
        flareBody.position.set(outerX, _CH.WHEEL_R + 0.04, wz);
        g.add(flareBody);

        /* Horizontal top cap of flare */
        var flareTop = _box(flareW + 0.10, 0.06, _CH.WHEEL_W * 2.36, matFlatBlack);
        flareTop.name = 'flareTop_' + wi + '_' + (si < 0 ? 'L' : 'R');
        flareTop.position.set(outerX, _CH.WHEEL_R * 1.92, wz);
        g.add(flareTop);
      }
    }

    /* ══════════════════════════════════════════════════════════
       14. RUNNING BOARDS — step bars between wheel arches
    ══════════════════════════════════════════════════════════ */
    var rbLen = Math.abs(_CH.WHEEL_Z_REAR - _CH.WHEEL_Z_FRONT) + 0.36;
    var rbCz  = (_CH.WHEEL_Z_FRONT + _CH.WHEEL_Z_REAR) * 0.5;

    for (var si = -1; si <= 1; si += 2) {
      /* Step board surface */
      var rb = _box(0.24, 0.06, rbLen, matFlatBlack);
      rb.name = 'runningBoard_' + (si < 0 ? 'L' : 'R');
      rb.position.set(si * (CW * 0.5 + 0.09), cabBaseY - 0.08, rbCz);
      g.add(rb);

      /* Three support brackets */
      var bktOffsets = [-rbLen * 0.32, 0, rbLen * 0.32];
      for (var bi = 0; bi < 3; bi++) {
        var bkt = _box(0.18, 0.18, 0.06, matFlatBlack);
        bkt.name = 'rbBkt_' + (si < 0 ? 'L' : 'R') + '_' + bi;
        bkt.position.set(si * (CW * 0.5 + 0.09), cabBaseY - 0.14, rbCz + bktOffsets[bi]);
        g.add(bkt);
      }
    }

    /* ══════════════════════════════════════════════════════════
       15. WHEELS × 4 — tyre + sidewall ring + hub + rotor +
                        center cap + 6 lug bolts
    ══════════════════════════════════════════════════════════ */
    var wheelPositions = [
      { x: -_CH.WHEEL_X, z: _CH.WHEEL_Z_FRONT, name: 'wheel_FL' },
      { x:  _CH.WHEEL_X, z: _CH.WHEEL_Z_FRONT, name: 'wheel_FR' },
      { x: -_CH.WHEEL_X, z: _CH.WHEEL_Z_REAR,  name: 'wheel_RL' },
      { x:  _CH.WHEEL_X, z: _CH.WHEEL_Z_REAR,  name: 'wheel_RR' }
    ];

    var tyreGeo     = new THREE.CylinderGeometry(_CH.WHEEL_R, _CH.WHEEL_R, _CH.WHEEL_W, 22);
    var sidewallGeo = new THREE.CylinderGeometry(_CH.WHEEL_R * 0.87, _CH.WHEEL_R * 0.87, 0.04, 22);
    var hubGeo      = new THREE.CylinderGeometry(_CH.HUB_R, _CH.HUB_R, _CH.HUB_W + 0.02, 16);
    var rotorGeo    = new THREE.CylinderGeometry(_CH.HUB_R * 0.78, _CH.HUB_R * 0.78, 0.04, 16);
    var capGeo      = new THREE.CylinderGeometry(0.068, 0.068, 0.06, 12);
    var lugGeo      = new THREE.CylinderGeometry(0.022, 0.022, 0.08, 6);
    var matSidewall = new THREE.MeshLambertMaterial({ color: 0x242424 });
    var matLug      = new THREE.MeshLambertMaterial({ color: 0x888888 });

    for (var wi = 0; wi < wheelPositions.length; wi++) {
      var wp     = wheelPositions[wi];
      var wGroup = new THREE.Group();
      wGroup.name = wp.name;

      var outX = wp.x < 0 ? -1 : 1;   // outer direction sign

      /* Tyre body */
      var tyre = new THREE.Mesh(tyreGeo, _MATS.wheel);
      tyre.rotation.z = Math.PI / 2;
      tyre.castShadow = true;
      wGroup.add(tyre);

      /* Sidewall highlight ring — slightly recessed from tyre face */
      var sw = new THREE.Mesh(sidewallGeo, matSidewall);
      sw.rotation.z = Math.PI / 2;
      sw.position.x = outX * (_CH.WHEEL_W * 0.44);
      wGroup.add(sw);

      /* Hub disc */
      var hub = new THREE.Mesh(hubGeo, _MATS.hub);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = outX * (_CH.WHEEL_W * 0.5 + 0.01);
      wGroup.add(hub);

      /* Brake rotor (inner dark disc) */
      var rotor = new THREE.Mesh(rotorGeo, matRotor);
      rotor.rotation.z = Math.PI / 2;
      rotor.position.x = outX * (_CH.WHEEL_W * 0.38);
      wGroup.add(rotor);

      /* Center cap */
      var cap = new THREE.Mesh(capGeo, matCenter);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = outX * (_CH.WHEEL_W * 0.5 + 0.03);
      wGroup.add(cap);

      /* 6 lug bolts evenly spaced */
      for (var li = 0; li < 6; li++) {
        var la  = (li / 6) * Math.PI * 2;
        var lug = new THREE.Mesh(lugGeo, matLug);
        lug.rotation.z = Math.PI / 2;
        lug.position.set(
          outX * (_CH.WHEEL_W * 0.5 + 0.05),
          Math.sin(la) * 0.115,
          Math.cos(la) * 0.115
        );
        wGroup.add(lug);
      }

      wGroup.position.set(wp.x, _CH.WHEEL_R, wp.z);
      g.add(wGroup);
    }

    /* Expose named refs — required by main.js _syncVehicleMesh() */
    g.userData.wheelGroups = wheelPositions.map(function(wp) {
      return g.getObjectByName(wp.name);
    });

    g.castShadow = true;

    console.log('[VehicleFactory] Vehicle built — '
      + g.children.length + ' child objects.');

    return g;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     createCockpit()
     ────────────────
     Builds the in-cab FPV interior: dashboard + steering wheel + speedo.

     All positions are LOCAL to the vehicle's coordinate system.
     The FPVCamera.update() adds this group as a child of the vehicle group
     so it moves and rotates with the truck automatically.

     Named objects (accessed via userData refs):
       cockpit.userData.steeringWheel → THREE.Group  (rotates on Z for animation)
       cockpit.userData.speedNeedle   → THREE.Mesh   (rotates on Z for speedo)
       cockpit.userData.rpmNeedle     → THREE.Mesh   (decorative rpm needle)
  ═══════════════════════════════════════════════════════════════════════ */
  static createCockpit() {
    _ensureMats();

    var g = new THREE.Group();
    g.name = 'cockpit';

    /* ── Dashboard panel ── */
    var dash = _box(_CH.DASH_W, _CH.DASH_H, _CH.DASH_D, _MATS.dash);
    dash.name = 'dashboard';
    dash.position.set(0, _CH.DASH_Y, _CH.DASH_Z);
    g.add(dash);

    /* Dash accent top strip */
    var topStrip = _box(_CH.DASH_W, 0.04, _CH.DASH_D, _MATS.dashAccent);
    topStrip.position.set(0, _CH.DASH_Y + _CH.DASH_H * 0.5 + 0.02, _CH.DASH_Z);
    g.add(topStrip);

    /* Instrument cluster recess (darker box recessed into dash face) */
    var cluster = _box(0.60, 0.26, 0.06, new THREE.MeshLambertMaterial({ color: 0x0a0a0a }));
    cluster.position.set(-0.32, _CH.DASH_Y + 0.02, _CH.DASH_Z - _CH.DASH_D * 0.5 - 0.02);
    g.add(cluster);

    /* ── Gauge rings (two circles via TorusGeometry — speedo + rpm) ── */
    var gaugeRingGeo = new THREE.TorusGeometry(0.11, 0.012, 6, 24);
    var gaugeRingMat = new THREE.MeshLambertMaterial({ color: 0x555555 });

    /* Speedo bezel */
    var speedoBezel = new THREE.Mesh(gaugeRingGeo, gaugeRingMat);
    speedoBezel.position.set(-0.22, _CH.DASH_Y + 0.04, _CH.DASH_Z - _CH.DASH_D * 0.5 - 0.04);
    speedoBezel.rotation.x = Math.PI * 0.5;
    g.add(speedoBezel);

    /* RPM bezel */
    var rpmBezel = new THREE.Mesh(gaugeRingGeo, gaugeRingMat);
    rpmBezel.position.set(-0.44, _CH.DASH_Y + 0.04, _CH.DASH_Z - _CH.DASH_D * 0.5 - 0.04);
    rpmBezel.rotation.x = Math.PI * 0.5;
    g.add(rpmBezel);

    /* ── Speed needle (thin box, pivots on Y around gauge centre) ──
       Stored as userData so FPVCamera.animateNeedle() can rotate it. */
    var needleGeo = new THREE.BoxGeometry(0.015, 0.09, 0.008);
    var speedNeedle = new THREE.Mesh(needleGeo, _MATS.needle);
    speedNeedle.name = 'speedNeedle';
    /* Pivot at bottom of needle — translate origin to bottom */
    speedNeedle.geometry.translate(0, 0.045, 0);
    speedNeedle.position.set(-0.22, _CH.DASH_Y + 0.04, _CH.DASH_Z - _CH.DASH_D * 0.5 - 0.05);
    speedNeedle.rotation.x = Math.PI * 0.5;
    /* Start at full-left (empty gauge = −135° from top) */
    speedNeedle.rotation.z = (135 / 180) * Math.PI;
    g.add(speedNeedle);
    g.userData.speedNeedle = speedNeedle;

    /* ── RPM needle (decorative — sweeps with engine sound feel) ── */
    var rpmNeedle = new THREE.Mesh(needleGeo.clone(), _MATS.needle);
    rpmNeedle.name = 'rpmNeedle';
    rpmNeedle.geometry.translate(0, 0.045, 0);
    rpmNeedle.position.set(-0.44, _CH.DASH_Y + 0.04, _CH.DASH_Z - _CH.DASH_D * 0.5 - 0.05);
    rpmNeedle.rotation.x = Math.PI * 0.5;
    rpmNeedle.rotation.z = (135 / 180) * Math.PI;
    g.add(rpmNeedle);
    g.userData.rpmNeedle = rpmNeedle;

    /* ── Steering column (dark cylinder connecting wheel to dash) ── */
    var columnGeo = new THREE.CylinderGeometry(0.035, 0.04, 0.55, 8);
    var column = new THREE.Mesh(columnGeo, _MATS.dash);
    column.name = 'steeringColumn';
    column.position.set(0, _CH.STEER_Y - 0.22, _CH.STEER_Z + 0.05);
    column.rotation.x = _CH.STEER_TILT * 0.85;
    g.add(column);

    /* ── Steering wheel ──
       TorusGeometry for the wheel rim + 3 BoxGeometry spokes.
       Wrapped in a sub-group so FPVCamera.animateWheel() can rotate
       the whole group on its local Z axis without disturbing the column. */
    var wheelGroup = new THREE.Group();
    wheelGroup.name = 'steeringWheel';
    wheelGroup.position.set(0, _CH.STEER_Y, _CH.STEER_Z);
    wheelGroup.rotation.x = _CH.STEER_TILT;

    /* Rim */
    var rimGeo = new THREE.TorusGeometry(
      _CH.STEER_R, _CH.STEER_TUBE, 8, 28
    );
    var rim = new THREE.Mesh(rimGeo, _MATS.steer);
    rim.name = 'steeringRim';
    wheelGroup.add(rim);

    /* Centre boss */
    var bossGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.05, 10);
    var boss = new THREE.Mesh(bossGeo, _MATS.dash);
    boss.rotation.x = Math.PI * 0.5;
    wheelGroup.add(boss);

    /* 3 spokes */
    for (var si = 0; si < 3; si++) {
      var spokeAngle = (si / 3) * Math.PI * 2 + Math.PI * 0.5;
      var spokeLen   = _CH.STEER_R - 0.07;
      var spoke = _box(0.025, spokeLen, 0.022, _MATS.steer);
      /* Pivot: spoke extends from centre outward */
      spoke.geometry.translate(0, spokeLen * 0.5, 0);
      spoke.rotation.z = spokeAngle;
      wheelGroup.add(spoke);
    }

    g.add(wheelGroup);
    g.userData.steeringWheel = wheelGroup;

    /* ── Interior trim — A-pillar bars (left + right) ── */
    for (var side = -1; side <= 1; side += 2) {
      var pillar = _box(0.05, 0.75, 0.05, _MATS.dash);
      pillar.name = 'pillar_' + (side < 0 ? 'L' : 'R');
      pillar.position.set(side * 0.88, 0.75, -0.80);
      pillar.rotation.z = side * 0.12;
      g.add(pillar);
    }

    /* ── Radio / centre console ── */
    var console_ = _box(0.22, 0.18, _CH.DASH_D, _MATS.dashAccent);
    console_.position.set(0.38, _CH.DASH_Y - 0.06, _CH.DASH_Z);
    g.add(console_);

    /* Radio face with two tiny button rows */
    var radioFace = _box(0.18, 0.10, 0.04, _MATS.dash);
    radioFace.position.set(0.38, _CH.DASH_Y - 0.04, _CH.DASH_Z - _CH.DASH_D * 0.5 - 0.02);
    g.add(radioFace);

    console.log('[VehicleFactory] Cockpit built.');
    return g;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     createDriver()
     ────────────────
     Seated storm chaser figure. Added as a child of the vehicle group,
     visible only in external (third-person) view.

     Anatomy (Cylinder + Box + Sphere — no CapsuleGeometry):
       head     — SphereGeometry with helmet overlay
       torso    — BoxGeometry in chaser jumpsuit
       upperArms— CylinderGeometry left + right
       foreArms — CylinderGeometry (hands on steering wheel position)
       thighs   — CylinderGeometry (horizontal, knees up in seat)
       shins    — CylinderGeometry (vertical, feet at floor)

     Origin is at the seat reference point (vehicle local coordinates).
  ═══════════════════════════════════════════════════════════════════════ */
  static createDriver() {
    _ensureMats();

    var g = new THREE.Group();
    g.name = 'driver';

    /* Seat position: slightly left of vehicle centre, at seat level */
    var seatX = -0.28;
    var seatY = _CH.SEATED_TORSO_Y - 0.20;
    var seatZ = -0.12;

    /* ── Torso ── */
    var torso = _box(_CH.TORSO_W, _CH.TORSO_H, _CH.TORSO_D, _MATS.suit);
    torso.name = 'torso';
    torso.position.set(seatX, seatY + _CH.TORSO_H * 0.5, seatZ);
    g.add(torso);

    /* ── Head ── */
    var head = _sphere(_CH.HEAD_R, 8, 7, _MATS.skin);
    head.name = 'head';
    head.position.set(seatX, seatY + _CH.TORSO_H + _CH.HEAD_R * 0.85, seatZ);
    g.add(head);

    /* Helmet (slightly larger sphere half-overlay) */
    var helmetGeo = new THREE.SphereGeometry(
      _CH.HEAD_R + 0.04, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.65
    );
    var helmet = new THREE.Mesh(helmetGeo, _MATS.helmet);
    helmet.position.copy(head.position);
    g.add(helmet);

    /* ── Upper arms (angled toward steering wheel) ── */
    for (var side = -1; side <= 1; side += 2) {
      var uArm = _cyl(_CH.LIMB_R * 0.85, _CH.LIMB_R, _CH.ARM_H * 0.55, 6, _MATS.suit);
      uArm.name = 'upperArm_' + (side < 0 ? 'L' : 'R');
      uArm.position.set(
        seatX + side * (_CH.TORSO_W * 0.55),
        seatY + _CH.TORSO_H * 0.72,
        seatZ - 0.08
      );
      /* Angled inward and forward toward wheel */
      uArm.rotation.z = side * 0.55;
      uArm.rotation.x = -0.35;
      g.add(uArm);
    }

    /* ── Forearms (reaching toward steering wheel position) ── */
    for (var side = -1; side <= 1; side += 2) {
      var fArm = _cyl(_CH.LIMB_R * 0.75, _CH.LIMB_R * 0.85, _CH.ARM_H * 0.48, 6, _MATS.skin);
      fArm.name = 'foreArm_' + (side < 0 ? 'L' : 'R');
      fArm.position.set(
        seatX + side * (_CH.TORSO_W * 0.30),
        seatY + _CH.TORSO_H * 0.52,
        seatZ - 0.35
      );
      fArm.rotation.z = side * 0.20;
      fArm.rotation.x = -0.60;
      g.add(fArm);
    }

    /* ── Thighs (horizontal forward, knees up) ── */
    for (var side = -1; side <= 1; side += 2) {
      var thigh = _cyl(_CH.LIMB_R, _CH.LIMB_R, _CH.LEG_H * 0.55, 7, _MATS.suit);
      thigh.name = 'thigh_' + (side < 0 ? 'L' : 'R');
      thigh.position.set(
        seatX + side * 0.14,
        seatY + 0.08,
        seatZ + _CH.LEG_H * 0.20
      );
      thigh.rotation.x = Math.PI * 0.5;
      g.add(thigh);
    }

    /* ── Shins + boots ── */
    for (var side = -1; side <= 1; side += 2) {
      var shin = _cyl(_CH.LIMB_R * 0.85, _CH.LIMB_R, _CH.LEG_H * 0.45, 7, _MATS.suit);
      shin.name = 'shin_' + (side < 0 ? 'L' : 'R');
      shin.position.set(
        seatX + side * 0.14,
        seatY - _CH.LEG_H * 0.22,
        seatZ + _CH.LEG_H * 0.50
      );
      g.add(shin);

      var boot = _box(0.14, 0.10, 0.22, _MATS.boot);
      boot.name = 'boot_' + (side < 0 ? 'L' : 'R');
      boot.position.set(
        seatX + side * 0.14,
        seatY - _CH.LEG_H * 0.44,
        seatZ + _CH.LEG_H * 0.52
      );
      g.add(boot);
    }

    console.log('[VehicleFactory] Driver built.');
    return g;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     createWalker()
     ────────────────
     Standing storm chaser. Used in on-foot mode.
     Hidden at startup; shown when player exits the vehicle.

     Named userData refs exposed for leg animation:
       walker.userData.legL  → THREE.Group (left leg pivot)
       walker.userData.legR  → THREE.Group (right leg pivot)
       walker.userData.armL  → THREE.Group (left arm swing)
       walker.userData.armR  → THREE.Group (right arm swing)

     Origin: feet at Y = 0 (caller adds HeightAt offset each frame).
  ═══════════════════════════════════════════════════════════════════════ */
  static createWalker() {
    _ensureMats();

    var g = new THREE.Group();
    g.name = 'walker';
    g.visible = false;   // hidden until player exits vehicle

    var rootY = 0;   // feet at Y = 0, everything built upward

    /* ── Boots ── */
    for (var side = -1; side <= 1; side += 2) {
      var boot = _box(0.15, 0.12, 0.26, _MATS.boot);
      boot.name = 'walkerBoot_' + (side < 0 ? 'L' : 'R');
      boot.position.set(side * 0.14, rootY + 0.06, 0.04);
      g.add(boot);
    }

    /* ── Leg groups (pivot at hip for animation) ──
       Each leg group contains shin + thigh; pivot point = hip height. */
    var hipY = rootY + _CH.LEG_H;   // hip height above feet

    /* Left leg */
    var legGroupL = new THREE.Group();
    legGroupL.name = 'legGroupL';
    legGroupL.position.set(-0.14, hipY, 0);
    {
      var thighL = _cyl(_CH.LIMB_R, _CH.LIMB_R, _CH.LEG_H * 0.52, 7, _MATS.suit);
      thighL.position.set(0, -_CH.LEG_H * 0.26, 0);
      legGroupL.add(thighL);
      var shinL = _cyl(_CH.LIMB_R * 0.85, _CH.LIMB_R, _CH.LEG_H * 0.44, 7, _MATS.suit);
      shinL.position.set(0, -_CH.LEG_H * 0.74, 0);
      legGroupL.add(shinL);
    }
    g.add(legGroupL);
    g.userData.legL = legGroupL;

    /* Right leg */
    var legGroupR = new THREE.Group();
    legGroupR.name = 'legGroupR';
    legGroupR.position.set(0.14, hipY, 0);
    {
      var thighR = _cyl(_CH.LIMB_R, _CH.LIMB_R, _CH.LEG_H * 0.52, 7, _MATS.suit);
      thighR.position.set(0, -_CH.LEG_H * 0.26, 0);
      legGroupR.add(thighR);
      var shinR = _cyl(_CH.LIMB_R * 0.85, _CH.LIMB_R, _CH.LEG_H * 0.44, 7, _MATS.suit);
      shinR.position.set(0, -_CH.LEG_H * 0.74, 0);
      legGroupR.add(shinR);
    }
    g.add(legGroupR);
    g.userData.legR = legGroupR;

    /* ── Torso ── */
    var torso = _box(_CH.TORSO_W, _CH.TORSO_H, _CH.TORSO_D, _MATS.suit);
    torso.name = 'walkerTorso';
    torso.position.set(0, hipY + _CH.TORSO_H * 0.5, 0);
    torso.castShadow = true;
    g.add(torso);

    /* ── Arm groups (pivot at shoulder, swing fore-aft for walk) ── */
    var shoulderY = hipY + _CH.TORSO_H - 0.06;

    /* Left arm */
    var armGroupL = new THREE.Group();
    armGroupL.name = 'armGroupL';
    armGroupL.position.set(-(_CH.TORSO_W * 0.5 + 0.04), shoulderY, 0);
    {
      var uArmL = _cyl(_CH.LIMB_R, _CH.LIMB_R, _CH.ARM_H * 0.52, 6, _MATS.suit);
      uArmL.position.set(0, -_CH.ARM_H * 0.26, 0);
      armGroupL.add(uArmL);
      var fArmL = _cyl(_CH.LIMB_R * 0.8, _CH.LIMB_R, _CH.ARM_H * 0.44, 6, _MATS.skin);
      fArmL.position.set(0, -_CH.ARM_H * 0.76, 0);
      armGroupL.add(fArmL);
    }
    g.add(armGroupL);
    g.userData.armL = armGroupL;

    /* Right arm */
    var armGroupR = new THREE.Group();
    armGroupR.name = 'armGroupR';
    armGroupR.position.set((_CH.TORSO_W * 0.5 + 0.04), shoulderY, 0);
    {
      var uArmR = _cyl(_CH.LIMB_R, _CH.LIMB_R, _CH.ARM_H * 0.52, 6, _MATS.suit);
      uArmR.position.set(0, -_CH.ARM_H * 0.26, 0);
      armGroupR.add(uArmR);
      var fArmR = _cyl(_CH.LIMB_R * 0.8, _CH.LIMB_R, _CH.ARM_H * 0.44, 6, _MATS.skin);
      fArmR.position.set(0, -_CH.ARM_H * 0.76, 0);
      armGroupR.add(fArmR);
    }
    g.add(armGroupR);
    g.userData.armR = armGroupR;

    /* ── Head ── */
    var head = _sphere(_CH.HEAD_R, 8, 7, _MATS.skin);
    head.name = 'walkerHead';
    head.position.set(0, shoulderY + _CH.HEAD_R * 1.08, 0);
    g.add(head);

    /* Helmet */
    var helmetGeo = new THREE.SphereGeometry(
      _CH.HEAD_R + 0.04, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.65
    );
    var helmetMesh = new THREE.Mesh(helmetGeo, _MATS.helmet);
    helmetMesh.position.copy(head.position);
    g.add(helmetMesh);

    /* ── Backpack / equipment pack ── */
    var pack = _box(0.20, 0.30, 0.12, _MATS.dashAccent);
    pack.name = 'pack';
    pack.position.set(0, hipY + _CH.TORSO_H * 0.45, _CH.TORSO_D * 0.5 + 0.07);
    g.add(pack);

    console.log('[VehicleFactory] Walker built.');
    return g;
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.FPVCamera
   ─────────────
   First-person view: camera sits inside the cab at the driver's eye point.
   Heading tracks physics.heading exactly (no lerp — rigid cab immersion).
   Head-bob adds small Y oscillation based on speed.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.FPVCamera = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(camera)
     camera : THREE.PerspectiveCamera — the scene's main camera
  ───────────────────────────────────────────────────────────────────── */
  constructor(camera) {
    if (!camera) {
      console.error('[FPVCamera] camera is required.');
      return;
    }

    this._camera    = camera;
    this._bobTime   = 0;       // accumulated time for head-bob phase
    this._steerAngle = 0;      // current smoothed steering wheel rotation

    /* Temp vectors — reused every frame to avoid GC churn */
    this._eyePos = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt, physics)
     Called every frame when inVehicle = true.

     dt      : delta time (seconds, capped)
     physics : HE.PhysicsEngine — reads .pos, .heading, .speedKmh

     Positions the camera at the driver's eye point inside the cab,
     oriented along the vehicle heading. Head-bob modulates Y slightly
     with vehicle speed so the driver experience feels kinetic.
  ═══════════════════════════════════════════════════════════════════════ */
  update(dt, physics) {
    if (!this._camera || !physics) return;

    var pos      = physics.pos;
    var heading  = physics.heading;
    var speedKmh = physics.speedKmh;

    /* ── Head-bob ──
       Advance bob phase proportional to speed (faster = more sway).
       Amplitude is fixed; only the rate scales with speed. */
    var bobFreq    = _CH.FPV_BOB_FREQ * HE.MathUtils.clamp(speedKmh / 60, 0.1, 1.0);
    this._bobTime += dt * bobFreq;
    var bobY       = Math.sin(this._bobTime * Math.PI * 2) * _CH.FPV_BOB_AMP;

    /* ── Eye position ── (vehicle local → world, accounting for +PI mesh rotation)
       The vehicle mesh is rotated by heading + PI, so:
         local -Z (hood)  → world +Z  (forward = sinH,cosH direction)
         local -X (left)  → world +X  (right of vehicle = cosH direction)
       Driver sits LEFT in the cab (local -X) = world +cosH direction.

       Derivation — local driver seat at (-SEAT_X, EYE_H, -EYE_Z) transforms to:
         world_x_offset = SEAT_X*cosH + EYE_Z*sinH
         world_z_offset = EYE_Z*cosH  - SEAT_X*sinH               */
    var sinH = Math.sin(heading);
    var cosH = Math.cos(heading);

    var sX = _CH.FPV_SEAT_X;
    var eZ = _CH.FPV_EYE_Z;

    this._eyePos.set(
      pos.x + sX * cosH + eZ * sinH,
      pos.y + _CH.FPV_EYE_Y + bobY,
      pos.z + eZ * cosH  - sX * sinH
    );

    this._camera.position.copy(this._eyePos);

    /* ── Look direction ──
       Aim at a point on the road 18 units ahead, 0.5 wu above physics Y.
       This gives a ~4° downward look — road visible, sky fills top half. */
    this._lookAt.set(
      pos.x + sinH * 18,
      pos.y + 0.50,
      pos.z + cosH * 18
    );

    this._camera.lookAt(this._lookAt);
  }


  /* ═══════════════════════════════════════════════════════════════════════
     animateWheel(dt, steeringWheel, keys)
     Rotates the steering wheel mesh in response to A/D key input.
     Uses a smooth exponential approach so the wheel doesn't snap.

     dt            : delta time
     steeringWheel : THREE.Group (cockpit.userData.steeringWheel)
     keys          : physics.keys — { [code]: bool }
  ═══════════════════════════════════════════════════════════════════════ */
  animateWheel(dt, steeringWheel, keys) {
    if (!steeringWheel) return;

    /* Target rotation: ±40° based on which key is held */
    var targetAngle = 0;
    if (keys && (keys['KeyA'] || keys['ArrowLeft']))  targetAngle =  0.70;  // rad left
    if (keys && (keys['KeyD'] || keys['ArrowRight'])) targetAngle = -0.70;  // rad right

    /* Smooth lerp toward target — wheel takes ~0.2s to reach full lock */
    var lerpRate    = 1 - Math.exp(-dt * 8.0);
    this._steerAngle = HE.MathUtils.lerp(this._steerAngle, targetAngle, lerpRate);

    /* Apply rotation around the wheel's local Z axis (normal to wheel face) */
    steeringWheel.rotation.z = this._steerAngle;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     animateNeedle(speedNeedle, kmh)
     Maps vehicle speed (0..100 km/h) to speedo needle rotation.

     The needle sweeps from −135° (0 km/h) to +135° (100 km/h)
     around the gauge centre on the local Z axis.

     speedNeedle : THREE.Mesh (cockpit.userData.speedNeedle)
     kmh         : Number — current speed in km/h
  ═══════════════════════════════════════════════════════════════════════ */
  animateNeedle(speedNeedle, kmh) {
    if (!speedNeedle) return;

    /* Map 0..100 km/h to −135°..+135° in radians */
    var t     = HE.MathUtils.clamp(kmh / 100, 0, 1);
    var angle = HE.MathUtils.lerp(
      (135 / 180) * Math.PI,   // empty (left stop)
     -(135 / 180) * Math.PI,   // full (right stop)
      t
    );

    speedNeedle.rotation.z = angle;
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.ThirdPersonCamera
   ─────────────────────
   Smooth follow camera used in both external vehicle view and on-foot mode.
   Sits behind and above the target, always looking at a point 1.5 wu above
   the target centre. Uses exponential lerp so it floats naturally.
   ═══════════════════════════════════════════════════════════════════════════ */

HE.ThirdPersonCamera = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(camera)
     camera : THREE.PerspectiveCamera — the scene's main camera
  ───────────────────────────────────────────────────────────────────── */
  constructor(camera) {
    if (!camera) {
      console.error('[ThirdPersonCamera] camera is required.');
      return;
    }

    this._camera = camera;

    /* Smoothed ideal position — lerped toward each frame */
    this._smoothPos = new THREE.Vector3();

    /* Temp vectors — no GC per frame */
    this._idealPos  = new THREE.Vector3();
    this._lookTarget = new THREE.Vector3();

    /* Flag: first frame should snap (no lerp from origin) */
    this._firstFrame = true;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt, pos, heading, heightFn)
     Called every frame from main.js._loop() when not in FPV.

     dt        : delta time (seconds, capped)
     pos       : THREE.Vector3 — vehicle or walker world position
     heading   : Number (radians) — facing direction
     heightFn  : (x, z) → Number — terrain height function
  ═══════════════════════════════════════════════════════════════════════ */
  update(dt, pos, heading, heightFn) {
    if (!this._camera || !pos) return;

    var sinH = Math.sin(heading);
    var cosH = Math.cos(heading);

    /* ── Ideal camera position ──
       Offset: BEHIND the vehicle (along -heading direction), UP. */
    this._idealPos.set(
      pos.x - sinH * _CH.TPC_BEHIND,
      pos.y + _CH.TPC_UP,
      pos.z - cosH * _CH.TPC_BEHIND
    );

    /* ── Terrain clearance — prevent camera clipping into hills ── */
    if (typeof heightFn === 'function') {
      var groundY = heightFn(this._idealPos.x, this._idealPos.z);
      var minY    = groundY + _CH.TPC_MIN_CLEAR;
      if (this._idealPos.y < minY) {
        this._idealPos.y = minY;
      }
    }

    /* ── Exponential lerp toward ideal position ──
       lerpRate: fraction to close each frame.
       At 60fps with rate 8: closes ~87% in 0.16s — feels snappy but smooth. */
    if (this._firstFrame) {
      this._smoothPos.copy(this._idealPos);
      this._firstFrame = false;
    } else {
      var lerpFrac = 1 - Math.exp(-_CH.TPC_LERP_RATE * dt);
      this._smoothPos.lerp(this._idealPos, lerpFrac);
    }

    this._camera.position.copy(this._smoothPos);

    /* ── Look target: 1.5 wu above vehicle/walker centre ── */
    this._lookTarget.set(
      pos.x,
      pos.y + _CH.TPC_TARGET_Y,
      pos.z
    );

    this._camera.lookAt(this._lookTarget);
  }


  /* ── Reset smooth position (call when switching from FPV → TPC) ── */
  snapTo(pos, heading) {
    if (!pos) return;
    var sinH = Math.sin(heading || 0);
    var cosH = Math.cos(heading || 0);
    this._smoothPos.set(
      pos.x - sinH * _CH.TPC_BEHIND,
      pos.y + _CH.TPC_UP,
      pos.z - cosH * _CH.TPC_BEHIND
    );
    this._firstFrame = false;
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   HE.Walker
   ──────────
   On-foot player controller.
   Reads physics.keys (set by PhysicsEngine.bindKeys()) for WASD input.
   Updates walkerMesh world position + heading, snaps to terrain, and drives
   limb animation on the walker GROUP userData refs.

   Walker does NOT emit events; main.js reads walker.pos + walker.heading
   to decide proximity-to-vehicle (enter range check).
   ═══════════════════════════════════════════════════════════════════════════ */

HE.Walker = class {

  /* ─────────────────────────────────────────────────────────────────────
     constructor(walkerMesh, scene, bus)
     walkerMesh : THREE.Group from VehicleFactory.createWalker()
     scene      : THREE.Scene — mesh will be added here
     bus        : HE.EventBus — optional, reserved for future events
  ───────────────────────────────────────────────────────────────────── */
  constructor(walkerMesh, scene, bus) {
    if (!walkerMesh || !scene) {
      console.error('[Walker] walkerMesh and scene are required.');
      return;
    }

    this._mesh   = walkerMesh;
    this._scene  = scene;
    this._bus    = bus || null;

    /* ── World state ── */
    this._pos     = new THREE.Vector3(0, 0, 0);
    this._heading = 0;    // radians

    /* ── Animation state ── */
    this._walkTime    = 0;    // accumulated time for limb oscillation
    this._moveSpeed   = 0;    // current frame speed (for bob amplitude)
    this._bobOffset   = 0;    // current vertical bob amount

    /* ── Lift / suction state ── */
    // main.js calls applyLift() when walker enters the funnel pull zone.
    // While _lifted = true, terrain-snap is bypassed and Y integrates upward.
    this._liftVel  = 0;
    this._lifted   = false;

    /* ── Limb refs (from walkerMesh.userData) ── */
    this._legL = walkerMesh.userData.legL || null;
    this._legR = walkerMesh.userData.legR || null;
    this._armL = walkerMesh.userData.armL || null;
    this._armR = walkerMesh.userData.armR || null;

    /* Mesh not added to scene yet — caller controls visibility + add */
    console.log('[Walker] Ready.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     activate(pos, heading)
     Show the walker at the given world position. Called by main.js when
     the player exits the vehicle.

     pos     : THREE.Vector3 — spawn position (vehicle left side)
     heading : Number (radians) — inherited from vehicle heading
  ═══════════════════════════════════════════════════════════════════════ */
  activate(pos, heading) {
    this._pos.copy(pos);
    this._heading = heading;
    this._mesh.visible = true;

    /* Immediately position the mesh */
    this._applyMeshTransform();

    console.log('[Walker] Activated at (' + pos.x.toFixed(1)
      + ', ' + pos.z.toFixed(1) + ')');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     deactivate()
     Hide the walker. Called by main.js when player re-enters vehicle.
  ═══════════════════════════════════════════════════════════════════════ */
  deactivate() {
    this._mesh.visible = false;
    this._moveSpeed    = 0;
    console.log('[Walker] Deactivated.');
  }


  /* ═══════════════════════════════════════════════════════════════════════
     update(dt, keys, heightFn)
     Per-frame locomotion tick. Called by main.js when on foot.

     dt        : delta time (seconds, capped to 0.05)
     keys      : physics.keys — { [code]: bool }
     heightFn  : (x, z) → Number — terrain height function

     Sub-systems in order:
       1. Heading intent  — A/D steer
       2. Move intent     — W/S forward/back
       3. Integrate pos   — translate along heading
       4. Terrain snap    — Y = heightFn(x,z)
       5. Limb animation  — sinusoidal leg/arm swing
       6. Body bob        — slight vertical oscillation while moving
       7. Mesh transform  — apply pos + heading to THREE.Group
  ═══════════════════════════════════════════════════════════════════════ */
  update(dt, keys, heightFn) {
    if (!this._mesh || !this._mesh.visible) return;

    var safeDt = Math.min(dt, 0.05);

    /* ── 1. Heading intent ── */
    var steer = 0;
    if (keys['KeyA'] || keys['ArrowLeft'])  steer =  1;
    if (keys['KeyD'] || keys['ArrowRight']) steer = -1;

    if (steer !== 0) {
      this._heading += steer * _CH.WALK_STEER_RATE * safeDt;
      this._heading = HE.MathUtils.wrapAngle(this._heading);
    }

    /* ── 2. Move intent — forward/back (no sideways strafe — keep controls simple) ── */
    var accel = 0;
    if (keys['KeyW'] || keys['ArrowUp'])   accel =  1;
    if (keys['KeyS'] || keys['ArrowDown']) accel = -1;

    var speed = accel * (accel >= 0 ? _CH.WALK_SPEED_FWD : _CH.WALK_SPEED_FWD * 0.7);
    this._moveSpeed = Math.abs(speed);

    /* ── 3. Integrate position ── */
    if (accel !== 0) {
      var sinH = Math.sin(this._heading);
      var cosH = Math.cos(this._heading);
      this._pos.x += sinH * speed * safeDt;
      this._pos.z += cosH * speed * safeDt;
    }

    /* ── 4. Terrain snap — bypassed while being sucked up ── */
    if (this._lifted) {
      this._pos.y += this._liftVel * safeDt;
      this._liftVel *= Math.pow(0.986, safeDt * 60);
    } else {
      if (typeof heightFn === 'function') {
        this._pos.y = heightFn(this._pos.x, this._pos.z);
      }
      this._liftVel = 0;
    }

    /* ── 5 + 6. Limb animation + body bob ── */
    this._animateLimbs(safeDt);

    /* ── 7. Apply to mesh ── */
    this._applyMeshTransform();
  }


  /* ─────────────────────────────────────────────────────────────────────
     _animateLimbs(dt)
     Sinusoidal leg + arm swing proportional to movement speed.
     Legs swing fore-aft (X rotation); arms counter-swing.
     Body bob is a simple Y offset on the root group.
  ───────────────────────────────────────────────────────────────────── */
  _animateLimbs(dt) {
    /* Advance walk cycle time proportional to movement speed */
    var cycleRate = HE.MathUtils.clamp(this._moveSpeed / _CH.WALK_SPEED_FWD, 0, 1);
    this._walkTime += dt * cycleRate * _CH.WALK_BOB_FREQ;

    var phase   = this._walkTime * Math.PI * 2;
    var swing   = Math.sin(phase) * _CH.LEG_SWING_AMP * cycleRate;
    var armSwing = swing * 0.65;    // arms swing slightly less than legs

    /* Legs: opposite phases (left forward when right back) */
    if (this._legL) this._legL.rotation.x =  swing;
    if (this._legR) this._legR.rotation.x = -swing;

    /* Arms: counter-swing (left arm forward when right leg forward) */
    if (this._armL) this._armL.rotation.x = -armSwing;
    if (this._armR) this._armR.rotation.x =  armSwing;

    /* Body bob: small Y sway at twice the leg frequency */
    this._bobOffset = Math.abs(Math.sin(phase)) * _CH.WALK_BOB_AMP * cycleRate;
  }


  /* ─────────────────────────────────────────────────────────────────────
     _applyMeshTransform()
     Writes current _pos + _heading + _bobOffset to the walker mesh.
     Called after every state change so the mesh always reflects internal state.
  ───────────────────────────────────────────────────────────────────── */
  _applyMeshTransform() {
    this._mesh.position.set(
      this._pos.x,
      this._pos.y + this._bobOffset,
      this._pos.z
    );

    /* Heading: walker faces along +Z when heading = 0.
       Three.js default: model faces -Z, so rotate Y by (heading + π). */
    this._mesh.rotation.y = this._heading + Math.PI;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     READ-ONLY GETTERS  — read by main.js for enter-range check + TPC target
  ═══════════════════════════════════════════════════════════════════════ */

  /** Current world position (live ref — do not mutate) */
  get pos()     { return this._pos; }

  /** Current facing direction in radians */
  get heading() { return this._heading; }

  /** Whether the walker mesh is currently active */
  get active()  { return this._mesh ? this._mesh.visible : false; }

  /** True while walker is floating off the ground */
  get lifted()  { return this._lifted; }

  /* Push walker position directly (wind / suction impulse in wu/frame) */
  applyImpulse(ix, iz) {
    this._pos.x += ix;
    this._pos.z += iz;
  }

  /* Trigger upward lift — vel in world units/s */
  applyLift(vel) {
    this._liftVel = Math.max(this._liftVel, vel);
    if (vel > 0.1) this._lifted = true;
  }

  /* Cancel lift, return to ground mode */
  cancelLift() {
    this._lifted  = false;
    this._liftVel = 0;
  }


  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP
  ═══════════════════════════════════════════════════════════════════════ */
  dispose() {
    this._mesh    = null;
    this._scene   = null;
    this._bus     = null;
    this._legL = this._legR = this._armL = this._armR = null;
    console.log('[Walker] Disposed.');
  }

};
