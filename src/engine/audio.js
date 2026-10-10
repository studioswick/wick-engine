// Wick Engine audio: Sound instances played through Babylon's Audio Engine V2.
// A Sound parented to a Part is positional (it follows the Part's mesh); otherwise it plays flat.
// Built-in tones are synthesised on the fly, so the demo needs no audio files.

const B = globalThis.BABYLON;

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

const RATE = 22050;
const TONES = {
  // Two seconds holding a whole number of cycles, so it loops without a click.
  hum() {
    const n = RATE * 2;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const swell = 0.75 + 0.25 * Math.sin(2 * Math.PI * 2 * t);
      out[i] = swell * (0.45 * Math.sin(2 * Math.PI * 110 * t) + 0.2 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * Math.sin(2 * Math.PI * 330 * t));
    }
    return out;
  },
  // Short low impact with a noise burst on top.
  thud() {
    const n = Math.floor(RATE * 0.4);
    const out = new Float32Array(n);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      seed = (seed * 16807) % 2147483647;
      const noise = (seed / 2147483647) * 2 - 1;
      out[i] = 0.9 * Math.sin(2 * Math.PI * (90 - 120 * t) * t) * Math.exp(-t * 11) + 0.35 * noise * Math.exp(-t * 70);
    }
    return out;
  },
};

export class WickAudio {
  constructor(world, log) {
    this.world = world;
    this.log = log;
    this.engine = null;
    this.sounds = new Map(); // instance id -> sound
    this.toneUrls = new Map();
    this.failed = false;
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

  _resolve(soundId) {
    const tone = /^wick:\/\/tone\/(\w+)$/.exec(soundId);
    if (tone) {
      if (!TONES[tone[1]]) throw new Error(`Unknown built-in tone "${tone[1]}"`);
      if (!this.toneUrls.has(tone[1])) this.toneUrls.set(tone[1], wavUrl(TONES[tone[1]](), RATE));
      return this.toneUrls.get(tone[1]);
    }
    if (/^https?:\/\//i.test(soundId)) return soundId;
    throw new Error('SoundId must be a wick://tone/... name or an http(s) URL');
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
        ...(spatial ? { spatialMaxDistance: p.MaxDistance, spatialMinDistance: 2, spatialDistanceModel: 'linear' } : {}),
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

  setVolume(id, v) {
    const s = this.sounds.get(id);
    if (s) s.volume = v;
  }

  dispose() {
    for (const id of [...this.sounds.keys()]) this.remove(id);
    try { this.engine?.dispose(); } catch { /* ignore */ }
    this.engine = null;
    for (const url of this.toneUrls.values()) URL.revokeObjectURL(url);
    this.toneUrls.clear();
  }
}
