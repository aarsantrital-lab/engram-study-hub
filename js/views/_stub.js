/* =============================================================================
   js/views/_stub.js — the placeholder body every view stub shares.
   Job A2. DISPOSABLE: once every view has been written for real, delete this
   file and its imports. Feature agents REPLACE the whole view file they own;
   they never edit registry.js.

   Each stub proves the three things a view depends on actually work:
     1. store.js round-trips (a per-view visit counter that survives reload)
     2. theme.css tokens resolve (live swatches read with getComputedStyle)
     3. vault.js + route params arrive intact
   ========================================================================== */

import { el, icon, fmt, token, emptyState } from '../dom.js';
import { store, KEYS, todayLocalISO } from '../store.js';
import { getVault, isVaultMissing } from '../vault.js';

const TOKENS = ['--bg', '--surface', '--fg', '--fg-muted', '--border', '--brand', '--good', '--warn', '--bad', '--info'];

/**
 * Build a stub view module.
 * @param {{id:string, title:string, icon:string, hint:string,
 *          owner?:string, extra?:(el:HTMLElement, params:Object)=>void}} spec
 */
export function stubView(spec) {
  return {
    id: spec.id,
    title: spec.title,
    icon: spec.icon,

    render(root, params) {
      /* ---- 1. store round-trip -------------------------------------- */
      const ui = store.update(KEYS.UI, (prev) => {
        const next = Object.assign({ stubVisits: {} }, prev);
        next.stubVisits = Object.assign({}, next.stubVisits);
        next.stubVisits[spec.id] = (next.stubVisits[spec.id] || 0) + 1;
        next.lastView = spec.id;
        next.lastViewDay = todayLocalISO();
        return next;
      }, { stubVisits: {} });
      const visits = ui.stubVisits[spec.id];

      /* ---- 2. token probe ------------------------------------------- */
      const swatches = TOKENS.map((name) => {
        const value = token(name);
        return el('div.stub__swatch', { attrs: { title: name + ': ' + (value || 'MISSING') } },
          el('span.stub__chip', { style: { background: value || 'transparent', borderColor: 'var(--border-strong, rgba(255,255,255,.12))' } }),
          el('code.stub__tokname', { text: name }),
          el('code.stub__tokval', { text: value || '— not loaded —' })
        );
      });
      const tokensOk = Boolean(token('--brand'));

      /* ---- 3. vault + params ---------------------------------------- */
      const vault = getVault();
      const paramKeys = Object.keys(params || {}).filter((k) => k !== '_path');

      root.append(
        el('header.stub__head',
          el('div.stub__eyebrow', el('span.eyebrow__dot'), el('span', { text: 'Engram v2 · scaffold' })),
          el('h1.stub__title', icon(spec.icon, { size: 20 }), el('span', { text: spec.title })),
          el('p.stub__hint', { text: spec.hint })
        ),

        el('div.stub__note', { dataset: { tone: 'info' } },
          icon('edit', { size: 14 }),
          el('span', { text: 'Placeholder view — ' + (spec.owner || 'a feature agent') +
            ' replaces js/views/' + spec.id + '.js wholesale. The shell, router, store and search around it are final.' })
        ),

        el('section.stub__grid',
          probe('Store',
            store.isMemoryOnly ? 'memory only'
              : store.hasUnsavedData() ? fmt.int(store.unsavedKeys().length) + ' unsaved'
              : 'localStorage',
            !store.isMemoryOnly && !store.hasUnsavedData(),
            'Visit ' + fmt.int(visits) + ' of this view · schema v' + store.schema +
            ' · ' + fmt.bytes(store.usageBytes()) + ' used'),
          probe('Theme tokens', tokensOk ? 'theme.css loaded' : 'theme.css MISSING', tokensOk,
            tokensOk ? '--brand resolves to ' + token('--brand') : 'Shell falls back to inline defaults'),
          probe('Vault', isVaultMissing() ? 'vault-data.js missing' : 'schema ' + vault.schema, !isVaultMissing(),
            isVaultMissing()
              ? 'Friendly empty state active — this is the required fallback, not a bug'
              : fmt.int(vault.counts.topics) + ' topics · ' + fmt.int(vault.counts.flashcards) + ' cards · ' +
                fmt.int(vault.counts.docs) + ' docs'),
          probe('Route params', paramKeys.length ? paramKeys.join(', ') : 'none', true,
            paramKeys.length
              ? paramKeys.map((k) => k + ' = ' + params[k]).join('  ·  ')
              : 'Pass some: #/' + spec.id + '?demo=1')
        ),

        el('details.stub__tokens',
          el('summary', { text: 'Design tokens resolving right now' }),
          el('div.stub__swatches', swatches)
        )
      );

      if (typeof spec.extra === 'function') {
        try { spec.extra(root, params || {}); }
        catch (err) {
          root.appendChild(el('div.stub__note', { dataset: { tone: 'bad' }, text: 'stub extra failed: ' + err.message }));
        }
      }
    },
  };
}

function probe(label, value, ok, detail) {
  return el('div.stub__probe', { dataset: { ok: ok ? 'yes' : 'no' } },
    el('div.stub__probe-label', { text: label }),
    el('div.stub__probe-value', icon(ok ? 'circle-check' : 'circle-alert', { size: 14 }), el('span', { text: value })),
    el('div.stub__probe-detail', { text: detail })
  );
}

export { emptyState };
