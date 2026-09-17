// LLM client, prompts and sampling for the Studio analysis workbench.
//
// Browser ES module: no dependencies, no DOM access at import time. Every
// request goes out with `credentials: "omit"`; `fetchImpl` is injectable so
// the tests can drive the client without a network.

import { globalObject } from "./global.js";

const encoder = new TextEncoder();

const MAX_SENTENCE = 160;
const MAX_NOTE = 600;

/** Number of UTF-8 bytes in a string. */
function byteLength(text) {
  return encoder.encode(text).length;
}

/**
 * Take the head of a pasted export: the first `maxLines` lines, then cut to
 * `maxBytes` UTF-8 bytes at a line boundary.
 *
 * Returns {sample, lines, bytes, truncated, totalLines}.
 */
export function takeSample(text, { maxLines = 80, maxBytes = 12288 } = {}) {
  const body = typeof text === "string" ? text : "";
  const all = body.split("\n");
  // A trailing newline is a terminator, not an empty last line.
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const totalLines = all.length;

  const head = all.slice(0, maxLines);
  const kept = [];
  let bytes = 0;
  for (const line of head) {
    // +1 for the newline that joins this line to the previous one.
    const cost = byteLength(line) + (kept.length ? 1 : 0);
    if (bytes + cost > maxBytes) break;
    kept.push(line);
    bytes += cost;
  }
  if (kept.length === 0) {
    // A single line longer than the budget (a one-line JSON export, say):
    // keep it, cut on a codepoint boundary so the sample stays valid text.
    const raw = encoder.encode(head.length ? head[0] : "");
    let end = Math.min(raw.length, maxBytes);
    while (end > 0 && (raw[end] & 0xc0) === 0x80) end -= 1;
    const cut = new TextDecoder().decode(raw.subarray(0, end));
    kept.push(cut);
    bytes = end;
  }

  const sample = kept.join("\n");
  const whole = all.join("\n");
  return {
    sample,
    lines: kept.length,
    bytes,
    truncated: sample !== whole,
    totalLines,
  };
}

/** String.prototype.trimEnd is ES2019; Studio's floor is ES2018. */
function trimEnd(text) {
  return String(text).replace(/\s+$/, "");
}

/** Block scalars carry newlines; the digest and the tables want one line. */
function flatten(text) {
  if (!text) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

/**
 * A field's own prose, kept nearly whole: the assessment is grounded in it,
 * so it is capped generously rather than cut to a sentence.
 */
function capped(text, limit = MAX_NOTE) {
  const flat = flatten(text);
  if (flat.length <= limit) return flat;
  return trimEnd(flat.slice(0, limit)) + "…";
}

/** First sentence of a description: up to the first ". ", capped at 160 chars. */
function firstSentence(text) {
  const flat = flatten(text);
  if (!flat) return "";
  const stop = flat.indexOf(". ");
  const sentence = stop === -1 ? flat : flat.slice(0, stop + 1);
  if (sentence.length <= MAX_SENTENCE) return sentence;
  return trimEnd(sentence.slice(0, MAX_SENTENCE)) + "…";
}

/**
 * A compact catalog digest for the identify prompt: one line per technology
 * (`id | name | vendor | category`) with its datasets indented below.
 *
 * `catalogRows` are the catalog.yml rows; `sources` is `{id: document}` for
 * the technologies whose map has been written. A technology with no document
 * (or no datasets) lists `(no map yet)`.
 */
export function buildCatalogDigest(catalogRows, sources) {
  const docs = sources || {};
  const lines = [];
  for (const row of catalogRows || []) {
    lines.push([row.id, row.name, row.vendor, row.category].join(" | "));
    const doc = docs[row.id];
    const datasets = doc && Array.isArray(doc.datasets) ? doc.datasets : [];
    if (!datasets.length) {
      lines.push("  (no map yet)");
      continue;
    }
    for (const ds of datasets) {
      const formats = (ds.formats || []).map((f) => f.format).filter(Boolean);
      const parts = [
        ds.id,
        ds.name,
        "formats: " + (formats.length ? formats.join(", ") : "(none)"),
      ];
      const sentence = firstSentence(ds.description);
      if (sentence) parts.push(sentence);
      lines.push("  " + parts.join(" | "));
    }
  }
  return lines.join("\n");
}

const NULLABLE_STRING = { type: ["string", "null"] };

/** Structured output for step 1 (identify). */
export const IDENTIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "technology_id",
    "dataset_id",
    "format",
    "confidence",
    "evidence",
    "alternatives",
    "unknown",
  ],
  properties: {
    technology_id: NULLABLE_STRING,
    dataset_id: NULLABLE_STRING,
    format: NULLABLE_STRING,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "array", items: { type: "string" } },
    alternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["technology_id", "dataset_id", "reason"],
        properties: {
          technology_id: NULLABLE_STRING,
          dataset_id: NULLABLE_STRING,
          reason: { type: "string" },
        },
      },
    },
    unknown: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["name", "vendor"],
      properties: { name: { type: "string" }, vendor: { type: "string" } },
    },
  },
};

