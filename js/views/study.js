/* =============================================================================
   js/views/study.js — THE REVIEW SESSION, plus the PRETEST and PRIME runners.
   Owner: Job B2. Replaces the Job A2 stub wholesale; keeps the export shape.

   ROUTES
     #/study                          tonight's FSRS session (default)
     #/study?topic=<topicId>          the same, restricted to one topic
     #/study?mode=pretest&topic=<id>  §1.0 pretest: delayed answers, score hidden
     #/study?mode=prime&topic=<id>    §1.1 prime: 10–20 min, structure only
     #/study?mode=errors[&entry=<id>] the Error Book (also the search target)

   THE LOOP (pedagogy-spec §1.5 + §1.7, Tier 0)
     intro (time budget + what is in the queue)
       → COMMIT BEFORE REVEAL — no hover-reveal, ever; typed / selected /
         mental-commit tap, and confidence 1–5 picked BEFORE submit
       → auto-rate what is machine-checkable (correct→Good, wrong→Again,
         fast+confident correct→Easy) with Hard/Easy as the two-button override;
         every grade button carries the interval the scheduler WILL apply
       → elaborated feedback, never a bare wrong
       → missed items re-enter after ~5 cards, to criterion, then STOP
       → every recall chased by its paired application item when one exists
       → confident-wrong → Error Book + top of tomorrow's queue ("this one bit you")
       → leech (scheduler-suspended) → "rewrite it with Hermes" state
       → session end: real-number competence statement, ONE effort slider,
         takeaway in his own words
     and a 90-second escape hatch that is ALWAYS visible and always counts.
   ========================================================================== */

import { store, todayLocalISO, uid } from './../store.js';
import { getSettings } from './../config.js';
import { getTopic, getTopics, isVaultMissing, isVaultEmpty } from './../vault.js';
import { routeFor, navigate } from './../router.js';
import { isNew } from './../scheduler.js';
import {
  el, icon, fmt, md, emptyState, toast, haptic, sound, prefersReducedMotion,
} from './../dom.js';
import {
  assembleQueue, cardContent, cardMeta, applyGrade, saveCard, buildPool,
  confidencePicker, commitPanel, gradeRow, feedbackPanel, sessionRail,
  escapeHatch, effortSlider, modeBinary, takeawayField, cardChips,
  SessionClock, celebrate, saveReflection, competenceLines, relearnMilestones,
  checkAnswer, pickMissingStep, autoRating, requeueForCriterion, pairedItemFor,
  recordActivity, recordSession, warmGame, invalidatePool, subjectSlug, minutesFor,
  registerTransientContent, estMinutesForItems,
  SESSION_FLOOR_SECONDS, SESSION_FLOOR_CARDS, CONFIDENT_THRESHOLD, SESSION_KEY, PRIME_KEY,
} from './../queue-ui.js';
import {
  addMiss, addLeech, noteCorrect, hypercorrectionCardIds, leechEntries,
  stats as errorStats, renderErrorBook, registerErrorBookSearch,
} from './../errorbook.js';

/* -----------------------------------------------------------------------------
   Module state — one live session at a time; onExit tears it down.
   -------------------------------------------------------------------------- */

let live = null;          // {dispose()}
let searchWired = false;
let deckListener = null;

/* =============================================================================
   1. VIEW ENTRY
   ========================================================================== */

function renderStudy(root, params) {
  if (live) { live.dispose(); live = null; }
  if (!searchWired) { registerErrorBookSearch(); searchWired = true; }
  warmGame();

  const mode = String((params && params.mode) || 'review').toLowerCase();
  const topicId = String((params && params.topic) || '') || null;

  if (mode === 'errors') return renderErrorsPage(root, params);
  if (mode === 'prime') return renderPrime(root, topicId);
  if (mode === 'pretest') return renderPretest(root, topicId);
  return renderIntro(root, { topicId });
}

/* =============================================================================
   2. SESSION INTRO — time budget + what is in the queue (never a due count)
   ========================================================================== */

