/* md.js — small, dependency-free markdown renderer.
   Deliberately limited: headings, lists, tables, code, quotes, images,
   links, bold/italic, subscripts already come through as unicode.
   Escapes HTML first, so vault content can't inject script. */

(function (global) {
  'use strict';

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, function (_, c) { return '<code>' + c + '</code>'; })
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  }

  function render(src) {
    if (!src) return '';
    var lines = esc(String(src).replace(/\r\n?/g, '\n')).split('\n');
    var out = [];
    var i = 0;

    function flushList(tag, items) {
      out.push('<' + tag + '>' + items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</' + tag + '>');
    }

    while (i < lines.length) {
      var ln = lines[i];

      // fenced code
      var fence = ln.match(/^```(\w*)\s*$/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + buf.join('\n') + '</code></pre>');
        continue;
      }

      // frontmatter (skip)
      if (i === 0 && /^---\s*$/.test(ln)) {
        i++;
        while (i < lines.length && !/^---\s*$/.test(lines[i])) i++;
        i++;
        continue;
      }

      // heading
      var h = ln.match(/^(#{1,6})\s+(.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }

      // hr
      if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(ln.trim())) { out.push('<hr>'); i++; continue; }

      // table
      if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1])) {
        var head = ln.split('|').map(function (c) { return c.trim(); }).filter(function (c, idx, arr) { return !(c === '' && (idx === 0 || idx === arr.length - 1)); });
        i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          rows.push(lines[i].split('|').map(function (c) { return c.trim(); }).filter(function (c, idx, arr) { return !(c === '' && (idx === 0 || idx === arr.length - 1)); }));
          i++;
        }
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
          '</tbody></table>');
        continue;
      }

      // blockquote
      if (/^>\s?/.test(ln)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + render(q.join('\n')) + '</blockquote>');
        continue;
      }

      // unordered list (with one nesting level)
      if (/^\s*[-*+]\s+/.test(ln)) {
        var items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
          i++;
        }
        flushList('ul', items);
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(ln)) {
        var oitems = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          oitems.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i++;
        }
        flushList('ol', oitems);
        continue;
      }

      // blank
      if (!ln.trim()) { i++; continue; }

      // paragraph
      var para = [];
      while (i < lines.length && lines[i].trim() &&
             !/^(#{1,6}\s|>\s?|\s*[-*+]\s|\s*\d+[.)]\s|```)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<p>' + inline(para.join(' ')) + '</p>');
    }

    return out.join('\n');
  }

  /** plain-text version, for search indexing */
  function strip(src) {
    return String(src || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#>*_`~|\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  global.MD = { render: render, esc: esc, strip: strip, inline: inline };
})(window);
