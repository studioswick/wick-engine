// Wick Engine core bridge: loads the WASM build of core/ (Lua VM + WickGuard policy) and wraps its C exports.

const NOT_READY = () => '!engine host is not ready';

export class WickCore {
  constructor() {
    /** Set by the runtime: (op, id, a, b) -> reply string. Must never throw. */
    this.hostHandler = NOT_READY;
  }

  static async load() {
    const core = new WickCore();
    let factory;
    try {
      ({ default: factory } = await import('../../wasm/wick_core.js'));
    } catch (err) {
      throw new Error('Wick core (WASM) is missing. Run ./build.sh locally or let the GitHub Pages workflow build it.', { cause: err });
    }
    const m = await factory({ wickHost: (op, id, a, b) => core.hostHandler(op, id, a, b) });
    core.m = m;
    const fn = (name, ret, args) => m.cwrap(name, ret, args);
    core._open = fn('wick_vm_open', 'number', ['number']);
    core._close = fn('wick_vm_close', null, []);
    core._run = fn('wick_vm_run', 'number', ['number', 'number']);
    core._step = fn('wick_vm_step', 'number', ['number']);
    core._event = fn('wick_vm_event', null, ['number', 'number']);
    core._lastMs = fn('wick_vm_last_ms', 'number', []);
    core._heap = fn('wick_vm_heap_bytes', 'number', []);
    core._fatal = fn('wick_vm_fatal', 'number', []);
    core._gReset = fn('wick_guard_reset', null, ['number', 'number', 'number']);
    core._gTick = fn('wick_guard_tick', 'number', ['number', 'number', 'number', 'number', 'number']);
    core._gTier = fn('wick_guard_tier', 'number', []);
    core._gReason = fn('wick_guard_reason', 'number', []);
    return core;
  }

  // Strings go through the heap rather than the stack: script sources can be large.
  _withStrings(strs, fn) {
    const m = this.m;
    const ptrs = strs.map((s) => {
      const size = m.lengthBytesUTF8(s) + 1;
      const p = m._malloc(size);
      m.stringToUTF8(s, p, size);
      return p;
    });
    try { return fn(...ptrs); } finally { ptrs.forEach((p) => m._free(p)); }
  }

  open(heapMB = 96) { return this._open(heapMB); }
  close() { this._close(); }
  run(name, source) { return this._withStrings([name, source], (a, b) => this._run(a, b)); }
  /** 0 ok, 1 a script errored (already logged), 2 fatal (stop the game). */
  step(dt) { return this._step(dt); }
  event(name, payload) { this._withStrings([name, payload], (a, b) => this._event(a, b)); }
  get lastScriptMs() { return this._lastMs(); }
  get heapBytes() { return this._heap(); }
  get fatal() { return this._fatal() === 1; }

  guardReset(maxBodies, fixedTier, startTier) { this._gReset(maxBodies, fixedTier, startTier); }
  /** 0 nothing, 1 lower the quality tier, 2 stop the game. */
  guardTick(frameMs, scriptMs, heapRatio, bodies, playing) {
    return this._gTick(frameMs, scriptMs, heapRatio, bodies, playing ? 1 : 0);
  }
  get guardTier() { return this._gTier(); }
  get guardReason() { return this._gReason(); }
}
