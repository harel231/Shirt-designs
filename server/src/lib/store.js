import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DB_PATH, ensureStorage } from './paths.js';

const EMPTY = { assets: [], shirtTypes: [], designs: [], exports: [] };

let cache = null;
let writeQueue = Promise.resolve();

function load() {
  if (cache) return cache;
  ensureStorage();
  if (existsSync(DB_PATH)) {
    try {
      cache = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(DB_PATH, 'utf8')) };
    } catch (err) {
      // A corrupt database should not take the whole studio offline; keep the
      // damaged file around so nothing is silently destroyed.
      const backup = `${DB_PATH}.corrupt-${Date.now()}`;
      renameSync(DB_PATH, backup);
      console.error(`db.json was unreadable (${err.message}); moved to ${backup}`);
      cache = structuredClone(EMPTY);
    }
  } else {
    cache = structuredClone(EMPTY);
  }
  return cache;
}

/** Writes are serialised and atomic (temp file + rename) to survive crashes. */
function persist() {
  const snapshot = JSON.stringify(cache, null, 2);
  writeQueue = writeQueue.then(() => {
    const tmp = `${DB_PATH}.${process.pid}.tmp`;
    writeFileSync(tmp, snapshot);
    renameSync(tmp, DB_PATH);
  });
  return writeQueue;
}

export const db = {
  /** Read-only view of a collection. */
  all(collection) {
    return load()[collection];
  },

  find(collection, id) {
    return load()[collection].find((row) => row.id === id);
  },

  findBy(collection, predicate) {
    return load()[collection].find(predicate);
  },

  insert(collection, row) {
    load()[collection].push(row);
    persist();
    return row;
  },

  update(collection, id, patch) {
    const row = db.find(collection, id);
    if (!row) return undefined;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    persist();
    return row;
  },

  remove(collection, id) {
    const rows = load()[collection];
    const index = rows.findIndex((row) => row.id === id);
    if (index === -1) return undefined;
    const [row] = rows.splice(index, 1);
    persist();
    return row;
  },

  /** Test/bootstrap helper: drops the in-memory cache so the file is re-read. */
  reset() {
    cache = null;
  },

  flush() {
    return writeQueue;
  },
};
