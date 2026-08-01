import { api } from '../api.js';
import { store } from '../store.js';
import {
  button,
  el,
  icon,
  promptSheet,
  segmented,
  setChildren,
  sheet,
  slider,
  toast,
  withBusy,
} from '../ui.js';

/**
 * Image workbench: cut out the background, trace to vector, save to the library.
 *
 * Each step produces a new asset on the server rather than mutating the last
 * one, so the original upload is always there to go back to when a tolerance
 * turns out to be too aggressive.
 */

export function openImageTool(startingAsset) {
  const original = startingAsset;
  /** The asset the workbench is currently showing; each step replaces it. */
  let current = startingAsset;
  /** Everything produced in this session, oldest first. */
  const history = [startingAsset];

  const settings = {
    tolerance: 28,
    softness: 35,
    mode: 'edges',
    colors: null,
    quality: 'balanced',
  };

  const INK_SWATCHES = [
    '#000000',
    '#ffffff',
    '#c8102e',
    '#1f2a44',
    '#f5c451',
    '#4ec9a0',
    '#2f6df6',
    '#7d5ba6',
  ];

  return sheet({
    title: 'Prepare artwork',
    render: () => {
      const preview = el('div', { class: 'preview-pane checker' });
      const meta = el('p', { class: 'field-hint' });
      const body = el('div');

      function paint() {
        setChildren(preview,
          el('img', { src: `${api.assets.fileUrl(current.id)}?v=${current.id}`, alt: current.name }),
        );

        const kind = current.kind === 'vector' ? 'Vector' : 'Bitmap';
        const detail =
          current.format === 'pdf'
            ? 'original PDF page, embedded as-is at export'
            : current.kind === 'vector'
              ? `${current.pathCount ?? 0} paths · ${current.palette?.length ?? 0} ink colour${
                  (current.palette?.length ?? 0) === 1 ? '' : 's'
                }`
              : `${current.width} × ${current.height} px`;
        meta.textContent = `${kind} · ${detail}`;
        renderSteps();
      }

      function renderSteps() {
        setChildren(body,
          current.kind === 'raster' ? backgroundStep() : null,
          current.kind === 'raster' ? traceStep() : vectorDone(),
          history.length > 1
            ? el(
                'button',
                {
                  class: 'btn btn-ghost btn-block',
                  style: { marginTop: '12px' },
                  onClick: () => {
                    current = original;
                    history.length = 1;
                    paint();
                  },
                },
                'Start over from the original',
              )
            : null,
        );
      }

      function backgroundStep() {
        const swatches = el('div', { class: 'chips', style: { marginTop: '10px' } });

        // Offer the sampled backdrop colours so a user can key a specific one
        // rather than trusting the automatic edge detection.
        api.assets
          .backgroundColors(current.id)
          .then(({ colors }) => {
            if (colors.length === 0) return;
            swatches.append(el('span', { class: 'field-hint', style: { alignSelf: 'center' } }, 'Detected:'));
            for (const color of colors) {
              swatches.append(
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'chip',
                    'aria-pressed': 'false',
                    onClick: (event) => {
                      const chip = event.currentTarget;
                      const on = chip.getAttribute('aria-pressed') !== 'true';
                      chip.setAttribute('aria-pressed', String(on));
                      const chosen = [...swatches.querySelectorAll('[aria-pressed="true"]')].map(
                        (node) => node.dataset.color,
                      );
                      settings.colors = chosen.length > 0 ? chosen : null;
                    },
                    dataset: { color },
                  },
                  el('span', { class: 'swatch', style: { background: color } }),
                  color,
                ),
              );
            }
          })
          .catch(() => {});

        return el(
          'section',
          { class: 'card', style: { marginTop: '14px' } },
          el('div', { class: 'section-head', style: { margin: '0 0 4px' } }, el('h2', {}, 'Remove background')),
          el(
            'p',
            { class: 'field-hint', style: { margin: 0 } },
            'Clears the backdrop and feathers the edge so outlines stay smooth.',
          ),
          swatches,
          slider({
            label: 'Tolerance',
            min: 0,
            max: 100,
            value: settings.tolerance,
            format: (v) => `${v}%`,
            onInput: (v) => {
              settings.tolerance = v;
            },
          }),
          slider({
            label: 'Edge softness',
            min: 0,
            max: 100,
            value: settings.softness,
            format: (v) => `${v}%`,
            onInput: (v) => {
              settings.softness = v;
            },
          }),
          el(
            'div',
            { style: { marginTop: '14px' } },
            el('span', { class: 'field-hint' }, 'Reach'),
            el('div', { style: { height: '6px' } }),
            segmented(
              [
                { value: 'edges', label: 'Outside only' },
                { value: 'everywhere', label: 'Everywhere' },
              ],
              settings.mode,
              (value) => {
                settings.mode = value;
                renderSteps();
              },
            ),
            el(
              'p',
              { class: 'field-hint' },
              settings.mode === 'edges'
                ? 'Keeps enclosed areas — the holes in an O stay filled.'
                : 'Also clears matching colour trapped inside the artwork.',
            ),
          ),
          button('Remove background', {
            class: 'btn btn-primary btn-block',
            style: { marginTop: '14px' },
            iconName: 'wand',
            onClick: async () => {
              const result = await withBusy('Cutting out the background…', () =>
                api.assets.removeBackground(current.id, {
                  tolerance: settings.tolerance,
                  softness: settings.softness,
                  mode: settings.mode,
                  colors: settings.colors,
                }),
              );

              store.cacheAsset(result);
              current = result;
              history.push(result);
              paint();

              const share = Math.round((result.removedShare ?? 0) * 100);
              toast(
                share > 90
                  ? `Removed ${share}% of the image — lower the tolerance if too much went.`
                  : `Background removed (${share}% of the frame).`,
                share > 90 ? 'error' : 'ok',
              );
            },
          }),
        );
      }

      function traceStep() {
        return el(
          'section',
          { class: 'card', style: { marginTop: '12px' } },
          el('div', { class: 'section-head', style: { margin: '0 0 4px' } }, el('h2', {}, 'Convert to vector')),
          el(
            'p',
            { class: 'field-hint', style: { margin: 0 } },
            'Traces a single solid shape in black — ideal for a logo or line art. Pick a different ink colour once it is traced.',
          ),
          el(
            'div',
            { style: { marginTop: '12px' } },
            el('span', { class: 'field-hint' }, 'Detail'),
            el('div', { style: { height: '6px' } }),
            segmented(
              [
                { value: 'crisp', label: 'Crisp' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'smooth', label: 'Smooth' },
              ],
              settings.quality,
              (value) => {
                settings.quality = value;
                renderSteps();
              },
            ),
          ),
          button('Trace to vector', {
            class: 'btn btn-block',
            style: { marginTop: '14px' },
            iconName: 'vector',
            onClick: async () => {
              const result = await withBusy('Tracing outlines…', () =>
                api.assets.vectorize(current.id, { quality: settings.quality }),
              );
              store.cacheAsset(result);
              current = result;
              history.push(result);
              paint();
              toast('Traced to a single vector shape.', 'ok');
            },
          }),
        );
      }

      function vectorDone() {
        const inkColor = current.palette?.[0]?.color ?? '#000000';
        const isTraced = current.source === 'vectorized';
        const colorRow = el('div', { class: 'chips', style: { marginTop: '10px' } });

        for (const swatch of INK_SWATCHES) {
          colorRow.append(
            el(
              'button',
              {
                type: 'button',
                class: 'chip',
                'aria-pressed': String(swatch.toLowerCase() === inkColor.toLowerCase()),
                onClick: async () => {
                  const result = await withBusy('Recolouring…', () => api.assets.recolor(current.id, swatch));
                  store.cacheAsset(result);
                  current = result;
                  history.push(result);
                  paint();
                },
              },
              el('span', { class: 'swatch', style: { background: swatch } }),
            ),
          );
        }

        return el(
          'section',
          { class: 'card', style: { marginTop: '14px' } },
          el(
            'div',
            { class: 'note info' },
            icon('info'),
            el('div', {}, 'This artwork is vector and ready to print at any size.'),
          ),
          isTraced
            ? el(
                'div',
                { style: { marginTop: '12px' } },
                el('span', { class: 'field-hint' }, 'Ink colour'),
                colorRow,
              )
            : null,
        );
      }

      paint();

      return [preview, meta, body];
    },

    footer: (close) =>
      el(
        'div',
        { class: 'btn-row' },
        button('Discard', { class: 'btn btn-ghost', onClick: () => close(undefined) }),
        button('Save to library', {
          class: 'btn btn-primary',
          iconName: 'save',
          onClick: async () => {
            const name = await promptSheet({
              title: 'Save to library',
              label: 'Name this artwork',
              value: current.name,
              confirmLabel: 'Save',
            });
            if (!name) return;

            const saved = await withBusy('Saving…', () => api.assets.save(current.id, name));
            await store.loadLibrary();
            toast('Added to your design library.', 'ok');
            close(saved);
          },
        }),
      ),
  });
}
