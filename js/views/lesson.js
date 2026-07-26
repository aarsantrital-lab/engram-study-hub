/* js/views/lesson.js — STUB (Job A2 scaffold).
   Owner: Job C (maps & content). Replace this whole file; keep the export shape.

   ROUTE CONTRACT (do not change — search results and mindmap nodes link here):
       #/lesson?topic=<topicId>&file=<url>
   `file` is the doc.url exactly as generate_data.py wrote it into vault-data.js,
   e.g. assets/mole-concept/lessons/0001-what-is-a-mole.html — a self-contained
   offline HTML file (build-constraints §4). Render it in an <iframe> or fetch
   and inject; never rewrite its inline CSS/JS. */

import { stubView } from './_stub.js';
import { el, icon } from '../dom.js';
import { safeUrl } from '../md.js';
import { getTopic, getLessons } from '../vault.js';
import { routeFor } from '../router.js';

export default stubView({
  id: 'lesson',
  title: 'Lesson',
  icon: 'book-open',
  owner: 'Job C (maps & content)',
  hint: 'A single self-contained lesson file: prediction gate, one manipulable model, ' +
        'at least two embedded retrieval checks, reveal-gated produced-answer problems, ' +
        'a precise citation and a next-lesson link.',

  extra(root, params) {
    const topicId = params.topic || (params._path && params._path[0]) || '';
    const file = params.file || '';
    const safeFile = safeUrl(file);
    const topic = getTopic(topicId);

    const rows = [
      ['topic param', topicId || '(none)'],
      ['file param', file || '(none)'],
      ['topic resolved', topic ? topic.name + ' · ' + topic.subject : 'not found in vault'],
    ];

    root.appendChild(el('section.stub__resolve',
      el('h2.stub__resolve-title', icon('external-link', { size: 14 }), el('span', { text: 'Route resolution' })),
      el('dl.stub__dl', rows.flatMap(([k, v]) => [
        el('dt', { text: k }), el('dd', el('code', { text: String(v) })),
      ])),
      // `file` comes from the hash route, so it is attacker-controllable: a
      // shared note holding [open](#/lesson?file=javascript:alert(1)) would
      // otherwise paint a button whose href executes on click. Checked here so
      // the button disappears entirely, and again centrally in dom.js.
      safeFile
        ? el('a.btn.btn-ghost', { href: safeFile, target: '_blank', rel: 'noopener' },
            icon('external-link', { size: 14 }), el('span', { text: 'Open the lesson file directly' }))
        : null
    ));

    const lessons = getLessons(topicId || undefined);
    if (lessons.length) {
      root.appendChild(el('section.stub__resolve',
        el('h2.stub__resolve-title', icon('list', { size: 14 }),
          el('span', { text: 'Lessons in the vault (' + lessons.length + ')' })),
        el('ul.stub__list', lessons.slice(0, 12).map((d) =>
          el('li', el('a', { href: routeFor('lesson', { topic: d.topicId, file: d.url }), text: d.title }))))
      ));
    }
  },
});
