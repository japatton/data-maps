"""Publish docs/wiki/ into a wiki repository.

A wiki is a separate git repository at <project>.wiki.git, on both Forgejo
and GitLab.  The pages are authored here so they are reviewed like any
other source and travel with a clone; this pushes them there.

    python3 tools/wiki.py --remote <url> --check    say what would change
    python3 tools/wiki.py --remote <url>            do it

The remote is always a parameter.  Each deployment's wiki is a
different repository and those URLs do not belong in this
repository, so a hard-coded default would publish to the wrong place the
first time anyone ran it from the wrong clone.

Forgejo renders the sidebar from `_Sidebar.md` and GitLab from
`_sidebar.md`, so the one source file is renamed on the way out; shipping
both names would leave a junk page on each host.  Verified against the
live Forgejo wiki: the sidebar lands in the right-hand rail, below the
Table of Contents Forgejo builds from the page's own headings.

Local only, like tools/studio_dev.py and tools/screenshots.py.  A wiki
push from CI would need a token with write access to a second repository,
and this content changes rarely enough not to be worth the credential.
"""
import argparse
import filecmp
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "docs", "wiki")

SIDEBAR_NAMES = {"forgejo": "_Sidebar.md", "gitlab": "_sidebar.md"}

# A wiki page cannot reach ../README.md: the wiki is a different
# repository.  An absolute URL can, but it differs per host and there is
# one source for two hosts, so pages write this token and it is replaced
# on the way out.
REPO_TOKEN = "{{REPO}}"


def substitute(text, repo_url):
    """`text` with every REPO_TOKEN replaced by `repo_url`.

    The base is stripped of a trailing slash so a page can write
    {{REPO}}/README.md without the caller having to care which form the
    url was given in.
    """
    return text.replace(REPO_TOKEN, repo_url.rstrip("/"))


def target_name(name, flavor):
    """The filename `name` takes on the target host."""
    if name == "_Sidebar.md":
        return SIDEBAR_NAMES.get(flavor, "_Sidebar.md")
    return name


def publishable(root):
    """Every file a wiki should carry, by name, sorted.

    Flat: wiki repositories have no directory convention the two hosts
    share, so a page in a subdirectory would resolve on neither.
    Dot-files are skipped to avoid publishing editor swaps, .DS_Store,
    and other junk.
    """
    out = []
    for name in sorted(os.listdir(root)):
        if name.startswith("."):
            continue
        if os.path.isfile(os.path.join(root, name)):
            out.append(name)
    return out


def plan_sync(source_dir, wiki_dir):
    """(adds, updates, deletes) between the source and a checked-out wiki.

    `.git` and dot-files are skipped rather than deleted, which is the
    difference between publishing a wiki and destroying one.

    Note: the `and not n.startswith(".")` guard in the deletes filter is
    currently unreachable because publishable() already skips dot-files.
    It is kept because removing that skip is a correctness mistake already
    made once in this file; this guard would prevent that error from
    destroying a wiki's manually-added .gitattributes.
    """
    source = publishable(source_dir)
    target = publishable(wiki_dir)
    adds, updates = [], []
    for name in source:
        if name not in target:
            adds.append(name)
        elif not filecmp.cmp(os.path.join(source_dir, name),
                             os.path.join(wiki_dir, name), shallow=False):
            updates.append(name)
    deletes = [n for n in target if n not in source and not n.startswith(".")]
    return sorted(adds), sorted(updates), sorted(deletes)


def git(args, cwd):
    return subprocess.call(["git"] + args, cwd=cwd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--remote", required=True,
                        help="the wiki repository, e.g. "
                             "ssh://git@host:2222/owner/repo.wiki.git")
    parser.add_argument("--flavor", choices=sorted(SIDEBAR_NAMES),
                        default="forgejo",
                        help="which host, for the sidebar filename")
    parser.add_argument("--repo-url", required=True,
                        help="base URL of the CODE repository, which "
                             "{{REPO}} in a page becomes, e.g. "
                             "https://host/owner/repo/src/branch/main")
    parser.add_argument("--check", action="store_true",
                        help="report what would change; write nothing")
    parser.add_argument("--source", default=SOURCE)
    args = parser.parse_args(argv)

    if not os.path.isdir(args.source):
        print("FATAL: no such source directory: %s" % args.source)
        return 1

    work = tempfile.mkdtemp(prefix="wiki-")
    staged = tempfile.mkdtemp(prefix="wiki-staged-")
    try:
        # A wiki that has never been written clones as an empty repository
        # with no commits, which is not an error and must not be treated
        # as one.
        if git(["clone", "--quiet", args.remote, work], ROOT) != 0:
            print("FATAL: could not clone %s" % args.remote)
            return 1
        for name in publishable(args.source):
            src = os.path.join(args.source, name)
            dst = os.path.join(staged, target_name(name, args.flavor))
            if name.endswith(".md"):
                with open(src, encoding="utf-8") as fh:
                    text = fh.read()
                with open(dst, "w", encoding="utf-8") as fh:
                    fh.write(substitute(text, args.repo_url))
            else:
                shutil.copyfile(src, dst)
        adds, updates, deletes = plan_sync(staged, work)

        for name in adds:
            print("  add     %s" % name)
        for name in updates:
            print("  update  %s" % name)
        for name in deletes:
            print("  delete  %s" % name)
        if not (adds or updates or deletes):
            print("  wiki is already up to date")
            return 0
        if args.check:
            print("%d change(s); nothing written (--check)"
                  % (len(adds) + len(updates) + len(deletes)))
            return 0

        # Deletes first, and through the index rather than the worktree.
        # _Sidebar.md and _sidebar.md differ only in case, and on a
        # case-insensitive filesystem - macOS, where this runs - they are
        # one file.  Copying the add first would land in the old name's
        # inode and the delete would then remove the page just written,
        # leaving the wiki with no sidebar while the run reported success.
        #
        # `git rm` rather than os.remove because `git add -A` matches the
        # worktree to the index case-insensitively too: after a plain
        # unlink-and-copy it sees the new name as the old entry, unchanged,
        # and commits nothing at all.
        for name in deletes:
            if git(["rm", "-q", "-f", "--", name], work) != 0:
                print("FATAL: could not remove %s" % name)
                return 1
        for name in adds + updates:
            shutil.copyfile(os.path.join(staged, name),
                            os.path.join(work, name))

        head = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT)
        message = "docs: sync wiki from %s" % head.decode("utf-8").strip()
        git(["add", "-A"], work)
        if git(["commit", "--quiet", "-m", message], work) != 0:
            print("FATAL: nothing committed")
            return 1
        if git(["push", "--quiet", "origin", "HEAD"], work) != 0:
            print("FATAL: push rejected")
            return 1
        print("%d change(s) pushed to %s"
              % (len(adds) + len(updates) + len(deletes), args.remote))
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(staged, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
