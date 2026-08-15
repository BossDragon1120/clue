// db.js — local, on-device storage for CLUE (IndexedDB). Nothing leaves the device.
const DB_NAME = 'clue-db';
const DB_VERSION = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('clues')) {
        const s = db.createObjectStore('clues', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('insights')) {
        db.createObjectStore('insights', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(r => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  async addClue(clue) { await tx('clues', 'readwrite', s => s.put(clue)); return clue; },
  async updateClue(clue) { await tx('clues', 'readwrite', s => s.put(clue)); return clue; },
  async deleteClue(id) { await tx('clues', 'readwrite', s => s.delete(id)); },
  async getClues() {
    const rows = await tx('clues', 'readonly', s => reqP(s.getAll()));
    return (rows || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },
  async clearClues() { await tx('clues', 'readwrite', s => s.clear()); },

  async saveInsights(obj) { await tx('insights', 'readwrite', s => s.put({ id: 'current', ...obj, updatedAt: new Date().toISOString() })); },
  async getInsights() { return tx('insights', 'readonly', s => reqP(s.get('current'))); },
  async clearInsights() { await tx('insights', 'readwrite', s => s.clear()); },

  async getSetting(key, fallback = null) {
    const row = await tx('meta', 'readonly', s => reqP(s.get(key)));
    return row ? row.value : fallback;
  },
  async setSetting(key, value) { await tx('meta', 'readwrite', s => s.put({ key, value })); },

  async exportAll() {
    const clues = await this.getClues();
    const insights = await this.getInsights();
    return { app: 'clue', version: 1, exportedAt: new Date().toISOString(), clues, insights };
  },
  async importAll(data) {
    if (!data || !Array.isArray(data.clues)) throw new Error('Not a valid CLUE backup file.');
    for (const c of data.clues) { if (c && c.id) await this.addClue(c); }
    return data.clues.length;
  },
};
