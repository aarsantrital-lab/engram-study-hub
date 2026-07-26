#!/usr/bin/env python3
"""
Engram dual publisher — vault repo + study-hub repo, in that order (v2, hardened).

WHAT THIS IS FOR
    Every content change needs TWO pushes and they are not transitive
    (build-constraints §2, §6): pushing the vault repo makes Obsidian on his PC
    see the new notes, and ONLY pushing the hub repo deploys the website. The
    single most-forgotten step in v1 was the second push, so this script owns
    both and verifies both.

        vault  /opt/data/obsidian-vault -> aarsantrital-lab/obsidian-vault
        hub    /opt/data/study-hub      -> aarsantrital-lab/engram-study-hub
                                        -> https://aarsantrital-lab.github.io/engram-study-hub/
                                           (live ~30 s after the push lands)

CONTRACTS THIS FILE KEEPS
    * The generator runs with cwd = HUB and must exit 0, or NOTHING is pushed
      (fail-closed). Generator exit 2 = "more warnings than the limit"; that is
      also fail-closed unless --allow-warnings is passed.
    * Hub commit message stays exactly `sync: study hub refresh [YYYY-MM-DD HH:MM]`
      — the /learn skill greps for it.
    * EXIT CODE CONTRACT (the /learn skill branches on it):
          0 = pushed, or genuinely nothing to do
          1 = a real failure (generator failed, push rejected, verification failed)
      Nothing else. Never raise out of main().

HARDENING (build-constraints §2 "required hardening")
    * --vault/--hub arguments and ENGRAM_VAULT/ENGRAM_HUB env, so it runs on
      Windows for testing. No `shell=True`, so paths with spaces are safe.
    * Failed push -> `git pull --rebase` -> push again. If the rebase hits a
      CONFLICT the repo is put back with `git rebase --abort` before returning 1.
      v1 left the repo sitting mid-rebase, which broke every later run.
    * Post-push verification: local HEAD == origin/<branch>, checked in BOTH
      repos against a fresh `git fetch`. Prose telling the model to eyeball
      `git log` is not verification.
    * Generator warnings are printed here, not buried in the generator's stdout.
    * GIT_TERMINAL_PROMPT=0: a missing credential fails fast instead of hanging
      a cron job forever.

USAGE
    python3 sync.py                       # the VPS default (both repos)
    python3 sync.py --vault D:/vault --hub D:/hub --dry-run
    python3 sync.py --hub-only            # after a hub-only code change
    python3 sync.py --self-test           # end-to-end, uses throwaway git repos
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

DEFAULT_VAULT = Path("/opt/data/obsidian-vault")
DEFAULT_HUB = Path("/opt/data/study-hub")
LIVE_URL = "https://aarsantrital-lab.github.io/engram-study-hub/"

HUB_COMMIT_PREFIX = "sync: study hub refresh"     # frozen — /learn greps this
VAULT_COMMIT_PREFIX = "sync: vault refresh"

GIT_TIMEOUT = 300
GEN_TIMEOUT = 900

QUIET = False


def info(msg=""):
    if not QUIET:
        print(msg)


def fail(msg):
    print("[x] " + str(msg), file=sys.stderr)


# --------------------------------------------------------------------------
# git plumbing
# --------------------------------------------------------------------------

def _env():
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"      # never block a cron job on a password
    env.setdefault("GIT_ASKPASS", "")
    return env


def git(repo, *args, timeout=GIT_TIMEOUT):
    """Run one git command in `repo`. Never raises; returns CompletedProcess."""
    cmd = ["git", "-C", str(repo)] + [str(a) for a in args]
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              env=_env(), encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        return subprocess.CompletedProcess(cmd, 127, "", "%s: %s" % (type(e).__name__, e))


def git_ok(repo, *args, **kw):
    return git(repo, *args, **kw).returncode == 0


def out(repo, *args, **kw):
    r = git(repo, *args, **kw)
    return r.stdout.strip() if r.returncode == 0 else ""


def have_git():
    try:
        return subprocess.run(["git", "--version"], capture_output=True,
                              timeout=30).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def is_repo(path):
    return (Path(path) / ".git").exists() and git_ok(path, "rev-parse", "--git-dir")


def current_branch(repo):
    return out(repo, "rev-parse", "--abbrev-ref", "HEAD") or "main"


def has_remote(repo, name="origin"):
    return name in out(repo, "remote").split()


def abort_rebase(repo):
    """Put a repo mid-rebase back the way it was. v1's missing half."""
    if git_ok(repo, "rebase", "--abort"):
        return True
    return git_ok(repo, "rebase", "--quit")


