/* ═══════════════════════════════════════════════════════════════════════════
   main-math.js  —  HEXADO CHASING v2.0
   Layer   : Foundation (load order: 3rd — after eventbus.js)
   Exports : window.HexEngine.VortexMath
             window.HexEngine.Noise
             window.HexEngine.MathUtils
   Deps    : none  (NO Three.js, NO DOM)
   ═══════════════════════════════════════════════════════════════════════════ */

var HE = window.HexEngine = window.HexEngine || {};


/* ═══════════════════════════════════════════════════════════════════════════
   NOISE  —  Value noise + multi-octave fBm
   Used by TerrainGen.heightAt() and weather turbulence
   ═══════════════════════════════════════════════════════════════════════════ */

HE.Noise = (function () {

  /* --- 256-entry permutation table (seeded, reproducible) --- */
  var _perm = new Uint8Array(512);

  (function _buildPerm() {
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;

    /* Knuth shuffle with fixed seed so terrain is deterministic */
    var seed = 42317;
    for (var i = 255; i > 0; i--) {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      var j = (seed >>> 0) % (i + 1);
      var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
    }
    for (var i = 0; i < 512; i++) _perm[i] = p[i & 255];
  })();

  /* Fade curve: 6t^5 - 15t^4 + 10t^3  (Ken Perlin's improved quintic) */
  function _fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  function _lerp(a, b, t) { return a + t * (b - a); }

  /* Gradient 1-D hash to slope +/-1 */
  function _grad1(hash, x) {
    return (hash & 1) ? x : -x;
  }

  /* Gradient 2-D — 8 directions */
  function _grad2(hash, x, y) {
    var h = hash & 7;
    var u = h < 4 ? x : y;
    var v = h < 4 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }

  /* Public API */
  return {

    /* Classic 1-D Perlin noise, output ~ -1..+1 */
    perlin1: function(x) {
      var X  = Math.floor(x) & 255;
      x -= Math.floor(x);
      var u  = _fade(x);
      var a  = _perm[X];
      var b  = _perm[X + 1];
      return _lerp(_grad1(a, x), _grad1(b, x - 1), u);
    },

    /* Classic 2-D Perlin noise, output ~ -1..+1 */
    perlin2: function(x, y) {
      var X  = Math.floor(x) & 255;
      var Y  = Math.floor(y) & 255;
      x -= Math.floor(x);
      y -= Math.floor(y);
      var u  = _fade(x);
      var v  = _fade(y);
      var aa = _perm[_perm[X    ] + Y    ];
      var ab = _perm[_perm[X    ] + Y + 1];
      var ba = _perm[_perm[X + 1] + Y    ];
      var bb = _perm[_perm[X + 1] + Y + 1];
      return _lerp(
        _lerp(_grad2(aa, x    , y    ), _grad2(ba, x - 1, y    ), u),
        _lerp(_grad2(ab, x    , y - 1), _grad2(bb, x - 1, y - 1), u),
        v
      );
    },

    /* Fractional Brownian Motion — multi-octave noise
       octaves : number of layers (4-6 typical for terrain)
       freq    : base frequency
       amp     : base amplitude
       Returns normalised sum ~ -1..+1                         */
    fbm2: function(x, y, octaves, freq, amp) {
      octaves = octaves || 4;
      freq    = freq    || 1.0;
      amp     = amp     || 1.0;
      var val     = 0;
      var maxVal  = 0;
      var curFreq = freq;
      var curAmp  = amp;
      for (var i = 0; i < octaves; i++) {
        val    += this.perlin2(x * curFreq, y * curFreq) * curAmp;
        maxVal += curAmp;
        curFreq *= 2.0;
        curAmp  *= 0.5;
      }
      return val / maxVal;
    },

    /* Smooth value noise — hash-based, cheaper than Perlin */
    value2: function(x, y) {
      var ix = Math.floor(x) & 255;
      var iy = Math.floor(y) & 255;
      var fx = x - Math.floor(x);
      var fy = y - Math.floor(y);
      var ux = _fade(fx);
      var uy = _fade(fy);

      var v00 = _perm[_perm[ix    ] + iy    ] / 255;
      var v10 = _perm[_perm[ix + 1] + iy    ] / 255;
      var v01 = _perm[_perm[ix    ] + iy + 1] / 255;
      var v11 = _perm[_perm[ix + 1] + iy + 1] / 255;

      return _lerp(_lerp(v00, v10, ux), _lerp(v01, v11, ux), uy);
    }

  };

})();