/** Structured output for step 2 (assess). */
export const ASSESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "observed_fields",
    "inventory_not_observed",
    "alerting_gaps",
    "parsing",
    "catalog_edits",
    "confidence",
  ],
  properties: {
    summary: { type: "string" },
    observed_fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name",
          "example",
          "in_inventory",
          "inventory_vendor",
          "suggested_ecs",
          "suggested_status",
          "note",
        ],
        properties: {
          name: { type: "string" },
          example: { type: "string" },
          in_inventory: { type: "boolean" },
          inventory_vendor: NULLABLE_STRING,
          suggested_ecs: NULLABLE_STRING,
          suggested_status: {
            type: ["string", "null"],
            enum: ["mapped", "partial", "unmapped", null],
          },
          note: { type: "string" },
        },
      },
    },
    inventory_not_observed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["vendor", "note"],
        properties: { vendor: { type: "string" }, note: { type: "string" } },
      },
    },
    alerting_gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ecs", "present_in_log", "note"],
        properties: {
          ecs: { type: "string" },
          present_in_log: { type: "boolean" },
          note: { type: "string" },
        },
      },
    },
    parsing: {
      type: "object",
      additionalProperties: false,
      required: ["mechanism", "parse_location", "rationale"],
      properties: {
        mechanism: { type: "string" },
        parse_location: { type: "string", enum: ["low", "high", "hybrid"] },
        rationale: { type: "string" },
      },
    },
    catalog_edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["where", "change"],
        properties: { where: { type: "string" }, change: { type: "string" } },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/** "Sample: first N lines (M bytes) of a P-line export" plus the fenced sample. */
function sampleBlock(sampleInfo) {
  const info = sampleInfo || {};
  return (
    "Sample: first " +
    info.lines +
    " lines (" +
    info.bytes +
    " bytes) of a " +
    info.totalLines +
    "-line export" +
    (info.truncated ? " (truncated)" : "") +
    "\n```\n" +
    (info.sample || "") +
    "\n```"
  );
}

const IDENTIFY_SYSTEM = [
  "You classify vendor log samples against a catalog of log technologies.",
  "Answer only with JSON matching the given schema. Choose technology_id,",
  "dataset_id and format ONLY from the catalog digest; if nothing fits, set them",
  'to null and describe the product in "unknown". Cite concrete tokens from the',
  "sample as evidence. Confidence is your probability that the technology_id is",
  "right.",
].join("\n");

/** Step 1 prompt: the catalog digest plus the sample. */
export function identifyPrompt(digest, sampleInfo) {
  const user = [
    "Catalog digest (technology, then its datasets):",
    "```",
    digest || "",
    "```",
    "",
    sampleBlock(sampleInfo),
    "",
    "Identify the technology, dataset and source format this sample belongs to.",
  ].join("\n");
  return { system: IDENTIFY_SYSTEM, user };
}

