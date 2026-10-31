// Wick Engine data model: the instance tree every system (Studio, renderer, physics, Lua, UI) shares.
// Pure data and events. No DOM and no Babylon, so it can run headless.

import { WICK_SOUNDS, soundId, WICK_TEXTURES, textureId, VOID_TEXTURE, WICK_MESHES, meshId } from './library.js';
import { WickAssets, assetUri } from './assets.js';
import { WICK_VERSION } from '../version.js';

/** Hard limits. maxParts is set by WickGuard from the device's performance (see guard.js). */
export const WICK_LIMITS = { maxParts: 2500, maxSourceChars: 200000 };

export const SHAPES = ['Block', 'Ball', 'Cylinder', 'Mesh'];
export const MATERIALS = ['Plastic', 'Metal', 'Glass', 'Neon', 'Wood', 'Grass'];
export const SERVICES = ['Workspace', 'Lighting', 'Scripts', 'Gui'];
export const GRAPHICS_FLOORS = ['Minimal', 'Low', 'Medium', 'High'];

/**
 * How each material behaves. grip scales Friction, bounce scales Bounciness, roll is the rolling resistance of
 * round parts, soft is how much the surface deadens impact sounds (0 rings, 1 thuds).
 */
export const SURFACES = {
  Plastic: { grip: 1.0, bounce: 1.0, roll: 0.25, soft: 0.35 },
  Metal: { grip: 0.75, bounce: 0.9, roll: 0.12, soft: 0.05 },
  Glass: { grip: 0.55, bounce: 0.8, roll: 0.12, soft: 0.05 },
  Neon: { grip: 0.9, bounce: 1.0, roll: 0.2, soft: 0.3 },
  Wood: { grip: 1.15, bounce: 0.7, roll: 0.3, soft: 0.55 },
  Grass: { grip: 1.5, bounce: 0.35, roll: 0.6, soft: 0.9 },
};

// Property schema helpers. `cat` groups a property in the Properties panel; `when(props)` hides it when false.
const num = (def, o = {}) => ({ type: 'number', default: def, ...o });
const bool = (def, o = {}) => ({ type: 'boolean', default: def, ...o });
const vec = (def, o = {}) => ({ type: 'vector3', default: def, ...o });
const vec2 = (def, o = {}) => ({ type: 'vector2', default: def, min: -1e5, max: 1e5, ...o });
const udim = (def, o = {}) => ({ type: 'udim2', default: def, ...o });
const col = (def, o = {}) => ({ type: 'color', default: def, ...o });
const en = (options, def, o = {}) => ({ type: 'enum', options, default: def, ...o });
const str = (def, o = {}) => ({ type: 'string', default: def, ...o });

const textureSuggest = (dm) => [...WICK_TEXTURES.map(textureId), VOID_TEXTURE, ...dm.assets.ids('texture').map(assetUri)];
const meshSuggest = (dm) => [...WICK_MESHES.map(meshId), ...dm.assets.ids('mesh').map(assetUri)];
const soundSuggest = (dm) => [...WICK_SOUNDS.map(soundId), ...dm.assets.ids('sound').map(assetUri)];
const imageSuggest = (dm) => [...WICK_TEXTURES.map(textureId), ...dm.assets.ids('texture').map(assetUri)];

