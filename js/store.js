/* store.js — durable local state + user-authored content.
   Everything the student adds (notes, images, card edits, review history)
   lives in localStorage so it survives redeploys of vault-data.js.
   Images are stored as data URLs inside a size budget. */

(function (global) {
  'use strict';

  var KEY = 'engram.hub.v2';
  var BUDGET = 4.2 * 1024 * 1024; // conservative localStorage ceiling

  var DEFAULTS = {
    version: 2,
    theme: 'dark',
    reviews: {},        // cardId -> {ease, interval, due, reps, lapses, last, history:[{t,g}]}
    sessions: {},       // 'YYYY-MM-DD' -> {count, correct}
    userCards: {},      // topicId -> [ {id,q,a,user:true} ]
    userNotes: {},      // topicId -> [ {id,title,body,created} ]
    userAssets: {},     // topicId -> [ {id,name,kind,data,created} ]
    suspended: {},      // cardId -> true
    starred: {},        // cardId -> true
    prefs: { dailyNew: 20, mode: 'recall', sound: false }
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  var state;
  try {
    var raw = localStorage.getItem(KEY);
    state = raw ? Object.assign(clone(DEFAULTS), JSON.parse(raw)) : clone(DEFAULTS);
    // migrate v1
    if (!raw) {
      var old = localStorage.getItem('engramStudyHub');
      if (old) {
        try {
          var o = JSON.parse(old);
          if (o && o.reviews) state.reviews = o.reviews;
        } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    state = clone(DEFAULTS);
  }
  for (var k in DEFAULTS) if (!(k in state)) state[k] = clone(DEFAULTS[k]);
  state.prefs = Object.assign(clone(DEFAULTS.prefs), state.prefs || {});

  var saveTimer = null;
  var listeners = [];

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('[store] quota exceeded', e);
      return false;
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!persist()) {
        // shed the largest assets until it fits
        var all = [];
        Object.keys(state.userAssets).forEach(function (t) {
          (state.userAssets[t] || []).forEach(function (a) { all.push({ t: t, a: a }); });
        });
        all.sort(function (x, y) { return (y.a.data || '').length - (x.a.data || '').length; });
        while (all.length && !persist()) {
          var victim = all.shift();
          state.userAssets[victim.t] = state.userAssets[victim.t].filter(function (a) { return a.id !== victim.a.id; });
        }
        global.Store.emit('quota');
      }
      listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    }, 90);
  }

  function usage() {
    try { return JSON.stringify(state).length; } catch (e) { return 0; }
  }

  function uid(prefix) {
    return (prefix || 'u') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  var events = {};

  global.Store = {
    state: state,
    save: save,
    uid: uid,
    usage: usage,
    budget: BUDGET,
    onChange: function (fn) { listeners.push(fn); },
    on: function (n, fn) { (events[n] = events[n] || []).push(fn); },
    emit: function (n, d) { (events[n] || []).forEach(function (f) { try { f(d); } catch (e) {} }); },

    // ---- user content -------------------------------------------------
    addNote: function (topicId, title, body) {
      var list = state.userNotes[topicId] || (state.userNotes[topicId] = []);
      var n = { id: uid('n'), title: title || 'Untitled note', body: body || '', created: Date.now(), user: true };
      list.unshift(n); save(); return n;
    },
    updateNote: function (topicId, id, patch) {
      var list = state.userNotes[topicId] || [];
      var n = list.find(function (x) { return x.id === id; });
      if (n) { Object.assign(n, patch); save(); }
      return n;
    },
    removeNote: function (topicId, id) {
      state.userNotes[topicId] = (state.userNotes[topicId] || []).filter(function (n) { return n.id !== id; });
      save();
    },

    addAsset: function (topicId, asset) {
      var list = state.userAssets[topicId] || (state.userAssets[topicId] = []);
      var a = Object.assign({ id: uid('a'), created: Date.now(), user: true }, asset);
      list.unshift(a); save(); return a;
    },
    removeAsset: function (topicId, id) {
      state.userAssets[topicId] = (state.userAssets[topicId] || []).filter(function (a) { return a.id !== id; });
      save();
    },

    addCard: function (topicId, q, a) {
      var list = state.userCards[topicId] || (state.userCards[topicId] = []);
      var c = { id: uid('c'), q: q, a: a, user: true, created: Date.now() };
      list.push(c); save(); return c;
    },
    removeCard: function (topicId, id) {
      state.userCards[topicId] = (state.userCards[topicId] || []).filter(function (c) { return c.id !== id; });
      delete state.reviews[id]; save();
    },

    toggleStar: function (id) {
      if (state.starred[id]) delete state.starred[id]; else state.starred[id] = true;
      save(); return !!state.starred[id];
    },
    toggleSuspend: function (id) {
      if (state.suspended[id]) delete state.suspended[id]; else state.suspended[id] = true;
      save(); return !!state.suspended[id];
    },

    // ---- backup -------------------------------------------------------
    exportJSON: function () { return JSON.stringify(state, null, 2); },
    importJSON: function (text) {
      var incoming = JSON.parse(text);
      if (!incoming || typeof incoming !== 'object') throw new Error('bad file');
      ['reviews', 'sessions', 'userCards', 'userNotes', 'userAssets', 'starred', 'suspended'].forEach(function (k) {
        if (incoming[k]) Object.assign(state[k], incoming[k]);
      });
      if (incoming.prefs) Object.assign(state.prefs, incoming.prefs);
      save();
    },
    reset: function () {
      var t = state.theme;
      Object.keys(state).forEach(function (k) { delete state[k]; });
      Object.assign(state, clone(DEFAULTS));
      state.theme = t;
      persist();
    }
  };
})(window);