function assessSystem(ecsVersion, mechanisms) {
  // No version is better than an invented one: an unlabelled "ECS" still
  // names the schema, while a wrong number would licence wrong field names.
  const version = ecsVersion ? " " + ecsVersion : "";
  const list = Array.isArray(mechanisms) ? mechanisms.join(", ") : String(mechanisms || "");
  return [
    "You are a SIEM data-onboarding engineer assessing how well a catalog",
    "entry covers a vendor log sample. The catalog maps vendor fields to Elastic",
    "Common Schema (ECS)" + version + ". Answer only with JSON matching the schema.",
    'Judge "in_inventory" strictly against the provided field table (match on the',
    "vendor name, tolerating case and separators). Suggest ECS targets only using",
    "real ECS" + version + ' field names; prefer null over a guess. "alerting_gaps" must',
    'cover every field in the required list. In "parsing" recommend a mechanism',
    "from: " + list + " and a parse location (low = near the source, high = near",
    "the SIEM, hybrid = envelope low and enrich high), with the rationale grounded",
    "in the sample's structure. \"catalog_edits\" lists concrete changes an editor",
    "should make, each naming where (dataset/format/field) and what.",
  ].join("\n");
}

/**
 * Step 2 prompt.
 *
 * ctx = {technology: {id, name, vendor},
 *        dataset: {id, name, description, event_categories, route_summary},
 *        format: <format entry>, other_formats: [names],
 *        required_ecs: [names], ecs_version, mechanisms}
 */
export function assessPrompt(ctx, sampleInfo) {
  const c = ctx || {};
  const tech = c.technology || {};
  const ds = c.dataset || {};
  const fmt = c.format || {};
  const fields = Array.isArray(fmt.fields) ? fmt.fields : [];

  // Every field's own prose goes in: `transform` says how a target is derived
  // (which decides whether an alerting target is reachable at all) and
  // `custom` records a target the catalog already carries outside ECS.
  const fieldRow = (f) => {
    const prose = [];
    if (f.description) prose.push("description: " + capped(f.description));
    if (f.transform) prose.push("transform: " + capped(f.transform));
    if (f.notes) prose.push("notes: " + capped(f.notes));
    return [
      f.vendor,
      f.type || "-",
      f.ecs == null ? "(no ECS target)" : f.ecs,
      f.custom || "-",
      f.status || "-",
      prose.length ? prose.join("; ") : "-",
    ].join(" | ");
  };
  const FIELD_HEADER = "vendor | type | ecs | custom | status | description, transform and notes";
  const fieldTable = fields.length
    ? [FIELD_HEADER].concat(fields.map(fieldRow)).join("\n")
    : "(the format lists no fields)";
  // The fields are rendered as the table below, so they are dropped from the
  // JSON dump rather than sent twice.
  const formatHead = {};
  for (const [key, value] of Object.entries(fmt)) {
    if (key !== "fields") formatHead[key] = value;
  }

  const user = [
    "Technology: " + [tech.id, tech.name, tech.vendor].filter(Boolean).join(" | "),
    "",
    "Dataset:",
    "```",
    "id: " + (ds.id || ""),
    "name: " + (ds.name || ""),
    "event_categories: " + ((ds.event_categories || []).join(", ") || "(none)"),
    "route: " + (ds.route_summary || "(none recorded)"),
    "description: " + (flatten(ds.description) || "(none)"),
    "```",
    "",
    "Chosen format entry, without its fields (JSON):",
    "```json",
    JSON.stringify(formatHead, null, 2),
    "```",
    "",
    "Field table — the inventory for this format, one row per field:",
    "```",
    fieldTable,
    "```",
    "Each value in the last column belongs to that field alone; values longer than "
      + MAX_NOTE + " characters end in ….",
    "",
    "Other formats offered for this dataset: " +
      ((c.other_formats || []).join(", ") || "(none)"),
    "",
    "Alerting-required ECS targets for this dataset's categories: " +
      ((c.required_ecs || []).join(", ") || "(none)"),
    "",
    sampleBlock(sampleInfo),
    "",
    "Assess how well this catalog entry covers the sample.",
  ].join("\n");

  return { system: assessSystem(c.ecs_version, c.mechanisms), user };
}