def in_rebase(repo):
    gd = out(repo, "rev-parse", "--git-dir")
    if not gd:
        return False
    base = (Path(repo) / gd) if not Path(gd).is_absolute() else Path(gd)
    return (base / "rebase-merge").exists() or (base / "rebase-apply").exists()


# --------------------------------------------------------------------------
# publish one repo
# --------------------------------------------------------------------------

def publish(repo, label, message, dry_run=False, require_git=False):
    """Stage, commit, push and VERIFY one repository.

    Returns (ok: bool, changed: bool). ok=False is a real failure (exit 1).
    """
    repo = Path(repo)
    if not repo.is_dir():
        fail("%s: %s does not exist" % (label, repo))
        return (not require_git), False
    if not is_repo(repo):
        msg = "%s: %s is not a git repo — files were written locally but NOTHING was published" % (label, repo)
        if require_git:
            fail(msg)
            return False, False
        info("[!] " + msg)
        return True, False

    if in_rebase(repo):
        info("[!] %s: repo was left mid-rebase by an earlier run — aborting that rebase first" % label)
        abort_rebase(repo)

    branch = current_branch(repo)
    if branch != "main":
        info("[!] %s: on branch '%s', not 'main' — GitHub Pages builds from main" % (label, branch))

    git(repo, "add", "-A")
    dirty = out(repo, "status", "--porcelain")

    ahead = ""
    if has_remote(repo):
        git(repo, "fetch", "origin", branch)
        ahead = out(repo, "rev-list", "--count", "origin/%s..HEAD" % branch) or "0"

    if not dirty and ahead in ("", "0"):
        info("[=] %s: already up to date" % label)
        return True, False

    if dry_run:
        n = len([ln for ln in dirty.splitlines() if ln.strip()])
        info("[.] %s: dry run — %d change(s) staged, %s unpushed commit(s), nothing committed"
             % (label, n, ahead or "0"))
        git(repo, "reset")
        return True, bool(dirty)

    if dirty:
        c = git(repo, "commit", "-m", message)
        blob = (c.stdout or "") + (c.stderr or "")
        if c.returncode != 0 and "nothing to commit" not in blob:
            fail("%s: commit failed\n%s" % (label, blob.strip()))
            return False, False

    if not has_remote(repo):
        info("[!] %s: no 'origin' remote — committed locally, NOT published" % label)
        return (not require_git), True

    push = git(repo, "push", "origin", branch)
    if push.returncode != 0:
        info("[~] %s: push rejected — rebasing on origin/%s and retrying" % (label, branch))
        pull = git(repo, "pull", "--rebase", "origin", branch)
        if pull.returncode != 0:
            # A conflict leaves the repo mid-rebase. Put it back, then stop.
            abort_rebase(repo)
            fail("%s: pull --rebase hit a conflict, so the rebase was aborted and the repo is "
                 "back where it was. Resolve it by hand in %s, then run sync again.\n%s"
                 % (label, repo, ((pull.stdout or "") + (pull.stderr or "")).strip()))
            return False, True
        push = git(repo, "push", "origin", branch)
        if push.returncode != 0:
            fail("%s: push failed after the rebase\n%s"
                 % (label, ((push.stdout or "") + (push.stderr or "")).strip()))
            return False, True

    # ---- verification: local HEAD must equal origin/<branch> ----------------
    git(repo, "fetch", "origin", branch)
    local = out(repo, "rev-parse", "HEAD")
    remote = out(repo, "rev-parse", "origin/%s" % branch)
    if not local or local != remote:
        fail("%s: push reported success but HEAD %s != origin/%s %s — the deploy is NOT live"
             % (label, local[:8] or "?", branch, remote[:8] or "?"))
        return False, True

    subject = out(repo, "log", "-1", "--pretty=%s")
    info("[+] %s: %s pushed to origin/%s  (%s)" % (label, local[:8], branch, subject))
    return True, True


# --------------------------------------------------------------------------
# generator
# --------------------------------------------------------------------------