/* ═══════════════════════════════════════════════════════════════════════════
   MATH UTILS  —  Scalar helpers used across all modules
   ═══════════════════════════════════════════════════════════════════════════ */

HE.MathUtils = {

  lerp: function(a, b, t) { return a + (b - a) * t; },

  smoothstep: function(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  },

  smootherstep: function(edge0, edge1, x) {
    var t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * t * (t * (t * 6 - 15) + 10);
  },

  clamp: function(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); },

  remap: function(v, inMin, inMax, outMin, outMax) {
    var t = (v - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
  },

  wrapAngle: function(a) {
    while (a >  Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  },

  angleDiff: function(a, b) {
    return this.wrapAngle(b - a);
  },

  atan2: function(dx, dz) {
    return Math.atan2(dx, dz);
  },

  dist2: function(ax, az, bx, bz) {
    var dx = bx - ax, dz = bz - az;
    return Math.sqrt(dx * dx + dz * dz);
  },

  dist3: function(ax, ay, az, bx, by, bz) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },

  randRange: function(min, max) {
    return min + Math.random() * (max - min);
  },

  randInt: function(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  },

  /* Map 0..1 intensity to EF scale 0-5 */
  efScale: function(intensity) {
    return Math.min(5, Math.floor(intensity * 6));
  }

};


/* ═══════════════════════════════════════════════════════════════════════════
   VORTEX MATH  —  Tornado aerodynamics, debris spirals, world-wind
   ═══════════════════════════════════════════════════════════════════════════ */

