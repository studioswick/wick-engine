// Wick Engine version. Format: <stage><major>.<minor>.<patch>
//   stage  p = pre-alpha, a = alpha, b = beta, (no letter) = release
//   major  changes when saved projects or the scripting API break
//   minor  a round of new or changed features
//   patch  fixes only
// Examples: p0.2.0 (this build), a0.1.0 (first alpha), b1.0.0, 1.0.0.

export const WICK_VERSION = 'p0.2.0';

const STAGES = { p: 'pre-alpha', a: 'alpha', b: 'beta' };
export const WICK_STAGE = STAGES[WICK_VERSION[0]] ?? 'release';
