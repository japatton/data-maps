#!/usr/bin/env python3
"""Launch gate: push every pipeline at a real Cribl and a real Elasticsearch.

Run by hand, never in CI.  Targets come from the environment so no host
or credential is committed:

    CRIBL_URL       e.g. http://cribl.example:19000   (skipped when unset)
    CRIBL_USER      Cribl UI/API user
    CRIBL_PASSWORD  its password
    ES_URL          e.g. http://localhost:9200         (skipped when unset)

Everything created is named dm_* and is deleted again at the end; the
dm_ prefix is reserved for validation, so anything already carrying it on
the target is deleted too and is not restored.  The report is written to
docs/verification/<date>-live-validation.md and is meant to be committed,
which is why it records a target that is neither loopback nor a .example
placeholder as <scheme>://<private host>:<port> and never by name.

What a green report proves: every Cribl pipeline is accepted by the API
(schema and conf valid) and every ingest pipeline compiles and loads in
Elasticsearch.  What it does not prove: correct parsing of real events;
the public tree carries no example records to run through them.
"""
import datetime
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, REPO)

from datamaps import cribl_paths  # noqa: E402
from datamaps import pipelines as pipelines_mod  # noqa: E402
from datamaps.ingest import pipeline as ingest_mod  # noqa: E402

SIMULATE_BODY = {"docs": [{"_source": {"message": ""}}]}
QUOTABLE_HOSTS = ("localhost", "127.0.0.1", "::1")


def targets(env):
    cribl = None
    if env.get("CRIBL_URL"):
        cribl = (env["CRIBL_URL"].rstrip("/"), env.get("CRIBL_USER", "admin"),
                 env.get("CRIBL_PASSWORD", ""))
    es = env["ES_URL"].rstrip("/") if env.get("ES_URL") else None
    return {"cribl": cribl, "es": es}


def display_endpoint(url):
    """The endpoint as the committed report is allowed to name it.

    A loopback or .example target is a placeholder and goes in verbatim.
    Any other host is somebody's real infrastructure and this repository is
    public, so only the scheme and the port survive.
    """
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if host in QUOTABLE_HOSTS or host.endswith(".example"):
        return url
    try:
        port = ":%d" % parts.port if parts.port else ""
    except ValueError:
        port = ""
    return "%s://<private host>%s" % (parts.scheme, port)


