// Wick Engine boot: loads Babylon.js and Havok from core/third_party, starts the WASM core, then hands over to the studio,
// or to the player when an exported game is deployed (game/game.json). Also registers the service worker, so after the
// first load everything runs offline. Both libraries are served from this repo (see pages.yml).

import { WickCore } from './engine/core.js';
import { WickAssets } from './engine/assets.js';

const LIBS = {
  babylon: 'core/third_party/babylon.js',
  havok: 'core/third_party/HavokPhysics_umd.js',
  // Havok's UMD script does not contain the physics engine itself: it fetches this file at start-up.
  havokWasm: 'core/third_party/HavokPhysics.wasm',
};

const root = document.getElementById('wick-root');

function splash(message, failed = false) {
  const box = document.createElement('div');
  box.className = `wk-splash${failed ? ' is-error' : ''}`;
  const title = document.createElement('div');
  title.className = 'wk-splash-title';
  title.textContent = failed ? 'Wick Engine could not start' : 'WICK ENGINE';
  const text = document.createElement('div');
  text.className = 'wk-splash-text';
  text.textContent = message;
  box.append(title, text);
  root.replaceChildren(box);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}. Check that the file is in the repo and was copied to the site.`));
    document.head.append(el);
  });
}

async function startHavok() {
  if (typeof globalThis.HavokPhysics !== 'function') {
    throw new Error(`${LIBS.havok} loaded but defines no HavokPhysics function. It must be the UMD build, HavokPhysics_umd.js.`);
  }
  const probe = await fetch(LIBS.havokWasm, { method: 'HEAD' }).catch(() => null);
  if (!probe?.ok) {
    throw new Error(`${LIBS.havokWasm} is missing. Havok needs HavokPhysics.wasm from the same @babylonjs/havok version as the UMD script, in the same folder.`);
  }
  return globalThis.HavokPhysics({ locateFile: (file) => (file.endsWith('.wasm') ? LIBS.havokWasm : file) });
}

/** game/game.json when a game is deployed next to the engine, otherwise null. */
async function loadGameConfig() {
  try {
    const res = await fetch('game/game.json', { cache: 'no-cache' });
    if (!res.ok) return null;
    const config = await res.json();
    return config?.format === 'wick-game' ? config : null;
  } catch {
    return null;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Offline support is unavailable:', err));
}

async function boot() {
  if (typeof WebAssembly !== 'object' || !document.createElement('canvas').getContext('webgl2')) {
    throw new Error('This browser needs WebAssembly and WebGL 2. Please use a current version of Chrome, Edge, Firefox or Safari.');
  }
  registerServiceWorker();
  splash('Loading Babylon.js and Havok...');
  await Promise.all([loadScript(LIBS.babylon), loadScript(LIBS.havok)]);
  if (!globalThis.BABYLON) throw new Error(`${LIBS.babylon} loaded but defines no BABYLON. It must be the UMD build (babylon.js).`);
  splash('Starting physics...');
  const havok = await startHavok();
  splash('Starting the Lua core...');
  const core = await WickCore.load();

  // An exported game boots straight into the player. Adding ?studio opens the editor if the game's game.json allows it.
  const config = await loadGameConfig();
  if (config && !(new URLSearchParams(location.search).has('studio') && config.studio)) {
    splash('Loading the game...');
    const { startPlayer } = await import('./player.js');
    await startPlayer({ root, havok, core, config });
    return;
  }

  splash('Opening your Library...');
  const assets = new WickAssets();
  await assets.open();
  splash('Opening the studio...');
  const { startStudio } = await import('./studio/shell.js');
  await startStudio({ root, havok, core, assets });
}

boot().catch((err) => {
  console.error(err);
  splash(err.message || String(err), true);
});