function renderIntro(root, o) {
  const topicId = o.topicId;
  const topic = topicId ? getTopic(topicId) : null;

  if (isVaultMissing() || isVaultEmpty()) {
    root.replaceChildren(
      sectionHead('Study', 'The nightly retrieval loop.'),
      emptyState({
        icon: 'layers',
        title: isVaultMissing() ? 'No vault loaded yet' : 'No cards in the vault yet',
        body: 'Cards are minted in the reference sweep, after a topic has an encoding artefact. '
          + 'Run the sync, or drop a vault-data.js beside index.html to study locally.',
        action: { label: 'Back to home', href: routeFor('home') },
      }),
      errorBookBlock(true));
    return;
  }

  const priorityIds = hypercorrectionCardIds({ limit: 6, topicId: topicId || undefined });
  const { items, session } = assembleQueue({ topicId: topicId || undefined, priorityIds });
  const saved = readSavedSession();
  const settings = getSettings();

  const subjects = Array.from(new Set(items.map((i) => {
    const c = cardContent(i.cardId);
    return c ? c.subject : '';
  }).filter(Boolean)));
  const newCount = items.filter((i) => i.isNew).length;
  const hyperCount = items.filter((i) => i.hyper).length;

  const hero = el('section.card.card--tone.card--2xl.card--pad-lg', {
    dataset: subjects.length === 1 ? { subject: subjectSlug(subjects[0]) } : { tone: 'brand' },
  },
  el('div.eyebrow.eyebrow--dot', el('span', { text: topic ? topic.name : 'Tonight' })),
  el('div.stat__value', {
    style: { fontSize: 'var(--fs-metric)', marginTop: 'var(--sp-2)' },
    text: items.length ? (session ? session.label : estMinutesForItems(items) + ' minutes') : 'Nothing due',
  }),
  el('p.text-meta', {
    style: { marginTop: 'var(--sp-2)' },
    text: items.length
      ? 'Your budget is ' + settings.dailyMinutes + ' minutes a night. The queue is packed to fit it — lowest recall first.'
      : 'Nothing is due right now. That is the schedule working, not a day off — you can still prime tomorrow’s chapter below.',
  }));

  const chips = el('div.chip-row', { style: { marginTop: 'var(--sp-4)' } });
  for (const s of subjects.slice(0, 4)) chips.appendChild(el('span.chip', { text: s }));
  if (hyperCount) {
    chips.appendChild(el('span.pill.pill--bad', icon('target', { size: 12 }),
      el('span', { text: hyperCount + ' that bit you — first' })));
  }
  if (newCount) {
    chips.appendChild(el('span.pill.pill--new', { text: newCount + ' first-time ' + fmt.plural(newCount, 'card') }));
  }
  if (chips.children.length) hero.appendChild(chips);

  const actions = el('div.btn-row', { style: { marginTop: 'var(--sp-5)' } });
  if (items.length) {
    actions.appendChild(el('button.btn.btn-primary.btn--lg', {
      type: 'button',
      onClick: () => {
        clearSavedSession();
        startRunner(root, { mode: 'review', items, topicId });
      },
    }, icon('play', { size: 16 }), 'Start'));
  }
  if (saved && saved.day === todayLocalISO() && saved.index < saved.items.length) {
    actions.appendChild(el('button.btn.btn-secondary.btn--lg', {
      type: 'button',
      onClick: () => resumeSaved(root, saved),
    }, icon('refresh', { size: 16 }),
    'Resume · about ' + minutesFor(saved.items.length - saved.index) + ' min left'));
  }
  hero.appendChild(actions);

  hero.appendChild(el('p.hint', {
    style: { marginTop: 'var(--sp-3)' },
    text: '90 seconds is a full session. The escape hatch is on every card and it always banks the night.',
  }));

  const blocks = [hero];

  if (items.length) blocks.push(queuePreview(items));
  blocks.push(modeCards(topicId));
  const leeches = leechEntries();
  if (leeches.length) blocks.push(leechBlock(leeches, root));
  blocks.push(errorBookBlock(true));

  root.replaceChildren(sectionHead('Study', topic ? topic.name : 'Tonight’s retrieval loop'), ...blocks);
}