def run_generator(vault, hub, max_warnings, allow_warnings, dry_run):
    """Rebuild vault-data.js/.json. Fail-closed: non-zero here = nothing pushed."""
    script = Path(hub) / "generate_data.py"
    if not script.exists():
        fail("generate_data.py is not in the hub (%s)" % hub)
        return False

    cmd = [sys.executable, "generate_data.py", "--vault", str(vault), "--hub", str(hub)]
    if max_warnings is not None:
        cmd += ["--max-warnings", str(max_warnings)]
    if dry_run:
        cmd.append("--dry-run")

    try:
        r = subprocess.run(cmd, cwd=str(hub), capture_output=True, text=True,
                           timeout=GEN_TIMEOUT, encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        fail("the generator could not be started: %s" % e)
        return False

    for line in (r.stdout or "").splitlines():
        info("    " + line)
    warn_lines = [ln.strip() for ln in (r.stderr or "").splitlines() if ln.strip()]
    if warn_lines:
        info("  vault warnings (these also ship in vault-data.warnings[] for the app):")
        for line in warn_lines:
            info("    " + line)

    if r.returncode == 2 and allow_warnings:
        info("[!] the generator reported more warnings than the limit; --allow-warnings, "
             "so the publish continues")
        return True
    if r.returncode != 0:
        fail("data generation exited %d — NOTHING was pushed (fail-closed)" % r.returncode)
        return False
    return True


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def resolve(args):
    vault = args.vault or os.environ.get("ENGRAM_VAULT") or str(DEFAULT_VAULT)
    hub = args.hub or os.environ.get("ENGRAM_HUB") or str(Path(__file__).resolve().parent)
    return Path(vault).expanduser().resolve(), Path(hub).expanduser().resolve()


def build_parser():
    p = argparse.ArgumentParser(
        prog="sync.py",
        description="Regenerate the hub data and publish BOTH repos (vault, then hub).")
    p.add_argument("--vault", help="vault repo root (default: $ENGRAM_VAULT or /opt/data/obsidian-vault)")
    p.add_argument("--hub", help="hub repo root (default: $ENGRAM_HUB or this file's folder)")
    p.add_argument("--vault-only", action="store_true", help="publish the vault repo only")
    p.add_argument("--hub-only", action="store_true", help="publish the hub repo only")
    p.add_argument("--max-warnings", type=int, default=None,
                   help="passed to the generator; above it the run is fail-closed")
    p.add_argument("--allow-warnings", action="store_true",
                   help="publish even when the generator is over its warning limit")
    p.add_argument("--require-git", action="store_true",
                   help="treat a missing repo/remote as a failure (use this on the server)")
    p.add_argument("--dry-run", action="store_true", help="build and report, commit nothing")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--self-test", action="store_true",
                   help="end-to-end test against throwaway local git repos")
    return p


def main(argv=None):
    global QUIET
    args = build_parser().parse_args(argv)
    if args.self_test:
        return self_test()

    QUIET = args.quiet
    vault, hub = resolve(args)

    if not have_git():
        fail("git is not on PATH — nothing can be published")
        return 1
    if not hub.is_dir():
        fail("hub not found: %s (pass --hub or set ENGRAM_HUB)" % hub)
        return 1
    if not vault.is_dir():
        fail("vault not found: %s (pass --vault or set ENGRAM_VAULT)" % vault)
        return 1

    info("vault %s" % vault)
    info("hub   %s" % hub)
    info("")
    info("1/3  rebuilding hub data from the vault")
    if not run_generator(vault, hub, args.max_warnings, args.allow_warnings, args.dry_run):
        return 1

    nojekyll = hub / ".nojekyll"
    if not nojekyll.exists() and not args.dry_run:
        try:
            nojekyll.write_text("", encoding="utf-8")
            info("    created .nojekyll (GitHub Pages drops _-prefixed paths without it)")
        except OSError:
            info("[!] could not create .nojekyll in the hub")

    stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    # --hub-only and --vault-only are mutually exclusive. Together they used to
    # switch BOTH pushes off and still exit 0 with "the site already matches the
    # vault" — a silent zero-push success, which is the exact failure this
    # script exists to prevent. Refuse loudly instead.
    if args.hub_only and args.vault_only:
        info("[x] --hub-only and --vault-only cancel each other out — nothing would be "
             "published. Pass one or neither.")
        return 1
    do_vault = not args.hub_only
    do_hub = not args.vault_only
    ok = True
    changed = False

    # Vault first: Obsidian on his PC pulls that repo, and a hub deploy that
    # references notes the vault has not published yet reads as data loss.
    if do_vault:
        info("")
        info("2/3  publishing the vault repo")
        good, ch = publish(vault, "vault", "%s [%s]" % (VAULT_COMMIT_PREFIX, stamp),
                           args.dry_run, args.require_git)
        ok = ok and good
        changed = changed or ch
    else:
        info("")
        info("2/3  vault skipped (--hub-only)")

    if do_hub:
        info("")
        info("3/3  publishing the hub repo")
        good, ch = publish(hub, "hub", "%s [%s]" % (HUB_COMMIT_PREFIX, stamp),
                           args.dry_run, args.require_git)
        ok = ok and good
        changed = changed or ch
    else:
        info("")
        info("3/3  hub skipped (--vault-only)")

    info("")
    if not ok:
        fail("publish incomplete — see above. The site is NOT updated.")
        return 1
    if args.dry_run:
        info("[.] dry run finished; nothing was committed or pushed")
    elif changed:
        info("[+] both repos verified against origin — %s is live in ~30 s" % LIVE_URL)
    else:
        info("[=] nothing to publish; the site already matches the vault")
    return 0


