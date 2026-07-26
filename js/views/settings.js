/* =============================================================================
   js/views/settings.js — the controls that are allowed to exist.

   Owner: Job — profile + community editors + settings.
   Imports: config.js · store.js · scheduler.js · dom.js · community.js

   THE RULE THIS SCREEN OBEYS (pedagogy §2 anti-features)
     No setting here selects an easier study mode. The time budget changes how
     LONG tonight is, never how hard; retention, caps and intervals stay with
     the scheduler. Nothing on this page can delete review history.

   PUBLIC API (other features read the study-load settings through these — they
   are the sanctioned way to feed scheduler.buildSession()):
     getTimeBudgetMin()      -> number  (minutes)
     getExamCalendar()       -> [{id, subject, label, date, confidence}]
     getExamDates()          -> {subject: 'YYYY-MM-DD'}   confident dates only
     getSchedulerOptions()   -> {timeBudgetMin, examDates}
   ========================================================================== */

import CONFIG, {
  APP_VERSION, DEFAULT_SETTINGS, getSettings, setSettings, hasSupabase,
} from '../config.js';
import { store, KEYS, uid, todayLocalISO, diffDaysISO, addDaysISO, daysFromToday } from '../store.js';
import { el, replace, icon, fmt, toast, haptic } from '../dom.js';
import {
  examRamp, EXAM_RAMP_DAYS, EXAM_RAMP_START_RETENTION, EXAM_RAMP_END_RETENTION,
  SCHEDULER_DEFAULTS, NEW_PER_DAY_MIN, NEW_PER_DAY_MAX,
} from '../scheduler.js';
import {
  openSheet, confirmSheet, loadSb, loadGame, sbReady, currentUser, field, selectField,
} from '../community.js';
import { getSubjects } from '../vault.js';

/* =============================================================================
   1. STUDY-LOAD API  (the scheduler feed)
   ========================================================================== */

const BUDGET_MIN = 10;
const BUDGET_MAX = 60;
const BUDGET_STEP = 5;

/** The nightly time budget in minutes. Clamped to something survivable. */
export function getTimeBudgetMin() {
  const s = getSettings();
  const n = Number(s.dailyMinutes);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.dailyMinutes;
  return Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, Math.round(n / BUDGET_STEP) * BUDGET_STEP));
}

/**
 * Confidence, and the one thing it controls: whether a date is allowed to drive
 * scheduler.examRamp() — the 21-day climb from 0.90 to 0.95 retention.
 *
 * `ramps` is false for anything nobody has actually confirmed. Raising his
 * nightly workload for three weeks on a date drawn from "the usual rhythm" is
 * exactly the on-no-evidence cost the spec forbids, so an unconfirmed date
 * counts down and plans backwards but never tightens retention.
 *
 * The stored values are grow.js's vocabulary (`high|med|low`) on purpose.
 * Three modules read this one key and only grow.js validates the word — it
 * rewrites anything else to 'low'. Writing "confirmed" here would therefore
 * show a date he CONFIRMED as low-confidence on the GROW grid, and a write-back
 * from that screen would hand 'low' to `confidenceRamps()` and silently switch
 * off a ramp he had earned. One vocabulary, no round-trip losses.
 */
export const EXAM_CONFIDENCE = Object.freeze([
  { value: 'high', label: 'Confirmed by school', ramps: true },
  { value: 'med', label: 'Expected — school said roughly this', ramps: true },
  { value: 'low', label: 'Not confirmed — do not plan on it', ramps: false },
]);

/** The student-facing word for a stored confidence value. */
export function confidenceLabel(v) {
  const row = EXAM_CONFIDENCE.find((x) => x.value === normaliseConfidence(v));
  return row ? row.label : 'Not confirmed';
}

/** The short form for a pill. */
export function confidenceShort(v) {
  const c = normaliseConfidence(v);
  return c === 'high' ? 'confirmed' : (c === 'med' ? 'expected' : 'not confirmed');
}

/**
 * ONE exam calendar, at one raw store key — shared with game.js AND grow.js,
 * which each normalise it into their own row shape:
 *
 *   settings/game : {id, label, date:'YYYY-MM-DD', bs, phase, confidence, subjects:[], detail}
 *   grow          : {id, label, ad:'YYYY-MM-DD',  bs, confidence:'high|med|low', kind, subject}
 *
 * Neither of those normalisers preserves fields it does not know, so this
 * editor writes the UNION: both `ad` and `date`, both `subject` and `subjects`,
 * and it carries `kind`/`phase`/`detail` through untouched. Editing a date here
 * therefore cannot silently delete another module's half of the row.
 *
 * `bs` is the Bikram Sambat date and is DISPLAY ONLY — every day calculation
 * runs on `date` through the store's local-date helpers.
 */
