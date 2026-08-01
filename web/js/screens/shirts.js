import { api } from '../api.js';
import { getState, store, subscribe } from '../store.js';
import {
  button,
  confirmSheet,
  el,
  emptyState,
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
 * T-Shirt Design Hub — the catalog.
 *
 * Built-in types are generated silhouettes that tint to any colour on demand.
 * A user-added type (a specific Carhartt or Saucony style) carries its own
 * photographs instead, with a print area measured in real inches so the
 * production file comes out at the right size either way.
 */

const SHAPE_LABELS = {
  tee: 'T-shirt',
  vneck: 'V-neck',
  longsleeve: 'Long sleeve',
  tank: 'Tank top',
  crewneck: 'Sweatshirt',
  hoodie: 'Hoodie',
  polo: 'Polo',
  workshirt: 'Work shirt',
};

const NEW_COLORS = [
  { name: 'White', hex: '#ffffff' },
  { name: 'Black', hex: '#141414' },
  { name: 'Navy', hex: '#1f2a44' },
  { name: 'Heather', hex: '#c9ccd1' },
  { name: 'Sand', hex: '#d9c9a8' },
  { name: 'Forest', hex: '#1f4032' },
];

export function renderShirtsScreen({ mount, navigate }) {
  const screen = el('div', { class: 'screen' });
  mount.append(screen);

  const unsubscribe = subscribe(paint);
  paint();

  function paint() {
    const { shirts } = getState();
    const custom = shirts.filter((shirt) => !shirt.builtIn);
    const builtIn = shirts.filter((shirt) => shirt.builtIn);

    setChildren(screen,
      el(
        'div',
        { class: 'screen-head' },
        el('h1', {}, 'Shirts'),
        el('p', {}, 'Pick a garment to design on, or add your own.'),
      ),

      button('Add a shirt type', {
        class: 'btn btn-primary btn-block',
        iconName: 'plus',
        onClick: () => openNewShirtSheet(),
      }),

      custom.length > 0
        ? el(
            'section',
            {},
            el('div', { class: 'section-head' }, el('h2', {}, 'Your shirts')),
            el('div', { class: 'grid' }, ...custom.map(shirtTile)),
          )
        : null,

      el('div', { class: 'section-head' }, el('h2', {}, 'Blanks')),
      builtIn.length === 0
        ? emptyState({ title: 'No shirts yet', message: 'Add one to start designing.' })
        : el('div', { class: 'grid' }, ...builtIn.map(shirtTile)),
    );
  }

  function shirtTile(shirt) {
    const colorway = shirt.colorways[0];
    return el(
      'button',
      { class: 'tile', onClick: () => openShirtSheet(shirt) },
      el(
        'div',
        { class: 'tile-art' },
        colorway?.frontUrl ? el('img', { src: colorway.frontUrl, alt: shirt.name, loading: 'lazy' }) : icon('shirts'),
      ),
      el(
        'div',
        { class: 'tile-label' },
        el('strong', { class: 'truncate' }, shirt.name),
        el(
          'span',
          {},
          `${shirt.brand ? `${shirt.brand} · ` : ''}${shirt.printAreas.front.widthIn}" × ${shirt.printAreas.front.heightIn}" print`,
        ),
        el(
          'div',
          { class: 'swatches' },
          ...shirt.colorways
            .slice(0, 7)
            .map((row) => el('span', { class: 'swatch', style: { background: row.hex } })),
          shirt.colorways.length > 7
            ? el('span', { class: 'field-hint' }, `+${shirt.colorways.length - 7}`)
            : null,
        ),
      ),
    );
  }

  /** Choose a colour, then start designing. */
  function openShirtSheet(shirt) {
    let selected = shirt.colorways[0];
    let view = 'front';

    return sheet({
      title: shirt.name,
      render: (close) => {
        const art = el('div', { class: 'preview-pane' });
        const colorRow = el('div', { class: 'chips' });
        const label = el('p', { class: 'field-hint' });

        function paintPreview() {
          const url = view === 'back' ? selected.backUrl : selected.frontUrl;
          setChildren(art,
            url
              ? el('img', { src: url, alt: `${shirt.name} ${view}` })
              : el('p', { class: 'field-hint' }, `No ${view} image for this colour.`),
          );
          label.textContent = `${selected.name} · ${selected.hex} · print area ${shirt.printAreas[view].widthIn}" × ${shirt.printAreas[view].heightIn}"`;
        }

        for (const colorway of shirt.colorways) {
          colorRow.append(
            el(
              'button',
              {
                type: 'button',
                class: 'chip',
                'aria-pressed': String(colorway.id === selected.id),
                dataset: { id: colorway.id },
                onClick: () => {
                  selected = colorway;
                  for (const chip of colorRow.children) {
                    chip.setAttribute('aria-pressed', String(chip.dataset.id === colorway.id));
                  }
                  paintPreview();
                },
              },
              el('span', { class: 'swatch', style: { background: colorway.hex } }),
              colorway.name,
            ),
          );
        }

        paintPreview();

        return [
          art,
          el(
            'div',
            { style: { marginTop: '10px' } },
            segmented(
              [
                { value: 'front', label: 'Front' },
                { value: 'back', label: 'Back' },
              ],
              view,
              (value) => {
                view = value;
                paintPreview();
              },
            ),
          ),
          label,
          el('div', { style: { marginTop: '10px' } }, el('span', { class: 'field-hint' }, 'Colour'), colorRow),
          el(
            'div',
            { class: 'btn-stack' },
            button('Add a colour', {
              class: 'btn btn-ghost btn-sm',
              iconName: 'palette',
              onClick: async () => {
                close();
                await openAddColorwaySheet(shirt);
              },
            }),
            button('Adjust print area', {
              class: 'btn btn-ghost btn-sm',
              iconName: 'resize',
              onClick: async () => {
                close();
                await openPrintAreaSheet(shirt);
              },
            }),
            !shirt.builtIn
              ? button('Delete this shirt type', {
                  class: 'btn btn-ghost btn-sm btn-danger',
                  iconName: 'trash',
                  onClick: async () => {
                    close();
                    await deleteShirt(shirt);
                  },
                })
              : null,
          ),
        ];
      },

      footer: (close) =>
        button('Start a design', {
          class: 'btn btn-primary btn-block',
          iconName: 'wand',
          onClick: async () => {
            const name = await promptSheet({
              title: 'New design',
              label: 'Design name',
              value: '',
              placeholder: 'Summer tour tee',
              confirmLabel: 'Create',
            });
            if (!name) return;

            const design = await withBusy('Creating…', () =>
              api.designs.create({
                name,
                shirtTypeId: shirt.id,
                colorwayId: selected.id,
                colorHex: selected.hex,
              }),
            );
            close();
            await store.loadDesigns();
            navigate(`#/design/${design.id}`);
          },
        }),
    });
  }

  function openAddColorwaySheet(shirt) {
    const isPhotoShirt = shirt.source === 'photo';
    let hex = '#5b8cff';
    let frontFile = null;
    let backFile = null;
    const nameInput = el('input', { type: 'text', placeholder: 'Bottle green' });

    return sheet({
      title: 'Add a colour',
      render: () => {
        const colorInput = el('input', {
          type: 'color',
          value: hex,
          style: { width: '100%', height: '48px', padding: '4px', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: '12px' },
          onInput: (event) => {
            hex = event.target.value;
          },
        });

        const filePicker = (label, onPick) =>
          el(
            'label',
            { class: 'btn btn-block', style: { marginTop: '10px' } },
            icon('camera'),
            label,
            el('input', {
              type: 'file',
              accept: 'image/png,image/jpeg',
              class: 'sr-only',
              onChange: (event) => {
                const file = event.target.files?.[0];
                if (file) onPick(file, event.currentTarget.parentElement);
              },
            }),
          );

        return [
          el('label', { class: 'field' }, el('span', {}, 'Colour name'), nameInput),
          isPhotoShirt
            ? el(
                'div',
                {},
                el(
                  'p',
                  { class: 'field-hint', style: { marginTop: '14px' } },
                  'This shirt uses photographs, so a new colour needs its own front photo.',
                ),
                filePicker('Front photo', (file, node) => {
                  frontFile = file;
                  node.lastChild.remove();
                  node.append(` · ${file.name}`);
                }),
                filePicker('Back photo (optional)', (file, node) => {
                  backFile = file;
                  node.lastChild.remove();
                  node.append(` · ${file.name}`);
                }),
              )
            : el('label', { class: 'field' }, el('span', {}, 'Garment colour'), colorInput),
        ];
      },

      footer: (close) =>
        el(
          'div',
          { class: 'btn-row' },
          button('Cancel', { class: 'btn btn-ghost', onClick: () => close() }),
          button('Add colour', {
            class: 'btn btn-primary',
            onClick: async () => {
              const name = nameInput.value.trim();
              if (!name) {
                toast('Give the colour a name.', 'error');
                return;
              }
              if (isPhotoShirt && !frontFile) {
                toast('Add a front photo for this colour.', 'error');
                return;
              }

              const form = new FormData();
              form.append('name', name);
              form.append('hex', hex);
              if (frontFile) form.append('front', frontFile, frontFile.name);
              if (backFile) form.append('back', backFile, backFile.name);

              await withBusy('Adding colour…', () => api.shirts.addColorway(shirt.id, form));
              await store.loadShirts();
              toast('Colour added.', 'ok');
              close();
            },
          }),
        ),
    });
  }

  /** Print area in inches — what determines the size of the production file. */
  function openPrintAreaSheet(shirt) {
    const areas = structuredClone(shirt.printAreas);
    let view = 'front';

    return sheet({
      title: 'Print area',
      render: () => {
        const body = el('div');

        function paintBody() {
          const area = areas[view];
          setChildren(body,
            el(
              'p',
              { class: 'field-hint' },
              'The maximum imprint on this garment. Production pages are cut to exactly this size.',
            ),
            slider({
              label: 'Width',
              min: 2,
              max: 20,
              step: 0.5,
              value: area.widthIn,
              format: (v) => `${v}"`,
              onInput: (v) => {
                area.widthIn = v;
              },
            }),
            slider({
              label: 'Height',
              min: 2,
              max: 24,
              step: 0.5,
              value: area.heightIn,
              format: (v) => `${v}"`,
              onInput: (v) => {
                area.heightIn = v;
              },
            }),
          );
        }

        paintBody();

        return [
          segmented(
            [
              { value: 'front', label: 'Front' },
              { value: 'back', label: 'Back' },
            ],
            view,
            (value) => {
              view = value;
              paintBody();
            },
          ),
          body,
        ];
      },

      footer: (close) =>
        button('Save print area', {
          class: 'btn btn-primary btn-block',
          onClick: async () => {
            await withBusy('Saving…', () => api.shirts.update(shirt.id, { printAreas: areas }));
            await store.loadShirts();
            toast('Print area updated.', 'ok');
            close();
          },
        }),
    });
  }

  async function deleteShirt(shirt) {
    const ok = await confirmSheet({
      title: `Delete "${shirt.name}"?`,
      message: 'The shirt type and its colours are removed.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    try {
      await api.shirts.remove(shirt.id);
    } catch (err) {
      if (err.status !== 409) {
        toast(err.message, 'error');
        return;
      }
      const names = (err.details?.usedBy ?? []).map((design) => design.name).join(', ');
      const force = await confirmSheet({
        title: 'Designs use this shirt',
        message: `Still used by: ${names}. Those designs will no longer export.`,
        confirmLabel: 'Delete anyway',
        danger: true,
      });
      if (!force) return;
      await withBusy('Deleting…', () => api.shirts.remove(shirt.id, true));
    }

    await store.loadShirts();
    toast('Shirt type deleted.');
  }

  /** Add a shirt type: reuse a blank silhouette, or photograph a real garment. */
  function openNewShirtSheet() {
    let mode = 'shape';
    let shape = 'tee';
    let frontFile = null;
    let backFile = null;
    const fields = {};

    return sheet({
      title: 'Add a shirt type',
      render: () => {
        const body = el('div');

        fields.name = el('input', { type: 'text', placeholder: 'Carhartt K87 Pocket Tee' });
        fields.brand = el('input', { type: 'text', placeholder: 'Carhartt' });
        fields.width = el('input', { type: 'number', value: '12', min: '2', max: '20', step: '0.5' });
        fields.height = el('input', { type: 'number', value: '16', min: '2', max: '24', step: '0.5' });

        function shapePicker() {
          const chips = el('div', { class: 'chips' });
          for (const key of getState().shapes) {
            chips.append(
              el(
                'button',
                {
                  type: 'button',
                  class: 'chip',
                  'aria-pressed': String(key === shape),
                  dataset: { shape: key },
                  onClick: () => {
                    shape = key;
                    for (const chip of chips.children) {
                      chip.setAttribute('aria-pressed', String(chip.dataset.shape === key));
                    }
                    paintPreview();
                  },
                },
                SHAPE_LABELS[key] ?? key,
              ),
            );
          }
          return chips;
        }

        const preview = el('div', { class: 'preview-pane' });
        function paintPreview() {
          const template = getState().shirts.find((row) => row.shape === shape && row.builtIn);
          const url = template?.colorways[0]?.frontUrl;
          setChildren(preview,
            url ? el('img', { src: url, alt: '' }) : el('p', { class: 'field-hint' }, 'Preview unavailable'),
          );
        }

        const filePicker = (label, onPick) =>
          el(
            'label',
            { class: 'btn btn-block', style: { marginTop: '10px' } },
            icon('camera'),
            el('span', {}, label),
            el('input', {
              type: 'file',
              accept: 'image/png,image/jpeg',
              class: 'sr-only',
              onChange: (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                onPick(file);
                event.currentTarget.previousSibling.textContent = `${label} · ${file.name}`;
              },
            }),
          );

        function paintBody() {
          setChildren(body,
            mode === 'shape'
              ? el(
                  'div',
                  {},
                  preview,
                  el('div', { style: { marginTop: '12px' } }, el('span', { class: 'field-hint' }, 'Base shape'), shapePicker()),
                  el(
                    'p',
                    { class: 'field-hint' },
                    'Comes with six stock colours and can be tinted to any colour later.',
                  ),
                )
              : el(
                  'div',
                  {},
                  el(
                    'p',
                    { class: 'field-hint' },
                    'Photograph the blank garment flat, front and back, filling the frame.',
                  ),
                  filePicker('Front photo', (file) => {
                    frontFile = file;
                  }),
                  filePicker('Back photo (optional)', (file) => {
                    backFile = file;
                  }),
                ),
          );
          if (mode === 'shape') paintPreview();
        }

        paintBody();

        return [
          segmented(
            [
              { value: 'shape', label: 'Use a blank' },
              { value: 'photo', label: 'From photos' },
            ],
            mode,
            (value) => {
              mode = value;
              paintBody();
            },
          ),
          el('label', { class: 'field' }, el('span', {}, 'Name'), fields.name),
          el('label', { class: 'field' }, el('span', {}, 'Brand (optional)'), fields.brand),
          body,
          el(
            'div',
            { class: 'field-row', style: { marginTop: '14px' } },
            el('label', { class: 'field', style: { marginTop: 0 } }, el('span', {}, 'Print width (in)'), fields.width),
            el('label', { class: 'field', style: { marginTop: 0 } }, el('span', {}, 'Print height (in)'), fields.height),
          ),
        ];
      },

      footer: (close) =>
        button('Add shirt type', {
          class: 'btn btn-primary btn-block',
          onClick: async () => {
            const name = fields.name.value.trim();
            if (!name) {
              toast('Give the shirt type a name.', 'error');
              return;
            }
            if (mode === 'photo' && !frontFile) {
              toast('Add a front photo.', 'error');
              return;
            }

            const widthIn = Number(fields.width.value) || 12;
            const heightIn = Number(fields.height.value) || 16;
            // Keep the on-canvas box proportional to the real inches so the
            // mockup guide matches the production page.
            const canvasWidth = 386;
            const printAreas = {
              front: {
                x: 307,
                y: 366,
                width: canvasWidth,
                height: canvasWidth * (heightIn / widthIn),
                widthIn,
                heightIn,
              },
              back: {
                x: 307,
                y: 336,
                width: canvasWidth,
                height: canvasWidth * (heightIn / widthIn),
                widthIn,
                heightIn,
              },
            };

            const form = new FormData();
            form.append('name', name);
            form.append('brand', fields.brand.value.trim());
            form.append('printAreas', JSON.stringify(printAreas));

            if (mode === 'shape') {
              form.append('shape', shape);
              form.append('category', SHAPE_LABELS[shape] ?? 'Custom');
              form.append('colorways', JSON.stringify(NEW_COLORS));
            } else {
              form.append('category', 'Custom');
              form.append('colorName', 'As photographed');
              form.append('front', frontFile, frontFile.name);
              if (backFile) form.append('back', backFile, backFile.name);
            }

            await withBusy('Adding shirt type…', () => api.shirts.create(form));
            await store.loadShirts();
            toast('Shirt type added.', 'ok');
            close();
          },
        }),
    });
  }

  return () => unsubscribe();
}
