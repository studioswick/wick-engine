// Wick project persistence: autosave to this browser, open/save .wick files, new project and the demo.

import { buildDemo } from './demo.js';
import { confirmDialog, promptDialog } from '../studio/ui.js';

const AUTOSAVE_KEY = 'wick.project.autosave';
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

  /** First visit: the demo. Later visits: the last autosaved project. */
  startup() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(AUTOSAVE_KEY)); } catch { /* corrupt autosave is ignored */ }
    if (data) {
      try {
        this.dm.load(data);
        this.studio.resetHistory();
        this.onStatus('Restored your last project');
        return;
      } catch { /* fall through to the demo */ }
    }
    buildDemo(this.dm);
    this.studio.resetHistory();
    this._autosaveNow();
  }

  _scheduleAutosave() {
    if (this.studio.playing) return;
    clearTimeout(this._timer);
    this.onStatus('Unsaved changes');
    this._timer = setTimeout(() => this._autosaveNow(), AUTOSAVE_DELAY_MS);
  }

  _autosaveNow() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this.studio.playing) return;
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.dm.toJSON()));
      this.autosaveFailed = false;
      this.onStatus('Saved in this browser');
    } catch {
      this.autosaveFailed = true;
      this.onStatus('Autosave failed. Use File > Save to File.');
    }
  }

  async _replaceWith(build, status) {
    if (this.studio.playing) { this.studio.toast('Stop the game first.', 'warn'); return; }
    const ok = await confirmDialog('Replace current project?', 'The project open now will be replaced. Save it to a file first if you want to keep it.', 'Replace');
    if (!ok) return;
    this.studio.select(null);
    build();
    this.studio.resetHistory();
    this._autosaveNow();
    this.onStatus(status);
  }

  newProject() { return this._replaceWith(() => this.dm.loadBlank('Untitled Project'), 'New project created'); }
  openDemo() { return this._replaceWith(() => buildDemo(this.dm), 'Demo project loaded'); }

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
      const data = JSON.parse(await file.text());
      this.studio.select(null);
      this.dm.load(data);
      this.studio.resetHistory();
      this._autosaveNow();
      this.onStatus(`Opened ${file.name}`);
    } catch (err) {
      this.studio.toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error');
    }
  }

  saveToFile() {
    if (this.studio.playing) { this.studio.toast('Stop the game before saving.', 'warn'); return; }
    this._autosaveNow();
    const name = `${this.dm.projectName.replace(/[^\w\- ]+/g, '').trim() || 'project'}.wick`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(this.dm.toJSON())], { type: 'application/json' }));
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