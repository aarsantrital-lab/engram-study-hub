#!/usr/bin/env python3
"""
Study Hub Syncer
One command: regenerate data from Obsidian vault, commit, push to GitHub Pages.
Called by the /learn skill after every flashcard update.
"""
import subprocess, sys
from pathlib import Path

HUB = Path("/opt/data/study-hub")

def run(cmd, cwd=None):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd)
    if result.returncode != 0:
        print(f"FAIL: {cmd}\n{result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()

def main():
    # 1. Rebuild vault-data.json + vault-data.js from Obsidian Teaching/ folder
    run("python3 generate_data.py", cwd=HUB)
    print("✓ Data rebuilt")

    # 2. Stage changes
    run("git add -A", cwd=HUB)

    # 3. Check if there's anything to commit
    status = run("git status --porcelain", cwd=HUB)
    if not status:
        print("✓ Nothing new to push — already up to date")
        return

    # 4. Commit
    from datetime import datetime
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    run(f'git commit -m "sync: study hub refresh [{ts}]"', cwd=HUB)
    print("✓ Committed")

    # 5. Push → GitHub Pages auto-deploys
    run("git push", cwd=HUB)
    print("✓ Pushed → https://aarsantrital-lab.github.io/engram-study-hub/ (live in ~30s)")

if __name__ == "__main__":
    main()