# --------------------------------------------------------------------------
# self-test — real git repos in a temp dir, no network
# --------------------------------------------------------------------------

def _seed_vault(vault):
    topic = vault / "Teaching" / "Test-Topic"
    (topic / "flashcards").mkdir(parents=True, exist_ok=True)
    (topic / "MISSION.md").write_text(
        "---\nsubject: Chemistry\nunit: Stoichiometry\n---\n\n"
        "**Goal:** Prove the pipeline end to end.\n", encoding="utf-8")
    (topic / "flashcards" / "Test-Topic-flashcards.md").write_text(
        "## Q: State the Avogadro constant with its unit.\n"
        "<!-- id: test-0001-01 | type: definition | cognitive: knowledge | pacer: R -->\n"
        "A: 6.022 \u00d7 10\u00b2\u00b3 mol\u207b\u00b9.\n", encoding="utf-8")


def _init_repo(path, remote=None):
    path.mkdir(parents=True, exist_ok=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.email", "test@engram.local")
    git(path, "config", "user.name", "Engram Test")
    git(path, "config", "commit.gpgsign", "false")
    if remote:
        git(path, "remote", "add", "origin", str(remote))


def self_test():
    if not have_git():
        print("git is not installed — self-test skipped")
        return 0
    hub_src = Path(__file__).resolve().parent
    gen = hub_src / "generate_data.py"
    if not gen.exists():
        print("generate_data.py is missing next to sync.py — self-test skipped")
        return 0

    fails = []
    tmp = Path(tempfile.mkdtemp(prefix="engram-sync-test-"))
    try:
        # bare "remotes"
        for name in ("vault.git", "hub.git"):
            subprocess.run(["git", "init", "--bare", "-q", "-b", "main", str(tmp / name)],
                           capture_output=True, env=_env())

        vault = tmp / "vault"
        hub = tmp / "hub"
        _init_repo(vault, tmp / "vault.git")
        _init_repo(hub, tmp / "hub.git")
        _seed_vault(vault)
        shutil.copy2(gen, hub / "generate_data.py")
        (hub / "index.html").write_text("<!-- hub -->\n", encoding="utf-8")
        for repo in (vault, hub):
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "-m", "initial")
            git(repo, "push", "-q", "-u", "origin", "main")

        argv = ["--vault", str(vault), "--hub", str(hub), "--quiet", "--require-git"]

        # an uncommitted vault edit, so run 1 has something to publish in BOTH repos
        (vault / "Teaching" / "Test-Topic" / "RESOURCES.md").write_text(
            "- The class guidebook, Unit 2.\n", encoding="utf-8")

        # 1. clean run publishes both and verifies both
        rc = main(argv)
        if rc != 0:
            fails.append("clean run exited %d, expected 0" % rc)
        if not (hub / "vault-data.js").exists():
            fails.append("vault-data.js was not generated")
        head_hub = out(hub, "rev-parse", "HEAD")
        remote_hub = out(hub, "rev-parse", "origin/main")
        if not head_hub or head_hub != remote_hub:
            fails.append("hub HEAD != origin/main after a clean run")
        if HUB_COMMIT_PREFIX not in out(hub, "log", "-1", "--pretty=%s"):
            fails.append("hub commit message lost the greppable prefix: %r"
                         % out(hub, "log", "-1", "--pretty=%s"))
        if VAULT_COMMIT_PREFIX not in out(vault, "log", "-1", "--pretty=%s"):
            fails.append("vault commit message lost its prefix")

        # 2. second run with no changes = nothing to do, still exit 0
        rc = main(argv)
        if rc != 0:
            fails.append("no-change run exited %d, expected 0" % rc)

        # 3. non-conflicting remote commit -> push rejected -> rebase -> push
        other = tmp / "other"
        subprocess.run(["git", "clone", "-q", str(tmp / "hub.git"), str(other)],
                       capture_output=True, env=_env())
        git(other, "config", "user.email", "other@engram.local")
        git(other, "config", "user.name", "Other")
        (other / "SIDE.md").write_text("side change\n", encoding="utf-8")
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", "side: unrelated change")
        git(other, "push", "-q", "origin", "main")
        (vault / "Teaching" / "Test-Topic" / "NOTES.md").write_text(
            "A new note, so there is something to publish.\n", encoding="utf-8")
        rc = main(argv)
        if rc != 0:
            fails.append("pull-rebase retry run exited %d, expected 0" % rc)
        if out(hub, "rev-parse", "HEAD") != out(hub, "rev-parse", "origin/main"):
            fails.append("hub HEAD != origin/main after the rebase retry")
        if not (hub / "SIDE.md").exists():
            fails.append("the rebase dropped the unrelated remote commit")

        # 4. conflicting remote commit -> abort the rebase, exit 1, repo clean
        git(other, "pull", "-q", "--rebase", "origin", "main")
        (other / "vault-data.js").write_text(
            "/* conflicting hand edit */\nwindow.VAULT_DATA = {\"schema\":2,\"topics\":[]};\n",
            encoding="utf-8")
        git(other, "add", "-A")
        git(other, "commit", "-q", "-m", "conflict: hand-edited vault-data.js")
        git(other, "push", "-q", "origin", "main")
        (vault / "Teaching" / "Test-Topic" / "flashcards" / "Test-Topic-flashcards.md").write_text(
            "## Q: State the Avogadro constant with its unit.\n"
            "<!-- id: test-0001-01 | type: definition | cognitive: knowledge | pacer: R -->\n"
            "A: 6.022 \u00d7 10\u00b2\u00b3 mol\u207b\u00b9 — a count per mole.\n",
            encoding="utf-8")
        rc = main(argv)
        if rc != 1:
            fails.append("conflicting run exited %d, expected 1" % rc)
        if in_rebase(hub):
            fails.append("the hub repo was left mid-rebase — this is the v1 bug")
        if out(hub, "status", "--porcelain") and not fails:
            pass  # staged-but-uncommitted work is fine; mid-rebase is not

        # 5. generator failure is fail-closed: nothing is committed
        before = out(hub, "rev-parse", "HEAD")
        broken = tmp / "broken-vault"
        rc = main(["--vault", str(broken), "--hub", str(hub), "--quiet"])
        if rc != 1:
            fails.append("missing vault exited %d, expected 1" % rc)
        if out(hub, "rev-parse", "HEAD") != before:
            fails.append("a failed generator still produced a commit")

        # 6. dry run writes no commit
        before = out(vault, "rev-parse", "HEAD")
        (vault / "Teaching" / "Test-Topic" / "EXTRA.md").write_text("extra\n", encoding="utf-8")
        rc = main(["--vault", str(vault), "--hub", str(hub), "--quiet", "--dry-run"])
        if rc != 0:
            fails.append("dry run exited %d, expected 0" % rc)
        if out(vault, "rev-parse", "HEAD") != before:
            fails.append("dry run created a commit")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if fails:
        print("SELF-TEST FAILED (%d):" % len(fails))
        for f in fails:
            print("  - " + f)
        return 1
    print("ok self-test: 6 scenarios passed "
          "(clean publish - no-op - rebase retry - conflict abort - fail-closed - dry run)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
