// WickGuard (JS side). The decisions live in core/wick_guard.cpp; this file feeds it frame measurements and
// applies the verdicts: lower the graphics tier, or stop the running game before the tab locks up.

import { TIERS } from './world.js';

export const MAX_BODIES = 1500;

const REASONS = {
  1: 'The game ran too slowly for this device, even at the lowest graphics quality.',
  2: 'A single frame took several seconds, which would have frozen the tab.',
  3: 'Scripts were using most of every frame. Check for loops that never call task.wait().',
  4: 'The game ran out of memory.',
  5: `The game created more than ${MAX_BODIES} physics bodies.`,
};

export class WickGuard {
  constructor(core, world) {
    this.core = core;
    this.world = world;
    this.quality = 'auto'; // 'auto' or a locked tier index
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

  /** keepTier: re-arm the timers (e.g. when Play starts) without undoing earlier quality reductions. */
  reset(keepTier = false) {
    const locked = this.quality === 'auto' ? -1 : this.quality;
    const start = Math.max(this.world.softwareRenderer ? 2 : 0, keepTier ? this.world.tier : 0);
    this.core.guardReset(MAX_BODIES, locked, start);
    this.world.setTier(this.core.guardTier);
  }

  get tierName() { return TIERS[this.world.tier].name; }

  _heapRatio() {
    const m = performance.memory; // Chromium only
    return m && m.jsHeapSizeLimit ? m.usedJSHeapSize / m.jsHeapSizeLimit : 0;
  }

  /** Call once per rendered frame with the frame time in milliseconds. */
  frame(frameMs) {
    const ctx = this.context();
    const action = this.core.guardTick(frameMs, ctx.scriptMs, this._heapRatio(), ctx.bodies, ctx.playing);
    if (action === 1) {
      this.world.setTier(this.core.guardTier);
      this.onDegrade?.(this.tierName);
    } else if (action === 2) {
      this.onStop?.(REASONS[this.core.guardReason] ?? 'The game was stopped to protect your device.');
    }
  }
}
