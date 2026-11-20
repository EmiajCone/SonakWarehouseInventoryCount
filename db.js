/* db.js — everything here works fully offline against IndexedDB. */
const DB_NAME = "warehouse-count-db";
const DB_VERSION = 1;

const DB = (() => {
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("catalog")) {
          db.createObjectStore("catalog", { keyPath: "gtin" });
        }
        if (!db.objectStoreNames.contains("racks")) {
          db.createObjectStore("racks", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("queue")) {
          db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
        }
        if (!db.objectStoreNames.contains("settings")) {
          db.createObjectStore("settings", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(storeName, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const store = t.objectStore(storeName);
      const result = fn(store);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
    });
  }

  return {
    // ---- catalog (single active brand's data at a time) ----
    _catalogCache: null,

    async clearCatalog() {
      this._catalogCache = null;
      return tx("catalog", "readwrite", (store) => store.clear());
    },

    async bulkLoadCatalog(records, onProgress) {
      this._catalogCache = null;
      const db = await open();
      const CHUNK = 2000;
      for (let i = 0; i < records.length; i += CHUNK) {
        const chunk = records.slice(i, i + CHUNK);
        await new Promise((resolve, reject) => {
          const t = db.transaction("catalog", "readwrite");
          const store = t.objectStore("catalog");
          chunk.forEach((r) => store.put(r));
          t.oncomplete = resolve;
          t.onerror = () => reject(t.error);
        });
        if (onProgress) onProgress(Math.min(i + CHUNK, records.length), records.length);
      }
    },

    async getByGtin(gtin) {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction("catalog", "readonly").objectStore("catalog").get(gtin);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    },

    async catalogCount() {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction("catalog", "readonly").objectStore("catalog").count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
    },

    async getCatalogArray() {
      if (this._catalogCache) return this._catalogCache;
      const db = await open();
      this._catalogCache = await new Promise((resolve) => {
        const req = db.transaction("catalog", "readonly").objectStore("catalog").getAll();
        req.onsuccess = () => {
          const rows = req.result || [];
          rows.forEach((r) => {
            r._s = `${r.gtin} ${r.article || ""} ${r.desc || ""} ${r.model || ""} ${r.color || ""} ${r.size || ""}`.toLowerCase();
          });
          resolve(rows);
        };
        req.onerror = () => resolve([]);
      });
      return this._catalogCache;
    },

    async searchCatalog(queryStr, limit = 20) {
      const q = queryStr.trim().toLowerCase();
      const arr = await this.getCatalogArray();
      if (!q) return arr.slice(0, limit);
      const out = [];
      for (let i = 0; i < arr.length && out.length < limit; i++) {
        if (arr[i]._s.includes(q)) out.push(arr[i]);
      }
      return out;
    },

    // ---- racks (all brands, refreshed together) ----
    async replaceRacks(records) {
      const db = await open();
      await new Promise((resolve, reject) => {
        const t = db.transaction("racks", "readwrite");
        t.objectStore("racks").clear();
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
      return new Promise((resolve, reject) => {
        const t = db.transaction("racks", "readwrite");
        const store = t.objectStore("racks");
        records.forEach((r) => store.add(r));
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },

    async getRacks() {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction("racks", "readonly").objectStore("racks").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    },

    async getRacksForBrand(brand) {
      const all = await this.getRacks();
      return all.filter((r) => r.brand === brand);
    },

    // ---- submission queue (anything that couldn't reach the server yet) ----
    async enqueue(record) {
      return tx("queue", "readwrite", (store) => store.add(record));
    },

    async getQueue() {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction("queue", "readonly").objectStore("queue").getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    },

    async dequeue(id) {
      return tx("queue", "readwrite", (store) => store.delete(id));
    },

    // ---- settings / session (small key-value store) ----
    async setSetting(key, value) {
      return tx("settings", "readwrite", (store) => store.put({ key, value }));
    },

    async getSetting(key, fallback = null) {
      const db = await open();
      return new Promise((resolve) => {
        const req = db.transaction("settings", "readonly").objectStore("settings").get(key);
        req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
        req.onerror = () => resolve(fallback);
      });
    },

    async clearSetting(key) {
      return tx("settings", "readwrite", (store) => store.delete(key));
    },
  };
})();
