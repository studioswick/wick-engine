// Wick project persistence: autosave to IndexedDB, open/save .wick files (with the assets they use embedded),
// new project from a template.

import { buildTemplate } from './templates.js';
import { idbGet, idbPut } from './storage.js';
import { projectFileData, importProjectData } from './projectfile.js';
import { confirmDialog, promptDialog } from '../studio/ui.js';
import { showTemplates } from '../studio/dialogs.js';

const AUTOSAVE_KEY = 'autosave';
const LEGACY_AUTOSAVE_KEY = 'wick.project.autosave'; // projects used to autosave to localStorage
const SETTINGS_KEY = 'wick.settings';
const AUTOSAVE_DELAY_MS = 1500;

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}

export function saveSettings(patch) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...patch })); } catch { /* storage unavailable */ }
}

export class WickProject {
  constructor(studio, { onStatus, onTitle }) {
    this.studio = studio;
    this.dm = studio.dm;
    this.onStatus = onStatus;
    this.onTitle = onTitle;
    this._timer = null;
    this.autosaveFailed = false;

    studio.on('dirty', () => this._scheduleAutosave());
    studio.on('save', () => this.saveToFile());
    this.dm.on('reset', () => this.onTitle(this.dm.projectName));
  }

  /** True while work exists that is not safely stored anywhere. */
  get unsaved() { return this._timer !== null || this.autosaveFailed; }

  /** First visit: the Wick demo. Later visits: the last autosaved project. Resolves with true if one was restored. */
  async startup() {
    let data = null;
    try { data = await idbGet('projects', AUTOSAVE_KEY); } catch { /* IndexedDB unavailable: fall back below */ }
    if (!data) {
      try { data = JSON.parse(localStorage.getItem(LEGACY_AUTOSAVE_KEY)); } catch { /* corrupt autosave is ignored */ }
    }
    if (data) {
      try {
        this.dm.load(data);
        this.studio.resetHistory();
        localStorage.removeItem(LEGACY_AUTOSAVE_KEY);
        await this._autosaveNow();
        this.onStatus('Restored your last project');
        return true;
      } catch { /* fall through to the demo */ }
    }
    await buildTemplate('demo', this.dm);
    this.studio.resetHistory();
    await this._autosaveNow();
    return false;
  }

  _scheduleAutosave() {
    if (this.studio.playing) return;
    clearTimeout(this._timer);
    this.onStatus('Unsaved changes');
    this._timer = setTimeout(() => this._autosaveNow(), AUTOSAVE_DELAY_MS);
  }

  async _autosaveNow() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this.studio.playing) return;
    try {
      await idbPut('projects', this.dm.toJSON(), AUTOSAVE_KEY);
      this.autosaveFailed = false;
      this.onStatus('Saved in this browser');
    } catch {
      this.autosaveFailed = true;
      this.onStatus('Autosave failed. Use File > Save to File.');
    }
  }

  async _replaceWith(build, status) {
    if (this.studio.playing) { this.studio.toast('Stop the game first.', 'warn'); return false; }
    const ok = await confirmDialog('Replace current project?', 'The project open now will be replaced. Save it to a file first if you want to keep it.', 'Replace');
    if (!ok) return false;
    this.studio.select(null);
    try {
      await build();
    } catch (err) {
      this.studio.toast(err.message, 'error');
      return false;
    }
    this.studio.resetHistory();
    await this._autosaveNow();
    this.onStatus(status);
    return true;
  }

  /** File > New Project: pick a template, then replace the current project with it. */
  async newProject() {
    const id = await showTemplates();
    if (!id) return false;
    return this._replaceWith(() => buildTemplate(id, this.dm), 'New project created');
  }

  openFromPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.wick,.json,application/json';
    input.addEventListener('change', () => { if (input.files[0]) this.openFile(input.files[0]); });
    input.click();
  }

  async openFile(file) {
    if (this.studio.playing) { this.studio.toast('Stop the game first.', 'warn'); return; }
    try {
      const data = await importProjectData(JSON.parse(await file.text()), this.dm.assets);
      this.studio.select(null);
      this.dm.load(data);
      this.studio.resetHistory();
      await this._autosaveNow();
      this.onStatus(`Opened ${file.name}`);
    } catch (err) {
      this.studio.toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error');
    }
  }

  saveToFile() {
    if (this.studio.playing) { this.studio.toast('Stop the game before saving.', 'warn'); return; }
    this._autosaveNow();
    const name = `${this.dm.projectName.replace(/[^\w\- ]+/g, '').trim() || 'project'}.wick`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(projectFileData(this.dm))], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.onStatus(`Saved ${name}`);
  }

  async rename() {
    const name = await promptDialog('Rename project', 'Project name', this.dm.projectName);
    if (!name) return;
    this.dm.projectName = name.slice(0, 80);
    this.onTitle(this.dm.projectName);
    this.studio.commit();
  }
}
