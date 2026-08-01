import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { removeBackground, toHex } from '../lib/background.js';
import { alphaBounds, crop, decode, encodePng, fit } from '../lib/image.js';
import { newId } from '../lib/ids.js';
import { ASSETS_DIR } from '../lib/paths.js';
import { isPdf, placeholderSvg, readPdfPageSize } from '../lib/pdfvector.js';
import { db } from '../lib/store.js';
import { normalizeHex, textToVector } from '../lib/text.js';
import { recolorSvg, traceToSvg } from '../lib/vector.js';

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
  const { file, sourceFile, ...rest } = asset;
  return {
    ...rest,
    url: `/api/assets/${asset.id}/file`,
    thumbnailUrl: `/api/assets/${asset.id}/file`,
  };
}

function assetPath(asset) {
  return join(ASSETS_DIR, asset.file);
}

/** Where a PDF-vector asset's original, untouched source file lives on disk. */
function pdfSourcePath(asset) {
  return join(ASSETS_DIR, asset.sourceFile);
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

/**
 * Loads an asset's bytes in the shape the PDF writer wants. A PDF-vector
 * asset carries both: `svg` for the on-canvas placeholder, and `pdfBuffer` —
 * the real vector source — for what actually gets embedded at export time.
 */
export async function loadAssetForRender(asset) {
  const bytes = await readFile(assetPath(asset));
  if (asset.format === 'pdf') {
    return { ...asset, svg: bytes.toString('utf8'), pdfBuffer: await readFile(pdfSourcePath(asset)) };
  }
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

    if (isPdf(req.file.buffer)) {
      return res.status(201).json(await insertPdfAsset(req));
    }

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
 * A PDF upload is treated as ready-made vector art — there is nothing to trim
 * a background from or trace, it is already the print-ready source. Only a
 * placeholder is shown on the canvas (see pdfvector.js for why); the original
 * file is kept untouched on disk and embedded directly into the production
 * PDF at export time.
 */
async function insertPdfAsset(req) {
  const { width, height } = await readPdfPageSize(req.file.buffer);
  const id = newId('asset');
  const name = req.body.name?.trim() || stripExtension(req.file.originalname) || 'PDF artwork';

  const sourceFile = `${id}.pdf`;
  await writeFile(join(ASSETS_DIR, sourceFile), req.file.buffer);
  const file = await writeVector(id, placeholderSvg(width, height, req.file.originalname));

  return publicAsset(
    db.insert('assets', {
      id,
      name,
      kind: 'vector',
      format: 'pdf',
      source: 'pdf-upload',
      file,
      sourceFile,
      width,
      height,
      palette: null,
      saved: req.body.save === 'true',
      createdAt: new Date().toISOString(),
    }),
  );
}

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
      quality: req.body.quality,
      alphaThreshold: numberOr(req.body.alphaThreshold, 0.5),
    });

    if (traced.pathCount === 0) {
      return res.status(400).json({
        error: 'Nothing traced above that threshold. Try a lower cutoff, or remove the background first.',
      });
    }

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
      settings: { quality: req.body.quality ?? 'balanced' },
      saved: false,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json(publicAsset(asset));
  } catch (err) {
    next(err);
  }
});

/**
 * Recolours a traced vector. This is a fill swap, not a re-trace — trying five
 * different ink colours costs nothing but five small SVG writes.
 */
assetsRouter.post('/:id/recolor', async (req, res, next) => {
  try {
    const source = db.find('assets', req.params.id);
    if (!source) return res.status(404).json({ error: 'No such asset.' });
    if (source.kind !== 'vector' || source.source !== 'vectorized') {
      return res.status(400).json({ error: 'Only traced artwork can be recoloured this way.' });
    }

    const svg = recolorSvg(await readFile(assetPath(source), 'utf8'), req.body.color);
    const id = newId('asset');
    const file = await writeVector(id, svg);

    const asset = db.insert('assets', {
      id,
      name: source.name,
      kind: 'vector',
      source: 'vectorized',
      parentId: source.parentId ?? source.id,
      file,
      width: source.width,
      height: source.height,
      palette: [{ color: normalizeHex(req.body.color) ?? '#000000', paths: source.pathCount ?? 1 }],
      pathCount: source.pathCount,
      settings: source.settings,
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
    if (asset.sourceFile) await unlink(pdfSourcePath(asset)).catch(() => {});
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