// ---- UI schema pieces ----
const guiObject = (extra = {}) => ({
  Position: udim([0, 0, 0, 0], { cat: 'Layout' }),
  Size: udim([0, 160, 0, 48], { cat: 'Layout' }),
  AnchorPoint: vec2([0, 0], { cat: 'Layout', step: 0.5 }),
  Rotation: num(0, { min: -3600, max: 3600, step: 1, cat: 'Layout' }),
  ZIndex: num(1, { min: -1000, max: 1000, step: 1, cat: 'Layout' }),
  LayoutOrder: num(0, { min: -100000, max: 100000, step: 1, cat: 'Layout' }),
  Visible: bool(true, { cat: 'Layout' }),
  ClipsDescendants: bool(false, { cat: 'Layout' }),
  BackgroundColor: col([0.18, 0.2, 0.27], { cat: 'Appearance' }),
  BackgroundTransparency: num(0, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }),
  ...extra,
});
const textProps = (text, o = {}) => ({
  Text: str(text, { max: 2000, cat: 'Text' }),
  TextColor: col([1, 1, 1], { cat: 'Text' }),
  TextSize: num(16, { min: 4, max: 200, step: 1, cat: 'Text' }),
  Font: en(['Sans', 'Serif', 'Mono', 'Display'], 'Sans', { cat: 'Text' }),
  TextXAlignment: en(['Left', 'Center', 'Right'], 'Center', { cat: 'Text' }),
  TextYAlignment: en(['Top', 'Center', 'Bottom'], 'Center', { cat: 'Text' }),
  TextWrapped: bool(false, { cat: 'Text' }),
  TextTransparency: num(0, { min: 0, max: 1, step: 0.05, cat: 'Text' }),
  ...o,
});
const imageProps = () => ({
  Image: str('', { cat: 'Image', suggest: imageSuggest }),
  ImageColor: col([1, 1, 1], { cat: 'Image' }),
  ImageTransparency: num(0, { min: 0, max: 1, step: 0.05, cat: 'Image' }),
  ScaleType: en(['Stretch', 'Fit', 'Crop'], 'Stretch', { cat: 'Image' }),
});
const autoColor = () => ({ AutoButtonColor: bool(true, { cat: 'Appearance' }) });

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
      DayLength: num(0, { min: 0, max: 3600, step: 10, cat: 'Environment' }), // seconds per 24 hours while playing; 0 keeps the time fixed
      Brightness: num(1.6, { min: 0, max: 5, step: 0.1, cat: 'Environment' }),
      FogDensity: num(0.0012, { min: 0, max: 0.05, step: 0.0005, cat: 'Environment' }),
      ShadowsEnabled: bool(true, { cat: 'Environment' }),
      Bloom: bool(true, { cat: 'Environment' }),
      CloudsEnabled: bool(true, { cat: 'Sky' }),
      CloudCoverage: num(0.5, { min: 0, max: 1, step: 0.05, cat: 'Sky' }),
      CloudDensity: num(0.6, { min: 0, max: 1, step: 0.05, cat: 'Sky' }),
      CloudHeight: num(260, { min: 60, max: 1200, step: 10, cat: 'Sky' }),
      WindStrength: num(0.35, { min: 0, max: 1, step: 0.05, cat: 'Wind' }), // sways grass and drifts clouds
      WindDirection: num(45, { min: 0, max: 360, step: 5, cat: 'Wind' }),
      MinGraphics: en(GRAPHICS_FLOORS, 'Minimal', { cat: 'Graphics' }), // the lowest quality tier the game may run at
    },
  },
  Scripts: { creatable: false, service: true, props: {} },
  Gui: { creatable: false, service: true, props: {} },
  Folder: { props: {} },
  Model: { props: {} },
  Part: {
    props: {
      Shape: en(SHAPES, 'Block', { cat: 'Appearance' }),
      MeshId: str('', { cat: 'Appearance', suggest: meshSuggest, when: (p) => p.Shape === 'Mesh' }),
      Color: col([0.64, 0.66, 0.72], { cat: 'Appearance' }),
      Material: en(MATERIALS, 'Plastic', { cat: 'Appearance' }),
      Texture: str('', { cat: 'Appearance', suggest: textureSuggest }),
      TextureColor: col([0, 0, 0], { cat: 'Appearance', when: (p) => p.Texture === VOID_TEXTURE }),
      Transparency: num(0, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }),
      CastShadow: bool(true, { cat: 'Appearance' }),
      Position: vec([0, 5, 0], { min: -1e5, max: 1e5, step: 0.5, cat: 'Transform' }),
      Rotation: vec([0, 0, 0], { min: -36000, max: 36000, step: 5, cat: 'Transform' }),
      Size: vec([4, 1, 2], { min: 0.05, max: 2048, step: 0.5, cat: 'Transform' }),
      Anchored: bool(false, { cat: 'Physics' }),
      CanCollide: bool(true, { cat: 'Physics' }),
      LockRotation: bool(false, { cat: 'Physics' }), // a body that never tips over (characters)
      CollisionFidelity: en(['Box', 'Hull'], 'Box', { cat: 'Physics', when: (p) => p.Shape === 'Mesh' }),
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
      // PBR lights fall off with the inverse square of distance, so useful values run into the hundreds.
      Brightness: num(60, { min: 0, max: 100000, step: 1, cat: 'Light' }),
      Range: num(30, { min: 1, max: 500, step: 1, cat: 'Light' }),
    },
  },
  // Where the game camera is. One per project, attached to a Part in the Workspace.
  CameraPoint: {
    props: {
      Offset: vec([0, 0, 0], { min: -1000, max: 1000, step: 0.5, cat: 'Camera' }), // relative to the Part, in its own axes
      FieldOfView: num(70, { min: 20, max: 120, step: 1, cat: 'Camera' }),
      Lock: en(['Part', 'Position'], 'Part', { cat: 'Camera' }), // Part: also copy its rotation. Position: only follow it, the view stays free
    },
  },
  Sound: {
    props: {
      SoundId: str(soundId('hum'), { cat: 'Sound', suggest: soundSuggest }),
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

  // ---- user interface ----
  ScreenGui: { props: { Enabled: bool(true, { cat: 'Behavior' }), DisplayOrder: num(0, { min: -1000, max: 1000, step: 1, cat: 'Behavior' }) } },
  Frame: { props: guiObject({ Size: udim([0, 240, 0, 140], { cat: 'Layout' }) }) },
  TextLabel: { props: guiObject({ BackgroundTransparency: num(1, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }), ...textProps('Label') }) },
  TextButton: {
    props: guiObject({ BackgroundColor: col([0.96, 0.65, 0.14], { cat: 'Appearance' }), ...autoColor(), ...textProps('Button', { TextColor: col([0.1, 0.07, 0.02], { cat: 'Text' }) }) }),
  },
  TextBox: {
    props: guiObject({
      BackgroundColor: col([0.1, 0.12, 0.17], { cat: 'Appearance' }),
      ...textProps('', { TextXAlignment: en(['Left', 'Center', 'Right'], 'Left', { cat: 'Text' }) }),
      PlaceholderText: str('Type here...', { max: 200, cat: 'Text' }),
      ClearTextOnFocus: bool(false, { cat: 'Behavior' }),
    }),
  },
  ImageLabel: { props: guiObject({ BackgroundTransparency: num(1, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }), Size: udim([0, 100, 0, 100], { cat: 'Layout' }), ...imageProps() }) },
  ImageButton: { props: guiObject({ BackgroundTransparency: num(1, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }), Size: udim([0, 100, 0, 100], { cat: 'Layout' }), ...autoColor(), ...imageProps() }) },
  ScrollingFrame: {
    props: guiObject({
      Size: udim([0, 240, 0, 180], { cat: 'Layout' }),
      CanvasSize: udim([0, 0, 0, 600], { cat: 'Layout' }), // scale 0 means "as wide as the frame"
      ScrollBarThickness: num(8, { min: 0, max: 40, step: 1, cat: 'Appearance' }),
      ScrollingEnabled: bool(true, { cat: 'Behavior' }),
    }),
  },
  // Children of a GuiObject that change how it looks or lays out its own children.
  UICorner: { props: { CornerRadius: num(8, { min: 0, max: 1000, step: 1, cat: 'Appearance' }) } },
  UIStroke: { props: { Color: col([0, 0, 0], { cat: 'Appearance' }), Thickness: num(1, { min: 0, max: 50, step: 0.5, cat: 'Appearance' }), Transparency: num(0, { min: 0, max: 1, step: 0.05, cat: 'Appearance' }) } },
  UIPadding: {
    props: {
      PaddingTop: num(8, { min: 0, max: 1000, step: 1, cat: 'Layout' }), PaddingBottom: num(8, { min: 0, max: 1000, step: 1, cat: 'Layout' }),
      PaddingLeft: num(8, { min: 0, max: 1000, step: 1, cat: 'Layout' }), PaddingRight: num(8, { min: 0, max: 1000, step: 1, cat: 'Layout' }),
    },
  },
  UIListLayout: {
    props: {
      FillDirection: en(['Vertical', 'Horizontal'], 'Vertical', { cat: 'Layout' }),
      Padding: num(6, { min: 0, max: 1000, step: 1, cat: 'Layout' }),
      HorizontalAlignment: en(['Left', 'Center', 'Right'], 'Left', { cat: 'Layout' }),
      VerticalAlignment: en(['Top', 'Center', 'Bottom'], 'Top', { cat: 'Layout' }),
      SortOrder: en(['LayoutOrder', 'Name'], 'LayoutOrder', { cat: 'Layout' }),
    },
  },
  UIGridLayout: {
    props: {
      CellSize: udim([0, 100, 0, 100], { cat: 'Layout' }), CellPadding: udim([0, 6, 0, 6], { cat: 'Layout' }),
      FillDirection: en(['Horizontal', 'Vertical'], 'Horizontal', { cat: 'Layout' }),
      SortOrder: en(['LayoutOrder', 'Name'], 'LayoutOrder', { cat: 'Layout' }),
    },
  },
  UIAspectRatioConstraint: { props: { AspectRatio: num(1, { min: 0.1, max: 10, step: 0.1, cat: 'Layout' }) } },
  UIScale: { props: { Scale: num(1, { min: 0.05, max: 10, step: 0.05, cat: 'Layout' }) } },
  UIGradient: { props: { Color0: col([1, 1, 1], { cat: 'Appearance' }), Color1: col([0.6, 0.6, 0.6], { cat: 'Appearance' }), Rotation: num(90, { min: -360, max: 360, step: 5, cat: 'Appearance' }) } },
};

