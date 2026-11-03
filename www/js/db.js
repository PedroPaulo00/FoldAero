// Camada de persistência (IndexedDB):
//   media   — arquivos importados no navegador (Blob + metadados)
//   meta    — favorito/lixeira das mídias da galeria do aparelho (app nativo)
//   folders — pastas criadas pelo usuário
const DB = (() => {
  const NAME = 'dreamview';
  const VERSION = 2;
  const STORES = ['media', 'meta', 'folders'];
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((s) => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloqueado por outra aba'));
    });
    return dbPromise;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const result = fn(t.objectStore(store));
      t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    all: (store) => tx(store, 'readonly', (s) => s.getAll()),
    putMany: (store, items) => tx(store, 'readwrite', (s) => { items.forEach((i) => s.put(i)); }),
    remove: (store, ids) => tx(store, 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); })
  };
})();
