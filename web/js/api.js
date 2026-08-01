/**
 * Studio server client.
 *
 * Same-origin by construction: the app is served by the very server it talks
 * to, so a phone only ever needs one URL and there is no host to configure.
 */

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request(path, init) {
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('Cannot reach the studio server. Check your connection.', 0);
  }

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(body?.error ?? `Request failed (${response.status})`, response.status, body);
  }
  return body;
}

function postJson(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export const api = {
  health: () => request('/api/health'),

  assets: {
    list: ({ includeDrafts = false, kind } = {}) => {
      const params = new URLSearchParams();
      if (includeDrafts) params.set('include', 'drafts');
      if (kind) params.set('kind', kind);
      return request(`/api/assets?${params}`);
    },
    get: (id) => request(`/api/assets/${id}`),
    upload: (file, name) => {
      const form = new FormData();
      form.append('image', file, file.name ?? 'upload.png');
      if (name) form.append('name', name);
      return request('/api/assets/upload', { method: 'POST', body: form });
    },
    backgroundColors: (id) => request(`/api/assets/${id}/background-colors`),
    removeBackground: (id, options) => postJson(`/api/assets/${id}/remove-background`, options),
    vectorize: (id, options) => postJson(`/api/assets/${id}/vectorize`, options),
    recolor: (id, color) => postJson(`/api/assets/${id}/recolor`, { color }),
    createText: (spec) => postJson('/api/assets/text', spec),
    save: (id, name) => postJson(`/api/assets/${id}/save`, { name }),
    rename: (id, name) =>
      request(`/api/assets/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    remove: (id, force = false) =>
      request(`/api/assets/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
    fileUrl: (id) => `/api/assets/${id}/file`,
  },

  shirts: {
    list: () => request('/api/shirts'),
    get: (id) => request(`/api/shirts/${id}`),
    create: (form) => request('/api/shirts', { method: 'POST', body: form }),
    addColorway: (id, form) => request(`/api/shirts/${id}/colorways`, { method: 'POST', body: form }),
    update: (id, patch) =>
      request(`/api/shirts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      }),
    removeColorway: (id, colorwayId) =>
      request(`/api/shirts/${id}/colorways/${colorwayId}`, { method: 'DELETE' }),
    remove: (id, force = false) =>
      request(`/api/shirts/${id}${force ? '?force=true' : ''}`, { method: 'DELETE' }),
    renderUrl: (id, view, color, guide = false) =>
      `/api/shirts/${id}/render?view=${view}&color=${encodeURIComponent(color)}${guide ? '&guide=true' : ''}`,
  },

  designs: {
    list: () => request('/api/designs'),
    get: (id) => request(`/api/designs/${id}`),
    create: (input) => postJson('/api/designs', input),
    save: (id, input) =>
      request(`/api/designs/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    duplicate: (id) => request(`/api/designs/${id}/duplicate`, { method: 'POST' }),
    remove: (id) => request(`/api/designs/${id}`, { method: 'DELETE' }),
    export: (id) => request(`/api/designs/${id}/export`, { method: 'POST' }),
  },

  exports: {
    list: () => request('/api/exports'),
    revoke: (id) => request(`/api/exports/${id}`, { method: 'DELETE' }),
  },

  fonts: {
    search: ({ q = '', category = '', limit = 40, offset = 0 } = {}) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      return request(`/api/fonts?${params}`);
    },
    categories: () => request('/api/fonts/categories'),
    preview: (spec) => postJson('/api/fonts/preview', spec),
    sampleUrl: (family, { text, weight = 400, size = 40, color } = {}) => {
      const params = new URLSearchParams({ weight: String(weight), size: String(size) });
      if (text) params.set('text', text);
      if (color) params.set('color', color);
      return `/api/fonts/${encodeURIComponent(family)}/sample.svg?${params}`;
    },
  },
};
