import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Router } from 'express';
import { db } from '../lib/store.js';
import { exportDir, publicBaseUrl, slugify } from './exports.js';

const require = createRequire(import.meta.url);
const archiver = require('archiver');

/**
 * The shareable folder.
 *
 * A print vendor gets one link, opens it in any browser, and finds the mockup,
 * the production artwork and the job spec — no account, no app. The link is an
 * unguessable token and can be revoked by deleting the export.
 */

export const shareRouter = Router();

function findByToken(token) {
  return db.findBy('exports', (record) => record.token === token);
}

shareRouter.get('/:token', (req, res) => {
  const record = findByToken(req.params.token);
  if (!record) return res.status(404).type('html').send(notFoundPage());

  res.type('html').send(folderPage(record, publicBaseUrl(req)));
});

/** JSON view of the same folder, for anyone wiring it into their own system. */
shareRouter.get('/:token/index.json', (req, res) => {
  const record = findByToken(req.params.token);
  if (!record) return res.status(404).json({ error: 'This share link is not valid.' });

  const base = publicBaseUrl(req);
  res.json({
    name: record.name,
    createdAt: record.createdAt,
    spec: record.spec,
    files: record.files.map((file) => ({
      ...file,
      url: `${base}/share/${record.token}/files/${file.name}`,
    })),
  });
});

/**
 * Everything in the folder as one .zip. This is the one-tap "get it onto my
 * phone" path: a phone's share sheet naturally offers "Save to Files" for a
 * single downloaded archive in a way it never quite does for a page full of
 * separate links.
 */
