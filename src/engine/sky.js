// Wick Engine sky: the dome shader (gradient, sun, moon, stars, clouds), the sun and moon lights, fog, and the
// day/night cycle. Everything is derived from the Lighting service.
// Clouds depend on the graphics tier (TIERS[n].clouds): 3 = full volumetric raymarch with light marching, 2 = lite
// volumetric (fewer steps, no light marching), 1 = a flat cloud layer painted on the dome that only imitates volume.

const B = globalThis.BABYLON;

const clamp01 = (n) => Math.min(1, Math.max(0, n));
/** Smoothstep that also works with a > b, so smooth(0, -0.2, x) rises as x falls. */
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Colour ramp over sun elevation: stops are [elevation, [r, g, b]] in ascending order, blended with smoothstep. */
function ramp(stops, e) {
  if (e <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (e <= stops[i][0]) return mix(stops[i - 1][1], stops[i][1], smooth(stops[i - 1][0], stops[i][0], e));
  }
  return stops[stops.length - 1][1];
}

const ZENITH = [[-0.2, [0.004, 0.008, 0.028]], [-0.05, [0.04, 0.05, 0.14]], [0.08, [0.17, 0.27, 0.58]], [0.35, [0.18, 0.4, 0.82]], [0.7, [0.14, 0.35, 0.8]]];
const HORIZON = [[-0.2, [0.015, 0.025, 0.06]], [-0.06, [0.16, 0.1, 0.18]], [0.0, [0.85, 0.38, 0.22]], [0.12, [0.98, 0.66, 0.42]], [0.35, [0.78, 0.84, 0.93]], [0.7, [0.62, 0.78, 0.96]]];
const SUN_COLOR = [[0, [1, 0.4, 0.15]], [0.12, [1, 0.65, 0.35]], [0.4, [1, 0.95, 0.85]]];
const AMBIENT = [[-0.2, [0.09, 0.12, 0.28]], [-0.02, [0.3, 0.25, 0.4]], [0.15, [0.62, 0.6, 0.7]], [0.5, [0.78, 0.86, 1]]];
const GROUND_AMBIENT = [[-0.1, [0.05, 0.05, 0.08]], [0.3, [0.34, 0.3, 0.26]]];
const MOON_COLOR = [0.45, 0.55, 0.9];

B.Effect.ShadersStore.wickSkyVertexShader = `
  precision highp float;
  attribute vec3 position;
  uniform mat4 worldViewProjection;
  varying vec3 vDir;
  void main() { vDir = position; gl_Position = worldViewProjection * vec4(position, 1.0); }`;

