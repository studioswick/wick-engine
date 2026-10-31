// Wick library: the built-in assets every project can use, generated in code so the engine ships no asset files.
// Sounds are addressed as wick://sounds/<name>. Surface textures are used by the Wood and Grass materials.
// Pure maths only (no DOM, no Babylon), so it also runs headless.

export { WICK_MESHES, meshId, builtinMeshName, builtinMesh } from './meshio.js';

export const SOUND_RATE = 22050;

const SOUNDS = {
  // Two seconds holding a whole number of cycles, so it loops without a click.
  hum() {
    const n = SOUND_RATE * 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SOUND_RATE;
      const swell = 0.75 + 0.25 * Math.sin(2 * Math.PI * 2 * t);
      out[i] = swell * (0.45 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 330 * t));
    }
    return out;
  },
  // A bright two-note bell.
  chime() {
    const n = SOUND_RATE;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SOUND_RATE, second = t > 0.18 ? 1 : 0, u = t - second * 0.18;
      const f = second ? 1318.5 : 987.8;
      out[i] = Math.exp(-u * 4.5) * (0.5 * Math.sin(2 * Math.PI * f * u) + 0.2 * Math.sin(2 * Math.PI * f * 2.76 * u) * Math.exp(-u * 6));
    }
    return out;
  },
  // A rising pickup blip.
  coin() {
    const n = Math.floor(SOUND_RATE * 0.35);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SOUND_RATE, f = t < 0.09 ? 988 : 1319;
      out[i] = 0.45 * Math.sign(Math.sin(2 * Math.PI * f * t)) * Math.min(1, (n - i) / (SOUND_RATE * 0.1)) * (t < 0.005 ? t / 0.005 : 1);
    }
    return out;
  },
  click() {
    const n = Math.floor(SOUND_RATE * 0.05);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.6 * Math.sin(2 * Math.PI * 1800 * (i / SOUND_RATE)) * Math.exp(-i / SOUND_RATE / 0.008);
    return out;
  },
  // Filtered noise swell.
  whoosh() {
    const n = Math.floor(SOUND_RATE * 0.8);
    const out = new Float32Array(n);
    let lp = 0, seed = 11;
    for (let i = 0; i < n; i++) {
      seed = (seed * 16807) % 2147483647;
      const t = i / n, a = 0.04 + 0.5 * Math.sin(Math.PI * t);
      lp += ((seed / 2147483647) * 2 - 1 - lp) * a;
      out[i] = lp * Math.sin(Math.PI * t) * 1.0;
    }
    return out;
  },
  // Looping wind: noise whose loudness cycles a whole number of times.
  wind() {
    const n = SOUND_RATE * 4;
    const out = new Float32Array(n);
    let lp = 0, seed = 5;
    for (let i = 0; i < n; i++) {
      seed = (seed * 16807) % 2147483647;
      const t = i / SOUND_RATE;
      lp += ((seed / 2147483647) * 2 - 1 - lp) * (0.03 + 0.02 * Math.sin(2 * Math.PI * t / 4));
      out[i] = lp * (0.7 + 0.3 * Math.sin(2 * Math.PI * 2 * t / 4)) * 1.6;
    }
    return out;
  },
};

export const WICK_SOUNDS = Object.keys(SOUNDS);
export const soundId = (name) => `wick://sounds/${name}`;

/** Library sound name for a SoundId such as wick://sounds/hum, or null if the id is not a library sound. */
export function librarySoundName(id) {
  const m = /^wick:\/\/(?:sounds|tone)\/(\w+)$/.exec(id); // wick://tone/ is the pre-library spelling
  return m && SOUNDS[m[1]] ? m[1] : null;
}

export const librarySamples = (name) => SOUNDS[name]();

// ---------------------------------------------------------------------------------------------
// Surface textures. Tileable (all noise wraps), RGBA bytes plus a height field for the normal map.
// ---------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

