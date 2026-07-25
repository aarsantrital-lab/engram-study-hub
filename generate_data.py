#!/usr/bin/env python3
"""
Study Hub Data Generator (v2)
Reads the Obsidian vault -> emits vault-data.json + vault-data.js for the Study Hub.

Robustness rules:
  - Never crash on a single malformed file. Collect warnings, keep going.
  - Support several flashcard syntaxes.
  - Pull topic metadata from MISSION.md, lessons/, reference/, notes/, attachments/.
  - Copy topic attachments into study-hub/assets/<topic>/ so GitHub Pages can serve them.
"""

import base64
import hashlib
import json
import mimetypes
import re
import shutil
import sys
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

VAULT = Path("/opt/data/obsidian-vault")
HUB = Path("/opt/data/study-hub")
OUT = HUB / "vault-data.json"
ASSETS = HUB / "assets"

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"}
DOC_EXT = {".pdf"}
MAX_ASSET_BYTES = 12 * 1024 * 1024  # skip anything absurd

WARNINGS = []


def warn(msg):
    WARNINGS.append(msg)
    print(f"  ! {msg}", file=sys.stderr)


def slug(s):
    s = re.sub(r"[^\w\s-]", "", str(s)).strip().lower()
    return re.sub(r"[\s_]+", "-", s) or "untitled"


def read_text(p):
    for enc in ("utf-8", "utf-8-sig", "latin-1"):
        try:
            return p.read_text(encoding=enc)
        except (UnicodeDecodeError, OSError):
            continue
    warn(f"unreadable file: {p}")
    return ""


# ---------------------------------------------------------------- flashcards

def _clean(s):
    s = s.strip()
    s = re.sub(r"^\*\*(.+)\*\*$", r"\1", s)
    return s.strip()


def parse_flashcards(text, source=""):
    """Supports:
        ## Q: question / A: answer     (canonical)
        **Q:** question / **A:** answer
        Q: question / A: answer
        question :: answer             (Obsidian spaced-repetition)
        question ?? answer
    Multi-line answers are joined until a blank line + next question.
    """
    cards = []
    seen = set()

    def push(q, a, extra=None):
        q, a = _clean(q), _clean(a)
        if not q or not a:
            return
        key = q.lower()
        if key in seen:
            return
        seen.add(key)
        card = {
            "id": hashlib.sha1(f"{source}|{q}".encode("utf-8")).hexdigest()[:12],
            "q": q,
            "a": a,
            "source": source,
        }
        if extra:
            card.update(extra)
        cards.append(card)

    # --- inline :: / ?? syntax
    for line in text.splitlines():
        m = re.match(r"^(?!#)(.{3,}?)\s(?:::|\?\?)\s(.{1,})$", line.strip())
        if m:
            push(m.group(1), m.group(2))

    # --- block Q/A syntax
    qa_re = re.compile(r"^(?:#{1,6}\s*)?(?:\*\*)?Q(?:uestion)?(?:\*\*)?\s*[:.)]\s*(.+)$", re.I)
    ans_re = re.compile(r"^(?:#{1,6}\s*)?(?:\*\*)?A(?:nswer)?(?:\*\*)?\s*[:.)]\s*(.*)$", re.I)

    lines = text.splitlines()
    i = 0
    while i < len(lines):
        qm = qa_re.match(lines[i].strip())
        if not qm:
            i += 1
            continue
        q = qm.group(1)
        a_parts = []
        j = i + 1
        started = False
        while j < len(lines):
            ln = lines[j]
            if qa_re.match(ln.strip()) and started:
                break
            am = ans_re.match(ln.strip())
            if am and not started:
                started = True
                if am.group(1).strip():
                    a_parts.append(am.group(1).strip())
            elif started:
                if qa_re.match(ln.strip()):
                    break
                if ln.strip().startswith("---"):
                    break
                a_parts.append(ln.rstrip())
            j += 1
        if started:
            push(q, "\n".join(a_parts).strip())
            i = j
        else:
            i += 1

    return cards


# ---------------------------------------------------------------- subjects

SUBJECT_RULES = [
    (("chem", "mole", "stoichio", "atom", "periodic", "acid", "redox"), "Chemistry", "chemistry"),
    (("physic", "kinemat", "newton", "thermo", "optics", "wave", "electr"), "Physics", "physics"),
    (("math", "algebra", "calculus", "trig", "geometry", "matrix"), "Mathematics", "math"),
    (("english", "grammar", "essay", "literature", "poem"), "English", "english"),
    (("nepali",), "Nepali", "nepali"),
    (("computer", "programming", "python", "cs-", "/cs", "database", "network"), "Computer Science", "cs"),
    (("bio", "cell", "genetic"), "Biology", "biology"),
]


