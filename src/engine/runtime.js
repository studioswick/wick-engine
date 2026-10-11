// Wick Engine runtime: one Play session from start to stop.
// Play snapshots the project, builds physics and audio, starts the Lua VM and runs every Script.
// Pause freezes scripts, physics and audio while the viewport stays live. Stop tears everything down and
// reloads the snapshot, so nothing a game does leaks into the project.

import { propDef } from './datamodel.js';

const SEP = '\x1f';
const MAX_TOUCH_EVENTS_PER_FRAME = 64;
const MAX_LOG_PER_SECOND = 300;

const KEY_NAMES = { ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl', AltLeft: 'LeftAlt', AltRight: 'RightAlt', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };

/** Maps KeyboardEvent.code to the key names scripts see ("W", "Space", "LeftShift", "Up"...). */
export function keyName(code) {
  return KEY_NAMES[code] ?? code.replace(/^Key/, '').replace(/^Digit/, '');
}

const clean = (s) => String(s).replace(/[\0\x1f]/g, ' ');

// ---- value encoding shared with core/wick_runtime.lua ----
function encode(def, v) {
  if (v === undefined || v === null) return 'z';
  switch (def.type) {
    case 'number': return `n${v}`;
    case 'boolean': return v ? 'b1' : 'b0';
    case 'vector3': return `v${v.join(',')}`;
    case 'color': return `c${v.join(',')}`;
    default: return `s${clean(v)}`;
  }
}

const TAG_FOR_TYPE = { number: 'n', boolean: 'b', string: 's', source: 's', enum: 's', vector3: 'v', color: 'c' };

export class WickRuntime {
  constructor({ dm, world, physics, audio, core, guard, limits, log }) {
    Object.assign(this, { dm, world, physics, audio, core, guard, limits, log });
    this.playing = false;
    this.paused = false;
    this.autoPaused = false; // paused because the tab was hidden, so it resumes when the tab returns
    this.starting = false;
    this.scriptMs = 0;
    this.events = [];
    this.onStateChange = null; // (playing, reason|null) => void
    this.onPauseChange = null; // (paused) => void
    this._offs = [];
    this._down = new Map(); // input name -> device ('Keyboard' | 'Mouse') for every key or button held right now
    physics.onTouched = (id, other) => {
      if (this.events.length < 1024) this.events.push(['touched', [`i${id}`, `i${other}`]]);
    };
    physics.onImpact = (a, b, strength, at, mass) => { if (this.playing) this.audio.impact(a, b, strength, at, mass); };
    // While paused the guard only watches graphics: nothing is running that could hang or run away.
    guard.context = () => ({ playing: this.playing && !this.paused, scriptMs: this.scriptMs, bodies: physics.count });
  }

  get heapBytes() { return this.playing ? this.core.heapBytes : 0; }

  // ------------------------------------------------------------------ lifecycle

  async play() {
    if (this.playing || this.starting) return;
    this.starting = true;
    const { dm, world, core, physics } = this;
    try {
      this.snapshot = dm.toJSON();
      this._logWindow = { start: performance.now(), count: 0, warned: false };
      this.events.length = 0;

      const lim = this.limits.values;
      core.hostHandler = (op, id, a, b) => this._host(op, id, a, b);
      if (core.open(lim.luaHeapMB, lim.scriptSliceMs, lim.scriptFrameMs) !== 0) throw new Error('The Lua VM failed to start');

      this.playing = true;
      this._setPaused(false);
      this._down.clear();
      world.setPlaying(true);
      physics.start(dm.workspace.props.Gravity);
      world.hooks = {
        created: (inst, mesh) => physics.add(inst, mesh),
        changed: (inst, prop, mesh) => this._partChanged(inst, prop, mesh),
        willDispose: (inst) => physics.remove(inst.id),
      };
      for (const [id, mesh] of world.meshes) physics.add(dm.find(id), mesh);
      dm.liveRead = (inst, prop) => this._live(inst, prop);
      this._offs.push(
        dm.on('changed', (inst, prop) => this._changed(inst, prop)),
        dm.on('removed', (inst) => { if (inst.className === 'Sound') this.audio.remove(inst.id); }),
      );
      this._tickObs = world.scene.onBeforeRenderObservable.add(() => this._tick());
      this.guard.reset(true);
      this.onStateChange?.(true, null);

      await this.audio.start();
      for (const s of dm.descendants(dm.root)) if (s.className === 'Sound' && dm.isRunnable(s)) this._addSound(s);

      for (const s of [...dm.descendants(dm.scripts), ...dm.descendants(dm.workspace)]) {
        if (s.className === 'Script' && !s.props.Disabled) core.run(s.name, s.props.Source);
      }
    } catch (err) {
      this.log('error', `Could not start the game: ${err.message || err}`);
      this.stop();
    } finally {
      this.starting = false;
    }
  }

  stop(reason = null) {
    if (!this.playing) return;
    const { dm, world } = this;
    this.playing = false;
    this._setPaused(false);
    this._down.clear();
    world.scene.onBeforeRenderObservable.remove(this._tickObs);
    this._offs.forEach((off) => off());
    this._offs = [];
    dm.liveRead = null;
    this.core.close();
    this.audio.dispose();
    this.physics.stop();
    world.hooks = {};
    this.events.length = 0;
    this.scriptMs = 0;
    dm.load(this.snapshot);
    world.setPlaying(false);
    this.snapshot = null;
    this.onStateChange?.(false, reason);
  }

  // ------------------------------------------------------------------ pause

  _setPaused(paused, auto = false) {
    this.paused = paused;
    this.autoPaused = paused && auto;
    this.world.paused = paused;
    this.onPauseChange?.(paused);
  }

  /** Freezes the game. auto marks a pause made because the tab was hidden. */
  pause(auto = false) {
    if (!this.playing || this.paused) return;
    this.releaseInputs(); // deliver key and button releases so no input stays stuck in Lua while frozen
    this._flushEvents();
    this._setPaused(true, auto);
    this.physics.setPaused(true);
    this.audio.pause();
  }

  resume() {
    if (!this.playing || !this.paused) return;
    this._setPaused(false);
    this.physics.setPaused(false);
    this.audio.resume();
    this.guard.reset(true); // the pause is not a slow frame
  }

  // ------------------------------------------------------------------ per-frame

  _tick() {
    if (!this.playing || this.paused) return;
    const t0 = performance.now();
    const dt = Math.min(this.world.engine.getDeltaTime() / 1000, 0.1);
    this._flushEvents();
    const rc = this.core.step(dt);
    this.scriptMs = performance.now() - t0;
    if (rc === 2 || this.core.fatal) {
      this.log('error', 'Script memory limit reached. The game was stopped.');
      // Stopping rebuilds the scene, so wait until the current frame has finished rendering.
      queueMicrotask(() => this.stop('Scripts used more memory than the game is allowed.'));
    }
  }

  _flushEvents() {
    let touches = 0;
    for (const [name, items] of this.events.splice(0)) {
      if (name === 'touched' && ++touches > MAX_TOUCH_EVENTS_PER_FRAME) continue;
      this.core.event(name, items.join(SEP));
    }
  }

  _input(down, name, device) {
    if (!this.playing || this.paused) return;
    if (down) {
      if (this._down.has(name)) return; // key repeat
      this._down.set(name, device);
    } else if (!this._down.delete(name)) {
      return; // released something that was not pressed during this session
    }
    this.events.push(['input', [down ? 'sbegin' : 'send', `s${name}`, `s${device}`]]);
  }

  onKey(code, down) { this._input(down, keyName(code), 'Keyboard'); }
  onMouse(button, down) { this._input(down, button, 'Mouse'); }

  /** Ends every held key and button (window lost focus, or the game is pausing). */
  releaseInputs() {
    if (!this.playing) return;
    for (const [name, device] of this._down) this.events.push(['input', ['send', `s${name}`, `s${device}`]]);
    this._down.clear();
  }

  // ------------------------------------------------------------------ live reads and reactions

  _live(inst, prop) {
    if (inst.className !== 'Part') return undefined;
    if (prop === 'Position' || prop === 'Rotation') {
      const t = this.world.liveTransform(inst.id);
      return t ? (prop === 'Position' ? t.position : t.rotation) : undefined;
    }
    if (prop === 'Velocity' && this.physics.bodies.has(inst.id)) return this.physics.getVelocity(inst.id);
    return undefined;
  }

  _partChanged(inst, prop, mesh) {
    const { physics } = this;
    if (prop === 'Position' || prop === 'Rotation') physics.teleport(inst.id);
    else if (prop === 'Velocity') physics.setVelocity(inst.id, inst.props.Velocity);
    else if (['Size', 'Anchored', 'CanCollide', 'Density', 'Bounciness', 'Friction', 'Material'].includes(prop)) physics.add(inst, mesh);
  }

  _changed(inst, prop) {
    if (inst === this.dm.workspace && prop === 'Gravity') this.physics.setGravity(inst.props.Gravity);
    else if (inst.className === 'Sound' && ['Volume', 'Looped', 'MaxDistance'].includes(prop)) this.audio.update(inst);
  }

  _addSound(inst) {
    const mesh = inst.parent?.className === 'Part' ? this.world.meshes.get(inst.parent.id) : null;
    return this.audio.add(inst, mesh);
  }

  // ------------------------------------------------------------------ Lua host bridge

  _inst(id) {
    const inst = this.dm.find(id);
    if (!inst) throw new Error('this Instance has been destroyed');
    return inst;
  }

  /** Decodes one tagged value from Lua. Instances come back as WickInstance objects. */
  _decode(s) {
    const body = s.slice(1);
    switch (s[0]) {
      case 'z': return null;
      case 'b': return body === '1';
      case 'n': return Number(body);
      case 's': return body;
      case 'v': case 'c': return body.split(',').map(Number);
      case 'i': return this._inst(Number(body));
      default: throw new Error('unreadable value from script');
    }
  }

  _decodeFor(def, prop, s) {
    if (s[0] !== TAG_FOR_TYPE[def.type]) {
      const names = { number: 'a number', boolean: 'a boolean', string: 'a string', source: 'a string', enum: 'a string', vector3: 'a Vector3', color: 'a Color3' };
      throw new Error(`${prop} expects ${names[def.type]}`);
    }
    return this._decode(s);
  }

  _host(op, id, a, b) {
    try {
      switch (op) {
        case 'log': return this._logFromLua(a, b);
        case 'root': return `i${this.dm.root.id}`;
        case 'get': return this._get(this._inst(id), a);
        case 'set': return this._set(this._inst(id), a, b);
        case 'new': return this._new(a, b);
        case 'call': return this._call(this._inst(id), a, b);
        case 'listen':
          if (a !== 'Touched' || this._inst(id).className !== 'Part') throw new Error(`${a} is not a valid event`);
          this.physics.listen(id);
          return '';
        case 'camget': return this._camera(a);
        default: throw new Error(`unknown host call "${op}"`);
      }
    } catch (err) {
      return `!${clean(err.message || err)}`;
    }
  }

  _logFromLua(level, text) {
    const w = this._logWindow;
    const now = performance.now();
    if (now - w.start > 1000) { w.start = now; w.count = 0; w.warned = false; }
    if (++w.count > MAX_LOG_PER_SECOND) {
      if (!w.warned) { w.warned = true; this.log('warn', 'Output is being throttled: too many messages per second.'); }
      return '';
    }
    this.log(level, text.slice(0, 2000));
    return '';
  }

  _get(inst, prop) {
    if (prop === 'ClassName') return `s${inst.className}`;
    if (prop === 'Parent') return inst.parent ? `i${inst.parent.id}` : 'z';
    const def = propDef(inst.className, prop);
    if (def) return encode(def, this.dm.get(inst, prop));
    const child = this.dm.findFirstChild(inst, prop); // workspace.Wall style access
    if (child) return `i${child.id}`;
    throw new Error(`${prop} is not a valid member of ${inst.className}`);
  }

  _set(inst, prop, enc) {
    if (prop === 'ClassName') throw new Error('ClassName is read-only');
    if (prop === 'Parent') {
      this.dm.setParent(inst, this._decode(enc));
      return '';
    }
    const def = propDef(inst.className, prop);
    if (!def) throw new Error(`${prop} is not a valid member of ${inst.className}`);
    this.dm.set(inst, prop, this._decodeFor(def, prop, enc));
    return '';
  }

  _new(className, parentEnc) {
    if (typeof className !== 'string') throw new Error('Instance.new expects a class name');
    const parent = this._decode(parentEnc);
    return `i${this.dm.create(className, parent).id}`;
  }

  _call(inst, method, argsText) {
    const { dm } = this;
    const args = argsText === '' ? [] : argsText.split(SEP).map((s) => this._decode(s));
    const ids = (list) => `L${list.map((c) => `i${c.id}`).join(SEP)}`;
    const needs = (cls) => {
      if (inst.className !== cls) throw new Error(`${method} is not a valid method of ${inst.className}`);
    };
    switch (method) {
      case 'Destroy': dm.destroy(inst); return 'z';
      case 'Clone': return `i${dm.clone(inst, null).id}`;
      case 'GetChildren': return ids(inst.children);
      case 'GetDescendants': return ids([...dm.descendants(inst)]);
      case 'FindFirstChild': {
        const hit = dm.findFirstChild(inst, String(args[0] ?? ''), !!args[1]);
        return hit ? `i${hit.id}` : 'z';
      }
      case 'IsA': return inst.isA(String(args[0])) ? 'b1' : 'b0';
      case 'GetFullName': return `s${clean(dm.fullName(inst))}`;
      case 'ApplyImpulse':
        needs('Part');
        if (!Array.isArray(args[0])) throw new Error('ApplyImpulse expects a Vector3');
        this.physics.applyImpulse(inst.id, args[0]);
        return 'z';
      case 'Play':
        needs('Sound');
        if (this.audio.sounds.has(inst.id)) this.audio.play(inst.id);
        else this._addSound(inst)?.then(() => this.audio.play(inst.id)); // created lazily so script-set properties apply
        return 'z';
      case 'Stop':
        needs('Sound');
        this.audio.stop(inst.id);
        return 'z';
      default: throw new Error(`${method} is not a valid method`);
    }
  }

  _camera(prop) {
    const c = this.world.cameraInfo();
    if (prop === 'Position') return `v${c.position.join(',')}`;
    if (prop === 'LookVector') return `v${c.look.join(',')}`;
    throw new Error(`${prop} is not a valid member of Camera`);
  }
}