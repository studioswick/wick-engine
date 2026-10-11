// Wick Engine audio: positional sound through Babylon's Audio Engine V2.
// Sound instances play library sounds (wick://sounds/<name>) or http(s) URLs. A Sound parented to a Part follows
// that Part's mesh; otherwise it plays flat. Impacts between Parts are synthesised per pair of materials, so
// glass on grass does not sound like metal on metal.

import { SURFACES } from './datamodel.js';
import { librarySamples, librarySoundName, SOUND_RATE, WICK_SOUNDS, soundId } from './library.js';

const B = globalThis.BABYLON;

const IMPACT_RATE = 32000;
const MAX_IMPACT_VOICES = 10;
const IMPACT_RANGE = 90; // units beyond which impacts are not worth a voice
const IMPACT_MIN_SPEED = 1.5; // quieter contacts than this (units per second) make no sound
const IMPACT_FULL_SPEED = 26; // contacts at this speed or above are full volume

function wavUrl(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * Inverse-distance falloff that reaches about -30 dB at maxDistance, so MaxDistance reads as "audible range"
 * and sounds still fade the way real ones do instead of dropping off linearly.
 */
function falloff(maxDistance) {
  const min = Math.min(12, Math.max(2, maxDistance / 14));
  return { min, rolloff: (min * 32) / Math.max(1, maxDistance - min) };
}

// ---------------------------------------------------------------------------------------------
// Impact synthesis. Each material has resonant partials [frequency Hz, level, decay seconds] and a hardness
// that sets how bright the strike noise is. A pair's sound is both voices, each damped by how soft the OTHER
// surface is, plus a low thump from soft surfaces.
// ---------------------------------------------------------------------------------------------

const VOICES = {
  Metal: { partials: [[620, 1, 0.7], [1710, 0.6, 0.5], [3350, 0.4, 0.35], [5530, 0.25, 0.25]], tick: 0.35, bright: 0.7 },
  Glass: { partials: [[1480, 1, 0.35], [3440, 0.7, 0.25], [6290, 0.5, 0.18]], tick: 0.3, bright: 0.8 },
  Plastic: { partials: [[420, 1, 0.07], [980, 0.5, 0.05]], tick: 0.5, bright: 0.45 },
  Neon: { partials: [[880, 1, 0.12], [2150, 0.5, 0.09]], tick: 0.4, bright: 0.55 },
  Wood: { partials: [[230, 1, 0.09], [520, 0.6, 0.06], [880, 0.3, 0.045]], tick: 0.45, bright: 0.3 },
  Grass: { partials: [[110, 1, 0.1]], tick: 0.9, bright: 0.08 },
};

/** Mono samples for the impact of material a on material b (order does not matter). */
export function synthImpact(a, b) {
  const pair = [a, b].map((m) => ({ voice: VOICES[m] ?? VOICES.Plastic, soft: (SURFACES[m] ?? SURFACES.Plastic).soft }));
  const longest = Math.max(...pair.flatMap((p) => p.voice.partials.map((q) => q[2] * (1 - 0.75 * pair.find((o) => o !== p).soft))));
  const n = Math.floor(IMPACT_RATE * Math.min(1.2, Math.max(0.16, longest * 4.5)));
  const out = new Float32Array(n);
  let seed = [...(a < b ? a + b : b + a)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) || 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };

  pair.forEach((p, k) => {
    const ring = 1 - 0.75 * pair[1 - k].soft; // the other surface soaks up this one's ringing
    for (const [freq, level, decay] of p.voice.partials) {
      const w = 2 * Math.PI * freq / IMPACT_RATE;
      const d = decay * (0.4 + 0.6 * ring);
      for (let i = 0; i < n; i++) out[i] += 0.5 * level * ring * Math.sin(w * i) * Math.exp(-i / IMPACT_RATE / d);
    }
    // Strike noise: one-pole low-pass, brighter for hard materials.
    const tick = p.voice.tick * (1 - 0.3 * p.soft);
    const alpha = 0.04 + 0.9 * p.voice.bright * p.voice.bright;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      lp += (rand() - lp) * alpha;
      out[i] += tick * 0.7 * lp * Math.exp(-i / IMPACT_RATE / 0.012);
    }
  });
  const thump = Math.max(...pair.map((p) => p.soft));
  for (let i = 0; i < n; i++) {
    const t = i / IMPACT_RATE;
    out[i] += thump * 0.9 * Math.sin(2 * Math.PI * (95 - 40 * t) * t) * Math.exp(-t / 0.07);
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const gain = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= gain;
  const fade = Math.min(n, 64); // short fade-out so the tail never clicks
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  return out;
}

export class WickAudio {
  constructor(world, log) {
    this.world = world;
    this.log = log;
    this.engine = null;
    this.sounds = new Map(); // instance id -> sound
    this.urls = new Map(); // library sound name -> blob url
    this.impacts = new Map(); // 'A|B' -> Promise<StaticSoundBuffer>
    this.voices = 0;
    this.failed = false;
    this._volume = 1;
  }

