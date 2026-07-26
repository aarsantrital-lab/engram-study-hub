/* =============================================================================
   js/md.js — Discord-flavoured markdown renderer. Zero dependencies, zero
   innerHTML injection paths. Job A2. LEAF MODULE: imports nothing.

   Ported from the v1 hub parser (build-constraints §8 "salvage js/md.js as-is
   + link-scheme allow-list") and extended for chat:

     # ## ###…      headings (1-6)
     **bold**  *italic*  __underline__  ~~strike~~  ***bold italic***
     ||spoiler||   click / Enter / Space to reveal
     `inline code`  ```fenced blocks```  > quotes  - lists  1. lists
     - [ ] task lists · tables · --- rules · ![img](…) · [link](url)
     bare https:// autolink  ·  vault content keeps unicode sub/sup (H₂O, 10²³)

   SECURITY MODEL (read this before editing)
     1. escapeHtml() runs FIRST on the raw source. After that no `<` or `>`
        from user text can survive, so every later transform is operating on
        inert text and can only ADD our own tags.
     2. URLs go through safeUrl() — an allow-list of https/http/mailto plus
        in-app relative and #hash routes. Everything else is dropped.
     3. renderMarkdownInto() re-parses the result and walks it against an
        element/attribute allow-list before it touches the live DOM. Belt and
        braces: even a regex bug cannot ship a script tag or an onclick.
     4. NOTHING here ever interpolates un-escaped input into an attribute.

   NOTATION (build-constraints §5): this renderer never rewrites numbers, so
   `6.022 × 10²³` passes through exactly as authored. Never emit e-notation.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. Escaping + URL allow-list
   ------------------------------------------------------------------------ */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape every HTML-significant character. Always the first thing we do. */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Strip control characters that would corrupt our placeholder tokens. */
