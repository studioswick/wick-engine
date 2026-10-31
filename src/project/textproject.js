// Wick text project: a whole project as plain files, for the Text-only Interface and for AI agents.
//
//   wick.json         project name and import options
//   tree.wtree        the object tree, one instance per line (see SKILL.md)
//   scripts/*.lua     Lua source, referenced from the tree with src=
//   assets/*          imported images, sounds, 3D models, bundles
//   .wick/output.log  written by the Studio: tree problems and everything the game printed
//
// Pure data in and out (no DOM), so it also runs headless.

import { CLASS_DEFS, SERVICES, coerce, propDef, propList } from '../engine/datamodel.js';
import { WICK_VERSION } from '../version.js';
import { assetIdOf, extOf, kindOfFile } from '../engine/assets.js';

export const TREE_FILE = 'tree.wtree';
export const META_FILE = 'wick.json';
export const LOG_FILE = '.wick/output.log';
export const COMMAND_FILE = '.wick/command';

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

const fmtNum = (n) => String(Number(Number(n).toFixed(4)));
const BARE = /^[\w.:/@#-]+$/;
const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

function colorText(c) {
  const bytes = c.map((v) => Math.round(v * 255));
  if (c.every((v, i) => Math.abs(bytes[i] / 255 - v) < 1e-6)) return `#${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return c.map(fmtNum).join(',');
}

function encodeValue(def, v) {
  switch (def.type) {
    case 'number': return fmtNum(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'vector3': case 'vector2': case 'udim2': return v.map(fmtNum).join(',');
    case 'color': return colorText(v);
    default: return v !== '' && BARE.test(v) ? v : quote(v);
  }
}

function parseColor(text) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }
  m = /^rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(text);
  if (m) return [m[1], m[2], m[3]].map((n) => Number(n) / 255);
  return text.replace(/[()\s]/g, '').split(',').map(Number);
}

function decodeValue(def, text, prop) {
  switch (def.type) {
    case 'number': {
      const n = Number(text);
      if (text === '' || !Number.isFinite(n)) throw new Error(`${prop} expects a number, got "${text}"`);
      return n;
    }
    case 'boolean':
      if (text !== 'true' && text !== 'false') throw new Error(`${prop} expects true or false, got "${text}"`);
      return text === 'true';
    case 'vector3': case 'vector2': case 'udim2': {
      const v = text.replace(/[()\s]/g, '').split(',').map(Number);
      const want = { vector3: 3, vector2: 2, udim2: 4 }[def.type];
      if (v.length !== want || v.some((n) => !Number.isFinite(n))) throw new Error(`${prop} expects ${want} comma-separated numbers (for example ${Array.from({ length: want }, (_, i) => i + 1).join(',')}), got "${text}"`);
      return v;
    }
    case 'color': {
      const v = parseColor(text);
      if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) throw new Error(`${prop} expects a color: #rrggbb, rgb(r,g,b) or three numbers from 0 to 1, got "${text}"`);
      if (v.some((n) => n > 1.0001)) throw new Error(`${prop} numbers must be 0 to 1 (use #rrggbb or rgb(255,128,0) for 0 to 255), got "${text}"`);
      return v;
    }
    default: return text;
  }
}

// ---------------------------------------------------------------------------------------------
// Suggestions for typos
// ---------------------------------------------------------------------------------------------

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
  return d[a.length][b.length];
}
function closest(word, list) {
  let best = null, score = Infinity;
  for (const w of list) { const s = distance(word, w); if (s < score) { score = s; best = w; } }
  return best && score <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}
const didYouMean = (word, list) => { const c = closest(word, list); return c ? ` Did you mean ${c}?` : ''; };

// ---------------------------------------------------------------------------------------------
// Tree -> text
// ---------------------------------------------------------------------------------------------

const sanitizePath = (s) => s.replace(/[^\w.-]+/g, '_');

/** The project's object tree as tree.wtree text, plus the Lua sources as { path -> source }. */
export function treeToText(dm) {
  const lines = ['# Wick object tree. One instance per line: ClassName [Name] [Property=value ...]. Indent two spaces per level.', ''];
  const scripts = new Map();
  const scriptPaths = new Map();
  const emit = (inst, depth) => {
    const pad = '  '.repeat(depth);
    const parts = [inst.className];
    if (inst.props.Name !== inst.className) parts.push(BARE.test(inst.props.Name) ? inst.props.Name : quote(inst.props.Name));
    for (const [k, def] of Object.entries(CLASS_DEFS[inst.className].props)) {
      if (def.runtime || def.type === 'source') continue;
      const v = inst.props[k];
      const same = Array.isArray(v) ? v.every((x, i) => x === def.default[i]) : v === def.default;
      if (!same) parts.push(`${k}=${encodeValue(def, v)}`);
    }
    if (inst.className === 'Script') {
      let path = `scripts/${dm.fullName(inst).split('.').map(sanitizePath).join('/')}.lua`, n = 2;
      while (scripts.has(path)) path = `${path.replace(/(_\d+)?\.lua$/, '')}_${n++}.lua`;
      scripts.set(path, inst.props.Source);
      scriptPaths.set(inst.id, path);
      parts.push(`src=${path}`);
    }
    lines.push(pad + parts.join(' '));
    for (const c of inst.children) emit(c, depth + 1);
  };
  for (const svc of dm.root.children) { emit(svc, 0); lines.push(''); }
  return { tree: lines.join('\n'), scripts, scriptPaths };
}

