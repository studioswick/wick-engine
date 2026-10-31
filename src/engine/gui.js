// Wick Engine UI: renders the Gui service as DOM over the viewport, and lets the Studio edit it visually.
// Layout maps straight onto CSS: Position and Size are calc(scale% + offset px), AnchorPoint is a translate,
// UIListLayout and UIGridLayout are flexbox, UIPadding insets the content box. While a game plays, elements raise the
// events scripts connect to (MouseButton1Click, MouseEnter, FocusLost ...); while editing, they can be selected, dragged
// and resized with handles.

import { GUI_OBJECTS, GUI_MODIFIERS, isGuiObject } from './datamodel.js';
import { libraryTextureName, surfaceTexture } from './library.js';
import { assetIdOf } from './assets.js';

const FONTS = {
  Sans: '-apple-system, "Segoe UI", Roboto, Inter, "Helvetica Neue", sans-serif',
  Serif: 'Georgia, "Times New Roman", serif',
  Mono: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
  Display: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
};
const ALIGN = { Left: 'flex-start', Center: 'center', Right: 'flex-end', Top: 'flex-start', Bottom: 'flex-end' };
const BUTTONS = new Set(['TextButton', 'ImageButton']);
const CLICKABLE_SIGNALS = ['MouseButton1Click', 'MouseButton1Down', 'MouseButton1Up', 'MouseButton2Click', 'MouseEnter', 'MouseLeave', 'Activated'];

