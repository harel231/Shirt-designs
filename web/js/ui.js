/**
 * Small DOM toolkit.
 *
 * The studio is a handful of screens driven by direct DOM writes rather than a
 * framework — the design canvas is imperative by nature (pointer maths, live
 * transforms) and a virtual DOM would only get in its way. These helpers are
 * the shared vocabulary the screens are written in.
 */

/**
 * Creates an element. Children may be nodes, strings, or nested arrays;
 * null/undefined/false are skipped so `cond && el(...)` works inline.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/**
 * Replaces a node's contents, skipping the falsy entries that inline
 * conditionals produce. The native `replaceChildren` would stringify a `null`
 * into the literal text "null", so screens must always go through this.
 */
export function setChildren(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

/** Inline SVG icons. Kept here so no icon font or sprite has to be fetched. */
const ICON_PATHS = {
  create: 'M12 3v18M3 12h18',
  shirts:
    'M8 3l-5 3 2 4 2-1v12h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0z',
  designs: 'M3 5h18M3 12h18M3 19h12',
  share: 'M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M12 3v13M8 7l4-4 4 4',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
  text: 'M4 6V4h16v2M12 4v16M8 20h8',
  back: 'M15 5l-7 7 7 7',
  chev: 'M9 5l7 7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12l5 5L20 6',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z',
  eyeOff: 'M4 4l16 16M10 6a10 10 0 0 1 12 6 18 18 0 0 1-3 4M6 8a18 18 0 0 0-4 4s4 7 10 7a10 10 0 0 0 4-1',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z',
  layers: 'M12 3l9 5-9 5-9-5zM3 14l9 5 9-5',
  palette: 'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4 2 2 0 0 1 2-2h1a4 4 0 0 0 4-4c0-4.4-4-8-9-8z',
  wand: 'M4 20l10-10M14 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM19 13l.7 2 2 .7-2 .8-.7 2-.8-2-2-.8 2-.7z',
  vector: 'M4 4h4v4H4zM16 16h4v4h-4zM8 6h8a2 2 0 0 1 2 2v8',
  flip: 'M12 3v18M8 8L4 12l4 4M16 8l4 4-4 4',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  rotate: 'M4 12a8 8 0 1 1 3 6M4 12V7M4 12h5',
  resize: 'M9 21H3v-6M21 9V3h-6M3 21L10 14M21 3l-7 7',
  front: 'M12 4l-4 2v14h8V6z',
  warn: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 8h.01',
  save: 'M5 4h11l4 4v12H5zM8 4v6h7V4M8 20v-6h8v6',
  camera: 'M4 8h3l2-3h6l2 3h3v12H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  link: 'M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  arrowUp: 'M12 20V5M6 11l6-6 6 6',
  arrowDown: 'M12 4v15M6 13l6 6 6-6',
  contrast: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 3v18',
};

export function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (size) {
    svg.style.width = `${size}px`;
    svg.style.height = `${size}px`;
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.info);
  svg.append(path);
  return svg;
}

export function button(label, props = {}) {
  const { iconName, ...rest } = props;
  return el('button', { type: 'button', class: 'btn', ...rest }, iconName && icon(iconName), label);
}

/* ---------- toasts ---------- */