const EXAM_KEY = 'examCalendar';

/**
 * Three vocabularies exist in the wild: this editor's, grow.js's high/med/low,
 * and data/examCalendar.json's "estimate". Map them all, and send anything
 * unrecognised to a NON-ramping value — an unknown word must never be read as
 * permission to raise his retention target.
 */
const CONFIDENCE_ALIASES = Object.freeze({
  high: 'high', confirmed: 'high', certain: 'high',
  med: 'med', medium: 'med', expected: 'med',
  low: 'low', estimate: 'low', estimated: 'low', guess: 'low', unknown: 'low',
});

function normaliseConfidence(v) {
  const key = String(v == null ? '' : v).trim().toLowerCase();
  /* An unrecognised word is never read as permission to raise his retention
     target for three weeks — unknown falls to the non-ramping value. */
  return CONFIDENCE_ALIASES[key] || 'low';
}

/** Does this row's confidence permit the 21-day retention ramp? */
export function confidenceRamps(v) {
  const c = normaliseConfidence(v);
  const row = EXAM_CONFIDENCE.find((x) => x.value === c);
  return Boolean(row && row.ramps);
}

/** Normalise one row, preserving every field the other two readers need. */
function normaliseExamRow(input) {
  const e = input || {};
  const date = typeof e.ad === 'string' ? e.ad : String(e.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const subjects = Array.isArray(e.subjects)
    ? e.subjects.filter(Boolean).map(String)
    : (e.subject ? [String(e.subject)] : []);
  return {
    id: String(e.id || e.label || date),
    label: String(e.label || 'Exam'),
    date,
    ad: date,                                   // grow.js reads this one
    bs: e.bs ? String(e.bs) : null,
    phase: e.phase ? String(e.phase) : null,
    kind: e.kind ? String(e.kind) : null,       // grow.js's field — carried through
    confidence: normaliseConfidence(e.confidence),
    subjects,
    subject: subjects.length === 1 ? subjects[0] : null,
    detail: e.detail ? String(e.detail) : '',
  };
}

/** Exam calendar rows, earliest date first. Malformed rows are dropped. */
export function getExamCalendar() {
  const raw = store.get(EXAM_KEY, null);
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.events) ? raw.events : []);
  return list.map(normaliseExamRow).filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function setExamCalendar(rows) {
  const list = (Array.isArray(rows) ? rows : []).map(normaliseExamRow).filter(Boolean);

  const write = (warn) => {
    const ok = store.set(EXAM_KEY, list);
    if (!ok && warn) {
      toast('Storage is full — that date is in memory only. Export a backup.', { tone: 'warn', timeout: 8000 });
    }
    return ok;
  };
  write(true);

  /* Tell the game layer so its cached countdown does not go stale.
     game.setExamCalendar() re-normalises and writes this key back with ITS row
     shape, which keeps neither grow.js's `ad`/`kind` nor `subject` — so the
     union rows go back on top afterwards. Handing the calendar over must not
     cost the other two readers their half of the row. */
  loadGame().then((g) => {
    try {
      if (typeof g.setExamCalendar !== 'function') return;
      g.setExamCalendar(list);
      write(false);
    } catch (err) { console.warn('[settings] game.setExamCalendar failed', err); }
  });
  return list;
}

/**
 * {subject -> next date} for scheduler.desiredRetentionFor().
 * Only a date somebody actually confirmed drives the exam ramp — an estimated
 * or guessed date would quietly raise his workload for three weeks on no
 * evidence, so it is deliberately withheld from the scheduler.
 */
export function getExamDates() {
  const today = todayLocalISO();
  const out = {};
  for (const row of getExamCalendar()) {
    if (!confidenceRamps(row.confidence)) continue;
    if (diffDaysISO(today, row.date) < 0) continue;              // already sat
    for (const subject of row.subjects) {
      if (!out[subject]) out[subject] = row.date;                // sorted → nearest wins
    }
  }
  return out;
}

/** The nearest confirmed whole-exam date (a row with no subject list). */
export function getGlobalExamDate() {
  const today = todayLocalISO();
  for (const row of getExamCalendar()) {
    if (!confidenceRamps(row.confidence) || row.subjects.length) continue;
    if (diffDaysISO(today, row.date) < 0) continue;
    return row.date;
  }
  return null;
}

/** Everything scheduler.buildSession() wants from Settings, in one object. */
export function getSchedulerOptions() {
  return {
    timeBudgetMin: getTimeBudgetMin(),
    examDates: getExamDates(),
    examDate: getGlobalExamDate(),
  };
}

/* =============================================================================
   2. THE VIEW
   ========================================================================== */

