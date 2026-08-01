import { api } from '../api.js';
import { el, icon, sheet } from '../ui.js';

/**
 * Google Fonts picker.
 *
 * Every row previews the family as server-rendered vector outlines — the exact
 * shapes that will be printed. Nothing is loaded as a webfont, so the picker
 * behaves identically on a phone that has never seen the family before.
 */

const PAGE_SIZE = 24;

export function openFontPicker({ current, sampleText = 'Handgloves' } = {}) {
  return sheet({
    title: 'Choose a font',
    render: (close) => {
      const results = el('div', { class: 'font-list' });
      const status = el('p', { class: 'field-hint' }, 'Loading the catalog…');
      const more = el('button', { class: 'btn btn-ghost btn-block', hidden: true }, 'Show more');

      let query = '';
      let category = '';
      let offset = 0;
      let total = 0;
      let token = 0;

      const preview = (family, weight) =>
        el('img', {
          src: api.fonts.sampleUrl(family, {
            text: sampleText,
            weight,
            size: 34,
            color: getComputedStyle(document.body).getPropertyValue('--ink').trim() || '#f1f2f6',
          }),
          alt: '',
          loading: 'lazy',
          // A family whose file will not download must not leave a broken box.
          onError: (event) => {
            event.target.replaceWith(el('span', { class: 'field-hint' }, family));
          },
        });

      async function load({ reset = false } = {}) {
        const run = ++token;
        if (reset) {
          offset = 0;
          results.replaceChildren();
        }

        status.hidden = false;
        status.textContent = 'Searching…';

        try {
          const page = await api.fonts.search({ q: query, category, limit: PAGE_SIZE, offset });
          if (run !== token) return;

          total = page.total;
          for (const font of page.items) {
            const weight = font.weights.includes(400) ? 400 : (font.weights[0] ?? 400);
            results.append(
              el(
                'button',
                {
                  type: 'button',
                  class: 'font-item',
                  'aria-pressed': String(font.family === current),
                  onClick: () => close(font),
                },
                el('span', { class: 'sample' }, preview(font.family, weight)),
                el('span', { class: 'name' }, font.family),
                font.family === current ? icon('check') : null,
              ),
            );
          }

          offset += page.items.length;
          more.hidden = offset >= total;
          status.hidden = total > 0;
          status.textContent = total === 0 ? 'No families match that search.' : '';
        } catch (err) {
          if (run !== token) return;
          status.hidden = false;
          status.textContent = err.message;
        }
      }

      more.addEventListener('click', () => load());

      const search = el('input', {
        type: 'text',
        placeholder: 'Search 1,900+ families',
        onInput: (event) => {
          query = event.target.value.trim();
          clearTimeout(search.timer);
          search.timer = setTimeout(() => load({ reset: true }), 220);
        },
      });

      const chips = el('div', { class: 'chips' });
      const categories = [
        { name: '', label: 'All' },
        { name: 'sans-serif', label: 'Sans' },
        { name: 'serif', label: 'Serif' },
        { name: 'display', label: 'Display' },
        { name: 'handwriting', label: 'Script' },
        { name: 'monospace', label: 'Mono' },
      ];

      for (const entry of categories) {
        chips.append(
          el(
            'button',
            {
              type: 'button',
              class: 'chip',
              'aria-pressed': String(entry.name === category),
              onClick: (event) => {
                category = entry.name;
                for (const chip of chips.children) chip.setAttribute('aria-pressed', 'false');
                event.currentTarget.setAttribute('aria-pressed', 'true');
                load({ reset: true });
              },
            },
            entry.label,
          ),
        );
      }

      load({ reset: true });

      return [
        el('label', { class: 'field' }, search),
        chips,
        el('div', { style: { marginTop: '12px' } }, results),
        status,
        more,
      ];
    },
  });
}
