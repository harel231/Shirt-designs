import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { removeBackground, toHex } from '../lib/background.js';
import { alphaBounds, crop, decode, encodePng, fit } from '../lib/image.js';
import { newId } from '../lib/ids.js';
import { ASSETS_DIR } from '../lib/paths.js';
import { db } from '../lib/store.js';
import { textToVector } from '../lib/text.js';
import { traceToSvg } from '../lib/vector.js';

/**
 * Content Creation Hub.
 *
 * Uploads land in a staging state (`saved: false`) so people can experiment
 * with background removal and tracing without cluttering the design library.
 * The library only ever lists what was explicitly saved.
 */

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
// Anything larger is downsampled before processing: flood filling and tracing
// are per-pixel, and a 12-megapixel phone photo would stall the request.
const MAX_WORKING_EDGE = 2400;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

export const assetsRouter = Router();

function publicAsset(asset) {
  const { file, ...rest } = asset;
  return {
    ...rest,
    url: `/api/assets/${asset.id}/file`,
    thumbnailUrl: `/api/assets/${asset.id}/file`,
  };
}

function assetPath(asset) {
  return join(ASSETS_DIR, asset.file);
}

async function writeRaster(id, image) {
  const file = `${id}.png`;
  await writeFile(join(ASSETS_DIR, file), encodePng(image));
  return file;
}

async function writeVector(id, svg) {
  const file = `${id}.svg`;
  await writeFile(join(ASSETS_DIR, file), svg, 'utf8');
  return file;
}

/** Loads an asset's bytes in the shape the PDF writer wants. */
export async function loadAssetForRender(asset) {
  const bytes = await readFile(assetPath(asset));
  if (asset.kind === 'vector') return { ...asset, svg: bytes.toString('utf8') };
  return { ...asset, buffer: bytes };
}

assetsRouter.get('/', (req, res) => {
  const includeDrafts = req.query.include === 'drafts';
  const kind = req.query.kind;

  const items = db
    .all('assets')
    .filter((asset) => (includeDrafts ? true : asset.saved))
    .filter((asset) => (kind ? asset.kind === kind : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicAsset);

  res.json({ items });
});

assetsRouter.get('/:id', (req, res) => {
  const asset = db.find('assets', req.params.id);
  if (!asset) return res.status(404).json({ error: 'No such asset.' });
  res.json(publicAsset(asset));
});

assetsRouter.get('/:id/file', async (req, res, next) => {
  const asset = db.find('assets', req.params.id);
  if (!asset) return res.status(404).json({ error: 'No such asset.' });
  try {
    const bytes = await readFile(assetPath(asset));
    res.type(asset.kind === 'vector' ? 'image/svg+xml' : 'image/png');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(bytes);
  } catch (err) {
    next(err);
  }
});

assetsRouter.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach an image as the "image" field.' });

    const decoded = decode(req.file.buffer);
    const image = fit(decoded, MAX_WORKING_EDGE);
    const id = newId('asset');
    const file = await writeRaster(id, image);

    const asset = db.insert('assets', {
      id,
      name: req.body.name?.trim() || stripExtension(req.file.originalname) || 'Untitled',
      kind: 'raster',
      source: 'upload',
      file,
      width: image.width,
      height: image.height,
      originalWidth: decoded.width,
      originalHeight: decoded.height,
      saved: req.body.save === 'true',
      createdAt: new Date().toISOString(),
    });

    res.status(201).json(publicAsset(asset));
  } catch (err) {
    next(err);
  }
});

/**
 * Background removal. Produces a *new* asset so the original stays available
 * to re-run with a different tolerance.
 */