def request(method, url, body=None, headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def cribl_login(url, user, password):
    status, text = request("POST", url + "/api/v1/auth/login",
                           {"username": user, "password": password})
    if status != 200:
        raise SystemExit("Cribl login failed: %s %s" % (status, text[:200]))
    return json.loads(text)["token"]


def cribl_version(url, token):
    status, text = request("GET", url + "/api/v1/system/info",
                           headers={"Authorization": "Bearer " + token})
    if status != 200:
        return "unknown"
    try:
        info = json.loads(text)
    except ValueError:
        return "unknown"
    # 4.19 wraps the answer in {"items": [...]}; older builds answer bare.
    if isinstance(info, dict) and isinstance(info.get("items"), list):
        info = info["items"][0] if info["items"] else None
    if not isinstance(info, dict) or not isinstance(info.get("BUILD"), dict):
        return "unknown"
    return info["BUILD"].get("VERSION", "unknown")


_GROUP = re.compile(r"\(\?<([A-Za-z_][A-Za-z0-9_]*)>")
# An assignment in a `code` body: __e['x'] = / __e["x"] = / __e.x = (not ==).
_CODE_WRITE = re.compile(
    r"""__e(?:\[\s*['"]([^'"\]]+)['"]\s*\]|\.([A-Za-z_$][\w$]*))\s*=(?!=)""")


def _written_before(functions):
    """Names each function index can rely on the pipeline itself producing."""
    written, seen = [], set()
    for fn in functions:
        written.append(set(seen))
        if fn.get("disabled") is True:
            continue
        c = fn.get("conf") or {}
        for row in c.get("add") or []:
            seen.add(cribl_paths.unquote(str(row.get("name", ""))))
        for pair in c.get("rename") or []:
            if isinstance(pair, dict):
                seen.add(cribl_paths.unquote(str(pair.get("newName", ""))))
        for key in ("dstField",):
            if c.get(key):
                seen.add(cribl_paths.unquote(str(c[key])))
        for rx in [c.get("regex")] + [r.get("regex") for r in c.get("regexList") or []]:
            if isinstance(rx, str):
                seen.update(_GROUP.findall(rx))
        if fn.get("id") == "code":
            for quoted, dotted in _CODE_WRITE.findall(str(c.get("code", ""))):
                seen.add(quoted or dotted)
    return written


def _put(event, name, value):
    if cribl_paths.is_quoted(name):
        event[cribl_paths.unquote(name)] = value
        return True
    parts = name.split(".")
    node = event
    for part in parts[:-1]:
        nxt = node.setdefault(part, {})
        if not isinstance(nxt, dict):
            return False
        node = nxt
    if parts[-1] in node:
        return False
    node[parts[-1]] = value
    return True


def sentinel_events(doc, numeric=False):
    """([event, ...], [(value, currentName, newName)]) for the behaviour check.

    Every rename that reads a vendor field gets a unique sentinel value at
    that field, addressed the way Cribl addresses it: a quoted name is a
    flat key, an unquoted dotted one a nested path.  Fields the pipeline
    writes itself before the rename are left alone.

    Renames that share one target are alternates for the same value (`user`
    or `USER`); a real record carries one of them, so the k-th alternate goes
    in the k-th event and each event carries every other source afresh.

    `numeric` seeds digit strings instead of words, for the second pass:
    a value a pipeline legitimately coerces (`Number(x) * 1000`) survives a
    digit sentinel, while one a rename or a flat-key read destroys does not.
    """
    functions = (doc.get("conf") or {}).get("functions") or []
    before = _written_before(functions)
    sources, groups = [], {}
    for i, fn in enumerate(functions):
        if fn.get("id") != "rename" or fn.get("disabled") is True:
            continue
        for pair in (fn.get("conf") or {}).get("rename") or []:
            if not isinstance(pair, dict):
                continue
            cur = str(pair.get("currentName", ""))
            bare = cribl_paths.unquote(cur)
            if (not cur or bare in ("_raw", "_time") or bare.startswith("__")
                    or "*" in cur or bare in before[i]):
                continue
            new = str(pair.get("newName", ""))
            group = groups.setdefault(cribl_paths.unquote(new), [])
            group.append(len(sources))
            sources.append((cur, new, group))
    width = max([len(g) for g in groups.values()] or [1])
    events, sentinels = [], []
    for k in range(width):
        event = {"_raw": ""}
        for n, (cur, new, group) in enumerate(sources):
            if group[min(k, len(group) - 1)] != n:
                continue
            value = ("731%07d" if numeric else "dmsentinel%04d") % len(sentinels)
            if _put(event, cur, value):
                sentinels.append((value, cur, new))
        events.append(event)
    return events, sentinels


def _lost(sentinels, items):
    """Indexes of sentinels absent from the output, raw or md5-masked."""
    blob = json.dumps(items).lower()
    return set(i for i, (value, _, _) in enumerate(sentinels)
               if value not in blob
               and hashlib.md5(value.encode("utf-8")).hexdigest() not in blob)


def behaviour_findings(sentinels, items, retry=None):
    """Data-loss findings for one preview run; an empty output is not one.

    `retry` is (sentinels, items) from the numeric pass; a value counts as
    lost only when both passes lost it.
    """
    if not items:
        return []
    out = []
    for item in items:
        for k in sorted(item):
            if "." in k and not k.startswith("__"):
                out.append("flat key survived re-nest: %s" % k)
    lost = _lost(sentinels, items)
    if lost and retry is not None:
        num_sentinels, num_items = retry
        lost &= (_lost(num_sentinels, num_items) if num_items
                 else set(range(len(num_sentinels))))
    for i in sorted(lost):
        out.append("value lost: %s -> %s" % (sentinels[i][1], sentinels[i][2]))
    return out


def cribl_preview(url, auth, pid, events):
    """(status, items or error text) for one preview of pipeline `pid`."""
    status, text = request("POST", url + "/api/v1/preview",
                           {"mode": "pipe", "pipelineId": pid, "events": events},
                           headers=auth)
    if status != 200:
        return status, text
    return status, [{k: v for k, v in it.items() if k != "cribl_pipe"}
                    for it in json.loads(text).get("items") or []
                    if isinstance(it, dict)]


def cribl_validate(url, token, pipelines):
    auth = {"Authorization": "Bearer " + token}
    results = []
    for key in sorted(pipelines):
        doc = pipelines[key]
        pid = doc["id"]
        request("DELETE", url + "/api/v1/pipelines/" + pid, headers=auth)
        status, text = request("POST", url + "/api/v1/pipelines", doc, headers=auth)
        result = {"id": pid, "key": "%s/%s__%s" % key, "ok": status == 200,
                  "status": status, "detail": "" if status == 200 else text[:2000],
                  "behaviour": None}
        if status == 200:
            events, sentinels = sentinel_events(doc)
            s2, items = cribl_preview(url, auth, pid, events)
            retry = None
            if s2 == 200 and items and _lost(sentinels, items):
                num_events, num_sentinels = sentinel_events(doc, numeric=True)
                s3, num_items = cribl_preview(url, auth, pid, num_events)
                retry = (num_sentinels, num_items if s3 == 200 else [])
            if s2 != 200:
                result["behaviour"] = ["preview failed: HTTP %s %s" % (s2, items[:300])]
            else:
                result["behaviour"] = behaviour_findings(sentinels, items, retry)
                result["sentinels"] = len(sentinels)
                result["dropped"] = not items
        results.append(result)
        request("DELETE", url + "/api/v1/pipelines/" + pid, headers=auth)
        sys.stdout.write("cribl %s %s%s\n" % (status, pid,
                         " BEHAVIOUR" if result["behaviour"] else ""))
    return results


def es_version(url):
    status, text = request("GET", url)
    if status != 200:
        return "unknown"
    try:
        return json.loads(text)["version"]["number"]
    except (ValueError, KeyError):
        return "unknown"


def simulate_error(text):
    """First per-document error in a `_simulate` body, or None when clean.

    Elasticsearch answers 200 even when a processor threw at run time: the
    failure is per document, inside the body.  Returns the `error` object, or
    {"type": "unparseable", "reason": <text[:200]>} when the body is not JSON
    or carries no `docs` list.
    """
    try:
        body = json.loads(text)
    except ValueError:
        return {"type": "unparseable", "reason": text[:200]}
    if not isinstance(body, dict) or not isinstance(body.get("docs"), list):
        return {"type": "unparseable", "reason": text[:200]}
    for doc in body["docs"]:
        if isinstance(doc, dict) and "error" in doc:
            err = doc["error"]
            return err if isinstance(err, dict) else {"type": "error",
                                                      "reason": str(err)}
    return None


def es_validate(url, envelopes):
    results = []
    for key in sorted(envelopes):
        env = envelopes[key]
        pid = env["id"]
        status, text = request("PUT", url + "/_ingest/pipeline/" + pid, env["pipeline"])
        ok = status == 200
        detail = "" if ok else text[:2000]
        if ok:
            s2, t2 = request("POST", url + "/_ingest/pipeline/" + pid + "/_simulate",
                             SIMULATE_BODY)
            if s2 != 200:
                ok, status, detail = False, s2, t2[:2000]
            else:
                err = simulate_error(t2)
                if err is not None:
                    ok = False
                    detail = json.dumps(err, indent=2, sort_keys=True)[:2000]
        results.append({"id": pid, "key": "%s/%s__%s" % key, "ok": ok,
                        "status": status, "detail": detail})
        request("DELETE", url + "/_ingest/pipeline/" + pid)
        sys.stdout.write("es %s %s\n" % (status, pid))
    return results


def _section(name, results, skipped_reason):
    if results is None:
        return ["## %s: skipped (%s)" % (name, skipped_reason), ""]
    ok = sum(1 for r in results if r["ok"])
    lines = ["## %s: %d of %d accepted" % (name, ok, len(results)), ""]
    failures = [r for r in results if not r["ok"]]
    if not failures:
        lines.append("No failures.")
    for r in failures:
        lines.append("### %s (`%s`) — HTTP %s" % (r["key"], r["id"], r["status"]))
        lines.append("")
        lines.append("```")
        lines.append(r["detail"])
        lines.append("```")
        lines.append("")
    lines.append("")
    return lines


def _behaviour_section(results):
    if results is None:
        return []
    ran = [r for r in results if r.get("behaviour") is not None]
    bad = [r for r in ran if r["behaviour"]]
    seeded = sum(r.get("sentinels", 0) for r in ran)
    dropped = sum(1 for r in ran if r.get("dropped"))
    lines = ["## Cribl behaviour: %d of %d clean" % (len(ran) - len(bad), len(ran)), "",
             "One preview per pipeline, seeded with a sentinel at every field a "
             "`rename` reads (%d sentinels); alternate sources of one target go in "
             "separate events. A finding is a dotted key the re-nest step left flat, "
             "or a sentinel that vanished, neither raw nor md5-masked, in both the "
             "word pass and the digit pass that retries a loss (a legitimate numeric "
             "coercion keeps the digits). %d pipelines dropped the synthetic event and "
             "prove nothing here." % (seeded, dropped), ""]
    if not bad:
        lines.append("No findings.")
    for r in bad:
        lines.append("### %s (`%s`)" % (r["key"], r["id"]))
        lines.append("")
        lines.extend("- %s" % f for f in r["behaviour"])
        lines.append("")
    lines.append("")
    return lines


def write_report(path, cribl_results, es_results, meta):
    lines = ["# Live validation — %s" % meta["date"], "",
             "| target | endpoint | version |", "|---|---|---|",
             # Code-spanned: a masked endpoint reads `<private host>`, and
             # outside a code span every Markdown renderer treats that as an
             # unknown HTML tag and drops it.
             "| Cribl Stream | `%s` | %s |" % (meta.get("cribl") or "—",
                                               meta.get("cribl_version") or "—"),
             "| Elasticsearch | `%s` | %s |" % (meta.get("es") or "—",
                                                meta.get("es_version") or "—"), "",
             "A green line means the target accepted the pipeline: schema and conf "
             "valid for Cribl, compiled and loaded for Elasticsearch. Neither proves "
             "correct parsing of real events.", ""]
    lines += _section("Cribl", cribl_results, "CRIBL_URL unset")
    lines += _behaviour_section(cribl_results)
    lines += _section("Elasticsearch", es_results, "ES_URL unset")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines).rstrip() + "\n")


