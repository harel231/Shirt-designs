import { api } from '../api.js';
import { getState, store, subscribe } from '../store.js';
import {
  button,
  confirmSheet,
  el,
  emptyState,
  formatBytes,
  formatDate,
  icon,
  setChildren,
  sheet,
  toast,
  withBusy,
} from '../ui.js';

/**
 * Shared folders — the handoff to the print vendor.
 *
 * An export is a folder of finished files behind an unguessable link. The
 * vendor opens it in any browser: no account, no app, nothing to install.
 */

export function renderSharesScreen({ mount, navigate }) {
  const screen = el('div', { class: 'screen' });
  mount.append(screen);

  const unsubscribe = subscribe(paint);
  store.loadExports();
  paint();

  function paint() {
    const { exports } = getState();

    setChildren(screen,
      el(
        'div',
        { class: 'screen-head' },
        el('h1', {}, 'Share'),
        el('p', {}, 'Folders of print-ready files you can send straight to a vendor.'),
      ),

      exports.length === 0
        ? emptyState({
            title: 'Nothing exported yet',
            message: 'Finish a design and export it to get a link you can email your printer.',
            action: button('Go to designs', {
              class: 'btn btn-primary',
              onClick: () => navigate('#/designs'),
            }),
          })
        : el('div', {}, ...exports.map(exportRow)),
    );
  }

  function exportRow(record) {
    const problems = (record.warnings ?? []).filter((warning) => warning.level === 'error');

    return el(
      'button',
      { class: 'row', onClick: () => openShareSheet(record) },
      el('div', { class: 'thumb' }, icon('share')),
      el(
        'div',
        { class: 'row-body' },
        el('strong', { class: 'truncate' }, record.name),
        el(
          'span',
          { class: 'truncate' },
          `${record.fileCount} files · ${formatDate(record.createdAt)}`,
        ),
      ),
      problems.length > 0
        ? el('span', { class: 'pill', style: { color: 'var(--warn)' } }, icon('warn'), String(problems.length))
        : null,
      el('span', { class: 'chev' }, icon('chev')),
    );
  }

  function openShareSheet(record) {
    return sheet({
      title: record.name,
      render: (close) => [
        el('p', { class: 'field-hint' }, `Prepared ${formatDate(record.createdAt)}`),
        linkBlock(record.shareUrl),
        (record.warnings ?? []).length > 0 ? warningsBlock(record.warnings) : null,
        el(
          'div',
          { class: 'btn-stack' },
          button('Open the folder', {
            class: 'btn btn-primary',
            iconName: 'link',
            // A plain same-tab navigation, not window.open: on a phone with
            // this app added to the home screen, a new browsing context has
            // no back button of its own to return with. The share page
            // itself carries a link back into the app.
            onClick: () => { window.location.href = record.shareUrl; },
          }),
          button('Download everything (.zip)', {
            class: 'btn',
            iconName: 'download',
            onClick: () => { window.location.href = `${record.shareUrl}/download.zip`; },
          }),
          button('Revoke this link', {
            class: 'btn btn-ghost btn-danger',
            iconName: 'trash',
            onClick: async () => {
              close();
              const ok = await confirmSheet({
                title: 'Revoke the link?',
                message: 'Anyone holding it, including your printer, will lose access immediately.',
                confirmLabel: 'Revoke',
                danger: true,
              });
              if (!ok) return;
              await withBusy('Revoking…', () => api.exports.revoke(record.id));
              await store.loadExports();
              toast('Link revoked.');
            },
          }),
        ),
      ],
    });
  }

  return () => unsubscribe();
}

