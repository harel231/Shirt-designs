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
render.yaml            Render blueprint (Docker + persistent disk)
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

### Render (one click, no card required for the base service)

A `render.yaml` blueprint is included:

1. Push this repo to GitHub.
2. On Render, **New → Blueprint**, point it at the repo.
3. It provisions the web service from the `Dockerfile` with a 1 GB persistent
   disk mounted at `/data` (`SHIRT_DATA_DIR`).

The blueprint uses Render's `starter` plan, which is what supports the
persistent disk — check Render's current pricing before deploying. Without a
disk (e.g. on a free instance) the app still runs correctly between requests,
it just loses uploads/designs/exports whenever the instance restarts or
redeploys.

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