export const GUI_OBJECTS = new Set(['Frame', 'TextLabel', 'TextButton', 'TextBox', 'ImageLabel', 'ImageButton', 'ScrollingFrame']);
export const GUI_MODIFIERS = new Set(['UICorner', 'UIStroke', 'UIPadding', 'UIListLayout', 'UIGridLayout', 'UIAspectRatioConstraint', 'UIScale', 'UIGradient']);
export const isGuiObject = (cls) => GUI_OBJECTS.has(cls);
export const isGuiClass = (cls) => cls === 'ScreenGui' || GUI_OBJECTS.has(cls) || GUI_MODIFIERS.has(cls);

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
const numbers = (v, len) => Array.isArray(v) && v.length === len && v.every((n) => typeof n === 'number' && Number.isFinite(n));

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
      return String(v ?? '').slice(0, def.max ?? 256);
    case 'source': {
      const s = String(v ?? '');
      if (s.length > WICK_LIMITS.maxSourceChars) throw new Error(`Script is too long (limit ${WICK_LIMITS.maxSourceChars} characters)`);
      return s;
    }
    case 'enum':
      if (!def.options.includes(v)) throw new Error(`${prop} must be one of: ${def.options.join(', ')}`);
      return v;
    case 'vector3':
      if (!numbers(v, 3)) throw new Error(`${prop} expects a Vector3`);
      return v.map((n) => clamp(n, def.min, def.max));
    case 'vector2':
      if (!numbers(v, 2)) throw new Error(`${prop} expects a Vector2`);
      return v.map((n) => clamp(n, def.min, def.max));
    case 'udim2': // [xScale, xOffset, yScale, yOffset]
      if (!numbers(v, 4)) throw new Error(`${prop} expects a UDim2`);
      return v.map((n) => clamp(n, -1e5, 1e5));
    case 'color':
      if (!numbers(v, 3)) throw new Error(`${prop} expects a Color3`);
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
  isA(cls) {
    return cls === 'Instance' || cls === this.className
      || (cls === 'BasePart' && this.className === 'Part') || (cls === 'GuiObject' && GUI_OBJECTS.has(this.className))
      || (cls === 'UIComponent' && GUI_MODIFIERS.has(this.className));
  }
}