function hash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise on a lattice that wraps every px by py cells, so the result tiles. */
function vnoise(x, y, px, py, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const wx = (v) => ((v % px) + px) % px, wy = (v) => ((v % py) + py) % py;
  const a = hash(wx(x0), wy(y0), seed), b = hash(wx(x0 + 1), wy(y0), seed);
  const c = hash(wx(x0), wy(y0 + 1), seed), d = hash(wx(x0 + 1), wy(y0 + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal noise over the unit tile with cx by cy lattice cells at the first octave. */
function fbm(u, v, cx, cy, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(u * cx, v * cy, cx, cy, seed + o * 17);
    norm += amp;
    amp *= 0.5; cx *= 2; cy *= 2;
  }
  return sum / norm;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Flat-sawn timber: growth rings bent by low-frequency noise, long fibres along U, and sparse dark pores. */
function wood(n) {
  const rgba = new Uint8ClampedArray(n * n * 4);
  const height = new Float32Array(n * n);
  const light = [214, 164, 104], dark = [122, 76, 40];
  for (let y = 0; y < n; y++) {
    const v = y / n;
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const warp = fbm(u, v, 2, 1, 2, 11);
      const ring = 0.5 + 0.5 * Math.sin((v * 6 + warp * 1.25) * TAU);
      const late = smooth(0.35, 1.0, ring) * (0.55 + 0.45 * fbm(u, v, 3, 3, 3, 4));                       // dark latewood at each ring edge
      const fibre = vnoise(u * 5, v * 150, 5, 150, 3);            // long streaks
      const fine = vnoise(u * 11, v * 300, 11, 300, 9);
      const pore = smooth(0.84, 0.97, vnoise(u * 28, v * 170, 28, 170, 21));
      const t = Math.min(1, Math.max(0, 0.2 + late * 0.5 + (fibre - 0.5) * 0.62 + (fine - 0.5) * 0.22 + (warp - 0.5) * 0.2)) * (1 - pore * 0.4);
      const shade = 1 - pore * 0.28;
      const i = y * n + x;
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = mix(light[k], dark[k], t) * shade;
      rgba[i * 4 + 3] = 255;
      height[i] = 0.55 * (1 - late) + 0.3 * fibre + 0.15 * fine - pore * 0.5;
    }
  }
  return { rgba, height };
}

/** Lawn: patchy base colour with thousands of upward blades drawn on top (wrapped, so it tiles). */
function grass(n) {
  const rgba = new Uint8ClampedArray(n * n * 4);
  const height = new Float32Array(n * n);
  const soil = [34, 62, 20], lush = [74, 118, 34];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      const patch = fbm(u, v, 4, 4, 4, 5);
      const i = y * n + x;
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = mix(soil[k], lush[k], patch);
      rgba[i * 4 + 3] = 255;
      height[i] = 0.25 * patch;
    }
  }
  const rnd = mulberry32(1337);
  const blades = Math.round(n * n * 0.022);
  const wrap = (v) => ((Math.round(v) % n) + n) % n;
  for (let b = 0; b < blades; b++) {
    const x0 = rnd() * n, y0 = rnd() * n;
    const len = 9 + rnd() * 20;
    const ang = -Math.PI / 2 + (rnd() - 0.5) * 1.1;
    const bend = (rnd() - 0.5) * 0.9;
    const tone = rnd();
    const base = tone < 0.1 ? [150, 156, 58] : [mix(40, 96, tone), mix(86, 150, tone), mix(22, 46, tone)];
    for (let s = 0; s <= len; s++) {
      const f = s / len;
      const a = ang + bend * f * f;
      const px = wrap(x0 + Math.cos(a) * s), py = wrap(y0 + Math.sin(a) * s);
      const i = py * n + px;
      const lit = 0.6 + 0.55 * f;                                 // darker at the root, brighter at the tip
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = rgba[i * 4 + k] * 0.25 + base[k] * lit * 0.75;
      height[i] = Math.max(height[i], 0.35 + 0.65 * f);
    }
  }
  return { rgba, height };
}

