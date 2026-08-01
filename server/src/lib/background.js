/**
 * Background removal.
 *
 * Tuned for the images people actually drop into a shirt design: logos, hand
 * drawings, scanned art and product shots that sit on a flat or near-flat
 * backdrop. The approach is an edge-seeded flood fill with a soft outer band,
 * which keeps antialiased outlines intact instead of leaving a hard fringe.
 */

/**
 * Perceptual-ish RGB distance ("redmean"). Cheap, and markedly better than raw
 * Euclidean at not eating dark navy pixels when the background is black.
 */
function distance(r1, g1, b1, r2, g2, b2) {
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(
    (((512 + rMean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rMean) * db * db) >> 8),
  );
}

/**
 * Samples the border ring and returns the dominant colours, so an image whose
 * backdrop is a soft gradient (or has a vignette) still gets fully keyed.
 */
export function estimateBackgroundColors({ width, height, data }, maxColors = 3) {
  const ring = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  const buckets = new Map();

  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 8) return;
    // Quantise to 5 bits per channel so near-identical pixels share a bucket.
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += data[i];
    bucket.g += data[i + 1];
    bucket.b += data[i + 2];
    bucket.n += 1;
    buckets.set(key, bucket);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onRing = x < ring || y < ring || x >= width - ring || y >= height - ring;
      if (onRing) sample(x, y);
    }
  }

  const total = [...buckets.values()].reduce((sum, bucket) => sum + bucket.n, 0);
  if (total === 0) return [{ r: 255, g: 255, b: 255 }];

  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .filter((bucket, index) => index === 0 || bucket.n / total > 0.08)
    .slice(0, maxColors)
    .map((bucket) => ({
      r: Math.round(bucket.r / bucket.n),
      g: Math.round(bucket.g / bucket.n),
      b: Math.round(bucket.b / bucket.n),
    }));
}

export function parseHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!match) return null;
  const int = Number.parseInt(match[1], 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} image
 * @param {object} [options]
 * @param {number} [options.tolerance] 0-100. How far a pixel may drift from the
 *   sampled backdrop and still count as background.
 * @param {number} [options.softness] 0-100. Width of the partial-alpha band
 *   that feathers the cutout edge.
 * @param {'edges'|'everywhere'} [options.mode] `edges` only clears background
 *   connected to the image border (keeps holes inside a logo opaque);
 *   `everywhere` also clears enclosed regions of the same colour.
 * @param {string[]} [options.colors] Explicit hex backdrop colours; when
 *   omitted they are sampled from the border.
 * @param {boolean} [options.despill] Remove backdrop colour bleeding into
 *   semi-transparent edge pixels.
 */
export function removeBackground(image, options = {}) {
  const { width, height, data } = image;
  const tolerance = clamp(options.tolerance ?? 28, 0, 100);
  const softness = clamp(options.softness ?? 35, 0, 100);
  const despill = options.despill !== false;

  const explicit = (options.colors ?? []).map(parseHex).filter(Boolean);
  const references = explicit.length > 0 ? explicit : estimateBackgroundColors(image);

  // Picking a colour by hand means "remove this colour", so those pixels go
  // wherever they are. Sampled backdrops stay edge-connected by default, which
  // is what keeps the holes inside a logo opaque.
  const defaultMode = explicit.length > 0 ? 'everywhere' : 'edges';
  const mode = options.mode === 'everywhere' || options.mode === 'edges' ? options.mode : defaultMode;

  // 0-100 maps onto the redmean scale, whose practical maximum is ~765.
  const inner = (tolerance / 100) * 420;
  const outer = inner + (softness / 100) * 160 + 8;

  const out = new Uint8ClampedArray(data);
  const nearest = new Float32Array(width * height);
  const refIndex = new Uint8Array(width * height);

  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    let best = Infinity;
    let bestRef = 0;
    for (let r = 0; r < references.length; r += 1) {
      const ref = references[r];
      const d = distance(data[i], data[i + 1], data[i + 2], ref.r, ref.g, ref.b);
      if (d < best) {
        best = d;
        bestRef = r;
      }
    }
    nearest[p] = best;
    refIndex[p] = bestRef;
  }

  // 0 = untouched, 1 = queued/background, 2 = soft edge.
  const state = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const push = (p) => {
    if (state[p] !== 0) return;
    if (nearest[p] <= inner) {
      state[p] = 1;
      queue[tail] = p;
      tail += 1;
    } else if (nearest[p] <= outer) {
      state[p] = 2;
    }
  };

  if (mode === 'everywhere') {
    for (let p = 0; p < width * height; p += 1) push(p);
  } else {
    for (let x = 0; x < width; x += 1) {
      push(x);
      push((height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
      push(y * width);
      push(y * width + width - 1);
    }
  }

  while (head < tail) {
    const p = queue[head];
    head += 1;
    const x = p % width;
    const y = (p - x) / width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (y > 0) push(p - width);
    if (y < height - 1) push(p + width);
  }

  const band = Math.max(1, outer - inner);
  for (let p = 0; p < width * height; p += 1) {
    if (state[p] === 0) continue;
    const i = p * 4;
    const alpha =
      state[p] === 1 ? 0 : clamp((nearest[p] - inner) / band, 0, 1) * (data[i + 3] / 255);

    if (despill && alpha > 0.02 && alpha < 0.98) {
      // Un-composite the backdrop out of the edge pixel: observed = fg*a + bg*(1-a).
      const ref = references[refIndex[p]];
      out[i] = clamp((data[i] - ref.r * (1 - alpha)) / alpha, 0, 255);
      out[i + 1] = clamp((data[i + 1] - ref.g * (1 - alpha)) / alpha, 0, 255);
      out[i + 2] = clamp((data[i + 2] - ref.b * (1 - alpha)) / alpha, 0, 255);
    }
    out[i + 3] = Math.round(alpha * 255);
  }

  const removed = countTransparent(out) - countTransparent(data);
  return {
    image: { width, height, data: out },
    backgroundColors: references.map(toHex),
    removedPixels: Math.max(0, removed),
    coverage: Math.max(0, removed) / (width * height),
  };
}

function countTransparent(data) {
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) n += 1;
  return n;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function toHex({ r, g, b }) {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
