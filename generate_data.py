#!/usr/bin/env python3
"""
Study Hub Data Generator
Reads Obsidian vault flashcards + INDEX.md → generates vault-data.json
Run this after adding new flashcards or topics to refresh the Study Hub.
"""

import json
import re
import os
from datetime import datetime, timedelta
from pathlib import Path

VAULT = Path("/opt/data/obsidian-vault")
OUT = Path("/opt/data/study-hub/vault-data.json")

def parse_flashcards(filepath):
    """Parse markdown flashcards in format:
    ## Q: question
    A: answer
    """
    cards = []
    text = filepath.read_text(encoding='utf-8')
    # Split on ## Q: headers
    chunks = re.split(r'^## Q: ', text, flags=re.MULTILINE)
    for chunk in chunks[1:]:  # skip header
        lines = chunk.strip().split('\n')
        q = lines[0].strip()
        # Find A: line
        a = ""
        for i, line in enumerate(lines[1:], 1):
            if line.startswith('A: '):
                a = line[3:].strip()
                # Collect continuation lines
                j = i + 1
                while j < len(lines) and not lines[j].startswith('## Q: ') and lines[j].strip():
                    a += " " + lines[j].strip()
                    j += 1
                break
        if q and a:
            cards.append({
                "q": q,
                "a": a,
                "interval": 7,
                "due": (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
            })
    return cards

def detect_subject(path_str):
    """Guess subject from file path or content."""
    p = path_str.lower()
    if 'chem' in p or 'mole' in p or 'stoichiometry' in p:
        return ('Chemistry', 'chemistry')
    if 'physic' in p:
        return ('Physics', 'physics')
    if 'english' in p:
        return ('English', 'english')
    if 'nepali' in p:
        return ('Nepali', 'nepali')
    if 'computer' in p or 'cs' in p:
        return ('Computer Science', 'cs')
    return ('General', 'cs')

def main():
    topics = []

    # Scan Teaching/ folder for flashcards
    teaching = VAULT / "Teaching"
    if teaching.exists():
        for topic_dir in teaching.iterdir():
            if not topic_dir.is_dir():
                continue
            flashcards_dir = topic_dir / "flashcards"
            if not flashcards_dir.exists():
                continue
            for fc_file in flashcards_dir.glob("*.md"):
                cards = parse_flashcards(fc_file)
                if not cards:
                    continue
                subject, badge = detect_subject(str(fc_file))
                topics.append({
                    "id": topic_dir.name.lower().replace(" ", "-"),
                    "name": topic_dir.name.replace("-", " ").title(),
                    "subject": subject,
                    "badge": badge,
                    "description": f"Flashcards from {fc_file.stem}",
                    "pages": "Teaching notes",
                    "flashcards": cards
                })

    # Also check Study/Books/INDEX.md for topics without flashcards yet
    index_file = VAULT / "Study" / "Books" / "INDEX.md"
    if index_file.exists():
        # Could parse INDEX.md for chapters without flashcards
        # For now, we rely on Teaching/ folder
        pass

    # Write output
    data = {"topics": topics, "generated_at": datetime.now().isoformat()}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
    # Also write JS bake file for file:// usage
    js_out = OUT.parent / "vault-data.js"
    js_out.write_text("window.VAULT_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding='utf-8')
    print(f"Generated {OUT} and {js_out} with {len(topics)} topics")

if __name__ == "__main__":
    main()