/** Tangent-space normal map (as RGBA bytes) from a height field that wraps at the edges. */
export function normalMap(height, n, strength) {
  const out = new Uint8ClampedArray(n * n * 4);
  const at = (x, y) => height[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      out[i] = (dx / len * 0.5 + 0.5) * 255;
      out[i + 1] = (dy / len * 0.5 + 0.5) * 255;
      out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Rows-by-columns brick courses, offset every other row, with mortar lines. */
function brick(n) {
  const rgba = new Uint8ClampedArray(n * n * 4), height = new Float32Array(n * n);
  const rows = 8, cols = 4, bh = n / rows, bw = n / cols, mortar = Math.max(2, n / 128);
  for (let y = 0; y < n; y++) {
    const row = Math.floor(y / bh), off = (row % 2) * bw / 2;
    for (let x = 0; x < n; x++) {
      const xx = (x + off) % n, col = Math.floor(xx / bw);
      const edge = Math.min(xx - col * bw, (col + 1) * bw - xx, y - row * bh, (row + 1) * bh - y);
      const i = y * n + x, grain = vnoise(x / n * 64, y / n * 64, 64, 64, 3), tint = hash(col, row, 5);
      const mortarHere = edge <= mortar;
      const base = mortarHere ? [176, 170, 158] : [146 + tint * 36, 66 + tint * 22, 46 + tint * 14];
      for (let k = 0; k < 3; k++) rgba[i * 4 + k] = base[k] * (0.82 + 0.3 * grain);
      rgba[i * 4 + 3] = 255;
      height[i] = mortarHere ? 0 : 0.55 + 0.25 * smooth(mortar, mortar * 4, edge) + 0.2 * grain;
    }
  }
  return { rgba, height };
}

function concrete(n) {
  const rgba = new Uint8ClampedArray(n * n * 4), height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n, i = y * n + x;
      const cloud = fbm(u, v, 3, 3, 4, 8), fine = vnoise(u * 160, v * 160, 160, 160, 2);
      const pit = smooth(0.86, 0.97, vnoise(u * 48, v * 48, 48, 48, 17));
      const g = (150 + cloud * 60 + (fine - 0.5) * 26) * (1 - pit * 0.35);
      rgba[i * 4] = g; rgba[i * 4 + 1] = g * 0.99; rgba[i * 4 + 2] = g * 0.96; rgba[i * 4 + 3] = 255;
      height[i] = 0.5 * cloud + 0.3 * fine - pit * 0.6;
    }
  }
  return { rgba, height };
}

function sand(n) {
  const rgba = new Uint8ClampedArray(n * n * 4), height = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n, i = y * n + x;
      const ripple = 0.5 + 0.5 * Math.sin((v * 9 + fbm(u, v, 2, 2, 3, 6) * 2.2) * TAU);
      const grain = vnoise(u * 220, v * 220, 220, 220, 5), patch = fbm(u, v, 4, 4, 3, 12);
      const t = 0.45 * ripple + 0.3 * patch + 0.25 * grain;
      rgba[i * 4] = mix(176, 232, t); rgba[i * 4 + 1] = mix(146, 200, t); rgba[i * 4 + 2] = mix(96, 148, t); rgba[i * 4 + 3] = 255;
      height[i] = 0.7 * ripple + 0.3 * grain;
    }
  }
  return { rgba, height };
}

function checker(n) {
  const rgba = new Uint8ClampedArray(n * n * 4), height = new Float32Array(n * n);
  const cells = 8, size = n / cells;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dark = (Math.floor(x / size) + Math.floor(y / size)) % 2;
      const i = y * n + x, g = dark ? 46 : 226;
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
      height[i] = 0;
    }
  }
  return { rgba, height };
}

