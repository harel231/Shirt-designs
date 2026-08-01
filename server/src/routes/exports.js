import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import { newId, newShareToken } from '../lib/ids.js';
import { EXPORTS_DIR, SHIRTS_DIR } from '../lib/paths.js';
import { buildArtworkPdf, buildMockupPdf, collectWarnings } from '../lib/pdf.js';
import { db } from '../lib/store.js';
import { loadAssetForRender } from './assets.js';

/**
 * Export = the handoff to the print vendor.
 *
 * One export writes a folder containing the mockup, the production artwork
 * file, the raw vector sources and a machine-readable spec, then publishes it
 * at an unguessable share URL that can be emailed straight to the printer.
 */

export const exportsRouter = Router();

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${req.get('host')}`;
}

function exportDir(exportId) {
  return join(EXPORTS_DIR, exportId);
}

/** Pulls together everything an export needs, resolving assets from disk once. */
async function gatherContext(design) {
  const shirt = db.find('shirtTypes', design.shirtTypeId);
  if (!shirt) {
    throw Object.assign(new Error('The shirt type for this design no longer exists.'), { status: 409 });
  }

  const colorway =
    shirt.colorways.find((row) => row.id === design.colorwayId) ?? shirt.colorways[0] ?? null;

  const color = {
    name: colorway?.name ?? 'Custom',
    hex: design.colorHex ?? colorway?.hex ?? '#ffffff',
    views: {},
  };

  if (shirt.source === 'photo' && colorway?.views) {
    for (const [view, file] of Object.entries(colorway.views)) {
      color.views[view] = await readFile(join(SHIRTS_DIR, file));
    }
  }

  const ids = new Set();
  for (const view of ['front', 'back']) {
    for (const layer of design.views[view]?.layers ?? []) ids.add(layer.assetId);
  }

  const assets = new Map();
  for (const id of ids) {
    const asset = db.find('assets', id);
    if (asset) assets.set(id, await loadAssetForRender(asset));
  }

  const resolveAsset = (id) => assets.get(id);
  return {
    shirt,
    color,
    colorway,
    assets,
    resolveAsset,
    warnings: collectWarnings(design, resolveAsset, shirt.printAreas),
  };
}

/** The vendor-facing job sheet: sizes, placements and ink colours. */
function buildSpec(design, ctx) {
  const views = ['front', 'back'].map((view) => {
    const area = ctx.shirt.printAreas[view];
    const layers = (design.views[view]?.layers ?? []).filter((layer) => layer.visible !== false);

    return {
      view,
      printArea: { widthIn: area.widthIn, heightIn: area.heightIn },
      artwork: layers.map((layer) => {
        const asset = ctx.resolveAsset(layer.assetId);
        return {
          name: asset?.name ?? 'Missing artwork',
          kind: asset?.kind ?? 'unknown',
          source: asset?.source,
          widthIn: round(layer.width),
          heightIn: round(layer.height),
          fromTopLeftIn: { x: round(layer.x), y: round(layer.y) },
          rotationDeg: round(layer.rotation),
          inkColors: asset?.palette?.map((entry) => entry.color) ?? null,
          effectiveDpi:
            asset?.kind === 'raster'
              ? Math.round(Math.min(asset.width / layer.width, asset.height / layer.height))
              : null,
          text: asset?.text ?? null,
        };
      }),
    };
  });

  const inks = new Set();
  for (const view of views) {
    for (const art of view.artwork) for (const ink of art.inkColors ?? []) inks.add(ink);
  }

  return {
    design: { id: design.id, name: design.name },
    garment: {
      type: ctx.shirt.name,
      brand: ctx.shirt.brand || null,
      category: ctx.shirt.category,
      color: { name: ctx.color.name, hex: ctx.color.hex },
    },
    views,
    distinctInkColors: [...inks],
    hasRasterArtwork: views.some((view) => view.artwork.some((art) => art.kind === 'raster')),
    warnings: ctx.warnings,
    generatedAt: new Date().toISOString(),
  };
}

exportsRouter.post('/designs/:id/export', async (req, res, next) => {
  try {
    const design = db.find('designs', req.params.id);
    if (!design) return res.status(404).json({ error: 'No such design.' });

    const ctx = await gatherContext(design);
    const total = ['front', 'back'].reduce(
      (sum, view) => sum + (design.views[view]?.layers ?? []).length,
      0,
    );
    if (total === 0) {
      return res.status(400).json({ error: 'Add some artwork to the design before exporting.' });
    }

    const exportId = newId('export');
    const dir = exportDir(exportId);
    await mkdir(join(dir, 'vectors'), { recursive: true });

    const [mockup, artwork] = await Promise.all([
      buildMockupPdf(design, ctx),
      buildArtworkPdf(design, ctx),
    ]);

    const slug = slugify(design.name);
    const files = [];

    await writeFile(join(dir, `${slug}-mockup.pdf`), mockup);
    files.push({
      name: `${slug}-mockup.pdf`,
      type: 'application/pdf',
      role: 'mockup',
      description: 'Front and back views of the finished garment, with placement measurements.',
    });

    await writeFile(join(dir, `${slug}-artwork.pdf`), artwork.buffer);
    files.push({
      name: `${slug}-artwork.pdf`,
      type: 'application/pdf',
      role: 'artwork',
      description: `Production file. Each page is the print area at true size (${artwork.pages
        .map((page) => `${page.view} ${page.widthIn}x${page.heightIn}in`)
        .join(', ')}). Output at 100%, no scaling.`,
    });

    // Raw vector sources alongside the PDF — many shops prefer to open the SVG.
    for (const asset of ctx.assets.values()) {
      if (asset.kind !== 'vector') continue;
      const name = `vectors/${slugify(asset.name)}-${asset.id}.svg`;
      await writeFile(join(dir, name), asset.svg, 'utf8');
      files.push({
        name,
        type: 'image/svg+xml',
        role: 'vector-source',
        description: `Editable vector source for "${asset.name}".`,
      });
    }

    const spec = buildSpec(design, ctx);
    await writeFile(join(dir, 'print-spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
    files.push({
      name: 'print-spec.json',
      type: 'application/json',
      role: 'spec',
      description: 'Machine-readable job details: garment, colour, sizes, placements, ink colours.',
    });

    for (const file of files) {
      file.bytes = (await stat(join(dir, file.name))).size;
    }

    const token = newShareToken();
    const record = db.insert('exports', {
      id: exportId,
      designId: design.id,
      token,
      name: design.name,
      files,
      spec,
      warnings: ctx.warnings,
      createdAt: new Date().toISOString(),
    });

    const base = publicBaseUrl(req);
    res.status(201).json({
      ...record,
      shareUrl: `${base}/share/${token}`,
      files: files.map((file) => ({ ...file, url: `${base}/share/${token}/files/${file.name}` })),
    });
  } catch (err) {
    next(err);
  }
});

exportsRouter.get('/exports', (req, res) => {
  const base = publicBaseUrl(req);
  const items = db
    .all('exports')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((record) => ({
      id: record.id,
      designId: record.designId,
      name: record.name,
      createdAt: record.createdAt,
      fileCount: record.files.length,
      warnings: record.warnings,
      shareUrl: `${base}/share/${record.token}`,
    }));
  res.json({ items });
});

exportsRouter.delete('/exports/:id', async (req, res, next) => {
  try {
    const record = db.find('exports', req.params.id);
    if (!record) return res.status(404).json({ error: 'No such export.' });
    db.remove('exports', record.id);
    await rm(exportDir(record.id), { recursive: true, force: true });
    res.json({ deleted: record.id, revoked: true });
  } catch (err) {
    next(err);
  }
});

export { buildSpec, gatherContext, exportDir, publicBaseUrl, slugify };

function slugify(value) {
  return (
    String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'design'
  );
}

function round(value) {
  return Number.parseFloat(Number(value ?? 0).toFixed(3));
}
