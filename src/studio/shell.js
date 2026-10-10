// Wick Studio shell: builds the window layout (menus, toolbar, viewport, docks, output, status bar),
// creates every engine system and wires them together.

import { WickDataModel } from '../engine/datamodel.js';
import { WickWorld, TIERS } from '../engine/world.js';
import { WickPhysics } from '../engine/physics.js';
import { WickAudio } from '../engine/audio.js';
import { WickGuard } from '../engine/guard.js';
import { WickRuntime } from '../engine/runtime.js';
import { WickProject, loadSettings, saveSettings } from '../project/project.js';
import { WickStudio } from './studio.js';
import { WickExplorer } from './explorer.js';
import { WickProperties } from './properties.js';
import { WickScriptEditor } from './scripteditor.js';
import { h, icon, showMenu, closeMenus, isMenuOpen, infoDialog, modal, toast, installAppFeel } from './ui.js';

const MAX_OUTPUT_LINES = 600;
const isTyping = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');

export function startStudio({ root, havok, core }) {
  const settings = loadSettings();

  // ---------------------------------------------------------------- layout
  const canvas = h('canvas', { class: 'wk-canvas', tabindex: '0' });
  const playBadge = h('div', { class: 'wk-play-badge' }, 'PLAYING  ·  hold right mouse to look  ·  W A S D Q E to fly');
  const viewportPane = h('div', { class: 'wk-pane is-active wk-viewport' }, canvas, playBadge);
  const panesEl = h('div', { class: 'wk-panes' }, viewportPane);
  const tabsEl = h('div', { class: 'wk-tabs' });
  const explorerEl = h('div', { class: 'wk-tree' });
  const propsEl = h('div', { class: 'wk-props' });
  const outputBody = h('div', { class: 'wk-output-body is-selectable' });
  const statusText = h('span', {}, 'Ready');
  const statFps = h('span', {});
  const statParts = h('span', {});
  const statLua = h('span', {});
  const statQuality = h('span', { class: 'wk-stat-quality' });
  const titleBtn = h('button', { class: 'wk-title', title: 'Rename project' });

  const mkBtn = (cls, title, content, onclick) => h('button', { class: cls, title, onclick }, content);
  const toolBtns = {};
  const tool = (id, label, key) => {
    toolBtns[id] = mkBtn('wk-tool', `${label} (${key})`, [icon(id), h('span', {}, label)], () => studio.setTool(id));
    return toolBtns[id];
  };
  const insertBtn = (what, ic, label) => mkBtn('wk-tool is-icon', `Insert ${label}`, icon(ic), () => studio.insert(what));
  const playBtn = mkBtn('wk-play', 'Run the game', [icon('play'), h('span', {}, 'Play')], () => togglePlay());
  const stopBtn = mkBtn('wk-stop', 'Stop the game', [icon('stop'), h('span', {}, 'Stop')], () => runtime.stop());
  const qualityBtn = h('button', { class: 'wk-chip', 'data-menu-anchor': '', title: 'Graphics quality' }, statQuality);

  const menubar = h('div', { class: 'wk-menubar' }, h('div', { class: 'wk-logo' }, 'WICK'));
  const toolbar = h('div', { class: 'wk-toolbar' },
    h('div', { class: 'wk-group' }, tool('select', 'Select', 'Q'), tool('move', 'Move', 'W'), tool('rotate', 'Rotate', 'E'), tool('scale', 'Scale', 'R')),
    h('div', { class: 'wk-group' },
      insertBtn('Block', 'block', 'Block'), insertBtn('Ball', 'ball', 'Ball'), insertBtn('Cylinder', 'cylinder', 'Cylinder'),
      insertBtn('Folder', 'folder', 'Folder'), insertBtn('Script', 'script', 'Script'), insertBtn('Sound', 'sound', 'Sound'),
      insertBtn('PointLight', 'light', 'PointLight')),
    h('div', { class: 'wk-group' }, playBtn, stopBtn),
    h('div', { class: 'wk-spacer' }), qualityBtn);

  const dock = h('div', { class: 'wk-dock' },
    h('div', { class: 'wk-panel wk-panel-explorer' }, h('div', { class: 'wk-panel-head' }, 'Explorer'), explorerEl),
    h('div', { class: 'wk-panel wk-panel-props' }, h('div', { class: 'wk-panel-head' }, 'Properties'), propsEl));
  const vSplit = h('div', { class: 'wk-splitter is-v' });
  const hSplit = h('div', { class: 'wk-splitter is-h' });
  const output = h('div', { class: 'wk-output' },
    h('div', { class: 'wk-panel-head' }, 'Output', h('button', { class: 'wk-link', onclick: () => outputBody.replaceChildren() }, 'Clear')), outputBody);

  const app = h('div', { class: 'wk-app' },
    menubar, toolbar,
    h('div', { class: 'wk-center' }, tabsEl, panesEl), vSplit, dock, hSplit, output,
    h('div', { class: 'wk-status' }, statusText, h('div', { class: 'wk-spacer' }), statLua, statParts, statFps),
    h('div', { class: 'wk-small-screen' }, 'Wick Engine Studio needs a larger window. Please use a desktop browser.'));
  root.replaceChildren(app);

  // ---------------------------------------------------------------- output panel
  const pending = [];
  const flushOutput = () => {
    const stick = outputBody.scrollTop + outputBody.clientHeight >= outputBody.scrollHeight - 24;
    outputBody.append(...pending.splice(0, 120).map(([level, text]) => h('div', { class: `wk-line is-${level}` }, text)));
    while (outputBody.childElementCount > MAX_OUTPUT_LINES) outputBody.firstElementChild.remove();
    if (stick) outputBody.scrollTop = outputBody.scrollHeight;
    if (pending.length) requestAnimationFrame(flushOutput);
  };
  const log = (level, text) => {
    if (pending.push([level, text]) === 1) requestAnimationFrame(flushOutput);
    if (pending.length > 2000) pending.splice(0, pending.length - 1000); // never let a log flood grow without bound
  };
  const status = (text) => { statusText.textContent = text; };

  // ---------------------------------------------------------------- engine systems
  const dm = new WickDataModel();
  const world = new WickWorld(canvas, dm);
  const physics = new WickPhysics(world.scene, havok);
  const audio = new WickAudio(world, log);
  const guard = new WickGuard(core, world);
  const runtime = new WickRuntime({ dm, world, physics, audio, core, guard, log });
  const studio = new WickStudio({ dm, world, runtime, guard, log, toast });
  const explorer = new WickExplorer(studio, explorerEl);
  new WickProperties(studio, propsEl);
  const editor = new WickScriptEditor(studio, { tabsEl, panesEl, viewportPane });
  const project = new WickProject(studio, { onStatus: status, onTitle: (n) => { titleBtn.textContent = n; document.title = `${n} | Wick Engine`; } });

  world.onPick = (inst) => studio.select(inst);
  world.onTransformCommit = () => studio.commit();
  world.onContextRequest = (inst, x, y) => explorer.menu(inst, x, y);
  world.onMouseButton = (button, down) => runtime.onMouse(button, down);
  world.onFrame = (ms) => guard.frame(ms);
  world.onContextLost = () => {
    log('error', 'The graphics context was lost (usually a GPU reset).');
    if (runtime.playing) runtime.stop('The graphics context was lost, so the game was stopped.');
  };
  guard.onDegrade = (tier) => { log('warn', `Wick Guard lowered graphics quality to ${tier} to keep the game smooth.`); toast(`Graphics quality lowered to ${tier}`, 'warn'); refreshStats(); };
  guard.onStop = (message) => {
    log('error', `Wick Guard stopped the game: ${message}`);
    queueMicrotask(() => runtime.stop(message));
  };

  runtime.onStateChange = (playing, reason) => {
    app.classList.toggle('is-playing', playing);
    studio.emit('playstate');
    status(playing ? 'Playing' : 'Stopped');
    if (!playing) { world.keys.clear(); held.clear(); }
    if (!playing && reason) {
      modal({
        title: 'Wick Guard stopped the game',
        content: [h('p', {}, reason), h('p', { class: 'wk-muted' }, 'Your project is safe and was restored to how it was before you pressed Play.')],
        width: 460,
      });
    }
  };
  studio.on('dirty', () => status('Unsaved changes'));
  studio.on('tool', (t) => Object.entries(toolBtns).forEach(([id, b]) => b.classList.toggle('is-active', id === t)));
  studio.setTool('select');

  async function togglePlay() {
    if (runtime.playing) { runtime.stop(); return; }
    editor.show('viewport');
    await runtime.play();
  }

  // ---------------------------------------------------------------- menus
  const quality = () => guard.quality;
  const setQuality = (q) => {
    guard.setQuality(q);
    saveSettings({ quality: q });
    refreshStats();
  };
  const panel = (cls, label, key) => ({
    label, checked: !app.classList.contains(cls),
    action: () => { app.classList.toggle(cls); saveSettings({ [key]: app.classList.contains(cls) }); },
  });

  const fileMenu = () => [
    { label: 'New Project', action: () => project.newProject() },
    { label: 'Open Demo Project', action: () => project.openDemo() },
    { separator: true },
    { label: 'Open from File...', action: () => project.openFromPicker() },
    { label: 'Save to File...', shortcut: 'Ctrl+S', action: () => project.saveToFile() },
    { separator: true },
    { label: 'Rename Project...', action: () => project.rename() },
  ];
  const editMenu = () => [
    { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !studio.canUndo, action: () => studio.undo() },
    { label: 'Redo', shortcut: 'Ctrl+Y', disabled: !studio.canRedo, action: () => studio.redo() },
    { separator: true },
    { label: 'Copy', shortcut: 'Ctrl+C', disabled: !studio.selected || studio.selected.service, action: () => studio.copy() },
    { label: 'Paste', shortcut: 'Ctrl+V', disabled: !studio.clipboard, action: () => studio.paste() },
    { label: 'Duplicate', shortcut: 'Ctrl+D', disabled: !studio.selected || studio.selected.service, action: () => studio.duplicate() },
    { label: 'Rename', shortcut: 'F2', disabled: !studio.selected || studio.selected.service, action: () => explorer.beginRename() },
    { label: 'Delete', shortcut: 'Del', disabled: !studio.selected || studio.selected.service, action: () => studio.delete() },
  ];
  const qualityItems = () => [
    { label: 'Auto (recommended)', checked: quality() === 'auto', action: () => setQuality('auto') },
    ...TIERS.map((t, i) => ({ label: t.name, checked: quality() === i, action: () => setQuality(i) })),
  ];
  const viewMenu = () => [
    panel('hide-dock', 'Explorer and Properties', 'hideDock'),
    panel('hide-output', 'Output', 'hideOutput'),
    { separator: true },
    { label: 'Focus Selection', shortcut: 'F', disabled: studio.selected?.className !== 'Part', action: () => studio.focus() },
    { label: 'Graphics Quality', submenu: qualityItems() },
  ];
  const helpMenu = () => [
    { label: 'Controls and Lua Reference', action: showHelp },
    { label: 'About Wick Engine', action: showAbout },
  ];
  let openBtn = null;
  const menuButton = (label, items) => {
    const b = h('button', { class: 'wk-menubtn', 'data-menu-anchor': '' }, label);
    const open = () => { const r = b.getBoundingClientRect(); showMenu(items(), r.left, r.bottom); openBtn = b; };
    b.addEventListener('click', () => { if (isMenuOpen() && openBtn === b) closeMenus(); else open(); });
    b.addEventListener('pointerenter', () => { if (isMenuOpen()) open(); }); // slide between menus like a desktop app
    return b;
  };
  menubar.append(menuButton('File', fileMenu), menuButton('Edit', editMenu), menuButton('View', viewMenu), menuButton('Help', helpMenu), h('div', { class: 'wk-spacer' }), titleBtn, h('div', { class: 'wk-spacer' }));
  titleBtn.addEventListener('click', () => project.rename());
  qualityBtn.addEventListener('click', () => { const r = qualityBtn.getBoundingClientRect(); showMenu(qualityItems(), r.right - 180, r.bottom); });

  function showHelp() {
    const row = (k, v) => h('tr', {}, h('td', { class: 'wk-kbd-cell' }, k), h('td', {}, v));
    infoDialog('Controls and Lua Reference', h('div', { class: 'wk-help is-selectable' },
      h('h4', {}, 'Viewport'),
      h('table', {},
        row('Right mouse drag', 'Look around. Hold it and use W A S D Q E to fly, Shift to go faster.'),
        row('Middle mouse drag', 'Pan the camera.'),
        row('Mouse wheel', 'Move forward and back.'),
        row('Left click', 'Select a part. Q W E R switch Select, Move, Rotate, Scale.'),
        row('Short right click', 'Opens the context menu (copy, duplicate, delete...).'),
        row('F', 'Focus the selected part.')),
      h('h4', {}, 'Lua in Wick Engine (Lua 5.5)'),
      h('pre', {}, `-- Scripts in Workspace or Scripts run when you press Play.
local part = Instance.new("Part")      -- also Folder, Sound, PointLight
part.Name = "Crate"
part.Size = Vector3.new(2, 2, 2)
part.Color = Color3.fromRGB(255, 120, 40)
part.Material = "Metal"                -- Plastic Metal Glass Neon Wood
part.Position = Vector3.new(0, 10, 0)
part.Parent = workspace
part.Velocity = Vector3.new(0, 5, 0)
part:ApplyImpulse(Vector3.new(0, 20, 0))
part.Touched:Connect(function(other) print("hit", other.Name) end)

game:GetService("RunService").Heartbeat:Connect(function(dt) end)
local input = game:GetService("UserInputService")
input.InputBegan:Connect(function(key) print(key.KeyCode) end)  -- "W", "Space", "MouseButton1"
print(input:IsKeyDown("W"))

task.wait(1)  task.spawn(f)  task.delay(2, f)  task.defer(f)
workspace.CurrentCamera.Position   workspace.CurrentCamera.LookVector
workspace.Gravity = 4`),
      h('p', { class: 'wk-muted' }, 'A loop that never calls task.wait() is stopped after a short time so it cannot freeze the game.')), 640);
  }

  function showAbout() {
    infoDialog('About Wick Engine', [
      h('p', {}, 'Wick Engine is a browser game engine by Wick Studios. This is an early pre-alpha build.'),
      h('p', { class: 'wk-muted' }, `Rendering: Babylon.js ${globalThis.BABYLON.Engine.Version} with Havok physics. Scripting: Lua 5.5 compiled to WebAssembly. GPU: ${world.gpuName}.`),
    ]);
  }

  // ---------------------------------------------------------------- splitters
  const drag = (el, onMove) => el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const move = (ev) => onMove(ev);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', () => el.removeEventListener('pointermove', move), { once: true });
  });
  drag(vSplit, (e) => app.style.setProperty('--dock-w', `${Math.min(560, Math.max(220, window.innerWidth - e.clientX))}px`));
  drag(hSplit, (e) => app.style.setProperty('--out-h', `${Math.min(420, Math.max(60, window.innerHeight - 24 - e.clientY))}px`));
  if (settings.hideDock) app.classList.add('hide-dock');
  if (settings.hideOutput) app.classList.add('hide-output');

  // ---------------------------------------------------------------- keyboard
  const held = new Set();
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || document.querySelector('.wk-overlay')) return;
    world.setKey(e.code, true);
    if (runtime.playing) {
      if (!e.repeat) held.add(e.code);
      runtime.onKey(e.code, true, e.repeat);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod) {
      const handled = { s: () => project.saveToFile(), z: () => (e.shiftKey ? studio.redo() : studio.undo()), y: () => studio.redo(), c: () => studio.copy(), v: () => studio.paste(), d: () => studio.duplicate() }[k];
      if (handled) { e.preventDefault(); handled(); }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') studio.delete();
    else if (e.key === 'F2') { e.preventDefault(); explorer.beginRename(); }
    else if (!world.isLooking) {
      const t = { q: 'select', w: 'move', e: 'rotate', r: 'scale' }[k];
      if (t) studio.setTool(t);
      else if (k === 'f') studio.focus();
    }
  });
  window.addEventListener('keyup', (e) => {
    world.setKey(e.code, false);
    if (runtime.playing && held.delete(e.code)) runtime.onKey(e.code, false, false);
  });
  window.addEventListener('blur', () => {
    world.keys.clear();
    for (const code of held) runtime.onKey(code, false, false);
    held.clear();
  });

  // ---------------------------------------------------------------- status and boot
  function refreshStats() {
    statFps.textContent = `${Math.round(world.fps)} FPS`;
    statParts.textContent = `${dm.partCount} parts`;
    statLua.textContent = runtime.playing ? `Lua ${(runtime.heapBytes / 1048576).toFixed(1)} MB` : '';
    statQuality.textContent = `${quality() === 'auto' ? 'Auto' : 'Locked'} · ${TIERS[world.tier].name}`;
    playBtn.disabled = runtime.playing;
    stopBtn.disabled = !runtime.playing;
  }
  setInterval(refreshStats, 500);

  installAppFeel({ onFileDrop: (f) => project.openFile(f), isDirty: () => project.unsaved });
  window.addEventListener('error', (e) => log('error', `Internal error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => log('error', `Internal error: ${e.reason?.message || e.reason}`));

  guard.setQuality(settings.quality ?? 'auto');
  const firstVisit = !localStorage.getItem('wick.project.autosave');
  project.startup();
  refreshStats();
  log('info', 'Wick Engine ready. Press Play to run the project.');
  if (firstVisit) toast('Welcome! This is the demo project. File > New Project starts a fresh one.');

  return { dm, world, studio, runtime };
}