/** What is in the queue, described — composition, not a debt counter. */
function queuePreview(items) {
  const byTopic = new Map();
  for (const i of items) {
    const c = cardContent(i.cardId);
    const key = c ? c.topicName : 'Other';
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(i);
  }
  const rows = Array.from(byTopic.entries())
    .map(([name, list]) => [name, estMinutesForItems(list)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const max = rows.length ? rows[0][1] : 1;
  return el('section.card', { style: { marginTop: 'var(--sp-4)' } },
    el('div.card__head', el('h3.card__title', { text: 'What is in it' })),
    el('div.stack', { style: { '--gap': 'var(--sp-3)' } },
      rows.map(([name, mins]) => el('div.meter-row',
        el('span.meter__label', { style: { minWidth: '38%' }, text: name }),
        el('div.meter.meter--sm', el('span.meter__fill', { style: { '--pct': String(Math.round((mins / max) * 100)) } })),
        el('span.meter__label', { text: mins + ' min' })))));
}

function modeCards(topicId) {
  const topics = getTopics();
  const target = topicId || (topics[0] ? topics[0].id : '');
  const wrap = el('div.card-grid', { style: { marginTop: 'var(--sp-4)' } });

  wrap.appendChild(modeCard({
    icon: 'eye',
    title: 'Pretest',
    body: 'Five higher-order questions on material you have not studied. You are expected to get these wrong — that is the point. Answers come at the end.',
    label: 'Run a pretest',
    route: routeFor('study', { mode: 'pretest', topic: target }),
    disabled: !target,
  }));
  wrap.appendChild(modeCard({
    icon: 'brain',
    title: 'Prime',
    body: '10–20 minutes before class: harvest the terms, guess the structure, save a skeleton. Zero detail allowed.',
    label: 'Prime a chapter',
    route: routeFor('study', { mode: 'prime', topic: target }),
    disabled: !target,
  }));
  return wrap;
}

function modeCard(o) {
  return el('a.card.card--tone.card--interactive.lift', {
    href: o.disabled ? null : o.route,
    dataset: { tone: 'info' },
    style: Object.assign(
      { textDecoration: 'none', color: 'var(--fg)' },
      o.disabled ? { opacity: '0.5', pointerEvents: 'none' } : {}
    ),
  },
  el('div.row', { style: { gap: 'var(--sp-2)' } },
    el('span.icon-tile', icon(o.icon, { size: 16 })),
    el('span.card__title', { text: o.title })),
  el('p.text-meta', { style: { marginTop: 'var(--sp-2)' }, text: o.body }),
  el('div.row', { style: { marginTop: 'var(--sp-3)', color: 'var(--accent)' } },
    el('span', { text: o.disabled ? 'Needs a topic' : o.label }),
    icon('arrow-right', { size: 14 })));
}

function leechBlock(rows, root) {
  return el('section.card.card--tone', {
    dataset: { tone: 'warn' },
    style: { marginTop: 'var(--sp-4)' },
  },
  el('div.card__head',
    el('h3.card__title.row', icon('refresh', { size: 16 }), el('span', { text: 'Waiting for a rewrite' }))),
  el('p.text-meta', {
    text: rows.length + ' ' + fmt.plural(rows.length, 'card') + ' has lapsed six times. '
      + 'That is a badly-written card or a missing prerequisite — not a willpower problem. '
      + 'Rewrite it with Hermes, then put it back in the queue.',
  }),
  el('div.btn-row', { style: { marginTop: 'var(--sp-3)' } },
    el('button.btn.btn-secondary.btn--sm', {
      type: 'button',
      onClick: () => navigate('study', { mode: 'errors' }),
    }, icon('external-link', { size: 14 }), 'Open the rewrite list')));
}

function errorBookBlock(compact) {
  const host = el('div', { style: { marginTop: 'var(--sp-6)' } });
  const s = errorStats();
  if (!s.total) {
    host.appendChild(el('section.card.card--quiet',
      el('p.text-meta', { text: 'Your Error Book is empty. Every miss lands there automatically, with the one step that was missing.' })));
    return host;
  }
  renderErrorBook(host, { compact });
  if (compact) {
    host.appendChild(el('div.btn-row',
      el('button.btn.btn-ghost.btn--sm', {
        type: 'button',
        onClick: () => navigate('study', { mode: 'errors' }),
      }, icon('filter', { size: 14 }), 'Open the full Error Book (' + s.open + ' open)')));
  }
  return host;
}

function renderErrorsPage(root, params) {
  // renderErrorBook brings its own heading (and the row count) — a second one
  // above it just says "Error Book" twice.
  const host = el('div');
  root.replaceChildren(
    el('div.btn-row', { style: { marginBottom: 'var(--sp-4)' } },
      el('button.btn.btn-ghost.btn--sm', {
        type: 'button',
        onClick: () => navigate('study'),
      }, icon('arrow-left', { size: 14 }), 'Back to tonight')),
    host);
  renderErrorBook(host, { focusEntry: params && params.entry ? String(params.entry) : '' });
}

function sectionHead(title, sub) {
  return el('div.section-head',
    el('div',
      el('h1.section-head__title', { text: title }),
      sub ? el('p.section-head__sub', { text: sub }) : null));
}

/* =============================================================================
   3. THE RUNNER — commit before reveal
   ========================================================================== */

/**
 * @param {HTMLElement} root the view container
 * @param {{mode:'review'|'pretest', items:Array, topicId?:string,
 *          deferFeedback?:boolean, seedMs?:number, startIndex?:number,
 *          results?:object}} cfg
 */
function startRunner(root, cfg) {
  const mode = cfg.mode || 'review';
  const items = cfg.items.slice();
  const deferFeedback = !!cfg.deferFeedback;
  const clock = new SessionClock(cfg.seedMs || 0);
  const doneFlags = [];
  const queuedIds = new Set(items.map((i) => i.cardId));
  const poolById = new Map(buildPool().map((c) => [c.id, c]));

  const results = cfg.results || {
    attempts: 0,
    correct: 0,
    relearned: 0,
    confidentWrong: 0,
    hyperFixed: 0,
    newIntervals: [],
    ratedCards: [],
    answers: [],
    graded: 0,
  };

  let index = cfg.startIndex || 0;
  let shownAt = Date.now();
  let finished = false;

  const rail = sessionRail(items.length);
  const clockLabel = el('span.mono.text-meta', { text: '0:00' });
  const hatch = escapeHatch({
    getState: () => ({ sec: clock.elapsedSec(), cards: results.graded }),
    onBank: () => finish(true),
  });

  const header = el('div.card.card--flush', {
    style: {
      position: 'sticky',
      top: '0',
      zIndex: 'var(--z-raised)',
      padding: 'var(--sp-3)',
      marginBottom: 'var(--sp-4)',
      background: 'var(--surface)',
    },
  },
  el('div.row.row--between', { style: { marginBottom: 'var(--sp-2)', flexWrap: 'wrap', gap: 'var(--sp-2)' } },
    el('div.row', { style: { gap: 'var(--sp-2)' } },
      icon(mode === 'pretest' ? 'eye' : 'layers', { size: 14, cls: 'icon--accent' }),
      el('span.eyebrow', el('span', { text: mode === 'pretest' ? 'Pretest — answers at the end' : 'Retrieval' })),
      clockLabel),
    hatch.node),
  rail.node);

  const stage = el('div');
  const wrap = el('div', header, stage);
  root.replaceChildren(wrap);

  const ticker = setInterval(() => { clockLabel.textContent = fmt.clock(clock.elapsedSec()); }, 1000);

  live = {
    dispose() {
      clearInterval(ticker);
      hatch.dispose();
      clock.dispose();
      if (!finished) persistSession();
      live = null;
    },
  };

  function persistSession() {
    store.set(SESSION_KEY, {
      day: todayLocalISO(),
      mode,
      topicId: cfg.topicId || null,
      index,
      elapsedMs: clock.elapsedMs(),
      items: items.map((i) => ({ cardId: i.cardId, attempt: i.attempt, hyper: i.hyper, relearn: i.relearn, paired: i.paired })),
      results,
    });
  }

  /* ---- one card ---------------------------------------------------------- */

  function paint() {
    if (index >= items.length) return finish(false);
    const item = items[index];
    const content = cardContent(item.cardId);
    if (!content) { index += 1; return paint(); }

    rail.set(index, doneFlags);
    shownAt = Date.now();

    const card = el('section.card.card--tone.card--pad-lg', {
      dataset: { subject: subjectSlug(content.subject) },
    });

    const flags = el('div.chip-row', { style: { marginBottom: 'var(--sp-3)' } });
    if (item.hyper) {
      flags.appendChild(el('span.pill.pill--bad', icon('target', { size: 12 }),
        el('span', { text: 'This one bit you last time' })));
    }
    if (item.relearn) {
      flags.appendChild(el('span.pill.pill--warn', { text: 'Back for the criterion — attempt ' + item.attempt }));
    }
    if (item.paired) {
      flags.appendChild(el('span.pill.pill--info', icon('zap', { size: 12 }), el('span', { text: 'Now use it' })));
    }
    if (flags.children.length) card.appendChild(flags);

    card.appendChild(cardChips(content, item.card));

    const q = el('div.prose', { style: { margin: 'var(--sp-4) 0' } });
    md(q, content.q);
    card.appendChild(q);

    const conf = confidencePicker({ onPick: () => refreshSubmit() });
    card.appendChild(conf.node);
    card.appendChild(el('hr.divider'));

    const commit = commitPanel({ content, onChange: () => refreshSubmit() });
    card.appendChild(commit.node);

    const submit = el('button.btn.btn-primary.btn--block.btn--lg', {
      type: 'button',
      disabled: true,
      style: { marginTop: 'var(--sp-4)' },
      onClick: () => reveal(),
    }, icon('check', { size: 16 }), deferFeedback ? 'Lock it in' : 'Commit and reveal');
    card.appendChild(submit);

    const guard = el('p.hint', {
      style: { marginTop: 'var(--sp-2)' },
      text: 'Confidence first, then the answer. The card does not open until both are in.',
    });
    card.appendChild(guard);

    function refreshSubmit() {
      const ready = conf.get() !== null && commit.isCommitted();
      submit.disabled = !ready;
      guard.textContent = ready
        ? 'Ready. Nothing is revealed until you tap.'
        : (conf.get() === null ? 'Pick your confidence first — that is the measurement.' : 'Commit an answer — typed, chosen, or out loud.');
    }

    stage.replaceChildren(card);
    if (!prefersReducedMotion()) card.animate
      && card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });

    /* ---- reveal + grade -------------------------------------------------- */

    function reveal() {
      const elapsedMs = Date.now() - shownAt;
      const state = commit.state();
      const confidence = conf.get();
      const verdict = checkAnswer(state.typed, content, state.chosenIndex);
      submit.disabled = true;
      submit.style.display = 'none';
      guard.remove();
      // Commit-before-reveal cuts both ways: once it is open, the answer he
      // gave is the answer he gave (§1.5 — no browse view, no re-picking).
      commit.lock();

      results.answers.push({
        cardId: item.cardId,
        question: content.q,
        given: state.typed || ((verdict.chosenText) || ''),
        chosenIndex: state.chosenIndex,
        confidence,
        machine: verdict.machine,
        correct: verdict.correct,
        elapsedMs,
      });

      if (deferFeedback) {
        // §1.0 — pretest answers are DELAYED to the end of the lesson.
        logPretest(item, content, state, confidence, elapsedMs);
        results.graded += 1;
        doneFlags[index] = true;
        haptic('tap');
        index += 1;
        persistSession();
        return paint();
      }

      const finishGrade = (correct, answerAlreadyShown) => {
        const missingStep = correct ? '' : pickMissingStep(content, state.typed);
        const auto = autoRating({ correct, elapsedMs, confidence });
        card.appendChild(feedbackPanel({
          content,
          correct,
          given: state.typed,
          chosenIndex: state.chosenIndex,
          missingStep,
          autoReason: auto.reason,
          confidence,
          showAnswer: !answerAlreadyShown,
        }));
        const gr = gradeRow({
          card: item.card,
          suggested: auto.rating,
          onGrade: (rating) => commitGrade({ item, content, rating, correct, confidence, elapsedMs, given: state.typed, missingStep }),
        });
        card.appendChild(el('div', { style: { marginTop: 'var(--sp-4)' } }, gr.node));
        gr.focusSuggested();
        sound(correct ? 'correct' : 'wrong');
        haptic(correct ? 'success' : 'warn');
        card.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      };

      if (verdict.machine) {
        finishGrade(!!verdict.correct);
      } else {
        // Not machine-checkable → he calls it. We never guess a verdict.
        const ask = el('div.stack', { style: { '--gap': 'var(--sp-3)', marginTop: 'var(--sp-4)' } },
          el('div.eyebrow', el('span', { text: 'Open the answer and be strict' })),
          el('div.btn-row',
            el('button.btn.btn-secondary.btn--block', {
              type: 'button',
              onClick: () => { ask.remove(); finishGrade(true, true); },
            }, icon('circle-check', { size: 16 }), 'I had it'),
            el('button.btn.btn-secondary.btn--block', {
              type: 'button',
              onClick: () => { ask.remove(); finishGrade(false, true); },
            }, icon('circle-alert', { size: 16 }), 'I missed it')),
          el('p.hint', { text: '“Nearly” is a miss in the exam. Strict here is marks later.' }));
        card.appendChild(el('div.formula-block', { style: { marginTop: 'var(--sp-4)' } },
          el('div.eyebrow', { style: { marginBottom: '4px' } }, el('span', { text: 'Answer' })),
          (() => { const n = el('div'); md(n, content.a || '—'); return n; })()));
        card.appendChild(ask);
      }
    }
  }

  /* ---- write the grade --------------------------------------------------- */

  function commitGrade(g) {
    const { item, content, rating, correct, confidence, elapsedMs, given, missingStep } = g;
    const probe = item.attempt > 1;                 // criterion re-check: logged, not re-scheduled
    const criterion = !!correct;

    const res = applyGrade({
      card: item.card,
      rating,
      confidence,
      elapsedMs,
      kind: 'review',
      probe,
      grade: correct ? 'recalled' : 'lapsed',
      errorClass: correct ? null : (elapsedMs < 2500 ? 'slip' : 'conceptual'),
      production: given,
      criterion: criterion && !probe,
      source: probe ? 'hub-criterion' : 'hub',
    });

    results.attempts += 1;
    results.graded += 1;
    if (correct) results.correct += 1;

    if (probe && correct) {
      // Criterion reached on a re-entry — count the relearn session by hand,
      // because the probe path deliberately does not touch FSRS state.
      const today = todayLocalISO();
      if (item.card.lastCriterionDay !== today) {
        const bumped = {
          ...item.card,
          relearnSessions: (Number(item.card.relearnSessions) || 0) + 1,
          lastCriterionDay: today,
        };
        saveCard(bumped);
        item.card = bumped;
        results.ratedCards.push(bumped);
      }
      results.relearned += 1;
    }

    if (!probe) {
      item.card = res.card;
      results.ratedCards.push(res.card);
      const preview = res.card.review;
      if (preview && Number.isFinite(preview.interval_days)) results.newIntervals.push(preview.interval_days);
    }

    // Error Book + hypercorrection bookkeeping.
    if (correct) {
      if (item.hyper) results.hyperFixed += 1;
      noteCorrect(item.cardId);
    } else {
      if (Number(confidence) >= CONFIDENT_THRESHOLD) results.confidentWrong += 1;
      addMiss({
        cardId: item.cardId,
        given,
        correct: content.a,
        missingStep,
        confidence,
        question: content.q,
      });
    }

    if (res.leechTriggered) {
      addLeech({ cardId: item.cardId, given, missingStep });
      toast('That card has lapsed six times — it is suspended until you rewrite it with Hermes. Bad card, not bad student.', { tone: 'warn', timeout: 7000 });
    }

    // ONE call per retrieval. game.js owns the ring, the XP (wrong answers
    // included) and the attendance touch — no seconds here, the session clock
    // is reported once by recordSession() at the end.
    recordActivity('review', {
      count: 1,
      cardId: item.cardId,
      topic: item.card.topic,
      subject: content.subject,
      unit: item.card.unit || undefined,
      correct,
      confidence,
      source: 'hub-study',
    });

    doneFlags[index] = true;

    // Missed → back after ~5 cards, to criterion, then stop (§1.5).
    if (!correct) {
      const requeued = requeueForCriterion(items, index, item);
      if (requeued) rail.grow();
    }

    // Every recall chased by its paired application item (§1.5).
    if (correct && !item.paired) {
      const paired = pairedItemFor(item, poolById, queuedIds);
      if (paired) {
        items.splice(index + 1, 0, paired);
        queuedIds.add(paired.cardId);
        rail.grow();
      }
    }

    index += 1;
    persistSession();
    paint();
  }

  /* ---- pretest logging (delayed feedback) -------------------------------- */

  function logPretest(item, content, state, confidence, elapsedMs) {
    // Authored prompts have no node in the engine's graph, so a replayed
    // `rate --file` line for them would invent one. They are persisted at the
    // reveal step instead — as Error Book rows, where they are worth something.
    if (item.synthetic) return;
    applyGrade({
      card: item.card,
      rating: 'again',
      confidence,
      elapsedMs,
      kind: 'pretest',
      probe: true,                // never scores, never schedules (§1.0)
      production: state.typed,
      source: 'hub-pretest',
    });
  }

  /* ---- end --------------------------------------------------------------- */

  function finish(banked) {
    if (finished) return;
    finished = true;
    clearInterval(ticker);
    hatch.dispose();
    clock.pause();
    clearSavedSession();

    // ATTENDANCE IS BANKED HERE, not on the reflection form. The escape hatch
    // promises "this always counts" (pedagogy-spec §1.7 / R8) — if the night
    // only landed when he also filled in the effort slider, the promise would
    // be false for exactly the 90-second session it exists to protect.
    const seconds = clock.elapsedSec();
    const floorMet = seconds >= SESSION_FLOOR_SECONDS || results.graded >= SESSION_FLOOR_CARDS;
    recordSession({ seconds, source: 'hub-' + mode });
    if (floorMet) celebrate({ kind: 'session', label: 'Night banked' });

    renderEnd(root, {
      mode,
      results,
      seconds: clock.elapsedSec(),
      banked,
      answers: results.answers,
      deferFeedback,
      topicId: cfg.topicId,
    });
    clock.dispose();
    live = null;
  }

  paint();
}

