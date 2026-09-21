"""Markdown and CSV renderings of one (dataset, format) block.

The CSV mirrors Studio's export (studio/lib/export.js): same columns in the
same order, CRLF records, quotes only where RFC 4180 needs them, so a file
from either source opens identically.  tests/test_studio_parity.py holds
the two column lists together.
"""
import csv
import io

CSV_COLUMNS = ["technology", "dataset", "format", "#",
               "vendor", "type", "description", "ecs", "status",
               "custom", "transform", "notes"]
_FIELD_KEYS = ["vendor", "type", "description", "ecs", "status",
               "custom", "transform", "notes"]


def _text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def block_csv(tech_view, ds_view, fmt_view):
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(CSV_COLUMNS)
    tech_id = tech_view["entry"]["id"]
    ds_id = ds_view["data"]["id"]
    fmt = fmt_view["data"]["format"]
    for at, fw in enumerate(fmt_view["fields"], 1):
        field = fw["field"]
        writer.writerow([tech_id, ds_id, fmt, str(at)]
                        + [_text(field.get(k)) for k in _FIELD_KEYS])
    return buf.getvalue()


def _cell(value):
    return " ".join(_text(value).split()).replace("|", "\\|")


def _code(value):
    text = _text(value)
    return "`%s`" % text if text else ""


def _hop(hop):
    parts = [hop.get("hop", "")]
    for key in ("location", "device", "name", "data_stream"):
        if hop.get(key):
            parts.append(hop[key])
    return ": ".join(parts)


def block_markdown(tech_view, ds_view, fmt_view):
    entry = tech_view["entry"]
    ds = ds_view["data"]
    fmt = fmt_view["data"]
    parsing = fmt.get("parsing") or {}
    out = []
    out.append("# %s — %s — %s" % (entry["name"], ds["id"], fmt["format"]))
    out.append("")
    out.append("**Technology:** %s (%s) · **Dataset:** %s · **Format:** `%s` · "
               "**Parsing:** `%s`"
               % (entry["name"], entry.get("vendor", ""), ds.get("name", ds["id"]),
                  fmt["format"], parsing.get("mechanism", "")))
    if ds.get("description"):
        out.append("")
        out.append(" ".join(_text(ds["description"]).split()))
    route = ds.get("route") or {}
    for side in ("direct", "guarded"):
        hops = route.get(side)
        if hops:
            out.append("")
            out.append("## Route (%s)" % side)
            out.append("")
            out.append(" → ".join(_hop(h) for h in hops))
    out.append("")
    out.append("## Parsing")
    out.append("")
    line = "`%s`" % parsing.get("mechanism", "")
    if parsing.get("artifact"):
        line += " — %s" % _text(parsing["artifact"])
    out.append(line)
    if parsing.get("notes"):
        out.append("")
        out.append(" ".join(_text(parsing["notes"]).split()))
    recs = fmt.get("recommendations") or {}
    if recs:
        out.append("")
        out.append("## Recommendations")
        for side in ("direct", "guarded"):
            body = recs.get(side)
            if not body:
                continue
            out.append("")
            out.append("### %s" % side)
            if body.get("parse_location"):
                out.append("")
                out.append("Parse location: `%s`" % body["parse_location"])
            for key, label in (("cribl", "Cribl"), ("elastic", "Elastic"),
                               ("relay", "Relay")):
                if body.get(key):
                    out.append("")
                    out.append("**%s:** %s" % (label, " ".join(_text(body[key]).split())))
    out.append("")
    out.append("## Fields (%d mapped of %d)" % (fmt_view["fields_mapped"],
                                                fmt_view["fields_total"]))
    out.append("")
    if fmt.get("fields_omitted"):
        out.append("No field table: %s" % _text(fmt["fields_omitted"]))
    else:
        out.append("| Vendor field | Type | Description | ECS | Custom | Transform | Status | Alerting |")
        out.append("|---|---|---|---|---|---|---|---|")
        for fw in fmt_view["fields"]:
            f = fw["field"]
            transform = " ".join(x for x in (_cell(f.get("transform")),
                                             _cell(f.get("notes"))) if x)
            out.append("| %s | %s | %s | %s | %s | %s | %s | %s |" % (
                _code(f.get("vendor")), _cell(f.get("type")),
                _cell(f.get("description")), _code(f.get("ecs")),
                _code(f.get("custom")), transform, _cell(f.get("status")),
                "●" if fw["alerting"] else ""))
    out.append("")
    return "\n".join(out)
