// Wick Engine hardware diagnostic: measures this device and decides where Auto graphics quality starts.
// Graphics are measured by rendering the open project at each quality tier (best first) and keeping the best
// tier that holds a smooth frame rate; scripts are measured by timing a fixed workload in the Lua VM.
// The result also drives the default WickGuard limits (see guard.js). Auto quality can still step down from the
// baseline at any time if a game turns out to be heavier than the test scene.

import { TIERS } from './world.js';

const WARMUP_FRAMES = 25; // shader compiles and probe creation make the first frames slow, so they are not counted
const SAMPLE_FRAMES = 50;
const PASS_MEDIAN_MS = 20; // about 50 fps
const PASS_P90_MS = 30;
const TIER_TIMEOUT_MS = 12000;
const REFERENCE_LUA_MS = 80; // time the Lua workload takes on a typical desktop CPU in this build
const LUA_WORKLOAD = 'local s = 0 for i = 1, 1000000 do s = s + math.sin(i) * (i % 7) end';
const TIER_SCORE = [1, 0.7, 0.4, 0.2];
export const RATINGS = ['High-end', 'Mainstream', 'Entry-level', 'Minimum'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/** Resolves with { median, p90 } for the next SAMPLE_FRAMES frames, or null if the tab was hidden or it timed out. */
function measureFrames(world) {
  return new Promise((resolve) => {
    const samples = [];
    let seen = 0;
    const finish = (value) => {
      world.scene.onAfterRenderObservable.remove(obs);
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHide);
      resolve(value);
    };
    const onHide = () => { if (document.hidden) finish(null); };
    const timer = setTimeout(() => finish({ median: Infinity, p90: Infinity }), TIER_TIMEOUT_MS);
    document.addEventListener('visibilitychange', onHide);
    const obs = world.scene.onAfterRenderObservable.add(() => {
      if (++seen <= WARMUP_FRAMES) return;
      samples.push(world.engine.getDeltaTime());
      const sorted = [...samples].sort((a, b) => a - b);
      if (samples.length >= 10 && percentile(sorted, 0.5) > 50) finish({ median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) }); // hopeless, stop early
      else if (samples.length >= SAMPLE_FRAMES) finish({ median: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) });
    });
  });
}

/** Times a fixed Lua workload. The VM needs a host that answers its start-up calls, so a stub stands in. */
function measureLua(core) {
  const previous = core.hostHandler;
  core.hostHandler = (op) => (op === 'root' ? 'i1' : '');
  try {
    if (core.open(16, 100, 35) !== 0) return 0;
    const t0 = performance.now();
    core.run('wick-diagnostic', LUA_WORKLOAD);
    return performance.now() - t0;
  } finally {
    core.close();
    core.hostHandler = previous;
  }
}

/**
 * Runs the diagnostic. onProgress(text) reports what is being measured. Resolves with the hardware profile
 * (stored in settings and read by WickLimits), or null if it was interrupted and should run again next time.
 */
export async function runDiagnostic({ world, core, guard, onProgress = () => {} }) {
  guard.suspend();
  try {
    onProgress('Measuring script speed...');
    const luaMs = measureLua(core);

    let tier = world.softwareRenderer ? 2 : 0; // a software renderer cannot hold High or Medium
    for (; tier < TIERS.length - 1; tier++) {
      onProgress(`Testing ${TIERS[tier].name} graphics...`);
      world.setTier(tier);
      const r = await measureFrames(world);
      if (!r) return null;
      if (r.median <= PASS_MEDIAN_MS && r.p90 <= PASS_P90_MS) break;
    }

    const cores = navigator.hardwareConcurrency || 4;
    const memGB = navigator.deviceMemory || 0; // Chromium only
    const cpu = luaMs > 0 ? clamp(REFERENCE_LUA_MS / luaMs, 0.2, 1) : 0.6;
    const score = 0.5 * TIER_SCORE[tier] + 0.3 * cpu + 0.1 * clamp(cores / 8, 0.25, 1) + 0.1 * (memGB ? clamp(memGB / 8, 0.25, 1) : 0.6);
    return {
      tier,
      score: Math.round(score * 100) / 100,
      cpuSlow: luaMs > 0 ? Math.round(clamp(luaMs / REFERENCE_LUA_MS, 1, 3) * 100) / 100 : 1,
      gpu: world.gpuName,
      cores,
      memGB,
      luaMs: Math.round(luaMs),
      measured: true,
    };
  } finally {
    guard.resume();
  }
}