/** Remove a leading <think>…</think> block (multi-line) and trim. */
export function stripThink(text) {
  const body = typeof text === "string" ? text : "";
  return body.replace(/^\s*<think>[\s\S]*?<\/think>/i, "").trim();
}

/**
 * A failed LLM call: HTTP status/body, the CORS flag, the raw content, and
 * whether the caller aborted it. An aborted call is not a failure of the
 * endpoint, so the view reports it as "Cancelled" rather than as an error.
 */
export class LlmError extends Error {
  constructor(message, { status = 0, body = "", cors = false, raw = null,
                         aborted = false } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = status;
    this.body = body;
    this.cors = cors;
    this.raw = raw;
    this.aborted = aborted;
  }
}

function endpointUrl({ apiKind, apiUrl, model, apiVersion }) {
  const base = String(apiUrl || "").replace(/\/+$/, "");
  if (apiKind === "azure") {
    return (
      base +
      "/openai/deployments/" +
      encodeURIComponent(model) +
      "/chat/completions?api-version=" +
      encodeURIComponent(apiVersion || "")
    );
  }
  return base + "/chat/completions";
}

function authHeaders({ apiKind, apiKey }) {
  const headers = { "Content-Type": "application/json" };
  if (!apiKey) return headers;
  if (apiKind === "azure") headers["api-key"] = apiKey;
  else headers.Authorization = "Bearer " + apiKey;
  return headers;
}

// The statuses an endpoint that cannot do structured output answers with.
// OpenAI itself says 400; llama.cpp and vLLM behind a proxy have been seen
// to answer 404 (the route exists only with the feature), 415, 422 (the body
// failed validation) and 501 (not implemented). The body still has to name
// the field, so a genuine 404 for a wrong URL is not retried.
const SCHEMA_REJECTION = [400, 404, 415, 422, 501];

/** A request whose body was rejected because the model lacks json_schema. */
function isSchemaRejection(status, body) {
  if (SCHEMA_REJECTION.indexOf(status) === -1) return false;
  const text = String(body || "");
  return text.includes("response_format") || text.includes("json_schema");
}

/**
 * An OpenAI-compatible chat client.
 *
 * `complete({system, user, schemaName, schema, signal})` returns the parsed
 * object, or throws LlmError. `signal` is an AbortSignal: aborting it - by
 * the Cancel button, by the run timeout, or by leaving the view - rejects
 * with an LlmError carrying `aborted`.
 */
