// Wick mesh import: reads OBJ, STL, PLY and GLB/glTF into one compact mesh format and builds the built-in meshes.
// Pure maths and parsing (no DOM, no Babylon), so it also runs headless.
// A finished mesh is { positions, normals, uvs|null, indices } as typed arrays, centred and scaled into the unit box
// (-0.5..0.5 on every axis). The Part's Size then stretches it back to real dimensions.

export const MESH_EXTENSIONS = ['obj', 'stl', 'ply', 'glb', 'gltf'];
export const MAX_TRIANGLES = 250000;

// ---------------------------------------------------------------------------------------------
// Parsers. Each returns { positions: number[], indices: number[], normals?: number[], uvs?: number[] }
// in the file's own (right-handed) space.
// ---------------------------------------------------------------------------------------------

function parseObj(text) {
  const v = [], vt = [], vn = [];
  const positions = [], normals = [], uvs = [], indices = [];
  const seen = new Map();
  let hasN = false, hasT = false;
  const pick = (list, token, size) => {
    if (token === undefined || token === '') return null;
    let i = parseInt(token, 10);
    i = i < 0 ? list.length / size + i : i - 1;
    return i >= 0 && i * size < list.length ? i : null;
  };
  const corner = (ref) => {
    const [a, b, c] = ref.split('/');
    const vi = pick(v, a, 3), ti = pick(vt, b, 2), ni = pick(vn, c, 3);
    if (vi === null) throw new Error(`OBJ face refers to a missing vertex ("${ref}")`);
    const key = `${vi}/${ti}/${ni}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = positions.length / 3;
      seen.set(key, id);
      positions.push(v[vi * 3], v[vi * 3 + 1], v[vi * 3 + 2]);
      normals.push(...(ni === null ? [0, 0, 0] : [vn[ni * 3], vn[ni * 3 + 1], vn[ni * 3 + 2]]));
      uvs.push(...(ti === null ? [0, 0] : [vt[ti * 2], vt[ti * 2 + 1]]));
      if (ni !== null) hasN = true;
      if (ti !== null) hasT = true;
    }
    return id;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    if (t[0] === 'v') v.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'vt') vt.push(+t[1], +t[2]);
    else if (t[0] === 'vn') vn.push(+t[1], +t[2], +t[3]);
    else if (t[0] === 'f' && t.length >= 4) {
      const ids = t.slice(1).map(corner);
      for (let i = 1; i < ids.length - 1; i++) indices.push(ids[0], ids[i], ids[i + 1]); // fan-triangulate polygons
    }
  }
  return { positions, indices, normals: hasN ? normals : null, uvs: hasT ? uvs : null };
}

function parseStl(buf) {
  const view = new DataView(buf);
  const positions = [], normals = [];
  const binary = buf.byteLength >= 84 && 84 + view.getUint32(80, true) * 50 === buf.byteLength;
  if (binary) {
    const count = view.getUint32(80, true);
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50;
      const n = [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)];
      for (let k = 0; k < 3; k++) {
        const p = o + 12 + k * 12;
        positions.push(view.getFloat32(p, true), view.getFloat32(p + 4, true), view.getFloat32(p + 8, true));
        normals.push(...n);
      }
    }
  } else {
    const text = new TextDecoder().decode(buf);
    for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) positions.push(+m[1], +m[2], +m[3]);
    if (positions.length % 9) throw new Error('This STL file is damaged (vertex count is not a multiple of 3)');
  }
  return { positions, indices: positions.map((_, i) => i).slice(0, positions.length / 3), normals: null };
}

const PLY_TYPES = {
  char: ['Int8', 1], int8: ['Int8', 1], uchar: ['Uint8', 1], uint8: ['Uint8', 1],
  short: ['Int16', 2], int16: ['Int16', 2], ushort: ['Uint16', 2], uint16: ['Uint16', 2],
  int: ['Int32', 4], int32: ['Int32', 4], uint: ['Uint32', 4], uint32: ['Uint32', 4],
  float: ['Float32', 4], float32: ['Float32', 4], double: ['Float64', 8], float64: ['Float64', 8],
};

function parsePly(buf) {
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = head.indexOf('end_header');
  if (!head.startsWith('ply') || end < 0) throw new Error('This is not a valid PLY file');
  const bodyStart = head.indexOf('\n', end) + 1;
  const elements = [];
  let format = 'ascii';
  for (const line of head.slice(0, end).split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'format') format = t[1];
    else if (t[0] === 'element') elements.push({ name: t[1], count: +t[2], props: [] });
    else if (t[0] === 'property' && elements.length) {
      elements[elements.length - 1].props.push(t[1] === 'list' ? { list: true, countType: t[2], type: t[3], name: t[4] } : { type: t[1], name: t[2] });
    }
  }
  const view = new DataView(buf);
  const little = format !== 'binary_big_endian';
  let pos = bodyStart;
  let words = null, wi = 0;
  if (format === 'ascii') words = new TextDecoder().decode(bytes.subarray(bodyStart)).split(/\s+/).filter(Boolean);
  const read = (type) => {
    if (words) return +words[wi++];
    const [kind, size] = PLY_TYPES[type] ?? (() => { throw new Error(`Unsupported PLY type "${type}"`); })();
    const value = view[`get${kind}`](pos, little);
    pos += size;
    return value;
  };
  const positions = [], normals = [], uvs = [], indices = [];
  let hasN = false, hasT = false;
  for (const el of elements) {
    for (let i = 0; i < el.count; i++) {
      const row = {};
      let list = null;
      for (const p of el.props) {
        if (p.list) {
          const n = read(p.countType);
          const items = [];
          for (let k = 0; k < n; k++) items.push(read(p.type));
          if (p.name === 'vertex_indices' || p.name === 'vertex_index') list = items;
        } else row[p.name] = read(p.type);
      }
      if (el.name === 'vertex') {
        positions.push(row.x, row.y, row.z);
        if ('nx' in row) { normals.push(row.nx, row.ny, row.nz); hasN = true; } else normals.push(0, 0, 0);
        const u = row.u ?? row.s ?? row.texture_u, w = row.v ?? row.t ?? row.texture_v;
        if (u !== undefined && w !== undefined) { uvs.push(u, w); hasT = true; } else uvs.push(0, 0);
      } else if (el.name === 'face' && list) {
        for (let k = 1; k < list.length - 1; k++) indices.push(list[0], list[k], list[k + 1]);
      }
    }
  }
  return { positions, indices, normals: hasN ? normals : null, uvs: hasT ? uvs : null };
}

// ---- glTF ----

const GLTF_COMPONENTS = { 5120: ['Int8', 1], 5121: ['Uint8', 1], 5122: ['Int16', 2], 5123: ['Uint16', 2], 5125: ['Uint32', 4], 5126: ['Float32', 4] };
const GLTF_WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function matMul(a, b) { // column-major 4x4: a * b
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function nodeMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function parseGltf(buf, fileName) {
  let json, bin = null;
  const head = new DataView(buf);
  if (buf.byteLength >= 12 && head.getUint32(0, true) === 0x46546c67) { // 'glTF'
    let o = 12;
    while (o + 8 <= buf.byteLength) {
      const len = head.getUint32(o, true), type = head.getUint32(o + 4, true);
      const chunk = buf.slice(o + 8, o + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)); // JSON
      else if (type === 0x004e4942) bin = chunk; // BIN
      o += 8 + len;
    }
  } else {
    json = JSON.parse(new TextDecoder().decode(buf));
  }
  if (!json?.meshes) throw new Error(`${fileName} contains no meshes`);
  if ((json.extensionsRequired ?? []).includes('KHR_draco_mesh_compression')) throw new Error('Draco-compressed glTF files are not supported. Export without compression.');
  const buffers = (json.buffers ?? []).map((b, i) => {
    if (i === 0 && bin) return bin;
    const m = /^data:[^,]*;base64,(.*)$/.exec(b.uri ?? '');
    if (!m) throw new Error('This glTF refers to an external .bin file. Export a .glb, or a .gltf with embedded buffers.');
    const raw = atob(m[1]);
    const out = new Uint8Array(raw.length);
    for (let k = 0; k < raw.length; k++) out[k] = raw.charCodeAt(k);
    return out.buffer;
  });
  const readAccessor = (index) => {
    const a = json.accessors[index], bv = json.bufferViews[a.bufferView];
    const [kind, size] = GLTF_COMPONENTS[a.componentType];
    const width = GLTF_WIDTH[a.type];
    const view = new DataView(buffers[bv.buffer]);
    const stride = bv.byteStride || size * width;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = new Array(a.count * width);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = view[`get${kind}`](base + i * stride + k * size, true);
    return out;
  };

  const positions = [], normals = [], uvs = [], indices = [];
  let hasN = false, hasT = false;
  const addMesh = (mesh, m) => {
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
      const base = positions.length / 3;
      const p = readAccessor(prim.attributes.POSITION);
      const n = prim.attributes.NORMAL !== undefined ? readAccessor(prim.attributes.NORMAL) : null;
      const t = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(prim.attributes.TEXCOORD_0) : null;
      for (let i = 0; i < p.length; i += 3) {
        const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
        positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        if (n) {
          const [nx, ny, nz] = [n[i], n[i + 1], n[i + 2]];
          const v = [m[0] * nx + m[4] * ny + m[8] * nz, m[1] * nx + m[5] * ny + m[9] * nz, m[2] * nx + m[6] * ny + m[10] * nz];
          const l = Math.hypot(...v) || 1;
          normals.push(v[0] / l, v[1] / l, v[2] / l);
          hasN = true;
        } else normals.push(0, 0, 0);
        if (t) { uvs.push(t[(i / 3) * 2], t[(i / 3) * 2 + 1]); hasT = true; } else uvs.push(0, 0);
      }
      const idx = prim.indices !== undefined ? readAccessor(prim.indices) : p.map((_, i) => i).slice(0, p.length / 3);
      for (const i of idx) indices.push(base + i);
    }
  };
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const m = matMul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) addMesh(json.meshes[node.mesh], m);
    for (const c of node.children ?? []) walk(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) for (const n of scene.nodes) walk(n, identity);
  else json.meshes.forEach((mesh) => addMesh(mesh, identity));
  return { positions, indices, normals: hasN ? normals : null, uvs: hasT ? uvs : null };
}

// ---------------------------------------------------------------------------------------------
// Finishing: orientation, handedness, normals, unit box
// ---------------------------------------------------------------------------------------------

/** Flat-shaded copy: every triangle gets its own three vertices and one face normal. */
function unweld({ positions, indices, uvs }) {
  const p = [], n = [], t = uvs ? [] : null, idx = [];
  for (let i = 0; i < indices.length; i += 3) {
    const c = [indices[i], indices[i + 1], indices[i + 2]];
    const a = c.map((k) => [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]]);
    const u = [a[1][0] - a[0][0], a[1][1] - a[0][1], a[1][2] - a[0][2]], w = [a[2][0] - a[0][0], a[2][1] - a[0][1], a[2][2] - a[0][2]];
    const fn = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...fn) || 1;
    c.forEach((k, j) => {
      idx.push(p.length / 3);
      p.push(...a[j]);
      n.push(fn[0] / l, fn[1] / l, fn[2] / l);
      if (t) t.push(uvs[k * 2], uvs[k * 2 + 1]);
    });
  }
  return { positions: p, normals: n, uvs: t, indices: idx };
}

/**
 * Turns parsed geometry into a Wick mesh. zUp rotates a Z-up file (CAD, STL) to Y-up. Files are right-handed and
 * Babylon is left-handed, so Z is negated and triangle winding flipped. Returns { mesh, size } where size is the
 * model's real dimensions (the mesh itself is normalised to the unit box).
 */
export function finishMesh(raw, { zUp = false } = {}) {
  const tris = raw.indices.length / 3;
  if (!tris) throw new Error('The file contains no triangles');
  if (tris > MAX_TRIANGLES) throw new Error(`The mesh has ${tris.toLocaleString()} triangles; the limit is ${MAX_TRIANGLES.toLocaleString()}. Simplify it in a modelling tool first.`);
  if (raw.positions.some((v) => !Number.isFinite(v))) throw new Error('The file contains invalid numbers');

  const convert = (x, y, z) => (zUp ? [x, z, -y] : [x, y, z]);
  const pos = [], nrm = raw.normals ? [] : null;
  for (let i = 0; i < raw.positions.length; i += 3) {
    const p = convert(raw.positions[i], raw.positions[i + 1], raw.positions[i + 2]);
    pos.push(p[0], p[1], -p[2]);
    if (nrm) { const n = convert(raw.normals[i], raw.normals[i + 1], raw.normals[i + 2]); nrm.push(n[0], n[1], -n[2]); }
  }
  const idx = raw.indices.slice();
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
  const dim = max.map((m, k) => Math.max(m - min[k], 1e-6));
  const centre = max.map((m, k) => (m + min[k]) / 2);
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) pos[i + k] = (pos[i + k] - centre[k]) / dim[k];

  let mesh = { positions: pos, indices: idx, normals: nrm, uvs: raw.uvs };
  if (nrm) {
    // The unit-box squash is a scale of 1/dim, so normals scale by dim (inverse transpose) before renormalising.
    for (let i = 0; i < nrm.length; i += 3) {
      const v = [nrm[i] * dim[0], nrm[i + 1] * dim[1], nrm[i + 2] * dim[2]];
      const l = Math.hypot(...v) || 1;
      nrm[i] = v[0] / l; nrm[i + 1] = v[1] / l; nrm[i + 2] = v[2] / l;
    }
  } else {
    mesh = unweld(mesh); // no normals in the file: flat shading, so hard edges stay hard
  }
  return {
    size: dim,
    mesh: {
      positions: new Float32Array(mesh.positions), normals: new Float32Array(mesh.normals),
      uvs: mesh.uvs ? new Float32Array(mesh.uvs) : null, indices: new Uint32Array(mesh.indices),
    },
  };
}

/** Parses a model file. `buffer` is an ArrayBuffer. Returns { mesh, size, format }. */
export function parseMeshFile(fileName, buffer, options = {}) {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  let raw;
  switch (ext) {
    case 'obj': raw = parseObj(new TextDecoder().decode(buffer)); break;
    case 'stl': raw = parseStl(buffer); break;
    case 'ply': raw = parsePly(buffer); break;
    case 'glb': case 'gltf': raw = parseGltf(buffer, fileName); break;
    default: throw new Error(`.${ext ?? '?'} is not a supported 3D format. Supported: ${MESH_EXTENSIONS.map((e) => `.${e}`).join(', ')}. Convert FBX or Collada files to .glb first.`);
  }
  return { ...finishMesh(raw, options), format: ext };
}

// ---------------------------------------------------------------------------------------------
// Built-in meshes (wick://meshes/<name>)
// ---------------------------------------------------------------------------------------------

/** Builds a unit-box mesh from indexed geometry. smooth shares vertex normals, otherwise every triangle is flat. */
function build(positions, indices, smooth) {
  const raw = { positions, indices, normals: null, uvs: null };
  if (!smooth) return unweld(raw);
  const normals = new Array(positions.length).fill(0);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
    const u = [0, 1, 2].map((k) => positions[b * 3 + k] - positions[a * 3 + k]), w = [0, 1, 2].map((k) => positions[c * 3 + k] - positions[a * 3 + k]);
    const f = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) normals[v * 3 + k] += f[k];
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
  }
  return { positions, normals, uvs: null, indices };
}

const finish = (m) => ({ positions: new Float32Array(m.positions), normals: new Float32Array(m.normals), uvs: null, indices: new Uint32Array(m.indices) });

function ring(segments, y, r, out) { for (let i = 0; i < segments; i++) { const a = (i / segments) * Math.PI * 2; out.push(Math.cos(a) * r, y, Math.sin(a) * r); } }

const BUILTIN_MESHES = {
  // Ramp: a right-angled triangular prism sloping up toward -X.
  wedge() {
    const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5];
    return finish(build(p, [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 0, 3, 5, 0, 5, 2], false));
  },
  pyramid() {
    const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0, 0.5, 0];
    return finish(build(p, [0, 1, 2, 0, 2, 3, 0, 4, 1, 1, 4, 2, 2, 4, 3, 3, 4, 0], false));
  },
  cone() {
    const n = 32, side = [], idx = [];
    ring(n, -0.5, 0.5, side); side.push(0, 0.5, 0);
    for (let i = 0; i < n; i++) idx.push(i, n, (i + 1) % n);
    const base = side.slice(0, n * 3).concat([0, -0.5, 0]);
    const off = side.length / 3;
    const p = side.concat(base);
    for (let i = 0; i < n; i++) idx.push(off + n, off + i, off + (i + 1) % n);
    return finish(build(p, idx, true));
  },
  // Ring in the XZ plane filling the unit box: Size.x and Size.z set the outer diameter, Size.y the tube thickness.
  torus() {
    const major = 32, minor = 16, p = [], idx = [];
    for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++) {
      const u = (i / major) * Math.PI * 2, v = (j / minor) * Math.PI * 2, r = 0.375 + 0.125 * Math.cos(v);
      p.push(Math.cos(u) * r, 0.5 * Math.sin(v), Math.sin(u) * r);
    }
    for (let i = 0; i < major; i++) for (let j = 0; j < minor; j++) {
      const a = i * minor + j, b = ((i + 1) % major) * minor + j, c = ((i + 1) % major) * minor + (j + 1) % minor, d = i * minor + (j + 1) % minor;
      idx.push(a, d, b, b, d, c);
    }
    return finish(build(p, idx, true));
  },
};

export const WICK_MESHES = Object.keys(BUILTIN_MESHES);
export const meshId = (name) => `wick://meshes/${name}`;
export const builtinMeshName = (id) => { const m = /^wick:\/\/meshes\/(\w+)$/.exec(id ?? ''); return m && BUILTIN_MESHES[m[1]] ? m[1] : null; };
const builtinCache = new Map();
export function builtinMesh(name) {
  if (!builtinCache.has(name)) builtinCache.set(name, BUILTIN_MESHES[name]());
  return builtinCache.get(name);
}
