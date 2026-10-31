// Text-only Interface: the project as files, with no graphical editor. Built for AI agents and for anyone who prefers
// a text editor.
//
// The files live in a virtual folder (see project/textproject.js). Connect a real folder (File System Access API,
// Chrome and Edge) and the two stay in sync: files an agent changes on disk are reloaded within a second, and the
// Studio writes .wick/output.log (tree problems, game output, errors) back into the folder. An agent can also write
// "run", "run 20" or "stop" into .wick/command to play the game, so it can check its own work without a human.

import { h, toast, confirmDialog, promptDialog } from './ui.js';
import { showSkill } from './dialogs.js';
import { idbGet, idbPut } from '../project/storage.js';
import { makeZip, readZip } from '../project/zip.js';
import { TREE_FILE, META_FILE, LOG_FILE, COMMAND_FILE, projectToFiles, filesToProject, parseTree } from '../project/textproject.js';

const TEXT_EXT = /\.(lua|wtree|json|md|txt|log|wickbundle)$/i;
const POLL_MS = 1000;
const MAX_LOG_LINES = 1500;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '.vscode', '.idea']);
const hasFolderAccess = () => typeof window.showDirectoryPicker === 'function';
const isText = (path) => TEXT_EXT.test(path) || !path.includes('.');

export class WickTextMode {
  /** controls: { play(), stop(), isPlaying() }. */
  constructor({ studio, project, host, controls, log }) {
    this.studio = studio;
    this.project = project;
    this.dm = studio.dm;
    this.controls = controls;
    this.log = log;
    this.active = false;
    this.files = new Map(); // path -> { text } | { bytes }
    this.problems = [];
    this.scriptPaths = new Map();
    this.dir = null; // FileSystemDirectoryHandle while a real folder is connected
    this.stamps = new Map(); // path -> `${lastModified}:${size}` of what we last read or wrote
    this.dirty = new Set(); // paths with edits not yet applied
    this.current = null;
    this._logLines = [];
    this._pollTimer = null;
    this._applyTimer = null;
    this._logTimer = null;
    this._stopAt = 0;
    this._pendingApply = false;
    this._build(host);
    studio.on('playstate', () => this._playState());
  }

  // ---------------------------------------------------------------- layout