/* =============================================================================
   4. SESSION END — competence statement, effort, takeaway
   ========================================================================== */

function renderEnd(root, o) {
  const results = o.results;
  const floorMet = o.seconds >= SESSION_FLOOR_SECONDS || results.graded >= SESSION_FLOOR_CARDS;
  const milestones = relearnMilestones(results.ratedCards || []);
  const sure = (results.answers || []).filter((a) => Number(a.confidence) >= CONFIDENT_THRESHOLD).length;
  const lines = o.deferFeedback
    // §1.0 — a pretest is never scored, so the statement is about the act, not marks.
    ? [
      results.graded + ' ' + fmt.plural(results.graded, 'question') + ' answered before being taught. No score is kept — that is the design.',
      sure
        ? sure + ' of them you were sure about. Those are the ones to read twice below: being certain and wrong is where marks actually go.'
        : 'You were unsure throughout, which is exactly right for material you have not met.',
      'Retrieving before the lesson is what makes the lesson stick. The answers are underneath.',
    ]
    : competenceLines({
      attempts: results.attempts,
      correct: results.correct,
      relearned: results.relearned,
      newIntervals: results.newIntervals,
      hyperFixed: results.hyperFixed,
      confidentWrong: results.confidentWrong,
      milestones,
    });

  const head = el('section.card.card--tone.card--2xl.card--pad-lg', {
    dataset: { tone: floorMet ? 'good' : 'neutral' },
  },
  el('div.eyebrow.eyebrow--dot', el('span', { text: floorMet ? 'Night banked' : 'Session ended' })),
  el('div.stat__value', {
    style: { fontSize: 'var(--fs-metric)', marginTop: 'var(--sp-2)' },
    text: fmt.dur(o.seconds * 1000),
  }),
  el('div.stack', { style: { '--gap': 'var(--sp-2)', marginTop: 'var(--sp-4)' } },
    lines.map((t) => el('p', { style: { fontSize: 'var(--fs-body-lg)', lineHeight: 'var(--lh-snug)' }, text: t }))),
  floorMet ? null : el('p.hint', {
    style: { marginTop: 'var(--sp-3)' },
    text: 'Under the 90-second floor, so this one does not count as a night yet. One more card gets you there.',
  }));

  const effort = effortSlider();
  const binary = modeBinary();
  const takeaway = takeawayField();

  const reflect = el('section.card.card--pad-lg', { style: { marginTop: 'var(--sp-4)' } },
    el('div.card__head', el('h3.card__title', { text: 'Two questions, then you are done' })),
    el('div.stack', { style: { '--gap': 'var(--sp-5)' } },
      effort.node,
      binary.node,
      takeaway.node),
    el('div.btn-row', { style: { marginTop: 'var(--sp-5)' } },
      el('button.btn.btn-primary.btn--lg', {
        type: 'button',
        onClick: (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          saveReflection({
            mode: o.mode,
            effort: effort.get(),
            thinking: binary.get(),
            takeaway: takeaway.get(),
            cards: results.graded,
            correct: results.correct,
            seconds: o.seconds,
            banked: floorMet,
          });
          // Attendance + confetti already fired when the session ended — this
          // button only saves the reflection, so it can never double-count.
          toast(floorMet ? 'Banked. Same time tomorrow.' : 'Saved.', { tone: 'good' });
          navigate('home');
        },
      }, icon('check', { size: 16 }), 'Save and finish'),
      el('button.btn.btn-ghost.btn--lg', {
        type: 'button',
        onClick: () => navigate('study'),
      }, icon('refresh', { size: 16 }), 'Another block')));

  const blocks = [sectionHead('Session', ''), head, reflect];
  if (o.deferFeedback) blocks.splice(2, 0, pretestReveal(o.answers));
  root.replaceChildren(...blocks);
}

