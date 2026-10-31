// WickStudio: the editor's state and every editing action (insert, copy, paste, duplicate, delete, group, undo...).
// Menus, the Explorer, the viewport, the UI editor and keyboard shortcuts all call into this one place.

import { propDef, isGuiObject, GUI_OBJECTS, GUI_MODIFIERS } from '../engine/datamodel.js';
import { insertBuiltinBundle, instantiateBundle, bundleFromInstances } from '../engine/bundles.js';
import { meshId } from '../engine/library.js';
import { assetUri } from '../engine/assets.js';

const HISTORY_LIMIT = 60;
const CONTAINERS = new Set(['Workspace', 'Scripts', 'Folder', 'Model', 'Part']);
const MESH_SHAPES = { Wedge: 'wedge', Cone: 'cone', Pyramid: 'pyramid', Torus: 'torus' };

export class WickStudio {
  constructor({ dm, world, runtime, guard, gui, log, toast }) {
    Object.assign(this, { dm, world, runtime, guard, gui, log, toast });
    this.selection = []; // the last entry is the primary
    this.tool = 'select';
    this.clipboard = null; // JSON string: an array of serialized subtrees
    this.undoStack = [];
    this.redoStack = [];
    this.current = JSON.stringify(dm.toJSON());
    this._handlers = {};
    this.openScript = () => {}; // set by the script editor

    dm.on('removed', (inst) => { if (this.selection.includes(inst)) this.setSelection(this.selection.filter((s) => s !== inst)); });
    dm.on('reset', () => {
      this.selection = this.selection.map((s) => dm.find(s.id)).filter(Boolean);
      this.world.setSelection(this.selection);
      this.gui.setSelection(this.selection);
      this.emit('selection', this.selected);
    });
  }

  // ---- tiny event emitter: selection, tool, dirty, playstate ----
  on(evt, fn) { (this._handlers[evt] ||= []).push(fn); }
  emit(evt, ...a) { for (const fn of this._handlers[evt] || []) fn(...a); }

  get playing() { return this.runtime.playing; }
  get selected() { return this.selection[this.selection.length - 1] ?? null; }
  isSelected(inst) { return this.selection.includes(inst); }

  /** Editing is blocked while a game runs; the project is restored from a snapshot on Stop. */
  canEdit() {
    if (this.playing) { this.toast('Stop the game to edit the project.', 'warn'); return false; }
    return true;
  }

  // ---------------------------------------------------------------- selection

  setSelection(list) {
    const next = [...new Set(list.filter(Boolean))].filter((i) => !i.destroyed);
    if (next.length === this.selection.length && next.every((s, i) => s === this.selection[i])) return;
    this.selection = next;
    this.world.setSelection(next);
    this.gui.setSelection(next);
    this.gui.setEditing(next.some((i) => this.dm.isInGui(i)) && !this.playing);
    this.emit('selection', this.selected);
  }

  /** Single selection, or with additive: toggle the instance in the current selection. */
  select(inst, additive = false) {
    if (!additive) { this.setSelection(inst ? [inst] : []); return; }
    if (!inst) return;
    this.setSelection(this.isSelected(inst) ? this.selection.filter((s) => s !== inst) : [...this.selection, inst]);
  }

  /** A click in the viewport. Shift adds to or removes from the selection; a plain click on empty space clears it. */
  pick(inst, additive) { this.select(inst, additive); }

  /** The selection without anything whose ancestor is also selected. */
  topLevel(list = this.selection) { return list.filter((i) => !list.some((o) => o !== i && this.dm.isAncestor(o, i))); }

  setTool(tool) {
    this.tool = tool;
    this.world.setTool(tool);
    this.emit('tool', tool);
  }

  // ---------------------------------------------------------------- history

  /** Records the current project state as an undo step if anything changed. */
  commit() {
    if (this.playing) return;
    const s = JSON.stringify(this.dm.toJSON());
    if (s === this.current) return;
    this.undoStack.push(this.current);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.current = s;
    this.emit('dirty');
  }

