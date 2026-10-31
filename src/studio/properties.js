// Properties panel: editors are generated from the class schema in datamodel.js.
// With several objects selected it shows the last one and applies every edit to all selected objects of that class.
// While a game runs it becomes a read-only live view (positions follow physics).

import { propList } from './../engine/datamodel.js';
import { h, icon, iconFor } from './ui.js';

const CATEGORY_ORDER = ['Data', 'Appearance', 'Layout', 'Text', 'Image', 'Transform', 'Physics', 'Behavior', 'Environment', 'Sky', 'Wind', 'Graphics', 'Light', 'Camera', 'Sound', 'Script'];

const fmt = (n) => String(Number(Number(n).toFixed(3)));
const toHex = (c) => `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);

export class WickProperties {
  constructor(studio, host) {
    this.studio = studio;
    this.dm = studio.dm;
    this.host = host;

    studio.on('selection', () => this.render());
    this.dm.on('changed', (inst, prop) => { if (studio.isSelected(inst) && !studio.playing) this.refresh(prop); });
    this.dm.on('reset', () => this.render());
    // Live values while playing.
    setInterval(() => { if (studio.playing && studio.selected) this.render(); }, 250);
    // Re-sync after an edit once focus leaves the panel (values may have been clamped).
    host.addEventListener('focusout', () => setTimeout(() => { if (!host.contains(document.activeElement)) this.render(); }, 0));
    this.render();
  }

  /** A property changed from outside the panel (gizmo, undo): re-render unless the user is typing here. */
  refresh() {
    if (this.host.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
    this.render();
  }

  render() {
    const inst = this.studio.selected;
    const locked = this.studio.playing;
    if (!inst) {
      this.host.replaceChildren(h('div', { class: 'wk-empty' }, 'Select an object to see its properties.'));
      return;
    }
    const many = this.studio.selection.length;
    const frag = document.createDocumentFragment();
    frag.append(h('div', { class: 'wk-prop-head' }, icon(iconFor(inst)), h('span', { class: 'wk-prop-class' }, inst.className),
      many > 1 ? h('span', { class: 'wk-muted' }, `${many} selected: edits apply to every ${inst.className}`) : null));

    const groups = new Map();
    for (const [name, def] of propList(inst.className)) {
      if (def.hidden || (def.when && !def.when(inst.props))) continue;
      const cat = def.cat || 'Data';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push([name, def]);
    }
    const cats = [...groups.keys()].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
    for (const cat of cats) {
      frag.append(h('div', { class: 'wk-prop-cat' }, cat));
      for (const [name, def] of groups.get(cat)) {
        const readOnly = locked || (name === 'Name' && inst.service);
        frag.append(h('div', { class: 'wk-prop' },
          h('label', { class: 'wk-prop-label', title: name }, name),
          h('div', { class: 'wk-prop-value' }, this._editor(inst, name, def, this.dm.get(inst, name), readOnly))));
      }
    }
    // Keep the scroll position across live refreshes.
    const top = this.host.scrollTop;
    this.host.replaceChildren(frag);
    this.host.scrollTop = top;
  }

  _commit(inst, name, value, revert) {
    if (!this.studio.setProp(inst, name, value)) { revert?.(); return; }
    // Some properties decide which others are shown (Shape, Texture), so redraw once the editor has let go of focus.
    if (propList(inst.className).some(([, d]) => d.when)) setTimeout(() => this.render(), 0);
  }

  _editor(inst, name, def, value, ro) {
    const set = (v, revert) => this._commit(inst, name, v, revert);
    switch (def.type) {
      case 'boolean':
        return h('input', { type: 'checkbox', class: 'wk-check-input', checked: value, disabled: ro, onchange: (e) => set(e.target.checked, () => { e.target.checked = value; }) });
      case 'enum':
        return h('select', { class: 'wk-input', disabled: ro, onchange: (e) => set(e.target.value, () => { e.target.value = value; }) },
          def.options.map((o) => h('option', { value: o, selected: o === value }, o)));
      case 'number':
        return this._num(value, def, ro, (v, revert) => set(v, revert));
      case 'vector3': {
        const inputs = ['X', 'Y', 'Z'].map((axis, i) => this._num(value[i], def, ro, () => {
          const next = inputs.map((el) => Number(el.value));
          set(next, () => inputs.forEach((el, j) => { el.value = fmt(value[j]); }));
        }, axis));
        return h('div', { class: 'wk-vec' }, inputs);
      }
      case 'vector2': {
        const inputs = ['X', 'Y'].map((axis, i) => this._num(value[i], def, ro, () => {
          const next = inputs.map((el) => Number(el.value));
          set(next, () => inputs.forEach((el, j) => { el.value = fmt(value[j]); }));
        }, axis));
        return h('div', { class: 'wk-vec is-two' }, inputs);
      }
      case 'udim2': {
        // [X scale, X offset, Y scale, Y offset]: scale is a fraction of the parent, offset is in pixels.
        const tags = ['X', 'X', 'Y', 'Y'], kinds = ['scale', 'px', 'scale', 'px'];
        const inputs = value.map((v, i) => this._num(v, { step: i % 2 ? 1 : 0.05 }, ro, () => {
          const next = inputs.map((el) => Number(el.value));
          set(next, () => inputs.forEach((el, j) => { el.value = fmt(value[j]); }));
        }, tags[i], `${tags[i]} ${kinds[i]}`));
        return h('div', { class: 'wk-udim' },
          h('span', { class: 'wk-udim-tag' }, 'X'), inputs[0], inputs[1], h('span', { class: 'wk-udim-tag' }, 'Y'), inputs[2], inputs[3]);
      }
      case 'color':
        return h('input', { type: 'color', class: 'wk-color', value: toHex(value), disabled: ro, onchange: (e) => set(fromHex(e.target.value), () => { e.target.value = toHex(value); }) });
      case 'source':
        return h('button', { class: 'wk-btn', onclick: () => this.studio.openScript(inst) }, 'Open in editor');
      default: {
        const suggestions = typeof def.suggest === 'function' ? def.suggest(this.dm) : def.suggest;
        const listId = suggestions ? `wk-list-${name}` : null;
        const input = h('input', {
          class: 'wk-input', type: 'text', value, disabled: ro, spellcheck: 'false', list: listId,
          onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); },
          onchange: (e) => {
            if (name === 'Name') this.studio.rename(inst, e.target.value);
            else set(e.target.value, () => { e.target.value = value; });
          },
        });
        return suggestions ? [input, h('datalist', { id: listId }, suggestions.map((s) => h('option', { value: s })))] : input;
      }
    }
  }

  _num(value, def, ro, onchange, axis, title) {
    return h('input', {
      class: `wk-input wk-num${axis ? ` axis-${axis}` : ''}`, type: 'number', value: fmt(value), step: def.step ?? 'any', disabled: ro,
      title: title || axis || '',
      onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); },
      onchange: (e) => onchange(Number(e.target.value), () => { e.target.value = fmt(value); }),
    });
  }
}
