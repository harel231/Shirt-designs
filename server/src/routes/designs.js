import { Router } from 'express';
import { newId } from '../lib/ids.js';
import { db } from '../lib/store.js';
import { normalizeHex } from '../lib/text.js';
import { publicShirt } from './shirts.js';

/**
 * Saved shirt designs.
 *
 * A design is a placement document: which shirt, which colour, and where each
 * library asset sits on the front and the back. Layer geometry is stored in
 * *inches relative to the print area*, not screen pixels, so a design means
 * the same thing on a phone, in the mockup and on the production PDF.
 */

export const designsRouter = Router();

const VIEWS = ['front', 'back'];

function emptyViews() {
  return { front: { layers: [] }, back: { layers: [] } };
}

function sanitizeLayer(raw, area) {
  const width = positive(raw.width, 4);
  const height = positive(raw.height, 4);

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('layer'),
    type: raw.type === 'text' ? 'text' : 'graphic',
    assetId: String(raw.assetId ?? ''),
    // Inches from the top-left of the print area. Allowed slightly outside the
    // area so artwork can be deliberately cropped by the bleed edge.
    x: bounded(raw.x, -area.widthIn, area.widthIn * 2, 0),
    y: bounded(raw.y, -area.heightIn, area.heightIn * 2, 0),
    width,
    height,
    rotation: bounded(raw.rotation, -360, 360, 0),
    opacity: bounded(raw.opacity, 0, 1, 1),
    visible: raw.visible !== false,
    locked: raw.locked === true,
  };
}

function sanitizeViews(raw, shirt) {
  const views = emptyViews();
  for (const view of VIEWS) {
    const area = shirt.printAreas[view];
    const layers = Array.isArray(raw?.[view]?.layers) ? raw[view].layers : [];
    views[view] = {
      layers: layers
        .slice(0, 60)
        .map((layer) => sanitizeLayer(layer, area))
        .filter((layer) => db.find('assets', layer.assetId)),
    };
  }
  return views;
}

function resolveColorway(shirt, colorwayId, fallbackHex) {
  const colorway =
    shirt.colorways.find((row) => row.id === colorwayId) ?? shirt.colorways[0];
  const hex = normalizeHex(fallbackHex) ?? colorway?.hex ?? '#ffffff';
  return { colorwayId: colorway?.id ?? null, colorHex: hex };
}

designsRouter.get('/', (req, res) => {
  const items = db
    .all('designs')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((design) => ({
      ...design,
      layerCount: VIEWS.reduce((sum, view) => sum + design.views[view].layers.length, 0),
    }));
  res.json({ items });
});

designsRouter.get('/:id', (req, res) => {
  const design = db.find('designs', req.params.id);
  if (!design) return res.status(404).json({ error: 'No such design.' });

  // The editor needs the public shape — colourway image URLs and the canvas
  // size live there, not on the stored row.
  const shirt = db.find('shirtTypes', design.shirtTypeId);
  res.json({ ...design, shirt: shirt ? publicShirt(shirt) : null });
});

designsRouter.post('/', (req, res) => {
  const shirt = db.find('shirtTypes', req.body?.shirtTypeId);
  if (!shirt) return res.status(400).json({ error: 'Pick a shirt type that exists.' });

  const now = new Date().toISOString();
  const { colorwayId, colorHex } = resolveColorway(shirt, req.body.colorwayId, req.body.colorHex);

  const design = db.insert('designs', {
    id: newId('design'),
    name: String(req.body.name ?? '').trim() || 'Untitled design',
    shirtTypeId: shirt.id,
    colorwayId,
    colorHex,
    views: sanitizeViews(req.body.views, shirt),
    createdAt: now,
    updatedAt: now,
  });

  res.status(201).json(design);
});

designsRouter.put('/:id', (req, res) => {
  const design = db.find('designs', req.params.id);
  if (!design) return res.status(404).json({ error: 'No such design.' });

  const shirt = db.find('shirtTypes', req.body?.shirtTypeId ?? design.shirtTypeId);
  if (!shirt) return res.status(400).json({ error: 'Pick a shirt type that exists.' });

  const { colorwayId, colorHex } = resolveColorway(
    shirt,
    req.body.colorwayId ?? design.colorwayId,
    req.body.colorHex ?? design.colorHex,
  );

  const updated = db.update('designs', design.id, {
    name: String(req.body.name ?? design.name).trim() || 'Untitled design',
    shirtTypeId: shirt.id,
    colorwayId,
    colorHex,
    views: req.body.views ? sanitizeViews(req.body.views, shirt) : design.views,
  });

  res.json(updated);
});

designsRouter.post('/:id/duplicate', (req, res) => {
  const design = db.find('designs', req.params.id);
  if (!design) return res.status(404).json({ error: 'No such design.' });

  const now = new Date().toISOString();
  const copy = db.insert('designs', {
    ...structuredClone(design),
    id: newId('design'),
    name: `${design.name} copy`,
    createdAt: now,
    updatedAt: now,
  });

  res.status(201).json(copy);
});

designsRouter.delete('/:id', (req, res) => {
  const design = db.find('designs', req.params.id);
  if (!design) return res.status(404).json({ error: 'No such design.' });
  db.remove('designs', design.id);
  res.json({ deleted: design.id });
});

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bounded(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export { sanitizeViews };