  _build(host) {
    const btn = (label, fn, cls = '') => h('button', { class: `wk-btn ${cls}`, onclick: fn }, label);
    this.folderLabel = h('span', { class: 'wk-muted' }, 'No folder connected: changes stay in this browser.');
    this.reconnectBtn = btn('', () => this.reconnect());
    this.reconnectBtn.hidden = true;
    const picker = h('input', { type: 'file', webkitdirectory: true, multiple: true, style: 'display:none', onchange: () => this._importPicked(picker) });
    const zipPicker = h('input', { type: 'file', accept: '.zip', style: 'display:none', onchange: async () => { if (zipPicker.files[0]) await this._importZip(zipPicker.files[0]); zipPicker.value = ''; } });
    const bar = h('div', { class: 'wk-text-bar' },
      hasFolderAccess() ? btn('Open Folder...', () => this.openFolder(), 'is-primary') : btn('Import Folder...', () => picker.click(), 'is-primary'),
      this.reconnectBtn,
      btn('Import Zip...', () => zipPicker.click()), picker, zipPicker,
      btn('Save Zip', () => this.saveZip()),
      btn('Reload', () => this.apply(true)),
      btn('AI Agent Skill (SKILL.md)', () => showSkill()),
      h('div', { class: 'wk-spacer' }), this.folderLabel);
    this.list = h('div', { class: 'wk-files' });
    this.problemsEl = h('div', { class: 'wk-problems' });
    this.pathLabel = h('div', { class: 'wk-text-path' });
    this.gutter = h('div', { class: 'wk-gutter' });
    this.area = h('textarea', { class: 'wk-code', spellcheck: 'false', autocomplete: 'off', wrap: 'off' });
    this.preview = h('div', { class: 'wk-text-preview' });
    this.editor = h('div', { class: 'wk-editor wk-text-editor' }, this.gutter, this.area);
    this.panel = h('div', { class: 'wk-text' }, bar,
      h('div', { class: 'wk-text-body' },
        h('div', { class: 'wk-text-side' }, h('div', { class: 'wk-panel-head' }, 'Project files', h('button', { class: 'wk-link', onclick: () => this.newFile() }, '+ New file')), this.list),
        h('div', { class: 'wk-text-main' }, this.pathLabel, this.editor, this.preview, this.problemsEl)));
    host.append(this.panel);

    this.area.addEventListener('input', () => this._edited());
    this.area.addEventListener('scroll', () => { this.gutter.scrollTop = this.area.scrollTop; });
    this.area.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.flush(); toast(this.dir ? 'Saved to the folder' : 'Applied'); return; }
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
    });
  }

  // ---------------------------------------------------------------- entering and leaving

  async enter() {
    this.active = true;
    this.files = projectToFiles(this.dm);
    this.stamps.clear();
    this.dirty.clear();
    this.problems = [];
    this.current = this.current && this.files.has(this.current) ? this.current : TREE_FILE;
    this._render();
    try {
      const saved = await idbGet('projects', 'folder');
      if (saved && hasFolderAccess() && !this.dir) { this.lastFolder = saved; this.reconnectBtn.textContent = `Reconnect "${saved.name}"`; this.reconnectBtn.hidden = false; }
    } catch { /* no remembered folder */ }
    this._startPolling();
  }

  leave() {
    this.flush();
    this.active = false;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    if (this.dirty.size) toast('Some edits had errors and were not applied. The last working version is kept.', 'warn');
  }

  // ---------------------------------------------------------------- file list and editing

  _render() {
    const names = [...this.files.keys()].sort((a, b) => {
      const rank = (p) => (p === META_FILE ? 0 : p === TREE_FILE ? 1 : p.startsWith('scripts/') ? 2 : p.startsWith('assets/') ? 3 : 4);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    this.list.replaceChildren(...names.map((p) => h('div', { class: `wk-file${p === this.current ? ' is-active' : ''}${this.dirty.has(p) ? ' is-dirty' : ''}`, dataset: { path: p }, onclick: () => this.open(p) }, p)),
      h('div', { class: 'wk-file wk-muted', dataset: { path: LOG_FILE }, onclick: () => this.open(LOG_FILE) }, `${LOG_FILE} (written by the Studio)`));
    this._renderProblems();
    if (this.current) this.open(this.current, true);
  }

  open(path, keep = false) {
    if (!keep && this.current && this.current !== path) this.flush();
    this.current = path;
    this.list.querySelectorAll('.wk-file').forEach((n) => n.classList.toggle('is-active', n.dataset.path === path));
    const isLog = path === LOG_FILE;
    const f = isLog ? { text: this._logText() } : this.files.get(path);
    this.pathLabel.replaceChildren(h('span', {}, path), isLog || ['wick.json'].includes(path) ? null : h('button', { class: 'wk-link', onclick: () => this.deleteFile(path) }, 'Delete file'));
    const textual = f && 'text' in f;
    this.editor.style.display = textual ? '' : 'none';
    this.preview.style.display = textual ? 'none' : '';
    if (textual) {
      if (this.area.value !== f.text || this._shown !== path) this.area.value = f.text;
      this._shown = path;
      this.area.readOnly = isLog;
      this._gutter();
    } else {
      this._shown = null;
      this.preview.replaceChildren(...(f ? this._previewOf(path, f.bytes) : [h('p', { class: 'wk-muted' }, 'File not found.')]));
    }
  }

  _previewOf(path, bytes) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const info = h('p', { class: 'wk-muted' }, `${bytes.length.toLocaleString()} bytes. Binary files are not edited here: replace the file on disk (or import it) and it reloads.`);
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' }[ext];
    if (type?.startsWith('image')) return [info, h('img', { class: 'wk-text-img', src: URL.createObjectURL(new Blob([bytes], { type })) })];
    if (type?.startsWith('audio')) return [info, h('audio', { controls: true, src: URL.createObjectURL(new Blob([bytes], { type })) })];
    return [info];
  }

  _gutter() {
    const n = this.area.value.split('\n').length;
    if (this.gutter.dataset.n !== String(n)) { this.gutter.dataset.n = n; this.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
  }

  _edited() {
    const path = this.current;
    if (!path || path === LOG_FILE || !this.files.get(path) || !('text' in this.files.get(path))) return;
    this.files.get(path).text = this.area.value;
    this.dirty.add(path);
    this._gutter();
    clearTimeout(this._applyTimer);
    this._applyTimer = setTimeout(() => this.flush(), 600);
    this.list.querySelectorAll('.wk-file').forEach((n) => { if (n.dataset.path === path) n.classList.add('is-dirty'); });
  }

  async newFile() {
    const path = await promptDialog('New file', 'Path, for example scripts/Door.lua', 'scripts/NewScript.lua');
    if (!path) return;
    const clean = path.replace(/^\/+/, '');
    if (this.files.has(clean)) { toast('That file already exists.', 'warn'); return; }
    this.files.set(clean, { text: clean.endsWith('.lua') ? '-- New script\n' : '' });
    await this._writeDisk(clean);
    this.open(clean);
    this._render();
  }

  async deleteFile(path) {
    if (!(await confirmDialog(`Delete ${path}?`, this.dir ? 'It is deleted from the folder too.' : 'It is removed from this project.', 'Delete'))) return;
    this.files.delete(path);
    this.dirty.delete(path);
    if (this.dir) await this._removeDisk(path);
    this.current = TREE_FILE;
    await this.apply();
    this._render();
  }

  // ---------------------------------------------------------------- applying files to the project

  /** Applies pending edits: quick path for a script, a full reload when the tree or an asset changed. */
  async flush() {
    clearTimeout(this._applyTimer);
    if (!this.dirty.size) return;
    const paths = [...this.dirty];
    for (const p of paths) await this._writeDisk(p);
    const onlyScripts = paths.every((p) => p.endsWith('.lua') && [...this.scriptPaths.values()].includes(p));
    if (onlyScripts && !this.controls.isPlaying()) {
      for (const [id, path] of this.scriptPaths) if (paths.includes(path)) { const inst = this.dm.find(id); if (inst) this.dm.set(inst, 'Source', this.files.get(path).text); }
      paths.forEach((p) => this.dirty.delete(p));
      this._render();
      return;
    }
    await this.apply();
  }

  /** Checks the tree, and if it has no errors (or force) loads the whole file set into the project. */
  async apply(force = false) {
    if (this.controls.isPlaying()) { this._pendingApply = true; this.record('info', 'Changes will load when the game stops.'); return false; }
    const tree = this.files.get(TREE_FILE);
    const check = tree ? parseTree(tree.text, (p) => this.files.get(p)?.text ?? null) : { problems: [] };
    const errors = check.problems.filter((p) => p.severity === 'error');
    if (errors.length && !force) {
      this.problems = check.problems;
      this._renderProblems();
      this._reportProblems('Not applied: tree.wtree has errors, so the last working version is kept.');
      return false;
    }
    const { problems, scriptPaths } = await filesToProject(this.files, this.dm);
    this.problems = problems;
    this.scriptPaths = scriptPaths;
    this.studio.resetHistory();
    this.dirty.clear();
    this._pendingApply = false;
    await this.project._autosaveNow();
    this._renderProblems();
    this._reportProblems(problems.length ? 'Loaded with problems.' : 'Project loaded.');
    this._render();
    return true;
  }

  _renderProblems() {
    const errors = this.problems.filter((p) => p.severity === 'error').length;
    this.problemsEl.replaceChildren(
      h('div', { class: 'wk-panel-head' }, this.problems.length ? `Problems (${errors} errors, ${this.problems.length - errors} warnings)` : 'Problems: none'),
      ...this.problems.map((p) => h('div', { class: `wk-problem is-${p.severity}`, onclick: () => this._goto(p) }, `${p.file}${p.line ? `:${p.line}` : ''}  ${p.message}`)));
  }

  _goto(p) {
    this.open(p.file);
    if (!p.line || !('text' in (this.files.get(p.file) ?? {}))) return;
    const lines = this.area.value.split('\n');
    const at = lines.slice(0, p.line - 1).join('\n').length + (p.line > 1 ? 1 : 0);
    this.area.focus();
    this.area.setSelectionRange(at, at + (lines[p.line - 1]?.length ?? 0));
  }

  // ---------------------------------------------------------------- output log (also written to .wick/output.log)

  _reportProblems(headline) {
    this.record(this.problems.some((p) => p.severity === 'error') ? 'error' : 'info', headline);
    for (const p of this.problems) this.record(p.severity === 'error' ? 'error' : 'warn', `${p.file}${p.line ? `:${p.line}` : ''}: ${p.message}`);
  }

  /** Called with every line the Studio logs (game output, errors) while this mode is active. */
  record(level, text) {
    if (!this.active) return;
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    this._logLines.push(`${stamp} [${level}] ${text}`);
    if (this._logLines.length > MAX_LOG_LINES) this._logLines.splice(0, this._logLines.length - MAX_LOG_LINES);
    if (this.current === LOG_FILE) this.open(LOG_FILE, true);
    clearTimeout(this._logTimer);
    this._logTimer = setTimeout(() => this._writeLog(), 400);
  }

  _logText() { return `# Wick output log. Most recent last. Written by the Studio; do not edit.\n${this._logLines.join('\n')}\n`; }

  async _writeLog() {
    if (!this.dir) return;
    try { await this._writeRaw(LOG_FILE, this._logText()); } catch { /* the folder may have been closed */ }
  }

  _playState() {
    if (!this.active) return;
    if (this.controls.isPlaying()) { this.record('info', '=== game started ==='); return; }
    this.record('info', '=== game stopped ===');
    this._stopAt = 0;
    if (this._pendingApply) this.apply();
  }

  // ---------------------------------------------------------------- real folders

  async openFolder() {
    if (!hasFolderAccess()) { toast('This browser cannot open folders. Use Import Folder or Import Zip.', 'warn'); return; }
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'wick-project' }); } catch { return; }
    await this._connect(dir);
  }

  async reconnect() {
    const dir = this.lastFolder;
    if (!dir) return;
    try {
      if ((await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') { toast('Permission was not granted.', 'warn'); return; }
    } catch { toast('The folder could not be reopened. Use Open Folder.', 'warn'); return; }
    this.reconnectBtn.hidden = true;
    await this._connect(dir);
  }

  async _connect(dir) {
    this.dir = dir;
    try { await idbPut('projects', dir, 'folder'); } catch { /* handles cannot always be stored */ }
    const disk = await this._readAll();
    if (disk.has(TREE_FILE)) {
      if (!(await confirmDialog(`Load "${dir.name}"?`, 'The project in this folder replaces the project open now.', 'Load'))) { this.dir = null; return; }
      this.files = disk;
      this.dirty.clear();
      await this.apply(true);
    } else {
      if (!(await confirmDialog(`"${dir.name}" has no tree.wtree`, 'Write the current project into this folder? Existing files are not touched.', 'Write project'))) { this.dir = null; return; }
      this.files = projectToFiles(this.dm);
      for (const p of this.files.keys()) await this._writeDisk(p);
      try { const skill = await (await fetch('SKILL.md')).text(); await this._writeRaw('SKILL.md', skill); } catch { /* optional */ }
    }
    this.folderLabel.textContent = `Folder: ${dir.name}. Files you or an agent change there reload automatically.`;
    await this._writeLog();
    this._render();
  }

  async _walk(dir, prefix, out) {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        if (SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.wick')) continue;
        await this._walk(handle, `${prefix}${name}/`, out);
      } else out.push([`${prefix}${name}`, handle]);
    }
  }

  async _readAll() {
    const found = [];
    await this._walk(this.dir, '', found);
    const files = new Map();
    for (const [path, handle] of found) {
      if (path === LOG_FILE || path === COMMAND_FILE) continue;
      const file = await handle.getFile();
      this.stamps.set(path, `${file.lastModified}:${file.size}`);
      if (isText(path)) files.set(path, { text: await file.text() }); else files.set(path, { bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    return files;
  }

  async _handleFor(path, create) {
    const parts = path.split('/');
    let dir = this.dir;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async _writeRaw(path, data) {
    const handle = await this._handleFor(path, true);
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    const file = await handle.getFile();
    this.stamps.set(path, `${file.lastModified}:${file.size}`);
  }

  async _writeDisk(path) {
    const f = this.files.get(path);
    if (!this.dir || !f) return;
    try { await this._writeRaw(path, f.text ?? f.bytes); } catch (err) { toast(`Could not write ${path}: ${err.message}`, 'error'); }
  }

  async _removeDisk(path) {
    try {
      const parts = path.split('/');
      let dir = this.dir;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      await dir.removeEntry(parts[parts.length - 1]);
      this.stamps.delete(path);
    } catch { /* already gone */ }
  }

  // ---------------------------------------------------------------- watching the folder

  _startPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => this._poll(), POLL_MS);
  }

  async _poll() {
    if (!this.active || !this.dir || document.hidden || this._polling) return;
    this._polling = true;
    try {
      await this._checkAutoStop();
      const found = [];
      await this._walk(this.dir, '', found);
      let changed = false, scriptsOnly = true;
      const seen = new Set();
      for (const [path, handle] of found) {
        if (path === LOG_FILE) continue;
        seen.add(path);
        const file = await handle.getFile();
        const stamp = `${file.lastModified}:${file.size}`;
        if (path === COMMAND_FILE) { if (file.size) await this._command((await file.text()).trim()); continue; }
        if (this.stamps.get(path) === stamp) continue;
        this.stamps.set(path, stamp);
        if (this.dirty.has(path) && path === this.current) continue; // the user is typing in it: their copy wins until saved
        this.files.set(path, isText(path) ? { text: await file.text() } : { bytes: new Uint8Array(await file.arrayBuffer()) });
        changed = true;
        if (!(path.endsWith('.lua') && [...this.scriptPaths.values()].includes(path))) scriptsOnly = false;
        this.record('info', `${path} changed on disk`);
      }
      for (const path of [...this.files.keys()]) if (!seen.has(path) && this.stamps.has(path)) { this.files.delete(path); this.stamps.delete(path); changed = true; scriptsOnly = false; this.record('info', `${path} was deleted on disk`); }
      if (changed) {
        if (scriptsOnly && !this.controls.isPlaying()) {
          for (const [id, path] of this.scriptPaths) { const inst = this.dm.find(id); const f = this.files.get(path); if (inst && f && inst.props.Source !== f.text) this.dm.set(inst, 'Source', f.text); }
          this._render();
        } else await this.apply();
        this._writeLog();
      }
    } catch (err) {
      this.record('error', `Watching the folder failed: ${err.message}`);
    } finally {
      this._polling = false;
    }
  }

  /** .wick/command: "run", "run 20" (seconds) or "stop". Cleared once read. */
  async _command(text) {
    try { await this._writeRaw(COMMAND_FILE, ''); } catch { /* ignore */ }
    const [word, arg] = text.toLowerCase().split(/\s+/);
    this.record('info', `command: ${text}`);
    if (word === 'stop') { this.controls.stop(); return; }
    if (word === 'reload') { await this.apply(true); return; }
    if (word !== 'run') { this.record('error', `Unknown command "${text}". Use: run, run <seconds>, stop, reload.`); return; }
    if (this.controls.isPlaying()) this.controls.stop();
    if (this.problems.some((p) => p.severity === 'error') || this._pendingApply) { this.record('error', 'Not running: fix the errors above first.'); return; }
    await this.controls.play();
    this._stopAt = Date.now() + (Number(arg) > 0 ? Number(arg) : 10) * 1000;
  }

  async _checkAutoStop() {
    if (this._stopAt && Date.now() > this._stopAt && this.controls.isPlaying()) { this.record('info', 'run finished: time limit reached'); this.controls.stop(); }
  }

  // ---------------------------------------------------------------- import and export without a folder

  async _loadFiles(files) {
    if (!files.has(TREE_FILE)) { toast('That has no tree.wtree, so it is not a Wick text project.', 'error'); return; }
    if (!(await confirmDialog('Load project?', 'The project in these files replaces the project open now.', 'Load'))) return;
    this.dir = null;
    this.folderLabel.textContent = 'No folder connected: changes stay in this browser. Use Save Zip to keep them.';
    this.files = files;
    this.dirty.clear();
    await this.apply(true);
  }

  async _importPicked(input) {
    const files = new Map();
    for (const f of input.files) {
      const parts = f.webkitRelativePath.split('/').slice(1);
      if (parts.some((p) => SKIP_DIRS.has(p) || (p.startsWith('.') && p !== '.wick'))) continue;
      const path = parts.join('/');
      files.set(path, isText(path) ? { text: await f.text() } : { bytes: new Uint8Array(await f.arrayBuffer()) });
    }
    input.value = '';
    await this._loadFiles(files);
  }

  async _importZip(file) {
    try {
      const entries = await readZip(await file.arrayBuffer());
      const root = [...entries.keys()].find((p) => p.endsWith(TREE_FILE));
      const prefix = root ? root.slice(0, -TREE_FILE.length) : '';
      const files = new Map();
      for (const [path, bytes] of entries) if (path.startsWith(prefix)) { const rel = path.slice(prefix.length); files.set(rel, isText(rel) ? { text: new TextDecoder().decode(bytes) } : { bytes }); }
      await this._loadFiles(files);
    } catch (err) { toast(err.message, 'error'); }
  }

  async saveZip() {
    await this.flush();
    const entries = [...this.files].map(([path, f]) => ({ path, data: f.text ?? f.bytes }));
    const zip = await makeZip(entries);
    const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    Object.assign(document.createElement('a'), { href: url, download: `${(this.dm.projectName || 'project').replace(/[^\w\- ]+/g, '').trim() || 'project'}-text-project.zip` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