const cleanups = [];
function addCleanup(fn) { if (typeof fn === 'function') cleanups.push(fn); }
function runCleanups() {
  while (cleanups.length) {
    const fn = cleanups.pop();
    try { fn(); } catch (err) { console.warn('[settings] cleanup failed', err); }
  }
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',

  render(root) {
    runCleanups();

    const loadHost = el('section.section');
    const feelHost = el('section.section');
    const examHost = el('section.section');
    const dataHost = el('section.section');
    const appHost = el('section.section');
    const dangerHost = el('section.section');

    root.appendChild(loadHost);
    root.appendChild(feelHost);
    root.appendChild(examHost);
    root.appendChild(dataHost);
    root.appendChild(appHost);
    root.appendChild(dangerHost);

    renderStudyLoad(loadHost);
    renderFeel(feelHost);
    renderExams(examHost);
    renderData(dataHost);
    renderApp(appHost);
    renderDanger(dangerHost);

    addCleanup(store.on('quota', () => renderData(dataHost)));
  },

  onExit() { runCleanups(); },
};

/* =============================================================================
   3. STUDY LOAD
   ========================================================================== */

function renderStudyLoad(host) {
  const minutes = getTimeBudgetMin();
  const readoutNum = el('span', { text: fmt.int(minutes) });
  const readout = el('div.stat__value.tabular', readoutNum, el('span.stat__unit', { text: 'min' }));

  const slider = el('input', {
    type: 'range',
    value: String(minutes),
    attrs: {
      min: String(BUDGET_MIN), max: String(BUDGET_MAX), step: String(BUDGET_STEP),
      'aria-label': 'Nightly time budget in minutes',
    },
    style: { width: '100%', minHeight: 'var(--tap)', accentColor: 'var(--brand)' },
    onInput: (e) => {
      const v = Number(e.target.value);
      readoutNum.textContent = fmt.int(v);
      updatePresets(v);
    },
    onChange: (e) => {
      const v = Number(e.target.value);
      setSettings({ dailyMinutes: v });
      haptic('select');
      toast('Tonight is ' + v + ' minutes.', { tone: 'good', timeout: 2200 });
    },
  });

  const presets = el('div.segmented',
    [15, 25, 35, 45].map((v) => el('button.segmented__btn', {
      type: 'button',
      class: v === minutes ? 'is-active' : null,
      attrs: { 'aria-pressed': String(v === minutes) },
      text: v + ' min',
      onClick: () => {
        slider.value = String(v);
        readoutNum.textContent = fmt.int(v);
        setSettings({ dailyMinutes: v });
        updatePresets(v);
        haptic('select');
      },
    })));

  function updatePresets(v) {
    Array.from(presets.children).forEach((btn) => {
      const on = btn.textContent.startsWith(String(v) + ' ');
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Study load' })),
        el('h2.section-head__title', { text: 'How long tonight runs' }))),
    el('article.card.card--tone', { dataset: { tone: 'brand' } },
      el('div.row.row--between', readout, presets),
      slider,
      el('p.hint', {
        text: 'The queue is filled to fit this budget, lowest-recall-first. It changes how long you sit, ' +
          'never how hard the cards are — retention stays at 0.90 and new cards stay capped at ' +
          NEW_PER_DAY_MIN + '–' + NEW_PER_DAY_MAX + ' a day.',
      }),
      el('div.card__foot',
        el('span.text-meta', {
          text: 'Floor: the 90-second, 5-card session still counts as a night. ' +
            'Reserve for new material: ' + Math.round(SCHEDULER_DEFAULTS.newReservePct * 100) + '%.',
        }))));
}

/* =============================================================================
   4. FEEL — sounds, haptics, motion, density
   ========================================================================== */

function toggleRow(labelText, hintText, checked, onChange, opts) {
  const o = opts || {};
  const control = el('label.toggle',
    el('input.toggle__input', {
      type: 'checkbox', checked,
      attrs: { 'aria-label': labelText },
      onChange: (e) => { onChange(e.target.checked === true); haptic('select'); },
    }),
    el('span.toggle__track', el('span.toggle__thumb')));

  return el('div.row.row--between', { style: { minHeight: 'var(--tap)', '--gap': 'var(--sp-4)' } },
    el('div.stack', { style: { '--gap': '2px', minWidth: '0' } },
      el('div.text-body-lg', { text: labelText }),
      hintText ? el('div.hint', { text: hintText }) : null),
    o.disabled
      ? el('span.pill.pill--neutral', { text: 'off in this build' })
      : control);
}