function stripControl(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Schemes we will put in an href. Everything else is rendered as plain text. */
export const ALLOWED_SCHEMES = ['https:', 'http:', 'mailto:'];

/**
 * Validate a URL taken from ALREADY-ESCAPED text.
 * @returns {string|null} the url to use in the attribute, or null to refuse.
 */
export function safeUrl(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw || /[\s<>"'`\\]/.test(raw)) return null;

  // Undo only the entities we ourselves introduced, so scheme sniffing is honest.
  const probe = raw
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .trim();

  // Anything that could break out of an attribute or hide a scheme: refuse.
  if (/[\s<>"'`\\\u0000-\u0020\u007F]/.test(probe)) return null;

  if (/^#/.test(probe)) return raw;                       // in-app hash route
  const scheme = /^([a-z][a-z0-9+.\-]*):/i.exec(probe);
  if (scheme) return ALLOWED_SCHEMES.includes(scheme[1].toLowerCase() + ':') ? raw : null;
  if (/^\/\//.test(probe)) return null;                   // protocol-relative: refuse
  return raw;                                             // relative path
}

/** Images additionally refuse mailto and anything non-http(s)/relative. */
function safeImageUrl(url) {
  const u = safeUrl(url);
  if (!u) return null;
  return /^mailto:/i.test(u.trim()) ? null : u;
}

/* ---------------------------------------------------------------------------
   2. Placeholder tokens — protect code / links / images from later regexes
   ------------------------------------------------------------------------ */

const TOK_OPEN = '\u0001', TOK_CLOSE = '\u0002';
const tokenRe = /\u0001(\d+)\u0002/g;

function makeTokens() {
  const slots = [];
  return {
    put(html) { slots.push(html); return TOK_OPEN + (slots.length - 1) + TOK_CLOSE; },
    restore(s) { return s.replace(tokenRe, (_, i) => slots[Number(i)] ?? ''); },
  };
}

/* ---------------------------------------------------------------------------
   3. Inline rendering
   ------------------------------------------------------------------------ */

/** Emphasis-only pass. Input MUST already be escaped + tokenised. */
function emphasis(s) {
  return s
    // ||spoiler|| — Discord. Revealed by the delegated handler at the bottom.
    .replace(/\|\|([\s\S]+?)\|\|/g,
      '<span class="md-spoiler" data-spoiler role="button" tabindex="0" ' +
      'aria-label="Spoiler, activate to reveal">$1</span>')
    // ***bold italic***
    .replace(/\*\*\*(?!\s)([\s\S]+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    // **bold**
    .replace(/\*\*(?!\s)([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    // __underline__ (Discord) — must run before single-underscore italics
    .replace(/__(?!_)([\s\S]+?)__/g, '<u>$1</u>')
    // ~~strike~~
    .replace(/~~(?!\s)([\s\S]+?)~~/g, '<del>$1</del>')
    // ==highlight== (kept from v1 — vault notes use it)
    .replace(/==(?!\s)([^=\n]+?)==/g, '<mark>$1</mark>')
    // *italic*
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    // _italic_
    .replace(/(^|[^\w_])_(?!_)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
}

/**
 * Render inline markdown for a single run of text.
 * @param {string} text raw (unescaped) markdown
 * @returns {string} sanitised HTML
 */
export function renderInline(text) {
  if (text == null || text === '') return '';
  return inlineFrom(escapeHtml(stripControl(text)));
}

/** Inline pipeline over text that is ALREADY escaped. */
function inlineFrom(escaped) {
  const t = makeTokens();
  let s = escaped;

  // 3a. inline code — protected from every later transform
  s = s.replace(/(`{1,3})([^`]+?)\1/g, (_, _ticks, code) =>
    t.put('<code class="md-code-inline">' + code + '</code>'));

  // 3b. images  ![alt](url "title")
  s = s.replace(/!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\s*\)/g, (m, alt, url) => {
    const safe = safeImageUrl(url);
    if (!safe) return t.put(alt || '');
    return t.put('<img class="md-img" src="' + safe + '" alt="' + alt +
      '" loading="lazy" decoding="async">');
  });

  // 3c. links  [text](url) — link text keeps its own emphasis
  s = s.replace(/\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\s*\)/g, (m, label, url) => {
    const safe = safeUrl(url);
    const inner = emphasis(label || safe || '');
    if (!safe) return t.put(inner);
    const external = /^https?:/i.test(safe);
    return t.put('<a class="md-link" href="' + safe + '"' +
      (external ? ' target="_blank" rel="noopener noreferrer nofollow"' : '') +
      '>' + inner + '</a>');
  });

  // 3d. bare-URL autolink — https only (job spec), http left as plain text
  s = s.replace(/(^|[\s(])(https:\/\/[^\s<]+)/g, (m, lead, url) => {
    let clean = url, trail = '';
    const trailRe = /(&quot;|&#39;|&gt;|&lt;|[.,;:!?)\]])$/;
    while (trailRe.test(clean)) {
      const hit = trailRe.exec(clean)[0];
      // keep a ')' that closes a '(' inside the url
      if (hit === ')' && (clean.split('(').length > clean.split(')').length)) break;
      trail = hit + trail;
      clean = clean.slice(0, -hit.length);
    }
    const safe = safeUrl(clean);
    if (!safe) return m;
    return lead + t.put('<a class="md-link" href="' + safe +
      '" target="_blank" rel="noopener noreferrer nofollow">' + clean + '</a>') + trail;
  });

  // 3e. emphasis, then put the protected pieces back
  return t.restore(emphasis(s));
}

/* ---------------------------------------------------------------------------
   4. Block rendering
   ------------------------------------------------------------------------ */

const indentOf = (line) => (line.match(/^[ \t]*/)[0] || '').replace(/\t/g, '  ').length;
const LIST_RE = /^([ \t]*)([-*+]|\d+[.)])[ \t]+(.*)$/;

/**
 * Render a full markdown document.
 * @param {string} src raw markdown
 * @returns {string} sanitised HTML
 */
export function renderMarkdown(src) {
  if (src == null || src === '') return '';
  const lines = escapeHtml(stripControl(String(src).replace(/\r\n?/g, '\n'))).split('\n');
  return renderBlocks(lines, 0, lines.length);
}

function renderBlocks(lines, start, end) {
  const out = [];
  let i = start;

  while (i < end) {
    const ln = lines[i];

    /* --- YAML frontmatter (only at the very top) --- */
    if (i === start && /^---\s*$/.test(ln)) {
      let j = i + 1;
      while (j < end && !/^---\s*$/.test(lines[j])) j += 1;
      if (j < end) { i = j + 1; continue; }
    }

    /* --- fenced code --- */
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(ln);
    if (fence) {
      const closer = fence[1][0];
      const lang = fence[2] || '';
      const buf = [];
      i += 1;
      while (i < end && !new RegExp('^\\s*' + closer + '{3,}\\s*$').test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push('<pre class="md-code"' + (lang ? ' data-lang="' + lang.replace(/[^\w+-]/g, '') + '"' : '') +
        '><code>' + buf.join('\n') + '</code></pre>');
      continue;
    }

    /* --- heading --- */
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln);
    if (h) {
      const lvl = h[1].length;
      out.push('<h' + lvl + ' class="md-h md-h' + lvl + '">' + inlineFrom(h[2]) + '</h' + lvl + '>');
      i += 1; continue;
    }

    /* --- horizontal rule --- */
    if (/^\s*(?:\*\s*){3,}$|^\s*(?:-\s*){3,}$|^\s*(?:_\s*){3,}$/.test(ln)) {
      out.push('<hr class="md-hr">'); i += 1; continue;
    }

    /* --- table --- */
    if (ln.includes('|') && i + 1 < end && /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(ln);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const rows = [];
      while (i < end && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1; }
      const th = head.map((c, k) => '<th' + alignAttr(aligns[k]) + '>' + inlineFrom(c) + '</th>').join('');
      const tb = rows.map((r) =>
        '<tr>' + r.map((c, k) => '<td' + alignAttr(aligns[k]) + '>' + inlineFrom(c) + '</td>').join('') + '</tr>'
      ).join('');
      out.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>' + th +
        '</tr></thead><tbody>' + tb + '</tbody></table></div>');
      continue;
    }

    /* --- blockquote (recursive) --- */
    if (/^\s*&gt;\s?/.test(ln)) {
      const q = [];
      while (i < end && (/^\s*&gt;\s?/.test(lines[i]) || (q.length && lines[i].trim() && !/^\s*$/.test(lines[i])))) {
        if (!/^\s*&gt;\s?/.test(lines[i])) break;
        q.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      out.push('<blockquote class="md-quote">' + renderBlocks(q, 0, q.length) + '</blockquote>');
      continue;
    }

    /* --- lists (nested by indentation) --- */
    if (LIST_RE.test(ln)) {
      const res = readList(lines, i, end, indentOf(ln));
      out.push(res.html); i = res.i; continue;
    }

    /* --- blank --- */
    if (!ln.trim()) { i += 1; continue; }

    /* --- paragraph --- */
    const para = [];
    while (i < end && lines[i].trim() &&
           !LIST_RE.test(lines[i]) &&
           !/^(#{1,6}\s|\s*&gt;\s?|\s*(`{3,}|~{3,}))/.test(lines[i]) &&
           !/^\s*(?:-\s*){3,}$/.test(lines[i])) {
      para.push(lines[i]); i += 1;
    }
    if (para.length) out.push('<p class="md-p">' + inlineFrom(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    else i += 1;
  }

  return out.join('\n');
}

function alignAttr(a) { return a ? ' style="text-align:' + a + '"' : ''; }

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function readList(lines, i, end, baseIndent) {
  const items = [];
  let ordered = null;
  let startNum = 1;

  while (i < end) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) break;
    const ind = indentOf(lines[i]);
    if (ind < baseIndent) break;
    if (ind > baseIndent) break;                     // handled as a child below
    const isOrdered = /\d/.test(m[2]);
    if (ordered === null) { ordered = isOrdered; if (isOrdered) startNum = parseInt(m[2], 10) || 1; }
    else if (ordered !== isOrdered) break;

    let content = m[3];
    i += 1;
    const children = [];

    while (i < end) {
      if (!lines[i].trim()) {                        // blank line: peek ahead
        let j = i + 1;
        if (j < end && LIST_RE.test(lines[j]) && indentOf(lines[j]) >= baseIndent) { i += 1; continue; }
        break;
      }
      const cm = LIST_RE.exec(lines[i]);
      if (cm) {
        const cind = indentOf(lines[i]);
        if (cind > baseIndent) { const r = readList(lines, i, end, cind); children.push(r.html); i = r.i; continue; }
        break;
      }
      if (indentOf(lines[i]) > baseIndent) { content += '\n' + lines[i].trim(); i += 1; continue; }
      break;
    }

    // task list  - [ ] / - [x]
    let checkbox = '';
    const task = /^\[([ xX])\]\s+([\s\S]*)$/.exec(content);
    if (task) {
      checkbox = '<input type="checkbox" class="md-task" disabled' +
        (task[1].toLowerCase() === 'x' ? ' checked' : '') + '> ';
      content = task[2];
    }
    items.push('<li class="md-li' + (task ? ' md-li-task' : '') + '">' + checkbox +
      inlineFrom(content).replace(/\n/g, '<br>') + children.join('') + '</li>');
  }

  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && startNum !== 1 ? ' start="' + startNum + '"' : '';
  return { html: '<' + tag + ' class="md-list"' + startAttr + '>' + items.join('') + '</' + tag + '>', i };
}

/* ---------------------------------------------------------------------------
   5. Plain-text extraction (search indexing)
   ------------------------------------------------------------------------ */

/** Markdown -> plain text, for the search index and previews. */
export function stripMarkdown(src) {
  return String(src == null ? '' : src)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\|\|/g, '')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/^\s*[-+]\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First `n` characters of the plain text, ending on a word boundary. */
export function excerpt(src, n) {
  const s = stripMarkdown(src);
  const max = n || 160;
  if (s.length <= max) return s;
  return s.slice(0, s.lastIndexOf(' ', max) > max * 0.6 ? s.lastIndexOf(' ', max) : max).trim() + '…';
}

/* ---------------------------------------------------------------------------
   6. Final DOM-level sanitiser + mounting
   ------------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
  'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'INPUT', 'LI', 'MARK', 'OL', 'P', 'PRE', 'SPAN',
  'STRONG', 'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);
const ALLOWED_ATTRS = new Set([
  'class', 'href', 'src', 'alt', 'title', 'target', 'rel', 'loading', 'decoding',
  'start', 'type', 'checked', 'disabled', 'colspan', 'rowspan', 'style',
  'role', 'tabindex', 'aria-label', 'data-spoiler', 'data-lang',
]);
const SAFE_STYLE = /^text-align:\s*(left|right|center)\s*;?$/i;

/**
 * Parse renderer output and strip anything outside the allow-list.
 * @returns {DocumentFragment}
 */
export function sanitizeToFragment(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  scrub(tpl.content);
  return tpl.content;
}

function scrub(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const doomed = [];
  while (walker.nextNode()) {
    const node = /** @type {Element} */ (walker.currentNode);
    if (!ALLOWED_TAGS.has(node.tagName)) { doomed.push(node); continue; }
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      if (!ALLOWED_ATTRS.has(name) || name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
      if (name === 'style' && !SAFE_STYLE.test(attr.value)) { node.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src') && !safeUrl(attr.value)) { node.removeAttribute(attr.name); }
    }
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    if (node.tagName === 'INPUT') {
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }
  }
  // unwrap disallowed elements, keeping their text
  for (const node of doomed) {
    const text = document.createTextNode(node.textContent || '');
    node.replaceWith(text);
  }
}

/**
 * THE RECOMMENDED WAY to put markdown on screen. Replaces the node's children
 * with sanitised nodes (never assigns raw user text to innerHTML).
 * @param {Element} node
 * @param {string} text raw markdown
 */
export function renderMarkdownInto(node, text) {
  if (!node) return node;
  node.replaceChildren(sanitizeToFragment(renderMarkdown(text)));
  installSpoilerHandler();
  return node;
}

/** Same, for a single inline run (chat message body, card front/back). */
export function renderInlineInto(node, text) {
  if (!node) return node;
  node.replaceChildren(sanitizeToFragment(renderInline(text)));
  installSpoilerHandler();
  return node;
}

/* ---------------------------------------------------------------------------
   7. Spoilers — one delegated listener for the whole document
   ------------------------------------------------------------------------ */

let spoilersWired = false;

/** Idempotent. Called automatically by renderMarkdownInto / renderInlineInto. */
export function installSpoilerHandler() {
  if (spoilersWired || typeof document === 'undefined') return;
  spoilersWired = true;

  const reveal = (elm) => {
    elm.classList.add('is-revealed');
    elm.setAttribute('aria-label', 'Spoiler revealed');
    elm.removeAttribute('role');
    elm.removeAttribute('tabindex');
  };

  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-spoiler]:not(.is-revealed)') : null;
    if (t) { e.preventDefault(); e.stopPropagation(); reveal(t); }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target instanceof Element ? e.target.closest('[data-spoiler]:not(.is-revealed)') : null;
    if (t) { e.preventDefault(); reveal(t); }
  });
}

export default {
  renderMarkdown, renderInline, renderMarkdownInto, renderInlineInto,
  escapeHtml, safeUrl, stripMarkdown, excerpt, sanitizeToFragment, installSpoilerHandler,
};