  /** Re-baselines history after a project is created or opened. */
  resetHistory() {
    this.current = JSON.stringify(this.dm.toJSON());
    this.undoStack = [];
    this.redoStack = [];
  }

  _restore(s) {
    this.dm.load(JSON.parse(s));
    this.current = s;
    this.emit('dirty');
  }

  undo() {
    if (!this.canEdit() || !this.undoStack.length) return;
    this.redoStack.push(this.current);
    this._restore(this.undoStack.pop());
  }

  redo() {
    if (!this.canEdit() || !this.redoStack.length) return;
    this.undoStack.push(this.current);
    this._restore(this.redoStack.pop());
  }

  get canUndo() { return this.undoStack.length > 0 && !this.playing; }
  get canRedo() { return this.redoStack.length > 0 && !this.playing; }

  // ---------------------------------------------------------------- actions

  _try(fn) {
    try { return fn(); } catch (err) { this.toast(err.message, 'error'); return null; }
  }

  _container() {
    const s = this.selected;
    return s && CONTAINERS.has(s.className) ? s : null;
  }

  /** Where new world objects go: the selected container, otherwise the Workspace. */
  _worldParent() {
    const sel = this._container();
    return sel && sel.className !== 'Scripts' ? sel : this.dm.workspace;
  }

  /** x and z in front of the camera, with y the ground height there (0 if there is none). */
  groundPoint() {
    const [x, , z] = this.world.insertPoint();
    const hit = this.world.raycast([x, 200, z], [0, -400, 0]);
    return [x, hit ? hit.point[1] : 0, z];
  }

  _guiParent(what) {
    const { dm } = this;
    const sel = this.selected;
    if (what === 'ScreenGui') return dm.gui;
    if (GUI_MODIFIERS.has(what)) {
      if (!sel || !isGuiObject(sel.className)) throw new Error(`Select a UI object (Frame, TextLabel...) first. ${what} attaches to one.`);
      return sel;
    }
    if (sel && (sel.className === 'ScreenGui' || isGuiObject(sel.className))) return sel;
    return dm.gui.children.find((c) => c.className === 'ScreenGui') ?? dm.create('ScreenGui', dm.gui);
  }

  /**
   * Inserts a new object. `what` is Block, Ball, Cylinder, Wedge, Cone, Pyramid, Torus, Model, Folder, Script,
   * Sound, PointLight, CameraPoint, ScreenGui or any UI class.
   */
  insert(what) {
    if (!this.canEdit()) return null;
    const { dm } = this;
    const inst = this._try(() => {
      if (MESH_SHAPES[what]) return this._newMeshPart(meshId(MESH_SHAPES[what]), what, [4, 4, 4]);
      if (what === 'ScreenGui' || GUI_OBJECTS.has(what) || GUI_MODIFIERS.has(what)) {
        const parent = this._guiParent(what);
        const props = GUI_OBJECTS.has(what) && !['TextLabel', 'ImageLabel', 'ImageButton'].includes(what)
          ? { Position: [0.5, 0, 0.5, 0], AnchorPoint: [0.5, 0.5] } : {};
        return dm.create(what, parent, props);
      }
      switch (what) {
        case 'Block':
        case 'Ball':
        case 'Cylinder': {
          const shape = { Block: {}, Ball: { Shape: 'Ball', Size: [4, 4, 4], Name: 'Ball' }, Cylinder: { Shape: 'Cylinder', Size: [3, 4, 3], Name: 'Cylinder' } }[what];
          return dm.create('Part', this._worldParent(), { Position: this.world.insertPoint(), ...shape });
        }
        case 'Model': return dm.create('Model', this._worldParent());
        case 'Folder': return dm.create('Folder', this._container() ?? (this.selected && dm.isInGui(this.selected) ? this.selected : dm.workspace));
        case 'Script': {
          const sel = this._container();
          return dm.create('Script', sel && sel.className !== 'Part' ? sel : dm.scripts);
        }
        case 'Sound': return dm.create('Sound', this.selected?.className === 'Part' ? this.selected : dm.workspace);
        case 'PointLight':
          if (this.selected?.className !== 'Part') throw new Error('Select a Part first. A PointLight attaches to a Part.');
          return dm.create('PointLight', this.selected);
        case 'CameraPoint':
          if (this.selected?.className !== 'Part') throw new Error('Select a Part first. A CameraPoint attaches to a Part, and the project can only have one.');
          return dm.create('CameraPoint', this.selected);
        default:
          throw new Error(`Cannot insert ${what}`);
      }
    });
    return this._finishInsert(inst);
  }

