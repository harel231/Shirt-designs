import { api } from '../api.js';
import { store } from '../store.js';
import {
  button,
  el,
  icon,
  segmented,
  setChildren,
  sheet,
  slider,
  toast,
  withBusy,
} from '../ui.js';
import { openFontPicker } from './font-picker.js';

/**
 * Text tool.
 *
 * Type is converted to vector outlines on the server, which is both what the
 * live preview shows and what ends up in the production PDF — there is no
 * second rendering path that could disagree with the printed result.
 */

const SHIRT_INKS = [
  '#ffffff',
  '#111111',
  '#c8102e',
  '#1f2a44',
  '#f5c451',
  '#4ec9a0',
  '#2f6df6',
  '#e2725b',
  '#7d5ba6',
  '#d9c9a8',
];

/** Internal type size. Only the resulting shape matters — layers scale in inches. */
const OUTLINE_SIZE = 160;

export function openTextTool({ initial } = {}) {
  const spec = {
    text: initial?.text ?? '',
    family: initial?.family ?? 'Bebas Neue',
    weight: initial?.weight ?? 400,
    italic: initial?.italic ?? false,
    letterSpacing: initial?.letterSpacing ?? 0,
    lineHeight: initial?.lineHeight ?? 1.1,
    align: initial?.align ?? 'center',
    arc: initial?.arc ?? 0,
    color: initial?.color ?? '#111111',
    // 'auto' reads the text itself: Hebrew comes out right to left without
    // anyone having to say so. The override is for mixed lines, where the
    // first strong word is not the one that sets the direction.
    direction: initial?.direction ?? 'auto',
    size: OUTLINE_SIZE,
  };

  let lastPreview = null;

  return sheet({
    title: initial ? 'Edit text' : 'Add text',
    render: () => {
      const preview = el('div', { class: 'preview-pane artwork' });
      const previewNote = el('p', { class: 'field-hint' });
      const scriptNote = el('div', { hidden: true });
      const familyLabel = el('strong', {}, spec.family);
      const weightRow = el('div', { class: 'chips' });

      let previewToken = 0;
      let debounce;

      /**
       * What the family cannot do with this text, said plainly and while it
       * can still be fixed. A Hebrew word in a Latin-only family outlines as a
       * row of blanks, and blanks are easy to miss in a small preview.
       */
      function showScriptNote(result) {
        if (result?.missingGlyphs > 0) {
          setChildren(scriptNote,
            el(
              'div',
              { class: 'note' },
              icon('warn'),
              el(
                'div',
                {},
                `${spec.family} has no shape for ${result.missingGlyphs} character${
                  result.missingGlyphs === 1 ? '' : 's'
                } here — they will print as blanks.`,
                result.scriptHint
                  ? el(
                      'button',
                      {
                        type: 'button',
                        class: 'btn btn-ghost btn-block',
                        style: { marginTop: '10px' },
                        onClick: () => chooseFont(result.scriptHint),
                      },
                      `Show fonts that support ${titleCase(result.scriptHint)}`,
                    )
                  : null,
              ),
            ),
          );
          scriptNote.hidden = false;
          return;
        }

        if (result?.unshaped) {
          setChildren(scriptNote,
            el(
              'div',
              { class: 'note' },
              icon('warn'),
              el(
                'div',
                {},
                'Arabic letters are placed right to left here, but not joined — each one keeps its standalone shape. Check the preview before printing.',
              ),
            ),
          );
          scriptNote.hidden = false;
          return;
        }

        scriptNote.hidden = true;
        scriptNote.replaceChildren();
      }

      async function chooseFont(subset = '') {
        const chosen = await openFontPicker({
          current: spec.family,
          sampleText: firstLine(spec.text),
          // Land on the families that can draw what is already typed.
          subset: subset || lastPreview?.scriptHint || '',
        });
        if (!chosen) return;
        spec.family = chosen.family;
        familyLabel.textContent = chosen.family;
        await loadWeights();
        refresh();
      }

      async function refresh() {
        if (!spec.text.trim()) {
          setChildren(preview, el('p', { class: 'field-hint' }, 'Type something to see it.'));
          previewNote.textContent = '';
          showScriptNote(null);
          lastPreview = null;
          return;
        }

        const run = ++previewToken;
        try {
          const result = await api.fonts.preview(spec);
          if (run !== previewToken) return;

          lastPreview = result;
          // The SVG is inlined rather than loaded via <img> so it inherits the
          // sheet's background and scales crisply at any pane size.
          preview.innerHTML = result.svg;
          const svg = preview.querySelector('svg');
          if (svg) {
            svg.removeAttribute('width');
            svg.removeAttribute('height');
            svg.style.maxHeight = '210px';
            svg.style.width = '100%';
          }
          previewNote.textContent = `${result.font.family} ${result.font.weight}${
            result.font.italic ? ' italic' : ''
          } · outlined, ${result.width} × ${result.height}${
            result.direction === 'rtl' ? ' · right to left' : ''
          }`;
          showScriptNote(result);
        } catch (err) {
          if (run !== previewToken) return;
          setChildren(preview, el('p', { class: 'field-hint' }, err.message));
          showScriptNote(null);
          lastPreview = null;
        }
      }

      function schedule() {
        clearTimeout(debounce);
        debounce = setTimeout(refresh, 260);
      }

      async function loadWeights() {
        weightRow.replaceChildren();
        let font;
        try {
          const page = await api.fonts.search({ q: spec.family, limit: 8 });
          font = page.items.find((item) => item.family === spec.family);
        } catch {
          font = undefined;
        }

        const weights = font?.weights?.length ? font.weights : [400];
        if (!weights.includes(spec.weight)) {
          spec.weight = weights.includes(400) ? 400 : weights[0];
        }

        for (const weight of weights) {
          weightRow.append(
            el(
              'button',
              {
                type: 'button',
                class: 'chip',
                'aria-pressed': String(weight === spec.weight),
                onClick: () => {
                  spec.weight = weight;
                  for (const chip of weightRow.children) {
                    chip.setAttribute('aria-pressed', String(Number(chip.dataset.weight) === weight));
                  }
                  refresh();
                },
                dataset: { weight: String(weight) },
              },
              String(weight),
            ),
          );
        }

        if (font?.hasItalic) {
          weightRow.append(
            el(
              'button',
              {
                type: 'button',
                class: 'chip',
                'aria-pressed': String(spec.italic),
                onClick: (event) => {
                  spec.italic = !spec.italic;
                  event.currentTarget.setAttribute('aria-pressed', String(spec.italic));
                  refresh();
                },
              },
              'Italic',
            ),
          );
        }
      }

      const textarea = el('textarea', {
        placeholder: 'BROOKLYN\nATHLETIC CLUB',
        value: spec.text,
        rows: 3,
        // Typing Hebrew should look like typing Hebrew: the caret starts on the
        // right and the line grows leftwards, the same way the artwork will.
        dir: directionAttribute(spec.direction),
        onInput: (event) => {
          spec.text = event.target.value;
          schedule();
        },
      });

      const colorRow = el('div', { class: 'chips' });
      for (const ink of SHIRT_INKS) {
        colorRow.append(
          el(
            'button',
            {
              type: 'button',
              class: 'chip',
              'aria-pressed': String(ink === spec.color),
              dataset: { ink },
              onClick: () => {
                spec.color = ink;
                for (const chip of colorRow.children) {
                  chip.setAttribute('aria-pressed', String(chip.dataset.ink === ink));
                }
                refresh();
              },
            },
            el('span', { class: 'swatch', style: { background: ink } }),
          ),
        );
      }

      loadWeights().then(refresh);

      return [
        preview,
        previewNote,
        scriptNote,
        el('label', { class: 'field' }, el('span', {}, 'Text'), textarea),
        el(
          'button',
          {
            type: 'button',
            class: 'row',
            style: { marginTop: '12px' },
            onClick: () => chooseFont(),
          },
          el('div', { class: 'thumb' }, icon('text')),
          el(
            'div',
            { class: 'row-body' },
            familyLabel,
            el('span', {}, 'Tap to browse every Google Font'),
          ),
          el('span', { class: 'chev' }, icon('chev')),
        ),
        el('div', { style: { marginTop: '12px' } }, el('span', { class: 'field-hint' }, 'Weight'), weightRow),
        el('div', { style: { marginTop: '12px' } }, el('span', { class: 'field-hint' }, 'Colour'), colorRow),
        el(
          'div',
          { style: { marginTop: '14px' } },
          el('span', { class: 'field-hint' }, 'Direction'),
          el('div', { style: { height: '6px' } }),
          segmented(
            [
              { value: 'auto', label: 'Auto' },
              { value: 'ltr', label: 'L → R' },
              { value: 'rtl', label: 'R → L' },
            ],
            spec.direction,
            (value) => {
              spec.direction = value;
              textarea.dir = directionAttribute(value);
              refresh();
            },
          ),
        ),
        el(
          'div',
          { style: { marginTop: '14px' } },
          el('span', { class: 'field-hint' }, 'Alignment'),
          el('div', { style: { height: '6px' } }),
          segmented(
            [
              { value: 'left', label: 'Left' },
              { value: 'center', label: 'Centre' },
              { value: 'right', label: 'Right' },
            ],
            spec.align,
            (value) => {
              spec.align = value;
              refresh();
            },
          ),
        ),
        slider({
          label: 'Arch',
          min: -160,
          max: 160,
          value: spec.arc,
          format: (v) => (v === 0 ? 'Straight' : `${v > 0 ? 'Up' : 'Down'} ${Math.abs(v)}°`),
          onInput: (v) => {
            spec.arc = v;
            schedule();
          },
        }),
        slider({
          label: 'Letter spacing',
          min: -20,
          max: 80,
          value: spec.letterSpacing,
          onInput: (v) => {
            spec.letterSpacing = v;
            schedule();
          },
        }),
        slider({
          label: 'Line spacing',
          min: 0.7,
          max: 2.4,
          step: 0.05,
          value: spec.lineHeight,
          format: (v) => `${v.toFixed(2)}×`,
          onInput: (v) => {
            spec.lineHeight = v;
            schedule();
          },
        }),
      ];
    },

    footer: (close) =>
      el(
        'div',
        { class: 'btn-row' },
        button('Cancel', { class: 'btn btn-ghost', onClick: () => close(undefined) }),
        button('Save to library', {
          class: 'btn btn-primary',
          iconName: 'save',
          onClick: async () => {
            if (!spec.text.trim()) {
              toast('Type something first.', 'error');
              return;
            }
            if (!lastPreview) {
              toast('Still rendering — try again in a moment.', 'error');
              return;
            }

            const asset = await withBusy('Outlining the type…', () =>
              api.assets.createText({ ...spec, save: true, name: firstLine(spec.text) }),
            );
            store.cacheAsset(asset);
            await store.loadLibrary();
            toast('Text saved to your library.', 'ok');
            close(asset);
          },
        }),
      ),
  });
}

function titleCase(value) {
  const text = String(value ?? '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The `dir` a text box should use for a direction setting. */
function directionAttribute(direction) {
  return direction === 'ltr' || direction === 'rtl' ? direction : 'auto';
}

function firstLine(text) {
  const line = String(text ?? '').split('\n')[0].trim();
  return line.length > 0 ? line.slice(0, 40) : 'Handgloves';
}
