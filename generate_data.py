#!/usr/bin/env python3
"""
Engram Study Hub — vault -> hub data generator (v2, hardened).

Reads the Obsidian vault and emits `vault-data.json` + `vault-data.js` for the
hub, copies lesson/reference HTML and media into `assets/`, and copies authored
data packs (numericals / questions / formulas / diagrams) into `data/`.

CONTRACTS THIS FILE KEEPS (build-constraints.md §1-2, §8, §9):
  * Vault layout: Teaching/<Topic-Hyphenated>/{MISSION.md, mindmap.md,
    flashcards/*.md, lessons/*.html, reference/|cheatsheets/*.html,
    attachments/|images/|assets/|diagrams/|flowcharts/, *.md notes}.
    Topic id = slugified directory name. Only `flashcards/` is scanned for cards.
  * All FIVE flashcard syntaxes keep parsing:
        "## Q:" / "A:"      **Q:** / **A:**      Q: / A:
        question :: answer  question ?? answer
  * Card identity: an explicit `id:` metadata comment wins; otherwise the legacy
    sha1("<flashcard-file-stem>|<question>")[:12]. Never invent a third scheme
    without shipping a migration map (see ../MIGRATION.md).
  * Schema stays 2 and grows ADDITIVELY only:
        card  += {type, pacer, cognitive, misconceptions[], lesson}
        topic += {subject, unit, lessonsMeta[{n,slug,title,url}]}
  * Warnings never crash the run; they are collected, printed, AND shipped in
    `vault-data.warnings[]` so the app can show them to the student (§9.7).
  * Subject and unit are DECLARED in MISSION.md frontmatter. Never keyword
    sniffed — that bug filed Nepali literature under English (§9.4).

HARDENING (all of build-constraints §2 "required hardening" + §9.7-9.8):
  * --vault/--hub arguments and ENGRAM_VAULT/ENGRAM_HUB env (runs on Windows).
  * Atomic writes: `.tmp` + os.replace, so a killed run never leaves a half
    written vault-data.js that would blank the hub.
  * `</script>`, `<!--`, U+2028/U+2029 escaped in the .js payload.
  * Orphan pruning through a written manifest: only files THIS generator wrote
    are ever deleted. Shell assets (icons.svg, icons/) are hard-reserved.
  * Flattened asset paths are namespaced by their sub-folder, so
    images/fig1.png and attachments/fig1.png cannot overwrite each other.
  * Refuses to overwrite a populated vault-data.js with an empty one unless
    --allow-empty is passed (a mistyped --vault must not wipe the hub).
  * Exit codes: 0 ok · 2 too many warnings (--max-warnings) · 1 hard failure.

Run `python generate_data.py --self-test` for the built-in parser tests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import traceback
from datetime import datetime
from pathlib import Path

# Windows consoles default to cp1252, which cannot encode "✓", "·" or "×".
# Without this, a warning containing a non-ASCII character kills the run with a
# UnicodeEncodeError — the generator must never die printing its own output.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

# --------------------------------------------------------------------------
# 0. Configuration
# --------------------------------------------------------------------------

DEFAULT_VAULT = Path("/opt/data/obsidian-vault")
DEFAULT_HUB = Path("/opt/data/study-hub")

SCHEMA = 2
GENERATOR_VERSION = "2.0.0"

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
DOC_EXT = {".pdf"}
MAX_ASSET_BYTES = 12 * 1024 * 1024
MAX_NOTE_CHARS = 60000
DEFAULT_MAX_WARNINGS = 20

ASSET_DIRS = ("attachments", "images", "assets", "diagrams", "flowcharts")
MINDMAP_NAMES = ("mindmap.md", "MINDMAP.md", "map.md", "Mindmap.md")
DATA_PACKS = ("numericals", "questions", "formulas", "diagrams")

# Files under assets/ that belong to the shell, not to the pipeline.
RESERVED_ASSETS = {"icons.svg", "icons", ".engram-manifest.json"}
MANIFEST_NAME = ".engram-manifest.json"

# Declared-subject -> badge token (a MAPPING of a declared value, not sniffing).
SUBJECT_BADGES = {
    "chemistry": "chemistry",
    "physics": "physics",
    "mathematics": "math", "maths": "math", "math": "math",
    "computer science": "cs", "computer-science": "cs", "cs": "cs",
    "english": "english",
    "nepali": "nepali",
    "biology": "biology",
    "general": "general",
}

# Card vocabularies. Unknown values are kept but flagged, never silently fixed.
CARD_TYPES = {
    "definition", "explain", "relational", "numerical", "freerecall",
    "transfer", "cloze", "spot-the-error", "diagram", "application",
}
COGNITIVE_LEVELS = {"knowledge", "understanding", "application", "higher"}
PACER_CODES = {"P", "A", "C", "E", "R"}
META_KEYS = {"id", "type", "pacer", "cognitive", "misconceptions", "lesson", "difficulty"}

# Mutable run state (set by main()).
VAULT = DEFAULT_VAULT
HUB = DEFAULT_HUB
ASSETS = DEFAULT_HUB / "assets"
QUIET = False
DRY = False
WARNINGS: list = []
WARN_DETAIL: list = []


def warn(msg, code="general"):
    """Collect a student-readable warning. NEVER raises, never stops the run."""
    text = str(msg).strip()
    WARNINGS.append(text)
    WARN_DETAIL.append({"code": code, "message": text})
    if not QUIET:
        print("  ! " + text, file=sys.stderr)


def info(msg):
    if not QUIET:
        print(msg)


# --------------------------------------------------------------------------
# 1. Small helpers
# --------------------------------------------------------------------------

def slug(s):
    s = re.sub(r"[^\w\s-]", "", str(s), flags=re.UNICODE).strip().lower()
    return re.sub(r"[\s_]+", "-", s) or "untitled"


def safe_filename(name):
    """Filesystem/URL-safe asset filename. Deterministic: same input, same output."""
    stem, dot, ext = str(name).rpartition(".")
    if not dot:
        stem, ext = str(name), ""
    stem = re.sub(r"[^\w.-]+", "-", stem, flags=re.ASCII).strip("-._") or "file"
    ext = re.sub(r"[^\w]+", "", ext, flags=re.ASCII).lower()
    return stem + ("." + ext if ext else "")


def read_text(p):
    """Encoding cascade — a single odd file must never take the run down."""
    for enc in ("utf-8", "utf-8-sig", "utf-16", "latin-1"):
        try:
            return p.read_text(encoding=enc)
        except (UnicodeDecodeError, UnicodeError, OSError):
            continue
    warn("could not read %s — check its encoding" % _rel(p), "unreadable")
    return ""


def _rel(p):
    try:
        return str(Path(p).relative_to(VAULT)).replace("\\", "/")
    except (ValueError, TypeError):
        return str(p).replace("\\", "/")


def is_private_name(name):
    """A leading '_' or '.' marks a vault path PRIVATE — it never reaches the hub.

    This is a privacy boundary, not a tidiness rule. The hub is published to the
    open web, so anything the teaching side keeps about the student rather than
    about the subject (`Teaching/_profile/student-profile.md`, `sessions.jsonl`,
    scratch notes) must be unpublishable by construction, not by remembering.
    """
    n = str(name)
    return n.startswith("_") or n.startswith(".")


def is_empty_scaffold(topic_dir):
    """True when a topic folder holds no publishable file at all.

    Empty `flashcards/`, `lessons/`, `reference/` folders with nothing in them
    are a DEFERRED topic — a shape reserved for content that is not written
    yet. That is a decision, not a fault, so the caller reports it with info()
    instead of a stack of warnings. Private ('_'/'.') files do not count as
    content: a folder holding only private files is still empty to the hub.
    """
    try:
        for p in topic_dir.rglob("*"):
            if p.is_file() and not is_private_path(p, topic_dir) and not is_private_name(p.name):
                return False
    except OSError:
        return False
    return True


def is_private_path(p, root):
    """True if `p` or any folder between `root` and `p` is private."""
    try:
        parts = Path(p).relative_to(root).parts
    except (ValueError, TypeError):
        parts = Path(p).parts
    return any(is_private_name(part) for part in parts)


def _clean(s):
    s = str(s).strip()
    s = re.sub(r"^\*\*(.+)\*\*$", r"\1", s)
    return s.strip()


ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def local_day_from_mtime(ts):
    """LOCAL Y-M-D. Never toISOString/UTC — Nepal is UTC+05:45 (§9.1)."""
    d = datetime.fromtimestamp(ts)
    return "%04d-%02d-%02d" % (d.year, d.month, d.day)


# --------------------------------------------------------------------------
# 2. Frontmatter + HTML-comment handling
# --------------------------------------------------------------------------

FRONTMATTER_RE = re.compile(r"\A﻿?---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)
COMMENT_RE = re.compile(r"<!--(.*?)-->", re.S)


def parse_frontmatter(text):
    """`--- key: value --- ` block at the top of a markdown file -> (dict, body).

    Deliberately a flat key:value reader, not YAML: no dependency, no surprises,
    and the only keys the pipeline honours are scalars.
    """
    m = FRONTMATTER_RE.match(text or "")
    if not m:
        return {}, (text or "")
    fm = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        k = k.strip().lower().replace("-", "_")
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        if k:
            fm[k] = v.strip()
    return fm, text[m.end():]


def parse_meta_comment(inner):
    """`id: x | type: y | pacer: C` -> dict, or None when it is prose."""
    parts = [p for p in re.split(r"[|·]", inner or "") if p.strip()]
    out = {}
    for part in parts:
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        k = k.strip().lower()
        if k in META_KEYS:
            out[k] = v.strip()
    return out or None


def mask_comments(text):
    """Strip HTML comments, preserving line numbers, and harvest metadata.

    The vault deliberately parks retired cards inside a big `<!-- ... -->`
    block. The v1 parser was not comment aware, so a stray `## Q:` in there
    shipped as a real card. This makes the parser comment aware for every
    reader (cards, mindmap, notes) and returns {line_no: meta} for the
    single-line metadata comments that sit between a question and its answer.
    """
    metas = {}
    out = []
    pos = 0
    src = text or ""
    for m in COMMENT_RE.finditer(src):
        out.append(src[pos:m.start()])
        whole = m.group(0)
        if "\n" not in whole:
            meta = parse_meta_comment(m.group(1))
            if meta:
                metas[src.count("\n", 0, m.start())] = meta
        out.append("\n" * whole.count("\n"))
        pos = m.end()
    out.append(src[pos:])
    joined = "".join(out)
    cut = joined.find("<!--")
    if cut >= 0:
        # FAIL CLOSED. An unmatched '<!--' means the author opened a comment and
        # never closed it — the commonest way that happens is deleting the '-->'
        # off the end of the Retired block. Deleting only the marker would
        # UN-comment everything after it and ship retired cards as live ones,
        # which is the exact v1 defect this function exists to kill. So the
        # region from the opener to EOF is dropped, and the line count is
        # preserved so every reported line number still points at the right row.
        dropped = joined.count("\n", cut)
        warn("an HTML comment is never closed (missing '-->') — everything after it was "
             "DROPPED, not shipped (%d lines). Close it with '-->' to get them back."
             % dropped, "unclosed-comment")
        joined = joined[:cut] + "\n" * dropped
    return joined.splitlines(), metas


def strip_comments(text):
    """Comment-free text for note bodies (md.js escapes HTML, so raw comments
    would otherwise render as visible junk)."""
    lines, _ = mask_comments(text)
    return "\n".join(lines)


# --------------------------------------------------------------------------
# 3. Flashcards — five syntaxes + metadata comments
# --------------------------------------------------------------------------

# The bold marker may close before OR after the colon: "**Q:** x" and "**Q**: x"
# both occur in the vault, and both must land on the same card.
_BOLD = r"(?:\*\*|__)?"
QA_RE = re.compile(r"^(?:#{1,6}\s*)?%sQ(?:uestion)?%s\s*[:.)]%s\s*(.+)$" % (_BOLD, _BOLD, _BOLD), re.I)
ANS_RE = re.compile(r"^(?:#{1,6}\s*)?%sA(?:nswer)?%s\s*[:.)]%s\s*(.*)$" % (_BOLD, _BOLD, _BOLD), re.I)
INLINE_RE = re.compile(r"^(?!#)(?:[-*+]\s+)?(.{3,}?)\s(?:::|\?\?)\s(.{1,})$")


def legacy_card_id(source, question):
    """The v1 identity: sha1("<file-stem>|<question>")[:12]. Kept EXACT — it is
    what every pre-migration review schedule is keyed by."""
    return hashlib.sha1(("%s|%s" % (source, question)).encode("utf-8")).hexdigest()[:12]


def _split_misconceptions(raw):
    if not raw:
        return []
    txt = str(raw).strip()
    if txt.lower() in ("none", "-", "n/a", "na"):
        return []
    return [t.strip() for t in re.split(r"[,;/\s]+", txt) if t.strip()]


def parse_flashcards(text, source="", topic_id="", strict=True):
    """All five syntaxes, plus `<!-- id: … | type: … -->` metadata comments.

    Returns cards in FILE ORDER with the additive card fields filled in.
    """
    lines, metas = mask_comments(text)
    cards = []
    seen_q = set()
    consumed = set()

    def meta_for(start, end):
        for k in range(start, end):
            if k in metas:
                return metas[k]
        return None

    def push(q, a, line_no, meta):
        q, a = _clean(q), _clean(a)
        if not q or not a:
            return
        key = q.lower()
        if key in seen_q:
            if strict:
                warn("%s: two cards ask the same question — the second was dropped: %s"
                     % (source or "flashcards", q[:70]), "duplicate-question")
            return
        seen_q.add(key)
        meta = meta or {}
        declared = (meta.get("id") or "").strip()
        if declared and not re.match(r"^[\w.:-]+$", declared):
            warn("%s: card id '%s' has characters that break routing — use letters, "
                 "digits, dots and hyphens" % (source or "flashcards", declared), "bad-id")
            declared = ""
        card = {
            "id": declared or legacy_card_id(source, q),
            "q": q,
            "a": a,
            "source": source,
            "type": (meta.get("type") or "").strip().lower(),
            "pacer": (meta.get("pacer") or "").strip().upper(),
            "cognitive": (meta.get("cognitive") or "").strip().lower(),
            "misconceptions": _split_misconceptions(meta.get("misconceptions")),
            "lesson": (meta.get("lesson") or "").strip(),
        }
        card["_line"] = line_no
        card["_declared"] = bool(declared)
        cards.append(card)

    # --- block syntaxes 1-3 (## Q: / **Q:** / Q:) --------------------------
    i = 0
    while i < len(lines):
        qm = QA_RE.match(lines[i].strip())
        if not qm:
            i += 1
            continue
        q = qm.group(1)
        a_parts = []
        j = i + 1
        started = False
        while j < len(lines):
            ln = lines[j]
            stripped = ln.strip()
            if started and QA_RE.match(stripped):
                break
            am = ANS_RE.match(stripped)
            if am and not started:
                started = True
                if am.group(1).strip():
                    a_parts.append(am.group(1).strip())
            elif started:
                # `---`, the next question, or an inline `::`/`??` card all end
                # the answer. Without the inline check a multi-line answer eats
                # every inline card that follows it in the file.
                if stripped.startswith("---") or INLINE_RE.match(stripped):
                    break
                a_parts.append(ln.rstrip())
            j += 1
        if started:
            push(q, "\n".join(a_parts).strip(), i, meta_for(i, j))
            for k in range(i, j):
                consumed.add(k)
            i = j
        else:
            i += 1

    # --- inline syntaxes 4-5 (:: and ??) on lines no block card claimed ----
    for n, raw in enumerate(lines):
        if n in consumed:
            continue
        m = INLINE_RE.match(raw.strip())
        if m:
            push(m.group(1), m.group(2), n, metas.get(n) or metas.get(n + 1))

    cards.sort(key=lambda c: c["_line"])

    if strict:
        undeclared = [c for c in cards if not c["_declared"]]
        if undeclared:
            warn("%s: %d card(s) have no `<!-- id: … -->` comment, so they fall back to the "
                 "legacy text hash — rewording one of those questions erases its review history"
                 % (source or "flashcards", len(undeclared)), "legacy-id")
        for c in cards:
            if c["type"] and c["type"] not in CARD_TYPES:
                warn("%s: card %s has an unknown type '%s'" % (source, c["id"], c["type"]),
                     "unknown-type")
            if c["cognitive"] and c["cognitive"] not in COGNITIVE_LEVELS:
                warn("%s: card %s has an unknown cognitive level '%s' — use knowledge, "
                     "understanding, application or higher" % (source, c["id"], c["cognitive"]),
                     "unknown-cognitive")
            if c["pacer"] and c["pacer"] not in PACER_CODES:
                warn("%s: card %s has an unknown PACER code '%s'" % (source, c["id"], c["pacer"]),
                     "unknown-pacer")
            if c["type"] == "definition" and c["pacer"] and c["pacer"] != "R":
                warn("%s: card %s is a cued definition but is not PACER R — cued definitions are "
                     "only allowed for genuinely arbitrary facts" % (source, c["id"]),
                     "definition-not-r")

    for c in cards:
        c.pop("_line", None)
        c.pop("_declared", None)
    return cards


# --------------------------------------------------------------------------
# 4. Mindmap
# --------------------------------------------------------------------------

NODE_META_KEYS = {"card", "cardid", "lesson", "testable", "unit"}


def _node_from_label(raw_label):
    """`Label | card:xyz | lesson:0001 | testable:hi` -> node with its metadata."""
    parts = [p for p in str(raw_label).split("|")]
    label = re.sub(r"[*_`]", "", parts[0]).strip()
    node = {"label": label, "children": []}
    for part in parts[1:]:
        if ":" not in part:
            continue
        k, v = part.split(":", 1)
        k = k.strip().lower()
        v = v.strip()
        if not v or k not in NODE_META_KEYS:
            continue
        if k in ("card", "cardid"):
            node["cardId"] = v
        else:
            node[k] = v
    return node


def parse_mindmap(md_text):
    """Indented bullet list -> nested nodes (2-space indent = one level).

    Comment aware: the vault's mindmap files document their own syntax inside
    `<!-- -->` blocks, and those example bullets must never become nodes.
    """
    lines, _ = mask_comments(md_text)
    root = {"label": None, "children": []}
    stack = [(-1, root)]
    for raw in lines:
        m = re.match(r"^(\s*)[-*+]\s+(.+?)\s*$", raw)
        if not m:
            continue
        indent = len(m.group(1).expandtabs(2))
        node = _node_from_label(m.group(2))
        if not node["label"]:
            continue
        while stack and stack[-1][0] >= indent:
            stack.pop()
        parent = stack[-1][1] if stack else root
        parent["children"].append(node)
        stack.append((indent, node))
    if len(root["children"]) == 1:
        return root["children"][0]
    if root["children"]:
        return {"label": "Overview", "children": root["children"]}
    return None


STOP = set("""a an the is are was were do does did of in on to for from with and or
what how why when where which who whom whose define state calculate list explain
name give find you your it its this that these those many much can could should""".split())


def _topic_phrase(q):
    s = re.sub(r"[^\w\s₀-₉⁰-⁹]", " ", q.lower())
    words = [w for w in s.split() if w not in STOP and len(w) > 1]
    if not words:
        return None
    return " ".join(words[:2]) if len(words) >= 2 else words[0]


def auto_mindmap(name, cards):
    """Fallback map: cluster cards by shared keywords.

    The `freq[best] < 2` guard is load-bearing — it fixed a documented
    regression where every card became its own branch (build-constraints §8).
    """
    if not cards:
        return None

    freq = {}
    per_card = []
    for c in cards:
        s = re.sub(r"[^\w\s₀-₉⁰-⁹]", " ", c["q"].lower())
        kws = [w for w in s.split() if w not in STOP and len(w) > 2]
        per_card.append(kws)
        for w in set(kws):
            freq[w] = freq.get(w, 0) + 1

    buckets = {}
    for c, kws in zip(cards, per_card):
        best = max(kws, key=lambda w: (freq[w], len(w)), default=None)
        if best is None or freq[best] < 2:          # <- the >=2-card rule
            label = (_topic_phrase(c["q"]) or c["q"][:26]).title()
        else:
            label = best.title()
        buckets.setdefault(label, []).append(c)

    singles = [k for k, v in buckets.items() if len(v) == 1]
    if len(singles) > 4:
        misc = []
        for k in singles:
            misc += buckets.pop(k)
        buckets["Other"] = misc

    ordered = sorted(buckets.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    children = []
    for head, cs in ordered[:14]:
        children.append({
            "label": head,
            "children": [
                {"label": (c["q"][:58] + "…") if len(c["q"]) > 58 else c["q"],
                 "children": [], "cardId": c["id"]}
                for c in cs[:10]
            ],
        })
    return {"label": name, "children": children, "auto": True}


def walk_mindmap(node):
    if not node:
        return
    yield node
    for child in node.get("children") or []:
        for n in walk_mindmap(child):
            yield n


# --------------------------------------------------------------------------
# 5. Assets, docs, notes  (every write is recorded for orphan pruning)
# --------------------------------------------------------------------------

def _record(emitted, dest):
    emitted.add(str(Path(dest).relative_to(HUB)).replace("\\", "/"))


def _copy_if_newer(src, dest, emitted):
    if DRY:                       # --dry-run parses and reports, writes NOTHING
        _record(emitted, dest)
        return True
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        if (not dest.exists()) or dest.stat().st_mtime < src.stat().st_mtime \
                or dest.stat().st_size != src.stat().st_size:
            shutil.copy2(src, dest)
        _record(emitted, dest)
        return True
    except OSError as e:
        warn("could not copy %s: %s" % (_rel(src), e), "copy-failed")
        return False


def collect_assets(topic_dir, topic_id, emitted):
    """Copy media into assets/<topic>/ with NAMESPACED flat names.

    `images/fig1.png` -> `images__fig1.png`, `attachments/a/fig1.png` ->
    `attachments__a__fig1.png`. Same basename in two folders can no longer
    silently overwrite (§9.7).
    """
    out = []
    candidates = []
    for sub in ASSET_DIRS:
        d = topic_dir / sub
        if d.is_dir():
            candidates += sorted(p for p in d.rglob("*")
                                 if p.is_file() and not is_private_path(p, topic_dir))
    candidates += sorted(p for p in topic_dir.glob("*")
                         if p.is_file() and p.suffix.lower() in IMAGE_EXT
                         and not is_private_name(p.name))
    if not candidates:
        return out

    dest_dir = ASSETS / topic_id
    used = {}
    for p in candidates:
        ext = p.suffix.lower()
        if ext not in IMAGE_EXT and ext not in DOC_EXT:
            continue
        try:
            size = p.stat().st_size
        except OSError as e:
            warn("could not read %s: %s" % (_rel(p), e), "asset-stat")
            continue
        if size > MAX_ASSET_BYTES:
            warn("%s is %d MB — too big to ship, so it is not in the hub"
                 % (_rel(p), size // (1024 * 1024)), "asset-too-large")
            continue
        try:
            rel_parts = list(p.relative_to(topic_dir).parts)
        except ValueError:
            rel_parts = [p.name]
        flat = safe_filename("__".join(rel_parts))
        if flat in used and used[flat] != str(p):
            stem, dot, suffix = flat.rpartition(".")
            digest = hashlib.sha1(str(p).encode("utf-8")).hexdigest()[:6]
            flat = "%s-%s%s%s" % (stem or flat, digest, dot, suffix)
        used[flat] = str(p)
        dest = dest_dir / flat
        if not _copy_if_newer(p, dest, emitted):
            continue
        out.append({
            "name": p.stem.replace("-", " ").replace("_", " "),
            "file": flat,
            "url": "assets/%s/%s" % (topic_id, flat),
            "kind": "image" if ext in IMAGE_EXT else "doc",
            "size": size,
        })
    return out


TITLE_RE = re.compile(r"<title>(.*?)</title>", re.I | re.S)
LESSON_FILE_RE = re.compile(r"^(\d{1,4})[-_](.+)$")


def _doc_title(path, topic_name):
    head = read_text(path)[:4000]
    tm = TITLE_RE.search(head)
    if tm:
        title = re.sub(r"\s+", " ", tm.group(1)).strip()
        # "What Is a Mole? — Mole Concept" -> "What Is a Mole?"
        for dash in (" — ", " – ", " - ", " | "):
            if title.lower().endswith(dash + topic_name.lower()):
                title = title[: -len(dash + topic_name)].strip()
                break
        if title:
            return title
    stem = re.sub(r"^\d+[-_]", "", path.stem)
    return stem.replace("-", " ").replace("_", " ").strip().title()


def collect_docs(topic_dir, topic_id, topic_name, emitted):
    """lessons/*.html + reference|cheatsheets/*.html -> docs[] and lessonsMeta[]."""
    docs = []
    lessons_meta = []
    for sub, kind in (("lessons", "lesson"), ("reference", "cheatsheet"),
                      ("cheatsheets", "cheatsheet")):
        d = topic_dir / sub
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.html")):
            if is_private_name(p.name):
                continue
            name = safe_filename(p.name)
            dest = ASSETS / topic_id / sub / name
            if not _copy_if_newer(p, dest, emitted):
                continue
            url = "assets/%s/%s/%s" % (topic_id, sub, name)
            title = _doc_title(p, topic_name)
            docs.append({"title": title, "kind": kind, "url": url})
            if kind == "lesson":
                m = LESSON_FILE_RE.match(p.stem)
                lessons_meta.append({
                    "n": int(m.group(1)) if m else len(lessons_meta) + 1,
                    "slug": (m.group(2) if m else p.stem),
                    "title": title,
                    "url": url,
                })
    lessons_meta.sort(key=lambda l: l["n"])
    return docs, lessons_meta


def collect_notes(topic_dir):
    """Any markdown that is not a flashcard file or a mindmap -> in-app note."""
    notes = []
    for p in sorted(topic_dir.rglob("*.md")):
        if "flashcards" in p.parts:
            continue
        if p.name in MINDMAP_NAMES:
            continue
        if is_private_path(p, topic_dir):      # nested _private/ inside a topic
            continue
        raw = read_text(p)
        _fm, body = parse_frontmatter(raw)
        txt = strip_comments(body).strip()
        if not txt:
            continue
        if len(txt) > MAX_NOTE_CHARS:
            txt = txt[:MAX_NOTE_CHARS] + "\n\n…(truncated)"
        notes.append({
            "title": p.stem.replace("-", " ").replace("_", " ").title(),
            "body": txt,
            "path": _rel(p),
        })
    return notes


# --------------------------------------------------------------------------
# 6. Topic build
# --------------------------------------------------------------------------

def build_topic(topic_dir, emitted):
    topic_id = slug(topic_dir.name)
    name = topic_dir.name.replace("-", " ").replace("_", " ").strip().title()

    # --- MISSION.md frontmatter: subject/unit are DECLARED, never guessed ---
    fm, mission_body = {}, ""
    mission = None
    for cand in ("MISSION.md", "mission.md", "Mission.md"):
        p = topic_dir / cand
        if p.exists():
            mission = p
            break
    if mission is not None:
        fm, mission_body = parse_frontmatter(read_text(mission))
    else:
        warn("%s has no MISSION.md — subject, unit and the goal line are all missing"
             % topic_dir.name, "no-mission")

    if fm.get("topic_id") and slug(fm["topic_id"]) != topic_id:
        warn("%s: MISSION.md says topic_id '%s' but the folder name gives '%s'. The folder "
             "name wins — rename one of them so links stay stable."
             % (topic_dir.name, fm["topic_id"], topic_id), "topic-id-mismatch")

    subject = (fm.get("subject") or "").strip()
    if not subject:
        subject = "General"
        warn("%s: no `subject:` in MISSION.md frontmatter — it will show as General. Subject "
             "is never guessed from words in the text." % topic_dir.name, "no-subject")
    unit = (fm.get("unit") or "").strip()
    if not unit:
        warn("%s: no `unit:` in MISSION.md frontmatter — exam grouping by unit is off for it."
             % topic_dir.name, "no-unit")
    badge = (fm.get("badge") or "").strip().lower() or SUBJECT_BADGES.get(subject.lower(), "general")
    if fm.get("name"):
        name = fm["name"].strip() or name
    if fm.get("title"):
        name = fm["title"].strip() or name

    # --- cards -------------------------------------------------------------
    cards = []
    fc_dir = topic_dir / "flashcards"
    fc_files = sorted(p for p in fc_dir.glob("*.md")
                      if not is_private_name(p.name)) if fc_dir.is_dir() else []
    if not fc_files and fc_dir.is_dir():
        warn("%s: flashcards/ is empty" % topic_dir.name, "no-cards")
    for fc in fc_files:
        try:
            cards += parse_flashcards(read_text(fc), source=fc.stem, topic_id=topic_id)
        except Exception:
            warn("%s: the flashcard file could not be read, so its cards are missing\n%s"
                 % (_rel(fc), traceback.format_exc(limit=2)), "card-parse-failed")

    by_id = {}
    deduped = []
    for c in cards:
        if c["id"] in by_id:
            warn("%s: card id '%s' is used twice — only the first copy ships"
                 % (topic_dir.name, c["id"]), "duplicate-id")
            continue
        by_id[c["id"]] = c
        deduped.append(c)
    cards = deduped

    notes = collect_notes(topic_dir)
    docs, lessons_meta = collect_docs(topic_dir, topic_id, name, emitted)
    assets = collect_assets(topic_dir, topic_id, emitted)

    lesson_numbers = {"%04d" % l["n"] for l in lessons_meta} | {str(l["n"]) for l in lessons_meta}
    for c in cards:
        if c["lesson"] and lessons_meta and c["lesson"].lstrip("0") not in \
                {str(l["n"]) for l in lessons_meta} and c["lesson"] not in lesson_numbers:
            warn("%s: card %s points at lesson %s, which has no file in lessons/"
                 % (topic_dir.name, c["id"], c["lesson"]), "dangling-lesson")

    # --- description -------------------------------------------------------
    description = ""
    if fm.get("goal"):
        description = fm["goal"].strip()
    if not description and mission_body:
        gm = re.search(r"\*\*Goal:\*\*\s*(.+)", mission_body)
        if gm:
            description = gm.group(1).strip()
        else:
            for ln in strip_comments(mission_body).splitlines():
                if ln.strip() and not ln.startswith("#") and not ln.startswith("|"):
                    description = ln.strip()
                    break
    if not description:
        description = "%d cards · %d notes" % (len(cards), len(notes))
    description = re.sub(r"\s+", " ", description).strip()

    # --- mindmap -----------------------------------------------------------
    mm = None
    for cand in MINDMAP_NAMES:
        p = topic_dir / cand
        if p.exists():
            mm = parse_mindmap(read_text(p))
            if mm is None:
                warn("%s: %s has no bullet list the map can read" % (topic_dir.name, cand),
                     "empty-mindmap")
            break
    if mm is None:
        mm = auto_mindmap(name, cards)
    else:
        dangling = [n.get("cardId") for n in walk_mindmap(mm)
                    if n.get("cardId") and n.get("cardId") not in by_id]
        if dangling:
            warn("%s: the mindmap points at %d card id(s) that do not exist (%s)"
                 % (topic_dir.name, len(dangling), ", ".join(sorted(set(dangling))[:3])),
                 "dangling-card-ref")

    # --- updated -----------------------------------------------------------
    updated = (fm.get("updated") or "").strip()
    if not ISO_DATE_RE.match(updated or ""):
        try:
            mtime = max([topic_dir.stat().st_mtime]
                        + [p.stat().st_mtime for p in topic_dir.rglob("*") if p.is_file()])
        except (OSError, ValueError):
            mtime = topic_dir.stat().st_mtime
        updated = local_day_from_mtime(mtime)

    return {
        "id": topic_id,
        "name": name,
        "subject": subject,
        "unit": unit,
        "badge": badge,
        "description": description,
        "flashcards": cards,
        "notes": notes,
        "docs": docs,
        "lessonsMeta": lessons_meta,
        "assets": assets,
        "mindmap": mm,
        "updated": updated,
        "mission": {
            "cdcUnitNo": fm.get("cdc_unit_no", ""),
            "teachingHours": fm.get("teaching_hours", ""),
            "examWindow": fm.get("exam_window", ""),
            "status": fm.get("status", ""),
        },
    }


# --------------------------------------------------------------------------
# 7. Data packs (numericals / questions / formulas / diagrams)
# --------------------------------------------------------------------------

def copy_data_packs(emitted_data):
    """Copy authored JSON packs from <vault>/data into <hub>/data.

    MERGE ONLY — never prunes. `data/` also holds files committed straight into
    the hub repo by the content agents, and this pipeline must not delete them.
    """
    copied = 0
    src_root = None
    for cand in ("data", "Data"):
        d = VAULT / cand
        if d.is_dir():
            src_root = d
            break
    if src_root is None:
        return 0

    dest_root = HUB / "data"
    dest_root.mkdir(parents=True, exist_ok=True)

    for p in sorted(src_root.glob("*.json")):
        if _copy_if_newer(p, dest_root / safe_filename(p.name), emitted_data):
            copied += 1
    for name in DATA_PACKS:
        d = src_root / name
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*.json")):
            rel = p.relative_to(d)
            dest = dest_root / name / Path(*[safe_filename(part) for part in rel.parts])
            if _copy_if_newer(p, dest, emitted_data):
                copied += 1
    return copied


def check_numericals_index(fix=False):
    """Directory listings do not exist over HTTP: every template file must be
    named in data/numericals/index.json or the app never loads it."""
    d = HUB / "data" / "numericals"
    if not d.is_dir():
        return
    files = sorted(p.name for p in d.glob("*.json") if p.name != "index.json")
    if not files:
        return
    idx_path = d / "index.json"
    listed = []
    idx = {"version": 1, "files": []}
    if idx_path.exists():
        try:
            idx = json.loads(read_text(idx_path)) or {}
            listed = [str(f) for f in (idx.get("files") or [])]
        except (ValueError, TypeError):
            warn("data/numericals/index.json is not valid JSON — the app will fall back to its "
                 "built-in list", "bad-index")
            return
    missing = [f for f in files if f not in listed]
    stale = [f for f in listed if f not in files]
    if stale:
        warn("data/numericals/index.json lists %s, which is not in the folder"
             % ", ".join(stale), "index-stale")
    if missing:
        if fix:
            idx["files"] = listed + missing
            write_atomic(idx_path, json.dumps(idx, indent=2, ensure_ascii=False) + "\n")
            info("  · added %s to data/numericals/index.json" % ", ".join(missing))
        else:
            warn("data/numericals/%s ships but is not listed in index.json, so the practice "
                 "engine never loads it (run with --fix-index)" % ", ".join(missing),
                 "index-missing")


# --------------------------------------------------------------------------
# 8. Writing — atomic, escaped, pruned
# --------------------------------------------------------------------------

def write_atomic(path, text):
    """.tmp + os.replace: a killed run can never leave a half-written file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def js_payload(json_text):
    """Make a JSON string safe inside a classic <script> tag.

    `</script>` would close the tag, `<!--` opens a legacy HTML comment in JS,
    and U+2028/U+2029 are line terminators to older parsers. All three are
    escaped with sequences that mean the same characters once parsed.
    """
    return (json_text
            .replace("</", "<\\/")
            .replace("<!--", "<\\!--")
            .replace(" ", "\\u2028")
            .replace(" ", "\\u2029"))


def load_manifest():
    p = ASSETS / MANIFEST_NAME
    if not p.exists():
        return []
    try:
        data = json.loads(read_text(p)) or {}
        return [str(x) for x in (data.get("paths") or [])]
    except (ValueError, TypeError):
        return []


def save_manifest(paths):
    payload = {
        "version": 1,
        "generator": GENERATOR_VERSION,
        "generated": datetime.now().isoformat(timespec="seconds"),
        "note": "Written by generate_data.py. Only paths listed here are ever pruned.",
        "paths": sorted(paths),
    }
    write_atomic(ASSETS / MANIFEST_NAME, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def prune_orphans(emitted):
    """Delete only what a previous run of THIS generator wrote and this run did
    not. Shell assets are reserved and can never be touched."""
    removed = 0
    for rel in load_manifest():
        if rel in emitted:
            continue
        rel_path = rel.replace("\\", "/")
        if not rel_path.startswith("assets/"):
            continue                      # data/ is merge-only, never pruned
        parts = rel_path.split("/")
        if len(parts) > 1 and parts[1] in RESERVED_ASSETS:
            continue
        target = HUB / rel_path
        try:
            if target.is_file():
                target.unlink()
                removed += 1
        except OSError as e:
            warn("could not remove the stale file %s: %s" % (rel_path, e), "prune-failed")
    # tidy up directories the removals emptied
    if ASSETS.is_dir():
        for d in sorted((p for p in ASSETS.rglob("*") if p.is_dir()),
                        key=lambda p: len(p.parts), reverse=True):
            if d.name in RESERVED_ASSETS:
                continue
            try:
                if not any(d.iterdir()):
                    d.rmdir()
            except OSError:
                pass
    return removed


def previous_topic_count():
    p = HUB / "vault-data.json"
    if not p.exists():
        return 0
    try:
        data = json.loads(read_text(p)) or {}
        return len(data.get("topics") or [])
    except (ValueError, TypeError):
        return 0


# --------------------------------------------------------------------------
# 9. Library shelf (Study/Books/INDEX.md)
# --------------------------------------------------------------------------

def collect_library():
    library = []
    index_file = VAULT / "Study" / "Books" / "INDEX.md"
    if not index_file.exists():
        return library
    for ln in read_text(index_file).splitlines():
        m = re.match(r"^\s*[-*]\s+\*\*(.+?)\*\*\s*[—\-–:]\s*(.+)$", ln)
        if m:
            library.append({"title": m.group(1).strip(), "detail": m.group(2).strip()})
    return library


# --------------------------------------------------------------------------
# 10. Self-test (no vault needed — `python generate_data.py --self-test`)
# --------------------------------------------------------------------------

def self_test():
    fails = []
    ran = [0]

    def ok(cond, label):
        ran[0] += 1
        if not cond:
            fails.append(label)

    # 1. all five syntaxes
    text = (
        "## Q: Canonical question?\nA: Canonical answer.\n\n"
        "**Q:** Bold question?\n**A:** Bold answer.\n\n"
        "Q: Bare question?\nA: Bare answer.\n\n"
        "Double colon question :: double colon answer\n"
        "Double query question ?? double query answer\n"
    )
    cards = parse_flashcards(text, source="deck", strict=False)
    ok(len(cards) == 5, "five syntaxes -> got %d cards" % len(cards))
    qs = [c["q"] for c in cards]
    ok(qs[0] == "Canonical question?", "canonical order/text: %r" % qs[:1])
    ok(any(c["a"] == "double colon answer" for c in cards), ":: syntax")
    ok(any(c["a"] == "double query answer" for c in cards), "?? syntax")
    ok(any(c["q"] == "Bold question?" and c["a"] == "Bold answer." for c in cards), "** syntax")

    # 2. legacy id is bit-stable
    ok(legacy_card_id("Mole-Concept-flashcards", "What is a mole?") == "ffc0a0edda68",
       "legacy sha1 id drifted")

    # 3. metadata comment between Q and A
    meta_text = (
        "## Q: What is the Avogadro constant?\n"
        "<!-- id: mole-0001-03 | type: definition | cognitive: knowledge | pacer: R | "
        "misconceptions: CH-M08, CH-M01 | lesson: 0001 -->\n"
        "A: 6.022 × 10²³ mol⁻¹.\n"
    )
    c = parse_flashcards(meta_text, source="deck", strict=False)[0]
    ok(c["id"] == "mole-0001-03", "declared id not used: %r" % c["id"])
    ok(c["type"] == "definition" and c["pacer"] == "R" and c["cognitive"] == "knowledge",
       "metadata fields")
    ok(c["misconceptions"] == ["CH-M08", "CH-M01"], "misconception list: %r" % c["misconceptions"])
    ok(c["lesson"] == "0001", "lesson field")
    ok("<!--" not in c["a"] and c["a"].startswith("6.022"), "answer polluted: %r" % c["a"])

    # 4. retired cards inside a block comment never ship
    retired = (
        "## Q: Live question?\nA: Live answer.\n\n"
        "<!--\n## Q: Retired question?\nA: Retired answer.\n-->\n"
    )
    rc = parse_flashcards(retired, source="deck", strict=False)
    ok(len(rc) == 1 and rc[0]["q"] == "Live question?", "comment-masking failed: %r" % rc)

    # 4b. an UNCLOSED block comment fails closed — the retired cards after the
    #     broken marker must be dropped, never resurrected as live cards.
    broken = (
        "## Q: Live question?\nA: Live answer.\n\n"
        "<!--\n## Q: RETIRED question that must never ship?\nA: Retired answer.\n"
    )
    global QUIET
    before, was_quiet = len(WARNINGS), QUIET
    QUIET = True                      # the warning is expected here — do not print it
    bc = parse_flashcards(broken, source="deck", strict=False)
    QUIET = was_quiet
    ok(len(bc) == 1 and bc[0]["q"] == "Live question?",
       "unclosed comment resurrected retired cards: %r" % [c["q"] for c in bc])
    ok(len(WARNINGS) > before and WARNINGS[-1].startswith("an HTML comment is never closed"),
       "unclosed comment did not warn")
    del WARNINGS[before:]
    del WARN_DETAIL[before:]

    # 5. frontmatter
    fm, body = parse_frontmatter("---\nsubject: Chemistry\nunit: Stoichiometry\n---\n# Title\n")
    ok(fm.get("subject") == "Chemistry" and fm.get("unit") == "Stoichiometry", "frontmatter keys")
    ok(body.strip() == "# Title", "frontmatter body split")

    # 6. mindmap + node metadata + comment awareness
    mm = parse_mindmap(
        "<!--\n  - Example node | card:not-real\n-->\n"
        "- Root\n  - Branch | lesson:0001 | testable:hi\n    - Leaf | card:mole-0001-03\n"
    )
    ok(mm and mm["label"] == "Root", "mindmap root")
    ok(mm["children"][0]["label"] == "Branch", "mindmap label strips metadata")
    ok(mm["children"][0].get("lesson") == "0001", "mindmap lesson meta")
    ok(mm["children"][0]["children"][0].get("cardId") == "mole-0001-03", "mindmap cardId")
    ok(all(n.get("cardId") != "not-real" for n in walk_mindmap(mm)), "mindmap comment example leaked")

    # 7. auto_mindmap keeps the >=2-card rule
    two = [{"q": "What is molar mass of CO2?", "id": "a"},
           {"q": "What is molar mass of NaCl?", "id": "b"},
           {"q": "Define entropy here", "id": "c"}]
    am = auto_mindmap("Topic", two)
    labels = [ch["label"] for ch in am["children"]]
    ok(any(l.lower() == "molar" or l.lower() == "mass" for l in labels),
       "shared keyword did not become a branch: %r" % labels)

    # 8. script escaping
    esc = js_payload(json.dumps({"a": "</script><!--  "}, ensure_ascii=False))
    ok("</script>" not in esc and "<!--" not in esc and " " not in esc,
       "js escaping: %r" % esc)
    ok(json.loads(esc.replace("<\\/", "</").replace("<\\!--", "<!--")
                  .replace("\\u2028", " "))["a"].startswith("</script>"),
       "js escaping is not reversible")

    # 9. asset name namespacing
    ok(safe_filename("attachments__fig 1.png") == "attachments__fig-1.png",
       "safe_filename: %r" % safe_filename("attachments__fig 1.png"))

    # 10. local date helper never uses UTC
    ok(ISO_DATE_RE.match(local_day_from_mtime(0)), "local_day_from_mtime shape")

    # 11. PRIVACY: '_'/'.'-prefixed vault paths are never publishable.
    # Teaching/_profile/student-profile.md holds what the teaching side knows
    # about the student. The hub is public. This must fail loudly if it regresses.
    ok(is_private_name("_profile") and is_private_name(".obsidian"),
       "is_private_name misses a private folder")
    ok(not is_private_name("Mole-Concept") and not is_private_name("flashcards"),
       "is_private_name wrongly hides real content")
    ok(is_private_path(Path("/v/T/_profile/student-profile.md"), Path("/v/T")),
       "is_private_path misses a private parent folder")
    ok(is_private_path(Path("/v/T/notes/_scratch.md"), Path("/v/T")),
       "is_private_path misses a private leaf file")
    ok(not is_private_path(Path("/v/T/lessons/0001-mole.md"), Path("/v/T")),
       "is_private_path wrongly hides real content")

    if fails:
        print("SELF-TEST FAILED (%d):" % len(fails))
        for f in fails:
            print("  ✗ " + f)
        return 1
    print("✓ self-test: %d checks passed "
          "(5 syntaxes · metadata · comments · ids · escaping · privacy)" % ran[0])
    return 0


# --------------------------------------------------------------------------
# 11. main
# --------------------------------------------------------------------------

def resolve_paths(args):
    vault = args.vault or os.environ.get("ENGRAM_VAULT") or str(DEFAULT_VAULT)
    hub = args.hub or os.environ.get("ENGRAM_HUB") or str(Path(__file__).resolve().parent)
    return Path(vault).expanduser().resolve(), Path(hub).expanduser().resolve()


def build_parser():
    p = argparse.ArgumentParser(
        prog="generate_data.py",
        description="Build vault-data.js / vault-data.json for the Engram study hub.")
    p.add_argument("--vault", help="vault root (default: $ENGRAM_VAULT or /opt/data/obsidian-vault)")
    p.add_argument("--hub", help="hub root (default: $ENGRAM_HUB or this file's folder)")
    p.add_argument("--max-warnings", type=int,
                   default=int(os.environ.get("ENGRAM_MAX_WARNINGS", DEFAULT_MAX_WARNINGS)),
                   help="exit 2 when more warnings than this are collected (default %d)"
                        % DEFAULT_MAX_WARNINGS)
    p.add_argument("--allow-empty", action="store_true",
                   help="allow overwriting a populated vault-data with zero topics")
    p.add_argument("--fix-index", action="store_true",
                   help="add unlisted template files to data/numericals/index.json")
    p.add_argument("--no-prune", action="store_true", help="keep orphaned generated assets")
    p.add_argument("--dry-run", action="store_true", help="parse and report, write nothing")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--self-test", action="store_true", help="run the parser tests and exit")
    return p


def main(argv=None):
    global VAULT, HUB, ASSETS, QUIET, DRY, WARNINGS, WARN_DETAIL
    args = build_parser().parse_args(argv)
    if args.self_test:
        return self_test()

    QUIET = args.quiet
    DRY = args.dry_run
    WARNINGS = []
    WARN_DETAIL = []
    VAULT, HUB = resolve_paths(args)
    ASSETS = HUB / "assets"

    if not VAULT.is_dir():
        print("✗ vault not found: %s\n  pass --vault <path> or set ENGRAM_VAULT" % VAULT,
              file=sys.stderr)
        return 1
    if not HUB.is_dir():
        print("✗ hub not found: %s\n  pass --hub <path> or set ENGRAM_HUB" % HUB, file=sys.stderr)
        return 1

    info("· vault %s" % VAULT)
    info("· hub   %s" % HUB)

    emitted = set()
    topics = []
    teaching = VAULT / "Teaching"
    if not teaching.is_dir():
        warn("there is no Teaching folder in %s, so no topics were built" % VAULT, "no-teaching")
    else:
        for topic_dir in sorted(teaching.iterdir()):
            if not topic_dir.is_dir():
                continue
            # '_'/'.'-prefixed folders are private (student profile, session
            # logs). Skipped silently and BEFORE build_topic, so a private
            # folder cannot become a hub topic or emit a 'no MISSION' warning
            # that would hint at its existence.
            if is_private_name(topic_dir.name):
                continue
            # A scaffolded-but-empty folder is a DEFERRED topic, not a broken
            # one: the folders exist so the shape of the syllabus is visible,
            # and the content is authored later. Building it would emit five
            # separate warnings (no-mission, no-subject, no-unit, no-cards,
            # empty-topic) for one deliberate decision, put a false "files did
            # not parse" banner in front of the student, and eat a quarter of
            # the --max-warnings budget. Report it once, as information.
            if is_empty_scaffold(topic_dir):
                info("· %s is scaffolded but empty — deferred, not in the hub yet"
                     % topic_dir.name)
                continue
            try:
                t = build_topic(topic_dir, emitted)
                if t["flashcards"] or t["notes"] or t["docs"] or t["assets"]:
                    topics.append(t)
                else:
                    warn("the topic folder '%s' has nothing in it yet, so it is not in the hub"
                         % topic_dir.name, "empty-topic")
            except Exception:
                warn("the topic '%s' could not be built, so it is missing from the hub\n%s"
                     % (topic_dir.name, traceback.format_exc(limit=3)), "topic-failed")

    # global card-id collision check across topics (store keys are global)
    global_ids = {}
    for t in topics:
        for c in t["flashcards"]:
            if c["id"] in global_ids and global_ids[c["id"]] != t["id"]:
                warn("card id '%s' is used by both '%s' and '%s' — one of them will inherit the "
                     "other's review history" % (c["id"], global_ids[c["id"]], t["id"]),
                     "cross-topic-id")
            global_ids[c["id"]] = t["id"]

    counts = {
        "topics": len(topics),
        "flashcards": sum(len(t["flashcards"]) for t in topics),
        "cards": sum(len(t["flashcards"]) for t in topics),   # legacy alias
        "notes": sum(len(t["notes"]) for t in topics),
        "docs": sum(len(t["docs"]) for t in topics),
        "lessons": sum(len(t["lessonsMeta"]) for t in topics),
        "assets": sum(len(t["assets"]) for t in topics),
    }

    if not topics and previous_topic_count() > 0 and not args.allow_empty:
        print("✗ refusing to replace %d existing topics with an empty vault-data — check --vault "
              "(%s). Pass --allow-empty if this is really what you want."
              % (previous_topic_count(), VAULT), file=sys.stderr)
        return 1

    now = datetime.now()
    data = {
        "schema": SCHEMA,
        "generator": GENERATOR_VERSION,
        "topics": topics,
        "library": collect_library(),
        "generated": now.isoformat(timespec="seconds"),
        "generated_at": now.isoformat(timespec="seconds"),
        "generatedDay": local_day_from_mtime(now.timestamp()),
        "counts": counts,
        "warnings": WARNINGS,
        "warningsDetail": WARN_DETAIL,
    }

    if args.dry_run:
        info("· dry run — nothing written")
    else:
        data_copied = copy_data_packs(emitted)
        if data_copied:
            info("· %d data pack file(s) copied from the vault" % data_copied)
        check_numericals_index(fix=args.fix_index)

        json_text = json.dumps(data, ensure_ascii=False)
        try:
            write_atomic(HUB / "vault-data.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            write_atomic(HUB / "vault-data.js",
                         "/* generated by generate_data.py — never hand-edit */\n"
                         "window.VAULT_DATA = " + js_payload(json_text) + ";\n")
        except OSError as e:
            print("✗ could not write vault-data: %s" % e, file=sys.stderr)
            return 1

        pruned = 0 if args.no_prune else prune_orphans(emitted)
        save_manifest(emitted)
        if pruned:
            info("· pruned %d orphaned generated file(s)" % pruned)
        nojekyll = HUB / ".nojekyll"
        if not nojekyll.exists():
            try:
                nojekyll.write_text("", encoding="utf-8")
                info("· created .nojekyll (GitHub Pages drops _-prefixed paths without it)")
            except OSError:
                warn("could not create .nojekyll in the hub", "nojekyll")

    info("✓ %d topics · %d cards · %d lessons · %d notes · %d assets%s"
         % (counts["topics"], counts["flashcards"], counts["lessons"], counts["notes"],
            counts["assets"],
            (" · %d warnings" % len(WARNINGS)) if WARNINGS else ""))

    if len(WARNINGS) > args.max_warnings:
        print("✗ %d warnings, above the limit of %d — fix the vault before publishing"
              % (len(WARNINGS), args.max_warnings), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
