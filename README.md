# Shirt Designs

An all-in-one t-shirt design studio: cut out artwork, trace it to vector, set
type in any Google Font, lay it out on a garment, and hand your printer a link
to production-ready files.

It runs as a **mobile web app** served by its own **Node print-production
server**. One command, one URL — open it on your phone and add it to the home
screen, where it behaves like an installed app.

```bash
npm install
npm start
```

The server prints the address to open. `http://localhost:4000` on the same
machine; on a phone, use the LAN address it lists (both devices on the same
Wi-Fi).

---

## What it does

### 1. Content Creation Hub

| | |
|---|---|
| **Background removal** | Edge-seeded flood fill with a soft alpha band and backdrop despill, so antialiased outlines survive instead of leaving a fringe. Tolerance and edge softness are live sliders. A colour you pick by hand is removed everywhere; a sampled backdrop is only removed where it touches the border, which keeps the holes inside an O or an A opaque. |
| **Vector conversion** | Traces a bitmap into filled paths and reports the resulting palette — that count is the number of screens a screen printer will charge you for. Ink count and detail level are adjustable. |
| **Text tool** | All **1,908 Google Fonts**, searchable offline. Weight, italic, alignment, letter spacing, line spacing and arched type. |
| **Design library** | Holds only what you explicitly save. Work in progress sits in a separate drafts shelf, so experiments never clutter the shelf you drag from. |

Text is converted to **vector outlines**, never live text. That is what a print
vendor wants: outlined type needs no font licence at the printer, cannot reflow
or substitute, and rips identically on every machine.

### 2. T-Shirt Design Hub

Eight built-in blanks — tee, v-neck, long sleeve, tank, sweatshirt, hoodie,
polo, work shirt — drawn as parametric vector silhouettes so **any hex colour**
can be produced on demand rather than stocking a photo per colourway.

You can add your own shirt types two ways:

- **from a blank** — reuse a silhouette under your own name and colours;
- **from photos** — photograph a real garment (a specific Carhartt or Saucony
  style) front and back. Photos are letterboxed onto the shared canvas so the
  imprint guide lands correctly whatever aspect ratio your camera produced.

Either way you set the **print area in real inches**, which is what determines
the size of the production file.

### 3. The design canvas

Tap a shirt, pick a colour, and lay out the front and the back:

- one finger to move, two to pinch-scale and rotate, corner handles for precise
  resize and rotate (rotation snaps to 15°);
- add graphics from your library, or add text without leaving the canvas;
- change the shirt colour at any time;
- layer ordering, hide, lock, duplicate, centre, undo;
- live readout of each item's **printed size in inches** and, for bitmaps, the
  **DPI it will actually print at**.

Layer geometry is stored in **inches relative to the print area** — not screen
pixels — so a design means the same thing on a phone, in the mockup and on
press.

### 4. Export and hand off

One export produces a folder behind an unguessable share link:

| File | What it is |
|---|---|
| `*-mockup.pdf` | Front and back views of the finished garment with the colour, the print area and placement measurements. |
| `*-artwork.pdf` | The production file. Each page **is** the print area at true physical size (a 12″ × 16″ area is an 864 × 1152 pt page), artwork only, for output at 100% with no scaling. |
| `vectors/*.svg` | Editable vector sources, which many shops prefer to open directly. |
| `print-spec.json` | Machine-readable job details: garment, colour, sizes, positions, rotations, ink colours, effective DPI. |

The link opens in any browser — no account, no app, nothing to install — and
shows the job sheet alongside the downloads. Revoke it whenever you like.

Before the files go out, the export flags what a printer would otherwise call
you about: bitmaps blown up past 150 DPI, artwork that hangs outside the
imprint area, and artwork missing from the library.

---

## Layout

```
server/                Node + Express print-production service
  src/lib/             background removal, tracing, fonts, text outlining, PDF
  src/routes/          REST API + the public share pages
  src/templates/       parametric garment artwork
  data/                bundled Google Fonts catalog (checked in)
  test/                38 tests
web/                   the mobile web app (static ES modules, no build step)
  js/screens/          create · shirts · designs · share · the canvas editor
  test/                25 tests over the coordinate maths
Dockerfile             single image serving both the API and the static app
render.yaml            Render blueprint (Docker, free plan, no disk — see below)
```

