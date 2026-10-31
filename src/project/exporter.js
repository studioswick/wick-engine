// Wick exporter: turns the open project into something people can play without the Studio.
//   game.wick + game.json  the project and its settings. Put them in the game/ folder of a fork of the engine
//                          repository and its GitHub Pages deploy boots straight into the game.
//   GitHub kit (.zip)       those two files already in game/, plus step-by-step publishing instructions.
//   Standalone site (.zip)  the whole engine site with the game inside, ready for any static host
//                           (GitHub Pages, itch.io, Netlify...). It works offline once it has loaded.

import { projectFileData } from './projectfile.js';
import { makeZip } from './zip.js';
import { WICK_VERSION } from '../version.js';
import { h, modal, toast } from '../studio/ui.js';

const GAME_DIR = 'game';

function save(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slugOf = (s) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'game';

/** { wick, config } as text. options: { title, studio }. */
export function buildGameFiles(dm, options) {
  const config = {
    format: 'wick-game', title: options.title || dm.projectName, engine: WICK_VERSION, exported: new Date().toISOString(),
    // false: a visitor to the published site cannot open the Studio with ?studio
    studio: !!options.studio,
  };
  return { wick: JSON.stringify(projectFileData(dm)), config: JSON.stringify(config, null, 2) };
}

const HOW_TO = (title) => `PUBLISHING "${title}" ON GITHUB PAGES
=========================================

You exported a game from Wick Engine. The folder "game" in this zip holds your project:

  game/game.wick   your whole project, with every image, sound and model it uses
  game/game.json   its title and settings

Your game goes live in five steps. You need a free GitHub account.

1. Fork the Wick Engine repository
   Open the Wick Engine repository on GitHub and press the Fork button. Your fork is your own copy of the engine.

2. Add your game to the fork
   In your fork press Add file > Upload files, and drag the "game" folder from this zip into the window.
   (Or, with git: copy the folder into your clone, then git add game, git commit, git push.)
   Commit the upload to the main branch.

3. Turn on GitHub Pages
   In your fork open Settings > Pages. Under Build and deployment choose Source: GitHub Actions.

4. Wait for the deploy
   Open the Actions tab. The "Deploy Wick Engine" workflow builds the engine and publishes the site (a couple of
   minutes the first time). When it has a green tick, Settings > Pages shows your address:
   https://<your-name>.github.io/<your-fork-name>/

5. Play
   Open the address. Because the folder "game" exists, the site starts your game instead of the Studio.

Updating the game
  Export again and replace game/game.wick in your fork. Pushing to main redeploys it.

Opening the Studio on the published site
  game/game.json has "studio": false. Set it to true and visitors can add ?studio to the address to open the editor.
  Your own Studio at the original address is not affected.

Hosting somewhere else
  Use Export > Standalone Site instead: it is a complete copy of the site with the game inside, for any static host.
`;

/** The GitHub kit: game/game.wick, game/game.json and HOW-TO-PUBLISH.txt. */
export async function exportGameKit(dm, options) {
  const { wick, config } = buildGameFiles(dm, options);
  const zip = await makeZip([
    { path: `${GAME_DIR}/game.wick`, data: wick },
    { path: `${GAME_DIR}/game.json`, data: config },
    { path: 'HOW-TO-PUBLISH.txt', data: HOW_TO(options.title || dm.projectName) },
  ]);
  save(`${slugOf(options.title || dm.projectName)}-github-kit.zip`, zip, 'application/zip');
}

/** A complete site: every engine file listed in files.json plus the game. onProgress(done, total). */
export async function exportSite(dm, options, onProgress = () => {}) {
  let list;
  try {
    const res = await fetch('files.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    list = await res.json();
  } catch {
    throw new Error('files.json was not found next to index.html, so the engine files cannot be listed. It is written by build.sh and by the Pages deploy; open the deployed site, not a bare copy of the source.');
  }
  const { wick, config } = buildGameFiles(dm, options);
  const paths = list.filter((p) => p !== `${GAME_DIR}/game.wick` && p !== `${GAME_DIR}/game.json`);
  const entries = [];
  for (const [i, path] of paths.entries()) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Could not read ${path} (${res.status}). Is it deployed?`);
    entries.push({ path, data: new Uint8Array(await res.arrayBuffer()) });
    onProgress(i + 1, paths.length);
  }
  entries.push({ path: `${GAME_DIR}/game.wick`, data: wick }, { path: `${GAME_DIR}/game.json`, data: config });
  entries.push({ path: 'files.json', data: JSON.stringify([...paths, `${GAME_DIR}/game.wick`, `${GAME_DIR}/game.json`]) });
  save(`${slugOf(options.title || dm.projectName)}-site.zip`, await makeZip(entries), 'application/zip');
}

/** File > Export Game... */
export function showExportDialog(studio) {
  const { dm } = studio;
  if (studio.playing) { toast('Stop the game first.', 'warn'); return; }
  const title = h('input', { class: 'wk-input', type: 'text', value: dm.projectName, maxlength: 80, onkeydown: (e) => e.stopPropagation() });
  const studioBox = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'wk-muted' }, 'Choose what to export.');
  const options = () => ({ title: title.value.trim() || dm.projectName, studio: studioBox.checked });
  const run = async (label, fn) => {
    status.textContent = `${label}...`;
    try { await fn(); status.textContent = `${label} done. Check your downloads.`; } catch (err) { status.textContent = err.message; toast(err.message, 'error'); }
  };
  const btn = (text, hint, fn) => h('button', { class: 'wk-template', onclick: fn }, h('div', { class: 'wk-template-name' }, text), h('div', { class: 'wk-muted' }, hint));
  modal({
    title: 'Export game',
    width: 600,
    content: [
      h('label', { class: 'wk-field' }, 'Game title', title),
      h('label', { class: 'wk-lib-opt' }, studioBox, 'Let visitors open the Studio by adding ?studio to the address'),
      h('div', { class: 'wk-templates' },
        btn('GitHub kit (.zip)', 'game/game.wick and game.json plus step-by-step instructions. Put the game folder in your fork of the engine and deploy.', () => run('Building the GitHub kit', () => exportGameKit(dm, options()))),
        btn('game.wick only', 'Just the project file, with its assets. Same file as File > Save, for the game folder.', () => run('Saving', async () => { const { wick } = buildGameFiles(dm, options()); save('game.wick', wick, 'application/json'); })),
        btn('Standalone site (.zip)', 'The whole engine plus the game: upload it to any static host. Needs the deployed site (files.json).', () => run('Building the site', () => exportSite(dm, options(), (d, t) => { status.textContent = `Packing the site: ${d} of ${t} files...`; })))),
      status,
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}
