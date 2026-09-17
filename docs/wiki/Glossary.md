# Glossary

The words this project uses without introducing them.

## The data

**ECS** — Elastic Common Schema, the field naming standard everything is
mapped *to*. `source.ip`, `event.action`, `threat.technique.id` are ECS
field names.

**ArcSight** — the SIEM this catalog is migrating off. This project maps
*to* ECS; it says nothing about ArcSight's own configuration.

**Technology** — one product that emits logs: a firewall, a directory
service, a mail gateway. One YAML file, one page on the site.

**Dataset** — one kind of log a technology emits. A firewall has a traffic
log and a threat log; those are two datasets, not two technologies.

**Format** — one encoding of a dataset. The same traffic log might be
available as CSV, CEF, LEEF or JSON, each carrying a different set of
fields. Formats are why coverage differs within one dataset.

**Field table** — the vendor's field names beside their ECS targets, one
row per field, with a status saying how completely it maps.

**Alerting profile** — the ECS fields the CSOC requires to alert on a
category of event. Owned by the CSOC; it drives every coverage number on
the site.

## The pipeline

**Cribl** — the pipeline that reshapes records between the device and
Elastic. A **worker group** is one deployment of it.

**Guard / CDS** — the cross-domain solution a record crosses to move from
the low side to the high side. **Everfox HSG** is the one in use.

**Route** — the path a feed takes from device to Elastic, including
whether it crosses the guard. Most datasets have two: *guarded* and
*direct*, separate feeds rather than a choice; a dataset that never
crosses the guard has only *direct*.

**MVX** — FireEye's detonation engine; its output is why some alert feeds
carry an analysis trace.

## This repository

**Studio** — the browser editor for the catalog, at `studio/` on the site.

**Draft** — a map researched but not yet verified against the deployed
system. Published with a banner saying so.

**Flag** — something the build noticed and wants a human to look at. Flags
do not fail the build; `FATAL` lines do.

For the rules behind these — what a status means, when a map stops being a
draft — see the README's [mapping status][status] and
[statuses and lifecycle][statuses].

[statuses]: {{REPO}}/README.md#statuses-and-lifecycle
[status]: {{REPO}}/README.md#mapping-status
