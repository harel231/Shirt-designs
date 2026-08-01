import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { decode, encodePng, letterbox } from '../lib/image.js';
import { newId } from '../lib/ids.js';
import { SHIRTS_DIR } from '../lib/paths.js';
import { db } from '../lib/store.js';
import { normalizeHex } from '../lib/text.js';
import { CANVAS, GARMENT_SHAPES, renderGarment } from '../templates/garments.js';

/**
 * T-Shirt Design Hub — the catalog side.
 *
 * A shirt type is either `template` (a generated silhouette that can be tinted
 * to any colour on demand) or `photo` (a real garment the user added, with an
 * uploaded front and back image per colourway). Both expose the same shape to
 * the app, so the design canvas does not care which it is dealing with.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 2 },
});

export const shirtsRouter = Router();

export function publicShirt(shirt) {
  return {
    ...shirt,
    canvas: CANVAS,
    colorways: shirt.colorways.map((colorway) => ({
      id: colorway.id,
      name: colorway.name,
      hex: colorway.hex,
      source: colorway.source,
      frontUrl: viewUrl(shirt, colorway, 'front'),
      backUrl: viewUrl(shirt, colorway, 'back'),
    })),
  };
}

function viewUrl(shirt, colorway, view) {
  if (colorway.source === 'photo') {
    return colorway.views?.[view]
      ? `/api/shirts/${shirt.id}/colorways/${colorway.id}/${view}.png`
      : null;
  }
  return `/api/shirts/${shirt.id}/render?view=${view}&color=${encodeURIComponent(colorway.hex)}`;
}

shirtsRouter.get('/', (req, res) => {
  const items = db
    .all('shirtTypes')
    .sort((a, b) => Number(b.builtIn === false) - Number(a.builtIn === false) || a.name.localeCompare(b.name))
    .map(publicShirt);
  res.json({ items, shapes: GARMENT_SHAPES });
});

shirtsRouter.get('/:id', (req, res) => {
  const shirt = db.find('shirtTypes', req.params.id);
  if (!shirt) return res.status(404).json({ error: 'No such shirt type.' });
  res.json(publicShirt(shirt));
});

/** Tinted garment artwork. Colour is a query param, so any hex works. */
shirtsRouter.get('/:id/render', (req, res) => {
  const shirt = db.find('shirtTypes', req.params.id);
  if (!shirt) return res.status(404).json({ error: 'No such shirt type.' });
  if (shirt.source === 'photo') {
    return res.status(400).json({ error: 'This shirt uses photographs; request a colourway image.' });
  }

  const view = req.query.view === 'back' ? 'back' : 'front';
  const color = normalizeHex(req.query.color) ?? '#f4f4f5';
  const svg = renderGarment(shirt.shape, {
    view,
    color,
    printArea: req.query.guide === 'true',
    area: shirt.printAreas[view],
  });

  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

shirtsRouter.get('/:id/colorways/:colorwayId/:view.png', async (req, res, next) => {
  try {
    const shirt = db.find('shirtTypes', req.params.id);
    const colorway = shirt?.colorways.find((row) => row.id === req.params.colorwayId);
    const file = colorway?.views?.[req.params.view];
    if (!file) return res.status(404).json({ error: 'No image for that colourway view.' });

    res.type('image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(await readFile(join(SHIRTS_DIR, file)));
  } catch (err) {
    next(err);
  }
});

/**
 * Adds a shirt type. Two ways in:
 *  - `shape` — reuse a built-in silhouette (recolourable, no photos needed);
 *  - front/back image uploads — a real garment photographed by the user.
 */
shirtsRouter.post('/', upload.fields([{ name: 'front' }, { name: 'back' }]), async (req, res, next) => {
  try {
    const name = String(req.body.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Give the shirt type a name.' });

    const front = req.files?.front?.[0];
    const back = req.files?.back?.[0];
    const usesPhotos = Boolean(front);

    if (!usesPhotos && !GARMENT_SHAPES.includes(req.body.shape)) {
      return res.status(400).json({
        error: `Upload a front photo, or pick a base shape (${GARMENT_SHAPES.join(', ')}).`,
      });
    }

    const id = newId('shirt');
    const printAreas = parsePrintAreas(req.body.printAreas);

    let colorways;
    if (usesPhotos) {
      const colorwayId = newId('color');
      const views = {};
      views.front = await storeShirtImage(id, colorwayId, 'front', front.buffer);
      if (back) views.back = await storeShirtImage(id, colorwayId, 'back', back.buffer);

      colorways = [
        {
          id: colorwayId,
          name: String(req.body.colorName ?? '').trim() || 'As photographed',
          hex: normalizeHex(req.body.colorHex) ?? '#cccccc',
          source: 'photo',
          views,
        },
      ];
    } else {
      colorways = parseColorways(req.body.colorways);
    }

    const now = new Date().toISOString();
    const shirt = db.insert('shirtTypes', {
      id,
      name,
      brand: String(req.body.brand ?? '').trim(),
      category: String(req.body.category ?? '').trim() || 'Custom',
      source: usesPhotos ? 'photo' : 'template',
      shape: usesPhotos ? null : req.body.shape,
      builtIn: false,
      printAreas,
      colorways,
      notes: String(req.body.notes ?? '').trim(),
      createdAt: now,
      updatedAt: now,
    });

    res.status(201).json(publicShirt(shirt));
  } catch (err) {
    next(err);
  }
});

shirtsRouter.patch('/:id', (req, res) => {
  const shirt = db.find('shirtTypes', req.params.id);
  if (!shirt) return res.status(404).json({ error: 'No such shirt type.' });
  if (shirt.builtIn && req.body.printAreas === undefined && req.body.name === undefined) {
    return res.status(400).json({ error: 'Nothing to change.' });
  }

  const patch = {};
  for (const field of ['name', 'brand', 'category', 'notes']) {
    if (typeof req.body[field] === 'string') patch[field] = req.body[field].trim();
  }
  if (req.body.printAreas) patch.printAreas = parsePrintAreas(req.body.printAreas, shirt.printAreas);

  res.json(publicShirt(db.update('shirtTypes', shirt.id, patch)));
});

/** Adds a colourway: a hex tint for template shirts, or photos for real ones. */
shirtsRouter.post(
  '/:id/colorways',
  upload.fields([{ name: 'front' }, { name: 'back' }]),
  async (req, res, next) => {
    try {
      const shirt = db.find('shirtTypes', req.params.id);
      if (!shirt) return res.status(404).json({ error: 'No such shirt type.' });

      const name = String(req.body.name ?? '').trim();
      if (!name) return res.status(400).json({ error: 'Give the colour a name.' });

      const colorwayId = newId('color');
      const front = req.files?.front?.[0];
      const colorway = {
        id: colorwayId,
        name,
        hex: normalizeHex(req.body.hex) ?? '#cccccc',
        source: front ? 'photo' : 'template',
      };

      if (front) {
        colorway.views = { front: await storeShirtImage(shirt.id, colorwayId, 'front', front.buffer) };
        const back = req.files?.back?.[0];
        if (back) colorway.views.back = await storeShirtImage(shirt.id, colorwayId, 'back', back.buffer);
      } else if (shirt.source === 'photo') {
        return res.status(400).json({
          error: 'This shirt type is photo-based, so a new colour needs its own front photo.',
        });
      }

      const updated = db.update('shirtTypes', shirt.id, {
        colorways: [...shirt.colorways, colorway],
      });
      res.status(201).json(publicShirt(updated));
    } catch (err) {
      next(err);
    }
  },
);

shirtsRouter.delete('/:id/colorways/:colorwayId', async (req, res, next) => {
  try {
    const shirt = db.find('shirtTypes', req.params.id);
    if (!shirt) return res.status(404).json({ error: 'No such shirt type.' });
    if (shirt.colorways.length <= 1) {
      return res.status(409).json({ error: 'A shirt type needs at least one colour.' });
    }

    const colorway = shirt.colorways.find((row) => row.id === req.params.colorwayId);
    if (!colorway) return res.status(404).json({ error: 'No such colourway.' });

    db.update('shirtTypes', shirt.id, {
      colorways: shirt.colorways.filter((row) => row.id !== colorway.id),
    });
    for (const file of Object.values(colorway.views ?? {})) {
      await unlink(join(SHIRTS_DIR, file)).catch(() => {});
    }

    res.json({ deleted: colorway.id });
  } catch (err) {
    next(err);
  }
});

shirtsRouter.delete('/:id', async (req, res, next) => {
  try {
    const shirt = db.find('shirtTypes', req.params.id);
    if (!shirt) return res.status(404).json({ error: 'No such shirt type.' });

    const designs = db.all('designs').filter((design) => design.shirtTypeId === shirt.id);
    if (designs.length > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        error: 'Designs still use this shirt type.',
        usedBy: designs.map((design) => ({ id: design.id, name: design.name })),
      });
    }

    db.remove('shirtTypes', shirt.id);
    for (const colorway of shirt.colorways) {
      for (const file of Object.values(colorway.views ?? {})) {
        await unlink(join(SHIRTS_DIR, file)).catch(() => {});
      }
    }

    res.json({ deleted: shirt.id });
  } catch (err) {
    next(err);
  }
});

async function storeShirtImage(shirtId, colorwayId, view, buffer) {
  // Every garment photo is letterboxed onto the shared canvas so print areas,
  // which are stored in canvas coordinates, land in the same place whatever
  // aspect ratio the phone's camera produced.
  const image = letterbox(decode(buffer), CANVAS);
  const file = `${shirtId}-${colorwayId}-${view}.png`;
  await writeFile(join(SHIRTS_DIR, file), encodePng(image));
  return file;
}

const DEFAULT_AREA = {
  front: { x: 307, y: 366, width: 386, height: 515, widthIn: 12, heightIn: 16 },
  back: { x: 307, y: 336, width: 386, height: 515, widthIn: 12, heightIn: 16 },
};

function parsePrintAreas(raw, fallback = DEFAULT_AREA) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return structuredClone(fallback);

  const areas = {};
  for (const view of ['front', 'back']) {
    const source = parsed[view] ?? fallback[view];
    areas[view] = {
      x: clampNumber(source.x, 0, CANVAS.width, fallback[view].x),
      y: clampNumber(source.y, 0, CANVAS.height, fallback[view].y),
      width: clampNumber(source.width, 10, CANVAS.width, fallback[view].width),
      height: clampNumber(source.height, 10, CANVAS.height, fallback[view].height),
      widthIn: clampNumber(source.widthIn, 0.5, 30, fallback[view].widthIn),
      heightIn: clampNumber(source.heightIn, 0.5, 40, fallback[view].heightIn),
    };
  }
  return areas;
}

function parseColorways(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  const rows = Array.isArray(parsed) ? parsed : [];
  const colorways = rows
    .map((row) => ({
      id: newId('color'),
      name: String(row?.name ?? '').trim() || 'Colour',
      hex: normalizeHex(row?.hex),
      source: 'template',
    }))
    .filter((row) => row.hex);

  return colorways.length > 0
    ? colorways
    : [{ id: newId('color'), name: 'White', hex: '#ffffff', source: 'template' }];
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
