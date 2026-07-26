/* js/views/topic.js — STUB (Job A2 scaffold).
   Owner: Job B (core study). Replace this whole file; keep the export shape.

   ROUTE CONTRACT (do not change — search, maps and home all link here):
       #/topic?id=<topicId>
   Optional secondary params already emitted by the search index:
       &note=<noteId>   scroll to / open a specific note */

import { stubView } from './_stub.js';
import { el, icon, fmt } from '../dom.js';
import { getTopic, getTopics } from '../vault.js';
import { routeFor } from '../router.js';

export default stubView({
  id: 'topic',
  title: 'Topic',
  icon: 'layers',
  owner: 'Job B (core study)',
  hint: 'One CDC unit end to end: mission, map, lessons, cards, numericals, ' +
        'reference sweep state and the 8-state study-loop position.',

  extra(root, params) {
    const id = params.id || (params._path && params._path[0]) || '';
    const topic = getTopic(id);

    if (topic) {
      root.appendChild(el('section.stub__resolve',
        el('h2.stub__resolve-title', icon('circle-check', { size: 14 }),
          el('span', { text: topic.name })),
        el('dl.stub__dl',
          el('dt', { text: 'subject' }), el('dd', el('code', { text: topic.subject })),
          el('dt', { text: 'unit' }), el('dd', el('code', { text: topic.unit || '(not declared in MISSION.md frontmatter)' })),
          el('dt', { text: 'cards' }), el('dd', el('code', { text: fmt.int(topic.flashcards.length) })),
          el('dt', { text: 'docs' }), el('dd', el('code', { text: fmt.int(topic.docs.length) })),
          el('dt', { text: 'notes' }), el('dd', el('code', { text: fmt.int(topic.notes.length) })),
          el('dt', { text: 'mindmap' }), el('dd', el('code', { text: topic.mindmap ? 'present' : 'none' }))
        ),
        topic.description ? el('p.stub__desc', { text: topic.description }) : null
      ));
      return;
    }

    const all = getTopics();
    root.appendChild(el('section.stub__resolve',
      el('h2.stub__resolve-title', icon('circle-alert', { size: 14 }),
        el('span', { text: id ? 'No topic with id “' + id + '”' : 'No topic id in the route' })),
      all.length
        ? el('ul.stub__list', all.map((t) =>
            el('li', el('a', { href: routeFor('topic', { id: t.id }), text: t.name + ' · ' + t.subject }))))
        : el('p.stub__desc', { text: 'The vault has no topics yet — run generate_data.py, or drop a vault-data.js next to index.html.' })
    ));
  },
});
