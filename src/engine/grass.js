// Wick Engine grass: real blades on Grass-material Blocks (High and Medium graphics).
// Blades are thin instances of one small mesh, built in 8-stud cells around the camera and swayed by the wind in the
// vertex shader, so a whole field is one draw call. High draws long three-segment blades densely; Medium draws
// shorter one-triangle blades, fewer of them, nearer to the camera. Other tiers draw none (the grass texture remains).

const B = globalThis.BABYLON;

const CELL = 8; // studs
const MAX_BLADES = 70000;
const REBUILD_MS = 120;

B.Effect.ShadersStore.wickGrassVertexShader = `
  precision highp float;
  attribute vec3 position;
  attribute vec4 world0; attribute vec4 world1; attribute vec4 world2; attribute vec4 world3;
  uniform mat4 partWorld; uniform mat4 viewProjection;
  uniform float time; uniform vec2 windDir; uniform float windStrength; uniform vec3 camPos; uniform float radius;
  varying float vH; varying float vShade; varying float vDist;
  void main() {
    mat4 w = partWorld * mat4(world0, world1, world2, world3);
    vec4 wp = w * vec4(position, 1.0);
    vec3 base = (w * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float h = position.y;
    float along = dot(base.xz, windDir);
    float ph = along * 0.18 + time * (1.2 + windStrength * 2.5) + base.x * 0.31;
    float gust = 0.5 + 0.5 * sin(time * 0.7 + along * 0.05);
    float sway = sin(ph) * 0.6 + sin(ph * 2.3 + base.z) * 0.4;
    float amp = windStrength * (0.12 + 0.28 * gust) + 0.03;
    vec2 off = (windDir * (sway * 0.5 + 0.5 * gust) + vec2(-windDir.y, windDir.x) * sway * 0.35) * amp * h * h * 1.6;
    wp.xz += off;
    wp.y -= length(off) * h * 0.35;
    float dist = length(base.xz - camPos.xz);
    float fade = 1.0 - smoothstep(radius * 0.7, radius, dist);
    wp.xyz = mix(base, wp.xyz, fade);
    vH = h;
    vShade = fract(sin(dot(base.xz, vec2(12.9898, 78.233))) * 43758.5453);
    vDist = distance(wp.xyz, camPos);
    gl_Position = viewProjection * wp;
  }`;

B.Effect.ShadersStore.wickGrassFragmentShader = `
  precision highp float;
  varying float vH; varying float vShade; varying float vDist;
  uniform vec3 tint; uniform vec3 lightColor; uniform vec3 ambient; uniform vec3 fogColor; uniform float fogDensity;
  void main() {
    vec3 root = vec3(0.09, 0.19, 0.045); vec3 tip = vec3(0.42, 0.62, 0.17);
    vec3 dry = vec3(0.55, 0.52, 0.2);
    vec3 albedo = mix(root, mix(tip, dry, step(0.82, vShade) * 0.6), vH) * tint * (0.6 + 0.4 * vShade);
    vec3 c = albedo * (ambient + lightColor * (0.55 + 0.45 * vH));
    c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14); // same filmic curve the PBR materials use
    float f = 1.0 - exp(-pow(fogDensity * vDist, 2.0));
    gl_FragColor = vec4(mix(c, fogColor, clamp(f, 0.0, 1.0)), 1.0);
  }`;

