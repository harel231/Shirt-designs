import { Router } from 'express';
import { loadCatalog, searchFonts } from '../lib/fonts.js';
import { textToVector } from '../lib/text.js';

/**
 * Google Fonts for the text tool.
 *
 * Previews are returned as SVG outlines rather than font files: the phone then
 * shows exactly the shapes that will be printed, and no font has to be
 * installed on the device for a family to be usable.
 */

export const fontsRouter = Router();

fontsRouter.get('/', (req, res) => {
  const catalog = loadCatalog();
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const result = searchFonts({
    query: String(req.query.q ?? ''),
    category: String(req.query.category ?? ''),
    subset: String(req.query.subset ?? ''),
    limit,
    offset,
  });

  res.json({
    ...result,
    limit,
    offset,
    catalog: { source: catalog.source, generatedAt: catalog.generatedAt, size: catalog.families.length },
  });
});

fontsRouter.get('/categories', (req, res) => {
  const { families } = loadCatalog();
  const categories = new Map();
  const subsets = new Map();

  for (const font of families) {
    categories.set(font.category, (categories.get(font.category) ?? 0) + 1);
    for (const subset of font.subsets) subsets.set(subset, (subsets.get(subset) ?? 0) + 1);
  }

  const toSorted = (map) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));

  res.json({ categories: toSorted(categories), subsets: toSorted(subsets) });
});

/**
 * Renders sample text in a family as vector outlines. Used for the font picker
 * and for the live preview while a text layer is being edited.
 */
fontsRouter.get('/:family/sample.svg', async (req, res, next) => {
  try {
    const result = await textToVector({
      text: String(req.query.text ?? req.params.family),
      family: req.params.family,
      weight: Number(req.query.weight) || 400,
      italic: req.query.italic === 'true',
      size: Math.min(400, Math.max(8, Number(req.query.size) || 64)),
      color: req.query.color ?? '#111111',
      arc: Number(req.query.arc) || 0,
      letterSpacing: Number(req.query.letterSpacing) || 0,
      align: req.query.align ?? 'center',
    });

    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(result.svg);
  } catch (err) {
    next(err);
  }
});

/** Same as the sample, but returns metrics too — handy for sizing a new layer. */
fontsRouter.post('/preview', async (req, res, next) => {
  try {
    const result = await textToVector(req.body ?? {});
    res.json({
      svg: result.svg,
      width: result.width,
      height: result.height,
      font: result.font,
      glyphCount: result.glyphCount,
      lineCount: result.lineCount,
    });
  } catch (err) {
    next(err);
  }
});
