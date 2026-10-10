// Wick Engine boot: loads Babylon.js and Havok, starts the WASM core, then hands over to the studio.
// Library URLs are the only version-sensitive setting. Pin them once you have tested a release.

import { WickCore } from './engine/core.js';

// I don't know why local scripts fail to load, so I'm externally referencing for now.
const LIBS = {
  babylon: 'https://cdn.babylonjs.com/babylon.js',
  havok: 'https://cdn.babylonjs.com/havok/HavokPhysics_umd.js',
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
    el.crossOrigin = 'anonymous';
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}. Check your connection.`));
    document.head.append(el);
  });
}

async function boot() {
  if (typeof WebAssembly !== 'object' || !document.createElement('canvas').getContext('webgl2')) {
    throw new Error('This browser needs WebAssembly and WebGL 2. Please use a current version of Chrome, Edge, Firefox or Safari.');
  }
  splash('Loading Babylon.js and Havok...');
  await Promise.all([loadScript(LIBS.babylon), loadScript(LIBS.havok)]);
  splash('Starting physics...');
  const havok = await globalThis.HavokPhysics();
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
