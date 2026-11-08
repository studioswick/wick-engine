// Wick project updater: brings a project saved by an older engine up to date while it loads.
//
// Every saved project records the engine version that wrote it (`engine`, see toJSON). WickDataModel.load passes the
// project through migrateProject first, so autosaves, .wick files, undo snapshots and exported games all get the same
// treatment. A project that is already current is not touched or copied.
//
// To make a release update old projects, add one entry to MIGRATIONS (oldest first) and set `to` to the new version:
//   { to: 'p0.6.0', note: 'Part.Foo is now Part.Bar.', project(data) { renameProperty(data, 'Part', 'Foo', 'Bar'); } }
// An entry applies to every project saved before `to`. `project` is optional: a release that changes nothing in saved
// projects only needs the note. Transforms must be safe to run on any project older than `to`, and work on the plain
// project data ({ root: { class, props, children } }). Properties still at their default are not saved, so a
// renameProperty only ever sees the ones that were changed.
// Format changes to the IndexedDB stores belong in storage.js (onupgradeneeded), not here.

import { WICK_VERSION, compareVersions } from '../version.js';

// ---- helpers for writing transforms ----

/** Calls fn(node) for every instance in the project, parents first. */
export function eachNode(data, fn) {
  const walk = (node) => { fn(node); for (const child of node.children ?? []) walk(child); };
  walk(data.root);
}

export function renameClass(data, from, to) {
  eachNode(data, (n) => { if (n.class === from) n.class = to; });
}

export function renameProperty(data, cls, from, to) {
  eachNode(data, (n) => {
    if (n.class === cls && n.props && from in n.props) { n.props[to] = n.props[from]; delete n.props[from]; }
  });
}

export function removeProperty(data, cls, prop) {
  eachNode(data, (n) => { if (n.class === cls && n.props) delete n.props[prop]; });
}

/** Replaces the source of every Script with fn(source, node), for changes to the Lua API. */
export function mapScripts(data, fn) {
  eachNode(data, (n) => { if (n.class === 'Script' && typeof n.props?.Source === 'string') n.props.Source = fn(n.props.Source, n); });
}

// ---- the updates, oldest first ----

export const MIGRATIONS = [
  { to: 'p0.5.0', note: 'UI objects gained Active, Sounds gained PlaybackSpeed and there is a built-in sphere mesh. Older projects load as they are.' },
];

/**
 * Brings project data up to the current engine version. Returns { data, from, to, updated, newer, notes, error }:
 * data is a migrated copy when updated is true and the original object otherwise; newer is true when the project was
 * saved by a newer engine (it loads as it is); error is set, and the project loaded unchanged, if a transform failed.
 */
export function migrateProject(data, { migrations = MIGRATIONS, current = WICK_VERSION } = {}) {
  const from = typeof data.engine === 'string' ? data.engine : null;
  const result = { data, from, to: current, updated: false, newer: false, notes: [], error: null };
  const order = compareVersions(from, current);
  if (order === 0) return result;
  if (order > 0) return { ...result, newer: true };

  const todo = migrations
    .filter((m) => compareVersions(m.to, from) > 0 && compareVersions(m.to, current) <= 0)
    .sort((a, b) => compareVersions(a.to, b.to));
  const copy = structuredClone(data);
  const notes = [];
  for (const m of todo) {
    try {
      m.project?.(copy);
    } catch (err) {
      return { ...result, error: `${m.to}: ${err.message || err}` };
    }
    if (m.note) notes.push(`${m.to}: ${m.note}`);
  }
  copy.engine = current;
  return { ...result, data: copy, updated: true, notes };
}