function renderFeel(host) {
  const s = getSettings();

  const motion = el('div.segmented',
    [['auto', 'Match device'], ['on', 'Reduce'], ['off', 'Full']].map(([value, label]) =>
      el('button.segmented__btn', {
        type: 'button',
        class: (s.reduceMotion || 'auto') === value ? 'is-active' : null,
        attrs: { 'aria-pressed': String((s.reduceMotion || 'auto') === value) },
        text: label,
        onClick: () => { setSettings({ reduceMotion: value }); haptic('select'); renderFeel(host); },
      })));

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Feel' })),
        el('h2.section-head__title', { text: 'Sound, buzz and motion' }))),
    el('div.card',
      toggleRow('Sounds', 'Short synthesised tones. No audio files, nothing downloaded.',
        s.sounds !== false, (v) => setSettings({ sounds: v }),
        { disabled: !CONFIG.FEATURES.sounds }),
      el('hr.divider'),
      toggleRow('Haptics', 'Android only — iPhone has no vibration API for web pages.',
        s.haptics !== false, (v) => setSettings({ haptics: v }),
        { disabled: !CONFIG.FEATURES.haptics }),
      el('hr.divider'),
      el('div.stack', { style: { '--gap': 'var(--sp-2)' } },
        el('div.text-body-lg', { text: 'Motion' }),
        el('div.hint', { text: 'Overrides your device setting for this app only.' }),
        el('div.row.row--wrap', motion)),
      el('hr.divider'),
      toggleRow('Streak flame in the header', 'Turn it off if seeing the count makes you play the streak instead of studying.',
        s.showStreakFlame !== false, (v) => setSettings({ showStreakFlame: v })),
      el('hr.divider'),
      toggleRow('Compact spacing', 'Tighter lists on a small screen.',
        s.compactDensity === true, (v) => setSettings({ compactDensity: v }))));
}

/* =============================================================================
   5. EXAM CALENDAR
   ========================================================================== */

function subjectChoices() {
  const base = ['Physics', 'Chemistry', 'Mathematics', 'Biology', 'English', 'Nepali', 'Computer Science'];
  const seen = new Set();
  const out = [{ value: '', label: 'All subjects' }];
  for (const s of getSubjects().concat(base)) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push({ value: s, label: s });
  }
  return out;
}

/**
 * The shipped calendar (data/examCalendar.json) is loaded and owned by game.js.
 * If nothing has written the store key yet, pull it through game.js's cached
 * loader once so this screen never says "no dates" while the rest of the app is
 * counting down to the First Terminal. Only ever fills an EMPTY key — it must
 * not overwrite dates he has already confirmed.
 */
let hydrating = false;

function hydrateExamCalendar(onDone) {
  if (hydrating || getExamCalendar().length) return;
  hydrating = true;
  loadGame().then(async (g) => {
    try {
      if (typeof g.loadExamCalendar !== 'function') return;
      const rows = await g.loadExamCalendar();
      if (!Array.isArray(rows) || !rows.length) return;
      if (getExamCalendar().length) return;                 // someone else got there first
      setExamCalendar(rows);
      if (typeof onDone === 'function') onDone();
    } catch (err) {
      console.warn('[settings] could not load the shipped exam calendar', err);
    } finally {
      hydrating = false;
    }
  });
}

function renderExams(host) {
  const rows = getExamCalendar();
  const today = todayLocalISO();
  if (!rows.length) hydrateExamCalendar(() => renderExams(host));

  const list = rows.length
    ? el('div.stack', { style: { '--gap': 'var(--sp-2)' } }, rows.map((r) => examRow(r, today, host)))
    : el('p.hint', { text: 'No dates yet. Add the First Terminal first — plans are generated backwards from a real date, and a wrong date is worse than none.' });

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Calendar' })),
        el('h2.section-head__title', { text: 'Exam dates' }),
        el('div.section-head__sub', {
          text: 'The last 21 days before a CONFIRMED paper raise its retention target from ' +
            EXAM_RAMP_START_RETENTION.toFixed(2) + ' to ' + EXAM_RAMP_END_RETENTION.toFixed(2) +
            ' automatically. Estimated dates count down but never change your workload.',
        })),
      el('div.section-head__actions',
        el('button.btn.btn-secondary.btn--sm', {
          type: 'button', onClick: () => openExamEditor(null, () => renderExams(host)),
        }, icon('plus', { size: 14 }), el('span', { text: 'Add a date' })))),
    el('div.card', list));
}

