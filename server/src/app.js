import cors from 'cors';
import express from 'express';
import { loadCatalog } from './lib/fonts.js';
import { ensureStorage } from './lib/paths.js';
import { seedShirtCatalog } from './lib/seed.js';
import { assetsRouter } from './routes/assets.js';
import { designsRouter } from './routes/designs.js';
import { exportsRouter } from './routes/exports.js';
import { fontsRouter } from './routes/fonts.js';
import { shareRouter } from './routes/share.js';
import { shirtsRouter } from './routes/shirts.js';

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

  app.use((req, res) => {
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