/* =============================================================================
   5. PRETEST (§1.0) — 3–5 higher-order questions, delayed answers, no score
   ========================================================================== */

function renderPretest(root, topicId) {
  const topic = topicId ? getTopic(topicId) : null;
  if (!topic) {
    root.replaceChildren(sectionHead('Pretest', ''), emptyState({
      icon: 'circle-alert',
      title: 'Pick a topic first',
      body: 'A pretest runs on one chapter you have not studied yet.',
      action: { label: 'Back to study', href: routeFor('study') },
    }));
    return;
  }

  const items = pretestItems(topic);
  if (!items.length) {
    root.replaceChildren(sectionHead('Pretest · ' + topic.name, ''), emptyState({
      icon: 'eye',
      title: 'Nothing unstudied left here',
      body: 'A pretest only works on material you have not met. Every card in this chapter is already in the schedule.',
      action: { label: 'Back to study', href: routeFor('study') },
    }));
    return;
  }

  const intro = el('section.card.card--tone.card--pad-lg', { dataset: { subject: subjectSlug(topic.subject) } },
    el('div.eyebrow.eyebrow--dot', el('span', { text: topic.name })),
    el('h2.card__title', { style: { fontSize: 'var(--fs-title-lg)', marginTop: 'var(--sp-2)' }, text: 'Pretest — ' + items.length + ' questions' }),
    el('div.stack', { style: { '--gap': 'var(--sp-2)', marginTop: 'var(--sp-3)' } },
      el('p', { text: 'You are expected to get these wrong — that is the point.' }),
      el('p.text-meta', { text: 'Answering before you learn makes the lesson stick harder. Nothing here is scored, nothing is shown to anyone, and no score is kept.' }),
      el('p.text-meta', { text: 'Answers are held back until the end, all at once. Pick your confidence honestly: being sure and wrong is the single most useful thing this test can find.' })),
    el('div.btn-row', { style: { marginTop: 'var(--sp-5)' } },
      el('button.btn.btn-primary.btn--lg', {
        type: 'button',
        onClick: () => startRunner(root, { mode: 'pretest', items, topicId, deferFeedback: true }),
      }, icon('play', { size: 16 }), 'Start the pretest')));

  root.replaceChildren(sectionHead('Pretest', topic.name), intro);
}

