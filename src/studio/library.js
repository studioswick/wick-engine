// Library dialog: built-in and imported sounds, textures, meshes, scripts and bundles.
// Imports (images, audio, 3D models, Lua, bundles) are saved in this browser's IndexedDB by WickAssets.

import { h, modal, toast, confirmDialog, promptDialog } from './ui.js';
import { ACCEPT, assetUri, extOf } from '../engine/assets.js';
import { WICK_SOUNDS, soundId, WICK_TEXTURES, textureId, VOID_TEXTURE, previewTexture, librarySamples, SOUND_RATE, WICK_MESHES, meshId, builtinMesh, textureId as texId } from '../engine/library.js';
import { LIBRARY_SCRIPTS, libraryScriptSource } from '../engine/libscripts.js';
import { WICK_BUNDLES } from '../engine/bundles.js';
import { wavUrl } from '../engine/audio.js';

const TABS = [
  { id: 'sound', title: 'Sounds' }, { id: 'texture', title: 'Textures' }, { id: 'mesh', title: 'Meshes' },
  { id: 'script', title: 'Scripts' }, { id: 'bundle', title: 'Bundles' },
];

/** Imports files into the library with a toast per result. options: { zUp }. Resolves with the records added. */
export async function importFiles(assets, files, options = {}) {
  const added = [];
  for (const file of files) {
    try {
      const rec = await assets.importFile(file, options);
      added.push(rec);
      toast(`Imported ${rec.name} to the Library`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (assets.error && added.length) toast('Browser storage is full or unavailable: imports will not survive closing this tab.', 'warn');
  return added;
}

/** Saves the selected objects to the Library as a bundle (asks for a name). */
export async function saveSelectionAsBundle(studio) {
  if (!studio.selection.length) { toast('Select the objects to put in the bundle first.', 'warn'); return; }
  const name = await promptDialog('Save as bundle', 'Bundle name', studio.selected.name);
  if (!name) return;
  await studio.dm.assets.add({ name, kind: 'bundle', mime: 'application/json', data: studio.bundleOfSelection(name) });
  toast(`Saved bundle ${name}`);
}

const thumb = (rgba, n) => {
  const c = h('canvas', { class: 'wk-lib-thumb', width: n, height: n });
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), n, n), 0, 0);
  return c;
};