  async start() {
    try {
      this.engine = await B.CreateAudioEngineAsync({ listenerEnabled: true, resumeOnInteraction: true });
      this.engine.listener.attach(this.world.camera);
      this.engine.unlockAsync?.().catch(() => {});
    } catch (err) {
      this.failed = true;
      this.log('warn', `Audio is unavailable on this device: ${err.message || err}`);
    }
  }

  /** Silences and suspends all audio while a game is paused, and brings it back on resume. */
  pause() {
    if (!this.engine) return;
    this._volume = this.engine.volume ?? 1;
    this.engine.volume = 0;
    this.engine.pause?.().catch?.(() => {});
  }

  resume() {
    if (!this.engine) return;
    this.engine.volume = this._volume;
    this.engine.resume?.().catch?.(() => {});
  }

  _resolve(id) {
    const name = librarySoundName(id);
    if (name) {
      if (!this.urls.has(name)) this.urls.set(name, wavUrl(librarySamples(name), SOUND_RATE));
      return this.urls.get(name);
    }
    if (/^https?:\/\//i.test(id)) return id;
    throw new Error(`SoundId must be a Wick library sound (${WICK_SOUNDS.map(soundId).join(', ')}) or an http(s) URL`);
  }

  _spatial(p) {
    const { min, rolloff } = falloff(p.MaxDistance);
    return { spatialDistanceModel: 'inverse', spatialMinDistance: min, spatialRolloffFactor: rolloff, spatialPanningModel: 'HRTF' };
  }

  /** Creates the sound for a Sound instance. `mesh` is the parent Part's mesh, if any. */
  async add(inst, mesh) {
    if (!this.engine || this.sounds.has(inst.id)) return;
    const p = inst.props;
    try {
      const spatial = p.Spatial && !!mesh;
      const sound = await B.CreateSoundAsync(`wick-${inst.id}`, this._resolve(p.SoundId), {
        loop: p.Looped,
        volume: p.Volume,
        spatialEnabled: spatial,
        ...(spatial ? this._spatial(p) : {}),
      });
      if (spatial) sound.spatial.attach(mesh);
      this.sounds.set(inst.id, sound);
      if (p.PlayOnStart) sound.play();
    } catch (err) {
      this.log('warn', `Sound "${inst.name}" could not load: ${err.message || err}`);
    }
  }

  play(id) { this.sounds.get(id)?.play(); }
  stop(id) { this.sounds.get(id)?.stop(); }

  remove(id) {
    const s = this.sounds.get(id);
    if (!s) return;
    try { s.stop(); s.dispose(); } catch { /* already gone */ }
    this.sounds.delete(id);
  }

  /** Applies Volume, Looped and MaxDistance changes made by a script to a live Sound. */
  update(inst) {
    const s = this.sounds.get(inst.id);
    if (!s) return;
    const p = inst.props;
    s.volume = p.Volume;
    s.loop = p.Looped;
    if (s.spatial) s.spatial.rolloffFactor = falloff(p.MaxDistance).rolloff;
  }

  /**
   * Plays the impact of two materials at a world position. strength is the change in relative speed (units per
   * second) and mass the lighter part's mass: harder hits are louder and heavier parts sound deeper.
   */
  async impact(a, b, strength, [x, y, z], mass) {
    if (!this.engine || this.voices >= MAX_IMPACT_VOICES || strength < IMPACT_MIN_SPEED) return;
    const cam = this.world.camera.position;
    if (Math.hypot(cam.x - x, cam.y - y, cam.z - z) > IMPACT_RANGE) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    this.voices++;
    try {
      let pending = this.impacts.get(key);
      if (!pending) {
        const url = wavUrl(synthImpact(a, b), IMPACT_RATE);
        pending = B.CreateSoundBufferAsync(url).finally(() => URL.revokeObjectURL(url));
        this.impacts.set(key, pending);
      }
      const buffer = await pending;
      const loud = Math.min(1, (strength - IMPACT_MIN_SPEED) / (IMPACT_FULL_SPEED - IMPACT_MIN_SPEED));
      const heavy = Math.min(1, Math.max(0, Math.log2(mass + 1) / 7));
      const { min, rolloff } = falloff(IMPACT_RANGE);
      const sound = await B.CreateSoundAsync('wick-impact', buffer, {
        volume: (0.06 + 0.94 * loud ** 0.8) * (0.75 + 0.25 * heavy),
        playbackRate: Math.min(1.6, Math.max(0.6, 2 ** (-0.18 * Math.log2(Math.max(0.05, mass) / 8)))) * (0.94 + Math.random() * 0.12),
        spatialEnabled: true,
        spatialPosition: new B.Vector3(x, y, z),
        spatialDistanceModel: 'inverse',
        spatialMinDistance: min,
        spatialRolloffFactor: rolloff,
        autoplay: true,
      });
      sound.onEndedObservable.addOnce(() => { sound.dispose(); this.voices--; });
    } catch (err) {
      this.voices--;
      this.impacts.delete(key); // retry next time
      if (!this.failed) { this.failed = true; this.log('warn', `Impact sounds are unavailable: ${err.message || err}`); }
    }
  }

  dispose() {
    for (const id of [...this.sounds.keys()]) this.remove(id);
    try { this.engine?.dispose(); } catch { /* ignore */ }
    this.engine = null;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.impacts.clear();
    this.voices = 0;
  }
}