def main():
    t = targets(os.environ)
    if not t["cribl"] and not t["es"]:
        sys.stderr.write("set CRIBL_URL and/or ES_URL\n")
        return 2
    loaded = pipelines_mod.load_pipelines(os.path.join(REPO, "data"))
    envelopes = ingest_mod.translate_all(loaded)
    meta = {"date": datetime.date.today().isoformat(), "cribl": None, "es": None,
            "cribl_version": None, "es_version": None}
    cribl_results = es_results = None
    if t["cribl"]:
        url, user, password = t["cribl"]
        token = cribl_login(url, user, password)
        meta["cribl"] = display_endpoint(url)
        meta["cribl_version"] = cribl_version(url, token)
        cribl_results = cribl_validate(url, token, loaded)
    if t["es"]:
        meta["es"] = display_endpoint(t["es"])
        meta["es_version"] = es_version(t["es"])
        es_results = es_validate(t["es"], envelopes)
    path = os.path.join(REPO, "docs", "verification",
                        "%s-live-validation.md" % meta["date"])
    write_report(path, cribl_results, es_results, meta)
    sys.stdout.write("report: %s\n" % os.path.relpath(path, REPO))
    failed = sum(1 for rs in (cribl_results, es_results) if rs
                 for r in rs if not r["ok"] or r.get("behaviour"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