B.Effect.ShadersStore.wickSkyFragmentShader = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground;
  uniform vec3 sunDir; uniform vec3 sunColor; uniform vec3 moonDir;
  uniform float starAmt; uniform float sunGlow;
  uniform vec3 camPos; uniform float time; uniform vec2 drift;
  uniform float cloudMode; uniform float coverage; uniform float cdensity; uniform float cbase;
  uniform vec3 lightDir; uniform vec3 lightColor; uniform vec3 cloudAmbient;

  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float noise3(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x), mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x), mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  float fbm2(vec3 p) { return 0.62 * noise3(p) + 0.38 * noise3(p * 2.07 + vec3(1.7, 9.2, 3.1)); }
  float fbm4(vec3 p) {
    float a = 0.5; float s = 0.0;
    for (int i = 0; i < 4; i++) { s += a * noise3(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return s / 0.9375;
  }
  float threshold() { return mix(0.8, 0.3, coverage); }

  // Cloud density at a world position; h is the 0..1 height inside the cloud slab.
  float cloudDensity(vec3 p, float h) {
    vec3 q = (p + vec3(drift.x, 0.0, drift.y)) * 0.0042;
    float base = cloudMode > 2.5 ? fbm4(q) : fbm2(q);
    float t0 = threshold();
    float shape = smoothstep(t0, t0 + 0.26, base);
    float profile = smoothstep(0.0, 0.18, h) * (1.0 - smoothstep(0.55, 1.0, h));
    return shape * profile * cdensity;
  }

  void main() {
    vec3 d = normalize(vDir);
    vec3 c = d.y > 0.0 ? mix(horizon, zenith, pow(d.y, 0.5)) : mix(horizon, ground, min(1.0, -d.y * 4.0));
    float s = max(dot(d, normalize(sunDir)), 0.0);
    float horizonness = 1.0 - smoothstep(0.0, 0.5, abs(sunDir.y));
    c += sunColor * (pow(s, 1800.0) * 8.0 + pow(s, 40.0) * 0.35 + pow(s, 5.0) * sunGlow * horizonness * 0.35);

    // Stars and moon
    if (starAmt > 0.01 && d.y > -0.05) {
      vec3 sd = d * 230.0; vec3 id = floor(sd); vec3 f = fract(sd) - 0.5; float hs = hash13(id);
      if (hs > 0.9965) {
        float tw = 0.6 + 0.4 * sin(time * (1.0 + hs * 8.0) + hs * 100.0);
        c += vec3(0.85, 0.9, 1.0) * (1.0 - smoothstep(0.0, 0.28, length(f))) * tw * starAmt * (0.4 + hs * 0.6);
      }
      float m = dot(d, normalize(moonDir));
      float disc = smoothstep(0.99935, 0.9997, m);
      float shade = 0.82 + 0.18 * noise3(d * 38.0);
      c += (vec3(0.86, 0.9, 1.0) * disc * shade * 1.4 + vec3(0.35, 0.45, 0.75) * pow(max(m, 0.0), 60.0) * 0.25) * starAmt;
    }

    // Clouds, composited over everything above (so they hide the sun, moon and stars behind them)
    if (cloudMode > 0.5 && d.y > 0.012) {
      float fade = smoothstep(0.012, 0.16, d.y);
      float cosL = dot(d, normalize(lightDir));
      float phase = (0.6975 / pow(1.3025 - 1.1 * cosL, 1.5)) * 0.08 + 0.55;
      if (cloudMode < 1.5) {
        float t = (cbase - camPos.y) / d.y;
        if (t > 0.0) {
          vec3 p = camPos + d * t;
          vec3 uv = vec3((p.xz + drift) * 0.0042, time * 0.004);
          float n = fbm2(uv);
          float t0 = threshold();
          float dens = smoothstep(t0, t0 + 0.26, n) * cdensity;
          float n2 = fbm2(uv + vec3(lightDir.xz * 0.06, 0.0));
          float lit = clamp(0.7 + (n - n2) * 4.0, 0.25, 1.1);
          vec3 cc = cloudAmbient * 0.85 + lightColor * lit * 0.75 * phase;
          c = mix(c, cc, clamp(dens * 1.15, 0.0, 0.95) * fade);
        }
      } else {
        float thick = cbase * 0.55;
        float h0 = cbase; float h1 = cbase + thick;
        float t0 = (h0 - camPos.y) / d.y; float t1 = (h1 - camPos.y) / d.y;
        float tn = max(min(t0, t1), 0.0); float tf = min(max(t0, t1), 9000.0);
        if (tf > tn) {
          float steps = cloudMode > 2.5 ? 26.0 : 10.0;
          float dt = (tf - tn) / steps;
          float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
          float T = 1.0; vec3 acc = vec3(0.0);
          for (int i = 0; i < 26; i++) {
            if (float(i) >= steps) break;
            vec3 p = camPos + d * (tn + (float(i) + jitter) * dt);
            float h = (p.y - h0) / thick;
            float dens = cloudDensity(p, h);
            if (dens > 0.003) {
              float light = 0.35 + 0.65 * h;
              if (cloudMode > 2.5) {
                float l = 0.0;
                for (int k = 1; k <= 3; k++) { vec3 lp = p + normalize(lightDir) * float(k) * thick * 0.14; l += cloudDensity(lp, (lp.y - h0) / thick); }
                light = exp(-l * 1.7);
              }
              vec3 scat = cloudAmbient * (0.5 + 0.5 * (1.0 - h)) + lightColor * light * phase;
              float a = 1.0 - exp(-dens * dt * 0.034);
              acc += T * a * scat;
              T *= 1.0 - a;
              if (T < 0.03) break;
            }
          }
          c = mix(c, c * T + acc, fade);
        }
      }
    }

    // Soft shoulder instead of a hard clip, since tone mapping is applied per material and not to the sky.
    vec3 over = max(c - 0.85, 0.0);
    c = min(c, vec3(0.85)) + (1.0 - exp(-over * 6.0)) * 0.15;
    gl_FragColor = vec4(c, 1.0);
  }`;

export class WickSky {
  constructor(world) {
    this.world = world;
    const scene = world.scene;
    this.cloudMode = 1;
    this.time = 0;
    this.drift = [0, 0];
    this._cycleAcc = 0;
    this._reflectAcc = 0;

    this.sun = new B.DirectionalLight('wick-sun', new B.Vector3(-0.4, -1, 0.35), scene);
    this.sun.autoCalcShadowZBounds = true;
    this.moon = new B.DirectionalLight('wick-moon', new B.Vector3(0.4, -1, -0.3), scene);
    this.moon.diffuse = B.Color3.FromArray(MOON_COLOR);
    this.moon.specular = B.Color3.FromArray(MOON_COLOR);
    this.hemi = new B.HemisphericLight('wick-ambient', new B.Vector3(0, 1, 0), scene);

    this.material = new B.ShaderMaterial('wick-sky', scene, { vertex: 'wickSky', fragment: 'wickSky' }, {
      attributes: ['position'],
      uniforms: ['worldViewProjection', 'zenith', 'horizon', 'ground', 'sunDir', 'sunColor', 'moonDir', 'starAmt', 'sunGlow', 'camPos', 'time', 'drift',
        'cloudMode', 'coverage', 'cdensity', 'cbase', 'lightDir', 'lightColor', 'cloudAmbient'],
    });
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    this.mesh = B.MeshBuilder.CreateSphere('wick-sky', { diameter: 1000, segments: 16 }, scene);
    this.mesh.material = this.material;
    this.mesh.infiniteDistance = true;
    this.mesh.isPickable = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    scene.fogMode = B.Scene.FOGMODE_EXP2;
    this.sunHeight = 1;
    this.apply(false);
  }

  /** Cloud quality for a graphics tier (TIERS[n].clouds). */
  setTier(tier) {
    this.cloudMode = tier.clouds;
    this.apply(false);
  }

  /** Wind as the grass shader and the cloud drift read it. */
  get wind() {
    const L = this.world.dm.lighting.props, a = (L.WindDirection * Math.PI) / 180;
    return { dir: [Math.sin(a), Math.cos(a)], strength: L.WindStrength, time: this.time };
  }

  /** Recomputes sun, moon, ambient light, fog and sky colours from the Lighting service. */
  apply(refreshReflections = true) {
    const L = this.world.dm.lighting.props;
    const th = ((L.ClockTime - 6) / 12) * Math.PI; // 0 at 06:00, PI at 18:00
    const e = Math.sin(th);
    this.sunHeight = e;
    const toSun = new B.Vector3(-Math.cos(th), e, -0.35).normalize();
    const toMoon = new B.Vector3(Math.cos(th) * 0.95, -e, 0.3).normalize();
    const dayAmt = smooth(-0.02, 0.3, e), nightAmt = smooth(0.02, 0.3, -e);
    const cloudy = L.CloudsEnabled ? 1 - 0.22 * L.CloudCoverage * L.CloudDensity : 1;

    const sunCol = ramp(SUN_COLOR, e);
    this.sun.direction = toSun.scale(-1);
    this.sun.intensity = L.Brightness * 2.2 * dayAmt * cloudy;
    this.sun.diffuse = B.Color3.FromArray(sunCol);
    this.sun.specular = this.sun.diffuse;
    this.moon.direction = toMoon.scale(-1);
    this.moon.intensity = L.Brightness * 0.5 * nightAmt;
    this.hemi.intensity = 0.2 + 0.5 * dayAmt;
    this.hemi.diffuse = B.Color3.FromArray(ramp(AMBIENT, e));
    this.hemi.groundColor = B.Color3.FromArray(ramp(GROUND_AMBIENT, e));

    const horizon = ramp(HORIZON, e), zenith = ramp(ZENITH, e);
    const m = this.material;
    m.setColor3('zenith', B.Color3.FromArray(zenith));
    m.setColor3('horizon', B.Color3.FromArray(horizon));
    m.setColor3('ground', B.Color3.FromArray(mix(horizon, [0.02, 0.02, 0.03], 0.7)));
    m.setVector3('sunDir', toSun);
    m.setColor3('sunColor', B.Color3.FromArray(sunCol).scale(smooth(-0.06, 0.0, e)));
    m.setVector3('moonDir', toMoon);
    m.setFloat('starAmt', smooth(0.0, -0.2, e) * (1 - 0.5 * (L.CloudsEnabled ? L.CloudCoverage : 0)));
    m.setFloat('sunGlow', 1);
    m.setVector3('lightDir', dayAmt >= nightAmt ? toSun : toMoon);
    m.setColor3('lightColor', B.Color3.FromArray(sunCol.map((v, i) => v * dayAmt + MOON_COLOR[i] * 0.3 * nightAmt)));
    m.setColor3('cloudAmbient', B.Color3.FromArray(ramp(AMBIENT, e).map((v) => v * (0.35 + 0.65 * Math.max(dayAmt, 0.15)))));
    m.setFloat('cloudMode', L.CloudsEnabled ? this.cloudMode : 0);
    m.setFloat('coverage', L.CloudCoverage);
    m.setFloat('cdensity', 0.35 + 0.9 * L.CloudDensity);
    m.setFloat('cbase', L.CloudHeight);

    const scene = this.world.scene;
    scene.fogColor = B.Color3.FromArray(horizon.map((v) => v * 0.92));
    scene.fogDensity = L.FogDensity;

    this.world.onSunChanged();
    if (refreshReflections) this.world.reflections?.invalidateSky();
  }

  /** Once per frame: clock for the shader, cloud drift with the wind, and the day/night cycle while a game runs. */
  update(dt, running) {
    const L = this.world.dm.lighting.props;
    this.time += dt;
    const w = this.wind, speed = w.strength * 30;
    this.drift[0] += w.dir[0] * speed * dt;
    this.drift[1] += w.dir[1] * speed * dt;
    const m = this.material;
    m.setFloat('time', this.time);
    m.setVector2('drift', new B.Vector2(this.drift[0], this.drift[1]));
    m.setVector3('camPos', this.world.camera.position);
    if (running && L.DayLength > 0) {
      L.ClockTime = (L.ClockTime + (dt * 24) / L.DayLength) % 24; // written directly: the project is restored on Stop
      this._cycleAcc += dt;
      this._reflectAcc += dt;
      if (this._cycleAcc > 0.05) { this._cycleAcc = 0; this.apply(false); }
      if (this._reflectAcc > 1) { this._reflectAcc = 0; this.world.reflections?.invalidateSky(); }
    }
  }
}