export class WickDataModel {
  /** assets: the shared WickAssets library. Omit it for a headless model with an empty in-memory library. */
  constructor(assets = new WickAssets({ persist: false })) {
    this._handlers = {};
    this.assets = assets;
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
    for (const cls of SERVICES) this._link(this._make(cls), this.root);
    this._bindServices();
  }

  _bindServices() {
    const find = (cls) => this.root.children.find((c) => c.className === cls);
    this.workspace = find('Workspace');
    this.lighting = find('Lighting');
    this.scripts = find('Scripts');
    this.gui = find('Gui');
  }

  _make(className, wantedId = null, enforceLimit = true) {
    if (enforceLimit && className === 'Part' && this._partCount >= WICK_LIMITS.maxParts) {
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

  /** Scripts under Workspace, Scripts or Gui run when playing. */
  isRunnable(inst) {
    for (let p = inst.parent; p; p = p.parent) if (p === this.workspace || p === this.scripts || p === this.gui) return true;
    return false;
  }

  isInGui(inst) {
    for (let p = inst; p; p = p.parent) if (p === this.gui) return true;
    return false;
  }

  /** The CameraPoint that is in the Workspace (at most one can be), or null. */
  get cameraPoint() {
    for (const d of this.descendants(this.workspace)) if (d.className === 'CameraPoint') return d;
    return null;
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

  // ---- placement rules ----

  /** Throws a readable Error if `sub` (a detached subtree or a new instance) may not be put under `parent`. */
  _checkPlacement(sub, parent) {
    if (!parent) return; // a detached copy can be built anywhere; the rules apply when it is parented
    const cls = sub.className;
    const under = parent.className;
    if (cls === 'ScreenGui' && parent !== this.gui) throw new Error('A ScreenGui can only go inside the Gui service');
    if (GUI_OBJECTS.has(cls) && under !== 'ScreenGui' && !GUI_OBJECTS.has(under)) throw new Error(`${cls} must be inside a ScreenGui or another UI object`);
    if (GUI_MODIFIERS.has(cls) && !GUI_OBJECTS.has(under)) throw new Error(`${cls} must be inside a UI object (Frame, TextLabel, ...)`);
    if ((cls === 'Part' || cls === 'Model') && this.isInGui(parent)) throw new Error(`${cls} cannot go inside the Gui service`);
    if (cls === 'PointLight' && under !== 'Part') throw new Error('A PointLight must be attached to a Part');
    if (parent === this.gui && !(cls === 'ScreenGui' || cls === 'Folder' || cls === 'Script')) throw new Error(`${cls} cannot go directly inside the Gui service`);

    const cams = [...this.descendants(sub, true)].filter((d) => d.className === 'CameraPoint');
    if (cams.length > 1) throw new Error('Only one CameraPoint can exist');
    if (cams.length) {
      if (cams[0] === sub && under !== 'Part') throw new Error('A CameraPoint must be attached to a Part');
      if (!this.isInWorkspace(parent)) throw new Error('A CameraPoint must be inside the Workspace');
      const existing = this.cameraPoint;
      if (existing && existing !== cams[0]) throw new Error('Only one CameraPoint can exist. Delete the existing one first.');
    }
  }

  // ---- creation / destruction ----
  create(className, parent = this.workspace, props = null) {
    const def = CLASS_DEFS[className];
    if (!def || def.creatable === false) throw new Error(`Unable to create an Instance of type "${className}"`);
    const inst = this._make(className);
    try {
      if (props) for (const [k, v] of Object.entries(props)) this._assign(inst, k, v);
      this._checkPlacement(inst, parent);
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
    this._checkPlacement(inst, parent);
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
    const inst = this._make(node.class, keepIds ? node.id : null, !keepIds); // opening a project never trips the part limit
    for (const [k, v] of Object.entries(node.props || {})) {
      try { this._assign(inst, k, v); } catch { /* ignore stale or invalid saved values */ }
    }
    for (const ch of node.children || []) {
      const c = this._build(ch, keepIds);
      if (c) this._link(c, inst);
    }
    return inst;
  }

  /**
   * Clone or paste serialized data under `parent`. Fresh ids unless `keepIds`. A copy never brings a second
   * CameraPoint into the Workspace: it is left out of the copy instead.
   */
  instantiate(node, parent, { keepIds = false } = {}) {
    const inst = this._build(node, keepIds);
    if (!inst) throw new Error('Nothing to paste');
    try {
      if (parent && !keepIds) {
        if (this.cameraPoint && this.isInWorkspace(parent)) {
          for (const d of [...this.descendants(inst)]) if (d.className === 'CameraPoint') this._cut(d);
        }
        this._checkPlacement(inst, parent);
      }
    } catch (err) {
      for (const d of this.descendants(inst, true)) this._discard(d);
      throw err;
    }
    if (parent) {
      this._link(inst, parent);
      for (const d of this.descendants(inst, true)) this.emit('added', d);
    }
    return inst;
  }

  /** Removes a node that has not been announced yet (it only exists inside a detached subtree). */
  _cut(inst) {
    for (const d of [...this.descendants(inst, true)]) this._discard(d);
    inst.parent.children = inst.parent.children.filter((c) => c !== inst);
    inst.parent = null;
  }

  clone(inst, parent = inst.parent) {
    return this.instantiate(this.serializeNode(inst), parent);
  }

  /** Ids of every library asset this project refers to (any string property holding asset://<id>). */
  usedAssetIds() {
    const used = new Set();
    for (const inst of this.descendants(this.root)) {
      for (const [k, d] of Object.entries(CLASS_DEFS[inst.className].props)) {
        if (d.type !== 'string' && d.type !== 'source') continue;
        const v = inst.props[k];
        if (d.type === 'string') { const m = /^asset:\/\/([\w-]+)$/.exec(v); if (m) used.add(m[1]); }
        else for (const m of v.matchAll(/asset:\/\/([\w-]+)/g)) used.add(m[1]);
      }
    }
    return [...used];
  }

  /** Project JSON. Assets are never part of it: they live in the library, and .wick files embed them separately. */
  toJSON() {
    // version is the file format; engine records which Wick Engine build saved the project.
    return { format: 'wick-project', version: 1, engine: WICK_VERSION, name: this.projectName, nextId: this._nextId, root: this.serializeNode(this.root) };
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
    for (const cls of SERVICES) {
      if (!this.root.children.some((c) => c.className === cls)) this._link(this._make(cls), this.root);
    }
    this._bindServices();
    this._nextId = Math.max(this._nextId, data.nextId || 1);
    this.projectName = String(data.name || 'Untitled Project').slice(0, 80);
    this.emit('reset');
  }

  /** Empty project: services plus a baseplate. */
  loadBlank(name = 'Untitled Project', { baseplate = true, grass = true } = {}) {
    this._initEmpty();
    this.projectName = name;
    if (baseplate) {
      this.create('Part', this.workspace, {
        Name: 'Baseplate', Size: [120, 1, 120], Position: [0, -0.5, 0], Anchored: true, CastShadow: false,
        Material: grass ? 'Grass' : 'Plastic', Color: grass ? [1, 1, 1] : [0.36, 0.38, 0.42],
      });
    }
    this.emit('reset');
  }
}
