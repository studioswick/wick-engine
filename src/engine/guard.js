// WickGuard (JS side). The decisions live in core/wick_guard.cpp; this file feeds it frame measurements and
// applies the verdicts: lower the graphics tier, or stop the running game before the tab locks up.
// It also owns the limits: every limit has a default calculated from this device's measured performance
// (see diagnostic.js), and the user can override any of them.

import { TIERS } from './world.js';
import { WICK_LIMITS, GRAPHICS_FLOORS } from './datamodel.js';

/** Editable limits. min/max bound what the limits dialog accepts. */
export const LIMIT_DEFS = [
  { key: 'maxParts', label: 'Parts per project', unit: '', min: 100, max: 20000, help: 'The most Parts a project can hold. Opening a larger project still works.' },
  { key: 'maxBodies', label: 'Physics bodies', unit: '', min: 50, max: 10000, help: 'The game is stopped if it creates more collidable Parts than this.' },
  { key: 'luaHeapMB', label: 'Script memory', unit: 'MB', min: 8, max: 512, help: 'Total memory all scripts may use. Takes effect the next time you press Play.' },
  { key: 'scriptSliceMs', label: 'Script time without waiting', unit: 'ms', min: 20, max: 2000, help: 'A script that runs this long without calling task.wait() is stopped. Next Play.' },
  { key: 'scriptFrameMs', label: 'Script time per frame', unit: 'ms', min: 4, max: 100, help: 'Scripts that are due to run share this much time each frame; the rest wait for the next frame. Next Play.' },
  { key: 'degradeFps', label: 'Lower graphics below', unit: 'FPS', min: 5, max: 120, help: 'Sustained frame rates below this step graphics quality down (Auto quality only).' },
  { key: 'stopFps', label: 'Stop the game below', unit: 'FPS', min: 1, max: 60, help: 'If the game stays below this at the lowest quality it is stopped.' },
  { key: 'hitchSeconds', label: 'Stop on a frozen frame of', unit: 's', min: 1, max: 30, help: 'A single frame this long means the tab is about to freeze, so the game is stopped.' },
];

/** What is assumed until the first hardware diagnostic has run. */
export const DEFAULT_HARDWARE = Object.freeze({ tier: 0, score: 0.5, cpuSlow: 1, gpu: 'unknown GPU', cores: 4, memGB: 0, luaMs: 0, measured: false });

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Default limits for a hardware profile; score is 0 (weak) to 1 (strong), cpuSlow is 1 or more (slower CPU). */
export function defaultLimits(hw) {
  const s = clamp(hw.score, 0.1, 1);
  return {
    maxParts: Math.round((1000 + 4000 * s) / 100) * 100,
    maxBodies: Math.round((500 + 2500 * s) / 50) * 50,
    luaHeapMB: Math.round(32 + 160 * s),
    scriptSliceMs: Math.round(100 * clamp(hw.cpuSlow, 1, 3)), // a slower CPU needs longer to finish the same honest work
    scriptFrameMs: Math.round(25 + 20 * s), // a weaker device has less spare time per frame
    degradeFps: Math.round(20 + 10 * s),
    stopFps: Math.round(5 + 4 * s),
    hitchSeconds: Math.round(4 + 4 * (1 - s)),
  };
}

export class WickLimits {
  constructor() {
    this.hardware = { ...DEFAULT_HARDWARE };
    this.overrides = {};
  }

  /** Restores the saved hardware profile and overrides from the settings object. */
  load(settings) {
    if (settings.hardware) this.hardware = { ...DEFAULT_HARDWARE, ...settings.hardware };
    this.overrides = {};
    this.set(settings.limits ?? {});
  }

  get defaults() { return defaultLimits(this.hardware); }
  get values() { return { ...this.defaults, ...this.overrides }; }

  /** Overrides the given limits (values equal to the default are not stored as overrides). */
  set(partial) {
    const defaults = this.defaults;
    for (const d of LIMIT_DEFS) {
      if (!(d.key in partial)) continue;
      const n = Number(partial[d.key]);
      if (!Number.isFinite(n)) continue;
      const v = Math.round(clamp(n, d.min, d.max));
      if (v === defaults[d.key]) delete this.overrides[d.key]; else this.overrides[d.key] = v;
    }
    this.apply();
  }

  reset() {
    this.overrides = {};
    this.apply();
  }

  /** Pushes the limits that other systems read directly. */
  apply() { WICK_LIMITS.maxParts = this.values.maxParts; }
}

export class WickGuard {
  constructor(core, world, limits) {
    this.core = core;
    this.world = world;
    this.limits = limits;
    this.quality = 'auto'; // 'auto' or a locked tier index
    this.suspended = false;
    this._skip = 0;
    /** () => { playing, scriptMs, bodies } supplied by the runtime. */
    this.context = () => ({ playing: false, scriptMs: 0, bodies: 0 });
    this.onDegrade = null; // (tierName) => void
    this.onStop = null; // (message) => void
  }

  /** 'auto' lets the guard step quality down when needed; a number locks that tier. */
  setQuality(quality) {
    this.quality = quality;
    this.reset();
  }

  /**
   * Re-arms the timers with the current limits. keepTier: do not undo earlier quality reductions (used when Play
   * starts or the tab returns). Otherwise Auto starts at the tier this device's diagnostic recommended.
   */
  reset(keepTier = false) {
    const v = this.limits.values;
    const locked = this.quality === 'auto' ? -1 : this.quality;
    const baseline = Math.max(this.world.softwareRenderer ? 2 : 0, this.limits.hardware.tier);
    const floor = this.floorTier;
    const start = Math.min(keepTier ? Math.max(baseline, this.world.tier) : baseline, floor);
    this.core.guardLimits(v.degradeFps, v.stopFps, v.hitchSeconds);
    this.core.guardReset(v.maxBodies, locked, start, floor);
    this.world.setTier(this.core.guardTier);
    this._skip = 2;
  }

  /** Pauses the guard (the hardware diagnostic changes quality on purpose). */
  suspend() { this.suspended = true; }

  resume() {
    this.suspended = false;
    this.reset(true);
  }

  get tierName() { return TIERS[this.world.tier].name; }

  /** Highest tier index (lowest quality) this project allows, from Lighting.MinGraphics. */
  get floorTier() { return 3 - GRAPHICS_FLOORS.indexOf(this.world.dm.lighting.props.MinGraphics); }

  _heapRatio() {
    const m = performance.memory; // Chromium only
    return m && m.jsHeapSizeLimit ? m.usedJSHeapSize / m.jsHeapSizeLimit : 0;
  }

  _reason(code) {
    const v = this.limits.values;
    return {
      1: 'The game ran too slowly for this device, even at the lowest graphics quality.',
      2: 'A single frame took several seconds, which would have frozen the tab.',
      3: 'Scripts were using most of every frame. Check for loops that never call task.wait().',
      4: 'The game ran out of memory.',
      5: `The game created more than ${v.maxBodies} physics bodies.`,
    }[code] ?? 'The game was stopped to protect your device.';
  }

  /** Call once per rendered frame with the frame time in milliseconds. */
  frame(frameMs) {
    if (this.suspended) return;
    if (this._skip > 0) { this._skip--; return; } // the frame after a reset or a hidden tab is not representative
    const ctx = this.context();
    const action = this.core.guardTick(frameMs, ctx.scriptMs, this._heapRatio(), ctx.bodies, ctx.playing);
    if (action === 1) {
      this.world.setTier(this.core.guardTier);
      this.onDegrade?.(this.tierName);
    } else if (action === 2) {
      this.onStop?.(this._reason(this.core.guardReason));
    }
  }
}