There is no bundler and no build step. The app is plain ES modules served
straight from `web/`, which is also why `npm start` is the only command you
need.

## Commands

```bash
npm start          # run the studio (server + app) on :4000
npm run dev        # same, with reload on server changes
npm test           # 63 tests across the server and the client maths
npm run fonts:sync # refresh the bundled Google Fonts catalog
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | Port to listen on. |
| `HOST` | `0.0.0.0` | Bind address — the default is what lets a phone reach it. |
| `SHIRT_DATA_DIR` | `server/data/storage` | Where uploads, exports and the database live. |
| `PUBLIC_BASE_URL` | derived from the request | Set this when running behind a tunnel or proxy so share links point somewhere your vendor can reach. |
| `GOOGLE_FONTS_API_KEY` | — | Optional. Lets `npm run fonts:sync` pull a live catalog instead of the bundled snapshot. |

State is a JSON database plus files on disk under `SHIRT_DATA_DIR`. Back that
one directory up and you have everything.

## Notes on the network

Font *browsing* is fully offline — the whole catalog ships with the server.
Font *files* are fetched from Google the first time a family is actually used
and cached on disk from then on, so a family you have used before keeps working
without a connection.

## Deploying for a public URL

This is a normal long-running Node process with a writable local disk — not
a stateless request handler. **It cannot run on Vercel, Netlify, or any other
serverless-functions platform**: those give a function a fresh, read-only
filesystem on every invocation, and this app writes uploads, exports and its
database to disk on nearly every request. It will crash on the first request
that tries to write anything (`ensureStorage()` failing to `mkdir` is the
usual first error).

Use a host that runs a real container with a persistent disk — Render,
Railway, Fly.io, or your own VPS/Docker host all work. A `Dockerfile` is
included and builds this repo as-is, with no native build dependencies (every
server package is pure JS).

### Render free tier (no card, deployable from a phone browser)

The included `render.yaml` targets Render's **free** plan on purpose:

1. Push this repo to GitHub.
2. On Render's dashboard, **New → Blueprint**, point it at the repo. No CLI,
   no local machine needed — this works from a phone browser.
3. It provisions the web service from the `Dockerfile`. No disk is attached,
   because free web services on Render cannot attach one at all — that is a
   hard platform rule, not something this blueprint could opt into.

**What that means in practice:** the app itself never crashes — a fresh
container just re-seeds the shirt catalog and starts with an empty library, the
same way it does on `npm start` the first time. But a free service spins down
after about 15 minutes with no traffic, and everything written to disk since
the last restart — uploaded artwork, custom shirt types, saved designs, past
exports — is gone when it spins back up. **Export and download anything you
want to keep** (the mockup PDF, the artwork PDF, the vector sources) before
you stop using it for a while; those files only really exist once they're on
your device, not while they're sitting in the app's temporary storage.

This is a real limitation, not a rare edge case — for a personal project used
in short sessions it will happen most times you come back. If you later want
the library itself to persist between sessions, the two ways to get that
without giving any platform a card are non-trivial: move file storage to
something like Cloudflare R2 and the JSON database to a provider with a real
permanent free tier, which needs code changes to this app's storage layer,
not just a config change. Ask if you want that built out.

### If you want it to actually persist: Render's paid plan, or your own host

Render's paid plans support attaching a real persistent disk (see git history
for a `render.yaml` with a `disk:` block), as does Railway, Fly.io, an Oracle
Cloud Always Free VM, or your own Docker host.

### Railway / Fly.io / your own host

Same `Dockerfile`, any Docker host:

```bash
docker build -t shirt-designs .
docker run -p 4000:4000 -v shirt-designs-data:/data shirt-designs
```

Mount a persistent volume at `/data` (or wherever you point `SHIRT_DATA_DIR`)
on whichever platform you pick — that volume *is* the design library, so
losing it means losing every saved asset, shirt type and export.

Once deployed, set `PUBLIC_BASE_URL` to the public URL so share links the app
generates point at it instead of guessing from the request:

```bash
PUBLIC_BASE_URL=https://your-app.example
```

### If you already tried Vercel

Delete or disconnect that project — left connected, it will keep redeploying
and crashing on every push to this branch. Nothing in this repo targets
Vercel; if a project there is auto-importing from GitHub, that happened on
Vercel's side, not from anything committed here.
