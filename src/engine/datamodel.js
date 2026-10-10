// Wick Engine data model: the instance tree every system (Studio, renderer, physics, Lua) shares.
// Pure data and events. No DOM and no Babylon, so it can run headless.

export const WICK_LIMITS = Object.freeze({ maxParts: 2500, maxSourceChars: 200000 });

export const SHAPES = ['Block', 'Ball', 'Cylinder'];
export const MATERIALS = ['Plastic', 'Metal', 'Glass', 'Neon', 'Wood'];

// Property schema helpers. `cat` groups a property in the Properties panel.
const num = (def, o = {}) => ({ type: 'number', default: def, ...o });
const bool = (def, o = {}) => ({ type: 'boolean', default: def, ...o });
const vec = (def, o = {}) => ({ type: 'vector3', default: def, ...o });
const col = (def, o = {}) => ({ type: 'color', default: def, ...o });
const en = (options, def, o = {}) => ({ type: 'enum', options, default: def, ...o });

export const CLASS_DEFS = {
  DataModel: { creatable: false, props: {} },
  Workspace: {
    creatable: false, service: true,
    props: { Gravity: num(9.81, { min: 0, max: 100, step: 0.1, cat: 'Physics' }) },
  },
  Lighting: {
    creatable: false, service: true,
    props: {
      ClockTime: num(14, { min: 0, max: 24, step: 0.25, cat: 'Environment' }),
      Brightness: num(1.6, { min: 0, max: 5, step: 0.1, cat: 'Environment' }),
      ShadowsEnabled: bool(true, { cat: 'Environment' }),
      Bloom: bool(true, { cat: 'Environment' }),
    },
  },
  Scripts: { creatable: false, service: true, props: {} },
  Folder: { props: {} },
  Part: {
    props: {
      Shape: en(SHAPES, 'Block', { cat: 'Appearance' }),
      Color: col([0.64, 0.66, 0.72], { cat: 'Appearance' }),
      Material: en(MATERIALS, 'Plastic', { cat: 'Appearance' }),
      Transparency: num(0, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }),
      CastShadow: bool(true, { cat: 'Appearance' }),
      Position: vec([0, 5, 0], { min: -1e5, max: 1e5, step: 0.5, cat: 'Transform' }),
      Rotation: vec([0, 0, 0], { min: -36000, max: 36000, step: 5, cat: 'Transform' }),
      Size: vec([4, 1, 2], { min: 0.05, max: 2048, step: 0.5, cat: 'Transform' }),
      Anchored: bool(false, { cat: 'Physics' }),
      CanCollide: bool(true, { cat: 'Physics' }),
      Density: num(1, { min: 0.01, max: 100, step: 0.1, cat: 'Physics' }),
      Bounciness: num(0.2, { min: 0, max: 1, step: 0.05, cat: 'Physics' }),
      Friction: num(0.6, { min: 0, max: 2, step: 0.05, cat: 'Physics' }),
      // Scripts read and write Velocity while playing; it is never saved.
      Velocity: vec([0, 0, 0], { min: -1e4, max: 1e4, hidden: true, runtime: true }),
    },
  },
  PointLight: {
    props: {
      Color: col([1, 0.85, 0.6], { cat: 'Light' }),
      Brightness: num(2, { min: 0, max: 50, step: 0.25, cat: 'Light' }),
      Range: num(24, { min: 1, max: 500, step: 1, cat: 'Light' }),
    },
  },
  Sound: {
    props: {
      SoundId: { type: 'string', default: 'wick://tone/hum', cat: 'Sound', suggest: ['wick://tone/hum', 'wick://tone/thud'] },
      Volume: num(0.6, { min: 0, max: 2, step: 0.05, cat: 'Sound' }),
      Looped: bool(false, { cat: 'Sound' }),
      PlayOnStart: bool(false, { cat: 'Sound' }),
      Spatial: bool(true, { cat: 'Sound' }),
      MaxDistance: num(60, { min: 1, max: 1000, step: 1, cat: 'Sound' }),
    },
  },
  Script: {
    props: {
      Source: { type: 'source', default: '-- New Wick script\nprint("Hello from Wick Engine!")\n', cat: 'Script' },
      Disabled: bool(false, { cat: 'Script' }),
    },
  },
};

const NAME_DEF = { type: 'string', default: '', cat: 'Data' };

export function propDef(className, prop) {
  if (prop === 'Name') return NAME_DEF;
  return CLASS_DEFS[className]?.props[prop];
}

/** Ordered [name, def] pairs for a class, Name first. */
export function propList(className) {
  return [['Name', NAME_DEF], ...Object.entries(CLASS_DEFS[className]?.props ?? {})];
}

const clone = (v) => (Array.isArray(v) ? v.slice() : v);
const clamp = (n, lo, hi) => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, n));
const sameVal = (a, b) => (Array.isArray(a) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);

