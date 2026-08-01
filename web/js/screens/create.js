import { api } from '../api.js';
import { assetImg } from '../asset-image.js';
import { getState, store, subscribe } from '../store.js';
import { getThemePreference, setThemePreference, THEME_OPTIONS } from '../theme.js';
import {
  button,
  confirmSheet,
  el,
  emptyState,
  formatDate,
  icon,
  promptSheet,
  segmented,
  setChildren,
  sheet,
  toast,
  withBusy,
} from '../ui.js';
import { openImageTool } from './image-tool.js';
import { openTextTool } from './text-tool.js';

/**
 * Content Creation Hub.
 *
 * Two ways in — an image or a piece of type — and one way out: the design
 * library, which holds only what was explicitly saved here. Work in progress
 * stays in a separate drafts shelf so experiments never clutter the library
 * you drag from when designing a shirt.
 */

export function renderCreateScreen({ mount }) {
  const screen = el('div', { class: 'screen' });
  mount.append(screen);

  const unsubscribe = subscribe(paint);
  paint();

  function paint() {
    const { library, drafts, health } = getState();

    setChildren(screen,
      el(
        'div',
        { class: 'screen-head' },
        el(
          'div',
          { class: 'head-row' },
          el('h1', {}, 'Create'),
          el(
            'button',
            {
              type: 'button',
              class: 'icon-btn',
              'aria-label': 'Appearance',
              onClick: () => openAppearanceSheet(),
            },
            icon('contrast'),
          ),
        ),
        el(
          'p',
          {},
          'Cut out artwork, trace it to vector and set type in any of the ',
          `${(health?.fonts.families ?? 0).toLocaleString()} Google Fonts.`,
        ),
      ),

      el(
        'div',
        { class: 'btn-row' },
        uploadButton(),
        button('Add text', {
          class: 'btn btn-primary',
          iconName: 'text',
          onClick: () => openTextTool(),
        }),
      ),

      drafts.length > 0 ? draftsSection(drafts) : null,

      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'Design library'),
        el('span', { class: 'count' }, `${library.length} item${library.length === 1 ? '' : 's'}`),
      ),

      library.length === 0
        ? emptyState({
            title: 'Nothing saved yet',
            message:
              'Artwork you save here is what you drag onto a shirt in the design canvas.',
          })
        : el('div', { class: 'grid' }, ...library.map(assetTile)),
    );
  }

  function uploadButton() {
    const input = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,application/pdf',
      class: 'sr-only',
      onChange: async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;

        const asset = await withBusy('Uploading…', () => api.assets.upload(file));
        store.cacheAsset(asset);
        await openImageTool(asset);
        await store.loadLibrary();
      },
    });

    return el(
      'label',
      { class: 'btn', style: { flex: '1' } },
      icon('image'),
      'Add image or PDF',
      input,
    );
  }

  function draftsSection(drafts) {
    return el(
      'section',
      {},
      el(
        'div',
        { class: 'section-head' },
        el('h2', {}, 'In progress'),
        el(
          'button',
          {
            class: 'count',
            style: { background: 'none', border: 0, color: 'var(--faint)' },
            onClick: async () => {
              const ok = await confirmSheet({
                title: 'Clear drafts?',
                message: `Discard ${drafts.length} unsaved item${drafts.length === 1 ? '' : 's'}. Anything already saved to the library is untouched.`,
                confirmLabel: 'Discard',
                danger: true,
              });
              if (!ok) return;
              await withBusy('Clearing…', async () => {
                for (const draft of drafts) await api.assets.remove(draft.id, true).catch(() => {});
              });
              await store.loadLibrary();
            },
          },
          'Clear',
        ),
      ),
      ...drafts.slice(0, 6).map((asset) =>
        el(
          'button',
          {
            class: 'row',
            onClick: async () => {
              await openImageTool(asset);
              await store.loadLibrary();
            },
          },
          assetThumb(asset),
          el(
            'div',
            { class: 'row-body' },
            el('strong', { class: 'truncate' }, asset.name),
            el('span', {}, `${describeSource(asset)} · not saved yet`),
          ),
          el('span', { class: 'chev' }, icon('chev')),
        ),
      ),
    );
  }

  function assetTile(asset) {
    return el(
      'button',
      {
        class: 'tile',
        onClick: () => openAssetSheet(asset),
      },
      el('div', { class: 'tile-art checker' }, assetImg(asset, { alt: '', loading: 'lazy' })),
      el(
        'div',
        { class: 'tile-label' },
        el('strong', { class: 'truncate' }, asset.name),
        el('span', {}, describeSource(asset)),
        asset.palette?.length
          ? el(
              'div',
              { class: 'swatches' },
              ...asset.palette
                .slice(0, 8)
                .map((ink) => el('span', { class: 'swatch', style: { background: ink.color } })),
            )
          : null,
      ),
    );
  }

  function openAssetSheet(asset) {
    return sheet({
      title: asset.name,
      render: (close) => [
        el(
          'div',
          { class: 'preview-pane checker' },
          assetImg(asset, { alt: asset.name }),
        ),
        el(
          'p',
          { class: 'field-hint' },
          `${describeSource(asset)} · ${formatSize(asset)} · added ${formatDate(asset.createdAt)}`,
        ),
        asset.kind === 'raster'
          ? el(
              'div',
              { class: 'note', style: { marginTop: '12px' } },
              icon('warn'),
              el(
                'div',
                {},
                'This is still a bitmap. Trace it to vector for the cleanest print at large sizes.',
              ),
            )
          : null,
        el(
          'div',
          { class: 'btn-stack' },
          asset.text
            ? button('Edit text', {
                class: 'btn',
                iconName: 'text',
                onClick: async () => {
                  close();
                  const created = await openTextTool({ initial: asset.text });
                  if (created) await store.loadLibrary();
                },
              })
            : null,
          asset.kind === 'raster'
            ? button('Open in workbench', {
                class: 'btn',
                iconName: 'wand',
                onClick: async () => {
                  close();
                  await openImageTool(asset);
                  await store.loadLibrary();
                },
              })
            : null,
          button('Rename', {
            class: 'btn btn-ghost',
            onClick: async () => {
              const name = await promptSheet({
                title: 'Rename',
                label: 'Name',
                value: asset.name,
              });
              if (!name) return;
              await withBusy('Renaming…', () => api.assets.rename(asset.id, name));
              await store.loadLibrary();
              close();
            },
          }),
          button('Delete', {
            class: 'btn btn-ghost btn-danger',
            iconName: 'trash',
            onClick: async () => {
              close();
              await deleteAsset(asset);
            },
          }),
        ),
      ],
    });
  }

  async function deleteAsset(asset) {
    const ok = await confirmSheet({
      title: `Delete "${asset.name}"?`,
      message: 'This removes it from your library for good.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;

    try {
      await api.assets.remove(asset.id);
    } catch (err) {
      if (err.status !== 409) {
        toast(err.message, 'error');
        return;
      }

      const names = (err.details?.usedBy ?? []).map((design) => design.name).join(', ');
      const force = await confirmSheet({
        title: 'Still in use',
        message: `This artwork is placed on: ${names}. Deleting it will leave a gap in those designs.`,
        confirmLabel: 'Delete anyway',
        danger: true,
      });
      if (!force) return;
      await withBusy('Deleting…', () => api.assets.remove(asset.id, true));
    }

    await store.loadLibrary();
    toast('Deleted.');
  }

  return () => unsubscribe();
}

/**
 * Appearance. Lives here because Create is where the app opens, and it is a
 * setting you reach for once and then forget about.
 */
function openAppearanceSheet() {
  return sheet({
    title: 'Appearance',
    render: () => {
      const host = el('div');

      const paint = () =>
        setChildren(host,
          segmented(THEME_OPTIONS, getThemePreference(), (value) => {
            setThemePreference(value);
            paint();
          }),
        );

      paint();

      return [
        host,
        el(
          'p',
          { class: 'field-hint', style: { marginTop: '10px' } },
          'The studio opens light so artwork reads the way it will on press. Match device follows your phone instead.',
        ),
      ];
    },
  });
}

function assetThumb(asset) {
  return el('div', { class: 'thumb checker' }, assetImg(asset, { alt: '', loading: 'lazy' }));
}

/**
 * Artwork dimensions. A PDF page is measured in points and can carry them to
 * six decimal places — nobody needs to read those.
 */
function formatSize(asset) {
  const size = `${Math.round(asset.width)} × ${Math.round(asset.height)}`;
  if (asset.format === 'pdf') return `${size} pt`;
  return asset.kind === 'raster' ? `${size} px` : size;
}

function describeSource(asset) {
  switch (asset.source) {
    case 'text':
      return `Text · ${asset.text?.family ?? 'outlined'}`;
    case 'vectorized':
      return `Vector · ${asset.palette?.length ?? 0} ink${(asset.palette?.length ?? 0) === 1 ? '' : 's'}`;
    case 'background-removed':
      return 'Cut out';
    case 'pdf-upload':
      return 'Vector · from PDF';
    default:
      return asset.kind === 'vector' ? 'Vector' : 'Image';
  }
}

export { describeSource, assetThumb };