function examRow(row, today, host) {
  const days = daysFromToday(row.date);
  const past = days < 0;
  const drives = confidenceRamps(row.confidence);
  const inWindow = !past && days <= EXAM_RAMP_DAYS;
  const ramping = inWindow && drives;
  const retention = ramping ? examRamp(row.date) : null;
  const tone = past ? 'neutral' : (days <= 7 ? 'bad' : (ramping ? 'warn' : 'info'));
  const who = row.subjects.length ? row.subjects.join(', ') : 'all subjects';

  return el('div.card.card--quiet', { dataset: { tone } },
    el('div.row.row--between',
      el('div.stack', { style: { '--gap': '2px', minWidth: '0' } },
        el('div.text-body-lg.truncate', { text: row.label + ' · ' + who }),
        el('div.text-meta', {
          text: fmt.dateLong(row.date) + (row.bs ? ' · ' + row.bs + ' BS' : '') + ' · ' +
            (past ? 'sat ' + Math.abs(days) + ' ' + fmt.plural(Math.abs(days), 'day') + ' ago'
                  : days === 0 ? 'today' : days + ' ' + fmt.plural(days, 'day') + ' away'),
        }),
        ramping
          ? el('div.text-meta', {
              text: 'Exam ramp active — retention target ' + retention.toFixed(2) +
                ' (' + EXAM_RAMP_START_RETENTION.toFixed(2) + ' → ' + EXAM_RAMP_END_RETENTION.toFixed(2) + ').',
            })
          : null,
        (inWindow && !drives)
          ? el('div.text-meta', {
              text: 'Inside the 21-day window, but this date is not confirmed — retention stays at ' +
                EXAM_RAMP_START_RETENTION.toFixed(2) + '. Check it with school and mark it confirmed to switch the ramp on.',
            })
          : null),
      el('div.row',
        el('span.pill', {
          class: drives ? (row.confidence === 'high' ? 'pill--good' : 'pill--info') : 'pill--neutral',
          text: confidenceShort(row.confidence),
        }),
        el('button.btn-icon', {
          type: 'button', attrs: { 'aria-label': 'Edit ' + row.label },
          onClick: () => openExamEditor(row, () => renderExams(host)),
        }, icon('edit', { size: 16 })),
        el('button.btn-icon', {
          type: 'button', attrs: { 'aria-label': 'Delete ' + row.label },
          onClick: async () => {
            const yes = await confirmSheet({
              title: 'Remove “' + row.label + '”?',
              body: 'Plans built from this date stop counting down. Nothing you have studied is affected.',
              confirmLabel: 'Remove', tone: 'bad',
            });
            if (!yes) return;
            setExamCalendar(getExamCalendar().filter((r) => r.id !== row.id));
            renderExams(host);
          },
        }, icon('trash', { size: 16 })))));
}

function openExamEditor(row, onDone) {
  const state = {
    id: row ? row.id : uid('exam'),
    label: row ? row.label : '',
    /* A row covering several subjects shows as "All subjects" — picking a
       single one here would silently narrow a whole exam week down to it. */
    subject: (row && row.subjects.length === 1) ? row.subjects[0] : '',
    subjectTouched: false,
    date: row ? row.date : addDaysISO(todayLocalISO(), 30),
    bs: row && row.bs ? row.bs : '',
    confidence: row ? row.confidence : 'low',
  };
  const saveBtn = el('button.btn.btn-primary', { type: 'button', text: row ? 'Save' : 'Add date' });
  const check = () => { saveBtn.disabled = !state.label.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(state.date); };

  const sheet = openSheet({
    title: row ? 'Edit exam date' : 'Add an exam date',
    subtitle: 'Real dates only. Confirm them with school in week one.',
    body: [
      field('What is it', el('input.input', {
        type: 'text', value: state.label, attrs: { placeholder: 'First Terminal', maxlength: '60' },
        onInput: (e) => { state.label = e.target.value; check(); },
      }), null, { required: true }),
      field('Subject', selectField(subjectChoices(), state.subject, (v) => { state.subject = v; state.subjectTouched = true; }, { label: 'Subject' }),
        'Leave on “All subjects” for a whole exam week.'),
      field('Date (AD)', el('input.input', {
        type: 'date', value: state.date,
        attrs: { min: '2026-01-01', max: '2030-12-31', 'aria-label': 'Exam date' },
        onInput: (e) => { state.date = e.target.value; check(); },
      }), null, { required: true }),
      field('Date (BS) — optional', el('input.input.input--mono', {
        type: 'text', value: state.bs, attrs: { placeholder: '2083-08-15', maxlength: '12' },
        onInput: (e) => { state.bs = e.target.value; },
      }), 'Shown beside the AD date. Every countdown is calculated from the AD date.'),
      field('How sure are you', selectField(EXAM_CONFIDENCE, state.confidence, (v) => { state.confidence = v; }, { label: 'Confidence' }),
        'Only a confirmed or expected date drives the 21-day retention ramp. An unconfirmed date still counts down, but it will not raise your nightly workload on no evidence.'),
    ],
    foot: [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancel', onClick: () => sheet.close() }),
      saveBtn,
    ],
  });
  check();

  saveBtn.addEventListener('click', () => {
    const rows = getExamCalendar().filter((r) => r.id !== state.id);
    /* Spread the original row first so grow.js's `kind` and game.js's
       `phase`/`detail` survive an edit made on this screen. */
    rows.push(Object.assign({}, row || {}, {
      id: state.id,
      label: state.label.trim(),
      subjects: state.subjectTouched
        ? (state.subject ? [state.subject] : [])
        : (row ? row.subjects : (state.subject ? [state.subject] : [])),
      date: state.date,
      ad: state.date,
      bs: state.bs.trim() || null,
      confidence: state.confidence,
    }));
    setExamCalendar(rows);
    sheet.close();
    toast('Saved.', { tone: 'good' });
    if (typeof onDone === 'function') onDone();
  });
}

