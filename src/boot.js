// Wick Engine boot: loads Babylon.js and Havok from core/third_party, starts the WASM core, then hands over to the studio.
// Both libraries are served from this repo, so the Pages workflow has to copy them into the site (see pages.yml).

import { WickCore } from './engine/core.js';

const LIBS = {
  babylon: 'core/third_party/babylon.js',
  havok: 'core/third_party/HavokPhsyics_umd.js',
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

async function boot() {
  if (typeof WebAssembly !== 'object' || !document.createElement('canvas').getContext('webgl2')) {
    throw new Error('This browser needs WebAssembly and WebGL 2. Please use a current version of Chrome, Edge, Firefox or Safari.');
  }
  splash('Loading Babylon.js and Havok...');
  await Promise.all([loadScript(LIBS.babylon), loadScript(LIBS.havok)]);
  if (!globalThis.BABYLON) throw new Error(`${LIBS.babylon} loaded but defines no BABYLON. It must be the UMD build (babylon.js).`);
  splash('Starting physics...');
  const havok = await startHavok();
  splash('Starting the Lua core...');
  const core = await WickCore.load();
  splash('Opening the studio...');
  const { startStudio } = await import('./studio/shell.js');
  startStudio({ root, havok, core });
}

boot().catch((err) => {
  console.error(err);
  splash(err.message || String(err), true);
});
