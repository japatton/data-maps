# Cribl field-path semantics — 2026-09-22

Probed with the preview API (`POST /api/v1/preview`, `mode: pipe`) on the
lab Cribl 4.19.0 and on throwaway `cribl/cribl:4.19.0` and `4.14.0`
containers. The 4.19.0 container also ran the same pipeline on a real
path (HTTP source → pipeline → filesystem destination), and the file
output matched preview exactly.

## Writes: an unquoted dotted name needs an existing parent

| Function | Event | Result |
|---|---|---|
| `eval` add `x.y = 'a'` | no `x` | nothing written |
| `eval` add `x.y = 'a'` | `x: {}` | `x: {y: 'a'}` |
| `eval` add `source = ({})`, then `source.ip = src` | no `source` | `source: {ip: ...}` |
| `rename src → source.ip` | no `source` | **`src` deleted, nothing written** |
| `rename src → source.ip` | `source: {}` | `source: {ip: ...}` |
| two renames into the same new parent (`source.ip`, `source.user`) | no `source` | both values lost |
| `rename src → 'source.ip'` (quoted) | — | flat key `"source.ip"` |
| `eval` add `'user.name'` (quoted) | — | flat key `"user.name"` |
| `code`: `__e.source = __e.source \|\| {}; __e.source.ip = __e.src` | — | `source: {ip: ...}` |

4.14.0 behaves identically, so this is not a 4.19 regression. No function
setting changes it (`GET /api/v1/functions` schemas for eval and rename).

Corpus impact: 12 committed pipelines were sampled at random. 8 of them have
a `rename`. Running only their `rename` functions over an event that
carries every `currentName`, **2 of 49 renamed values landed** at their
`newName`. The rest were deleted.

## Reads

| Expression (in `eval` value or `filter`) | Event | Result |
|---|---|---|
| `__e['event.duration']` | `event: {duration: 5}` | undefined (reads the flat key only) |
| `__e['event.duration']` | `"event.duration": 7` | 7 |
| bare `event.duration` / `__e.event.duration` / `__e['event']['duration']` | `event: {duration: 5}` | 5 |
| bare `missing_field`, `missing.a.b.c` | absent | `undefined` — **no throw** |
| `__e.event?.duration` | — | rejected at save (`Unexpected token .`) |

A bare read of an absent field throws `ReferenceError` only inside a
`code` function (real JavaScript). The `eval` values and filters return
`undefined`, so the brief's rule that a bare identifier "throws at
runtime" holds for `code` and not for `eval`.