/** Prefer authored higher-order prompts; else unseen cards, application first. */
function pretestItems(topic) {
  const authored = (topic.raw && Array.isArray(topic.raw.pretest)) ? topic.raw.pretest : [];
  if (authored.length) {
    return authored.slice(0, 5).map((p, i) => {
      const id = 'pretest-' + topic.id + '-' + i;
      registerTransientContent({
        id,
        q: String((p && (p.q || p.question)) || ''),
        a: String((p && (p.a || p.answer)) || ''),
        explanation: (p && p.explanation) || '',
        topicId: topic.id,
        topicName: topic.name,
        subject: topic.subject,
        unit: topic.unit,
      });
      return {
        cardId: id,
        card: { id, topic: topic.id, subject: topic.subject },
        attempt: 1,
        relearn: false,
        hyper: false,
        paired: false,
        isNew: true,
        synthetic: true,
      };
    }).filter((it) => {
      const c = cardContent(it.cardId);
      return c && c.q;
    });
  }
  const pool = buildPool().filter((c) => c.topic === topic.id && isNew(c) && !c.suspended);
  const score = (c) => {
    const m = cardMeta(c.id);
    if (m.cognitive === 'higher') return 0;
    if (m.cognitive === 'application') return 1;
    return 2;
  };
  return pool.sort((a, b) => score(a) - score(b)).slice(0, 5).map((c) => ({
    cardId: c.id,
    card: c,
    attempt: 1,
    relearn: false,
    hyper: false,
    paired: false,
    isNew: true,
  }));
}

/**
 * All the answers at once, at the end — the delayed-feedback condition (R5).
 * A pretest is never scored, so the machine cannot say who was wrong. He can:
 * one tap per row sends it to the Error Book, which is where §1.0's
 * "hypercorrection fires on confident-wrong" actually happens.
 */