shareRouter.get('/:token/download.zip', async (req, res, next) => {
  const record = findByToken(req.params.token);
  if (!record) return res.status(404).json({ error: 'This share link is not valid.' });

  try {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.type('application/zip');
    res.set('Content-Disposition', `attachment; filename="${slugify(record.name)}-print-files.zip"`);

    archive.on('error', next);
    archive.pipe(res);

    const dir = exportDir(record.id);
    for (const file of record.files) {
      archive.file(join(dir, file.name), { name: file.name });
    }

    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

shareRouter.get('/:token/files/*name', async (req, res, next) => {
  try {
    const record = findByToken(req.params.token);
    if (!record) return res.status(404).json({ error: 'This share link is not valid.' });

    const requested = Array.isArray(req.params.name) ? req.params.name.join('/') : req.params.name;
    // Only names this export actually published are servable, which rules out
    // path traversal by construction.
    const file = record.files.find((row) => row.name === requested);
    if (!file) return res.status(404).json({ error: 'No such file in this folder.' });

    const path = join(exportDir(record.id), file.name);
    const info = await stat(path);

    res.type(file.type);
    res.set('Content-Length', String(info.size));
    res.set(
      'Content-Disposition',
      `${req.query.download === 'true' ? 'attachment' : 'inline'}; filename="${file.name.split('/').pop()}"`,
    );
    createReadStream(path).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(410).json({ error: 'This file has been removed.' });
    next(err);
  }
});

function folderPage(record, base) {
  const spec = record.spec ?? {};
  const garment = spec.garment ?? {};
  const link = `${base}/share/${record.token}`;

  const fileRows = record.files
    .map(
      (file) => `<li class="file">
  <div class="file-main">
    <a href="${link}/files/${encodeURI(file.name)}">${escapeHtml(file.name)}</a>
    <span class="badge badge-${escapeHtml(file.role)}">${escapeHtml(file.role.replace('-', ' '))}</span>
  </div>
  <p>${escapeHtml(file.description)}</p>
  <div class="file-meta">
    ${formatBytes(file.bytes)}
    <a class="dl" href="${link}/files/${encodeURI(file.name)}?download=true">Download</a>
  </div>
</li>`,
    )
    .join('');

  const viewRows = (spec.views ?? [])
    .filter((view) => view.artwork.length > 0)
    .map(
      (view) => `<section class="view">
  <h3>${escapeHtml(view.view)} &middot; print area ${view.printArea.widthIn}&Prime; &times; ${view.printArea.heightIn}&Prime;</h3>
  <table>
    <thead><tr><th>Artwork</th><th>Size</th><th>Position</th><th>Type</th></tr></thead>
    <tbody>
    ${view.artwork
      .map(
        (art) => `<tr>
      <td>${escapeHtml(art.name)}</td>
      <td>${art.widthIn}&Prime; &times; ${art.heightIn}&Prime;</td>
      <td>${art.fromTopLeftIn.x}&Prime;, ${art.fromTopLeftIn.y}&Prime; from top-left${art.rotationDeg ? ` &middot; ${art.rotationDeg}&deg;` : ''}</td>
      <td>${escapeHtml(art.kind)}${art.effectiveDpi ? ` &middot; ${art.effectiveDpi} DPI` : ''}</td>
    </tr>`,
      )
      .join('')}
    </tbody>
  </table>
</section>`,
    )
    .join('');

  const inks = spec.distinctInkColors ?? [];
  const inkRow = inks.length
    ? `<div class="inks"><span>${inks.length} ink colour${inks.length === 1 ? '' : 's'}</span>${inks
        .map((ink) => `<i style="background:${escapeHtml(ink)}" title="${escapeHtml(ink)}"></i>`)
        .join('')}</div>`
    : '';

  const warnings = (record.warnings ?? []).length
    ? `<div class="warn"><strong>Check before printing</strong><ul>${record.warnings
        .map((warning) => `<li>${escapeHtml(warning.view)}: ${escapeHtml(warning.message)}</li>`)
        .join('')}</ul></div>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(record.name)} — print files</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f8; --card:#ffffff; --ink:#15161a; --muted:#6b6f76; --line:#e3e4e8; --accent:#2f6df6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#111216; --card:#1a1c21; --ink:#f2f3f5; --muted:#9aa0a8; --line:#2a2d33; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  header h1 { margin:0 0 6px; font-size: 26px; letter-spacing:-0.01em; }
  header p { margin:0; color: var(--muted); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; margin-top:20px; }
  .spec { display:grid; grid-template-columns: repeat(auto-fit,minmax(150px,1fr)); gap:14px; }
  .spec div span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .spec div strong { font-weight:600; }
  .swatch { display:inline-block; width:13px; height:13px; border-radius:3px; border:1px solid var(--line); vertical-align:-2px; margin-right:6px; }
  ul.files { list-style:none; margin:0; padding:0; }
  li.file { padding:14px 0; border-bottom:1px solid var(--line); }
  li.file:last-child { border-bottom:0; padding-bottom:0; }
  .file-main { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .file-main a { color:var(--accent); font-weight:600; text-decoration:none; word-break:break-all; }
  li.file p { margin:4px 0 8px; color:var(--muted); font-size:13.5px; }
  .file-meta { display:flex; gap:14px; align-items:center; color:var(--muted); font-size:12.5px; }
  .dl { color:var(--ink); text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:3px 12px; }
  .badge { font-size:11px; text-transform:uppercase; letter-spacing:.05em; padding:2px 8px; border-radius:999px; background:var(--bg); border:1px solid var(--line); color:var(--muted); }
  .badge-artwork { border-color:var(--accent); color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th { text-align:left; color:var(--muted); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.05em; padding-bottom:6px; }
  td { padding:7px 0; border-top:1px solid var(--line); vertical-align:top; }
  .view h3 { font-size:14px; text-transform:capitalize; margin:18px 0 6px; }
  .view:first-of-type h3 { margin-top:0; }
  .inks { display:flex; align-items:center; gap:6px; margin-top:14px; color:var(--muted); font-size:13px; }
  .inks i { width:18px; height:18px; border-radius:5px; border:1px solid var(--line); }
  .warn { margin-top:20px; border:1px solid #e0b400; background:#fff8e0; color:#5c4300; border-radius:12px; padding:14px 18px; }
  @media (prefers-color-scheme: dark) { .warn { background:#2c2404; color:#f0d98a; } }
  .warn ul { margin:6px 0 0; padding-left:18px; }
  footer { margin-top:28px; color:var(--muted); font-size:12.5px; }
  .back-link { display:inline-flex; align-items:center; gap:6px; color:var(--muted); text-decoration:none; font-size:13px; margin-bottom:14px; }
  .zip-btn { display:inline-flex; align-items:center; gap:8px; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; padding:11px 18px; border-radius:999px; font-size:14.5px; }
</style>
</head>
<body>
<div class="wrap">
  <a class="back-link" href="/">&larr; Back to the studio</a>
  <header>
    <h1>${escapeHtml(record.name)}</h1>
    <p>Print-ready files &middot; prepared ${escapeHtml(formatDate(record.createdAt))}</p>
  </header>

  <div class="card">
    <div class="spec">
      <div><span>Garment</span><strong>${escapeHtml(garment.type ?? '—')}</strong></div>
      ${garment.brand ? `<div><span>Brand</span><strong>${escapeHtml(garment.brand)}</strong></div>` : ''}
      <div><span>Colour</span><strong><i class="swatch" style="background:${escapeHtml(garment.color?.hex ?? '#fff')}"></i>${escapeHtml(garment.color?.name ?? '—')} ${escapeHtml(garment.color?.hex ?? '')}</strong></div>
    </div>
    ${inkRow}
    <a class="zip-btn" style="margin-top:16px" href="${link}/download.zip">&#8595; Download everything (.zip)</a>
  </div>

  ${viewRows ? `<div class="card">${viewRows}</div>` : ''}
  ${warnings}

  <div class="card">
    <ul class="files">${fileRows}</ul>
  </div>

  <footer>
    Anyone with this link can view and download these files.
    A JSON version of this folder is at <a href="${link}/index.json">index.json</a>.
  </footer>
</div>
</body>
</html>`;
}

function notFoundPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link not found</title>
<style>body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#15161a;background:#f6f6f8}div{text-align:center;padding:24px}</style>
</head><body><div><h1>This link is not available</h1><p>The share folder may have been revoked, or the address is mistyped.</p></div></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
