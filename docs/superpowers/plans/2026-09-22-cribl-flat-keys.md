# Cribl flat keys + re-nest — plan (2026-09-22)

Evidence: `docs/verification/2026-09-22-cribl-field-semantics.md`. Cribl writes
an unquoted dotted name only when the parent object already exists, and
`rename` deletes the source when it can't. The user chose flat keys plus one
shared re-nest step, which is the pattern Cribl's own `prep_for_ECS` uses.

## Rule

A dotted path is **flat** once any earlier step has written it as a flat key:
a quoted `eval`/`rename`/`dstField` name, a `flatten` with delimiter `.`, or a
`code` assignment `__e['a.b'] =`. From that point on, every reference to it is
a quoted name (`'a.b'`) in function confs and `__e['a.b']` in expressions.
Every other path keeps its nested meaning. Each pipeline ends with the
canonical re-nest `code` function (`datamaps/renest.js`, single source).

## Tasks

1. `datamaps/renest.js` holds the canonical re-nest code (proven on lab Cribl
   2026-09-22).
2. `datamaps/cribl_paths.py` is a stdlib-only analyzer and rewriter. It walks
   the enabled functions in order and tracks FLAT. It quotes dotted writes,
   quotes references to FLAT names, and rewrites expression chains whose
   longest dotted prefix is in FLAT to `__e['P']`. `code` bodies only rewrite
   `__e.`/`__e[` chains. It reports what can't be rewritten: a read of a
   parent of a FLAT name, and a nested write inside `code`. It appends the
   re-nest function if it's missing.
3. `tools/pipelines/flat_keys.py` applies the rewriter to `data/pipelines`
   (`--check` reports only) and writes JSON with `indent=2` plus a newline.
4. Lint: a pending rewrite is a finding (`flat-key-rewrite-pending`), as are
   `missing-renest` and `parent-read-of-flat`. `VALID_PATH` accepts quoted
   literals.
5. Transpiler: quoted names are unquoted before `map_field`, and the canonical
   re-nest becomes `dot_expander {field: "*"}`.
6. Gate behaviour check: a sentinel event carrying every `rename` currentName
   is sent through `/api/v1/preview`. It fails when a sentinel vanishes or a
   dotted top-level key survives.
7. Docs: brief rules 4 and ★ORDER, README lint list, the backlog sentence,
   and the spec's bare-identifier and "missing read throws" notes.
8. Run: suites with node, lint, and the gate until green. Then commit and push
   on `bare-identifiers`.
