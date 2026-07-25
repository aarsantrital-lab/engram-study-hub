#!/usr/bin/env python3
"""
Study Hub Syncer (v2)
Regenerate data from the Obsidian vault, commit, push to GitHub Pages.
Called by the /learn skill after every flashcard/note/media update.

Robust: never hard-fails the caller. Returns 0 on success or "nothing to do",
1 only when the push genuinely failed (so /learn can report it).
"""
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HUB = Path("/opt/data/study-hub")
LIVE = "https://aarsantrital-lab.github.io/engram-study-hub/"


def run(cmd, check=True):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=HUB, timeout=180)
    if check and r.returncode != 0:
        print(f"✗ {cmd}\n{r.stderr.strip()}", file=sys.stderr)
    return r


def main():
    # 1. rebuild vault-data.json / .js and copy assets
    gen = run("python3 generate_data.py")
    print(gen.stdout.strip() or gen.stderr.strip())
    if gen.returncode != 0:
        print("✗ data generation failed — nothing pushed", file=sys.stderr)
        return 1

    # 2. only proceed if this is actually a git repo
    if not (HUB / ".git").exists():
        print("• no git repo — data rebuilt locally only")
        return 0

    run("git add -A", check=False)
    status = run("git status --porcelain", check=False).stdout.strip()
    if not status:
        print("✓ already up to date")
        return 0

    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    c = run(f'git commit -m "sync: study hub refresh [{ts}]"', check=False)
    if c.returncode != 0 and "nothing to commit" not in (c.stdout + c.stderr):
        print(f"✗ commit failed: {c.stderr.strip()}", file=sys.stderr)
        return 1

    p = run("git push", check=False)
    if p.returncode != 0:
        # try once after rebasing on remote
        run("git pull --rebase", check=False)
        p = run("git push", check=False)
    if p.returncode != 0:
        print(f"✗ push failed: {p.stderr.strip()}", file=sys.stderr)
        return 1

    print(f"✓ pushed → {LIVE} (live in ~30s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
