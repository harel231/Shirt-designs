import { api } from './api.js';

/**
 * Shared client state.
 *
 * Deliberately thin: the server is the source of truth, so this is a cache
 * with explicit invalidation rather than a second copy of the data model.
 * Screens subscribe to the collections they render and re-render on change.
 */

const state = {
  library: [],
  drafts: [],
  shirts: [],
  shapes: [],
  designs: [],
  exports: [],
  health: null,
};

const listeners = new Set();
const loaded = new Set();

export function getState() {
  return state;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  for (const listener of [...listeners]) listener(state);
}

function set(patch) {
  Object.assign(state, patch);
  emit();
}

/** Fetches a collection once, unless `force` is set. */
async function ensure(key, loader, force) {
  if (loaded.has(key) && !force) return;
  await loader();
  loaded.add(key);
}

export const store = {
  async init() {
    const health = await api.health();
    set({ health });
    await Promise.all([store.loadShirts(), store.loadLibrary()]);
  },

  async loadLibrary(force = true) {
    return ensure(
      'library',
      async () => {
        const [saved, all] = await Promise.all([
          api.assets.list(),
          api.assets.list({ includeDrafts: true }),
        ]);
        const savedIds = new Set(saved.items.map((item) => item.id));
        set({
          library: saved.items,
          drafts: all.items.filter((item) => !savedIds.has(item.id)),
        });
      },
      force,
    );
  },

  async loadShirts(force = true) {
    return ensure(
      'shirts',
      async () => {
        const { items, shapes } = await api.shirts.list();
        set({ shirts: items, shapes });
      },
      force,
    );
  },

  async loadDesigns(force = true) {
    return ensure(
      'designs',
      async () => {
        const { items } = await api.designs.list();
        set({ designs: items });
      },
      force,
    );
  },

  async loadExports(force = true) {
    return ensure(
      'exports',
      async () => {
        const { items } = await api.exports.list();
        set({ exports: items });
      },
      force,
    );
  },

  findShirt(id) {
    return state.shirts.find((shirt) => shirt.id === id);
  },

  findAsset(id) {
    return (
      state.library.find((asset) => asset.id === id) ??
      state.drafts.find((asset) => asset.id === id)
    );
  },

  /** Keeps a just-created asset visible without a full round trip. */
  cacheAsset(asset) {
    const bucket = asset.saved ? 'library' : 'drafts';
    const next = state[bucket].filter((item) => item.id !== asset.id);
    set({ [bucket]: [asset, ...next] });
  },
};