export function showLibrary(studio, startTab = 'sound') {
  const { dm } = studio, assets = dm.assets;
  let tab = startTab;
  const state = { zUp: false, largest: 4 };
  const body = h('div', { class: 'wk-lib-body' });
  const tabs = h('div', { class: 'wk-help-tabs' });
  let audio = null;
  const play = (url) => { audio?.pause(); audio = new Audio(url); audio.volume = 0.6; audio.play().catch(() => {}); };

  const row = (preview, title, sub, actions) => h('div', { class: 'wk-lib-row' }, preview, h('div', { class: 'wk-lib-text' }, h('div', { class: 'wk-lib-name' }, title), h('div', { class: 'wk-muted' }, sub)), h('div', { class: 'wk-lib-actions' }, actions));
  const btn = (label, fn, primary = false) => h('button', { class: `wk-btn${primary ? ' is-primary' : ''}`, onclick: fn }, label);
  const section = (label) => h('div', { class: 'wk-lib-section' }, label);

  async function remove(rec) {
    const used = dm.usedAssetIds().includes(rec.id);
    const ok = await confirmDialog(`Delete ${rec.name}?`, used ? 'This project uses it, so anything that refers to it will stop working. It is removed from this browser.' : 'It is removed from this browser.', 'Delete');
    if (ok) await assets.remove(rec.id);
  }
  const deleteBtn = (rec) => h('button', { class: 'wk-btn', title: 'Delete from the Library', onclick: () => remove(rec) }, 'Delete');

  const builders = {
    sound() {
      const out = [section('Built in')];
      for (const n of WICK_SOUNDS) out.push(row(h('button', { class: 'wk-btn', onclick: () => play(wavUrl(librarySamples(n), SOUND_RATE)) }, 'Play'), n, soundId(n), btn('Add to Project', () => studio.insertSound(soundId(n), n), true)));
      out.push(section('Imported'));
      for (const r of assets.list('sound')) out.push(row(h('button', { class: 'wk-btn', onclick: () => play(assets.url(r.id)) }, 'Play'), r.name, assetUri(r.id), [btn('Add to Project', () => studio.insertSound(assetUri(r.id), r.name.replace(/\.[^.]+$/, '')), true), deleteBtn(r)]));
      return out;
    },
    texture() {
      const out = [h('p', { class: 'wk-muted' }, 'Textures go on the Texture property of Parts. Select Parts, then Apply. A Part\'s Color tints the texture; white shows it as is.'), section('Built in')];
      for (const n of WICK_TEXTURES) out.push(row(thumb(previewTexture(n, 64), 64), n, texId(n), btn('Apply to Selection', () => studio.applyTexture(texId(n)), true)));
      const swatch = h('div', { class: 'wk-lib-thumb wk-lib-void' });
      out.push(row(swatch, 'void', `${VOID_TEXTURE}: unlit, always exactly its TextureColor`, btn('Apply to Selection', () => studio.applyTexture(VOID_TEXTURE), true)));
      out.push(section('Imported'));
      for (const r of assets.list('texture')) out.push(row(h('img', { class: 'wk-lib-thumb', src: assets.url(r.id) }), r.name, assetUri(r.id), [btn('Apply to Selection', () => studio.applyTexture(assetUri(r.id)), true), deleteBtn(r)]));
      out.push(h('div', {}, btn('Clear Texture from Selection', () => studio.applyTexture(''))));
      return out;
    },
    mesh() {
      const out = [h('p', { class: 'wk-muted' }, 'Meshes become Parts with Shape = Mesh. Imported models are scaled so their largest side is the size set below, then resized like any Part.'), section('Built in')];
      for (const n of WICK_MESHES) out.push(row(h('div', { class: 'wk-lib-thumb wk-lib-mesh' }, n[0].toUpperCase()), n, `${meshId(n)} - ${builtinMesh(n).indices.length / 3} triangles`, btn('Insert', () => studio.insertMesh(meshId(n), n[0].toUpperCase() + n.slice(1), [1, 1, 1], state.largest), true)));
      out.push(section('Imported'));
      for (const r of assets.list('mesh')) {
        const dims = r.meta.size ?? [1, 1, 1];
        out.push(row(h('div', { class: 'wk-lib-thumb wk-lib-mesh' }, extOf(r.name).toUpperCase()), r.name, `${assetUri(r.id)} - ${r.meta.triangles.toLocaleString()} triangles`, [btn('Insert', () => studio.insertMesh(assetUri(r.id), r.name, dims, state.largest), true), deleteBtn(r)]));
      }
      return out;
    },
    script() {
      const out = [section('Built in')];
      for (const s of LIBRARY_SCRIPTS) out.push(row(h('div', { class: 'wk-lib-thumb wk-lib-mesh' }, 'Lua'), s.name, s.description, btn('Insert', async () => { try { studio.insertScript(s.name, await libraryScriptSource(s.id)); } catch (err) { toast(err.message, 'error'); } }, true)));
      out.push(section('Imported'));
      for (const r of assets.list('script')) out.push(row(h('div', { class: 'wk-lib-thumb wk-lib-mesh' }, 'Lua'), r.name, `${r.data.split('\n').length} lines`, [btn('Insert', () => studio.insertScript(r.name.replace(/\.[^.]+$/, ''), r.data), true), deleteBtn(r)]));
      return out;
    },
    bundle() {
      const out = [section('Built in')];
      for (const b of WICK_BUNDLES) out.push(row(h('div', { class: 'wk-lib-thumb wk-lib-mesh' }, 'Pkg'), b.name, b.description, btn('Insert', () => studio.insertBuiltinBundle(b.id), true)));
      out.push(section('Yours'));
      for (const r of assets.list('bundle')) out.push(row(h('div', { class: 'wk-lib-thumb wk-lib-mesh' }, 'Pkg'), r.name, `${r.data.nodes.length} top-level objects`, [btn('Insert', () => studio.insertCustomBundle(r.data), true), deleteBtn(r)]));
      out.push(h('div', {}, btn('Save Selection as Bundle...', () => saveBundle())));
      return out;
    },
  };

  const saveBundle = () => saveSelectionAsBundle(studio);

  function render() {
    tabs.replaceChildren(...TABS.map((t) => h('button', { class: `wk-help-tab${t.id === tab ? ' is-active' : ''}`, onclick: () => { tab = t.id; render(); } }, `${t.title} (${assets.list(t.id).length})`)));
    body.replaceChildren(...builders[tab]());
  }
  assets.onChange(() => { if (body.isConnected) render(); });

  const picker = h('input', { type: 'file', multiple: true, accept: ACCEPT, style: 'display:none', onchange: async () => {
    const added = await importFiles(assets, [...picker.files], { zUp: state.zUp });
    picker.value = '';
    if (added.length) { tab = added[added.length - 1].kind; render(); }
  } });
  const zUp = h('input', { type: 'checkbox', onchange: (e) => { state.zUp = e.target.checked; } });
  const size = h('input', { class: 'wk-input wk-num', type: 'number', value: state.largest, min: 0.1, step: 0.5, style: 'width:64px', onkeydown: (e) => e.stopPropagation(), onchange: (e) => { state.largest = Math.max(0.1, Number(e.target.value) || 4); } });
  const bar = h('div', { class: 'wk-lib-bar' },
    btn('Import Files...', () => picker.click(), true), picker,
    h('label', { class: 'wk-lib-opt' }, zUp, 'Z axis is up (3D models)'),
    h('label', { class: 'wk-lib-opt' }, 'Largest side', size, 'studs'),
    h('span', { class: 'wk-muted wk-lib-hint' }, `Accepts images, audio, .obj .stl .ply .glb .gltf, .lua and .wickbundle. You can also drop files on the window.`));
  const note = h('div', { class: 'wk-muted' }, assets.error
    ? 'Browser storage is unavailable or full, so imports only last until this tab closes.'
    : 'Imports are saved in this browser (IndexedDB) and stay in the Library across projects. A .wick file carries the assets it uses.');

  render();
  modal({ title: 'Library', width: 860, content: h('div', { class: 'wk-lib' }, bar, tabs, body, note), buttons: [{ label: 'Close', primary: true }] });
}
