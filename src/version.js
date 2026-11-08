// Wick Engine version. Format: <stage><major>.<minor>.<patch>
//   stage  p = pre-alpha, a = alpha, b = beta, (no letter) = release
//   major  changes when saved projects or the scripting API break
//   minor  a round of new or changed features
//   patch  fixes only
// Examples: p0.5.0 (this build), a0.1.0 (first alpha), b1.0.0, 1.0.0.
// When this changes, change VERSION in sw.js too, and add an entry to MIGRATIONS in project/migrate.js.

export const WICK_VERSION = 'p0.5.0';

// The separate public repository that publishes exported games (the engine repository itself can stay private).
export const WICK_WRAPPER_REPO = 'https://github.com/studioswick/Wick-Engine-Game-Wrapper';

const STAGES = { p: 'pre-alpha', a: 'alpha', b: 'beta' };
export const WICK_STAGE = STAGES[WICK_VERSION[0]] ?? 'release';

const STAGE_ORDER = { p: 0, a: 1, b: 2, '': 3 };

/** { stage, major, minor, patch } for text such as "p0.4.0", or null when the text is not a version. */
export function parseVersion(text) {
  const m = /^([pab]?)(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? ''));
  return m ? { stage: m[1], major: +m[2], minor: +m[3], patch: +m[4] } : null;
}

/** -1, 0 or 1, like a sort comparator. Text that is not a version counts as older than every real version. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  const diffs = [STAGE_ORDER[x.stage] - STAGE_ORDER[y.stage], x.major - y.major, x.minor - y.minor, x.patch - y.patch];
  return Math.sign(diffs.find((d) => d !== 0) ?? 0);
}
