/* srs.js — SM-2 derived scheduler with FSRS-flavoured fuzz and lapse handling.
   Grades: 1 Again · 2 Hard · 3 Good · 4 Easy */

(function (global) {
  'use strict';

  var DAY = 86400000;

  function today() {
    var d = new Date(); d.setHours(0, 0, 0, 0); return d;
  }
  function iso(d) {
    return new Date(d).toISOString().slice(0, 10);
  }
  function parse(s) {
    var d = new Date(s + 'T00:00:00'); return isNaN(d) ? today() : d;
  }
  function fuzz(days) {
    if (days < 3) return days;
    var f = Math.max(1, Math.round(days * 0.05));
    return days + Math.round((Math.random() * 2 - 1) * f);
  }

  var SRS = {
    DAY: DAY,
    today: today,
    iso: iso,
    parse: parse,

    /** review record for a card, creating a virgin one if needed */
    get: function (id) {
      var r = Store.state.reviews[id];
      if (!r) {
        r = { ease: 2.5, interval: 0, due: iso(today()), reps: 0, lapses: 0, last: null, history: [] };
        Store.state.reviews[id] = r;
      }
      if (!r.history) r.history = [];
      return r;
    },

    isNew: function (id) {
      var r = Store.state.reviews[id];
      return !r || r.reps === 0;
    },

    dueIn: function (id) {
      var r = Store.state.reviews[id];
      if (!r || !r.reps) return 0;
      return Math.round((parse(r.due) - today()) / DAY);
    },

    isDue: function (id) {
      if (Store.state.suspended[id]) return false;
      var r = Store.state.reviews[id];
      if (!r || !r.reps) return true;           // unseen counts as due
      return parse(r.due) <= today();
    },

    isOverdue: function (id) {
      var r = Store.state.reviews[id];
      if (!r || !r.reps) return false;
      return parse(r.due) < today();
    },

    /** retrievability estimate 0..1 — used for "weakest first" ordering */
    strength: function (id) {
      var r = Store.state.reviews[id];
      if (!r || !r.reps) return 0;
      var elapsed = (Date.now() - (r.last || Date.now())) / DAY;
      var s = Math.max(r.interval, 0.5);
      var acc = r.history.length
        ? r.history.filter(function (h) { return h.g >= 3; }).length / r.history.length
        : 0.5;
      var retr = Math.exp(-elapsed / (s * 1.4));
      return Math.max(0, Math.min(1, retr * 0.6 + acc * 0.4));
    },

    /** apply a grade, mutate + persist, return the new record */
    grade: function (id, g) {
      var r = SRS.get(id);
      var t = today();

      if (g === 1) {
        r.lapses += 1;
        r.ease = Math.max(1.3, r.ease - 0.2);
        r.interval = 0;
        r.due = iso(t);                       // same-day relearn
      } else {
        if (r.reps === 0) {
          r.interval = g === 2 ? 1 : g === 3 ? 2 : 4;
        } else if (r.interval === 0) {
          r.interval = g === 2 ? 1 : g === 3 ? 2 : 3;
        } else {
          var mult = g === 2 ? 1.2 : g === 3 ? r.ease : r.ease * 1.35;
          r.interval = Math.max(1, Math.round(r.interval * mult));
        }
        if (g === 2) r.ease = Math.max(1.3, r.ease - 0.15);
        if (g === 4) r.ease = Math.min(3.2, r.ease + 0.1);
        r.interval = Math.min(fuzz(r.interval), 365);
        r.due = iso(new Date(t.getTime() + r.interval * DAY));
      }

      r.reps += 1;
      r.last = Date.now();
      r.history.push({ t: Date.now(), g: g });
      if (r.history.length > 60) r.history = r.history.slice(-60);

      // session log
      var key = iso(t);
      var s = Store.state.sessions[key] || (Store.state.sessions[key] = { count: 0, correct: 0 });
      s.count += 1;
      if (g >= 3) s.correct += 1;

      Store.save();
      return r;
    },

    /** preview interval label for each grade button */
    preview: function (id, g) {
      var r = Store.state.reviews[id];
      var ease = r ? r.ease : 2.5;
      var iv = r ? r.interval : 0;
      var reps = r ? r.reps : 0;
      if (g === 1) return '<10m';
      var n;
      if (reps === 0) n = g === 2 ? 1 : g === 3 ? 2 : 4;
      else if (iv === 0) n = g === 2 ? 1 : g === 3 ? 2 : 3;
      else n = Math.max(1, Math.round(iv * (g === 2 ? 1.2 : g === 3 ? ease : ease * 1.35)));
      n = Math.min(n, 365);
      if (n < 30) return n + 'd';
      if (n < 365) return (n / 30).toFixed(n < 60 ? 1 : 0) + 'mo';
      return '1y';
    },

    streak: function () {
      var n = 0;
      var d = today();
      // today doesn't break the streak if not yet studied
      if (!Store.state.sessions[iso(d)]) d = new Date(d.getTime() - DAY);
      while (Store.state.sessions[iso(d)] && Store.state.sessions[iso(d)].count > 0) {
        n += 1; d = new Date(d.getTime() - DAY);
      }
      return n;
    },

    retention: function (days) {
      days = days || 30;
      var c = 0, k = 0;
      var cutoff = Date.now() - days * DAY;
      Object.keys(Store.state.reviews).forEach(function (id) {
        (Store.state.reviews[id].history || []).forEach(function (h) {
          if (h.t >= cutoff) { k += 1; if (h.g >= 3) c += 1; }
        });
      });
      return k ? Math.round((c / k) * 100) : null;
    },

    forecast: function (ids, days) {
      days = days || 14;
      var out = [];
      var t = today();
      for (var i = 0; i < days; i++) {
        var d = new Date(t.getTime() + i * DAY);
        var key = iso(d);
        var n = 0;
        ids.forEach(function (id) {
          var r = Store.state.reviews[id];
          if (Store.state.suspended[id]) return;
          if (!r || !r.reps) { if (i === 0) n += 1; return; }
          if (r.due === key) n += 1;
          else if (i === 0 && parse(r.due) < t) n += 1;   // overdue lands today
        });
        out.push({ date: key, day: d, count: n });
      }
      return out;
    }
  };

  global.SRS = SRS;
})(window);