/** Validate and normalise a value against a schema entry. Throws a readable Error. */
export function coerce(def, v, prop) {
  switch (def.type) {
    case 'number': {
      const n = Number(v);
      if (typeof v === 'boolean' || !Number.isFinite(n)) throw new Error(`${prop} expects a number`);
      return clamp(n, def.min, def.max);
    }
    case 'boolean':
      if (typeof v !== 'boolean') throw new Error(`${prop} expects a boolean`);
      return v;
    case 'string':
      return String(v ?? '').slice(0, 256);
    case 'source': {
      const s = String(v ?? '');
      if (s.length > WICK_LIMITS.maxSourceChars) throw new Error(`Script is too long (limit ${WICK_LIMITS.maxSourceChars} characters)`);
      return s;
    }
    case 'enum':
      if (!def.options.includes(v)) throw new Error(`${prop} must be one of: ${def.options.join(', ')}`);
      return v;
    case 'vector3':
      if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        throw new Error(`${prop} expects a Vector3`);
      }
      return v.map((n) => clamp(n, def.min, def.max));
    case 'color':
      if (!Array.isArray(v) || v.length !== 3 || v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
        throw new Error(`${prop} expects a Color3`);
      }
      return v.map((n) => clamp(n, 0, 1));
    default:
      throw new Error(`Unsupported property type for ${prop}`);
  }
}

export class WickInstance {
  constructor(dm, id, className) {
    this.dm = dm;
    this.id = id;
    this.className = className;
    this.parent = null;
    this.children = [];
    this.destroyed = false;
    this.service = !!CLASS_DEFS[className].service;
    this.props = { Name: className };
    for (const [k, d] of Object.entries(CLASS_DEFS[className].props)) this.props[k] = clone(d.default);
  }
  get name() { return this.props.Name; }
  isA(cls) { return cls === 'Instance' || cls === this.className || (cls === 'BasePart' && this.className === 'Part'); }
}

export class WickDataModel {
  constructor() {
    this._handlers = {};
    /** Optional hook: (inst, prop) -> live value or undefined. Installed while playing. */
    this.liveRead = null;
    this.projectName = 'Untitled Project';
    this._initEmpty();
  }

  // ---- events: added(inst) removed(inst) changed(inst, prop) reparented(inst, oldParent) reset() ----
  on(evt, fn) {
    (this._handlers[evt] ||= []).push(fn);
    return () => { this._handlers[evt] = this._handlers[evt].filter((f) => f !== fn); };
  }
  emit(evt, ...args) {
    for (const fn of (this._handlers[evt] || []).slice()) fn(...args);
  }

  _initEmpty() {
    this._nextId = 1;
    this._byId = new Map();
    this._partCount = 0;
    this.root = this._make('DataModel');
    for (const cls of ['Workspace', 'Lighting', 'Scripts']) this._link(this._make(cls), this.root);
    this._bindServices();
  }

  _bindServices() {
    const find = (cls) => this.root.children.find((c) => c.className === cls);
    this.workspace = find('Workspace');
    this.lighting = find('Lighting');
    this.scripts = find('Scripts');
  }

  _make(className, wantedId = null) {
    if (className === 'Part' && this._partCount >= WICK_LIMITS.maxParts) {
      throw new Error(`Part limit reached (${WICK_LIMITS.maxParts})`);
    }
    const id = wantedId && !this._byId.has(wantedId) ? wantedId : this._nextId++;
    if (id >= this._nextId) this._nextId = id + 1;
    const inst = new WickInstance(this, id, className);
    this._byId.set(id, inst);
    if (className === 'Part') this._partCount++;
    return inst;
  }

  _link(child, parent) {
    child.parent = parent;
    parent.children.push(child);
  }

  find(id) { return this._byId.get(id); }
  get partCount() { return this._partCount; }

  *descendants(inst, includeSelf = false) {
    if (includeSelf) yield inst;
    for (const c of inst.children) yield* this.descendants(c, true);
  }

  isAncestor(maybeAncestor, inst) {
    for (let p = inst.parent; p; p = p.parent) if (p === maybeAncestor) return true;
    return false;
  }

  isInWorkspace(inst) {
    for (let p = inst; p; p = p.parent) if (p === this.workspace) return true;
    return false;
  }

  /** Scripts under Workspace or Scripts run when playing. */
  isRunnable(inst) {
    for (let p = inst.parent; p; p = p.parent) if (p === this.workspace || p === this.scripts) return true;
    return false;
  }

  fullName(inst) {
    const parts = [];
    for (let p = inst; p && p !== this.root; p = p.parent) parts.unshift(p.name);
    return parts.join('.');
  }

  findFirstChild(inst, name, recursive = false) {
    for (const c of inst.children) if (c.name === name) return c;
    if (recursive) {
      for (const c of inst.children) {
        const hit = this.findFirstChild(c, name, true);
        if (hit) return hit;
      }
    }
    return null;
  }

  // ---- creation / destruction ----
  create(className, parent = this.workspace, props = null) {
    const def = CLASS_DEFS[className];
    if (!def || def.creatable === false) throw new Error(`Unable to create an Instance of type "${className}"`);
    const inst = this._make(className);
    try {
      if (props) for (const [k, v] of Object.entries(props)) this._assign(inst, k, v);
    } catch (err) {
      this._discard(inst);
      throw err;
    }
    if (parent) {
      this._link(inst, parent);
      this.emit('added', inst);
    }
    return inst;
  }

