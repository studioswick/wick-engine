// Wick library: the built-in assets every project can use, generated in code so the engine ships no asset files.
// Sounds are addressed as wick://sounds/<name>. Surface textures are used by the Wood and Grass materials.
// Pure maths only (no DOM, no Babylon), so it also runs headless.

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

const TEXTURES = { Wood: { make: wood, bump: 5 }, Grass: { make: grass, bump: 4 } };

/** World units covered by one repeat of each surface texture. */
export const TEXTURE_TILE = { Wood: 3, Grass: 3.5 };

/** { color, normal } RGBA byte arrays for a library surface ('Wood' or 'Grass'), n pixels square. */
export function surfaceTexture(name, n = 512) {
  const t = TEXTURES[name];
  const { rgba, height } = t.make(n);
  return { color: rgba, normal: normalMap(height, n, t.bump) };
}
