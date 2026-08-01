import { api } from '../api.js';
import { getState, store, subscribe } from '../store.js';
import {
  button,
  confirmSheet,
  el,
  emptyState,
  formatDate,
  icon,
  setChildren,
  sheet,
  toast,
  withBusy,
} from '../ui.js';

/**
 * Saved shirt designs — the work in flight between the studio and the printer.
 */

export function renderDesignsScreen({ mount, navigate }) {
  const screen = el('div', { class: 'screen' });
  mount.append(screen);

  const unsubscribe = subscribe(paint);
  store.loadDesigns();
  paint();

  function paint() {
    const { designs, shirts } = getState();

    setChildren(screen,
      el(
        'div',
        { class: 'screen-head' },
        el('h1', {}, 'Designs'),
        el('p', {}, 'Everything you have laid out on a shirt.'),
      ),

      designs.length === 0
        ? emptyState({
            title: 'No designs yet',
            message: 'Pick a shirt to start laying out artwork.',
            action: button('Browse shirts', {
              class: 'btn btn-primary',
              onClick: () => navigate('#/shirts'),
            }),
          })
        : el('div', {}, ...designs.map((design) => designRow(design, shirts))),
    );
  }

  function designRow(design, shirts) {
    const shirt = shirts.find((row) => row.id === design.shirtTypeId);
    const thumb = shirt ? api.shirts.renderUrl(shirt.id, 'front', design.colorHex) : null;

    return el(
      'button',
      { class: 'row', onClick: () => navigate(`#/design/${design.id}`) },
      el(
        'div',
        { class: 'thumb' },
        thumb ? el('img', { src: thumb, alt: '', loading: 'lazy' }) : icon('shirts'),
      ),
      el(
        'div',
        { class: 'row-body' },
        el('strong', { class: 'truncate' }, design.name),
        el(
          'span',
          { class: 'truncate' },
          `${shirt?.name ?? 'Shirt removed'} · ${design.layerCount ?? 0} item${design.layerCount === 1 ? '' : 's'} · ${formatDate(design.updatedAt)}`,
        ),
      ),
      el(
        'span',
        {
          class: 'icon-btn',
          role: 'button',
          'aria-label': 'More',
          onClick: (event) => {
            event.stopPropagation();
            openDesignSheet(design, shirt);
          },
        },
        icon('layers'),
      ),
    );
  }

  function openDesignSheet(design, shirt) {
    return sheet({
      title: design.name,
      render: (close) => [
        el(
          'p',
          { class: 'field-hint' },
          `${shirt?.name ?? 'Shirt removed'} · updated ${formatDate(design.updatedAt)}`,
        ),
        el(
          'div',
          { class: 'btn-stack' },
          button('Open in canvas', {
            class: 'btn btn-primary',
            iconName: 'wand',
            onClick: () => {
              close();
              navigate(`#/design/${design.id}`);
            },
          }),
          button('Export print files', {
            class: 'btn',
            iconName: 'share',
            onClick: async () => {
              close();
              await exportDesign(design);
            },
          }),
          button('Duplicate', {
            class: 'btn btn-ghost',
            iconName: 'copy',
            onClick: async () => {
              await withBusy('Duplicating…', () => api.designs.duplicate(design.id));
              await store.loadDesigns();
              toast('Duplicated.', 'ok');
              close();
            },
          }),
          button('Delete', {
            class: 'btn btn-ghost btn-danger',
            iconName: 'trash',
            onClick: async () => {
              close();
              const ok = await confirmSheet({
                title: `Delete "${design.name}"?`,
                message: 'The layout is removed. Your library artwork is untouched.',
                confirmLabel: 'Delete',
                danger: true,
              });
              if (!ok) return;
              await withBusy('Deleting…', () => api.designs.remove(design.id));
              await store.loadDesigns();
              toast('Design deleted.');
            },
          }),
        ),
      ],
    });
  }

  async function exportDesign(design) {
    const record = await withBusy('Building print files…', () => api.designs.export(design.id));
    await store.loadExports();
    const { openExportSheet } = await import('./shares.js');
    await openExportSheet(record);
  }

  return () => unsubscribe();
}