const rgb = (c, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
const dim = (scale, offset) => `calc(${scale * 100}% + ${offset}px)`;
const el = (tag, cls, style) => { const e = document.createElement(tag); if (cls) e.className = cls; if (style) Object.assign(e.style, style); return e; };

export class WickGui {
  constructor(dm, host) {
    this.dm = dm;
    this.layer = el('div', 'wk-gui-layer');
    host.append(this.layer);
    this.nodes = new Map(); // instance id -> { el, content }
    this.listened = new Set(); // 'id:Signal' pairs a script connected to
    this.playing = false;
    this.editing = false;
    this.visible = true;
    this.selection = [];
    this.onSignal = null; // (id, signalName, ...encodedArgs)
    this.onEditSelect = null; // (inst, additive)
    this.onEditChange = null; // () after a drag or resize finished
    this._imageCache = new Map();
    this._timer = 0;
    this._overlay = el('div', 'wk-gui-overlay');
    this.layer.append(this._overlay);

    const again = () => this.schedule();
    for (const evt of ['added', 'removed', 'reparented', 'reset']) dm.on(evt, again);
    dm.on('changed', (inst, prop) => this._changed(inst, prop));
    dm.assets.onChange(again);
    new ResizeObserver(() => this._drawSelection()).observe(this.layer);
    this.rebuild();
  }

  // ---------------------------------------------------------------- modes

  setVisible(flag) { this.visible = flag; this._refreshMode(); }
  setEditing(flag) { this.editing = flag && !this.playing; this._refreshMode(); }

  setPlaying(flag) {
    this.playing = flag;
    this.editing = false;
    this.listened.clear();
    this._refreshMode();
    this.rebuild();
  }

  _refreshMode() {
    this.layer.classList.toggle('is-hidden', !this.visible && !this.playing);
    this.layer.classList.toggle('is-editing', this.editing);
    this.layer.classList.toggle('is-playing', this.playing);
    for (const [id, n] of this.nodes) this._pointer(this.dm.find(id), n);
    this._drawSelection();
  }

  _pointer(inst, n) {
    if (!inst || !n.el) return;
    const interactive = this.editing || (this.playing && (BUTTONS.has(inst.className) || inst.className === 'TextBox' || inst.className === 'ScrollingFrame'
      || CLICKABLE_SIGNALS.some((s) => this.listened.has(`${inst.id}:${s}`))));
    n.el.style.pointerEvents = interactive ? 'auto' : 'none';
  }

  // ---------------------------------------------------------------- building

  schedule() {
    if (this._timer) return;
    this._timer = requestAnimationFrame(() => { this._timer = 0; this.rebuild(); });
  }

  rebuild() {
    this.nodes.clear();
    const screens = [];
    for (const d of this.dm.descendants(this.dm.gui)) if (d.className === 'ScreenGui') screens.push(d);
    this.layer.replaceChildren(...screens.map((s) => this._screen(s)), this._overlay);
    this._drawSelection();
  }

  _screen(inst) {
    const e = el('div', 'wk-gui-screen');
    const n = { el: e, content: e };
    this.nodes.set(inst.id, n);
    this._applyScreen(inst, n);
    this._children(inst, n);
    return e;
  }

  _applyScreen(inst, n) {
    n.el.style.display = inst.props.Enabled ? '' : 'none';
    n.el.style.zIndex = String(inst.props.DisplayOrder + 1000);
  }

  _children(inst, n) {
    for (const c of inst.children) {
      if (!isGuiObject(c.className)) continue;
      const child = this._object(c);
      n.content.append(child.el);
    }
  }

  _object(inst) {
    const cls = inst.className;
    const e = el('div', `wk-gui wk-gui-${cls.toLowerCase()}`);
    e.dataset.id = inst.id;
    const n = { el: e, content: null, text: null, input: null, img: null, tint: null };
    this.nodes.set(inst.id, n);
    if (cls === 'ImageLabel' || cls === 'ImageButton') {
      n.img = el('div', 'wk-gui-img');
      n.tint = el('div', 'wk-gui-tint');
      e.append(n.img, n.tint);
    }
    if (cls === 'TextLabel' || cls === 'TextButton') { n.text = el('div', 'wk-gui-text'); e.append(n.text); }
    if (cls === 'TextBox') {
      n.input = el('textarea', 'wk-gui-input');
      n.input.spellcheck = false;
      e.append(n.input);
    }
    n.content = el('div', 'wk-gui-content');
    if (cls === 'ScrollingFrame') { n.canvas = el('div', 'wk-gui-canvas'); n.canvas.append(n.content); e.append(n.canvas); }
    else e.append(n.content);
    this._wire(inst, n);
    this._apply(inst);
    this._children(inst, n);
    return n;
  }

  // ---------------------------------------------------------------- styling

  _modifiers(inst) {
    const out = {};
    for (const c of inst.children) if (GUI_MODIFIERS.has(c.className)) out[c.className] = c.props;
    return out;
  }

  /** The layout the parent applies to its children, or null. */
  _layoutOf(inst) {
    const parent = inst.parent;
    if (!parent || !isGuiObject(parent.className)) return null;
    const m = this._modifiers(parent);
    if (m.UIListLayout) return { kind: 'list', props: m.UIListLayout, parent };
    if (m.UIGridLayout) return { kind: 'grid', props: m.UIGridLayout, parent };
    return null;
  }

  _apply(inst) {
    const n = this.nodes.get(inst.id);
    if (!n) return;
    const p = inst.props, e = n.el, cls = inst.className, m = this._modifiers(inst), layout = this._layoutOf(inst);
    const s = e.style;
    s.display = p.Visible ? '' : 'none';
    s.zIndex = String(p.ZIndex);
    s.overflow = p.ClipsDescendants || cls === 'ScrollingFrame' ? (cls === 'ScrollingFrame' && p.ScrollingEnabled ? 'auto' : 'hidden') : 'visible';
    s.scrollbarWidth = cls === 'ScrollingFrame' ? (p.ScrollBarThickness > 0 ? 'thin' : 'none') : '';

    // size and position
    const grid = layout?.kind === 'grid' ? layout.props : null;
    const size = grid ? [grid.CellSize[0], grid.CellSize[1], grid.CellSize[2], grid.CellSize[3]] : p.Size;
    s.width = dim(size[0], size[1]);
    s.height = dim(size[2], size[3]);
    if (m.UIAspectRatioConstraint) { s.aspectRatio = String(m.UIAspectRatioConstraint.AspectRatio); s.height = 'auto'; } else s.aspectRatio = '';
    if (layout) {
      s.position = 'relative';
      s.left = s.top = '0';
      s.flex = 'none';
      s.order = String(this._order(inst, layout));
    } else {
      s.position = 'absolute';
      s.left = dim(p.Position[0], p.Position[1]);
      s.top = dim(p.Position[2], p.Position[3]);
      s.order = '';
    }
    const scale = m.UIScale ? m.UIScale.Scale : 1;
    s.transform = layout ? (scale !== 1 ? `scale(${scale})` : '') : `translate(${-p.AnchorPoint[0] * 100}%, ${-p.AnchorPoint[1] * 100}%) rotate(${p.Rotation}deg) scale(${scale})`;

    // look
    const alpha = 1 - p.BackgroundTransparency;
    const grad = m.UIGradient;
    s.backgroundColor = rgb(p.BackgroundColor, alpha);
    s.backgroundImage = grad ? `linear-gradient(${grad.Rotation}deg, ${rgb(grad.Color0, alpha)}, ${rgb(grad.Color1, alpha)})` : '';
    s.borderRadius = m.UICorner ? `${m.UICorner.CornerRadius}px` : '';
    s.boxShadow = m.UIStroke ? `inset 0 0 0 ${m.UIStroke.Thickness}px ${rgb(m.UIStroke.Color, 1 - m.UIStroke.Transparency)}` : '';
    e.classList.toggle('wk-auto', !!p.AutoButtonColor && this.playing);

    // content box: padding and the layout of this element's own children
    const c = n.content.style;
    const pad = m.UIPadding;
    c.inset = pad ? `${pad.PaddingTop}px ${pad.PaddingRight}px ${pad.PaddingBottom}px ${pad.PaddingLeft}px` : '0';
    c.display = ''; c.flexDirection = ''; c.flexWrap = ''; c.gap = ''; c.alignItems = ''; c.justifyContent = ''; c.alignContent = '';
    if (m.UIListLayout) {
      const l = m.UIListLayout, vertical = l.FillDirection === 'Vertical';
      c.display = 'flex';
      c.flexDirection = vertical ? 'column' : 'row';
      c.gap = `${l.Padding}px`;
      c.alignItems = ALIGN[vertical ? l.HorizontalAlignment : l.VerticalAlignment];
      c.justifyContent = ALIGN[vertical ? l.VerticalAlignment : l.HorizontalAlignment];
    } else if (m.UIGridLayout) {
      const g = m.UIGridLayout;
      c.display = 'flex';
      c.flexWrap = 'wrap';
      c.flexDirection = g.FillDirection === 'Horizontal' ? 'row' : 'column';
      c.gap = `${g.CellPadding[3]}px ${g.CellPadding[1]}px`;
      c.alignContent = 'flex-start';
      c.alignItems = 'flex-start';
    }
    if (n.canvas) {
      n.canvas.style.width = dim(p.CanvasSize[0] || 1, p.CanvasSize[1]);
      n.canvas.style.height = dim(p.CanvasSize[2] || 0, p.CanvasSize[3] || 0);
      n.canvas.style.minHeight = '100%';
    }

    // text
    const label = n.text;
    if (label || n.input) {
      const t = label ?? n.input, ts = t.style;
      ts.color = rgb(p.TextColor, 1 - p.TextTransparency);
      ts.fontSize = `${p.TextSize}px`;
      ts.fontFamily = FONTS[p.Font];
      ts.textAlign = p.TextXAlignment.toLowerCase();
      ts.whiteSpace = p.TextWrapped ? 'pre-wrap' : 'pre';
      if (label) {
        ts.justifyContent = ALIGN[p.TextXAlignment];
        ts.alignItems = ALIGN[p.TextYAlignment];
        label.textContent = p.Text;
      } else {
        n.input.placeholder = p.PlaceholderText;
        n.input.style.paddingTop = p.TextYAlignment === 'Center' ? `${Math.max(0, (e.clientHeight - p.TextSize * 1.3) / 2)}px` : '';
        if (document.activeElement !== n.input) n.input.value = p.Text;
        n.input.rows = 1;
        n.input.readOnly = this.editing;
      }
    }
    if (n.img) {
      n.img.style.backgroundImage = this._imageUrl(p.Image) ? `url("${this._imageUrl(p.Image)}")` : 'none';
      n.img.style.backgroundSize = { Stretch: '100% 100%', Fit: 'contain', Crop: 'cover' }[p.ScaleType];
      n.img.style.opacity = String(1 - p.ImageTransparency);
      const white = p.ImageColor.every((v) => v > 0.99);
      n.tint.style.display = white ? 'none' : 'block';
      n.tint.style.backgroundColor = rgb(p.ImageColor);
      n.tint.style.webkitMaskImage = n.tint.style.maskImage = n.img.style.backgroundImage;
      n.tint.style.maskSize = n.tint.style.webkitMaskSize = n.img.style.backgroundSize;
      n.tint.style.opacity = String(1 - p.ImageTransparency);
    }
    this._pointer(inst, n);
  }

  _order(inst, layout) {
    const kids = layout.parent.children.filter((c) => isGuiObject(c.className));
    kids.sort(layout.props.SortOrder === 'Name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => a.props.LayoutOrder - b.props.LayoutOrder);
    return kids.indexOf(inst);
  }

  _changed(inst, prop) {
    if (this.playing && !this.nodes.has(inst.id) && !GUI_MODIFIERS.has(inst.className)) return;
    if (inst.className === 'ScreenGui') { const n = this.nodes.get(inst.id); if (n) this._applyScreen(inst, n); return; }
    if (GUI_MODIFIERS.has(inst.className)) {
      const parent = inst.parent;
      if (parent && this.nodes.has(parent.id)) {
        this._apply(parent);
        for (const c of parent.children) if (isGuiObject(c.className)) this._apply(c); // a layout change reflows the children
      }
    } else if (isGuiObject(inst.className)) {
      this._apply(inst);
      if (prop === 'LayoutOrder' || prop === 'Name') for (const c of inst.parent?.children ?? []) if (isGuiObject(c.className)) this._apply(c);
    }
    this._drawSelection();
  }

  _imageUrl(id) {
    if (!id) return '';
    if (/^https?:\/\//i.test(id)) return id;
    const asset = assetIdOf(id);
    if (asset) return this.dm.assets.get(asset)?.kind === 'texture' ? this.dm.assets.url(asset) : '';
    const lib = libraryTextureName(id);
    if (!lib) return '';
    if (!this._imageCache.has(lib)) {
      const { color } = surfaceTexture(lib, 128);
      const canvas = el('canvas');
      canvas.width = canvas.height = 128;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(color), 128, 128), 0, 0);
      this._imageCache.set(lib, canvas.toDataURL());
    }
    return this._imageCache.get(lib);
  }

  // ---------------------------------------------------------------- events

  /** A script connected to an event on this instance. Returns false if the class has no such event. */
  listen(inst, name) {
    if (!isGuiObject(inst.className)) return false;
    const valid = inst.className === 'TextBox' ? ['Focused', 'FocusLost', 'MouseEnter', 'MouseLeave'] : CLICKABLE_SIGNALS;
    if (!valid.includes(name)) return false;
    this.listened.add(`${inst.id}:${name}`);
    this._pointer(inst, this.nodes.get(inst.id));
    return true;
  }

  focus(inst, on) {
    const input = this.nodes.get(inst.id)?.input;
    if (input) on ? input.focus() : input.blur();
  }

  _emit(inst, name, ...args) {
    if (this.playing && this.listened.has(`${inst.id}:${name}`)) this.onSignal?.(inst.id, name, ...args);
  }

  _wire(inst, n) {
    const e = n.el;
    e.addEventListener('pointerenter', () => this._emit(inst, 'MouseEnter'));
    e.addEventListener('pointerleave', () => this._emit(inst, 'MouseLeave'));
    e.addEventListener('pointerdown', (ev) => {
      if (this.editing) { this._editDown(ev, inst); return; }
      if (!this.playing) return;
      if (ev.button === 0) this._emit(inst, 'MouseButton1Down');
      if (e.classList.contains('wk-auto')) e.classList.add('is-pressed');
    });
    e.addEventListener('pointerup', (ev) => {
      e.classList.remove('is-pressed');
      if (this.playing && ev.button === 0) this._emit(inst, 'MouseButton1Up');
    });
    e.addEventListener('click', (ev) => {
      if (!this.playing) return;
      this._emit(inst, 'MouseButton1Click');
      this._emit(inst, 'Activated');
      ev.stopPropagation();
    });
    e.addEventListener('contextmenu', () => { if (this.playing) this._emit(inst, 'MouseButton2Click'); });
    if (n.input) {
      n.input.addEventListener('focus', () => {
        if (inst.props.ClearTextOnFocus) { inst.props.Text = ''; n.input.value = ''; }
        this._emit(inst, 'Focused');
      });
      n.input.addEventListener('blur', () => this._emit(inst, 'FocusLost', `b${n.input.dataset.enter === '1' ? 1 : 0}`, 'z'));
      n.input.addEventListener('input', () => { inst.props.Text = n.input.value.slice(0, 2000); }); // read by scripts, not an edit
      n.input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        n.input.dataset.enter = ev.key === 'Enter' ? '1' : '0';
        if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); n.input.blur(); }
      });
    }
  }

  // ---------------------------------------------------------------- visual editing

  setSelection(list) {
    this.selection = list.filter((i) => i && (isGuiObject(i.className)));
    this._drawSelection();
  }

  _rectOf(id) {
    const n = this.nodes.get(id);
    if (!n || !n.el.isConnected) return null;
    const r = n.el.getBoundingClientRect(), base = this.layer.getBoundingClientRect();
    return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
  }

  _drawSelection() {
    this._overlay.replaceChildren();
    if (!this.editing) return;
    for (const inst of this.selection) {
      const r = this._rectOf(inst.id);
      if (!r) continue;
      const box = el('div', 'wk-gui-sel', { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      for (const [hx, hy] of [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]]) {
        const h = el('div', 'wk-gui-handle', { left: `${hx * 100}%`, top: `${hy * 100}%`, cursor: hx === 0.5 ? 'ns-resize' : hy === 0.5 ? 'ew-resize' : hx === hy ? 'nwse-resize' : 'nesw-resize' });
        h.addEventListener('pointerdown', (ev) => this._resizeDown(ev, inst, hx, hy));
        box.append(h);
      }
      this._overlay.append(box);
    }
  }

  _editDown(ev, inst) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    this.onEditSelect?.(inst, ev.shiftKey);
    if (this._layoutOf(inst)) return; // children of a list or grid are placed by the layout
    this._dragStart(ev, [inst], (dx, dy, starts) => {
      for (const s of starts) this.dm.set(s.inst, 'Position', [s.p[0], s.p[1] + dx, s.p[2], s.p[3] + dy]);
    });
  }

  _resizeDown(ev, inst, hx, hy) {
    ev.stopPropagation();
    ev.preventDefault();
    const a = inst.props.AnchorPoint;
    this._dragStart(ev, [inst], (dx, dy, [s]) => {
      let { p, z } = { p: s.p.slice(), z: s.z.slice() };
      // Moving an edge by d changes the size by +-d, and the position by the share of it the AnchorPoint holds.
      if (hx === 0) { z[1] -= dx; p[1] += dx * (1 - a[0]); } else if (hx === 1) { z[1] += dx; p[1] += dx * a[0]; }
      if (hy === 0) { z[3] -= dy; p[3] += dy * (1 - a[1]); } else if (hy === 1) { z[3] += dy; p[3] += dy * a[1]; }
      this.dm.set(s.inst, 'Size', z);
      this.dm.set(s.inst, 'Position', p);
    });
  }

  _dragStart(ev, insts, apply) {
    const starts = insts.map((inst) => ({ inst, p: inst.props.Position.slice(), z: inst.props.Size.slice() }));
    const x0 = ev.clientX, y0 = ev.clientY;
    let moved = false;
    const move = (e) => {
      const dx = Math.round(e.clientX - x0), dy = Math.round(e.clientY - y0);
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      try { apply(dx, dy, starts); } catch { /* clamped or invalid: ignore this step */ }
      this._drawSelection();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) this.onEditChange?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}

export { GUI_OBJECTS };
