// Wick assets: every imported file (images, sounds, 3D meshes, scripts, bundles) lives in one library that is saved in
// IndexedDB. Projects refer to assets as asset://<id>; .wick files embed only the assets they refer to.
// The whole library is kept in memory so the renderer, audio and UI can read it synchronously.

import { idbAll, idbDelete, idbPut, requestPersistence } from '../project/storage.js';
import { MESH_EXTENSIONS, parseMeshFile } from './meshio.js';

export const assetUri = (id) => `asset://${id}`;
export const assetIdOf = (uri) => /^asset:\/\/([\w-]+)$/.exec(uri ?? '')?.[1] ?? null;

export const ASSET_KINDS = ['texture', 'sound', 'mesh', 'script', 'bundle'];
const EXT = {
  texture: { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml' },
  sound: { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac' },
  script: { lua: 'text/plain' },
  bundle: { wickbundle: 'application/json' },
};
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export const extOf = (name) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
export function kindOfFile(name) {
  const ext = extOf(name);
  if (MESH_EXTENSIONS.includes(ext)) return 'mesh';
  return ASSET_KINDS.find((k) => EXT[k]?.[ext]) ?? null;
}
export const ACCEPT = ['mesh', ...Object.keys(EXT)].flatMap((k) => (k === 'mesh' ? MESH_EXTENSIONS : Object.keys(EXT[k]))).map((e) => `.${e}`).join(',');

// ---- binary helpers (assets travel inside .wick files as base64) ----

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(text) {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const typed = (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** FNV-1a of raw bytes: tells a file that was replaced on disk from one that is unchanged. */
export function hashBytes(bytes) {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
  return h.toString(16);
}

/** FNV-1a over the asset's bytes, used to tell a re-import of the same file from a different file with the same id. */
function fingerprint(rec) {
  let h = 2166136261;
  const feed = (bytes) => { for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0; };
  if (rec.kind === 'mesh') { feed(typed(rec.data.positions)); feed(typed(rec.data.indices)); }
  else if (typeof rec.data === 'string') feed(new TextEncoder().encode(rec.data));
  else if (rec.kind === 'bundle') feed(new TextEncoder().encode(JSON.stringify(rec.data)));
  else feed(new Uint8Array(rec.data));
  return h.toString(16);
}

function slug(name) {
  return name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'asset';
}

export class WickAssets {
  /** persist: false keeps everything in memory (used by exported games, which carry their own assets). */
  constructor({ persist = true } = {}) {
    this.persist = persist;
    this.records = new Map();
    this.error = null; // set when IndexedDB is unavailable or full; assets then live only for this session
    this._urls = new Map();
    this._handlers = [];
  }

  onChange(fn) { this._handlers.push(fn); }
  _emit() { for (const fn of this._handlers) fn(); }

  /** Loads the saved library. Safe to call when IndexedDB is unavailable. */
  async open() {
    if (!this.persist) return;
    try {
      for (const r of await idbAll('assets')) this.records.set(r.id, r);
    } catch (err) {
      this.error = err;
    }
    this._emit();
  }

  get(id) { return this.records.get(id); }
  has(id) { return this.records.has(id); }
  list(kind) { return [...this.records.values()].filter((r) => !kind || r.kind === kind).sort((a, b) => a.added - b.added); }
  ids(kind) { return this.list(kind).map((r) => r.id); }

  /** A blob: URL for a texture or sound asset (cached). */
  url(id) {
    const rec = this.records.get(id);
    if (!rec || rec.kind === 'mesh' || rec.kind === 'script' || rec.kind === 'bundle') return null;
    let url = this._urls.get(id);
    if (!url) {
      url = URL.createObjectURL(new Blob([rec.data], { type: rec.mime }));
      this._urls.set(id, url);
    }
    return url;
  }

  _uniqueId(base) {
    let id = base, n = 2;
    while (this.records.has(id)) id = `${base}_${n++}`;
    return id;
  }

  /** Stores a record in memory and IndexedDB. Resolves with the record; sets this.error if it could not be saved. */
  async add({ name, kind, mime = '', data, meta = {}, id = null, srcHash = null, original = null }) {
    const rec = { id: this._uniqueId(id || slug(name)), name, kind, mime, data, meta, added: Date.now(), srcHash, original };
    this.records.set(rec.id, rec);
    this._emit();
    if (this.persist) {
      try {
        await idbPut('assets', rec);
        requestPersistence();
      } catch (err) {
        this.error = err;
      }
    }
    return rec;
  }

  async remove(id) {
    if (!this.records.delete(id)) return;
    const url = this._urls.get(id);
    if (url) { URL.revokeObjectURL(url); this._urls.delete(id); }
    this._emit();
    if (this.persist) { try { await idbDelete('assets', id); } catch (err) { this.error = err; } }
  }

  /** Imports one file chosen by the user. options.zUp applies to 3D models. Throws a readable Error. */
  async importFile(file, options = {}) {
    const kind = kindOfFile(file.name);
    if (!kind) throw new Error(`${file.name}: unsupported file type. Supported: ${ACCEPT}`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than ${MAX_FILE_BYTES / 1048576} MB`);
    const ext = extOf(file.name);
    const raw = new Uint8Array(await file.arrayBuffer());
    const srcHash = hashBytes(raw); // of the file as it was given, so a re-import of the same file can be recognised
    switch (kind) {
      case 'texture': {
        const data = raw.slice().buffer;
        try { (await createImageBitmap(new Blob([data], { type: EXT.texture[ext] }))).close(); } catch { throw new Error(`${file.name} is not a readable image`); }
        return this.add({ name: file.name, kind, mime: EXT.texture[ext], data, srcHash });
      }
      case 'sound':
        return this.add({ name: file.name, kind, mime: EXT.sound[ext], data: raw.slice().buffer, srcHash });
      case 'script':
        return this.add({ name: file.name, kind, mime: 'text/plain', data: new TextDecoder().decode(raw), srcHash });
      case 'bundle': {
        const data = JSON.parse(new TextDecoder().decode(raw));
        if (data?.format !== 'wick-bundle') throw new Error(`${file.name} is not a Wick bundle`);
        return this.add({ name: file.name, kind, mime: 'application/json', data, srcHash });
      }
      default: {
        const { mesh, size, format } = parseMeshFile(file.name, raw.slice().buffer, options);
        // The original file is kept so the Text-only Interface can write it back to a folder unchanged.
        return this.add({ name: file.name, kind, data: mesh, srcHash, original: raw.slice().buffer, meta: { format, size, zUp: !!options.zUp, triangles: mesh.indices.length / 3, vertices: mesh.positions.length / 3 } });
      }
    }
  }

  /**
   * Imports a file unless the library already holds this exact file under the id its name gives. A changed file with
   * the same name replaces the old one and keeps its id, so references in the project stay valid.
   */
  async ensureFile(file, options = {}) {
    const id = slug(file.name);
    const existing = this.records.get(id);
    if (existing?.srcHash) {
      const hash = hashBytes(new Uint8Array(await file.arrayBuffer()));
      if (hash === existing.srcHash && (existing.kind !== 'mesh' || !!existing.meta.zUp === !!options.zUp)) return existing;
    }
    if (existing) await this.remove(id);
    return this.importFile(file, options);
  }

  // ---- embedding in .wick files ----

  /** JSON-safe copy of the given assets (binary data as base64). Unknown ids are skipped. */
  embed(ids) {
    return ids.map((id) => this.records.get(id)).filter(Boolean).map((r) => {
      let data;
      if (r.kind === 'mesh') {
        data = { positions: toBase64(typed(r.data.positions)), normals: toBase64(typed(r.data.normals)), indices: toBase64(typed(r.data.indices)), uvs: r.data.uvs ? toBase64(typed(r.data.uvs)) : null };
      } else if (r.kind === 'script' || r.kind === 'bundle') data = r.data;
      else data = toBase64(new Uint8Array(r.data));
      return { id: r.id, name: r.name, kind: r.kind, mime: r.mime, meta: r.meta, data };
    });
  }

  /**
   * Adds embedded assets that this library does not have yet. An asset whose id is taken by different content gets a
   * new id. Resolves with a Map of old id -> new id for every asset that was renamed.
   */
  async importEmbedded(list) {
    const renamed = new Map();
    for (const e of list ?? []) {
      let data;
      if (e.kind === 'mesh') {
        const f32 = (t) => (t ? new Float32Array(fromBase64(t).buffer) : null);
        data = { positions: f32(e.data.positions), normals: f32(e.data.normals), uvs: f32(e.data.uvs), indices: new Uint32Array(fromBase64(e.data.indices).buffer) };
      } else if (e.kind === 'script' || e.kind === 'bundle') data = e.data;
      else data = fromBase64(e.data).buffer;
      const rec = { id: e.id, name: e.name, kind: e.kind, mime: e.mime, meta: e.meta ?? {}, data };
      const existing = this.records.get(e.id);
      if (existing && fingerprint(existing) === fingerprint(rec)) continue;
      const added = await this.add({ ...rec, id: e.id });
      if (added.id !== e.id) renamed.set(e.id, added.id);
    }
    return renamed;
  }
}
