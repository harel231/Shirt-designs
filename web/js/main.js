import { store } from './store.js';
import { initTheme } from './theme.js';
import { clear, el, icon, toast } from './ui.js';
import { renderCreateScreen } from './screens/create.js';
import { renderShirtsScreen } from './screens/shirts.js';
import { renderDesignsScreen } from './screens/designs.js';
import { renderSharesScreen } from './screens/shares.js';
import { renderEditor } from './screens/editor.js';

/**
 * App shell: a hash router and a bottom tab bar.
 *
 * Hash routing keeps the whole app a single static file with no server-side
 * route table, and back/forward still work the way a phone user expects.
 */

const TABS = [
  { id: 'create', label: 'Create', icon: 'wand', route: '#/create' },
  { id: 'shirts', label: 'Shirts', icon: 'shirts', route: '#/shirts' },
  { id: 'designs', label: 'Designs', icon: 'designs', route: '#/designs' },
  { id: 'share', label: 'Share', icon: 'share', route: '#/share' },
];

const ROUTES = [
  { pattern: /^#\/create$/, tab: 'create', render: renderCreateScreen },
  { pattern: /^#\/shirts$/, tab: 'shirts', render: renderShirtsScreen },
  { pattern: /^#\/designs$/, tab: 'designs', render: renderDesignsScreen },
  { pattern: /^#\/share$/, tab: 'share', render: renderSharesScreen },
  { pattern: /^#\/design\/([\w-]+)$/, tab: null, render: renderEditor, fullscreen: true },
];

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

/** Lets the current screen clean up timers and listeners before it is replaced. */
let disposeCurrent = null;

export function navigate(route, { replace = false } = {}) {
  if (replace) window.location.replace(route);
  else window.location.hash = route;
}

function buildTabBar() {
  clear(tabbar);
  for (const tab of TABS) {
    tabbar.append(
      el(
        'button',
        {
          type: 'button',
          dataset: { tab: tab.id },
          'aria-current': 'false',
          onClick: () => navigate(tab.route),
        },
        icon(tab.icon),
        el('span', {}, tab.label),
      ),
    );
  }
}

function highlightTab(active) {
  for (const button of tabbar.querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.tab === active));
  }
  tabbar.hidden = active === null;
}

async function renderRoute() {
  const hash = window.location.hash || '#/create';
  const match = ROUTES.map((route) => ({ route, result: route.pattern.exec(hash) })).find(
    (entry) => entry.result,
  );

  if (!match) {
    navigate('#/create', { replace: true });
    return;
  }

  disposeCurrent?.();
  disposeCurrent = null;
  clear(app);
  highlightTab(match.route.tab);
  app.classList.toggle('app', !match.route.fullscreen);

  try {
    const result = await match.route.render({
      mount: app,
      params: match.result.slice(1),
      navigate,
    });
    if (typeof result === 'function') disposeCurrent = result;
  } catch (err) {
    console.error(err);
    clear(app);
    app.append(
      el(
        'div',
        { class: 'screen' },
        el('div', { class: 'note' }, icon('warn'), el('div', {}, err?.message ?? 'This screen failed to load.')),
      ),
    );
  }

  // A new screen always starts at the top, like a native push.
  window.scrollTo(0, 0);
}

async function boot() {
  // Before anything renders: index.html already applied the stored choice, this
  // takes over the setting and starts following the device if that is the pick.
  initTheme();
  buildTabBar();

  try {
    await store.init();
  } catch (err) {
    clear(app);
    app.append(
      el(
        'div',
        { class: 'screen' },
        el('div', { class: 'screen-head' }, el('h1', {}, 'Studio offline')),
        el(
          'div',
          { class: 'note' },
          icon('warn'),
          el(
            'div',
            {},
            err?.message ?? 'The studio server did not answer.',
            el('p', { style: { margin: '8px 0 0' } }, 'Start it with ', el('code', {}, 'npm start'), ' and reload.'),
          ),
        ),
        el(
          'div',
          { class: 'btn-stack' },
          el('button', { class: 'btn btn-primary', onClick: () => window.location.reload() }, 'Try again'),
        ),
      ),
    );
    return;
  }

  window.addEventListener('hashchange', renderRoute);
  await renderRoute();
}

window.addEventListener('unhandledrejection', (event) => {
  // Errors already surfaced by withBusy are re-thrown; do not double-report.
  if (event.reason?.handled) return;
  console.error(event.reason);
});

boot();

export { TABS };