function pretestReveal(answers) {
  const wrap = el('section.card.card--pad-lg', { style: { marginTop: 'var(--sp-4)' } },
    el('div.card__head',
      el('h3.card__title', { text: 'Now the answers' }),
      el('p.card__sub', { text: 'No score — read them in one pass. The ones you were sure about are the ones to read twice.' })));

  for (const a of answers) {
    const content = cardContent(a.cardId);
    const row = el('div', { style: { paddingTop: 'var(--sp-4)', marginTop: 'var(--sp-4)', borderTopWidth: '1px' } });
    const confident = Number(a.confidence) >= CONFIDENT_THRESHOLD;
    row.appendChild(el('div.chip-row', { style: { marginBottom: 'var(--sp-2)' } },
      el('span.chip.chip--micro', { text: 'Confidence ' + (a.confidence || '—') + '/5' }),
      confident ? el('span.pill.pill--warn', { text: 'You were sure — read this one twice' }) : null));
    const q = el('div.prose');
    md(q, a.question || (content ? content.q : ''));
    row.appendChild(q);
    if (a.given) {
      row.appendChild(el('div', { style: { marginTop: 'var(--sp-2)' } },
        el('div.eyebrow', el('span', { text: 'You wrote' })),
        el('p.text-meta', { text: a.given })));
    }
    const ansNode = el('div.formula-block', { style: { marginTop: 'var(--sp-2)' } });
    md(ansNode, (content && content.a) || '—');
    row.appendChild(ansNode);

    const mark = el('button.btn.btn-secondary.btn--sm', {
      type: 'button',
      onClick: () => {
        mark.disabled = true;
        mark.textContent = confident ? 'In the Error Book — it leads next session' : 'In the Error Book';
        addMiss({
          cardId: a.cardId,
          kind: 'pretest',
          question: a.question || (content ? content.q : ''),
          given: a.given,
          correct: (content && content.a) || '',
          missingStep: content ? pickMissingStep(content, a.given) : '',
          confidence: a.confidence,
        });
      },
    }, icon('circle-alert', { size: 14 }),
    confident ? 'I was sure — and I had it wrong' : 'I had this wrong');
    row.appendChild(el('div.btn-row', { style: { marginTop: 'var(--sp-3)' } }, mark));
    wrap.appendChild(row);
  }
  return wrap;
}

/* =============================================================================
   6. PRIME (§1.1) — 10–20 min, structure only, zero detail
   ========================================================================== */

const PRIME_QUESTIONS = [
  'Without any detail: what are the 3–5 big groups this chapter splits into?',
  'Which two of those groups do you think are most connected — and why do you think so?',
  'What is this chapter FOR? What will you be able to do at the end that you cannot do now?',
];

function renderPrime(root, topicId) {
  const topic = topicId ? getTopic(topicId) : null;
  if (!topic) {
    root.replaceChildren(sectionHead('Prime', ''), emptyState({
      icon: 'circle-alert',
      title: 'Pick a chapter to prime',
      body: 'Priming runs on the chapter you are about to be taught.',
      action: { label: 'Back to study', href: routeFor('study') },
    }));
    return;
  }

  let minutes = 15;
  const clock = new SessionClock(0);
  let ticker = null;

  const banner = el('section.card.card--tone', { dataset: { tone: 'warn' } },
    el('div.row', { style: { gap: 'var(--sp-2)' } },
      icon('alert-triangle', { size: 16, cls: 'icon--accent' }),
      el('span.card__title', { text: 'Priming only. No detail.' })),
    el('p.text-meta', { style: { marginTop: 'var(--sp-2)' },
      text: 'If you catch yourself writing definitions or worked steps, stop. Detail now is studying done early — it does not stick, and it eats the time that does.' }));

  const timerLabel = el('span.stat__value', { style: { fontSize: 'var(--fs-metric)' }, text: fmt.clock(minutes * 60) });
  const timerNote = el('p.hint', { text: 'Pick a box, then start. When it ends, you stop — that is the whole technique.' });

  const boxes = el('div.segmented', [10, 15, 20].map((m) => el('button.segmented__btn', {
    type: 'button',
    class: m === minutes ? 'is-active' : '',
    onClick: (e) => {
      minutes = m;
      for (const b of e.currentTarget.parentNode.children) b.classList.remove('is-active');
      e.currentTarget.classList.add('is-active');
      timerLabel.textContent = fmt.clock(minutes * 60);
    },
  }, el('span', { text: m + ' min' }))));

  /* --- the worksheet ---------------------------------------------------- */

  const terms = el('textarea.textarea', {
    rows: 5,
    placeholder: 'One term per line — just the words you can see in the material. No meanings.',
    attrs: { 'aria-label': 'Keyword harvest' },
  });
  const shuffled = el('div.chip-row', { style: { marginTop: 'var(--sp-2)' } });
  const shuffleBtn = el('button.btn.btn-secondary.btn--sm', {
    type: 'button',
    onClick: () => {
      const list = terms.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      shuffled.replaceChildren();
      // Deliberately shuffled: the order in the book is not the order in your head.
      const arr = list.slice();
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      for (const t of arr) shuffled.appendChild(el('span.chip', { text: t }));
      if (!arr.length) shuffled.appendChild(el('span.hint', { text: 'Add a few terms first.' }));
    },
  }, icon('refresh', { size: 14 }), 'Shuffle them');

  const answers = PRIME_QUESTIONS.map((qText, i) => {
    const input = el('textarea.textarea', {
      rows: 2,
      placeholder: 'Guess. Being wrong here costs nothing.',
      attrs: { 'aria-label': 'Structure question ' + (i + 1) },
    });
    return { qText, input, node: el('div.field', el('span.label', { text: qText }), input) };
  });

  const skeleton = el('textarea.textarea', {
    rows: 4,
    placeholder: 'One group per line, max three words each. This is a guess, and it is saved as version v0.',
    attrs: { 'aria-label': 'Skeleton map v0' },
  });

  const saveBtn = el('button.btn.btn-primary.btn--lg', {
    type: 'button',
    onClick: () => savePrime(),
  }, icon('check', { size: 16 }), 'Save the hypothesis');

  const startBtn = el('button.btn.btn-primary.btn--lg', {
    type: 'button',
    onClick: () => startTimer(),
  }, icon('timer', { size: 16 }), 'Start the box');

  function startTimer() {
    startBtn.disabled = true;
    const endsAt = Date.now() + minutes * 60000;
    ticker = setInterval(() => {
      const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      timerLabel.textContent = fmt.clock(left);
      if (left <= 0) {
        clearInterval(ticker);
        ticker = null;
        timerNote.textContent = 'Time. Stop here — priming past the box stops being priming.';
        sound('complete');
        haptic('warn');
        savePrime(true);
      }
    }, 1000);
  }

  function savePrime(auto) {
    const list = terms.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const groups = skeleton.value.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    const seconds = clock.elapsedSec();
    const version = store.update(PRIME_KEY, (prev) => {
      const map = (prev && typeof prev === 'object') ? { ...prev } : {};
      const rows = Array.isArray(map[topic.id]) ? map[topic.id].slice() : [];
      rows.push({
        id: uid('prime'),
        v: rows.length,
        ts: Date.now(),
        day: todayLocalISO(),
        topicId: topic.id,
        topicName: topic.name,
        minutes,
        seconds,
        keywords: list,
        answers: answers.map((a) => ({ q: a.qText, a: a.input.value.trim() })),
        skeleton: groups,
      });
      map[topic.id] = rows;
      return map;
    }, {})[topic.id].length - 1;

    // Priming is encoding work: one encode unit, and game.js pays the XP.
    recordActivity('encode', {
      count: 1,
      topic: topic.id,
      subject: topic.subject,
      source: 'hub-prime',
    });
    recordSession({ seconds, source: 'hub-prime' });
    try {
      window.dispatchEvent(new CustomEvent('engram:prime-saved', {
        detail: { topicId: topic.id, version, skeleton: groups },
      }));
    } catch (_) { /* non-fatal */ }
    toast('Saved as v' + version + '. The diff against your real map later is the evidence your schema changed.', { tone: 'good', timeout: 6000 });
    if (!auto) navigate('study');
  }

  const prior = (store.get(PRIME_KEY, {}) || {})[topic.id] || [];

  root.replaceChildren(
    sectionHead('Prime · ' + topic.name, 'Structure before detail, in a box you cannot exceed.'),
    banner,
    el('section.card.card--pad-lg', { style: { marginTop: 'var(--sp-4)' } },
      el('div.row.row--between', { style: { flexWrap: 'wrap', gap: 'var(--sp-3)' } },
        el('div', el('div.eyebrow.eyebrow--dot', el('span', { text: 'Timebox' })), timerLabel),
        boxes),
      timerNote,
      el('div.btn-row', { style: { marginTop: 'var(--sp-3)' } }, startBtn)),
    el('section.card.card--pad-lg', { style: { marginTop: 'var(--sp-4)' } },
      el('div.card__head',
        el('h3.card__title', { text: '1 · Harvest the words' }),
        el('p.card__sub', { text: 'Skim the chapter and pull the terms. Nothing else.' })),
      terms,
      el('div.btn-row', { style: { marginTop: 'var(--sp-2)' } }, shuffleBtn),
      shuffled),
    el('section.card.card--pad-lg', { style: { marginTop: 'var(--sp-4)' } },
      el('div.card__head',
        el('h3.card__title', { text: '2 · Guess the structure' }),
        el('p.card__sub', { text: 'Three questions. Guesses only — you have not been taught this yet.' })),
      el('div.stack', { style: { '--gap': 'var(--sp-4)' } }, answers.map((a) => a.node))),
    el('section.card.card--pad-lg', { style: { marginTop: 'var(--sp-4)' } },
      el('div.card__head',
        el('h3.card__title', { text: '3 · Skeleton, version 0' }),
        el('p.card__sub', { text: 'Groups only, three words each. Saved as a hypothesis you will diff later.' })),
      skeleton,
      el('div.btn-row', { style: { marginTop: 'var(--sp-4)' } },
        saveBtn,
        el('a.btn.btn-ghost.btn--lg', { href: routeFor('maps', { topic: topic.id }) },
          icon('waypoints', { size: 16 }), 'Open the map canvas'))),
    // Spread, never `: null` — replaceChildren() is native DOM and stringifies a
    // null argument into a literal "null" text node on screen. This is the
    // common branch: every first Prime of a chapter has no earlier hypothesis.
    ...(prior.length
      ? [el('section.card.card--quiet', { style: { marginTop: 'var(--sp-4)' } },
        el('p.text-meta', { text: prior.length + ' earlier ' + fmt.plural(prior.length, 'hypothesis', 'hypotheses') + ' saved for this chapter. The newest is v' + (prior.length - 1) + ', from ' + fmt.dateShort(prior[prior.length - 1].ts) + '.' }))]
      : []));

  live = {
    dispose() {
      if (ticker) clearInterval(ticker);
      clock.dispose();
      live = null;
    },
  };
}

