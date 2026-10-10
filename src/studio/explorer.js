// Explorer panel: the instance tree with selection, inline rename, drag-to-reparent and a context menu.

import { h, icon, iconFor, showMenu } from './ui.js';

const MAX_CHILDREN_SHOWN = 300; // keeps a runaway script from turning the tree into a million rows

export class WickExplorer {
  constructor(studio, host) {
    this.studio = studio;
    this.dm = studio.dm;
    this.host = host;
    this.expanded = new Set([...this.dm.root.children.map((c) => c.id)]);
    this.dragId = null;
    this._timer = null;
    this._last = 0;

    const dm = this.dm;
    for (const evt of ['added', 'removed', 'reparented', 'reset']) dm.on(evt, () => this.schedule());
    dm.on('changed', (_inst, prop) => { if (prop === 'Name' || prop === 'Shape') this.schedule(); });
    studio.on('selection', (inst) => {
      // Only rebuild rows when a collapsed ancestor had to open; otherwise just move the highlight,
      // so a click is never interrupted by the row it landed on being replaced.
      const before = this.expanded.size;
      this.reveal(inst);
      if (this.expanded.size !== before) this.render(); else this.markSelected();
    });

    host.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.wk-row')) return; // rows handle their own
      this.menu(null, e.clientX, e.clientY);
    });
    this.render();
  }

  /** Re-render soon. While a game runs this is throttled, since scripts can change the tree every frame. */
  schedule() {
    if (this._timer) return;
    const wait = this.studio.playing ? Math.max(0, 250 - (performance.now() - this._last)) : 0;
    this._timer = setTimeout(() => { this._timer = null; this.render(); }, wait);
  }

  markSelected() {
    this.host.querySelector('.is-selected')?.classList.remove('is-selected');
    const sel = this.studio.selected;
    const row = sel && this.host.querySelector(`.wk-row[data-id="${sel.id}"]`);
    row?.classList.add('is-selected');
    row?.scrollIntoView({ block: 'nearest' });
  }

  reveal(inst) {
    for (let p = inst?.parent; p; p = p.parent) this.expanded.add(p.id);
  }

  render() {
    this._last = performance.now();
    const frag = document.createDocumentFragment();
    for (const svc of this.dm.root.children) this._row(frag, svc, 0);
    this.host.replaceChildren(frag);
    this.host.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
  }

  _row(parentEl, inst, depth) {
    const open = this.expanded.has(inst.id);
    const hasKids = inst.children.length > 0;
    const selected = this.studio.selected === inst;
    const row = h('div', {
      class: `wk-row${selected ? ' is-selected' : ''}`,
      dataset: { id: inst.id },
      style: `padding-left:${6 + depth * 14}px`,
      draggable: inst.service ? false : 'true',
    },
      h('span', { class: `wk-twisty${hasKids ? '' : ' is-empty'}${open ? ' is-open' : ''}`, onclick: (e) => { e.stopPropagation(); this.toggle(inst); } }, icon('chevron', 12)),
      icon(iconFor(inst)),
      h('span', { class: 'wk-row-name' }, inst.name));

    row.addEventListener('pointerdown', (e) => { if (e.button === 0 || e.button === 2) this.studio.select(inst); });
    row.addEventListener('dblclick', () => (inst.className === 'Script' ? this.studio.openScript(inst) : this.toggle(inst)));
    row.addEventListener('contextmenu', (e) => { e.stopPropagation(); this.studio.select(inst); this.menu(inst, e.clientX, e.clientY); });

    row.addEventListener('dragstart', (e) => {
      if (this.studio.playing) { e.preventDefault(); return; }
      this.dragId = inst.id;
      e.dataTransfer.setData('text/plain', String(inst.id));
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { this.dragId = null; this.host.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop')); });
    row.addEventListener('dragover', (e) => {
      const dragged = this.dragId && this.dm.find(this.dragId);
      if (!dragged || dragged === inst || this.dm.isAncestor(dragged, inst)) return;
      e.preventDefault();
      row.classList.add('is-drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('is-drop');
      const dragged = this.dragId && this.dm.find(this.dragId);
      if (dragged) { this.expanded.add(inst.id); this.studio.reparent(dragged, inst); }
    });

    parentEl.append(row);
    if (open && hasKids) {
      inst.children.slice(0, MAX_CHILDREN_SHOWN).forEach((c) => this._row(parentEl, c, depth + 1));
      if (inst.children.length > MAX_CHILDREN_SHOWN) {
        parentEl.append(h('div', { class: 'wk-row wk-row-more', style: `padding-left:${6 + (depth + 1) * 14}px` },
          `+ ${inst.children.length - MAX_CHILDREN_SHOWN} more`));
      }
    }
  }

  toggle(inst) {
    if (this.expanded.has(inst.id)) this.expanded.delete(inst.id); else this.expanded.add(inst.id);
    this.render();
  }

  menu(inst, x, y) {
    const s = this.studio;
    const items = [];
    if (inst?.className === 'Script') items.push({ label: 'Open Script', action: () => s.openScript(inst) });
    if (inst?.className === 'Part') items.push({ label: 'Focus', shortcut: 'F', action: () => s.focus(inst) });
    if (items.length) items.push({ separator: true });
    if (inst) {
      items.push(
        { label: 'Copy', shortcut: 'Ctrl+C', disabled: inst.service, action: () => s.copy(inst) },
        { label: 'Paste Into', shortcut: 'Ctrl+V', disabled: !s.clipboard, action: () => s.paste(inst) },
        { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: inst.service, action: () => s.duplicate(inst) },
        { label: 'Rename', shortcut: 'F2', disabled: inst.service, action: () => this.beginRename(inst) },
        { label: 'Delete', shortcut: 'Del', disabled: inst.service, action: () => s.delete(inst) },
        { separator: true },
      );
    } else {
      items.push({ label: 'Paste', shortcut: 'Ctrl+V', disabled: !s.clipboard, action: () => s.paste() }, { separator: true });
    }
    items.push({
      label: 'Insert',
      submenu: [
        { label: 'Block', action: () => s.insert('Block') },
        { label: 'Ball', action: () => s.insert('Ball') },
        { label: 'Cylinder', action: () => s.insert('Cylinder') },
        { label: 'Folder', action: () => s.insert('Folder') },
        { label: 'Script', action: () => s.insert('Script') },
        { label: 'Sound', action: () => s.insert('Sound') },
        { label: 'PointLight', disabled: inst?.className !== 'Part', action: () => s.insert('PointLight') },
      ],
    });
    showMenu(items, x, y);
  }

  beginRename(inst = this.studio.selected) {
    if (!inst || inst.service || !this.studio.canEdit()) return;
    this.reveal(inst);
    this.render();
    const label = this.host.querySelector(`.wk-row[data-id="${inst.id}"] .wk-row-name`);
    if (!label) return;
    const input = h('input', { class: 'wk-rename', value: inst.name, spellcheck: 'false', maxlength: '80' });
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      if (apply) this.studio.rename(inst, input.value);
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    label.replaceWith(input);
    input.focus();
    input.select();
  }
}