/** Rounded stones separated by dark gaps, from a jittered-grid distance field that wraps at the edges. */
function cobble(n) {
  const rgba = new Uint8ClampedArray(n * n * 4), height = new Float32Array(n * n);
  const g = 8, pts = [];
  for (let cy = 0; cy < g; cy++) for (let cx = 0; cx < g; cx++) pts.push([cx + 0.15 + 0.7 * hash(cx, cy, 31), cy + 0.15 + 0.7 * hash(cx, cy, 77)]);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = (x / n) * g, py = (y / n) * g, cx0 = Math.floor(px), cy0 = Math.floor(py);
      let d1 = 9, d2 = 9, id = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const wx = (cx0 + ox + g) % g, wy = (cy0 + oy + g) % g, p = pts[wy * g + wx];
        const d = Math.hypot(px - (cx0 + ox + (p[0] - Math.floor(p[0]))), py - (cy0 + oy + (p[1] - Math.floor(p[1]))));
        if (d < d1) { d2 = d1; d1 = d; id = wy * g + wx; } else if (d < d2) d2 = d;
      }
      const edge = d2 - d1, stone = smooth(0.02, 0.18, edge), tone = hash(id, 3, 9), i = y * n + x;
      const grain = vnoise(x / n * 96, y / n * 96, 96, 96, 4);
      const c = (96 + tone * 62 + (grain - 0.5) * 24) * (0.35 + 0.65 * stone);
      rgba[i * 4] = c; rgba[i * 4 + 1] = c * 0.97; rgba[i * 4 + 2] = c * 0.92; rgba[i * 4 + 3] = 255;
      height[i] = stone * (0.7 + 0.3 * (1 - Math.min(1, d1)));
    }
  }
  return { rgba, height };
}

/** Brushed-steel floor plates in a 2 by 2 grid with a rivet at each plate corner. */
function plates(n) {
  const rgba = new Uint8ClampedArray(n * n * 4), height = new Float32Array(n * n);
  const half = n / 2, seam = Math.max(2, n / 160), rivet = n / 64;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const lx = x % half, ly = y % half, i = y * n + x;
      const brush = vnoise(x / n * 6, y / n * 380, 6, 380, 7), tone = 0.9 + 0.1 * hash(Math.floor(x / half), Math.floor(y / half), 2);
      const edge = Math.min(lx, half - lx, ly, half - ly);
      const cornerD = Math.min(Math.hypot(lx - half * 0.1, ly - half * 0.1), Math.hypot(lx - half * 0.9, ly - half * 0.1), Math.hypot(lx - half * 0.1, ly - half * 0.9), Math.hypot(lx - half * 0.9, ly - half * 0.9));
      const dot = 1 - smooth(rivet * 0.6, rivet, cornerD), gap = 1 - smooth(seam, seam * 2.5, edge);
      const g = (132 + 52 * brush) * tone * (1 - gap * 0.6) * (1 + dot * 0.25);
      rgba[i * 4] = g * 0.92; rgba[i * 4 + 1] = g * 0.96; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
      height[i] = 0.6 - gap * 0.5 + dot * 0.4 + 0.1 * brush;
    }
  }
  return { rgba, height };
}

const TEXTURES = {
  wood: { make: wood, bump: 5, tile: 3 }, grass: { make: grass, bump: 4, tile: 3.5 },
  brick: { make: brick, bump: 4, tile: 3 }, concrete: { make: concrete, bump: 3, tile: 4 }, sand: { make: sand, bump: 3, tile: 4 },
  checker: { make: checker, bump: 0, tile: 4 }, cobble: { make: cobble, bump: 5, tile: 4 }, plates: { make: plates, bump: 3, tile: 4 },
};

export const WICK_TEXTURES = Object.keys(TEXTURES);
export const textureId = (name) => `wick://textures/${name}`;

/** The Void texture: unlit, always shows its TextureColor whatever the lighting. It has no image. */
export const VOID_TEXTURE = textureId('void');

/** Library texture name for a Texture value such as wick://textures/brick, or null. */
export function libraryTextureName(id) {
  const m = /^wick:\/\/textures\/(\w+)$/.exec(id ?? '');
  return m && TEXTURES[m[1]] ? m[1] : null;
}

/** World units covered by one repeat of a library texture. */
export const textureTile = (name) => TEXTURES[name].tile;

/** { color, normal } RGBA byte arrays for a library texture, n pixels square. */
export function surfaceTexture(name, n = 512) {
  const t = TEXTURES[name];
  const { rgba, height } = t.make(n);
  return { color: rgba, normal: t.bump ? normalMap(height, n, t.bump) : null };
}

/** Both textures as RGBA bytes, for a preview. */
export const previewTexture = (name, n = 96) => TEXTURES[name].make(n).rgba;
