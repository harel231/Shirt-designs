/**
 * Coordinate systems, in one place.
 *
 * Three are in play at once:
 *
 *  - garment canvas: the 1000x1250 space the shirt artwork is drawn in;
 *  - print-area inches: where layers actually live, because inches are what
 *    survives the trip to the printer;
 *  - screen pixels: what the user touches.
 *
 * Keeping the conversions pure and in one module means the editor, the
 * thumbnails and the tests all agree about where things are.
 */

/** Fits the garment canvas inside the available box, centred, without cropping. */
export function layoutCanvas(container, canvas, padding = 0) {
  const availableWidth = Math.max(1, container.width - padding * 2);
  const availableHeight = Math.max(1, container.height - padding * 2);
  const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height);
  const width = canvas.width * scale;
  const height = canvas.height * scale;

  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
    scale,
  };
}

export function printAreaRect(layout, area) {
  return {
    left: layout.left + area.x * layout.scale,
    top: layout.top + area.y * layout.scale,
    width: area.width * layout.scale,
    height: area.height * layout.scale,
  };
}

/** Screen pixels per printed inch — the bridge between touch and press. */
export function pixelsPerInch(layout, area) {
  return (area.width * layout.scale) / area.widthIn;
}

export function layerToScreen(layer, layout, area) {
  const rect = printAreaRect(layout, area);
  const ppi = pixelsPerInch(layout, area);

  return {
    left: rect.left + layer.x * ppi,
    top: rect.top + layer.y * ppi,
    width: layer.width * ppi,
    height: layer.height * ppi,
  };
}

/** Inverse of {@link layerToScreen}: a dragged point back into inches. */
export function screenToInches(point, layout, area) {
  const rect = printAreaRect(layout, area);
  const ppi = pixelsPerInch(layout, area);
  return { x: (point.x - rect.left) / ppi, y: (point.y - rect.top) / ppi };
}

/**
 * Initial size for freshly added artwork: 70% of the print area's width while
 * staying inside it, keeping the source aspect ratio.
 */
export function fitNewLayer(asset, area) {
  const aspect = asset.height / Math.max(1, asset.width);
  let width = area.widthIn * 0.7;
  let height = width * aspect;

  const maxHeight = area.heightIn * 0.7;
  if (height > maxHeight) {
    height = maxHeight;
    width = height / Math.max(0.0001, aspect);
  }

  return {
    x: (area.widthIn - width) / 2,
    // Chest prints sit high in the area rather than dead centre.
    y: Math.min((area.heightIn - height) / 2, area.heightIn * 0.22),
    width,
    height,
  };
}

/**
 * Keeps a layer reachable. Artwork may hang outside the print area — that is a
 * legitimate bleed choice — but never so far that it cannot be grabbed again.
 */
export function clampLayer(layer, area) {
  const minVisible = 0.5;
  return {
    ...layer,
    x: clamp(layer.x, -layer.width + minVisible, area.widthIn - minVisible),
    y: clamp(layer.y, -layer.height + minVisible, area.heightIn - minVisible),
    width: clamp(layer.width, 0.25, area.widthIn * 3),
    height: clamp(layer.height, 0.25, area.heightIn * 3),
  };
}

/** True when any part of the layer sits outside the printable area. */
export function overflowsPrintArea(layer, area) {
  const epsilon = 0.01;
  return (
    layer.x < -epsilon ||
    layer.y < -epsilon ||
    layer.x + layer.width > area.widthIn + epsilon ||
    layer.y + layer.height > area.heightIn + epsilon
  );
}

/** Effective print resolution of a bitmap at its current size on the garment. */
export function effectiveDpi(asset, layer) {
  return Math.floor(
    Math.min(asset.width / Math.max(0.01, layer.width), asset.height / Math.max(0.01, layer.height)),
  );
}

/** Centres a layer horizontally in the print area. */
export function centerHorizontally(layer, area) {
  return { ...layer, x: (area.widthIn - layer.width) / 2 };
}

/** Scales a layer about its own centre so it stays put while resizing. */
export function scaleAboutCenter(layer, factor) {
  const width = layer.width * factor;
  const height = layer.height * factor;
  return {
    ...layer,
    x: layer.x + (layer.width - width) / 2,
    y: layer.y + (layer.height - height) / 2,
    width,
    height,
  };
}

export function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** Inches rendered the way a print shop writes them. */
export function formatInches(value) {
  return `${Math.round(value * 100) / 100}"`;
}

/** Distance and angle between two pointers, for pinch-zoom and rotate. */
export function pointerSpan(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    distance: Math.hypot(dx, dy),
    angle: (Math.atan2(dy, dx) * 180) / Math.PI,
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

/** Wraps degrees into (-180, 180] so rotation deltas never jump a full turn. */
export function normalizeAngle(degrees) {
  let angle = degrees % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}
