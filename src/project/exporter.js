// Wick exporter: turns the open project into something people can play without the Studio.
//   game.wick + game.json  the project and its settings (game.json also names the engine site that runs it).
//   GitHub kit (.zip)       those two files in a game/ folder plus step-by-step instructions. They go into a copy of the
//                          separate Wick Game Wrapper repository, whose workflow downloads the published engine and
//                          deploys it with the game, so the engine's own repository never has to be public.
//   Standalone site (.zip)  the whole engine site with the game inside, ready for any static host
//                          (GitHub Pages, itch.io, Netlify...). It works offline once it has loaded.

import { projectFileData } from './projectfile.js';
import { makeZip } from './zip.js';
import { WICK_VERSION, WICK_WRAPPER_REPO } from '../version.js';
import { h, modal, toast } from '../studio/ui.js';

const GAME_DIR = 'game';

function save(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slugOf = (s) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'game';

/** The address this copy of the engine is published at, or '' when it runs from a local server. */
export function publishedEngineUrl() {
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(location.hostname) || location.protocol === 'file:') return '';
  return new URL('.', location.href).href.replace(/\/$/, '');
}

/** { wick, config } as text. options: { title, studio, engineUrl }. */
export function buildGameFiles(dm, options) {
  const config = {
    format: 'wick-game', title: options.title || dm.projectName, engine: WICK_VERSION, exported: new Date().toISOString(),
    // The published Wick Engine site the wrapper repository downloads the engine from.
    engineUrl: (options.engineUrl ?? '').trim().replace(/\/+$/, ''),
    // false: a visitor to the published site cannot open the Studio with ?studio
    studio: !!options.studio,
  };
  return { wick: JSON.stringify(projectFileData(dm)), config: JSON.stringify(config, null, 2) };
}

const HOW_TO = (title, engineUrl) => `PUBLISHING "${title}" ON GITHUB PAGES
=========================================

You exported a game from Wick Engine. The folder "game" in this zip holds your project:

  game/game.wick   your whole project, with every image, sound and model it uses
  game/game.json   its title and settings, and the address of the Wick Engine that runs it

The game is published from the Wick Game Wrapper: a small public repository whose workflow downloads the engine and puts
your game next to it. You need a free GitHub account.

1. Create your game repository from the wrapper
   Open ${WICK_WRAPPER_REPO}
   Press "Use this template" > "Create a new repository". Name it, choose Public, and create it.

2. Add your game
   In your new repository press Add file > Upload files, and drag the "game" folder from this zip into the window.
   Commit the upload to the main branch.

3. Turn on GitHub Pages
   In your repository open Settings > Pages. Under Build and deployment choose Source: GitHub Actions.

4. Wait for the deploy
   Open the Actions tab. The "Deploy Wick game" workflow publishes the site (a minute or two). When it has a green tick,
   Settings > Pages shows your address:
   https://<your-name>.github.io/<your-repository-name>/

5. Play
   Open the address. Because the folder "game" exists, the site starts your game instead of the Studio.

${engineUrl ? `The engine is taken from: ${engineUrl}` : `NOTE: this kit was exported from a copy of Wick Studio that is not published, so game/game.json has an empty "engineUrl".
Open game/game.json and set "engineUrl" to the address your Wick Engine is published at, for example
"https://your-name.github.io/wick-engine", before you upload it.`}

Updating the game
  Export again and replace game/game.wick and game/game.json in your repository. Pushing to main redeploys it.

Opening the Studio on the published site
  game/game.json has "studio": false. Set it to true and visitors can add ?studio to the address to open the editor.

Hosting somewhere else
  Use Export > Standalone Site instead: it is a complete copy of the site with the game inside, for any static host.
`;

/** The GitHub kit: game/game.wick, game/game.json and HOW-TO-PUBLISH.txt. */
export async function exportGameKit(dm, options) {
  const { wick, config } = buildGameFiles(dm, options);
  const zip = await makeZip([
    { path: `${GAME_DIR}/game.wick`, data: wick },
    { path: `${GAME_DIR}/game.json`, data: config },
    { path: 'HOW-TO-PUBLISH.txt', data: HOW_TO(options.title || dm.projectName, JSON.parse(config).engineUrl) },
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
  const paths = list.filter((p) => !p.startsWith(`${GAME_DIR}/`));
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
  const stop = (e) => e.stopPropagation();
  const title = h('input', { class: 'wk-input', type: 'text', value: dm.projectName, maxlength: 80, onkeydown: stop });
  const engine = h('input', { class: 'wk-input', type: 'text', value: publishedEngineUrl(), placeholder: 'https://your-name.github.io/wick-engine', onkeydown: stop });
  const studioBox = h('input', { type: 'checkbox' });
  const status = h('div', { class: 'wk-muted' }, 'Choose what to export.');
  const options = () => ({ title: title.value.trim() || dm.projectName, studio: studioBox.checked, engineUrl: engine.value });
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
      h('label', { class: 'wk-field' }, 'Address of your published Wick Engine (the wrapper repository downloads the engine from here)', engine),
      h('label', { class: 'wk-lib-opt' }, studioBox, 'Let visitors open the Studio by adding ?studio to the address'),
      h('div', { class: 'wk-templates' },
        btn('GitHub kit (.zip)', 'The game folder plus step-by-step instructions for publishing it with the Wick Game Wrapper repository.', () => run('Building the GitHub kit', () => exportGameKit(dm, options()))),
        btn('game.wick only', 'Just the project file, with its assets. Same file as File > Save, for the game folder.', () => run('Saving', async () => { const { wick } = buildGameFiles(dm, options()); save('game.wick', wick, 'application/json'); })),
        btn('Standalone site (.zip)', 'The whole engine plus the game: upload it to any static host. Needs the deployed site (files.json).', () => run('Building the site', () => exportSite(dm, options(), (d, t) => { status.textContent = `Packing the site: ${d} of ${t} files...`; })))),
      status,
    ],
    buttons: [{ label: 'Close', primary: true }],
  });
}
