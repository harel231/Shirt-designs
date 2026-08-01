import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Minimal raster pipeline. Everything downstream (background removal, tracing,
 * PDF placement) speaks a single shape: `{ width, height, data }` where `data`
 * is a straight (non-premultiplied) RGBA `Uint8ClampedArray`.
 */

export function sniffFormat(buffer) {
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF') return 'webp';
  if (buffer.toString('utf8', 0, 400).trimStart().startsWith('<svg')) return 'svg';
  if (buffer.toString('utf8', 0, 400).includes('<svg')) return 'svg';
  return 'unknown';
}

export function decode(buffer) {
  const format = sniffFormat(buffer);
  if (format === 'png') {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  }
  if (format === 'jpeg') {
    const raw = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
    return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
  }
  throw Object.assign(
    new Error(
      `Unsupported image format "${format}". Upload a PNG or JPEG — HEIC photos from an iPhone are converted by the app before upload.`,
    ),
    { status: 415 },
  );
}

export function encodePng({ width, height, data }) {
  const png = new PNG({ width, height });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
}

/** Reads the pixel dimensions without fully decoding, when that is all we need. */
export function measure(buffer) {
  const { width, height } = decode(buffer);
  return { width, height };
}

/**
 * Downsamples so the longest edge fits `maxEdge`. Tracing and flood filling are
 * O(pixels); a 4032x3024 phone photo is 12M pixels and would stall the request.
 */
export function fit(image, maxEdge) {
  const scale = maxEdge / Math.max(image.width, image.height);
  if (scale >= 1) return image;

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y += 1) {
    // Box filter: average the source pixels that collapse into this one.
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.data[i + 3];
          r += image.data[i] * alpha;
          g += image.data[i + 1] * alpha;
          b += image.data[i + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        data[o] = r / a;
        data[o + 1] = g / a;
        data[o + 2] = b / a;
      }
      data[o + 3] = a / n;
    }
  }

  return { width, height, data };
}

/**
 * Resamples to exact dimensions in either direction: the box filter in `fit`
 * for shrinking, bilinear for enlarging. `fit` alone cannot do this — it
 * returns the source untouched when asked to grow.
 */
export function resize(image, width, height) {
  if (width === image.width && height === image.height) return image;

  // An aspect-preserving shrink goes through the box filter, which averages
  // every source pixel instead of sampling four of them and aliasing.
  const keepsAspect = Math.abs(width / height - image.width / image.height) < 0.01;
  if (keepsAspect && width <= image.width) return fit(image, Math.max(width, height));

  const data = new Uint8ClampedArray(width * height * 4);
  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const wy = sy - y0;

    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const wx = sx - x0;

      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top =
          image.data[(y0 * image.width + x0) * 4 + c] * (1 - wx) +
          image.data[(y0 * image.width + x1) * 4 + c] * wx;
        const bottom =
          image.data[(y1 * image.width + x0) * 4 + c] * (1 - wx) +
          image.data[(y1 * image.width + x1) * 4 + c] * wx;
        data[o + c] = top * (1 - wy) + bottom * wy;
      }
    }
  }

  return { width, height, data };
}

/**
 * Scales an image to fit a fixed frame and centres it on a transparent canvas.
 *
 * Garment photographs go through this so every shirt — generated or
 * photographed — occupies the same coordinate space. Print areas are stored in
 * that space, so without it the imprint guide would drift on any photo that
 * was not already the canvas aspect ratio.
 */
export function letterbox(image, frame) {
  const scale = Math.min(frame.width / image.width, frame.height / image.height);
  const scaled = resize(
    image,
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );

  const data = new Uint8ClampedArray(frame.width * frame.height * 4);
  const offsetX = Math.round((frame.width - scaled.width) / 2);
  const offsetY = Math.round((frame.height - scaled.height) / 2);

  for (let y = 0; y < scaled.height; y += 1) {
    const target = ((y + offsetY) * frame.width + offsetX) * 4;
    data.set(scaled.data.subarray(y * scaled.width * 4, (y + 1) * scaled.width * 4), target);
  }

  return { width: frame.width, height: frame.height, data };
}

/** Tightest rectangle containing pixels above `alphaThreshold`, or null. */
export function alphaBounds({ width, height, data }, alphaThreshold = 8) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function crop({ width, height, data }, box) {
  const out = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y += 1) {
    const src = ((y + box.y) * width + box.x) * 4;
    out.set(data.subarray(src, src + box.width * 4), y * box.width * 4);
  }
  return { width: box.width, height: box.height, data: out };
}
