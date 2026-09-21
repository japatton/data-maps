# Picker

The Picker is the page for people who *consume* a map rather than own one:
tell it what you have, take away the map and the pipeline that parses it.
The README's [Picker section][picker] describes every part of it. This is
the other shape — one heading per thing you might actually want to do.

Open it from **Picker** in the site header.

## I have Forcepoint DLP sending CEF to Cribl and I want the pipeline

Technology **Forcepoint DLP** → dataset **DLP incident (policy
violation)** → wire format **syslog-cef**, which is already selected
because it is the recommended format for that dataset. Leave **Cribl
Stream is in the path** on.

The **Cribl Stream pipeline** panel holds the pipeline as JSON, with
**Copy** and **Download**. It is the committed pipeline verbatim, not
something the page assembled: what you paste into Cribl is exactly the
body that was POSTed to a Cribl 4.19 instance when the pipeline was
written. Its id is shown beside the buttons, and it starts with `dm_` —
rename it if you keep it, because `dm_` is reserved for validation runs
that delete everything carrying the prefix.

Above the parser panel sits the data map for that same block, with
**JSON**, **Markdown** and **CSV** downloads of its own. The CSV is the
field table and it carries the technology, dataset and format on every row,
so it stands alone once mailed.

## I do not run Cribl; what do I load into Elasticsearch

Turn **Cribl Stream is in the path** off. The panel becomes
**Elasticsearch ingest pipeline**: the same parsing, translated from the
Cribl pipeline into ingest processors.

**Download** hands you one thing — the request body for

    PUT _ingest/pipeline/<id>

and nothing else. The coverage badge, the notes and the manual steps stay
on the page; they are a report for you, not something Elasticsearch would
accept.

Two things to check before you load it:

- **The `Requires` line.** If it says `painless-regex`, the pipeline uses a
  Painless regex literal and the Elasticsearch node has to be started with
  `script.painless.regex.enabled: true`. Without it the `PUT` fails to
  compile, and that is the node, not the pipeline — see
  [Troubleshooting][regex].
- **The coverage badge.** *"6 of 8 steps translated, 1 partial, 1 manual"*
  means two of the original steps are not fully in the file you just
  downloaded. That is the next question.

## The ingest pipeline says it has manual steps

A manual step is a Cribl function the translator refused to guess at, so
it emitted nothing for it. Nothing is stubbed: there is no placeholder
processor to find and no comment to grep for, because a pipeline that
silently half-did a step would be worse than one that is honestly short.
What the page gives you instead is everything needed to finish it by hand:
the function's name, the reason it could not be translated, the
description the pipeline's author wrote for it, and — under **Original
Cribl function** — the function's own JSON.

A *partial* step is the same idea one level down: some of an `eval`'s rows
translated and the others did not. The processors for the good rows are in
the pipeline; the failing rows are listed as the manual part, with a reason
per row.

Forcepoint DLP's incident feed is a fair example of both. The `code`
function is fully manual — it is arbitrary JavaScript and will never
translate — and its description says what it does (split `destinationHosts`
and type-test each element into `destination.ip` or `destination.domain`),
which is enough to write a `script` processor or a `foreach` by hand. The
`eval` step is partial: four of its rows use a regex literal in a position
the expression subset does not cover, so those four are listed and the
rest of the step is in the pipeline.

Across the whole catalog, 141 of 2,093 steps are fully manual — 79 of them
`code` — and another 194 are partial. The full list of what does and does
not translate, and the semantic differences to know about the parts that
*did*, is in the README's [translation section][translate]. Read the
divergences before you trust a generated pipeline in production: several of
them are silent.

## I want to send someone this exact result

Copy the URL. The selection lives in the address bar, so the link restores
it:

    picker.html#<tech>/<dataset>/<format>?cribl=1|0&dest=elastic
    picker.html#forcepoint-dlp/incident/syslog-cef?cribl=0&dest=elastic

`cribl=0` is the Cribl toggle off — the ingest-pipeline view — and `1` is
on. A link whose technology, dataset or format the catalog does not have
resets the selection at that level and says what it could not find, so a
stale link tells you it is stale instead of quietly showing a different
feed.

## The result says the parsing happens somewhere else

Two different messages, both meaning "this is not where the work is".

**"Parsing happens downstream in `<artifact>`; this pipeline only
identifies the event and tags event.dataset."** The block is handled by an
Elastic integration or an Elastic ingest pipeline, and the Cribl pipeline
for it is deliberately thin: it tags `event.dataset` and passes the raw
record through untouched, and the named artifact does the field
extraction. The pipeline shown is still real and still worth loading —
just do not expect it to produce ECS fields.

**"Cribl is not in this path for this feed."** The block's parsing
mechanism is `none`: nothing is generated because there is nothing to
generate from. The map is still there, and the technology page's
recommendations say what that feed needs.

## The format I have is not listed

Every format the catalog documents for a dataset appears in the third
select, not only the recommended one, so check the list before concluding
it is missing. If what your device emits genuinely is not there, the map
is incomplete rather than the Picker — the device owner adds the format,
and [Add a technology](Add-a-technology) is the walkthrough.

If the format is listed but says *"No pipeline has been authored for this
block yet"*, that is the other gap: the map documents the format and
nobody has written its pipeline. It shows on the index as a `no-pipeline`
flag, and no block is in that state today.

[picker]: {{REPO}}/README.md#the-picker
[translate]: {{REPO}}/README.md#what-translates-and-what-does-not
[regex]: Troubleshooting#elasticsearch-rejects-the-ingest-pipeline-with-a-regex-error