/* =============================================================================
   6. DATA — export, review log, import
   ========================================================================== */

function renderData(host) {
  const bytes = store.usageBytes();
  const logCount = store.reviewLogCount();
  const unsaved = store.hasUnsavedData();

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'Data' })),
        el('h2.section-head__title', { text: 'Your work, in your hands' }),
        el('div.section-head__sub', { text: 'The review log is append-only. Nothing on this screen can shorten it.' }))),

    unsaved
      ? el('div.card.card--quiet', { dataset: { tone: 'bad' }, style: { marginBottom: 'var(--sp-3)' } },
          el('div.row', icon('alert-triangle', { size: 16, cls: 'icon--accent' }),
            el('span.text-meta', {
              text: 'Some changes are in memory only because storage is full (' +
                store.unsavedKeys().join(', ') + '). Export a backup now.',
            })))
      : null,

    el('div.card',
      el('div.stat-row',
        el('div.stat', { dataset: { tone: 'info' } },
          el('div.stat__eyebrow', icon('file-text', { size: 14 }), el('span', { text: 'Review log' })),
          el('div.stat__value.stat__value--fg.tabular', { text: fmt.int(logCount) }),
          el('div.stat__sub', { text: 'entries, append-only' })),
        el('div.stat', { dataset: { tone: 'neutral' } },
          el('div.stat__eyebrow', icon('layers', { size: 14 }), el('span', { text: 'On this device' })),
          el('div.stat__value.stat__value--fg.tabular', { text: fmt.bytes(bytes) }),
          el('div.stat__sub', { text: store.isMemoryOnly ? 'memory only — private mode?' : 'local storage' }))),

      el('div.btn-row', { style: { marginTop: 'var(--sp-4)' } },
        el('button.btn.btn-primary.btn--sm', {
          type: 'button',
          onClick: () => {
            const ok = store.downloadBackup();
            toast(ok ? 'Backup downloaded.' : 'Download failed — try again.', { tone: ok ? 'good' : 'bad' });
          },
        }, icon('download', { size: 14 }), el('span', { text: 'Export everything' })),

        el('button.btn.btn-secondary.btn--sm', {
          type: 'button',
          onClick: () => {
            if (!logCount) { toast('No reviews logged yet.', { tone: 'info' }); return; }
            const ok = store.downloadReviewLog();
            toast(ok ? 'Review log downloaded (JSONL).' : 'Download failed — try again.', { tone: ok ? 'good' : 'bad' });
          },
        }, icon('upload', { size: 14 }), el('span', { text: 'Review log (.jsonl)' })),

        el('label.btn.btn-ghost.btn--sm',
          icon('paperclip', { size: 14 }),
          el('span', { text: 'Import a backup' }),
          el('input', {
            type: 'file', accept: '.json,application/json', class: 'sr-only',
            onChange: (e) => {
              const file = e.target.files && e.target.files[0];
              e.target.value = '';
              if (file) openImport(file, () => renderData(host));
            },
          }))),

      el('p.hint', { style: { marginTop: 'var(--sp-3)' },
        text: 'The .jsonl file is what engram.py replays with `rate --file` — it is the durable copy of every review you have ever done.' })));
}

function openImport(file, onDone) {
  const reader = new FileReader();
  reader.onerror = () => toast('That file could not be read.', { tone: 'bad' });
  reader.onload = async () => {
    let payload = null;
    try { payload = JSON.parse(String(reader.result || '')); }
    catch (_) { toast('That is not a valid Engram backup (bad JSON).', { tone: 'bad' }); return; }

    const dry = store.importAllData(payload, { merge: true, dryRun: true });
    if (!dry || dry.ok === false) { toast(dry && dry.error ? dry.error : 'That backup could not be read.', { tone: 'bad' }); return; }

    const keys = (dry.imported || []).concat(dry.merged || []);
    const yes = await confirmSheet({
      title: 'Merge this backup?',
      body: keys.length + ' ' + fmt.plural(keys.length, 'section') + ' will be merged into what is already here: ' +
        keys.slice(0, 8).join(', ') + (keys.length > 8 ? '…' : '') + '.',
      detail: 'Review-log entries are matched by id, so nothing is duplicated and nothing is removed. Merging never deletes.',
      confirmLabel: 'Merge it in',
    });
    if (!yes) return;

    const report = store.importAllData(payload, { merge: true });
    if (!report || report.ok === false) { toast(report && report.error ? report.error : 'Import failed.', { tone: 'bad' }); return; }
    toast('Imported. Reload to see everything.', {
      tone: 'good', timeout: 0,
      action: { label: 'Reload', onClick: () => location.reload() },
    });
    if (typeof onDone === 'function') onDone();
  };
  reader.readAsText(file);
}

