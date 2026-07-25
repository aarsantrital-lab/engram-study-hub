/* app.js — Engram Study Console
   Views: Today · Study · Topics · Mind map · Stats
   Everything is rendered client-side from window.VAULT_DATA + Store. */

(function () {
  'use strict';

  // ------------------------------------------------------------ helpers
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return MD.esc(s == null ? '' : s); };

  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  function toast(msg, ms) {
    var t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.hidden = true; }, ms || 1900);
  }

  function typeset(root) {
    if (!window.renderMathInElement) return;
    try {
      renderMathInElement(root, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false
      });
    } catch (e) { /* non-fatal */ }
  }

  function plural(n, s, p) { return n + ' ' + (n === 1 ? s : (p || s + 's')); }

  function relDate(isoStr) {
    var d = SRS.parse(isoStr), t = SRS.today();
    var n = Math.round((d - t) / SRS.DAY);
    if (n < -1) return Math.abs(n) + 'd overdue';
    if (n === -1) return '1d overdue';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n < 30) return 'in ' + n + 'd';
    return 'in ' + Math.round(n / 30) + 'mo';
  }

  // ------------------------------------------------------------ data model
  var DATA = window.VAULT_DATA || { topics: [], library: [] };
  var App = {
    view: 'today',
    subject: null,
    topicId: null,
    session: null,
    mode: 'recall'
  };

  /** merged card list for a topic: vault cards + user cards, minus suspended */
  function cardsOf(topic, includeSuspended) {
    var user = Store.state.userCards[topic.id] || [];
    var all = (topic.flashcards || []).concat(user);
    return includeSuspended ? all : all.filter(function (c) { return !Store.state.suspended[c.id]; });
  }

  function notesOf(topic) {
    return (topic.notes || []).concat(Store.state.userNotes[topic.id] || []);
  }

  function assetsOf(topic) {
    var v = (topic.assets || []).map(function (a) { return Object.assign({}, a, { src: a.url }); });
    var u = (Store.state.userAssets[topic.id] || []).map(function (a) { return Object.assign({}, a, { src: a.data }); });
    return u.concat(v);
  }

  function visibleTopics() {
    return DATA.topics.filter(function (t) { return !App.subject || t.subject === App.subject; });
  }

  function allCards() {
    var out = [];
    DATA.topics.forEach(function (t) {
      cardsOf(t).forEach(function (c) { out.push({ card: c, topic: t }); });
    });
    return out;
  }

  function dueCards(topicId) {
    return allCards().filter(function (x) {
      return (!topicId || x.topic.id === topicId) && SRS.isDue(x.card.id);
    });
  }

  function topicProgress(t) {
    var cs = cardsOf(t);
    if (!cs.length) return { pct: 0, learned: 0, total: 0, due: 0 };
    var learned = cs.filter(function (c) { var r = Store.state.reviews[c.id]; return r && r.reps > 0 && r.interval >= 4; }).length;
    var due = cs.filter(function (c) { return SRS.isDue(c.id); }).length;
    return { pct: Math.round((learned / cs.length) * 100), learned: learned, total: cs.length, due: due };
  }

  // ------------------------------------------------------------ theme
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    Store.state.theme = t; Store.save();
    var m = $('meta[name=theme-color]');
    if (m) m.setAttribute('content', t === 'dark' ? '#141210' : '#faf7f2');
  }

  // ------------------------------------------------------------ views
  var Views = {};

  // ---------- TODAY
  Views.today = function () {
    var due = dueCards();
    var topics = visibleTopics();
    var total = allCards().length;
    var newCount = due.filter(function (x) { return SRS.isNew(x.card.id); }).length;
    var reviewCount = due.length - newCount;
    var overdue = due.filter(function (x) { return SRS.isOverdue(x.card.id); }).length;
    var streak = SRS.streak();
    var todayLog = Store.state.sessions[SRS.iso(SRS.today())] || { count: 0, correct: 0 };

    var headline = due.length
      ? plural(due.length, 'card') + ' waiting'
      : (total ? 'Queue clear' : 'Nothing indexed yet');
    var note = due.length
      ? [newCount ? newCount + ' new' : null, reviewCount ? reviewCount + ' review' : null, overdue ? overdue + ' overdue' : null]
          .filter(Boolean).join(' · ')
      : (total ? 'Next batch lands ' + nextDueLabel() + '. ' + todayLog.count + ' reviewed today.'
               : 'Run /learn in Hermes to build your first deck.');

    var html = '';
    html += '<div class="view-head">' +
      '<div class="view-title">' + greeting() + '</div>' +
      '<div class="view-sub">' + new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) +
      (streak ? ' · ' + plural(streak, 'day') + ' streak' : '') + '</div></div>';

    html += '<div class="queue-strip">' +
      '<div><div class="queue-headline">' + esc(headline) + '</div><div class="queue-note">' + esc(note) + '</div></div>' +
      (due.length ? '<button class="btn" data-act="startAll">Start session <kbd>↵</kbd></button>'
                  : '<button class="btn sec" data-act="cram">Free review</button>') +
      '</div>';

    // weakest cards — actionable, not decorative
    var weak = allCards()
      .filter(function (x) { var r = Store.state.reviews[x.card.id]; return r && r.reps >= 2; })
      .map(function (x) { return { x: x, s: SRS.strength(x.card.id) }; })
      .sort(function (a, b) { return a.s - b.s; })
      .slice(0, 6);

    html += '<div class="split" style="margin-top:22px">';

    html += '<div>';
    html += '<div class="section-label">Decks</div>';
    if (!topics.length) {
      html += emptyState('No topics', 'Nothing matches this filter yet.');
    } else {
      html += '<div class="row-list panel">';
      topics.forEach(function (t) {
        var p = topicProgress(t);
        var cls = p.due ? (cardsOf(t).some(function (c) { return SRS.isOverdue(c.id); }) ? 'over' : 'due') : 'ok';
        html += '<button class="row" data-act="openTopic" data-id="' + esc(t.id) + '">' +
          '<span class="dot ' + cls + '"></span>' +
          '<span class="row-title">' + esc(t.name) + '</span>' +
          '<span style="width:74px" class="bar"><i style="width:' + p.pct + '%"></i></span>' +
          '<span class="row-meta">' + (p.due ? p.due + ' due' : p.pct + '%') + '</span>' +
          '</button>';
      });
      html += '</div>';
    }

    if (weak.length) {
      html += '<div class="section-label">Weakest recall</div><div class="row-list panel">';
      weak.forEach(function (w) {
        html += '<button class="row" data-act="drill" data-id="' + esc(w.x.card.id) + '" data-topic="' + esc(w.x.topic.id) + '">' +
          '<span class="dot ' + (w.s < 0.3 ? 'over' : 'due') + '"></span>' +
          '<span class="row-title">' + esc(w.x.card.q) + '</span>' +
          '<span class="row-meta">' + Math.round(w.s * 100) + '%</span></button>';
      });
      html += '</div>';
    }
    html += '</div>';

    // right column
    html += '<div>';
    html += '<div class="section-label">Next 14 days</div>';
    html += '<div class="panel">' + forecastHTML(allCards().map(function (x) { return x.card.id; }), 14) + '</div>';
    html += '<div class="section-label">Quick add</div>';
    html += '<div class="panel"><div class="inline-actions">' +
      '<button class="btn sm sec" data-act="newNote">＋ Note</button>' +
      '<button class="btn sm sec" data-act="newCard">＋ Card</button>' +
      '<button class="btn sm sec" data-act="upload">↥ Image</button>' +
      '</div><div class="stat-note" style="margin-top:10px">Attach to any topic. Stored in this browser and included in search.</div></div>';
    html += '</div>';

    html += '</div>';
    return html;
  };

  function greeting() {
    var hr = new Date().getHours();
    if (hr < 5) return 'Late session';
    if (hr < 12) return 'Good morning';
    if (hr < 17) return 'Good afternoon';
    if (hr < 22) return 'Good evening';
    return 'Late session';
  }

  function nextDueLabel() {
    var best = null;
    allCards().forEach(function (x) {
      var r = Store.state.reviews[x.card.id];
      if (!r || !r.reps) return;
      var d = SRS.parse(r.due);
      if (!best || d < best) best = d;
    });
    return best ? relDate(SRS.iso(best)) : 'later';
  }

  function forecastHTML(ids, days) {
    var f = SRS.forecast(ids, days);
    var max = Math.max.apply(null, f.map(function (d) { return d.count; }).concat([1]));
    return '<div class="forecast">' + f.map(function (d, i) {
      var pct = Math.round((d.count / max) * 100);
      return '<div class="fc-col" title="' + d.date + ': ' + plural(d.count, 'card') + '">' +
        '<div class="fc-bar' + (i === 0 ? ' today' : '') + '" style="height:' + Math.max(pct, d.count ? 6 : 2) + '%"></div>' +
        '<div class="fc-lab">' + (i % 2 === 0 ? d.day.getDate() : '') + '</div></div>';
    }).join('') + '</div>';
  }

  function emptyState(title, body, mark) {
    return '<div class="empty"><div class="empty-mark">' + (mark || '◌') + '</div>' +
      '<h3>' + esc(title) + '</h3><p>' + esc(body) + '</p></div>';
  }

  // ---------- STUDY
  var MODES = [
    { id: 'recall', label: 'Active recall', hint: 'Flip and self-grade.' },
    { id: 'type', label: 'Type answer', hint: 'Write it before you flip — retrieval effort beats recognition.' },
    { id: 'feynman', label: 'Feynman', hint: 'Explain it out loud in plain words, as if to a 12-year-old, then check.' },
    { id: 'reverse', label: 'Reverse', hint: 'Answer shown first — produce the question.' },
    { id: 'cram', label: 'Cram', hint: 'Ignore scheduling. Everything, weakest first.' }
  ];

  function startSession(opts) {
    opts = opts || {};
    var pool;
    if (opts.cardIds) {
      var idx = {};
      allCards().forEach(function (x) { idx[x.card.id] = x; });
      pool = opts.cardIds.map(function (id) { return idx[id]; }).filter(Boolean);
    } else if (App.mode === 'cram') {
      pool = allCards().filter(function (x) { return !opts.topicId || x.topic.id === opts.topicId; });
      pool.sort(function (a, b) { return SRS.strength(a.card.id) - SRS.strength(b.card.id); });
    } else {
      pool = dueCards(opts.topicId);
      // interleave subjects — better than blocked practice
      pool = interleave(pool);
    }
    if (!pool.length) { toast('Nothing due — try Cram mode'); go('study'); return; }
    App.session = { queue: pool, i: 0, shown: false, done: 0, correct: 0, again: [], startedAt: Date.now() };
    go('study');
  }

  function interleave(list) {
    var bySub = {};
    list.forEach(function (x) { (bySub[x.topic.subject] = bySub[x.topic.subject] || []).push(x); });
    Object.keys(bySub).forEach(function (k) { shuffle(bySub[k]); });
    var keys = Object.keys(bySub), out = [], n = 0;
    while (out.length < list.length) {
      var k = keys[n % keys.length];
      if (bySub[k].length) out.push(bySub[k].shift());
      n++;
      if (n > list.length * 4) break;
    }
    return out;
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  Views.study = function () {
    var html = '<div class="study-wrap">';
    html += '<div class="mode-bar">' + MODES.map(function (m) {
      return '<button class="mode-pill' + (App.mode === m.id ? ' on' : '') + '" data-act="mode" data-id="' + m.id + '">' + esc(m.label) + '</button>';
    }).join('') + '</div>';

    var s = App.session;
    if (!s || s.i >= s.queue.length) {
      if (s && s.i >= s.queue.length) return html + sessionSummary(s) + '</div>';
      var due = dueCards();
      html += '<div class="panel" style="text-align:center;padding:34px">' +
        '<div class="queue-headline" style="font-family:var(--font-display);font-size:1.5rem">' +
        (due.length ? plural(due.length, 'card') + ' ready' : 'Queue empty') + '</div>' +
        '<div class="queue-note" style="margin:6px 0 16px">' + esc(MODES.find(function (m) { return m.id === App.mode; }).hint) + '</div>' +
        '<button class="btn" data-act="startAll">' + (App.mode === 'cram' ? 'Start cram' : 'Start session') + '</button>' +
        '</div>';
      return html + '</div>';
    }

    var cur = s.queue[s.i];
    var card = cur.card;
    var pct = Math.round((s.i / s.queue.length) * 100);
    var starred = !!Store.state.starred[card.id];

    html += '<div class="study-meta">' +
      '<span>' + (s.i + 1) + '/' + s.queue.length + '</span>' +
      '<span class="bar"><i style="width:' + pct + '%"></i></span>' +
      '<span>' + esc(cur.topic.name) + '</span>' +
      '<button class="ghost-btn" data-act="star" style="padding:2px 6px" title="Star (S)">' + (starred ? '★' : '☆') + '</button>' +
      '<button class="ghost-btn" data-act="suspend" style="padding:2px 6px" title="Suspend card">⊘</button>' +
      '</div>';

    var front = App.mode === 'reverse' ? card.a : card.q;
    var back = App.mode === 'reverse' ? card.q : card.a;

    html += '<div class="card"><div class="card-body">';
    html += '<div class="card-q">' + MD.inline(esc(front)) + '</div>';

    if (App.mode === 'type' && !s.shown) {
      html += '<textarea class="type-answer" id="typeBox" placeholder="Write the answer from memory…"></textarea>';
    }
    if (App.mode === 'feynman' && !s.shown) {
      html += '<div class="self-check" style="margin-top:18px">Explain it aloud in your own words. No jargon. Then reveal and find the gap.</div>';
    }

    if (s.shown) {
      html += '<div class="card-a">' + MD.render(back) + '</div>';
      if (s.typed) {
        html += '<div class="self-check">You wrote: <em>' + esc(s.typed) + '</em>' +
          (s.match != null ? ' · overlap <b>' + s.match + '%</b>' : '') + '</div>';
      }
    }
    html += '</div>';

    html += '<div class="card-foot">';
    if (!s.shown) {
      html += '<button class="reveal-btn" data-act="reveal">Reveal <kbd>space</kbd></button>';
    } else {
      [[1, 'Again'], [2, 'Hard'], [3, 'Good'], [4, 'Easy']].forEach(function (g) {
        html += '<button class="grade" data-g="' + g[0] + '" data-act="grade" data-id="' + g[0] + '">' +
          '<b>' + g[1] + '</b><span>' + SRS.preview(card.id, g[0]) + '</span></button>';
      });
    }
    html += '</div></div>';

    // context: related notes/images for this topic, collapsed
    var assets = assetsOf(cur.topic);
    if (s.shown && assets.length) {
      html += '<div class="section-label">Visual reference</div><div class="asset-grid">' +
        assets.slice(0, 4).map(assetHTML).join('') + '</div>';
    }

    html += '</div>';
    return html;
  };

  function sessionSummary(s) {
    var mins = Math.max(1, Math.round((Date.now() - s.startedAt) / 60000));
    var acc = s.done ? Math.round((s.correct / s.done) * 100) : 0;
    return '<div class="panel" style="text-align:center;padding:34px">' +
      '<div style="font-family:var(--font-display);font-size:1.9rem">Session complete</div>' +
      '<div class="queue-note" style="margin:4px 0 18px">' + plural(s.done, 'card') + ' · ' + acc + '% first-pass · ' + mins + ' min</div>' +
      '<div class="stat-grid" style="max-width:460px;margin:0 auto 18px">' +
      '<div class="stat"><div class="stat-v">' + s.correct + '</div><div class="stat-l">recalled</div></div>' +
      '<div class="stat"><div class="stat-v">' + (s.done - s.correct) + '</div><div class="stat-l">missed</div></div>' +
      '<div class="stat"><div class="stat-v">' + SRS.streak() + '</div><div class="stat-l">streak</div></div>' +
      '</div>' +
      (s.again.length ? '<button class="btn" data-act="redoMissed">Redo ' + plural(s.again.length, 'miss', 'misses') + '</button> ' : '') +
      '<button class="btn sec" data-act="goToday">Back to today</button></div>';
  }

  function assetHTML(a) {
    if (a.kind === 'image') {
      return '<button class="asset" data-act="light" data-src="' + esc(a.src) + '" data-name="' + esc(a.name) + '">' +
        '<img src="' + esc(a.src) + '" alt="' + esc(a.name) + '" loading="lazy">' +
        '<div class="asset-name">' + esc(a.name) + '</div></button>';
    }
    return '<a class="asset" href="' + esc(a.src) + '" target="_blank" rel="noopener">' +
      '<div class="asset-doc">▤</div><div class="asset-name">' + esc(a.name) + '</div></a>';
  }

  // ---------- TOPICS
  Views.topics = function () {
    if (App.topicId) return topicDetail();
    var ts = visibleTopics();
    var html = '<div class="view-head"><div class="view-title">Topics</div>' +
      '<div class="view-sub">' + plural(ts.length, 'deck') + ' · ' + plural(allCards().length, 'card') + '</div></div>';
    if (!ts.length) return html + emptyState('Nothing here yet', 'Run /learn <topic> in Hermes to generate a deck, or add a card manually.');
    html += '<div class="topic-grid">';
    ts.forEach(function (t) {
      var p = topicProgress(t);
      var n = notesOf(t).length, a = assetsOf(t).length;
      html += '<button class="topic-card" data-act="openTopic" data-id="' + esc(t.id) + '">' +
        '<div class="tc-top"><h3>' + esc(t.name) + '</h3><span class="badge ' + esc(t.badge) + '">' + esc(t.subject) + '</span></div>' +
        '<p>' + esc(t.description) + '</p>' +
        '<div class="bar"><i style="width:' + p.pct + '%"></i></div>' +
        '<div class="tc-foot"><span>' + p.total + ' cards</span>' +
        (n ? '<span>' + n + ' notes</span>' : '') +
        (a ? '<span>' + a + ' media</span>' : '') +
        (p.due ? '<span style="color:var(--accent);margin-left:auto">' + p.due + ' due</span>' : '<span style="margin-left:auto">' + p.pct + '%</span>') +
        '</div></button>';
    });
    html += '</div>';
    return html;
  };

  function topicDetail() {
    var t = DATA.topics.find(function (x) { return x.id === App.topicId; });
    if (!t) { App.topicId = null; return Views.topics(); }
    var cards = cardsOf(t, true);
    var p = topicProgress(t);
    var notes = notesOf(t);
    var assets = assetsOf(t);
    var docs = t.docs || [];

    var html = '<div class="view-head">' +
      '<button class="ghost-btn" data-act="backTopics" style="padding:2px 0;margin-bottom:6px">← All topics</button>' +
      '<div class="view-title">' + esc(t.name) + '</div>' +
      '<div class="view-sub">' + esc(t.subject) + ' · ' + p.total + ' cards · ' + p.pct + '% learned' +
      (p.due ? ' · <b style="color:var(--accent)">' + p.due + ' due</b>' : '') + '</div></div>';

    html += '<div class="inline-actions" style="margin-bottom:20px">' +
      '<button class="btn" data-act="studyTopic" data-id="' + esc(t.id) + '">Study ' + (p.due ? '(' + p.due + ')' : 'all') + '</button>' +
      '<button class="btn sec" data-act="mapTopic" data-id="' + esc(t.id) + '">Mind map</button>' +
      '<button class="btn sec" data-act="newNote" data-topic="' + esc(t.id) + '">＋ Note</button>' +
      '<button class="btn sec" data-act="newCard" data-topic="' + esc(t.id) + '">＋ Card</button>' +
      '<button class="btn sec" data-act="upload" data-topic="' + esc(t.id) + '">↥ Upload</button>' +
      '</div>';

    if (docs.length) {
      html += '<div class="section-label">Lessons &amp; reference</div><div class="row-list panel">';
      docs.forEach(function (d) {
        html += '<a class="row" href="' + esc(d.url) + '" target="_blank" rel="noopener">' +
          '<span class="dot ok"></span><span class="row-title">' + esc(d.title) + '</span>' +
          '<span class="row-meta">' + esc(d.kind) + ' ↗</span></a>';
      });
      html += '</div>';
    }

    html += '<div class="section-label">Media &amp; diagrams</div>';
    html += '<div class="dropzone" data-act="upload" data-topic="' + esc(t.id) + '" id="dz-' + esc(t.id) + '">' +
      '<b>Drop images, flowcharts or screenshots here</b><br>or click to browse · paste with ⌘V works too</div>';
    if (assets.length) {
      html += '<div class="asset-grid" style="margin-top:10px">' + assets.map(function (a) {
        var inner = assetHTML(a);
        if (a.user) inner = inner.replace('</button>', '<span class="asset-name" style="opacity:.6;padding-top:0">local</span></button>');
        return inner;
      }).join('') + '</div>';
    }

    html += '<div class="section-label">Notes</div>';
    if (!notes.length) {
      html += '<div class="panel" style="color:var(--ink-3);font-size:.85rem">No notes yet. Add your own, or they arrive with the next /learn sync.</div>';
    } else {
      notes.forEach(function (n, i) {
        html += '<div class="note-block" data-note="' + i + '">' +
          '<button class="note-head" data-act="toggleNote"><span class="note-caret">▶</span>' + esc(n.title) +
          (n.user ? '<span class="badge" style="margin-left:auto">local</span>' : '') + '</button>' +
          '<div class="note-body" hidden>' + MD.render(n.body) +
          (n.user ? '<div class="inline-actions"><button class="btn sm sec" data-act="editNote" data-topic="' + esc(t.id) + '" data-id="' + esc(n.id) + '">Edit</button>' +
                    '<button class="btn sm sec" data-act="delNote" data-topic="' + esc(t.id) + '" data-id="' + esc(n.id) + '">Delete</button></div>' : '') +
          '</div></div>';
      });
    }

    html += '<div class="section-label">Cards</div><div class="row-list panel">';
    cards.forEach(function (c) {
      var r = Store.state.reviews[c.id];
      var sus = Store.state.suspended[c.id];
      html += '<div class="row" style="opacity:' + (sus ? '.45' : '1') + '">' +
        '<span class="dot ' + (sus ? '' : SRS.isOverdue(c.id) ? 'over' : SRS.isDue(c.id) ? 'due' : 'ok') + '"></span>' +
        '<span class="row-title" title="' + esc(c.a) + '">' + esc(c.q) + '</span>' +
        '<span class="row-meta">' + (r && r.reps ? relDate(r.due) : 'new') + '</span>' +
        '<button class="ghost-btn" data-act="suspendCard" data-id="' + esc(c.id) + '" style="padding:0 4px" title="' + (sus ? 'Unsuspend' : 'Suspend') + '">' + (sus ? '⊕' : '⊘') + '</button>' +
        (c.user ? '<button class="ghost-btn" data-act="delCard" data-topic="' + esc(t.id) + '" data-id="' + esc(c.id) + '" style="padding:0 4px">✕</button>' : '') +
        '</div>';
    });
    html += '</div>';

    return html;
  }

  // ---------- MIND MAP
  var mm = null;
  Views.map = function () {
    var ts = visibleTopics();
    if (!ts.length) return '<div class="view-head"><div class="view-title">Mind map</div></div>' +
      emptyState('No topics to map', 'Generate a deck first.');
    var tid = App.topicId && ts.some(function (t) { return t.id === App.topicId; }) ? App.topicId : ts[0].id;
    App.mapTopic = tid;

    var html = '<div class="view-head"><div class="view-title">Mind map</div>' +
      '<div class="view-sub">Click a branch to fold. Click a leaf to drill the card. Scroll to zoom, drag to pan.</div></div>';
    html += '<div class="map-toolbar">' +
      '<select id="mapTopicSel" class="chip" style="padding:5px 10px">' +
      ts.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === tid ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn sm sec" data-act="mmExpand">Expand all</button>' +
      '<button class="btn sm sec" data-act="mmCollapse">Collapse</button>' +
      '<button class="btn sm sec" data-act="mmZoomIn">＋</button>' +
      '<button class="btn sm sec" data-act="mmZoomOut">－</button>' +
      '<span class="stat-note" style="margin-left:auto">● strong ● shaky ● weak</span>' +
      '</div>';
    html += '<div class="map-stage" id="mapStage"></div>';
    return html;
  };

  function mountMap() {
    var stage = $('#mapStage');
    if (!stage) return;
    var t = DATA.topics.find(function (x) { return x.id === App.mapTopic; });
    if (!t) return;
    mm = new MindMap(stage, {
      onLeaf: function (n) {
        if (n.cardId) startSession({ cardIds: [n.cardId] });
        else toast(n.label);
      }
    });
    mm.render(MindMap.fromTopic(t, cardsOf(t)));
  }

  // ---------- STATS
  Views.stats = function () {
    var cards = allCards();
    var ids = cards.map(function (x) { return x.card.id; });
    var reviewed = ids.filter(function (id) { var r = Store.state.reviews[id]; return r && r.reps; });
    var mature = ids.filter(function (id) { var r = Store.state.reviews[id]; return r && r.interval >= 21; });
    var ret30 = SRS.retention(30);
    var lapses = Object.keys(Store.state.reviews).reduce(function (a, k) { return a + (Store.state.reviews[k].lapses || 0); }, 0);
    var totalReviews = Object.keys(Store.state.sessions).reduce(function (a, k) { return a + Store.state.sessions[k].count; }, 0);
    var days = Object.keys(Store.state.sessions).length;

    var html = '<div class="view-head"><div class="view-title">Stats</div>' +
      '<div class="view-sub">Local to this browser · ' + Math.round(Store.usage() / 1024) + ' KB stored</div></div>';

    html += '<div class="stat-grid">' +
      stat(SRS.streak(), 'day streak', days ? days + ' active days' : '') +
      stat(ret30 == null ? '—' : ret30 + '%', 'retention 30d', ret30 == null ? 'need more reviews' : (ret30 >= 85 ? 'intervals can grow' : ret30 >= 70 ? 'healthy' : 'slow down, add context')) +
      stat(reviewed.length + '/' + ids.length, 'cards seen', mature.length + ' mature (21d+)') +
      stat(totalReviews, 'total reviews', lapses + ' lapses') +
      '</div>';

    html += '<div class="section-label">Activity</div><div class="panel">' + heatHTML() + '</div>';
    html += '<div class="section-label">Upcoming load</div><div class="panel">' + forecastHTML(ids, 21) + '</div>';
    html += '<div class="section-label">This month</div><div class="panel">' + calHTML(ids) + '</div>';

    // per-subject breakdown — bullets, not a table
    var bySub = {};
    cards.forEach(function (x) {
      var s = bySub[x.topic.subject] || (bySub[x.topic.subject] = { n: 0, learned: 0, due: 0 });
      s.n++;
      var r = Store.state.reviews[x.card.id];
      if (r && r.interval >= 4) s.learned++;
      if (SRS.isDue(x.card.id)) s.due++;
    });
    html += '<div class="section-label">By subject</div><div class="row-list panel">';
    Object.keys(bySub).forEach(function (k) {
      var s = bySub[k];
      html += '<div class="row"><span class="row-title">' + esc(k) + '</span>' +
        '<span style="width:100px" class="bar"><i style="width:' + Math.round(s.learned / s.n * 100) + '%"></i></span>' +
        '<span class="row-meta">' + s.learned + '/' + s.n + (s.due ? ' · ' + s.due + ' due' : '') + '</span></div>';
    });
    html += '</div>';

    html += '<div class="section-label">Data</div><div class="panel"><div class="inline-actions">' +
      '<button class="btn sm sec" data-act="export">Export backup</button>' +
      '<button class="btn sm sec" data-act="import">Import backup</button>' +
      '<button class="btn sm sec" data-act="reset">Reset progress</button>' +
      '</div><div class="stat-note" style="margin-top:8px">Progress lives in this browser only. Export before clearing site data.</div></div>';

    return html;
  };

  function stat(v, l, note) {
    return '<div class="stat"><div class="stat-v">' + esc(v) + '</div><div class="stat-l">' + esc(l) + '</div>' +
      (note ? '<div class="stat-note">' + esc(note) + '</div>' : '') + '</div>';
  }

  function heatHTML() {
    var out = [];
    var end = SRS.today();
    var start = new Date(end.getTime() - 118 * SRS.DAY);
    // align to week start
    start = new Date(start.getTime() - start.getDay() * SRS.DAY);
    for (var d = new Date(start); d <= end; d = new Date(d.getTime() + SRS.DAY)) {
      var s = Store.state.sessions[SRS.iso(d)];
      var n = s ? s.count : 0;
      var lvl = n === 0 ? 0 : n < 5 ? 1 : n < 15 ? 2 : n < 30 ? 3 : 4;
      out.push('<i data-l="' + lvl + '" title="' + SRS.iso(d) + ': ' + n + '"></i>');
    }
    return '<div class="heat">' + out.join('') + '</div>' +
      '<div class="stat-note" style="margin-top:8px">Last 17 weeks</div>';
  }

  function calHTML(ids) {
    var now = new Date();
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    var startPad = first.getDay();
    var daysIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var counts = {};
    ids.forEach(function (id) {
      var r = Store.state.reviews[id];
      if (!r || !r.reps || Store.state.suspended[id]) return;
      counts[r.due] = (counts[r.due] || 0) + 1;
    });
    var html = '<div class="cal">' + ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(function (d) { return '<div class="cal-h">' + d + '</div>'; }).join('');
    for (var i = 0; i < startPad; i++) html += '<div class="cal-d out"></div>';
    for (var d = 1; d <= daysIn; d++) {
      var date = new Date(now.getFullYear(), now.getMonth(), d);
      var key = SRS.iso(date);
      var n = counts[key] || 0;
      var isToday = key === SRS.iso(SRS.today());
      var over = date < SRS.today() && n > 0;
      html += '<div class="cal-d' + (isToday ? ' today' : '') + '" title="' + (n ? plural(n, 'card') + ' due' : '') + '">' +
        d + (n ? '<span class="pip' + (over ? ' over' : '') + '"></span>' : '') + '</div>';
    }
    html += '</div>';
    return html;
  }

  // ------------------------------------------------------------ search
  var searchIndex = null;
  function buildIndex() {
    searchIndex = [];
    DATA.topics.forEach(function (t) {
      searchIndex.push({ kind: 'topic', title: t.name, sub: t.subject + ' · ' + t.description, topic: t.id, text: (t.name + ' ' + t.subject + ' ' + t.description).toLowerCase() });
      cardsOf(t, true).forEach(function (c) {
        searchIndex.push({ kind: 'card', title: c.q, sub: MD.strip(c.a).slice(0, 110), topic: t.id, cardId: c.id, text: (c.q + ' ' + c.a).toLowerCase() });
      });
      notesOf(t).forEach(function (n) {
        var body = MD.strip(n.body);
        searchIndex.push({ kind: 'note', title: n.title, sub: t.name + ' · ' + body.slice(0, 100), topic: t.id, text: (n.title + ' ' + body).toLowerCase() });
      });
      assetsOf(t).forEach(function (a) {
        searchIndex.push({ kind: 'media', title: a.name, sub: t.name, topic: t.id, src: a.src, akind: a.kind, text: (a.name + ' ' + t.name).toLowerCase() });
      });
    });
  }

  var COMMANDS = [
    { kind: 'cmd', title: 'Start due session', sub: 'Review everything scheduled', run: function () { App.mode = 'recall'; startSession({}); } },
    { kind: 'cmd', title: 'Cram mode', sub: 'All cards, weakest first', run: function () { App.mode = 'cram'; startSession({}); } },
    { kind: 'cmd', title: 'Type-answer mode', sub: 'Write before revealing', run: function () { App.mode = 'type'; startSession({}); } },
    { kind: 'cmd', title: 'Feynman mode', sub: 'Explain it simply', run: function () { App.mode = 'feynman'; startSession({}); } },
    { kind: 'cmd', title: 'New note', sub: 'Add your own notes to a topic', run: function () { noteModal(); } },
    { kind: 'cmd', title: 'New card', sub: 'Add a flashcard', run: function () { cardModal(); } },
    { kind: 'cmd', title: 'Upload image', sub: 'Attach a diagram or photo', run: function () { uploadModal(); } },
    { kind: 'cmd', title: 'Toggle theme', sub: 'Dark / light', run: function () { applyTheme(Store.state.theme === 'dark' ? 'light' : 'dark'); } },
    { kind: 'cmd', title: 'Export backup', sub: 'Download progress JSON', run: doExport },
    { kind: 'cmd', title: 'Open mind map', sub: 'Visualise the topic tree', run: function () { go('map'); } },
    { kind: 'cmd', title: 'Stats', sub: 'Retention, forecast, activity', run: function () { go('stats'); } }
  ];

  function score(item, q) {
    var t = item.text;
    var i = t.indexOf(q);
    if (i === -1) {
      // fuzzy subsequence fallback
      var qi = 0;
      for (var k = 0; k < t.length && qi < q.length; k++) if (t[k] === q[qi]) qi++;
      return qi === q.length ? 0.2 : 0;
    }
    var base = i === 0 ? 3 : /\b/.test(t[i - 1] || ' ') ? 2 : 1;
    var kindBonus = item.kind === 'topic' ? 0.6 : item.kind === 'cmd' ? 0.5 : 0;
    return base + kindBonus + Math.min(1, q.length / Math.max(t.length, 1));
  }

  function highlight(s, q) {
    if (!q) return esc(s);
    var i = s.toLowerCase().indexOf(q);
    if (i === -1) return esc(s);
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
  }

  var pal = { open: false, sel: 0, results: [] };

  function openPalette(prefill) {
    if (!searchIndex) buildIndex();
    pal.open = true;
    $('#palette').hidden = false;
    var inp = $('#paletteInput');
    inp.value = prefill || '';
    inp.focus();
    inp.select();
    runSearch();
  }
  function closePalette() { pal.open = false; $('#palette').hidden = true; }

  function runSearch() {
    var q = $('#paletteInput').value.trim().toLowerCase();
    var pool = COMMANDS.map(function (c) { return Object.assign({ text: (c.title + ' ' + c.sub).toLowerCase() }, c); }).concat(searchIndex);
    var res;
    if (!q) {
      res = COMMANDS.slice(0, 6).map(function (c) { return Object.assign({ text: '' }, c); });
    } else {
      res = pool.map(function (it) { return { it: it, s: score(it, q) }; })
        .filter(function (x) { return x.s > 0; })
        .sort(function (a, b) { return b.s - a.s; })
        .slice(0, 40)
        .map(function (x) { return x.it; });
    }
    pal.results = res;
    pal.sel = 0;

    var box = $('#paletteResults');
    if (!res.length) { box.innerHTML = '<div class="pr-empty">No matches for “' + esc(q) + '”</div>'; return; }
    var groups = { cmd: 'Commands', topic: 'Topics', card: 'Cards', note: 'Notes', media: 'Media' };
    var html = '', last = null, idx = 0;
    res.forEach(function (r) {
      if (r.kind !== last) { html += '<div class="pr-group">' + groups[r.kind] + '</div>'; last = r.kind; }
      var ico = { cmd: '⌁', topic: '≡', card: '◐', note: '✎', media: '▣' }[r.kind];
      html += '<button class="pr' + (idx === 0 ? ' sel' : '') + '" data-i="' + idx + '">' +
        '<span class="pr-ico">' + ico + '</span><span class="pr-main">' +
        '<span class="pr-t">' + highlight(r.title, q) + '</span>' +
        (r.sub ? '<span class="pr-s">' + highlight(String(r.sub), q) + '</span>' : '') +
        '</span></button>';
      idx++;
    });
    box.innerHTML = html;
  }

  function pickResult(i) {
    var r = pal.results[i];
    if (!r) return;
    closePalette();
    if (r.kind === 'cmd') { r.run(); return; }
    if (r.kind === 'card') { startSession({ cardIds: [r.cardId] }); return; }
    if (r.kind === 'media' && r.akind === 'image') { lightbox(r.src, r.title); return; }
    App.topicId = r.topic;
    go('topics');
    if (r.kind === 'note') {
      setTimeout(function () {
        var blocks = $$('.note-block');
        var hit = blocks.find(function (b) { return b.textContent.indexOf(r.title) === 0 || $('.note-head', b).textContent.trim().indexOf(r.title) === 0; });
        if (hit) { hit.classList.add('open'); $('.note-body', hit).hidden = false; hit.scrollIntoView({ block: 'center' }); }
      }, 60);
    }
  }

  // ------------------------------------------------------------ modals
  function modal(html) {
    var box = $('#modalBox');
    box.innerHTML = '<button class="modal-close" data-act="closeModal" aria-label="Close">✕</button>' + html;
    $('#modal').hidden = false;
    var f = box.querySelector('input, textarea, select');
    if (f) setTimeout(function () { f.focus(); }, 40);
    typeset(box);
  }
  function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }

  function topicSelect(id, sel) {
    return '<select id="' + id + '">' + DATA.topics.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === sel ? ' selected' : '') + '>' + esc(t.name) + '</option>';
    }).join('') + (DATA.topics.length ? '' : '<option value="">— no topics —</option>') + '</select>';
  }

  function noteModal(topicId, existing) {
    modal('<h2>' + (existing ? 'Edit note' : 'New note') + '</h2>' +
      '<div class="sub">Markdown supported — headings, lists, tables, code, $LaTeX$, ![](image urls).</div>' +
      (existing ? '' : '<div class="field"><label>Topic</label>' + topicSelect('nTopic', topicId || App.topicId) + '</div>') +
      '<div class="field"><label>Title</label><input id="nTitle" value="' + esc(existing ? existing.title : '') + '" placeholder="e.g. Limiting reagent shortcuts"></div>' +
      '<div class="field"><label>Body</label><textarea id="nBody" rows="12" placeholder="Paste your notes here…">' + esc(existing ? existing.body : '') + '</textarea>' +
      '<div class="hint">Tip: lines like <code>- parent</code> / <code>  - child</code> in a note titled “Mindmap” become a custom mind map on next sync.</div></div>' +
      '<div class="inline-actions"><button class="btn" data-act="saveNote" data-topic="' + esc(topicId || '') + '" data-id="' + esc(existing ? existing.id : '') + '">Save note</button>' +
      '<button class="btn sec" data-act="closeModal">Cancel</button></div>');
  }

  function cardModal(topicId) {
    modal('<h2>New flashcard</h2>' +
      '<div class="sub">Goes into the local deck for that topic and enters the scheduler immediately.</div>' +
      '<div class="field"><label>Topic</label>' + topicSelect('cTopic', topicId || App.topicId) + '</div>' +
      '<div class="field"><label>Question</label><textarea id="cQ" rows="2" placeholder="What is…"></textarea></div>' +
      '<div class="field"><label>Answer</label><textarea id="cA" rows="4" placeholder="Markdown + $LaTeX$ ok"></textarea></div>' +
      '<div class="inline-actions"><button class="btn" data-act="saveCard">Add card</button>' +
      '<button class="btn sec" data-act="saveCardMore">Add &amp; another</button>' +
      '<button class="btn sec" data-act="closeModal">Cancel</button></div>');
  }

  function uploadModal(topicId) {
    modal('<h2>Attach media</h2>' +
      '<div class="sub">Images, flowcharts, screenshots, handwritten notes. Stored in this browser.</div>' +
      '<div class="field"><label>Topic</label>' + topicSelect('uTopic', topicId || App.topicId) + '</div>' +
      '<div class="dropzone" id="modalDrop"><b>Drop files or click to browse</b><br>png · jpg · webp · svg · gif — or paste from clipboard</div>' +
      '<input type="file" id="fileInput" accept="image/*" multiple hidden>' +
      '<div id="uploadList" style="margin-top:12px"></div>');
    var dz = $('#modalDrop'), fi = $('#fileInput');
    dz.addEventListener('click', function () { fi.click(); });
    fi.addEventListener('change', function () { handleFiles(fi.files, $('#uTopic').value); });
    ['dragover', 'dragenter'].forEach(function (e) {
      dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.add('hot'); });
    });
    ['dragleave', 'drop'].forEach(function (e) {
      dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.remove('hot'); });
    });
    dz.addEventListener('drop', function (ev) { handleFiles(ev.dataTransfer.files, $('#uTopic').value); });
  }

  function settingsModal() {
    var used = Store.usage(), pct = Math.min(100, Math.round(used / Store.budget * 100));
    modal('<h2>Settings</h2><div class="sub">Preferences and local data.</div>' +
      '<div class="field"><label>Theme</label><select id="sTheme">' +
      '<option value="dark"' + (Store.state.theme === 'dark' ? ' selected' : '') + '>Dark</option>' +
      '<option value="light"' + (Store.state.theme === 'light' ? ' selected' : '') + '>Light</option></select></div>' +
      '<div class="field"><label>Local storage</label><div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="hint">' + Math.round(used / 1024) + ' KB of ~' + Math.round(Store.budget / 1024) + ' KB used. Images count against this.</div></div>' +
      '<div class="field"><label>Keyboard</label><div class="hint">' +
      '<kbd>⌘K</kbd> search · <kbd>space</kbd> reveal · <kbd>1-4</kbd> grade · <kbd>S</kbd> star · <kbd>T</kbd> theme · <kbd>G</kbd> then <kbd>t/s/m</kbd> jump · <kbd>esc</kbd> close' +
      '</div></div>' +
      '<div class="inline-actions"><button class="btn sm sec" data-act="export">Export</button>' +
      '<button class="btn sm sec" data-act="import">Import</button>' +
      '<button class="btn sm sec" data-act="reset">Reset progress</button></div>');
    $('#sTheme').addEventListener('change', function () { applyTheme(this.value); });
  }

  function lightbox(src, cap) {
    $('#lightboxImg').src = src;
    $('#lightboxCap').textContent = cap || '';
    $('#lightbox').hidden = false;
  }

  // ------------------------------------------------------------ uploads
  function handleFiles(files, topicId) {
    if (!files || !files.length) return;
    if (!topicId) { toast('Pick a topic first'); return; }
    var list = $('#uploadList');
    Array.prototype.forEach.call(files, function (f) {
      if (!/^image\//.test(f.type)) { toast('Skipped ' + f.name + ' — images only'); return; }
      if (f.size > 3.5 * 1024 * 1024) { toast(f.name + ' too large (3.5MB max)'); return; }
      var reader = new FileReader();
      reader.onload = function () {
        downscale(reader.result, function (dataUrl) {
          Store.addAsset(topicId, { name: f.name.replace(/\.[^.]+$/, ''), kind: 'image', data: dataUrl });
          if (list) list.insertAdjacentHTML('afterbegin',
            '<div class="row"><span class="dot ok"></span><span class="row-title">' + esc(f.name) + '</span><span class="row-meta">saved</span></div>');
          toast('Attached ' + f.name);
          searchIndex = null;
          if (App.view === 'topics' && App.topicId === topicId) render();
        });
      };
      reader.readAsDataURL(f);
    });
  }

  /** cap the long edge so localStorage doesn't blow up */
  function downscale(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var MAX = 1400;
      var w = img.width, hgt = img.height;
      if (Math.max(w, hgt) <= MAX && dataUrl.length < 700000) return cb(dataUrl);
      var k = MAX / Math.max(w, hgt);
      var c = document.createElement('canvas');
      c.width = Math.round(w * Math.min(1, k));
      c.height = Math.round(hgt * Math.min(1, k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      try { cb(c.toDataURL('image/jpeg', 0.82)); } catch (e) { cb(dataUrl); }
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }

  function doExport() {
    var blob = new Blob([Store.exportJSON()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'engram-backup-' + SRS.iso(SRS.today()) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Backup downloaded');
  }

  function doImport() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json';
    inp.onchange = function () {
      var f = inp.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try { Store.importJSON(r.result); searchIndex = null; render(); toast('Backup restored'); }
        catch (e) { toast('Import failed — bad file'); }
      };
      r.readAsText(f);
    };
    inp.click();
  }

  // ------------------------------------------------------------ router
  function go(view) {
    App.view = view;
    $$('.nav-item').forEach(function (b) { b.classList.toggle('on', b.dataset.view === view); });
    $$('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    $('#rail').classList.remove('open');
    render();
    $('#scroller').scrollTop = 0;
  }

  function render() {
    var el = $('#view-' + App.view);
    if (!el) return;
    el.innerHTML = Views[App.view]();
    typeset(el);
    if (App.view === 'map') { mountMap(); var sel = $('#mapTopicSel'); if (sel) sel.addEventListener('change', function () { App.mapTopic = this.value; mountMap(); }); }
    if (App.view === 'topics' && App.topicId) wireDropzone();
    updateMeters();
  }

  function wireDropzone() {
    $$('.dropzone[data-topic]').forEach(function (dz) {
      var tid = dz.dataset.topic;
      ['dragover', 'dragenter'].forEach(function (e) { dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.add('hot'); }); });
      ['dragleave', 'drop'].forEach(function (e) { dz.addEventListener(e, function (ev) { ev.preventDefault(); dz.classList.remove('hot'); }); });
      dz.addEventListener('drop', function (ev) { handleFiles(ev.dataTransfer.files, tid); });
    });
  }

  function updateMeters() {
    var due = dueCards().length;
    $('#mDue').textContent = due;
    $('#mStreak').textContent = SRS.streak();
    var r = SRS.retention(30);
    $('#mRet').textContent = r == null ? '—' : r + '%';
    $('#navDue').textContent = due || '';
    document.title = (due ? '(' + due + ') ' : '') + 'Engram · Study Console';
  }

  function renderSubjects() {
    var subs = [];
    DATA.topics.forEach(function (t) { if (subs.indexOf(t.subject) === -1) subs.push(t.subject); });
    $('#subjectFilters').innerHTML = subs.map(function (s) {
      return '<button class="chip' + (App.subject === s ? ' on' : '') + '" data-act="subject" data-id="' + esc(s) + '">' + esc(s) + '</button>';
    }).join('') || '<span class="stat-note">none yet</span>';
  }

  // ------------------------------------------------------------ actions
  var ACTIONS = {
    startAll: function () { startSession({ topicId: App.sessionTopic || null }); },
    cram: function () { App.mode = 'cram'; startSession({}); },
    goToday: function () { App.session = null; go('today'); },
    openTopic: function (el) { App.topicId = el.dataset.id; go('topics'); },
    backTopics: function () { App.topicId = null; render(); },
    studyTopic: function (el) { App.sessionTopic = el.dataset.id; App.mode = App.mode === 'cram' ? 'cram' : 'recall'; startSession({ topicId: el.dataset.id }); },
    mapTopic: function (el) { App.topicId = el.dataset.id; App.mapTopic = el.dataset.id; go('map'); },
    drill: function (el) { startSession({ cardIds: [el.dataset.id] }); },
    subject: function (el) { App.subject = App.subject === el.dataset.id ? null : el.dataset.id; renderSubjects(); render(); },

    mode: function (el) {
      App.mode = el.dataset.id;
      App.session = null;
      render();
    },
    reveal: function () {
      var s = App.session; if (!s) return;
      var box = $('#typeBox');
      if (box) {
        s.typed = box.value.trim();
        var correct = MD.strip(s.queue[s.i].card.a).toLowerCase().split(/\W+/).filter(function (w) { return w.length > 3; });
        var mine = s.typed.toLowerCase().split(/\W+/);
        var hit = correct.filter(function (w) { return mine.indexOf(w) !== -1; }).length;
        s.match = correct.length ? Math.round(hit / correct.length * 100) : null;
      }
      s.shown = true; render();
    },
    grade: function (el) {
      var s = App.session; if (!s || !s.shown) return;
      var g = parseInt(el.dataset.id, 10);
      var cur = s.queue[s.i];
      SRS.grade(cur.card.id, g);
      s.done += 1;
      if (g >= 3) s.correct += 1; else s.again.push(cur.card.id);
      s.i += 1; s.shown = false; s.typed = null; s.match = null;
      render();
    },
    redoMissed: function () { var ids = App.session.again.slice(); startSession({ cardIds: ids }); },
    star: function () { var s = App.session; if (s) { Store.toggleStar(s.queue[s.i].card.id); render(); } },
    suspend: function () {
      var s = App.session; if (!s) return;
      Store.toggleSuspend(s.queue[s.i].card.id);
      s.queue.splice(s.i, 1); s.shown = false;
      searchIndex = null; render(); toast('Card suspended');
    },
    suspendCard: function (el) { Store.toggleSuspend(el.dataset.id); render(); },
    delCard: function (el) { Store.removeCard(el.dataset.topic, el.dataset.id); searchIndex = null; render(); toast('Card deleted'); },

    toggleNote: function (el) {
      var b = el.closest('.note-block');
      b.classList.toggle('open');
      var body = $('.note-body', b);
      body.hidden = !b.classList.contains('open');
      if (!body.hidden) typeset(body);
    },
    newNote: function (el) { noteModal(el && el.dataset.topic); },
    newCard: function (el) { cardModal(el && el.dataset.topic); },
    upload: function (el) { uploadModal(el && el.dataset.topic); },
    editNote: function (el) {
      var list = Store.state.userNotes[el.dataset.topic] || [];
      var n = list.find(function (x) { return x.id === el.dataset.id; });
      if (n) { noteModal(el.dataset.topic, n); $('#modalBox').dataset.topic = el.dataset.topic; }
    },
    delNote: function (el) { Store.removeNote(el.dataset.topic, el.dataset.id); searchIndex = null; render(); toast('Note deleted'); },

    saveNote: function (el) {
      var tSel = $('#nTopic');
      var tid = tSel ? tSel.value : (el.dataset.topic || $('#modalBox').dataset.topic || App.topicId);
      var title = $('#nTitle').value.trim() || 'Untitled note';
      var body = $('#nBody').value;
      if (!tid) { toast('No topic selected'); return; }
      if (el.dataset.id) Store.updateNote(tid, el.dataset.id, { title: title, body: body });
      else Store.addNote(tid, title, body);
      searchIndex = null; closeModal();
      App.topicId = tid; go('topics'); toast('Note saved');
    },
    saveCard: function () { if (saveCardImpl()) { closeModal(); render(); } },
    saveCardMore: function () {
      if (saveCardImpl()) { $('#cQ').value = ''; $('#cA').value = ''; $('#cQ').focus(); }
    },

    light: function (el) { lightbox(el.dataset.src, el.dataset.name); },
    closeModal: closeModal,
    export: doExport,
    import: doImport,
    reset: function () {
      if (!confirm('Erase all local progress, notes and uploads? Export first if unsure.')) return;
      Store.reset(); searchIndex = null; closeModal(); render(); toast('Progress reset');
    },

    mmExpand: function () { if (mm) mm.expandAll(); },
    mmCollapse: function () { if (mm) mm.collapseAll(); },
    mmZoomIn: function () { if (mm) mm.zoom(1.2); },
    mmZoomOut: function () { if (mm) mm.zoom(1 / 1.2); }
  };

  function saveCardImpl() {
    var tid = $('#cTopic').value;
    var q = $('#cQ').value.trim(), a = $('#cA').value.trim();
    if (!tid) { toast('No topic'); return false; }
    if (!q || !a) { toast('Question and answer required'); return false; }
    Store.addCard(tid, q, a);
    searchIndex = null;
    toast('Card added');
    return true;
  }

  // ------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (t && ACTIONS[t.dataset.act]) { e.preventDefault(); ACTIONS[t.dataset.act](t); return; }

    var nav = e.target.closest('.nav-item');
    if (nav) { App.topicId = nav.dataset.view === 'topics' ? null : App.topicId; go(nav.dataset.view); return; }

    var pr = e.target.closest('.pr');
    if (pr) { pickResult(parseInt(pr.dataset.i, 10)); return; }

    if (e.target.closest('#searchTrigger')) { openPalette(); return; }
    if (e.target.id === 'themeBtn' || e.target.closest('#themeBtn')) { applyTheme(Store.state.theme === 'dark' ? 'light' : 'dark'); return; }
    if (e.target.closest('#settingsBtn')) { settingsModal(); return; }
    if (e.target.closest('#railToggle')) { $('#rail').classList.toggle('open'); return; }

    if (e.target.id === 'palette') closePalette();
    if (e.target.id === 'modal') closeModal();
    if (e.target.closest('#lightbox')) $('#lightbox').hidden = true;
  });

  $('#paletteInput').addEventListener('input', runSearch);

  var gPending = false;
  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }

    if (pal.open) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var n = pal.results.length; if (!n) return;
        pal.sel = (pal.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
        $$('.pr').forEach(function (b, i) { b.classList.toggle('sel', i === pal.sel); if (i === pal.sel) b.scrollIntoView({ block: 'nearest' }); });
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); pickResult(pal.sel); return; }
      return;
    }

    if (e.key === 'Escape') {
      if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
      if (!$('#modal').hidden) { closeModal(); return; }
      if (App.topicId && App.view === 'topics') { App.topicId = null; render(); return; }
      return;
    }

    if (typing) {
      // ctrl+enter reveals in type mode
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && App.view === 'study') { e.preventDefault(); ACTIONS.reveal(); }
      return;
    }
    if (!$('#modal').hidden) return;

    if (e.key === '/') { e.preventDefault(); openPalette(); return; }

    if (gPending) {
      gPending = false;
      var map = { t: 'today', s: 'study', o: 'topics', m: 'map', a: 'stats' };
      if (map[e.key.toLowerCase()]) { e.preventDefault(); go(map[e.key.toLowerCase()]); return; }
    }
    if (e.key.toLowerCase() === 'g') { gPending = true; setTimeout(function () { gPending = false; }, 900); return; }

    if (e.key.toLowerCase() === 't') { applyTheme(Store.state.theme === 'dark' ? 'light' : 'dark'); return; }

    if (App.view === 'study' && App.session) {
      var s = App.session;
      if (s.i >= s.queue.length) {
        if (e.key === 'Enter') { e.preventDefault(); ACTIONS.goToday(); }
        return;
      }
      if ((e.key === ' ' || e.key === 'Enter') && !s.shown) { e.preventDefault(); ACTIONS.reveal(); return; }
      if (s.shown && /^[1-4]$/.test(e.key)) { e.preventDefault(); ACTIONS.grade({ dataset: { id: e.key } }); return; }
      if (s.shown && e.key === ' ') { e.preventDefault(); ACTIONS.grade({ dataset: { id: '3' } }); return; }
      if (e.key.toLowerCase() === 's') { ACTIONS.star(); return; }
    }

    if (App.view === 'today' && e.key === 'Enter') { e.preventDefault(); ACTIONS.startAll(); }
  });

  // paste image anywhere -> attach to current topic
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData || {}).items;
    if (!items) return;
    var imgs = [];
    Array.prototype.forEach.call(items, function (it) {
      if (it.type && it.type.indexOf('image') === 0) { var f = it.getAsFile(); if (f) imgs.push(f); }
    });
    if (!imgs.length) return;
    var tid = ($('#uTopic') && $('#uTopic').value) || App.topicId || (DATA.topics[0] && DATA.topics[0].id);
    if (!tid) { toast('No topic to attach to'); return; }
    e.preventDefault();
    handleFiles(imgs, tid);
  });

  window.addEventListener('resize', function () {
    if (App.view === 'map' && mm && mm.data) mm.render(mm.data);
  });

  Store.on('quota', function () { toast('Storage full — oldest images dropped. Export a backup.', 4000); });

  // ------------------------------------------------------------ boot
  function boot() {
    applyTheme(Store.state.theme || 'dark');
    if (!DATA.topics) DATA.topics = [];
    renderSubjects();
    buildIndex();
    $('#boot').remove();
    $('#app').hidden = false;
    go('today');

    if (DATA.warnings && DATA.warnings.length) {
      console.warn('[vault] ' + DATA.warnings.length + ' warnings', DATA.warnings);
    }
  }

  if (!window.VAULT_DATA) {
    // still boot with an empty shell rather than a blank page
    console.error('vault-data.js missing or failed to load');
    DATA = { topics: [], library: [] };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