def detect_subject(path_str, text=""):
    hay = (path_str + " " + text[:800]).lower()
    for keys, name, badge in SUBJECT_RULES:
        if any(k in hay for k in keys):
            return name, badge
    return "General", "general"


# ---------------------------------------------------------------- assets

def collect_assets(topic_dir, topic_id):
    """Copy images/pdfs from the topic folder into hub assets/, return manifest."""
    out = []
    candidates = []
    for sub in ("attachments", "images", "assets", "diagrams", "flowcharts"):
        d = topic_dir / sub
        if d.is_dir():
            candidates += [p for p in d.rglob("*") if p.is_file()]
    # loose images at topic root
    candidates += [p for p in topic_dir.glob("*") if p.is_file() and p.suffix.lower() in IMAGE_EXT]

    if not candidates:
        return out
    dest_dir = ASSETS / topic_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    for p in candidates:
        ext = p.suffix.lower()
        if ext not in IMAGE_EXT and ext not in DOC_EXT:
            continue
        try:
            size = p.stat().st_size
            if size > MAX_ASSET_BYTES:
                warn(f"asset too large, skipped: {p.name} ({size//1024}KB)")
                continue
            dest = dest_dir / p.name
            if not dest.exists() or dest.stat().st_mtime < p.stat().st_mtime:
                shutil.copy2(p, dest)
            out.append({
                "name": p.stem.replace("-", " ").replace("_", " "),
                "file": p.name,
                "url": f"assets/{topic_id}/{p.name}",
                "kind": "image" if ext in IMAGE_EXT else "doc",
                "size": size,
            })
        except OSError as e:
            warn(f"asset copy failed {p}: {e}")
    return out


# ---------------------------------------------------------------- mindmap

def parse_mindmap(md_text):
    """Indented bullet list -> nested nodes.
       - Root
         - Child
           - Grandchild
    """
    root = {"label": None, "children": []}
    stack = [(-1, root)]
    for raw in md_text.splitlines():
        m = re.match(r"^(\s*)[-*+]\s+(.+?)\s*$", raw)
        if not m:
            continue
        indent = len(m.group(1).expandtabs(2))
        label = re.sub(r"[*_`]", "", m.group(2)).strip()
        if not label:
            continue
        node = {"label": label, "children": []}
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
    """Extract the subject phrase a question is *about*, for clustering."""
    s = re.sub(r"[^\w\s₀-₉⁰-⁹]", " ", q.lower())
    words = [w for w in s.split() if w not in STOP and len(w) > 1]
    if not words:
        return None
    # prefer a 2-word phrase, fall back to 1
    return " ".join(words[:2]) if len(words) >= 2 else words[0]


def auto_mindmap(name, cards):
    """Fallback mindmap: cluster cards by shared subject keywords."""
    if not cards:
        return None

    # count keyword frequency so shared concepts become branches
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
        # pick the most shared keyword as the branch this card belongs under
        best = max(kws, key=lambda w: (freq[w], len(w)), default=None)
        if best is None or freq[best] < 2:
            label = (_topic_phrase(c["q"]) or c["q"][:26]).title()
        else:
            label = best.title()
        buckets.setdefault(label, []).append(c)

    # merge singleton buckets into a catch-all so the tree isn't a comb
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


# ---------------------------------------------------------------- html docs

def collect_docs(topic_dir, topic_id):
    docs = []
    for sub, kind in (("lessons", "lesson"), ("reference", "reference"), ("cheatsheets", "reference")):
        d = topic_dir / sub
        if not d.is_dir():
            continue
        dest_dir = ASSETS / topic_id / sub
        for p in sorted(d.glob("*.html")):
            try:
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / p.name
                if not dest.exists() or dest.stat().st_mtime < p.stat().st_mtime:
                    shutil.copy2(p, dest)
                title = p.stem
                head = read_text(p)[:4000]
                tm = re.search(r"<title>(.*?)</title>", head, re.I | re.S)
                if tm:
                    title = tm.group(1).strip()
                docs.append({
                    "title": re.sub(r"^\d+[-_]", "", title).replace("-", " ").strip().title(),
                    "kind": kind,
                    "url": f"assets/{topic_id}/{sub}/{p.name}",
                })
            except OSError as e:
                warn(f"doc copy failed {p}: {e}")
    return docs