/* =============================================================================
   7. APP + ACCOUNT
   ========================================================================== */

function renderApp(host) {
  const rowsHost = el('div.stack', { style: { '--gap': 'var(--sp-3)' } });

  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', el('span', { text: 'App' })),
        el('h2.section-head__title', { text: 'Version and account' }))),
    el('div.card', rowsHost));

  const infoRow = (label, value, tone) => el('div.row.row--between',
    el('span.text-meta', { text: label }),
    el('span.pill', { class: tone ? 'pill--' + tone : 'pill--neutral', text: value }));

  replace(rowsHost,
    infoRow('Version', APP_VERSION),
    infoRow('Time zone', CONFIG.TIMEZONE_LABEL),
    infoRow('Offline caching', ('serviceWorker' in navigator) ? 'available' : 'not supported',
      ('serviceWorker' in navigator) ? 'good' : 'warn'),
    infoRow('Community backend', hasSupabase() ? 'configured' : 'not configured',
      hasSupabase() ? 'good' : 'neutral'),
    el('div.btn-row',
      el('button.btn.btn-secondary.btn--sm', {
        type: 'button', onClick: (e) => checkForUpdate(e.currentTarget),
      }, icon('refresh', { size: 14 }), el('span', { text: 'Check for updates' }))));

  /* Account block is async — Supabase may not even be present. */
  renderAccount(rowsHost);
}

async function renderAccount(host) {
  if (!hasSupabase()) {
    host.appendChild(el('p.hint', {
      text: 'Sign-in, shared decks and the effort board switch on once SUPABASE_URL and SUPABASE_ANON_KEY are filled in (supabase/SETUP.md). Everything else works without them.',
    }));
    return;
  }
  const ready = await sbReady();
  if (!ready) {
    host.appendChild(el('p.hint', { text: 'Supabase is configured but the client has not loaded — sharing is offline for now.' }));
    return;
  }
  const user = await currentUser();
  if (!user) {
    host.appendChild(el('div.row.row--between',
      el('span.text-meta', { text: 'Not signed in' }),
      el('button.btn.btn-secondary.btn--sm', {
        type: 'button', onClick: () => toast('Open Chat to sign in — the account panel lives there.', { tone: 'info' }),
      }, icon('user', { size: 14 }), el('span', { text: 'Sign in' }))));
    return;
  }

  const isAdmin = Boolean(user.email && CONFIG.ADMIN_EMAIL &&
    String(user.email).toLowerCase() === String(CONFIG.ADMIN_EMAIL).toLowerCase());

  host.appendChild(el('hr.divider'));
  host.appendChild(el('div.row.row--between',
    el('div.stack', { style: { '--gap': '2px', minWidth: '0' } },
      el('div.text-body-lg.truncate', { text: String(user.email || 'Signed in') }),
      el('div.text-meta.mono.truncate', { text: String(user.id || '') })),
    isAdmin ? el('span.pill.pill--ai', icon('shield', { size: 12 }), el('span', { text: 'admin' })) : null));
  if (isAdmin) {
    host.appendChild(el('p.hint', {
      text: 'The admin badge only decides which buttons are drawn. Real permission is enforced by the database policy, server-side.',
    }));
  }
  host.appendChild(el('div.btn-row',
    el('button.btn.btn-ghost.btn--sm', {
      type: 'button',
      onClick: async () => {
        const yes = await confirmSheet({
          title: 'Sign out?',
          body: 'Your cards, streak and review log stay on this device — they are local. You just stop seeing the group shelf.',
          confirmLabel: 'Sign out',
        });
        if (!yes) return;
        const sb = await loadSb();
        try { await sb.auth.signOut(); toast('Signed out.', { tone: 'good' }); }
        catch (_) { toast('Could not sign out right now.', { tone: 'bad' }); }
      },
    }, icon('log-out', { size: 14 }), el('span', { text: 'Sign out' }))));
}

