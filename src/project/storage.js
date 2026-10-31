// Wick storage: the one IndexedDB database behind the asset library and project autosave.
// Stores: 'assets' (keyPath id) holds every imported asset, 'projects' holds autosaved projects by key.

const DB_NAME = 'wick-engine';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB is not available in this browser')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

/** Runs one request inside its own transaction and resolves with the request's result once it has committed. */
async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

export const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const idbAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const idbPut = (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const idbDelete = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

/** Asks the browser not to evict this origin's storage. Harmless if refused or unsupported. */
export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* optional */ }
}