export function createClient({ apiKind, apiUrl, model, apiVersion, apiKey, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...args) => globalObject.fetch(...args));
  const url = endpointUrl({ apiKind, apiUrl, model, apiVersion });
  const headers = authHeaders({ apiKind, apiKey });

  async function post(body, signal) {
    let res;
    try {
      const init = {
        method: "POST",
        headers,
        credentials: "omit",
        body: JSON.stringify(body),
      };
      // Only set when the caller gave one, so a fetch that knows nothing of
      // signals is not handed an undefined.
      if (signal) init.signal = signal;
      res = await doFetch(url, init);
    } catch (err) {
      // An abort is the caller's own doing and says nothing about the
      // endpoint, so it is never reported as a network failure.
      if (err && err.name === "AbortError") {
        throw new LlmError("The run was cancelled.", { aborted: true });
      }
      // A browser reports a blocked cross-origin request as a TypeError with
      // no status; there is nothing else to distinguish it by.
      if (err instanceof TypeError) {
        return { ok: false, status: 0, cors: true, body: err.message };
      }
      throw err;
    }
    const text = await res.text();
    return { ok: res.ok, status: res.status, cors: false, body: text };
  }

  function bodyFor({ system, user, schemaName, schema }) {
    return {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, schema, strict: true },
      },
    };
  }

  function fallbackBody({ system, user, schema }) {
    const withSchema =
      system +
      "\n\nYour answer must be a single JSON object matching this JSON Schema " +
      "exactly (no prose, no code fence):\n" +
      JSON.stringify(schema);
    return {
      model,
      temperature: 0,
      messages: [
        { role: "system", content: withSchema },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    };
  }

  async function complete(req) {
    const signal = req && req.signal;
    let res = await post(bodyFor(req), signal);
    if (!res.ok && isSchemaRejection(res.status, res.body)) {
      res = await post(fallbackBody(req), signal);
    }
    if (!res.ok) {
      const where = res.cors
        ? "the request never reached " + url + " (blocked, offline, or no CORS headers)"
        : "HTTP " + res.status + " from " + url;
      throw new LlmError("LLM request failed: " + where, {
        status: res.status,
        body: res.body,
        cors: res.cors,
      });
    }

    let envelope;
    try {
      envelope = JSON.parse(res.body);
    } catch (err) {
      throw new LlmError("LLM response was not JSON", {
        status: res.status,
        body: res.body,
        raw: res.body,
      });
    }
    const choice = envelope && envelope.choices && envelope.choices[0];
    const content = choice && choice.message ? choice.message.content : null;
    if (typeof content !== "string") {
      throw new LlmError("LLM response carried no message content", {
        status: res.status,
        body: res.body,
        raw: res.body,
      });
    }
    const cleaned = stripThink(content);
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new LlmError("LLM did not answer with JSON", {
        status: res.status,
        body: res.body,
        raw: cleaned,
      });
    }
    // Both schemas describe an object. A model that answered with a bare
    // list, string or null parses fine and then fails much later, in a view
    // reading a property off it, with nothing left to show the operator.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new LlmError("LLM answered with JSON, but not an object", {
        status: res.status,
        body: res.body,
        raw: cleaned,
      });
    }
    return parsed;
  }

  return { complete };
}

function ecsLookup(ecs) {
  if (!ecs) return () => false;
  if (ecs instanceof Set) return (name) => ecs.has(name);
  if (Array.isArray(ecs)) return (name) => ecs.includes(name);
  const fields =
    Object.prototype.hasOwnProperty.call(ecs, "fields") && ecs.fields && typeof ecs.fields === "object"
      ? ecs.fields
      : ecs;
  return (name) => Object.prototype.hasOwnProperty.call(fields, name);
}

/** A deep copy of a JSON value, so annotating never edits the caller's own. */
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * The names in one suggestion: models asked for a single ECS target
 * sometimes answer with several ("source.ip, client.ip"), which as one
 * string is never in the dictionary and would be struck through whole.
 */
function splitNames(value) {
  const out = [];
  for (const part of String(value).split(",")) {
    const name = part.trim();
    if (name !== "") out.push(name);
  }
  return out;
}

/**
 * Annotate every ECS name the model suggested with `ecs_known`, so the report
 * can strike through names that are not in the dictionary. A null suggestion
 * stays null: there is nothing to check.
 *
 * A comma-separated answer is split: `ecs_list` carries the names and
 * `ecs_known` is one boolean per name, in the same order, for a renderer to
 * mark each one on its own. A single name keeps the plain boolean.
 *
 * The annotated result is a copy: nothing the caller handed in is edited, so
 * a caller that keeps the model's own answer - to re-check it against another
 * dictionary, or to show what was actually returned - still has it untouched.
 * The analyze view does not keep one today; this is hygiene, not a promise
 * anything currently relies on.
 */
export function checkEcsNames(result, ecs) {
  const known = ecsLookup(ecs);
  const mark = (items, key) => {
    for (const item of items || []) {
      if (!item || typeof item !== "object") continue;
      const value = item[key];
      if (value === null || value === undefined || value === "") {
        item.ecs_known = null;
        continue;
      }
      const names = splitNames(value);
      if (names.length === 0) {
        item.ecs_known = null;
      } else if (names.length === 1) {
        item.ecs_known = known(names[0]);
      } else {
        item.ecs_list = names;
        item.ecs_known = names.map((name) => known(name));
      }
    }
  };
  if (!result || typeof result !== "object") return result;
  const copy = clone(result);
  mark(copy.observed_fields, "suggested_ecs");
  mark(copy.alerting_gaps, "ecs");
  return copy;
}
