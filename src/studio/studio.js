// WickStudio: the editor's state and every editing action (insert, copy, paste, duplicate, delete, undo...).
// Menus, the Explorer, the viewport and keyboard shortcuts all call into this one place.

const HISTORY_LIMIT = 60;
const CONTAINERS = new Set(['Workspace', 'Scripts', 'Folder', 'Part']);

export class WickStudio {
  constructor({ dm, world, runtime, guard, log, toast }) {
    Object.assign(this, { dm, world, runtime, guard, log, toast });
    this.selected = null;
    this.tool = 'select';
    this.clipboard = null; // serialized subtree (JSON string)
    this.undoStack = [];
    this.redoStack = [];
    this.current = JSON.stringify(dm.toJSON());
    this._handlers = {};
    this.openScript = () => {}; // set by the script editor

    dm.on('removed', (inst) => { if (this.selected === inst) this.select(null); });
    dm.on('reset', () => {
      const again = this.selected && dm.find(this.selected.id);
      this.selected = again || null;
      this.world.setSelected(this.selected);
      this.emit('selection', this.selected);
    });
  }

  // ---- tiny event emitter: selection, tool, dirty ----
  on(evt, fn) { (this._handlers[evt] ||= []).push(fn); }
  emit(evt, ...a) { for (const fn of this._handlers[evt] || []) fn(...a); }

  get playing() { return this.runtime.playing; }

  /** Editing is blocked while a game runs; the project is restored from a snapshot on Stop. */
  canEdit() {
    if (this.playing) { this.toast('Stop the game to edit the project.', 'warn'); return false; }
    return true;
  }

  select(inst) {
    if (this.selected === inst) return;
    this.selected = inst;
    this.world.setSelected(inst);
    this.emit('selection', inst);
  }

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

  /** Inserts a new object. `what` is Block, Ball, Cylinder, Folder, Script, Sound or PointLight. */
  insert(what) {
    if (!this.canEdit()) return null;
    const { dm } = this;
    const sel = this._container();
    const inst = this._try(() => {
      switch (what) {
        case 'Block':
        case 'Ball':
        case 'Cylinder': {
          const shape = { Block: {}, Ball: { Shape: 'Ball', Size: [4, 4, 4], Name: 'Ball' }, Cylinder: { Shape: 'Cylinder', Size: [3, 4, 3], Name: 'Cylinder' } }[what];
          const parent = sel && sel.className !== 'Scripts' ? sel : dm.workspace;
          return dm.create('Part', parent, { Position: this.world.insertPoint(), ...shape });
        }
        case 'Folder':
          return dm.create('Folder', sel ?? dm.workspace);
        case 'Script':
          return dm.create('Script', sel && sel.className !== 'Part' ? sel : dm.scripts);
        case 'Sound': {
          const parent = this.selected?.className === 'Part' ? this.selected : dm.workspace;
          return dm.create('Sound', parent);
        }
        case 'PointLight':
          if (this.selected?.className !== 'Part') throw new Error('Select a Part first. A PointLight attaches to a Part.');
          return dm.create('PointLight', this.selected);
        default:
          throw new Error(`Cannot insert ${what}`);
      }
    });
    if (!inst) return null;
    this.select(inst);
    this.commit();
    if (inst.className === 'Script') this.openScript(inst);
    return inst;
  }

  copy(inst = this.selected) {
    if (!inst || inst.service) return;
    this.clipboard = JSON.stringify(this.dm.serializeNode(inst));
    this.toast(`Copied ${inst.name}`);
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
    const target = parent ?? this._container() ?? this.dm.workspace;
    const inst = this._try(() => this.dm.instantiate(JSON.parse(this.clipboard), target));
    if (!inst) return;
    this._nudge(inst, 2); // keep the copy from hiding exactly behind the original
    this.select(inst);
    this.commit();
  }

  duplicate(inst = this.selected) {
    if (!inst || inst.service || !this.canEdit()) return;
    const copy = this._try(() => this.dm.clone(inst, inst.parent));
    if (!copy) return;
    this._nudge(copy, 2);
    this.select(copy);
    this.commit();
  }

  delete(inst = this.selected) {
    if (!inst || !this.canEdit()) return;
    if (inst.service) { this.toast(`${inst.name} cannot be deleted.`, 'warn'); return; }
    this._try(() => this.dm.destroy(inst));
    this.commit();
  }

  rename(inst, name) {
    if (!inst || !this.canEdit()) return;
    const clean = String(name).trim();
    if (!clean || clean === inst.name) return;
    if (this._try(() => this.dm.set(inst, 'Name', clean)) !== null) this.commit();
  }

  /** Property edit from the Properties panel. Returns true if applied. */
  setProp(inst, prop, value) {
    if (!this.canEdit()) return false;
    const ok = this._try(() => { this.dm.set(inst, prop, value); return true; });
    if (ok) this.commit();
    return !!ok;
  }

  reparent(inst, parent) {
    if (!this.canEdit()) return;
    if (this._try(() => this.dm.setParent(inst, parent)) !== null || inst.parent === parent) this.commit();
  }

  focus(inst = this.selected) { this.world.focus(inst); }
}
