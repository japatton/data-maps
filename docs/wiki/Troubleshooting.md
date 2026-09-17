# Troubleshooting

Each heading is the symptom as you see it.

## Studio says a request was blocked, or never reached the endpoint

Two clients, two wordings, one cause. Analysis says:

> the request never reached &lt;url&gt; (blocked, offline, or no CORS headers)

and a repository call says, with the step that failed in front of it:

> Check access: blocked by the browser (CORS or unreachable)

Either message names several causes at once and cannot tell them apart,
because a browser reports them to JavaScript identically — one `TypeError`
with no detail in it.

Open the browser console. The three read completely differently there:

- `Mixed Content: ... requested an insecure resource 'http://...'` — the
  site is HTTPS and the endpoint is HTTP. The browser refuses before
  sending anything, so there is no CORS error to find. The endpoint needs
  TLS; nothing on this side fixes it.
- `blocked by CORS policy` — the endpoint is reachable but does not permit
  this site. Its owner must return `Access-Control-Allow-Origin` for the
  site's origin, answer `OPTIONS`, and allow the headers Studio sends:
  `Content-Type`, plus `Authorization` — or `api-key` against Azure. Every
  call is preflighted, because `application/json` is not a CORS-safelisted
  content type.
- `ERR_CONNECTION_REFUSED` / `ERR_NAME_NOT_RESOLVED` — nothing is
  listening, or DNS is wrong.

What each endpoint has to do about the first two is in the README's
[Studio section][studio].

For local work, `tools/studio_dev.py` proxies an endpoint that will not
answer CORS — it answers the preflight itself, and the same section has
the command and the setting to point at it. One gap: the proxy allows
`Authorization`, `PRIVATE-TOKEN` and `Content-Type` and nothing else, so
an **Azure** analysis endpoint, which Studio authenticates with an
`api-key` header, still fails preflight behind it.

## Studio could not start

Two different failures wear this heading, and the page tells you which by
what it prints under it.

**A list of documents it could not load.** It failed to fetch the
published snapshot, and it has already told the two cases apart: a request
that got **no answer at all** means the files are being opened directly
rather than served, and a request that **was** answered but not with those
files means the site was never built, or not built where it is being
served from. Either way, build it and serve that copy.

**One error line and no list.** Something else threw during boot. That
line is the whole of what Studio knows, and the browser console carries
the stack behind it.

A page that sits on **Loading…** and never changes is neither. That text
is written by `studio/index.html`, and only the `studio.js` module
replaces it — so anything that stops the module loading leaves it
standing: a 404 on one of its imports after a partial deploy, a syntax
error a browser below the ES2018 floor will not parse, or a request that
nothing ever times out. The console names the file for the first two; the
third shows only as a request still pending in the network tab.

## Review says a file changed, or does not exist on the branch

Both come from **Check upstream**, and they are opposite problems.

**"… changed in the repository since this site was built."** Someone
edited that file after the last build, and Studio commits whole files, so
committing yours would silently revert theirs. Wait for the site to
rebuild, then **reload Studio** and make your change again by hand —
reopening the technology is not enough, because Studio holds each document
it has loaded for the life of the page and would hand you the same stale
snapshot.

Do not press **Resume** on the older draft to get your edit back. Resuming
restores every value the draft was written against, so it undoes the newer
edits as well as restoring yours, and **Check upstream** will not stop it:
the baseline it compares was loaded fresh, so it matches the branch. The
review screen marks each change that would revert newer work, and the
draft banner warns before you choose. The README's [Studio section][studio]
has the longer version.

**"… does not exist on `<branch>`."** The opposite: waiting will not help.
Either the token is not allowed to read that file, or the site was built
from a different branch than the one the merge request targets.

Neither creates a branch. The run stops at the check, so there is nothing
to clean up.

## The build says a field is missing key 'ecs'

Every field carries an `ecs` key; there is no way to leave it out. Where
nothing in ECS fits, the value is `null` — omitting the key altogether is
what this error means. The `status` beside it still has to say what the
relationship is, and a `null` target does not decide that on its own: see
the README's [mapping status][status].

The line names where to go, down to the field:

    FATAL: adfs dataset 'security-audit' format 'windows-event' field 'EventID': missing key 'ecs'

## A hand-edited file shows as changed when nothing changed

Formatting, not content: a hand edit that rewraps a paragraph reads to
Studio as drift. Run:

    python3 tools/canonicalize.py

Why that works, and what it refuses to touch, is in the README's
[Studio section][studio], under *Editing a data file by hand*.

The one thing it does not say: `tools/canonicalize.py` needs `node` on
PATH, because the emitter it calls is JavaScript. Without it the tool does
not report a missing dependency — it dies with a `FileNotFoundError`
traceback naming `node`.

## Delete is refused, on one of two screens

Two different checks, in two different places.

**The editor's Delete technology button is greyed out.** The technology is
in neither the catalog nor the published site, so there is nothing to
remove, and the button's tooltip says exactly that. A catalog row with no
map file yet is still deletable — the row is the thing being removed.

**The delete screen will not act.** The repository is not configured, and
where you fix that depends on which part is missing. A token or an API URL
is yours to set: **Settings**, then reopen. A missing kind or project is
not — Settings has no field for either, so they can only come from
`data/studio.yml` or the deployment's `STUDIO_REPOSITORY_KIND` and
`STUDIO_REPOSITORY_PROJECT`, and the site has to rebuild before Studio
reads the change. Either way the refusal is a paragraph on the screen
rather than a tooltip, and it holds the confirm button shut however
correctly you type the id.

[status]: {{REPO}}/README.md#mapping-status
[studio]: {{REPO}}/README.md#studio