// ---------------------------------------------------------------------------------------------
// Text -> tree
// ---------------------------------------------------------------------------------------------

/** Splits one line (without indentation) into { cls, name, props: [[key, value, quoted]] }. */
function tokenize(text) {
  const out = [];
  let i = 0;
  const readQuoted = () => {
    let s = '';
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\' && i + 1 < text.length) { i++; s += text[i] === 'n' ? '\n' : text[i]; } else s += text[i];
      i++;
    }
    if (text[i] !== '"') throw new Error('a quoted string is missing its closing "');
    i++;
    return s;
  };
  while (i < text.length) {
    if (text[i] === ' ' || text[i] === '\t') { i++; continue; }
    if (text[i] === '"') { out.push({ value: readQuoted(), quoted: true }); continue; }
    let key = '';
    while (i < text.length && text[i] !== ' ' && text[i] !== '=' && text[i] !== '\t') key += text[i++];
    if (text[i] === '=') {
      i++;
      if (text[i] === '"') out.push({ key, value: readQuoted(), quoted: true });
      else { let v = ''; while (i < text.length && text[i] !== ' ' && text[i] !== '\t') v += text[i++]; out.push({ key, value: v, quoted: false }); }
    } else out.push({ value: key, quoted: false });
  }
  return out;
}

/**
 * Parses tree.wtree. readScript(path) returns the Lua source for a src= path, or null if there is no such file.
 * Returns { data, problems, scriptPaths, lines }: data is project data for WickDataModel.load, problems is a list of
 * { line, severity: 'error' | 'warn', message }, scriptPaths maps instance id -> script file path, lines maps id -> line.
 */
export function parseTree(text, readScript) {
  const problems = [];
  const problem = (line, message, severity = 'error') => problems.push({ line, severity, message, file: TREE_FILE });
  const scriptPaths = new Map(), lineOf = new Map();
  let nextId = 2;
  const services = new Map(SERVICES.map((s) => [s, { id: nextId++, class: s, props: {}, children: [] }]));
  const stack = []; // { indent, node }

  const raw = text.replace(/\r/g, '').split('\n');
  for (let n = 0; n < raw.length; n++) {
    let lineNo = n + 1, line = raw[n];
    while (line.endsWith('\\') && n + 1 < raw.length) { line = `${line.slice(0, -1)} ${raw[++n].trim()}`; } // a trailing \ continues the line
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (/^\s*\t/.test(line) || /^ *\t/.test(line)) { problem(lineNo, 'Use spaces for indentation, not tabs (two spaces per level).'); continue; }
    const indent = /^ */.exec(line)[0].length;
    if (indent % 2) { problem(lineNo, `Indentation must be a multiple of two spaces (found ${indent}).`); continue; }
    let tokens;
    try { tokens = tokenize(line.trim()); } catch (err) { problem(lineNo, err.message); continue; }
    if (!tokens.length || tokens[0].key !== undefined) { problem(lineNo, 'A line must start with a class name, for example: Part Wall Size=4,1,2'); continue; }
    const cls = tokens[0].value;
    if (!CLASS_DEFS[cls] || cls === 'DataModel') {
      problem(lineNo, `Unknown class "${cls}".${didYouMean(cls, Object.keys(CLASS_DEFS).filter((c) => c !== 'DataModel'))}`);
      continue;
    }
    const depth = indent / 2;
    let node;
    if (depth === 0) {
      if (!CLASS_DEFS[cls].service) { problem(lineNo, `${cls} cannot be at the top level. Top-level lines are the services: ${SERVICES.join(', ')}. Indent it under one of them.`); continue; }
      node = services.get(cls);
      stack.length = 0;
    } else {
      if (CLASS_DEFS[cls].service) { problem(lineNo, `${cls} is a service and must be at the top level (no indentation).`); continue; }
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent || parent.depth !== depth - 1) { problem(lineNo, `Indented too far: there is no parent line at ${depth - 1} level(s) of indentation above this one.`); continue; }
      node = { id: nextId++, class: cls, props: {}, children: [] };
      parent.node.children.push(node);
    }
    stack.push({ depth, node });
    lineOf.set(node.id, lineNo);

    let rest = tokens.slice(1);
    if (rest.length && rest[0].key === undefined && !CLASS_DEFS[cls].service) { node.props.Name = rest[0].value; rest = rest.slice(1); }
    const defs = CLASS_DEFS[cls].props;
    let src = null;
    for (const t of rest) {
      if (t.key === undefined) { problem(lineNo, `"${t.value}" is not Name=value. Properties are written Name=value with no spaces around the =. (Only one bare name is allowed, right after the class.)`); continue; }
      if (t.key === 'Name') { node.props.Name = t.value; continue; }
      if (t.key === 'src' && cls === 'Script') { src = t.value; continue; }
      const def = propDef(cls, t.key);
      if (!def || def.runtime) {
        problem(lineNo, `${cls} has no property "${t.key}".${didYouMean(t.key, [...propList(cls).map(([k]) => k), ...(cls === 'Script' ? ['src'] : [])])}`);
        continue;
      }
      try { node.props[t.key] = coerce(def, decodeValue(def, t.value, t.key), t.key); } catch (err) { problem(lineNo, err.message); }
    }
    if (cls === 'Script') {
      if (src === null && node.props.Source === undefined) { problem(lineNo, 'A Script needs src=scripts/<file>.lua (or an inline Source="...").'); }
      else if (src !== null) {
        const source = readScript(src);
        if (source === null || source === undefined) problem(lineNo, `Script file not found: ${src}`);
        else { node.props.Source = source; scriptPaths.set(node.id, src); }
      }
    }
  }
  const data = {
    format: 'wick-project', version: 1, engine: WICK_VERSION, name: 'Untitled Project', nextId,
    root: { id: 1, class: 'DataModel', props: {}, children: [...services.values()] },
  };
  return { data, problems, scriptPaths, lineOf };
}

