"""Regenerate the screenshots the README embeds.

The README's pictures are of the real built site, not mockups, so they go
stale the moment the site's layout moves.  This puts them back:

    python3 tools/screenshots.py           retake every shot
    python3 tools/screenshots.py --check   report missing ones, change nothing

Needs a built site (`python3 -m datamaps.build`) and Google Chrome.  Local
only, like tools/studio_dev.py - CI has neither a browser nor a display, and
the images are committed rather than built.

Chrome writes the image and then routinely does not exit, so every attempt
runs to its deadline and is killed; that is the normal path here, not a
fault.  Separately, Studio is a single-page app that fetches its documents
before it paints, so a screenshot can catch it mid-boot showing "Loading...".  Chrome's
--virtual-time-budget advances virtual time while those fetches take real
time, which makes the race unavoidable rather than merely unlikely.  A
half-painted capture is tiny compared with a real one, so those shots are
retried until the file exceeds a floor known to be larger than the loading
screen and smaller than any real render.
"""
import argparse
import os
import shutil
import socket
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "images")
# Flat, NOT docs/wiki/images/: publishable() in tools/wiki.py lists only
# top-level files, because wiki hosts share no subdirectory convention.
# A screenshot in a subdirectory is never published.
WIKI_OUT = os.path.join(ROOT, "docs", "wiki")
PUBLIC = os.path.join(ROOT, "public")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# name, page (relative to the built site), width, height, min bytes, output dir
# min bytes 0 means "a static page, one attempt is enough"
SHOTS = [
    ("catalog", "index.html", 1400, 900, 0, OUT),
    ("technology-page", "tech/paloalto-ngfw.html", 1400, 1000, 0, OUT),
    ("ecs-index", "ecs-index.html", 1400, 900, 0, OUT),
    ("studio-editor", "studio/index.html#/tech/paloalto-ngfw", 1500, 950, 60000, OUT),
    ("studio-picker", "studio/index.html#/", 1400, 900, 60000, WIKI_OUT),
    ("studio-review", "studio/index.html#/tech/paloalto-ngfw/review", 1400, 950, 60000, WIKI_OUT),
]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# Headless Chrome hangs often enough here that a run without a deadline is a
# run that can never finish: it holds the shot open, the caller waits on it,
# and nothing says why.  Each attempt gets its own deadline and is killed at
# it; the retry loop then treats the dead attempt as any other short one.
SHOT_TIMEOUT = 75


def shoot(url, path, width, height, profile):
    if os.path.exists(path):
        os.remove(path)
    proc = subprocess.Popen([
        CHROME, "--headless", "--disable-gpu", "--no-sandbox",
        "--hide-scrollbars", "--virtual-time-budget=20000",
        "--window-size=%d,%d" % (width, height),
        "--user-data-dir=" + profile, "--screenshot=" + path, url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        proc.communicate(timeout=SHOT_TIMEOUT)
    except subprocess.TimeoutExpired:
        # Chrome writes the PNG and then routinely does not exit, so reaching
        # the deadline is the ordinary end of a shot rather than a failure.
        # Only an attempt that produced no file is worth saying anything about.
        proc.kill()
        proc.communicate()
        if not os.path.exists(path):
            say("    (chrome produced nothing inside %ds)" % SHOT_TIMEOUT)
    return os.path.getsize(path) if os.path.exists(path) else 0


def say(line):
    print(line)
    sys.stdout.flush()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true",
                        help="report missing or empty images; change nothing")
    args = parser.parse_args(argv)

    if args.check:
        missing = []
        for n, _, _, _, _, out_dir in SHOTS:
            path = os.path.join(out_dir, n + ".png")
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                missing.append((n, out_dir))
        for n, out_dir in missing:
            print("missing or empty: %s/%s.png"
                  % (os.path.relpath(out_dir, ROOT), n))
        print("%d of %d screenshot(s) missing" % (len(missing), len(SHOTS)))
        return 1 if missing else 0

    if not os.path.isdir(PUBLIC):
        print("FATAL: no built site - run python3 -m datamaps.build first")
        return 1
    if not os.path.exists(CHROME):
        print("FATAL: Chrome not found at %s" % CHROME)
        return 1
    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    if not os.path.isdir(WIKI_OUT):
        os.makedirs(WIKI_OUT)

    # Studio needs http: it fetches its documents, and a file:// origin gets
    # neither the requests nor a legible reason for their absence.
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "tools", "studio_dev.py"),
         "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    failed = []
    try:
        for name, page, width, height, floor, out_dir in SHOTS:
            path = os.path.join(out_dir, name + ".png")
            url = ("http://127.0.0.1:%d/%s" % (port, page) if floor
                   else "file://" + os.path.join(PUBLIC, page))
            profile = os.path.join("/tmp", "cr-shot-" + name)
            size = 0
            for attempt in range(1, 5):
                shutil.rmtree(profile, ignore_errors=True)
                size = shoot(url, path, width, height, profile)
                if size > floor:
                    break
                say("  %s: attempt %d produced %d bytes, retrying"
                      % (name, attempt, size))
            shutil.rmtree(profile, ignore_errors=True)
            if size > floor:
                say("  %-16s %6d bytes  %dx%d" % (name, size, width, height))
            else:
                failed.append(name)
                say("  %-16s FAILED after 4 attempts" % name)
    finally:
        server.terminate()
        server.wait()
    print("%d of %d screenshot(s) written"
          % (len(SHOTS) - len(failed), len(SHOTS)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
