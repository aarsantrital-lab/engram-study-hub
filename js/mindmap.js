/* mindmap.js — dependency-free tidy tree in SVG.
   Horizontal layout, collapsible branches, pan + zoom, node click callback.
   Leaves bound to a cardId are tinted by recall strength. */

(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    var n = document.createElementNS(SVGNS, name);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    return n;
  }

  function measure(text, size) {
    // approximation good enough for a label box; avoids reflow-heavy getBBox loops
    return Math.max(34, text.length * size * 0.545 + 20);
  }

  function MindMap(container, opts) {
    this.c = container;
    this.opts = opts || {};
    this.collapsed = {};
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._bind();
  }

  MindMap.prototype._bind = function () {
    var self = this;
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    this.c.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.mm-node')) return;
      dragging = true; sx = e.clientX; sy = e.clientY; ox = self.tx; oy = self.ty;
      self.c.classList.add('drag');
      self.c.setPointerCapture(e.pointerId);
    });
    this.c.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      self.tx = ox + (e.clientX - sx);
      self.ty = oy + (e.clientY - sy);
      self._apply();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      self.c.addEventListener(ev, function (e) {
        dragging = false; self.c.classList.remove('drag');
        try { self.c.releasePointerCapture(e.pointerId); } catch (x) {}
      });
    });
    this.c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = self.c.getBoundingClientRect();
      var mx = e.clientX - rect.left, my = e.clientY - rect.top;
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      var ns = Math.max(0.25, Math.min(3, self.scale * factor));
      var k = ns / self.scale;
      self.tx = mx - k * (mx - self.tx);
      self.ty = my - k * (my - self.ty);
      self.scale = ns;
      self._apply();
    }, { passive: false });
  };

  MindMap.prototype._apply = function () {
    if (this.g) this.g.setAttribute('transform',
      'translate(' + this.tx + ',' + this.ty + ') scale(' + this.scale + ')');
  };

  MindMap.prototype.zoom = function (f) {
    var rect = this.c.getBoundingClientRect();
    var mx = rect.width / 2, my = rect.height / 2;
    var ns = Math.max(0.25, Math.min(3, this.scale * f));
    var k = ns / this.scale;
    this.tx = mx - k * (mx - this.tx);
    this.ty = my - k * (my - this.ty);
    this.scale = ns;
    this._apply();
  };

  MindMap.prototype.expandAll = function () { this.collapsed = {}; this.render(this.data); };
  MindMap.prototype.collapseAll = function () {
    var self = this;
    self.collapsed = {};
    (function walk(n, d) {
      if (d >= 1 && n.children && n.children.length) self.collapsed[n._key] = true;
      (n.children || []).forEach(function (c) { walk(c, d + 1); });
    })(this.data, 0);
    this.render(this.data);
  };

  /** layout: assign x by depth, y by in-order leaf packing */
  MindMap.prototype._layout = function (root) {
    var self = this;
    var GAPY = 34, GAPX = 56, FS = 13;
    var y = 0;
    var nodes = [], links = [];

    (function key(n, path) {
      n._key = path;
      (n.children || []).forEach(function (c, i) { key(c, path + '.' + i); });
    })(root, '0');

    function walk(n, depth) {
      n._depth = depth;
      n._w = measure(n.label, FS);
      n._collapsed = !!self.collapsed[n._key];
      var kids = (!n._collapsed && n.children) ? n.children : [];
      if (!kids.length) {
        n._y = y;
        y += GAPY;
      } else {
        var first = null, last = null;
        kids.forEach(function (c) {
          walk(c, depth + 1);
          if (first === null) first = c._y;
          last = c._y;
          links.push({ a: n, b: c });
        });
        n._y = (first + last) / 2;
      }
      nodes.push(n);
    }
    walk(root, 0);

    // x by cumulative widest-per-depth
    var widest = {};
    nodes.forEach(function (n) { widest[n._depth] = Math.max(widest[n._depth] || 0, n._w); });
    var xoff = {}; var acc = 0;
    Object.keys(widest).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
      xoff[d] = acc; acc += widest[d] + GAPX;
    });
    nodes.forEach(function (n) { n._x = xoff[n._depth]; });

    return { nodes: nodes, links: links, width: acc, height: Math.max(y, GAPY) };
  };

  MindMap.prototype.render = function (data) {
    if (!data) return;
    this.data = data;
    var self = this;
    var H = 26;
    var lay = this._layout(data);

    this.c.innerHTML = '';
    var svg = el('svg', { xmlns: SVGNS });
    var g = el('g');
    this.g = g;
    svg.appendChild(g);
    this.c.appendChild(svg);

    // links
    lay.links.forEach(function (L) {
      var x1 = L.a._x + L.a._w, y1 = L.a._y;
      var x2 = L.b._x, y2 = L.b._y;
      var mx = (x1 + x2) / 2;
      var p = el('path', {
        class: 'mm-link',
        d: 'M' + x1 + ',' + y1 + ' C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2
      });
      p.dataset.to = L.b._key;
      g.appendChild(p);
    });

    // nodes
    lay.nodes.forEach(function (n) {
      var cls = 'mm-node' + (n._depth === 0 ? ' root' : '') +
        (!n.children || !n.children.length ? ' leaf' : '') +
        (n._collapsed ? ' collapsed' : '');
      var grp = el('g', { class: cls, transform: 'translate(' + n._x + ',' + (n._y - H / 2) + ')' });
      grp.appendChild(el('rect', { width: n._w, height: H, rx: 6, ry: 6 }));

      var label = n.label.length > 46 ? n.label.slice(0, 44) + '…' : n.label;
      var t = el('text', { x: 10, y: H / 2 });
      t.textContent = label;
      grp.appendChild(t);

      if (n._collapsed && n.children && n.children.length) {
        var cnt = el('text', { class: 'mm-count', x: n._w + 6, y: H / 2 });
        cnt.textContent = '+' + n.children.length;
        grp.appendChild(cnt);
      }

      // strength tint for card leaves
      if (n.cardId && global.SRS) {
        var s = SRS.strength(n.cardId);
        var col = s > 0.75 ? 'var(--good)' : s > 0.4 ? 'var(--warn)' : s > 0 ? 'var(--bad)' : 'var(--ink-3)';
        grp.appendChild(el('circle', { cx: n._w - 8, cy: H / 2, r: 3.2, fill: col, opacity: 0.9 }));
      }

      grp.addEventListener('click', function (e) {
        e.stopPropagation();
        if (n.children && n.children.length) {
          if (self.collapsed[n._key]) delete self.collapsed[n._key];
          else self.collapsed[n._key] = true;
          var s = self.scale, tx = self.tx, ty = self.ty;
          self.render(self.data);
          self.scale = s; self.tx = tx; self.ty = ty; self._apply();
        } else if (self.opts.onLeaf) {
          self.opts.onLeaf(n);
        }
      });

      grp.addEventListener('mouseenter', function () {
        g.querySelectorAll('.mm-link[data-to="' + n._key + '"]').forEach(function (p) { p.classList.add('hot'); });
      });
      grp.addEventListener('mouseleave', function () {
        g.querySelectorAll('.mm-link.hot').forEach(function (p) { p.classList.remove('hot'); });
      });

      g.appendChild(grp);
    });

    // fit — measure the ACTUAL rendered bounds, not the estimated layout box
    var rect = this.c.getBoundingClientRect();
    var pad = 24;
    var availW = Math.max(rect.width - pad * 2, 100);
    var availH = Math.max(rect.height - pad * 2, 100);

    var bb;
    try { bb = g.getBBox(); } catch (e) { bb = { x: 0, y: 0, width: lay.width, height: lay.height + H }; }
    if (!bb.width || !bb.height) bb = { x: 0, y: 0, width: lay.width, height: lay.height + H };

    var s = Math.min(availW / bb.width, availH / bb.height);
    this.scale = Math.max(0.3, Math.min(s, 2.4));
    // centre the real content box inside the stage
    this.tx = (rect.width - bb.width * this.scale) / 2 - bb.x * this.scale;
    this.ty = (rect.height - bb.height * this.scale) / 2 - bb.y * this.scale;
    this._apply();
  };

  /** Build a mindmap tree from a topic: notes headings + card clusters */
  MindMap.fromTopic = function (topic, cards) {
    if (topic.mindmap && topic.mindmap.children && topic.mindmap.children.length) {
      return JSON.parse(JSON.stringify(topic.mindmap));
    }
    return {
      label: topic.name,
      children: (cards || []).slice(0, 40).map(function (c) {
        return { label: c.q, children: [], cardId: c.id };
      })
    };
  };

  global.MindMap = MindMap;
})(window);
