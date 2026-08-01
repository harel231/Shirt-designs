import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import cors from 'cors';
import express from 'express';
import { loadCatalog } from './lib/fonts.js';
import { ensureStorage, SERVER_ROOT } from './lib/paths.js';
import { seedShirtCatalog } from './lib/seed.js';
import { assetsRouter } from './routes/assets.js';
import { designsRouter } from './routes/designs.js';
import { exportsRouter } from './routes/exports.js';
import { fontsRouter } from './routes/fonts.js';
import { shareRouter } from './routes/share.js';
import { shirtsRouter } from './routes/shirts.js';

const require = createRequire(import.meta.url);

/**
 * pdf.js, served to the browser as plain modules.
 *
 * PDF artwork is the one asset kind the server cannot draw a preview of — see
 * lib/pdfvector.js — so the app renders it on the device instead. Shipping the
 * library from node_modules keeps the web app buildless and the version
 * pinned in the lockfile rather than vendored into the repo.
 */
const PDFJS_ROOT = dirname(require.resolve('pdfjs-dist/package.json'));

export function createApp() {
  ensureStorage();
  seedShirtCatalog();

  const app = express();
  // The mobile app runs on a device and talks to this over the LAN, so it is
  // always cross-origin.
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => {
    const catalog = loadCatalog();
    res.json({
      ok: true,
      version: 1,
      fonts: { families: catalog.families.length, source: catalog.source },
    });
  });

  app.use('/api/assets', assetsRouter);
  app.use('/api/shirts', shirtsRouter);
  app.use('/api/designs', designsRouter);
  app.use('/api/fonts', fontsRouter);
  app.use('/api', exportsRouter);
  app.use('/share', shareRouter);

  // Versioned by the lockfile and immutable once installed, so it can be
  // cached hard: the worker and the font data are the largest things the app
  // ever downloads.
  app.use(
    '/vendor/pdfjs',
    express.static(PDFJS_ROOT, { immutable: true, maxAge: '1y', index: false }),
  );

  // The studio itself: a mobile web app served from the same origin, so a phone
  // only needs the one URL and there is no cross-origin setup to get wrong.
  const webRoot = join(SERVER_ROOT, '..', 'web');
  app.use(
    express.static(webRoot, {
      // index.html is the app shell and changes with every release; the rest is
      // content-addressed enough to cache for a session.
      setHeaders: (res, path) => {
        if (path.endsWith('index.html')) res.set('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.includes('.')) {
      return res.sendFile(join(webRoot, 'index.html'));
    }
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error
  // handlers by arity, so `next` has to stay in the signature.
  app.use((err, req, res, next) => {
    const status = err.status ?? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: status >= 500 ? 'Something went wrong on the server.' : err.message,
    });
  });

  return app;
}
