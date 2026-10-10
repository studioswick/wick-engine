// Wick Studio UI toolkit: DOM helper, icons, popup menus, dialogs, toasts, and the patches that make the
// page behave like an installed app (no browser context menu, no page zoom, no text-selection or drag quirks).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

// ---------------------------------------------------------------- icons (16px, stroke = currentColor)

const ICONS = {
  select: '<path d="M3 2l9 5.5-4 1-2 4z"/>',
  move: '<path d="M8 1.5v13M1.5 8h13M8 1.5l-2 2M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
  rotate: '<path d="M13 8a5 5 0 1 1-1.8-3.8M13 2.5v3h-3"/>',
  scale: '<rect x="2.5" y="6.5" width="7" height="7"/><path d="M7 9l6.5-6.5M9.5 2.5h4v4"/>',
  play: '<path d="M4.5 3l8 5-8 5z" fill="currentColor"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/>',
  block: '<path d="M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8zM2.5 4.8L8 8l5.5-3.2M8 8v6.2"/>',
  ball: '<circle cx="8" cy="8" r="5.5"/><path d="M2.6 7.2c3 1.4 7.8 1.4 10.8 0"/>',
  cylinder: '<ellipse cx="8" cy="4" rx="4.5" ry="1.8"/><path d="M3.5 4v8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V4"/>',
  script: '<path d="M6 4.5L2.5 8 6 11.5M10 4.5L13.5 8 10 11.5"/>',
  sound: '<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5"/>',
  light: '<path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.5.4.7.9.7 1.5h3.4c0-.6.2-1.1.7-1.5A4.2 4.2 0 0 0 8 1.8zM6.4 13h3.2"/>',
  folder: '<path d="M1.8 4.2h4l1.4 1.6h7v6.6H1.8z"/>',
  workspace: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c2 1.8 2 9.8 0 11.6M8 2.2c-2 1.8-2 9.8 0 11.6"/>',
  lighting: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>',
  game: '<path d="M8 1.8l6 6.2-6 6.2-6-6.2z"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
};

export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('class', 'wk-icon');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.4');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = ICONS[name] ?? ICONS.block;
  return s;
}

/** Explorer icon name for an instance. */
export function iconFor(inst) {
  switch (inst.className) {
    case 'DataModel': return 'game';
    case 'Workspace': return 'workspace';
    case 'Lighting': return 'lighting';
    case 'Scripts': case 'Script': return 'script';
    case 'Folder': return 'folder';
    case 'PointLight': return 'light';
    case 'Sound': return 'sound';
    case 'Part': return inst.props.Shape === 'Ball' ? 'ball' : inst.props.Shape === 'Cylinder' ? 'cylinder' : 'block';
    default: return 'block';
  }
}

// ---------------------------------------------------------------- popup menus

let menus = [];
let outsideListener = null;
const escListener = (e) => { if (e.key === 'Escape') closeMenus(); };

export const isMenuOpen = () => menus.length > 0;

export function closeMenus() {
  menus.forEach((m) => m.remove());
  menus = [];
  if (outsideListener) {
    document.removeEventListener('pointerdown', outsideListener, true);
    document.removeEventListener('keydown', escListener, true);
    window.removeEventListener('blur', closeMenus);
    window.removeEventListener('resize', closeMenus);
    outsideListener = null;
  }
}

function place(el, x, y) {
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
}

function buildMenu(items, depth) {
  const el = h('div', { class: 'wk-menu', role: 'menu' });
  for (const it of items) {
    if (it.separator) { el.append(h('div', { class: 'wk-sep' })); continue; }
    const row = h('div', { class: `wk-menu-item${it.disabled ? ' is-disabled' : ''}` },
      h('span', { class: 'wk-check' }, it.checked ? '✓' : ''),
      h('span', { class: 'wk-menu-label' }, it.label),
      it.submenu ? icon('chevron', 12) : h('span', { class: 'wk-kbd' }, it.shortcut || ''));
    if (it.submenu && !it.disabled) {
      row.addEventListener('pointerenter', () => openSub(row, it.submenu, depth + 1));
    } else {
      row.addEventListener('pointerenter', () => trimTo(depth));
    }
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled || it.submenu) return;
      closeMenus();
      it.action?.();
    });
    el.append(row);
  }
  return el;
}

function trimTo(depth) {
  while (menus.length > depth + 1) menus.pop().remove();
}

