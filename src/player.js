// Wick player: runs an exported game (game/game.wick) full screen, with none of the Studio around it.
// boot.js starts this instead of the Studio when a game/ folder is deployed next to index.html.

import { WickDataModel } from './engine/datamodel.js';
import { WickAssets } from './engine/assets.js';
import { WickWorld } from './engine/world.js';
import { WickPhysics } from './engine/physics.js';
import { WickAudio } from './engine/audio.js';
import { WickGuard, WickLimits, DEFAULT_HARDWARE } from './engine/guard.js';
import { WickRuntime } from './engine/runtime.js';
import { WickGui } from './engine/gui.js';
import { importProjectData } from './project/projectfile.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

export async function startPlayer({ root, havok, core, config }) {
  const assets = new WickAssets({ persist: false }); // the game carries its own assets
  const dm = new WickDataModel(assets);

  const canvas = el('canvas', 'wk-canvas');
  canvas.tabIndex = 0;
  const stage = el('div', 'wk-player-stage');
  stage.append(canvas);
  const title = el('div', 'wk-player-title', config.title || 'Wick Game');
  const message = el('div', 'wk-player-text', 'Loading...');
  const play = el('button', 'wk-player-play', 'Play');
  play.disabled = true;
  const overlay = el('div', 'wk-player-overlay');
  overlay.append(title, message, play);
  const bar = el('div', 'wk-player-bar');
  const pauseBtn = el('button', 'wk-player-btn', 'Pause');
  const fullBtn = el('button', 'wk-player-btn', 'Full screen');
  bar.append(pauseBtn, fullBtn);
  const app = el('div', 'wk-player');
  app.append(stage, bar, overlay);
  root.replaceChildren(app);
  document.title = config.title || 'Wick Game';

  const res = await fetch('game/game.wick');
  if (!res.ok) throw new Error(`The game file game/game.wick could not be loaded (${res.status}).`);
  dm.load(await importProjectData(await res.json(), assets));

  const limits = new WickLimits();
  limits.hardware = { ...DEFAULT_HARDWARE, tier: (navigator.hardwareConcurrency || 4) <= 4 ? 1 : 0, score: (navigator.hardwareConcurrency || 4) <= 4 ? 0.45 : 0.8 }; // no diagnostic here: Auto steps down by itself
  limits.apply();
  const world = new WickWorld(canvas, dm);
  world.onWarn = (t) => console.warn(t);
  const physics = new WickPhysics(world.scene, havok);
  const audio = new WickAudio(world, (level, text) => console[level === 'error' ? 'error' : 'log'](text));
  const guard = new WickGuard(core, world, limits);
  const gui = new WickGui(dm, stage);
  const log = (level, text) => (level === 'error' ? console.error(text) : level === 'warn' ? console.warn(text) : console.log(text));
  const runtime = new WickRuntime({ dm, world, physics, audio, core, guard, limits, log, gui });
  guard.setQuality('auto');
  world.onFrame = (ms) => guard.frame(ms);
  world.onMouseButton = (button, down) => runtime.onMouse(button, down);
  world.onContextLost = () => runtime.stop('The graphics context was lost, so the game was stopped.');
  guard.onStop = (msg) => queueMicrotask(() => runtime.stop(msg));

  const show = (text, label) => { message.textContent = text; play.textContent = label; play.disabled = false; overlay.hidden = false; bar.hidden = true; };
  runtime.onStateChange = (playing, reason) => {
    if (playing) { overlay.hidden = true; bar.hidden = false; return; }
    show(reason || 'The game ended.', 'Play again');
  };
  runtime.onPauseChange = (paused) => { pauseBtn.textContent = paused ? 'Resume' : 'Pause'; };
  play.addEventListener('click', async () => { play.disabled = true; message.textContent = 'Starting...'; await runtime.play(); canvas.focus(); });
  pauseBtn.addEventListener('click', () => (runtime.paused ? runtime.resume() : runtime.pause()));
  fullBtn.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else app.requestFullscreen?.(); });

  const typing = (t) => !!t?.closest?.('input, textarea, select');
  window.addEventListener('keydown', (e) => {
    if (typing(e.target) || !runtime.playing) return;
    if (!(e.ctrlKey || e.metaKey)) world.setKey(e.code, true);
    runtime.onKey(e.code, true);
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { world.setKey(e.code, false); runtime.onKey(e.code, false); });
  window.addEventListener('blur', () => { world.keys.clear(); runtime.releaseInputs(); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (runtime.playing && !runtime.paused) runtime.pause(true); return; }
    if (runtime.autoPaused) runtime.resume();
    guard.reset(true);
  });
  window.addEventListener('error', (e) => console.error(`Internal error: ${e.message}`));

  show(config.description || 'Ready.', 'Play');
  bar.hidden = true;
  return { dm, world, runtime };
}