  _finishInsert(inst) {
    if (!inst) return null;
    this.select(inst);
    this.commit();
    if (inst.className === 'Script') this.openScript(inst);
    return inst;
  }

  _newMeshPart(uri, name, size) {
    return this.dm.create('Part', this._worldParent(), { Name: name, Shape: 'Mesh', MeshId: uri, Size: size, Position: this.world.insertPoint() });
  }

  // ---- Library actions ----

  /** A built-in or imported mesh as a new Part. dims are the model's real dimensions when known. */
  insertMesh(uri, name, dims = [1, 1, 1], largest = 4) {
    if (!this.canEdit()) return null;
    const k = largest / Math.max(...dims);
    const size = dims.map((d) => Math.max(0.05, Math.round(d * k * 100) / 100));
    return this._finishInsert(this._try(() => this._newMeshPart(uri, name.replace(/\.[^.]+$/, ''), size)));
  }

  insertSound(uri, name) {
    if (!this.canEdit()) return null;
    return this._finishInsert(this._try(() => this.dm.create('Sound', this.selected?.className === 'Part' ? this.selected : this.dm.workspace, { Name: name, SoundId: uri })));
  }

  insertScript(name, source) {
    if (!this.canEdit()) return null;
    const sel = this._container();
    const parent = sel && sel.className !== 'Part' ? sel : (sel?.className === 'Part' ? sel : this.dm.scripts);
    return this._finishInsert(this._try(() => this.dm.create('Script', parent, { Name: name, Source: source })));
  }

  /** Puts the texture on every selected Part (an empty uri clears it). */
  applyTexture(uri) {
    if (!this.canEdit()) return;
    const parts = this.world._effective();
    if (!parts.length) { this.toast('Select one or more Parts first.', 'warn'); return; }
    for (const p of parts) this._try(() => this.dm.set(p, 'Texture', uri));
    this.commit();
  }

  async insertBuiltinBundle(id) {
    if (!this.canEdit()) return null;
    const inst = await this._try(() => insertBuiltinBundle(this.dm, id, this._worldParent(), this.groundPoint()));
    if (inst) { this.select(inst); this.commit(); }
    return inst;
  }

  insertCustomBundle(data) {
    if (!this.canEdit()) return null;
    const made = this._try(() => instantiateBundle(this.dm, data, this._worldParent()));
    if (made) { this.setSelection(made); this.commit(); }
    return made;
  }

  /** Bundle data for the current selection (saved to the Library by the caller). */
  bundleOfSelection(name) {
    return bundleFromInstances(this.dm, name, this.topLevel().filter((i) => !i.service));
  }

  // ---- clipboard, duplicate, delete ----

  copy(inst) {
    const list = inst ? [inst] : this.topLevel();
    const items = list.filter((i) => !i.service);
    if (!items.length) return;
    this.clipboard = JSON.stringify(items.map((i) => this.dm.serializeNode(i)));
    this.toast(items.length === 1 ? `Copied ${items[0].name}` : `Copied ${items.length} objects`);
  }

  _nudge(root, dx) {
    for (const d of this.dm.descendants(root, true)) {
      if (d.className === 'Part') {
        const p = d.props.Position;
        this.dm.set(d, 'Position', [p[0] + dx, p[1], p[2]]);
      }
    }
  }

