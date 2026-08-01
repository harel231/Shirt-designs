import { api } from '../api.js';
import {
  clampLayer,
  effectiveDpi,
  fitNewLayer,
  formatInches,
  layerToScreen,
  layoutCanvas,
  normalizeAngle,
  overflowsPrintArea,
  pixelsPerInch,
  pointerSpan,
  printAreaRect,
  screenToInches,
} from '../geometry.js';
import { getState, store } from '../store.js';
import {
  button,
  clear,
  confirmSheet,
  el,
  emptyState,
  icon,
  promptSheet,
  setChildren,
  sheet,
  toast,
  withBusy,
} from '../ui.js';
import { openTextTool } from './text-tool.js';
import { openImageTool } from './image-tool.js';
import { openExportSheet } from './shares.js';

/**
 * The design canvas.
 *
 * Layers live in inches relative to the print area, so what is dragged here is
 * literally what gets printed. Direct pointer handling (rather than a gesture
 * library) keeps one-finger drag, two-finger pinch/rotate and the corner
 * handles working from the same maths as the export.
 */

const CANVAS_PADDING = 18;
const LOW_DPI = 150;

export async function renderEditor({ mount, params, navigate }) {
  const [designId] = params;

  const design = await api.designs.get(designId);
  await store.loadShirts(false);
  await store.loadLibrary(false);

  const shirt = design.shirt ?? store.findShirt(design.shirtTypeId);
  if (!shirt) {
    mount.append(
      el(
        'div',
        { class: 'screen' },
        emptyState({
          title: 'Shirt type missing',
          message: 'The garment this design was built on has been deleted.',
          action: button('Back to designs', { class: 'btn btn-primary', onClick: () => navigate('#/designs') }),
        }),
      ),
    );
    return undefined;
  }

  /* ---------- state ---------- */

  const state = {
    name: design.name,
    colorHex: design.colorHex,
    colorwayId: design.colorwayId,
    views: {
      front: { layers: [...(design.views.front?.layers ?? [])] },
      back: { layers: [...(design.views.back?.layers ?? [])] },
    },
    view: 'front',
    selectedId: null,
    dirty: false,
  };

  const undoStack = [];

  const area = () => shirt.printAreas[state.view];
  const layers = () => state.views[state.view].layers;
  const selected = () => layers().find((layer) => layer.id === state.selectedId) ?? null;

  function snapshot() {
    undoStack.push(structuredClone(state.views));
    if (undoStack.length > 40) undoStack.shift();
  }

  function markDirty() {
    state.dirty = true;
    scheduleSave();
  }

  function updateLayer(id, patch, { record = true } = {}) {
    const list = layers();
    const index = list.findIndex((layer) => layer.id === id);
    if (index === -1) return;
    if (record) snapshot();
    list[index] = clampLayer({ ...list[index], ...patch }, area());
    markDirty();
    paintLayers();
    paintSelectionBar();
  }

  /* ---------- persistence ---------- */

  let saveTimer;
  let saving = false;

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 900);
    statusLabel.textContent = 'Unsaved';
  }

  async function save() {
    if (saving) return;
    saving = true;
    statusLabel.textContent = 'Saving…';
    try {
      await api.designs.save(design.id, {
        name: state.name,
        shirtTypeId: shirt.id,
        colorwayId: state.colorwayId,
        colorHex: state.colorHex,
        views: state.views,
      });
      state.dirty = false;
      statusLabel.textContent = 'Saved';
    } catch (err) {
      statusLabel.textContent = 'Not saved';
      toast(err.message, 'error');
    } finally {
      saving = false;
    }
  }

  /* ---------- chrome ---------- */

  const statusLabel = el('span', {}, 'Saved');
  const titleLabel = el('strong', { class: 'truncate' }, state.name);

  const root = el('div', { class: 'editor' });
  const stage = el('div', { class: 'editor-stage' });
  const canvas = el('div', { class: 'stage-canvas' });
  const garment = el('div', { class: 'garment' });
  const printArea = el('div', { class: 'print-area' });
  const layerHost = el('div', { class: 'stage-canvas' });
  const handleHost = el('div', { class: 'stage-canvas', style: { pointerEvents: 'none' } });

  canvas.append(garment, printArea);
  stage.append(canvas, layerHost, handleHost);

  const selectionBar = el('div', { class: 'selection-bar', hidden: true });
  const toolRow = el('div', { class: 'tool-row' });

  root.append(
    el(
      'div',
      { class: 'editor-bar' },
      el(
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Back',
          onClick: async () => {
            clearTimeout(saveTimer);
            if (state.dirty) await save();
            navigate('#/designs');
          },
        },
        icon('back'),
      ),
      el(
        'div',
        { class: 'editor-title' },
        titleLabel,
        el('span', {}, shirt.name, ' · ', statusLabel),
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          'aria-label': 'Rename design',
          onClick: async () => {
            const name = await promptSheet({ title: 'Rename design', label: 'Name', value: state.name });
            if (!name) return;
            state.name = name;
            titleLabel.textContent = name;
            markDirty();
          },
        },
        icon('text'),
      ),
      el(
        'button',
        {
          class: 'btn btn-primary btn-sm',
          onClick: () => exportDesign(),
        },
        icon('share'),
        'Export',
      ),
    ),
    el(
      'div',
      { class: 'seg', style: { margin: '10px 12px 0' } },
      ...['front', 'back'].map((view) =>
        el(
          'button',
          {
            type: 'button',
            'aria-pressed': String(state.view === view),
            dataset: { view },
            onClick: () => setView(view),
          },
          view === 'front' ? 'Front' : 'Back',
        ),
      ),
    ),
    stage,
    el('div', { class: 'editor-tools' }, selectionBar, toolRow),
  );

  mount.append(root);

  /* ---------- garment + layout ---------- */

  let layout = null;

  function currentColorway() {
    return shirt.colorways.find((row) => row.id === state.colorwayId) ?? shirt.colorways[0];
  }

  function garmentUrl() {
    if (shirt.source === 'photo') {
      const colorway = currentColorway();
      return state.view === 'back' ? colorway?.backUrl : colorway?.frontUrl;
    }
    return api.shirts.renderUrl(shirt.id, state.view, state.colorHex);
  }

  function relayout() {
    const bounds = stage.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return;

    layout = layoutCanvas(
      { width: bounds.width, height: bounds.height },
      shirt.canvas ?? { width: 1000, height: 1250 },
      CANVAS_PADDING,
    );

    Object.assign(garment.style, {
      left: `${layout.left}px`,
      top: `${layout.top}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
    });

    const rect = printAreaRect(layout, area());
    Object.assign(printArea.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });

    paintLayers();
  }

  function paintGarment() {
    const url = garmentUrl();
    setChildren(garment,
      url
        ? el('img', { src: url, alt: `${shirt.name} ${state.view}` })
        : el(
            'div',
            { style: { display: 'grid', placeItems: 'center', height: '100%', color: 'var(--faint)' } },
            `No ${state.view} image for this colour`,
          ),
    );
  }

  function setView(view) {
    state.view = view;
    state.selectedId = null;
    for (const node of root.querySelectorAll('.seg [data-view]')) {
      node.setAttribute('aria-pressed', String(node.dataset.view === view));
    }
    paintGarment();
    relayout();
    paintSelectionBar();
    paintTools();
  }

  /* ---------- layers ---------- */

  const layerNodes = new Map();

  function paintLayers() {
    if (!layout) return;
    const printBox = area();
    const seen = new Set();

    layers().forEach((layer, index) => {
      seen.add(layer.id);
      let node = layerNodes.get(layer.id);

      if (!node) {
        node = el('div', { class: 'layer', dataset: { id: layer.id } });
        node.addEventListener('pointerdown', (event) => onLayerPointerDown(event, layer.id));
        layerNodes.set(layer.id, node);
        layerHost.append(node);
      }

      const asset = store.findAsset(layer.assetId);
      if (node.dataset.assetId !== layer.assetId) {
        node.dataset.assetId = layer.assetId;
        setChildren(node,
          asset
            ? el('img', { src: api.assets.fileUrl(layer.assetId), alt: asset.name, draggable: false })
            : el('div', { class: 'note' }, 'Missing artwork'),
        );
      }

      const rect = layerToScreen(layer, layout, printBox);
      Object.assign(node.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transform: `rotate(${layer.rotation}deg)`,
        opacity: String(layer.opacity ?? 1),
        zIndex: String(10 + index),
      });
      node.classList.toggle('selected', layer.id === state.selectedId);
      node.classList.toggle('hidden', layer.visible === false);
      node.style.pointerEvents = layer.locked ? 'none' : 'auto';
    });

    for (const [id, node] of layerNodes) {
      if (!seen.has(id)) {
        node.remove();
        layerNodes.delete(id);
      }
    }

    paintHandles();
  }

  /* ---------- handles ---------- */

  function paintHandles() {
    clear(handleHost);
    const layer = selected();
    if (!layer || layer.locked || !layout) return;

    const rect = layerToScreen(layer, layout, area());
    const radians = (layer.rotation * Math.PI) / 180;

    // Handles ride the layer's rotated corners rather than the upright box.
    const corner = (dx, dy) => {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const x = (dx * rect.width) / 2;
      const y = (dy * rect.height) / 2;
      return {
        x: cx + x * Math.cos(radians) - y * Math.sin(radians),
        y: cy + x * Math.sin(radians) + y * Math.cos(radians),
      };
    };

    const resizeAt = corner(1, 1);
    const rotateAt = corner(-1, -1);

    handleHost.append(
      handle('resize', resizeAt, (event) => onResizeStart(event, layer.id)),
      handle('rotate', rotateAt, (event) => onRotateStart(event, layer.id)),
    );
  }

  function handle(name, at, onDown) {
    const node = el(
      'div',
      {
        class: 'handle',
        style: { left: `${at.x}px`, top: `${at.y}px`, pointerEvents: 'auto', touchAction: 'none' },
      },
      icon(name),
    );
    node.addEventListener('pointerdown', onDown);
    return node;
  }

  /* ---------- pointer interaction ---------- */

  /** Active drag pointers, so pinch and rotate can read both at once. */
  const pointers = new Map();
  let drag = null;

  function stagePoint(event) {
    const bounds = stage.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function onLayerPointerDown(event, layerId) {
    const layer = layers().find((row) => row.id === layerId);
    if (!layer || layer.locked) return;

    event.preventDefault();
    event.stopPropagation();
    select(layerId);

    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, stagePoint(event));

    if (pointers.size === 1) {
      drag = { kind: 'move', layerId, start: stagePoint(event), origin: { ...layer } };
      snapshot();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const span = pointerSpan(a, b);
      drag = {
        kind: 'transform',
        layerId,
        startSpan: span,
        origin: { ...layer },
      };
    }
  }

  function onResizeStart(event, layerId) {
    const layer = layers().find((row) => row.id === layerId);
    if (!layer) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const rect = layerToScreen(layer, layout, area());
    drag = {
      kind: 'resize',
      layerId,
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      startDistance: distance(stagePoint(event), {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      }),
      origin: { ...layer },
    };
    snapshot();
  }

  function onRotateStart(event, layerId) {
    const layer = layers().find((row) => row.id === layerId);
    if (!layer) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const rect = layerToScreen(layer, layout, area());
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const point = stagePoint(event);
    drag = {
      kind: 'rotate',
      layerId,
      center,
      startAngle: (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI,
      origin: { ...layer },
    };
    snapshot();
  }

  function onPointerMove(event) {
    if (!drag) return;
    const point = stagePoint(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);

    const layer = layers().find((row) => row.id === drag.layerId);
    if (!layer) return;
    const ppi = pixelsPerInch(layout, area());

    if (drag.kind === 'move') {
      const dx = (point.x - drag.start.x) / ppi;
      const dy = (point.y - drag.start.y) / ppi;
      updateLayer(drag.layerId, { x: drag.origin.x + dx, y: drag.origin.y + dy }, { record: false });
      return;
    }

    if (drag.kind === 'transform' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const span = pointerSpan(a, b);
      const factor = span.distance / Math.max(1, drag.startSpan.distance);
      const width = drag.origin.width * factor;
      const height = drag.origin.height * factor;
      updateLayer(
        drag.layerId,
        {
          width,
          height,
          // Scale about the centre so the artwork does not crawl away.
          x: drag.origin.x + (drag.origin.width - width) / 2,
          y: drag.origin.y + (drag.origin.height - height) / 2,
          rotation: drag.origin.rotation + normalizeAngle(span.angle - drag.startSpan.angle),
        },
        { record: false },
      );
      return;
    }

    if (drag.kind === 'resize') {
      const factor = distance(point, drag.center) / Math.max(1, drag.startDistance);
      const width = drag.origin.width * factor;
      const height = drag.origin.height * factor;
      updateLayer(
        drag.layerId,
        {
          width,
          height,
          x: drag.origin.x + (drag.origin.width - width) / 2,
          y: drag.origin.y + (drag.origin.height - height) / 2,
        },
        { record: false },
      );
      return;
    }

    if (drag.kind === 'rotate') {
      const angle = (Math.atan2(point.y - drag.center.y, point.x - drag.center.x) * 180) / Math.PI;
      let rotation = drag.origin.rotation + (angle - drag.startAngle);
      // Snap to the straight angles people actually want.
      const snapped = Math.round(rotation / 15) * 15;
      if (Math.abs(rotation - snapped) < 4) rotation = snapped;
      updateLayer(drag.layerId, { rotation: Math.round(rotation * 10) / 10 }, { record: false });
    }
  }

  function onPointerUp(event) {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) drag = null;
  }

  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);
  stage.addEventListener('pointerdown', (event) => {
    // A tap on empty canvas clears the selection.
    if (event.target === stage || event.target === canvas || event.target === layerHost) select(null);
  });

  function select(id) {
    state.selectedId = id;
    paintLayers();
    paintSelectionBar();
    paintTools();
  }

  /* ---------- selection bar ---------- */

  function paintSelectionBar() {
    const layer = selected();
    selectionBar.hidden = !layer;
    if (!layer) return;

    const asset = store.findAsset(layer.assetId);
    const dpi = asset && asset.kind === 'raster' ? effectiveDpi(asset, layer) : null;
    const outside = overflowsPrintArea(layer, area());

    clear(selectionBar);
    selectionBar.append(
      el(
        'span',
        { class: 'meta' },
        el('b', {}, formatInches(layer.width)),
        ' × ',
        el('b', {}, formatInches(layer.height)),
        dpi !== null
          ? el('span', { class: dpi < LOW_DPI ? 'warn' : '' }, ` · ${dpi} DPI`)
          : el('span', {}, ' · vector'),
        outside ? el('span', { class: 'warn' }, ' · outside print area') : null,
      ),
      barButton('Centre', 'flip', () => {
        updateLayer(layer.id, { x: (area().widthIn - layer.width) / 2 });
      }),
      barButton('Front', 'arrowUp', () => reorder(layer.id, 1)),
      barButton('Back', 'arrowDown', () => reorder(layer.id, -1)),
      barButton(layer.visible === false ? 'Show' : 'Hide', layer.visible === false ? 'eyeOff' : 'eye', () => {
        updateLayer(layer.id, { visible: layer.visible === false });
      }),
      barButton('Duplicate', 'copy', () => duplicateLayer(layer)),
      barButton('Delete', 'trash', () => removeLayer(layer.id), true),
    );
  }

  function barButton(label, iconName, onClick, danger = false) {
    return el(
      'button',
      { class: `btn btn-sm btn-ghost ${danger ? 'btn-danger' : ''}`, onClick },
      icon(iconName),
      label,
    );
  }

  function reorder(id, direction) {
    const list = layers();
    const index = list.findIndex((layer) => layer.id === id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= list.length) return;
    snapshot();
    const [layer] = list.splice(index, 1);
    list.splice(target, 0, layer);
    markDirty();
    paintLayers();
  }

  function duplicateLayer(layer) {
    snapshot();
    const copy = {
      ...structuredClone(layer),
      id: `layer_${Math.random().toString(36).slice(2, 10)}`,
      x: layer.x + 0.25,
      y: layer.y + 0.25,
    };
    layers().push(copy);
    state.selectedId = copy.id;
    markDirty();
    paintLayers();
    paintSelectionBar();
  }

  function removeLayer(id) {
    snapshot();
    state.views[state.view].layers = layers().filter((layer) => layer.id !== id);
    state.selectedId = null;
    markDirty();
    paintLayers();
    paintSelectionBar();
    paintTools();
  }

  /* ---------- tools ---------- */

  function paintTools() {
    clear(toolRow);
    toolRow.append(
      toolButton('Graphic', 'image', () => openLibrarySheet()),
      toolButton('Text', 'text', async () => {
        const asset = await openTextTool();
        if (asset) addLayer(asset, 'text');
      }),
      toolButton('Colour', 'palette', () => openColorSheet()),
      toolButton('Layers', 'layers', () => openLayersSheet()),
      toolButton('Undo', 'rotate', undo, undoStack.length === 0),
    );
  }

  function toolButton(label, iconName, onClick, disabled = false) {
    return el('button', { type: 'button', onClick, disabled }, icon(iconName), el('span', {}, label));
  }

  function undo() {
    const previous = undoStack.pop();
    if (!previous) return;
    state.views = previous;
    state.selectedId = null;
    markDirty();
    // Rebuild from scratch: an undo can remove or reorder nodes wholesale.
    for (const node of layerNodes.values()) node.remove();
    layerNodes.clear();
    paintLayers();
    paintSelectionBar();
    paintTools();
  }

  function addLayer(asset, type = 'graphic') {
    const box = fitNewLayer(asset, area());
    snapshot();
    const layer = {
      id: `layer_${Math.random().toString(36).slice(2, 10)}`,
      type,
      assetId: asset.id,
      ...box,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
    };
    layers().push(layer);
    state.selectedId = layer.id;
    markDirty();
    paintLayers();
    paintSelectionBar();
    paintTools();
  }

  function openLibrarySheet() {
    const { library } = getState();

    return sheet({
      title: 'Add from library',
      render: (close) => {
        if (library.length === 0) {
          return emptyState({
            title: 'Your library is empty',
            message: 'Artwork you save in Create shows up here.',
            action: button('Go to Create', {
              class: 'btn btn-primary',
              onClick: () => {
                close();
                navigate('#/create');
              },
            }),
          });
        }

        return el(
          'div',
          { class: 'grid' },
          ...library.map((asset) =>
            el(
              'button',
              {
                class: 'tile',
                onClick: () => {
                  addLayer(asset, asset.source === 'text' ? 'text' : 'graphic');
                  close();
                },
              },
              el(
                'div',
                { class: 'tile-art checker' },
                el('img', { src: api.assets.fileUrl(asset.id), alt: '', loading: 'lazy' }),
              ),
              el('div', { class: 'tile-label' }, el('strong', { class: 'truncate' }, asset.name)),
            ),
          ),
        );
      },
      footer: (close) =>
        el(
          'div',
          { class: 'btn-row' },
          button('Upload an image', {
            class: 'btn btn-ghost',
            iconName: 'image',
            onClick: () => {
              close();
              pickAndPrepareImage();
            },
          }),
          button('Add text', {
            class: 'btn btn-primary',
            iconName: 'text',
            onClick: async () => {
              close();
              const asset = await openTextTool();
              if (asset) addLayer(asset, 'text');
            },
          }),
        ),
    });
  }

  /** Upload straight from the canvas, run it through the workbench, place it. */
  function pickAndPrepareImage() {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'sr-only' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;

      const uploaded = await withBusy('Uploading…', () => api.assets.upload(file));
      store.cacheAsset(uploaded);
      const prepared = await openImageTool(uploaded);
      await store.loadLibrary();
      if (prepared) addLayer(prepared, 'graphic');
    });
    document.body.append(input);
    input.click();
  }

  function openColorSheet() {
    return sheet({
      title: 'Shirt colour',
      render: (close) => {
        const grid = el('div', { class: 'grid' });
        for (const colorway of shirt.colorways) {
          grid.append(
            el(
              'button',
              {
                class: 'tile',
                onClick: () => {
                  state.colorwayId = colorway.id;
                  state.colorHex = colorway.hex;
                  paintGarment();
                  markDirty();
                  close();
                },
              },
              el(
                'div',
                { class: 'tile-art' },
                colorway.frontUrl
                  ? el('img', { src: colorway.frontUrl, alt: colorway.name, loading: 'lazy' })
                  : el('div', { style: { background: colorway.hex, width: '100%', height: '100%' } }),
              ),
              el(
                'div',
                { class: 'tile-label' },
                el('strong', { class: 'truncate' }, colorway.name),
                el('span', {}, colorway.hex),
              ),
            ),
          );
        }
        return grid;
      },
    });
  }

  function openLayersSheet() {
    return sheet({
      title: `${state.view === 'front' ? 'Front' : 'Back'} layers`,
      render: (close) => {
        const list = layers();
        if (list.length === 0) {
          return emptyState({ title: 'Nothing here yet', message: 'Add a graphic or some text.' });
        }

        // Topmost first, matching what the eye sees on the shirt.
        return el(
          'div',
          {},
          ...[...list].reverse().map((layer) => {
            const asset = store.findAsset(layer.assetId);
            return el(
              'button',
              {
                class: 'row',
                onClick: () => {
                  select(layer.id);
                  close();
                },
              },
              el(
                'div',
                { class: 'thumb checker' },
                asset ? el('img', { src: api.assets.fileUrl(asset.id), alt: '' }) : icon('warn'),
              ),
              el(
                'div',
                { class: 'row-body' },
                el('strong', { class: 'truncate' }, asset?.name ?? 'Missing artwork'),
                el(
                  'span',
                  {},
                  `${formatInches(layer.width)} × ${formatInches(layer.height)}${layer.visible === false ? ' · hidden' : ''}`,
                ),
              ),
              el(
                'span',
                {
                  class: 'icon-btn',
                  role: 'button',
                  'aria-label': layer.locked ? 'Unlock' : 'Lock',
                  onClick: (event) => {
                    event.stopPropagation();
                    updateLayer(layer.id, { locked: !layer.locked });
                    close();
                  },
                },
                icon('lock'),
              ),
            );
          }),
        );
      },
    });
  }

  async function exportDesign() {
    clearTimeout(saveTimer);
    await save();

    const total = state.views.front.layers.length + state.views.back.layers.length;
    if (total === 0) {
      toast('Add some artwork before exporting.', 'error');
      return;
    }

    const record = await withBusy('Building print files…', () => api.designs.export(design.id));
    await store.loadExports();
    await openExportSheet(record);
  }

  /* ---------- start ---------- */

  paintGarment();
  paintTools();

  // The stage has no size until it is in the document and laid out, and it
  // changes again when the toolbar grows or the on-screen keyboard appears.
  // Observing it beats guessing with a one-shot rAF.
  const observer = new ResizeObserver(() => relayout());
  observer.observe(stage);

  const onResize = () => relayout();
  window.addEventListener('orientationchange', onResize);

  return () => {
    observer.disconnect();
    window.removeEventListener('orientationchange', onResize);
    clearTimeout(saveTimer);
    if (state.dirty) save();
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
