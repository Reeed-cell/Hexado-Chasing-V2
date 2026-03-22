/* ═══════════════════════════════════════════════════════════════════════════
   3DEngine.js  —  HEXADO CHASING v2.0
   Layer   : Foundation (load order: 4th — after main-math.js)
   Exports : window.HexEngine.Engine
   Deps    : Three.js r128  (must be loaded before this file)
   ═══════════════════════════════════════════════════════════════════════════

   Responsibility
   ──────────────
   Owns the Three.js primitives that every other module borrows:
     • WebGLRenderer  (shadow maps, tone-mapping, pixel ratio cap)
     • PerspectiveCamera  (75° FOV, near 0.15, far 1400)
     • Scene  (background sky colour, exponential fog)
     • Lighting rig  (hemisphere + sun DirectionalLight + soft fill)
     • Window-resize handler (keeps aspect + renderer size in sync)

   Public API
   ──────────
     engine = new HE.Engine()
     const { scene, camera, renderer } = engine.init(canvas)

   Called exclusively by Render.js — never by main.js directly.
   ═══════════════════════════════════════════════════════════════════════════ */

var HE = window.HexEngine = window.HexEngine || {};


HE.Engine = class {

  constructor() {
    /* Filled by init(). Exposed so callers can read them directly
       via engine.scene / engine.camera / engine.renderer if needed. */
    this.scene    = null;
    this.camera   = null;
    this.renderer = null;

    /* Store sun ref so Render.js can tint it during storm build-up. */
    this._sun = null;

    /* Bound resize so we can cleanly remove it in dispose(). */
    this._onResize = this._handleResize.bind(this);
  }

  /* ───────────────────────────────────────────────────────────────────────
     init(canvas)
     Wires everything, runs one resize pass, and returns the three
     core Three.js objects that every downstream module needs.
     canvas : HTMLCanvasElement  (#canvas in index.html)
  ─────────────────────────────────────────────────────────────────────── */
  init(canvas) {
    this._buildRenderer(canvas);
    this._buildScene();
    this._buildCamera();
    this._buildLights();
    this._attachResizeHandler();

    /* Correct aspect ratio + renderer size from frame 0. */
    this._handleResize();

    console.log('[3DEngine] Ready — Three.js r' + THREE.REVISION);

    return {
      scene:    this.scene,
      camera:   this.camera,
      renderer: this.renderer
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     RENDERER
  ═══════════════════════════════════════════════════════════════════════ */

  _buildRenderer(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas:          canvas,
      antialias:       true,
      powerPreference: 'high-performance'
    });

    /* PCFSoft shadows — smooth penumbras for the directional sun. */
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type    = THREE.PCFSoftShadowMap;

    /* ACESFilmic tone-mapping pairs well with the amber HUD colour palette. */
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    /* sRGB output — correct for Three.js r128 linear pipeline. */
    this.renderer.outputEncoding = THREE.sRGBEncoding;

    /* Cap device pixel ratio at 2: retina quality without perf cliff. */
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    /* Actual pixel dimensions set by _handleResize(). */
  }

  /* ═══════════════════════════════════════════════════════════════════════
     SCENE  —  Sky background + exponential fog
  ═══════════════════════════════════════════════════════════════════════ */

  _buildScene() {
    this.scene = new THREE.Scene();

    /* Overcast Oklahoma sky — dusty blue-grey. Render.js darkens this
       toward a sickly green-grey as storm intensity rises. */
    this.scene.background = new THREE.Color(0x7aa0c0);

    /* FogExp2: density 0.0045 shows ~200m of terrain cleanly.
       Render.js bumps density to ~0.010 at EF5 for wall-of-rain effect. */
    this.scene.fog = new THREE.FogExp2(0x8aacbf, 0.0045);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CAMERA
  ═══════════════════════════════════════════════════════════════════════ */

  _buildCamera() {
    /* 75° vFOV — immersive inside the cab without fisheye distortion.
       Near 0.15 keeps dashboard geometry from z-clipping.
       Far 1400 covers the full terrain chunk + distant storm funnel.  */
    this.camera = new THREE.PerspectiveCamera(
      75,    // vFOV degrees
      1.0,   // aspect — corrected immediately in _handleResize()
      0.15,  // near clip
      1400   // far clip
    );

    /* Safe default: slightly behind & above road origin, looking south.
       Characters.js / Render.js take over from frame 1, but this
       prevents a one-frame black flash on slower machines. */
    this.camera.position.set(0, 3.5, 12);
    this.camera.lookAt(0, 1.2, 0);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     LIGHTING — Three-light rig for Oklahoma daytime plains
     ─────────────────────────────────────────────────────────────────────
     1. HemisphereLight  — warm amber sky dome + brown-grey ground bounce
     2. DirectionalLight — main sun, golden-hour angle, casts shadows
     3. DirectionalLight — soft north fill, no shadows, lifts dark edges
  ═══════════════════════════════════════════════════════════════════════ */

  _buildLights() {

    /* ── 1. Hemisphere ambient ──────────────────────────────────────── */
    var hemi = new THREE.HemisphereLight(
      0xfff4d6,  // sky colour  — slightly yellow/amber
      0x6b5a3e,  // ground bounce — dry Oklahoma dirt
      0.65       // intensity
    );
    hemi.name = 'hemi';
    this.scene.add(hemi);

    /* ── 2. Sun (shadow-casting directional) ────────────────────────── */
    var sun = new THREE.DirectionalLight(0xfff0cc, 1.15);
    sun.name = 'sun';

    /* Low afternoon south-east angle — long shadows toward the player. */
    sun.position.set(80, 120, 60);
    sun.castShadow = true;

    /* Shadow frustum just covers the visible road + terrain strip.
       Keeping it tight maximises shadow texel density. */
    sun.shadow.camera.left   = -160;
    sun.shadow.camera.right  =  160;
    sun.shadow.camera.top    =  160;
    sun.shadow.camera.bottom = -160;
    sun.shadow.camera.near   =  10;
    sun.shadow.camera.far    = 450;

    /* 2048² shadow map: sharp enough for vehicle silhouette, VRAM-safe. */
    sun.shadow.mapSize.width  = 2048;
    sun.shadow.mapSize.height = 2048;

    /* Small negative bias prevents shadow acne on the flat terrain. */
    sun.shadow.bias = -0.0006;

    this.scene.add(sun);
    this.scene.add(sun.target);  /* target stays at (0,0,0) — road origin */
    this._sun = sun;             /* stored for Render.js tint access */

    /* ── 3. Soft fill (no shadows) ──────────────────────────────────── */
    var fill = new THREE.DirectionalLight(0xc8d8ff, 0.28);
    fill.name = 'fill';
    fill.position.set(-60, 40, -80);  /* north-west, opposite the sun */
    this.scene.add(fill);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     RESIZE HANDLER
  ═══════════════════════════════════════════════════════════════════════ */

  _attachResizeHandler() {
    window.addEventListener('resize', this._onResize, { passive: true });
  }

  _handleResize() {
    var w = window.innerWidth;
    var h = window.innerHeight;

    if (this.camera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    if (this.renderer) {
      this.renderer.setSize(w, h);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CLEANUP  — call if tearing down the engine (e.g. hot-reload dev flow)
  ═══════════════════════════════════════════════════════════════════════ */

  dispose() {
    window.removeEventListener('resize', this._onResize);

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }

    /* Scene geometry/material disposal is Render.js's responsibility. */
    this.scene  = null;
    this.camera = null;
    this._sun   = null;
  }

  /* ─────────────────────────────────────────────────────────────────────
     READ-ONLY ACCESSORS  (Render.js uses these to animate storm lighting)
  ───────────────────────────────────────────────────────────────────── */

  get sun()      { return this._sun; }
  get fogRef()   { return this.scene ? this.scene.fog : null; }

};