  paste(parent) {
    if (!this.clipboard || !this.canEdit()) return;
    const target = parent ?? this._container() ?? (this.selected && this.dm.isInGui(this.selected) ? this.selected : this.dm.workspace);
    const made = this._try(() => JSON.parse(this.clipboard).map((n) => this.dm.instantiate(n, target)));
    if (!made) return;
    made.forEach((m) => this._nudge(m, 2)); // keep the copy from hiding exactly behind the original
    this.setSelection(made);
    this.commit();
  }

  duplicate(inst) {
    if (!this.canEdit()) return;
    const list = (inst ? [inst] : this.topLevel()).filter((i) => !i.service);
    const copies = list.map((i) => this._try(() => this.dm.clone(i, i.parent))).filter(Boolean);
    if (!copies.length) return;
    copies.forEach((c) => this._nudge(c, 2));
    this.setSelection(copies);
    this.commit();
  }

  delete(inst) {
    if (!this.canEdit()) return;
    const list = inst ? [inst] : this.topLevel();
    if (list.some((i) => i.service)) { this.toast(`${list.find((i) => i.service).name} cannot be deleted.`, 'warn'); return; }
    for (const i of list) if (!i.destroyed) this._try(() => this.dm.destroy(i));
    this.commit();
  }

  rename(inst, name) {
    if (!inst || !this.canEdit()) return;
    const clean = String(name).trim();
    if (!clean || clean === inst.name) return;
    if (this._try(() => this.dm.set(inst, 'Name', clean)) !== null) this.commit();
  }

  /** Property edit from the Properties panel. Applies to every selected instance of the same class. */
  setProp(inst, prop, value) {
    if (!this.canEdit()) return false;
    const targets = prop !== 'Name' && this.isSelected(inst) ? this.selection.filter((i) => i.className === inst.className && propDef(i.className, prop)) : [inst];
    let ok = true;
    for (const t of targets) ok = !!this._try(() => { this.dm.set(t, prop, value); return true; }) && ok;
    this.commit();
    return ok;
  }

  /** Moves the instance (and the rest of the selection, if it is part of it) under parent. */
  reparent(inst, parent) {
    if (!this.canEdit()) return;
    const list = this.isSelected(inst) ? this.topLevel() : [inst];
    let changed = false;
    for (const i of list) if (this._try(() => this.dm.setParent(i, parent)) !== null || i.parent === parent) changed = true;
    if (changed) this.commit();
  }

  // ---- grouping ----

  canGroupAsModel(list = this.topLevel()) {
    return list.length > 0 && list.every((i) => i.className === 'Part' || i.className === 'Model');
  }

  canGroup(list = this.topLevel()) { return list.length > 0 && !list.some((i) => i.service); }

  /** Wraps the selection in a new Model (Parts and Models only) or Folder (anything). */
  group(kind) {
    if (!this.canEdit()) return;
    const list = this.topLevel();
    if (!this.canGroup(list)) { this.toast('Select something to group first. Services cannot be grouped.', 'warn'); return; }
    if (kind === 'Model' && !this.canGroupAsModel(list)) { this.toast('A Model can only group Parts and other Models. Use Group as Folder for anything else.', 'warn'); return; }
    const parents = new Set(list.map((i) => i.parent));
    const parent = parents.size === 1 ? list[0].parent : (kind === 'Model' || list.every((i) => this.dm.isInWorkspace(i)) ? this.dm.workspace : list[0].parent);
    const made = this._try(() => {
      const g = this.dm.create(kind, parent, { Name: kind });
      for (const i of list) this.dm.setParent(i, g);
      return g;
    });
    if (!made) return;
    this.select(made);
    this.commit();
  }

  ungroup() {
    if (!this.canEdit()) return;
    const groups = this.topLevel().filter((i) => i.className === 'Model' || i.className === 'Folder');
    if (!groups.length) { this.toast('Select a Model or Folder to ungroup.', 'warn'); return; }
    const freed = [];
    for (const g of groups) {
      for (const c of [...g.children]) if (this._try(() => this.dm.setParent(c, g.parent)) !== null) freed.push(c);
      this._try(() => this.dm.destroy(g));
    }
    this.setSelection(freed);
    this.commit();
  }

  focus(inst) { this.world.focus(inst); }
}

export { assetUri };