async function checkForUpdate(btn) {
  if (!('serviceWorker' in navigator)) { toast('This browser has no offline caching.', { tone: 'info' }); return; }
  if (btn) { btn.disabled = true; }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { toast('Offline caching is not active here — serve the hub over https.', { tone: 'info' }); return; }
    await reg.update();
    const waiting = reg.waiting;
    if (waiting) {
      toast('A new version is ready.', {
        tone: 'info', timeout: 0,
        action: {
          label: 'Update now',
          onClick: () => { try { waiting.postMessage({ type: 'SKIP_WAITING' }); } catch (_) { location.reload(); } },
        },
      });
    } else {
      toast('Checked — you are on version ' + APP_VERSION + '.', { tone: 'good' });
    }
  } catch (_) {
    toast('Could not check right now.', { tone: 'warn' });
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* =============================================================================
   8. DANGER ZONE
      Both actions are CACHE ONLY. Neither touches the review log, the SRS
      state, notes, maps, the vault or anything in the cloud.
   ========================================================================== */

const VOLATILE_KEYS = [KEYS.CHAT_CACHE, KEYS.SEARCH_RECENT, KEYS.UI];

function renderDanger(host) {
  replace(host,
    el('div.section-head',
      el('div',
        el('div.eyebrow.eyebrow--dot', { dataset: { tone: 'bad' } }, el('span', { text: 'Danger zone' })),
        el('h2.section-head__title', { text: 'Clearing caches' }),
        el('div.section-head__sub', { text: 'Neither button below can touch your progress. Review history has no delete path in this app, by design.' }))),

    el('article.card.card--tone', { dataset: { tone: 'bad' } },
      el('div.stack', { style: { '--gap': 'var(--sp-4)' } },
        dangerRow(
          'Clear the offline cache',
          'Deletes the downloaded copies of the app files and re-fetches them. Use it when an update seems stuck.',
          'Clear offline cache',
          async () => {
            const yes = await confirmSheet({
              title: 'Clear the offline cache?',
              body: 'The app files are downloaded again next time you are online. Your cards, streak, notes and review log are not stored in this cache and are not touched.',
              acknowledge: 'I understand this only clears downloaded app files.',
              confirmLabel: 'Clear cache', tone: 'bad',
            });
            if (!yes) return;
            await clearServiceWorkerCaches();
          }),

        el('hr.divider'),

        dangerRow(
          'Reset the local scratch data',
          'Chat cache, recent searches and the remembered last screen. Progress, cards, maps, notes and the review log stay exactly where they are.',
          'Reset scratch data',
          async () => {
            const yes = await confirmSheet({
              title: 'Reset scratch data?',
              body: 'This clears: cached chat messages, recent searches, and which screen you were last on. It cannot reach your SRS state, your review log, your notes, your maps or anything in the cloud.',
              detail: 'Export a backup first if you want to be certain — the button is one section up.',
              acknowledge: 'I have a backup, or I do not need one.',
              confirmLabel: 'Reset scratch data', tone: 'bad',
            });
            if (!yes) return;
            for (const key of VOLATILE_KEYS) store.remove(key);
            haptic('warn');
            toast('Scratch data cleared. Your progress is untouched.', { tone: 'good' });
          }))));
}

function dangerRow(title, body, actionLabel, onClick) {
  return el('div.row.row--between', { style: { '--gap': 'var(--sp-4)', alignItems: 'flex-start' } },
    el('div.stack', { style: { '--gap': '2px', minWidth: '0' } },
      el('div.text-body-lg', { text: title }),
      el('div.hint', { text: body })),
    el('button.btn.btn-danger.btn--sm', { type: 'button', text: actionLabel, onClick }));
}

async function clearServiceWorkerCaches() {
  if (!('serviceWorker' in navigator)) { toast('Nothing cached here.', { tone: 'info' }); return; }
  const reg = await navigator.serviceWorker.getRegistration();
  const target = navigator.serviceWorker.controller || (reg && (reg.active || reg.waiting));
  if (!target) { toast('No cache is active on this device.', { tone: 'info' }); return; }

  let settled = false;
  const done = (msg, tone) => {
    if (settled) return;
    settled = true;
    navigator.serviceWorker.removeEventListener('message', onMessage);
    toast(msg, {
      tone, timeout: 0,
      action: { label: 'Reload', onClick: () => location.reload() },
    });
  };
  function onMessage(event) {
    if (event.data && event.data.type === 'CACHES_CLEARED') {
      done('Offline cache cleared. Reload to fetch fresh files.', 'good');
    }
  }
  navigator.serviceWorker.addEventListener('message', onMessage);
  try { target.postMessage({ type: 'CLEAR_CACHES' }); }
  catch (_) { done('Could not reach the cache worker.', 'warn'); return; }
  setTimeout(() => done('Cache clear requested. Reload to fetch fresh files.', 'info'), 2500);
}