/* =============================================================================
   7. RESUME
   ========================================================================== */

function readSavedSession() {
  const s = store.get(SESSION_KEY, null);
  if (!s || typeof s !== 'object' || !Array.isArray(s.items)) return null;
  return s;
}

function clearSavedSession() { store.remove(SESSION_KEY); }

function resumeSaved(root, saved) {
  const pool = new Map(buildPool().map((c) => [c.id, c]));
  const items = saved.items
    .map((i) => {
      const card = pool.get(i.cardId);
      if (!card) return null;
      return {
        cardId: i.cardId,
        card,
        attempt: Number(i.attempt) || 1,
        hyper: !!i.hyper,
        relearn: !!i.relearn,
        paired: !!i.paired,
        isNew: isNew(card),
      };
    })
    .filter(Boolean);
  if (!items.length) { clearSavedSession(); return renderIntro(root, { topicId: saved.topicId }); }
  startRunner(root, {
    mode: saved.mode === 'pretest' ? 'pretest' : 'review',
    deferFeedback: saved.mode === 'pretest',
    items,
    topicId: saved.topicId,
    seedMs: Number(saved.elapsedMs) || 0,
    startIndex: Math.min(Number(saved.index) || 0, items.length),
    results: saved.results && typeof saved.results === 'object' ? saved.results : undefined,
  });
}

/* =============================================================================
   8. VIEW EXPORT
   ========================================================================== */

export default {
  id: 'study',
  title: 'Study',
  icon: 'layers',

  render(root, params) {
    renderStudy(root, params || {});
  },

  onEnter() {
    if (deckListener) return;
    deckListener = () => {
      invalidatePool();
      toast('Deck imported — it is in tonight’s pool.', { tone: 'good' });
    };
    window.addEventListener('engram:import-deck', deckListener);
  },

  onExit() {
    if (live) { live.dispose(); live = null; }
    if (deckListener) {
      window.removeEventListener('engram:import-deck', deckListener);
      deckListener = null;
    }
  },
};
