// WickGuard policy. Pure decision logic: the JS side feeds in per-frame measurements and applies the verdict
// (lower graphics quality, or stop the game) so a heavy project never takes the browser tab down with it.

#include <algorithm>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define WICK_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define WICK_EXPORT extern "C"
#endif

namespace {

enum Action { kNone = 0, kDegrade = 1, kStop = 2 };
enum Reason { kNoReason = 0, kLowFps = 1, kHitch = 2, kScriptLoad = 3, kMemory = 4, kBodies = 5 };

constexpr int kMaxTier = 3;               // 0 High, 1 Medium, 2 Low, 3 Minimal
constexpr double kSlowSeconds = 2.5;      // sustained slowness before dropping a tier
constexpr double kCriticalSeconds = 6.0;  // sustained at the floor before stopping
constexpr double kScriptShare = 0.6;      // scripts using this share of a slow frame means graphics are not the problem
constexpr double kScriptSeconds = 4.0;
constexpr double kHeapStopRatio = 0.9;    // JS heap used / limit
constexpr double kWarmupSeconds = 3.0;    // shader compiles and asset setup are allowed to be slow

// Thresholds the user (or the hardware diagnostic) can change. They survive wick_guard_reset.
struct Limits {
  double slowMs = 38.0;       // smoothed frame time that counts as "slow" (about 26 fps)
  double criticalMs = 125.0;  // frame time at the lowest quality that counts as unplayable (about 8 fps)
  double hitchMs = 4000.0;    // a single frame this long means the tab is about to freeze
};

struct State {
  int tier = 0;
  int fixedTier = -1;  // >= 0 when the user locked a quality level
  int maxBodies = 1500;
  int reason = kNoReason;
  double frameEma = 16.7;
  double scriptEma = 0.0;
  double slowSeconds = 0.0;
  double criticalSeconds = 0.0;
  double scriptSeconds = 0.0;
  double age = 0.0;
};

State g;
Limits L;

int stop(int reason) {
  g.reason = reason;
  return kStop;
}

}  // namespace

// Frame-rate thresholds are given as FPS and the hitch as seconds.
WICK_EXPORT void wick_guard_limits(double degradeFps, double stopFps, double hitchSeconds) {
  L.slowMs = 1000.0 / std::max(degradeFps, 1.0);
  L.criticalMs = 1000.0 / std::max(stopFps, 0.5);
  L.hitchMs = std::max(hitchSeconds, 0.5) * 1000.0;
}

// fixedTier: -1 for automatic quality, otherwise the locked tier. startTier is only used in automatic mode.
WICK_EXPORT void wick_guard_reset(int maxBodies, int fixedTier, int startTier) {
  g = State{};
  g.maxBodies = maxBodies;
  g.fixedTier = fixedTier;
  g.tier = fixedTier >= 0 ? std::min(fixedTier, kMaxTier) : std::clamp(startTier, 0, kMaxTier);
}

// Called once per rendered frame. Returns 0 nothing, 1 lower the quality tier, 2 stop the game.
WICK_EXPORT int wick_guard_tick(double frameMs, double scriptMs, double heapRatio, int bodies, int playing) {
  if (frameMs <= 0) return kNone;
  const double dt = std::min(frameMs, 1000.0) / 1000.0;
  g.age += dt;
  const bool warm = g.age < kWarmupSeconds;

  if (playing) {
    if (!warm && frameMs >= L.hitchMs) return stop(kHitch);
    if (heapRatio > kHeapStopRatio) return stop(kMemory);
    if (bodies > g.maxBodies) return stop(kBodies);
  }

  g.frameEma += (frameMs - g.frameEma) * 0.1;
  g.scriptEma += (scriptMs - g.scriptEma) * 0.1;
  if (warm) return kNone;

  const bool slow = g.frameEma > L.slowMs;
  const bool scriptBound = playing && slow && g.scriptEma > g.frameEma * kScriptShare;

  g.slowSeconds = slow ? g.slowSeconds + dt : std::max(0.0, g.slowSeconds - dt * 2.0);
  g.scriptSeconds = scriptBound ? g.scriptSeconds + dt : std::max(0.0, g.scriptSeconds - dt);
  if (g.scriptSeconds > kScriptSeconds) return stop(kScriptLoad);

  // Graphics are the likely cause: drop a tier, then give the new tier time to settle.
  if (slow && !scriptBound && g.slowSeconds > kSlowSeconds && g.fixedTier < 0 && g.tier < kMaxTier) {
    g.tier++;
    g.slowSeconds = 0.0;
    g.frameEma = 20.0;
    return kDegrade;
  }

  const bool atFloor = g.fixedTier >= 0 || g.tier >= kMaxTier;
  const bool critical = playing && atFloor && g.frameEma > L.criticalMs;
  g.criticalSeconds = critical ? g.criticalSeconds + dt : std::max(0.0, g.criticalSeconds - dt);
  if (g.criticalSeconds > kCriticalSeconds) return stop(kLowFps);

  return kNone;
}

WICK_EXPORT int wick_guard_tier() { return g.tier; }
WICK_EXPORT int wick_guard_reason() { return g.reason; }