def collect_notes(topic_dir):
    """Any markdown that isn't flashcards -> reference notes shown in-app."""
    notes = []
    skip_dirs = {"flashcards"}
    for p in sorted(topic_dir.rglob("*.md")):
        if any(part in skip_dirs for part in p.parts):
            continue
        txt = read_text(p).strip()
        if not txt:
            continue
        if len(txt) > 60000:
            txt = txt[:60000] + "\n\n…(truncated)"
        notes.append({
            "title": p.stem.replace("-", " ").replace("_", " ").title(),
            "body": txt,
            "path": str(p.relative_to(VAULT)),
        })
    return notes


# ---------------------------------------------------------------- main

def build_topic(topic_dir):
    topic_id = slug(topic_dir.name)
    name = topic_dir.name.replace("-", " ").replace("_", " ").strip().title()

    cards = []
    fc_dir = topic_dir / "flashcards"
    fc_files = list(fc_dir.glob("*.md")) if fc_dir.is_dir() else []
    for fc in sorted(fc_files):
        try:
            cards += parse_flashcards(read_text(fc), source=fc.stem)
        except Exception as e:
            warn(f"flashcard parse failed {fc}: {e}")

    notes = collect_notes(topic_dir)
    docs = collect_docs(topic_dir, topic_id)
    assets = collect_assets(topic_dir, topic_id)

    # description from MISSION.md goal line
    description = ""
    mission = topic_dir / "MISSION.md"
    if mission.exists():
        mt = read_text(mission)
        gm = re.search(r"\*\*Goal:\*\*\s*(.+)", mt)
        if gm:
            description = gm.group(1).strip()
        else:
            for ln in mt.splitlines():
                if ln.strip() and not ln.startswith("#"):
                    description = ln.strip()
                    break
    if not description:
        description = f"{len(cards)} cards · {len(notes)} notes"

    # mindmap
    mm = None
    for cand in ("mindmap.md", "MINDMAP.md", "map.md"):
        p = topic_dir / cand
        if p.exists():
            mm = parse_mindmap(read_text(p))
            break
    if mm is None:
        mm = auto_mindmap(name, cards)

    blob = " ".join([c["q"] for c in cards[:20]]) + " " + description
    subject, badge = detect_subject(str(topic_dir), blob)

    try:
        mtime = max([topic_dir.stat().st_mtime] + [p.stat().st_mtime for p in topic_dir.rglob("*") if p.is_file()])
    except (OSError, ValueError):
        mtime = topic_dir.stat().st_mtime

    return {
        "id": topic_id,
        "name": name,
        "subject": subject,
        "badge": badge,
        "description": description,
        "flashcards": cards,
        "notes": notes,
        "docs": docs,
        "assets": assets,
        "mindmap": mm,
        "updated": datetime.fromtimestamp(mtime, timezone.utc).strftime("%Y-%m-%d"),
    }


def main():
    topics = []
    teaching = VAULT / "Teaching"
    if not teaching.is_dir():
        warn(f"no Teaching folder at {teaching}")
    else:
        for topic_dir in sorted(teaching.iterdir()):
            if not topic_dir.is_dir() or topic_dir.name.startswith("."):
                continue
            try:
                t = build_topic(topic_dir)
                if t["flashcards"] or t["notes"] or t["docs"] or t["assets"]:
                    topics.append(t)
                else:
                    warn(f"topic '{topic_dir.name}' has no usable content, skipped")
            except Exception:
                warn(f"topic build failed: {topic_dir.name}\n{traceback.format_exc()}")

    # Book index -> library shelf (read-only reference)
    library = []
    index_file = VAULT / "Study" / "Books" / "INDEX.md"
    if index_file.exists():
        for ln in read_text(index_file).splitlines():
            m = re.match(r"^\s*[-*]\s+\*\*(.+?)\*\*\s*[—\-–:]\s*(.+)$", ln)
            if m:
                library.append({"title": m.group(1).strip(), "detail": m.group(2).strip()})

    data = {
        "schema": 2,
        "topics": topics,
        "library": library,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "warnings": WARNINGS,
        "counts": {
            "topics": len(topics),
            "cards": sum(len(t["flashcards"]) for t in topics),
            "notes": sum(len(t["notes"]) for t in topics),
            "assets": sum(len(t["assets"]) for t in topics),
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False)
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT.parent / "vault-data.js").write_text(
        "window.VAULT_DATA = " + payload + ";\n", encoding="utf-8"
    )
    c = data["counts"]
    print(f"✓ {c['topics']} topics · {c['cards']} cards · {c['notes']} notes · {c['assets']} assets"
          + (f" · {len(WARNINGS)} warnings" if WARNINGS else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