// ---------------------------------------------------------------------------------------------
// Project <-> files
// ---------------------------------------------------------------------------------------------

/** The whole project as a Map of path -> { text } or { bytes: Uint8Array }. */
export function projectToFiles(dm) {
  const files = new Map();
  const { tree, scripts } = treeToText(dm);
  const assetOptions = {};
  files.set(TREE_FILE, { text: tree });
  for (const [path, source] of scripts) files.set(path, { text: source });
  for (const id of dm.usedAssetIds()) {
    const rec = dm.assets.get(id);
    if (!rec) continue;
    const ext = extOf(rec.name) || { texture: 'png', sound: 'wav', mesh: 'glb', script: 'lua', bundle: 'wickbundle' }[rec.kind];
    const path = `assets/${id}.${ext}`;
    if (rec.kind === 'script') files.set(path, { text: rec.data });
    else if (rec.kind === 'bundle') files.set(path, { text: JSON.stringify(rec.data, null, 2) });
    else if (rec.kind === 'mesh') { if (rec.original) files.set(path, { bytes: new Uint8Array(rec.original) }); if (rec.meta.zUp) assetOptions[id] = { zUp: true }; }
    else files.set(path, { bytes: new Uint8Array(rec.data) });
  }
  files.set(META_FILE, { text: JSON.stringify({ format: 'wick-text-project', version: 1, engine: WICK_VERSION, name: dm.projectName, assetOptions }, null, 2) });
  return files;
}

/**
 * Loads a files map into dm: imports assets, parses the tree, loads it, and drops instances that break placement
 * rules. Resolves with { problems, scriptPaths } (scriptPaths: instance id -> script file).
 */
export async function filesToProject(files, dm) {
  const problems = [];
  let meta = {};
  try { if (files.get(META_FILE)) meta = JSON.parse(files.get(META_FILE).text); } catch { problems.push({ file: META_FILE, line: 1, severity: 'error', message: `${META_FILE} is not valid JSON` }); }
  for (const [path, f] of files) {
    if (!path.startsWith('assets/') || path.endsWith('/')) continue;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!kindOfFile(name)) { problems.push({ file: path, line: 0, severity: 'warn', message: `${path} is not a supported asset type and was ignored.` }); continue; }
    try {
      const id = name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
      const file = new File([f.bytes ?? f.text ?? ''], name);
      await dm.assets.ensureFile(file, { zUp: !!meta.assetOptions?.[id]?.zUp });
    } catch (err) {
      problems.push({ file: path, line: 0, severity: 'error', message: `${path}: ${err.message}` });
    }
  }
  const treeFile = files.get(TREE_FILE);
  if (!treeFile) { problems.push({ file: TREE_FILE, line: 0, severity: 'error', message: `${TREE_FILE} is missing.` }); return { problems, scriptPaths: new Map() }; }
  const parsed = parseTree(treeFile.text, (path) => files.get(path)?.text ?? null);
  problems.push(...parsed.problems);
  parsed.data.name = String(meta.name || 'Untitled Project').slice(0, 80);
  dm.load(parsed.data);

  // Placement rules (a Frame in the Workspace, a second CameraPoint...) that the line-by-line parse cannot see.
  for (const inst of [...dm.descendants(dm.root)]) {
    if (inst.service || inst.destroyed || !inst.parent) continue;
    try { dm._checkPlacement(inst, inst.parent); } catch (err) {
      problems.push({ file: TREE_FILE, line: parsed.lineOf.get(inst.id) ?? 0, severity: 'error', message: `${inst.className} "${inst.name}": ${err.message}. It was left out.` });
      dm.destroy(inst);
    }
  }
  // Asset references that point at nothing.
  for (const id of dm.usedAssetIds()) if (!dm.assets.has(id)) problems.push({ file: TREE_FILE, line: 0, severity: 'warn', message: `asset://${id} is used by the project but there is no assets/${id}.* file or Library asset with that name.` });
  return { problems, scriptPaths: parsed.scriptPaths };
}

export { assetIdOf };
