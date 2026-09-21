# Runbooks

What to do, in the order to do it.

## Publish the site

Nothing to run by hand: the site rebuilds when the default branch moves.
Both CI definitions in this repository — `.gitlab-ci.yml` and
`.forgejo/workflows/pages.yml` — publish from that branch and from no
other.  The Forgejo workflow lives under `.forgejo/` rather than
`.github/` so that a mirror to GitHub can carry it: GitHub refuses a
push that writes `.github/workflows/` unless the credential holds
workflow permission, and this one deliberately does not.

To see what a build would produce before pushing:

    python3 -m datamaps.build

A build that fails publishes nothing and replaces nothing: it stops before
it touches `public/`, so the site that is up stays up. Which problems fail
a build and which merely get flagged on the published site is in the
README's [validation tiers][validation].

## Point a deployment at its own endpoints

The `STUDIO_*` variables that override `data/studio.yml`, and why they
belong at group level rather than per project, are in the README's
[Studio section][deploy].

Two traps it does not spell out:

- **Repointing a deployment is two variables, not one.** The allow-list is
  checked against four keys — `repository.api_url`,
  `repository.web_ide_url`, `analysis.api_url` and `elastic.url`, empty
  ones skipped — so a new endpoint means changing the endpoint *and*
  `STUDIO_ALLOWED_HOSTS`. `web_ide_url` is the one that gets forgotten,
  because it is a link template rather than an endpoint, and it fails the
  pipeline exactly like the rest.
- **A secret variable fails the build, and the message never says
  "secret".** `STUDIO_REPOSITORY_TOKEN` is rejected with `'token' is not a
  key of studio repository`: there is no key in the config to hold one, by
  design.

Set the variables in front of a local build before they reach CI, and
check the keys it echoes back. A variable whose `STUDIO_` prefix is
mistyped is not an error — it is silently ignored, and that echo is the
only place the omission shows.

## Rotate the repository token

Per person, and no deployment: Studio's token lives in each admin's
browser and never in the repository, so there is nothing central to
change. In Studio: **Settings**, paste the new token into **Repository
token**, **Save**.

**Forget everything** clears the tokens and keys. Unfinished editor work is kept separately in this browser and survives it; discard a draft from the editor. Unticking **Remember on
this device** and saving erases the remembered copy rather than leaving it
behind: the values move to session storage, which the tab drops when it
closes.

## A pipeline failed

Read **every** `FATAL` line. Data validation and the host check each
collect every problem they find and print a line for each, so one file can
produce several lines and one wrong allow-list produces one line per URL.

Two things stop the run before any of that and hide everything behind
them. A file that will not parse as YAML is reported on its own: the build
reads every data file before it validates any of them, so one bad edit
masks every error in the rest, including errors that were already there. A
bad `STUDIO_*` variable stops the run next, still before validation, and
also reports only the first. In both cases, fix and run again rather than
trusting the list you were handed.

- `invalid YAML` — a hand edit that broke the file. Nothing else was
  checked.
- `is not a key of studio <section>`, or `is not a studio config section`
  — a `STUDIO_*` variable that names no configuration key, or whose
  section word is mistyped. Often a secret someone tried to inject.
- `must be true or false` — a boolean variable given something else.
- `is not in STUDIO_ALLOWED_HOSTS` — a URL pointing at a host the
  allow-list does not cover. Either the URL is wrong or the list is; the
  line names which key it read.
- `missing key 'ecs'` — a hand-edited field table. See
  [Troubleshooting](Troubleshooting).

## Undo a merge that should not have landed

Revert the merge request. The site rebuilds from the default branch, so
the revert is the whole fix — there is no separate deployment to roll
back.

This is why a deletion goes through a merge request rather than a direct
commit, and why Studio's delete screen says so before you confirm: the
revert *is* the recovery path.

## Refresh the screenshots

    python3 -m datamaps.build
    python3 tools/screenshots.py

One run takes the README's images and this wiki's together —
`studio-picker.png` and `studio-review.png` are written into `docs/wiki/`
and go out with the pages. It needs a built site and Chrome, so it never
runs in CI. `--check` reports missing or empty images without taking any.

## Publish this wiki

    python3 tools/wiki.py --remote <wiki-url> --repo-url <code-url> --check
    python3 tools/wiki.py --remote <wiki-url> --repo-url <code-url>

`--check` prints the adds, updates and deletes and writes nothing. Both
URLs are required and neither has a default: each deployment's wiki
is a different repository, and `--repo-url` is what every link back to
the README on these pages resolves to.

Add `--flavor gitlab` for a GitLab wiki. It wants a lowercase `_sidebar`
where Forgejo wants `_Sidebar`, and the tool renames the file on the way
out; publish with the wrong flavor and the host does not recognise the
page as a sidebar at all.

## Live validation

Before enabling public hosting, and after any change to `data/pipelines/`
or `datamaps/ingest/`, run the live validation described in
`tools/validate_live/README.md` and commit the report it writes under
`docs/verification/`.  CI runs the offline lint and the transpiler tests on
every push; this is the one check that needs a real Cribl and a real
Elasticsearch, so it is run by a person and recorded.

A report proves acceptance — Cribl took the conf, Elasticsearch compiled the
processors.  It does not prove parsing correctness: this repository holds no
example records to run through either.

[deploy]: {{REPO}}/README.md#studio
[validation]: {{REPO}}/README.md#validation-and-data-quality