HE.VortexMath = class {

  constructor() {

    /* Maximum tangential wind speed (m/s) at EF5 intensity */
    this.V_MAX       = 85.0;

    /* Core radius (world units): solid-body inner region of Rankine vortex */
    this.RC_MAX      = 18.0;
    this.RC_MIN      =  2.0;

    /* Radial inflow coefficient — controls suction toward center */
    this.INFLOW_K    = 0.18;

    /* Vertical updraft speed coefficient */
    this.UPDRAFT_K   = 0.35;

    /* Outer influence radius (beyond this wind ~ 0) */
    this.R_OUTER     = 220.0;

    /* Debris helix pitch (world units per full revolution) */
    this.HELIX_PITCH = 14.0;

    /* Mutable state */
    this._intensity  = 0.0;
    this._rc         = this.RC_MIN;
    this._vMax       = 0.0;
  }

  /* ─────────────────────────────────────────────
     setIntensity(t)
     t : 0..1  (from WeatherSystem.intensity)
     Recomputes derived parameters so all
     subsequent calls use consistent scaling.
  ───────────────────────────────────────────── */
  setIntensity(t) {
    t = HE.MathUtils.clamp(t, 0, 1);
    this._intensity = t;
    /* Core radius grows with storm power */
    this._rc   = HE.MathUtils.lerp(this.RC_MIN, this.RC_MAX, t);
    /* Max wind speed on a smooth cubic curve for EF feel */
    this._vMax = this.V_MAX * t * t * (3 - 2 * t);
  }

  /* ─────────────────────────────────────────────
     cylindrical(r, z)
     Rankine combined-vortex velocity field.

     r : radial distance from tornado axis (>= 0)
     z : height above ground (world units)

     Returns { vTheta, vR, vZ }
       vTheta : tangential (CCW positive)
       vR     : radial inflow (negative = inward)
       vZ     : vertical updraft (positive = up)
  ───────────────────────────────────────────── */
  cylindrical(r, z) {
    var rc   = this._rc;
    var vMax = this._vMax;
    var r0   = Math.max(r, 0.001);

    var vTheta, vR, vZ;

    if (r0 <= rc) {
      /* Solid-body inner core: vTheta increases linearly with r */
      vTheta = vMax * (r0 / rc);
      vR     = -this.INFLOW_K * vMax * (r0 / rc) * 0.4;
    } else {
      /* Free vortex outer region: vTheta = vMax * rc / r */
      vTheta = vMax * rc / r0;
      vR     = -this.INFLOW_K * vMax * (rc / r0);

      if (r0 > this.R_OUTER) {
        vTheta = 0;
        vR     = 0;
      } else if (r0 > this.R_OUTER * 0.7) {
        var blend = 1 - HE.MathUtils.smoothstep(
          this.R_OUTER * 0.7, this.R_OUTER, r0
        );
        vTheta *= blend;
        vR     *= blend;
      }
    }

    /* Updraft — strongest at axis, exponential decay with r */
    var zNorm = HE.MathUtils.clamp(z / 60, 0, 1);
    vZ = this.UPDRAFT_K * vMax * Math.exp(-r0 / (rc * 3)) * (1 - zNorm);

    return { vTheta: vTheta, vR: vR, vZ: vZ };
  }

  /* ─────────────────────────────────────────────
     worldWind(dx, dz)
     Converts cylindrical velocity to world-space
     XZ wind vector for a point offset from centre.

     dx, dz : signed world offsets from tornado
     Returns { x, z } wind impulse vector
             (multiply by dt in caller)
  ───────────────────────────────────────────── */
  worldWind(dx, dz) {
    var r = Math.sqrt(dx * dx + dz * dz);
    if (r < 0.001) return { x: 0, z: 0 };

    /* Unit vectors in cylindrical frame:
       radial    : (dx/r, dz/r)   — outward from axis
       tangential: (-dz/r, dx/r)  — CCW perpendicular  */
    var rHatX =  dx / r;
    var rHatZ =  dz / r;
    var tHatX = -dz / r;
    var tHatZ =  dx / r;

    /* Sample at ground level for horizontal forces */
    var vel = this.cylindrical(r, 0);

    return {
      x: tHatX * vel.vTheta + rHatX * vel.vR,
      z: tHatZ * vel.vTheta + rHatZ * vel.vR
    };
  }

  /* ─────────────────────────────────────────────
     spiralPos(i, total, h, t)
     Debris particle position on helical spiral.

     i     : particle index
     total : total particle count
     h     : max height of debris column
     t     : animation time (seconds)

     Returns { x, y, z } relative to tornado centre
  ───────────────────────────────────────────── */
  spiralPos(i, total, h, t) {
    var frac   = i / total;
    var rc     = this._rc;

    /* Radius shrinks as debris rises — funnel narrows at top */
    var rMax   = rc * HE.MathUtils.lerp(2.8, 0.6, frac);

    /* Phase offset so particles are evenly distributed */
    var phase  = frac * Math.PI * 2 * (total / 3.0);

    /* Angular velocity scales with intensity */
    var omega  = HE.MathUtils.lerp(0.6, 3.5, this._intensity);

    /* Radius wobble for turbulent look */
    var rWobble = rMax * (1 + 0.18 * Math.sin(phase * 3.1 + t * 1.7));

    var angle  = omega * t + phase;
    var x = Math.cos(angle) * rWobble;
    var z = Math.sin(angle) * rWobble;

    /* Helix drift: particles rise up the column */
    var yDrift = (t * HE.MathUtils.lerp(2, 8, this._intensity) + frac * h) % h;

    return { x: x, y: yDrift, z: z };
  }

  /* ─────────────────────────────────────────────
     funnelRadius(normH)
     Shape of funnel at normalised height
     (0 = ground, 1 = cloud base).
     Used by Tornado.js to build funnel rings.
  ───────────────────────────────────────────── */
  funnelRadius(normH) {
    /* Classic concave tornado profile — wide at top, rope at ground */
    return this._rc * (0.32 + 2.6 * Math.pow(1 - normH, 2.2));
  }

  /* ─────────────────────────────────────────────
     turbulence(x, z, t)
     Low-frequency noise wind outside main vortex.
     Makes driving feel alive even far from tornado.
     Returns { x, z } ambient wind vector.
  ───────────────────────────────────────────── */
  turbulence(x, z, t) {
    var freq  = 0.003;
    var scale = HE.MathUtils.lerp(0.4, 3.0, this._intensity);
    var nx = HE.Noise.perlin2(x * freq + t * 0.11, z * freq) * scale;
    var nz = HE.Noise.perlin2(x * freq, z * freq + t * 0.09) * scale;
    return { x: nx, z: nz };
  }

  /* Read-only getters */
  get intensity()  { return this._intensity; }
  get coreRadius() { return this._rc; }
  get maxWind()    { return this._vMax; }

};