const hash = (a, b, c) => {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One blade: `segments` quads narrowing to a tip. Height runs 0..1 along Y, width +-0.5 along X. */
function bladeMesh(segments, scene) {
  const positions = [], indices = [];
  for (let k = 0; k <= segments; k++) {
    const y = k / segments, w = 0.5 * (1 - y * 0.92);
    positions.push(-w, y, 0, w, y, 0);
  }
  for (let k = 0; k < segments; k++) {
    const a = k * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const mesh = new B.Mesh('wick-blade', scene);
  const vd = new B.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.applyToMesh(mesh);
  return mesh;
}

export class WickGrass {
  constructor(world) {
    this.world = world;
    this.tier = null; // { radius, density, segments } or null
    this.fields = new Map(); // part id -> field
    this._last = 0;
  }

  setTier(config) {
    this.tier = config ?? null;
    for (const f of this.fields.values()) this._dispose(f);
    this.fields.clear();
    if (!this.tier) return;
    for (const [id, mesh] of this.world.meshes) {
      const inst = this.world.dm.find(id);
      if (inst) this.attach(inst, mesh);
    }
  }

  static wants(inst) {
    const p = inst.props;
    return p.Material === 'Grass' && p.Shape === 'Block' && p.Texture !== 'wick://textures/void' && p.Transparency < 0.5;
  }

  /** Called when a Part's mesh exists or one of its look properties changed. */
  attach(inst, mesh) {
    this.detach(inst.id);
    if (!this.tier || !WickGrass.wants(inst)) return;
    const mat = new B.ShaderMaterial(`wick-grass-${inst.id}`, this.world.scene, { vertex: 'wickGrass', fragment: 'wickGrass' }, {
      attributes: ['position', 'world0', 'world1', 'world2', 'world3'],
      uniforms: ['partWorld', 'viewProjection', 'time', 'windDir', 'windStrength', 'camPos', 'radius', 'tint', 'lightColor', 'ambient', 'fogColor', 'fogDensity'],
    });
    mat.backFaceCulling = false;
    const blade = bladeMesh(this.tier.segments, this.world.scene);
    blade.material = mat;
    blade.isPickable = false;
    blade.alwaysSelectAsActiveMesh = true;
    blade.setEnabled(false);
    this.fields.set(inst.id, { inst, mesh, blade, mat, cells: new Map(), key: '', count: 0 });
    this._last = 0; // build right away
  }

  detach(id) {
    const f = this.fields.get(id);
    if (f) { this._dispose(f); this.fields.delete(id); }
  }

  _dispose(f) {
    f.blade.dispose();
    f.mat.dispose();
  }

  dispose() {
    this.setTier(null);
  }

  /** Blades for one cell, as 4x4 matrices. Matrices are relative to the Part so the field follows it. */
  _cell(f, cx, cz) {
    const k = `${cx},${cz}`;
    let m = f.cells.get(k);
    if (m) return m;
    const [sx, sy, sz] = f.inst.props.Size;
    const x0 = Math.max(cx * CELL, -sx / 2), x1 = Math.min((cx + 1) * CELL, sx / 2);
    const z0 = Math.max(cz * CELL, -sz / 2), z1 = Math.min((cz + 1) * CELL, sz / 2);
    const area = Math.max(0, x1 - x0) * Math.max(0, z1 - z0);
    const n = Math.round(area * this.tier.density);
    m = new Float32Array(n * 16);
    const rand = rng(Math.floor(hash(f.inst.id, cx, cz) * 4294967296));
    for (let i = 0; i < n; i++) {
      const lx = x0 + rand() * (x1 - x0), lz = z0 + rand() * (z1 - z0);
      const a = rand() * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const wx = 0.1 + rand() * 0.07, wy = this.tier.height * (0.55 + rand() * 0.75);
      const o = i * 16;
      // (blade scale * rotation) with the Part's scale divided out, then the base position in unit coordinates
      m[o] = (wx * c) / sx; m[o + 2] = (-wx * s) / sz;
      m[o + 5] = wy / sy;
      m[o + 8] = s / sx; m[o + 10] = c / sz;
      m[o + 12] = lx / sx; m[o + 13] = 0.5; m[o + 14] = lz / sz; m[o + 15] = 1;
    }
    f.cells.set(k, m);
    return m;
  }

  _rebuild(f) {
    const [sx, sy, sz] = f.inst.props.Size;
    const inv = f.mesh.getWorldMatrix().clone().invert();
    const cam = B.Vector3.TransformCoordinates(this.world.camera.position, inv);
    const px = cam.x * sx, pz = cam.z * sz; // camera in the Part's own stud coordinates
    const r = this.tier.radius;
    const nearX = Math.max(-sx / 2 - px, 0, px - sx / 2), nearZ = Math.max(-sz / 2 - pz, 0, pz - sz / 2);
    const key = `${Math.floor(px / CELL)},${Math.floor(pz / CELL)}|${sx},${sy},${sz}|${f.inst.props.Color}`;
    if (Math.hypot(nearX, nearZ) > r) { f.blade.setEnabled(false); f.key = ''; return; }
    if (key === f.key) return;
    f.key = key;
    f.cells.size > 600 && f.cells.clear();
    const parts = [];
    let total = 0;
    for (let cx = Math.floor((px - r) / CELL); cx <= Math.floor((px + r) / CELL); cx++) {
      for (let cz = Math.floor((pz - r) / CELL); cz <= Math.floor((pz + r) / CELL); cz++) {
        const dx = Math.max(cx * CELL - px, 0, px - (cx + 1) * CELL), dz = Math.max(cz * CELL - pz, 0, pz - (cz + 1) * CELL);
        if (Math.hypot(dx, dz) > r) continue;
        const cell = this._cell(f, cx, cz);
        if (total + cell.length / 16 > MAX_BLADES) continue;
        total += cell.length / 16;
        parts.push(cell);
      }
    }
    const buffer = new Float32Array(total * 16);
    let at = 0;
    for (const c of parts) { buffer.set(c, at); at += c.length; }
    f.count = total;
    f.blade.setEnabled(total > 0);
    if (total > 0) f.blade.thinInstanceSetBuffer('matrix', buffer, 16, true);
  }

  /** Once per frame. Rebuilds a field only when the camera crossed into another cell, at most every REBUILD_MS. */
  update() {
    if (!this.tier || this.fields.size === 0) return;
    const now = performance.now();
    const rebuild = now - this._last > REBUILD_MS;
    if (rebuild) this._last = now;
    const { sky, camera, scene } = this.world;
    const w = sky.wind;
    const sun = sky.sun, hemi = sky.hemi, moon = sky.moon;
    const lightColor = sun.diffuse.scale(sun.intensity / 2.2).add(moon.diffuse.scale(moon.intensity / 2));
    const ambient = hemi.diffuse.scale(hemi.intensity);
    for (const f of this.fields.values()) {
      if (rebuild) this._rebuild(f);
      if (!f.blade.isEnabled()) continue;
      const m = f.mat;
      m.setMatrix('partWorld', f.mesh.getWorldMatrix());
      m.setFloat('time', w.time);
      m.setVector2('windDir', new B.Vector2(w.dir[0], w.dir[1]));
      m.setFloat('windStrength', w.strength);
      m.setVector3('camPos', camera.position);
      m.setFloat('radius', this.tier.radius);
      m.setColor3('tint', B.Color3.FromArray(f.inst.props.Color));
      m.setColor3('lightColor', new B.Color3(lightColor.r, lightColor.g, lightColor.b));
      m.setColor3('ambient', new B.Color3(ambient.r, ambient.g, ambient.b));
      m.setColor3('fogColor', scene.fogColor);
      m.setFloat('fogDensity', scene.fogDensity);
    }
  }
}