assetsRouter.post('/:id/remove-background', async (req, res, next) => {
  try {
    const source = db.find('assets', req.params.id);
    if (!source) return res.status(404).json({ error: 'No such asset.' });
    if (source.kind !== 'raster') {
      return res.status(400).json({ error: 'Only raster images have a background to remove.' });
    }

    const image = decode(await readFile(assetPath(source)));
    const result = removeBackground(image, {
      tolerance: numberOr(req.body.tolerance, 28),
      softness: numberOr(req.body.softness, 35),
      mode: req.body.mode,
      colors: req.body.colors,
      despill: req.body.despill,
    });

    // Trim the now-transparent margin so the artwork's own box is its bounds.
    const bounds = alphaBounds(result.image);
    const trimmed = bounds ? crop(result.image, bounds) : result.image;

    const id = newId('asset');
    const file = await writeRaster(id, trimmed);

    const asset = db.insert('assets', {
      id,
      name: `${source.name} (cut out)`,
      kind: 'raster',
      source: 'background-removed',
      parentId: source.id,
      file,
      width: trimmed.width,
      height: trimmed.height,
      hasAlpha: true,
      settings: {
        tolerance: numberOr(req.body.tolerance, 28),
        softness: numberOr(req.body.softness, 35),
        mode: req.body.mode ?? 'edges',
      },
      backgroundColors: result.backgroundColors,
      saved: false,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({
      ...publicAsset(asset),
      removedShare: Number(result.coverage.toFixed(3)),
    });
  } catch (err) {
    next(err);
  }
});

/** Samples the backdrop so the app can show which colours will be keyed out. */
assetsRouter.get('/:id/background-colors', async (req, res, next) => {
  try {
    const asset = db.find('assets', req.params.id);
    if (!asset) return res.status(404).json({ error: 'No such asset.' });
    const image = decode(await readFile(assetPath(asset)));
    const { estimateBackgroundColors } = await import('../lib/background.js');
    res.json({ colors: estimateBackgroundColors(image).map(toHex) });
  } catch (err) {
    next(err);
  }
});

/** Raster -> vector, the print-ready conversion. */
assetsRouter.post('/:id/vectorize', async (req, res, next) => {
  try {
    const source = db.find('assets', req.params.id);
    if (!source) return res.status(404).json({ error: 'No such asset.' });
    if (source.kind === 'vector') {
      return res.status(400).json({ error: 'This artwork is already vector.' });
    }

    const decoded = decode(await readFile(assetPath(source)));
    // Tracing cost grows with pixel count and the extra detail is not visible
    // in the output paths, so cap the working size.
    const image = fit(decoded, 1400);
    const traced = traceToSvg(image, {
      colors: numberOr(req.body.colors, 8),
      quality: req.body.quality,
    });

    const id = newId('asset');
    const file = await writeVector(id, traced.svg);

    const asset = db.insert('assets', {
      id,
      name: `${source.name} (vector)`,
      kind: 'vector',
      source: 'vectorized',
      parentId: source.id,
      file,
      width: traced.width,
      height: traced.height,
      palette: traced.palette,
      pathCount: traced.pathCount,
      settings: { colors: numberOr(req.body.colors, 8), quality: req.body.quality ?? 'balanced' },
      saved: false,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json(publicAsset(asset));
  } catch (err) {
    next(err);
  }
});

/** The text tool: type set in any Google Font, converted straight to outlines. */
assetsRouter.post('/text', async (req, res, next) => {
  try {
    const result = await textToVector(req.body ?? {});
    const id = newId('asset');
    const file = await writeVector(id, result.svg);

    const asset = db.insert('assets', {
      id,
      name: req.body.name?.trim() || firstLine(req.body.text),
      kind: 'vector',
      source: 'text',
      file,
      width: result.width,
      height: result.height,
      palette: [{ color: result.color, paths: 1 }],
      // Kept so the layer stays editable: the app can re-render with new
      // settings instead of forcing the user to start over.
      text: {
        text: req.body.text,
        family: result.font.family,
        weight: result.font.weight,
        italic: result.font.italic,
        size: result.font.size,
        letterSpacing: numberOr(req.body.letterSpacing, 0),
        lineHeight: numberOr(req.body.lineHeight, 1.2),
        align: req.body.align ?? 'center',
        arc: numberOr(req.body.arc, 0),
        color: result.color,
      },
      saved: req.body.save === true,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json(publicAsset(asset));
  } catch (err) {
    next(err);
  }
});

/** Explicitly add a staged asset to the design library. */
assetsRouter.post('/:id/save', (req, res) => {
  const asset = db.find('assets', req.params.id);
  if (!asset) return res.status(404).json({ error: 'No such asset.' });

  const updated = db.update('assets', asset.id, {
    saved: true,
    name: req.body?.name?.trim() || asset.name,
    tags: Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 12) : asset.tags,
  });

  res.json(publicAsset(updated));
});

assetsRouter.patch('/:id', (req, res) => {
  const asset = db.find('assets', req.params.id);
  if (!asset) return res.status(404).json({ error: 'No such asset.' });

  const patch = {};
  if (typeof req.body?.name === 'string') patch.name = req.body.name.trim();
  if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.slice(0, 12);
  res.json(publicAsset(db.update('assets', asset.id, patch)));
});

assetsRouter.delete('/:id', async (req, res, next) => {
  try {
    const asset = db.find('assets', req.params.id);
    if (!asset) return res.status(404).json({ error: 'No such asset.' });

    const usedBy = db
      .all('designs')
      .filter((design) =>
        ['front', 'back'].some((view) =>
          (design.views[view]?.layers ?? []).some((layer) => layer.assetId === asset.id),
        ),
      )
      .map((design) => ({ id: design.id, name: design.name }));

    if (usedBy.length > 0 && req.query.force !== 'true') {
      return res.status(409).json({
        error: 'This artwork is still placed on a shirt design.',
        usedBy,
      });
    }

    db.remove('assets', asset.id);
    await unlink(assetPath(asset)).catch(() => {});
    res.json({ deleted: asset.id });
  } catch (err) {
    next(err);
  }
});

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripExtension(name) {
  return String(name ?? '').replace(/\.[a-z0-9]+$/i, '');
}

function firstLine(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > 40 ? `${line.slice(0, 40)}...` : line || 'Text';
}