export function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  const node = el('div', { class: `toast ${kind ? `toast-${kind}` : ''}` }, message);
  root.append(node);

  setTimeout(() => {
    node.style.transition = 'opacity 0.25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, kind === 'error' ? 5200 : 2800);
}

/* ---------- blocking progress ---------- */

let busyDepth = 0;
let busyNode = null;

export function busy(message) {
  busyDepth += 1;
  if (!busyNode) {
    busyNode = el('div', { class: 'busy' }, el('div', { class: 'boot-mark' }), el('p', {}, message));
    document.body.append(busyNode);
  } else {
    busyNode.querySelector('p').textContent = message;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    busyDepth -= 1;
    if (busyDepth <= 0) {
      busyDepth = 0;
      busyNode?.remove();
      busyNode = null;
    }
  };
}

/** Wraps an async task in the blocking spinner and surfaces failures as toasts. */
export async function withBusy(message, task) {
  const done = busy(message);
  try {
    return await task();
  } catch (err) {
    toast(err?.message ?? 'Something went wrong.', 'error');
    throw err;
  } finally {
    done();
  }
}

/* ---------- bottom sheets ---------- */

/**
 * Opens a bottom sheet.
 *
 * `render` receives a `close(result)` callback and returns the body content.
 * The returned promise resolves with whatever `close` was given, so a sheet
 * reads like an await at the call site.
 */
/** Depth of the currently open sheet stack, so nested sheets layer correctly. */
let sheetDepth = 0;

export function sheet({ title, render, footer, onClose, dismissible = true }) {
  const root = document.getElementById('sheet-root');
  const depth = sheetDepth++;

  return new Promise((resolve) => {
    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      sheetDepth = Math.max(0, sheetDepth - 1);
      backdrop.style.opacity = '0';
      setTimeout(() => backdrop.remove(), 150);
      document.removeEventListener('keydown', onKey);
      onClose?.(result);
      resolve(result);
    };

    const onKey = (event) => {
      if (event.key === 'Escape' && dismissible) close(undefined);
    };

    const body = el('div', { class: 'sheet-body' });
    const panel = el(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title ?? 'Options' },
      el('div', { class: 'sheet-grip' }),
      title &&
        el(
          'div',
          { class: 'sheet-head' },
          el('h2', {}, title),
          dismissible &&
            el('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close(undefined) }, icon('close')),
        ),
      body,
    );

    const backdrop = el(
      'div',
      {
        class: 'sheet-backdrop',
        style: { transition: 'opacity 0.15s', zIndex: String(60 + depth * 2) },
        onClick: (event) => {
          if (event.target === backdrop && dismissible) close(undefined);
        },
      },
      panel,
    );

    append(body, [render(close, { panel, body })]);
    if (footer) panel.append(el('div', { class: 'sheet-foot' }, footer(close)));

    root.append(backdrop);
    document.addEventListener('keydown', onKey);
  });
}

/** Yes/no confirmation as a sheet. Resolves true only on the confirm action. */
export function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return sheet({
    title,
    render: () => el('p', { style: { margin: '4px 0 8px', color: 'var(--muted)' } }, message),
    footer: (close) =>
      el(
        'div',
        { class: 'btn-row' },
        button('Cancel', { class: 'btn btn-ghost', onClick: () => close(false) }),
        button(confirmLabel, {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          onClick: () => close(true),
        }),
      ),
  }).then((result) => result === true);
}

/** Single-line text prompt as a sheet. Resolves the trimmed value or null. */
export function promptSheet({ title, label, value = '', placeholder = '', confirmLabel = 'Save' }) {
  let input;
  return sheet({
    title,
    render: (close) => {
      input = el('input', {
        type: 'text',
        value,
        placeholder,
        onKeydown: (event) => {
          if (event.key === 'Enter') close(input.value.trim() || null);
        },
      });
      setTimeout(() => input.focus(), 80);
      return el('label', { class: 'field' }, el('span', {}, label), input);
    },
    footer: (close) =>
      el(
        'div',
        { class: 'btn-row' },
        button('Cancel', { class: 'btn btn-ghost', onClick: () => close(null) }),
        button(confirmLabel, {
          class: 'btn btn-primary',
          onClick: () => close(input.value.trim() || null),
        }),
      ),
  }).then((result) => result ?? null);
}

/** A labelled range input that reports its value live. */
export function slider({ label, min, max, step = 1, value, format = (v) => v, onInput }) {
  const readout = el('b', {}, format(value));
  const input = el('input', {
    type: 'range',
    min,
    max,
    step,
    value,
    onInput: (event) => {
      const next = Number(event.target.value);
      readout.textContent = format(next);
      onInput(next);
    },
  });

  return el(
    'label',
    { class: 'slider' },
    el('div', { class: 'slider-head' }, el('span', {}, label), readout),
    input,
  );
}

export function segmented(options, active, onChange) {
  const wrap = el('div', { class: 'seg', role: 'group' });
  for (const option of options) {
    wrap.append(
      el(
        'button',
        {
          type: 'button',
          'aria-pressed': String(option.value === active),
          onClick: () => onChange(option.value),
        },
        option.label,
      ),
    );
  }
  return wrap;
}

export function emptyState({ title, message, action }) {
  return el('div', { class: 'empty' }, el('strong', {}, title), el('p', {}, message), action);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