  _discard(inst) {
    this._byId.delete(inst.id);
    if (inst.className === 'Part') this._partCount--;
    inst.destroyed = true;
  }

  destroy(inst) {
    if (inst.service || inst === this.root) throw new Error(`${inst.name} cannot be destroyed`);
    const all = [...this.descendants(inst, true)];
    if (inst.parent) inst.parent.children = inst.parent.children.filter((c) => c !== inst);
    inst.parent = null;
    for (const d of all.reverse()) {
      this._discard(d);
      this.emit('removed', d);
    }
  }

  setParent(inst, parent) {
    if (inst.service || inst === this.root) throw new Error(`${inst.name} cannot be moved`);
    if (parent && (parent === inst || this.isAncestor(inst, parent))) {
      throw new Error('An instance cannot be parented to itself or one of its descendants');
    }
    const old = inst.parent;
    if (old === parent) return;
    if (old) old.children = old.children.filter((c) => c !== inst);
    inst.parent = null;
    if (parent) this._link(inst, parent);
    this.emit('reparented', inst, old);
  }

  // ---- properties ----
  _assign(inst, prop, value) {
    const def = propDef(inst.className, prop);
    if (!def) throw new Error(`${prop} is not a valid property of ${inst.className}`);
    inst.props[prop] = coerce(def, value, prop);
  }

  get(inst, prop) {
    if (this.liveRead) {
      const live = this.liveRead(inst, prop);
      if (live !== undefined) return live;
    }
    return inst.props[prop];
  }

  set(inst, prop, value) {
    if (prop === 'Parent') { this.setParent(inst, value); return value; }
    const def = propDef(inst.className, prop);
    if (!def) throw new Error(`${prop} is not a valid property of ${inst.className}`);
    if (prop === 'Name' && inst.service) throw new Error(`${inst.name} cannot be renamed`);
    const v = coerce(def, value, prop);
    inst.props[prop] = v;
    this.emit('changed', inst, prop);
    return v;
  }

  // ---- serialization ----
  serializeNode(inst) {
    const props = {};
    const defs = CLASS_DEFS[inst.className].props;
    if (inst.props.Name !== inst.className) props.Name = inst.props.Name;
    for (const [k, d] of Object.entries(defs)) {
      if (d.runtime) continue;
      if (!sameVal(inst.props[k], d.default)) props[k] = clone(inst.props[k]);
    }
    return { id: inst.id, class: inst.className, props, children: inst.children.map((c) => this.serializeNode(c)) };
  }

  /** Build a detached subtree from serialized data; unknown classes and bad values are skipped. */
  _build(node, keepIds) {
    const def = CLASS_DEFS[node?.class];
    if (!def || (def.creatable === false && !def.service && node.class !== 'DataModel')) return null;
    const inst = this._make(node.class, keepIds ? node.id : null);
    for (const [k, v] of Object.entries(node.props || {})) {
      try { this._assign(inst, k, v); } catch { /* ignore stale or invalid saved values */ }
    }
    for (const ch of node.children || []) {
      const c = this._build(ch, keepIds);
      if (c) this._link(c, inst);
    }
    return inst;
  }

  /** Clone or paste serialized data under `parent`. Fresh ids unless `keepIds`. */
  instantiate(node, parent, { keepIds = false } = {}) {
    const inst = this._build(node, keepIds);
    if (!inst) throw new Error('Nothing to paste');
    if (parent) {
      this._link(inst, parent);
      for (const d of this.descendants(inst, true)) this.emit('added', d);
    }
    return inst;
  }

  clone(inst, parent = inst.parent) {
    return this.instantiate(this.serializeNode(inst), parent);
  }

  toJSON() {
    return { format: 'wick-project', version: 1, name: this.projectName, nextId: this._nextId, root: this.serializeNode(this.root) };
  }

  load(data) {
    if (!data || data.format !== 'wick-project' || data.root?.class !== 'DataModel') {
      throw new Error('This is not a Wick Engine project file');
    }
    if (data.version > 1) throw new Error('This project was saved by a newer Wick Engine');
    this._nextId = 1;
    this._byId = new Map();
    this._partCount = 0;
    this.root = this._build(data.root, true);
    for (const cls of ['Workspace', 'Lighting', 'Scripts']) {
      if (!this.root.children.some((c) => c.className === cls)) this._link(this._make(cls), this.root);
    }
    this._bindServices();
    this._nextId = Math.max(this._nextId, data.nextId || 1);
    this.projectName = String(data.name || 'Untitled Project').slice(0, 80);
    this.emit('reset');
  }

  /** Empty project: services plus a baseplate. */
  loadBlank(name = 'Untitled Project') {
    this._initEmpty();
    this.projectName = name;
    this.create('Part', this.workspace, {
      Name: 'Baseplate', Size: [120, 1, 120], Position: [0, -0.5, 0], Anchored: true, CastShadow: false,
      Color: [0.36, 0.52, 0.34],
    });
    this.emit('reset');
  }
}