/** Shown straight after an export, with the files that were produced. */
export function openExportSheet(record) {
  const problems = (record.warnings ?? []).filter((warning) => warning.level === 'error');

  return sheet({
    title: 'Ready for your printer',
    render: () => [
      problems.length > 0
        ? el(
            'div',
            { class: 'note' },
            icon('warn'),
            el('div', {}, 'Exported, but check these first:', el('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } }, ...problems.map((p) => el('li', {}, p.message)))),
          )
        : el(
            'div',
            { class: 'note info' },
            icon('check'),
            el('div', {}, 'Everything checks out for production.'),
          ),

      linkBlock(record.shareUrl),

      button('Download everything (.zip)', {
        class: 'btn btn-primary btn-block',
        style: { marginTop: '12px' },
        iconName: 'download',
        onClick: () => { window.location.href = `${record.shareUrl}/download.zip`; },
      }),

      el('div', { class: 'section-head' }, el('h2', {}, 'In the folder')),
      ...record.files.map((file) =>
        el(
          // A plain link with the browser's own download behaviour (no
          // target="_blank") — the server sends Content-Disposition:
          // attachment for ?download=true, so this saves the file instead of
          // opening an in-app PDF preview with no way back to the app.
          'a',
          { class: 'row', href: `${file.url}?download=true` },
          el('div', { class: 'thumb' }, icon(file.role === 'spec' ? 'info' : 'download')),
          el(
            'div',
            { class: 'row-body' },
            el('strong', { class: 'truncate' }, file.name.split('/').pop()),
            el('span', {}, `${file.description}`),
          ),
          el('span', { class: 'pill' }, formatBytes(file.bytes)),
        ),
      ),

      record.spec?.distinctInkColors?.length
        ? el(
            'div',
            { class: 'card', style: { marginTop: '14px' } },
            el(
              'strong',
              { style: { fontSize: '14px' } },
              `${record.spec.distinctInkColors.length} ink colour${record.spec.distinctInkColors.length === 1 ? '' : 's'}`,
            ),
            el(
              'div',
              { class: 'swatches' },
              ...record.spec.distinctInkColors.map((ink) =>
                el('span', { class: 'swatch', style: { background: ink }, title: ink }),
              ),
            ),
          )
        : null,
    ],

    footer: (close) =>
      el(
        'div',
        { class: 'btn-row' },
        button('Done', { class: 'btn btn-ghost', onClick: () => close() }),
        button('Send to printer', {
          class: 'btn btn-primary',
          iconName: 'share',
          onClick: () => shareLink(record),
        }),
      ),
  });
}

function linkBlock(url) {
  return el(
    'div',
    { class: 'card', style: { marginTop: '12px' } },
    el('span', { class: 'field-hint' }, 'Share link'),
    el(
      'p',
      {
        style: {
          margin: '6px 0 10px',
          wordBreak: 'break-all',
          fontSize: '13px',
          color: 'var(--accent)',
        },
      },
      url,
    ),
    el(
      'div',
      { class: 'btn-row' },
      button('Copy link', {
        class: 'btn btn-sm',
        iconName: 'copy',
        onClick: () => copyToClipboard(url),
      }),
      button('Open', {
        class: 'btn btn-sm',
        iconName: 'link',
        onClick: () => { window.location.href = url; },
      }),
    ),
  );
}

function warningsBlock(warnings) {
  return el(
    'div',
    { class: 'note', style: { marginTop: '12px' } },
    icon('warn'),
    el(
      'div',
      {},
      ...warnings.map((warning) => el('div', {}, `${warning.view}: ${warning.message}`)),
    ),
  );
}

/** Uses the OS share sheet where available, falling back to the clipboard. */
async function shareLink(record) {
  const payload = {
    title: `${record.name} — print files`,
    text: `Print-ready files for "${record.name}".`,
    url: record.shareUrl,
  };

  if (navigator.share) {
    try {
      await navigator.share(payload);
      return;
    } catch (err) {
      // A cancelled share is not an error worth reporting.
      if (err?.name === 'AbortError') return;
    }
  }

  await copyToClipboard(record.shareUrl);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied.', 'ok');
  } catch {
    // Clipboard access is blocked outside a secure context; show it instead.
    window.prompt('Copy this link', text);
  }
}
