// Script editor: a tab per open Script next to the viewport tab. Plain textarea with line numbers,
// Tab/Enter indentation and a custom right-click menu (the browser's menu is disabled app-wide).

import { h, icon, showMenu } from './ui.js';

const COMMIT_DELAY_MS = 700;
const OPENS_BLOCK = /(\b(then|do|else|repeat)|\bfunction\s*[\w.:]*\s*\([^)]*\))\s*$/;

export class WickScriptEditor {
  constructor(studio, { tabsEl, panesEl, viewportPane }) {
    this.studio = studio;
    this.dm = studio.dm;
    this.tabsEl = tabsEl;
    this.panesEl = panesEl;
    this.open = new Map(); // script id -> { tab, pane, area, gutter, label, timer }
    this.active = 'viewport';

    this.viewportTab = h('div', { class: 'wk-tab is-active', onclick: () => this.show('viewport') }, icon('workspace', 14), h('span', {}, 'Viewport'));
    tabsEl.append(this.viewportTab);
    this.viewportPane = viewportPane;
    studio.openScript = (inst) => this.openScript(inst);

    this.dm.on('changed', (inst, prop) => {
      if (prop === 'Name' && this.open.has(inst.id)) this.open.get(inst.id).label.textContent = inst.name;
    });
    this.dm.on('removed', (inst) => { if (this.open.has(inst.id)) this.close(inst.id); });
    // After undo, Stop or a project load, refresh tabs from the restored data.
    this.dm.on('reset', () => this.resync());
    studio.on('playstate', () => this.updateReadOnly());
  }

  openScript(inst) {
    if (inst.className !== 'Script') return;
    if (!this.open.has(inst.id)) this._create(inst);
    else this.resync(); // the project may have been reloaded (Stop, undo, open) since this tab was made
    this.show(inst.id);
  }

  _create(inst) {
    const id = inst.id;
    // Looked up on every write. Stop, undo and Open rebuild the whole tree, so an instance held from when the tab
    // opened would be a dead copy whose edits the project never sees.
    const current = () => this.dm.find(id);
    const area = h('textarea', { class: 'wk-code', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off' });
    area.value = inst.props.Source;
    const gutter = h('div', { class: 'wk-gutter' });
    const label = h('span', {}, inst.name);
    const rec = { area, gutter, label, timer: null };

    const lines = () => {
      const n = area.value.split('\n').length;
      if (gutter.dataset.n !== String(n)) {
        gutter.dataset.n = n;
        gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      }
    };
    const flush = () => {
      clearTimeout(rec.timer);
      rec.timer = null;
      this.studio.commit();
    };
    area.addEventListener('input', () => {
      lines();
      const live = current();
      if (!live) return;
      try {
        this.dm.set(live, 'Source', area.value);
      } catch (err) {
        this.studio.toast(err.message, 'error');
        return;
      }
      clearTimeout(rec.timer);
      rec.timer = setTimeout(flush, COMMIT_DELAY_MS);
    });
    area.addEventListener('blur', () => { if (rec.timer) flush(); });
    area.addEventListener('scroll', () => { gutter.scrollTop = area.scrollTop; });
    area.addEventListener('keydown', (e) => this._keys(e, area));
    area.addEventListener('contextmenu', (e) => this._menu(e, area));
    lines();

    rec.close = h('span', { class: 'wk-tab-close', title: 'Close', onclick: (e) => { e.stopPropagation(); this.close(inst.id); } }, '×');
    rec.tab = h('div', { class: 'wk-tab', onclick: () => this.show(inst.id) }, icon('script', 14), label, rec.close);
    rec.pane = h('div', { class: 'wk-pane wk-editor' }, gutter, area);
    this.tabsEl.append(rec.tab);
    this.panesEl.append(rec.pane);
    this.open.set(inst.id, rec);
    area.readOnly = this.studio.playing;
  }

  show(id) {
    this.active = id;
    this.viewportTab.classList.toggle('is-active', id === 'viewport');
    this.viewportPane.classList.toggle('is-active', id === 'viewport');
    for (const [sid, r] of this.open) {
      r.tab.classList.toggle('is-active', sid === id);
      r.pane.classList.toggle('is-active', sid === id);
    }
    if (id !== 'viewport') this.open.get(id)?.area.focus();
  }

  close(id) {
    const r = this.open.get(id);
    if (!r) return;
    if (r.timer) { clearTimeout(r.timer); this.studio.commit(); }
    r.tab.remove();
    r.pane.remove();
    this.open.delete(id);
    if (this.active === id) this.show('viewport');
  }

  resync() {
    for (const [id, r] of [...this.open]) {
      const inst = this.dm.find(id);
      if (!inst || inst.className !== 'Script') { this.close(id); continue; }
      r.label.textContent = inst.name;
      if (r.area.value !== inst.props.Source) {
        r.area.value = inst.props.Source;
        r.area.dispatchEvent(new Event('scroll'));
        r.gutter.dataset.n = '';
        r.gutter.textContent = Array.from({ length: r.area.value.split('\n').length }, (_, i) => i + 1).join('\n');
      }
    }
  }

  updateReadOnly() {
    for (const r of this.open.values()) r.area.readOnly = this.studio.playing;
  }

  // ---- typing helpers ----
  _insert(area, text) {
    if (!document.execCommand('insertText', false, text)) area.setRangeText(text, area.selectionStart, area.selectionEnd, 'end');
  }

  _keys(e, area) {
    e.stopPropagation(); // editor keys never reach the studio shortcuts, except Ctrl+S below
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.studio.emit('save');
      return;
    }
    if (area.readOnly) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      this._insert(area, '  ');
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      const before = area.value.slice(0, area.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const indent = /^[ \t]*/.exec(line)[0] + (OPENS_BLOCK.test(line.trimEnd()) ? '  ' : '');
      e.preventDefault();
      this._insert(area, `\n${indent}`);
    }
  }

  _menu(e, area) {
    e.preventDefault();
    e.stopPropagation();
    const hasSel = area.selectionStart !== area.selectionEnd;
    showMenu([
      { label: 'Cut', shortcut: 'Ctrl+X', disabled: !hasSel || area.readOnly, action: () => { area.focus(); document.execCommand('cut'); } },
      { label: 'Copy', shortcut: 'Ctrl+C', disabled: !hasSel, action: () => { area.focus(); document.execCommand('copy'); } },
      {
        label: 'Paste', shortcut: 'Ctrl+V', disabled: area.readOnly,
        action: async () => {
          try {
            const text = await navigator.clipboard.readText();
            area.focus();
            this._insert(area, text);
          } catch {
            this.studio.toast('The browser blocked clipboard access. Use Ctrl+V instead.', 'warn');
          }
        },
      },
      { separator: true },
      { label: 'Select All', shortcut: 'Ctrl+A', action: () => { area.focus(); area.select(); } },
    ], e.clientX, e.clientY);
  }
}