function openSub(row, items, depth) {
  trimTo(depth - 1);
  const sub = buildMenu(items, depth);
  document.body.append(sub);
  const r = row.getBoundingClientRect();
  place(sub, r.right - 2, r.top - 4);
  menus.push(sub);
}

/** Shows a popup menu at screen position (x, y). Items: { label, shortcut, action, disabled, checked, submenu, separator }. */
export function showMenu(items, x, y) {
  closeMenus();
  const root = buildMenu(items, 0);
  document.body.append(root);
  place(root, x, y);
  menus = [root];
  // Pressing the control that opened the menu is left to that control, so it can toggle the menu closed.
  outsideListener = (e) => { if (!e.target.closest?.('.wk-menu, [data-menu-anchor]')) closeMenus(); };
  document.addEventListener('pointerdown', outsideListener, true);
  document.addEventListener('keydown', escListener, true);
  window.addEventListener('blur', closeMenus);
  window.addEventListener('resize', closeMenus);
}

// ---------------------------------------------------------------- dialogs and toasts

/** Generic modal. Returns { close }. buttons: [{ label, primary, action }] where action may return false to stay open. */
export function modal({ title, content, buttons = [{ label: 'OK', primary: true }], width = 420 }) {
  closeMenus();
  const overlay = h('div', { class: 'wk-overlay' });
  const dialog = h('div', { class: 'wk-dialog', role: 'dialog', 'aria-modal': 'true', style: `width:${width}px` },
    h('div', { class: 'wk-dialog-title' }, title),
    h('div', { class: 'wk-dialog-body' }, content),
    h('div', { class: 'wk-dialog-actions' }, buttons.map((b) => h('button', {
      class: `wk-btn${b.primary ? ' is-primary' : ''}`,
      onclick: () => { if (b.action?.() !== false) close(); },
    }, b.label))));
  overlay.append(dialog);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); buttons.find((b) => b.cancel)?.action?.(); close(); }
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      const p = buttons.find((b) => b.primary);
      if (p && p.action?.() !== false) close();
    }
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  dialog.querySelector('input, .wk-btn.is-primary, .wk-btn')?.focus();
  return { close };
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { class: 'wk-input', type: 'text', value, spellcheck: 'false', maxlength: '80' });
    modal({
      title,
      content: [h('label', { class: 'wk-field' }, label, input)],
      buttons: [
        { label: 'Cancel', cancel: true, action: () => resolve(null) },
        { label: 'OK', primary: true, action: () => { resolve(input.value.trim() || null); } },
      ],
    });
    input.select();
  });
}

export function confirmDialog(title, message, okLabel = 'OK') {
  return new Promise((resolve) => {
    modal({
      title,
      content: h('p', {}, message),
      buttons: [
        { label: 'Cancel', cancel: true, action: () => resolve(false) },
        { label: okLabel, primary: true, action: () => { resolve(true); } },
      ],
    });
  });
}

export function infoDialog(title, content, width = 480) {
  return modal({ title, content, width });
}

let toastHost;
export function toast(message, kind = 'info') {
  toastHost ||= document.body.appendChild(h('div', { class: 'wk-toasts' }));
  const t = h('div', { class: `wk-toast is-${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => t.classList.add('is-leaving'), 3600);
  setTimeout(() => t.remove(), 4000);
}

// ---------------------------------------------------------------- app feel

/**
 * Makes the page behave like an app. Right-click and middle-click belong to the studio, pinch and ctrl+wheel
 * never zoom the page, nothing outside text fields is selectable, and dropped files never navigate away.
 */
export function installAppFeel({ onFileDrop, isDirty } = {}) {
  const editable = (t) => !!t?.closest?.('input, textarea, [contenteditable="true"]');

  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll cursor
  document.addEventListener('auxclick', (e) => e.preventDefault());
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false }); // pinch and ctrl+wheel
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('selectstart', (e) => { if (!editable(e.target) && !e.target.closest?.('.is-selectable')) e.preventDefault(); });
  document.addEventListener('dragstart', (e) => { if (!e.target.closest?.('[draggable="true"]')) e.preventDefault(); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) onFileDrop?.(file);
  });

  // Page-level shortcuts that an app would not expose (save, bookmark, print, find-next, select-all).
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (['s', 'd', 'p', 'g'].includes(k) || (k === 'a' && !editable(e.target))) e.preventDefault();
  }, true); // capture phase, so the script editor stopping propagation cannot let the browser shortcut through

  window.addEventListener('beforeunload', (e) => {
    if (isDirty?.()) { e.preventDefault(); e.returnValue = ''; }
  });
}
