// The logic behind #/analyze — everything the workbench decides, with no DOM
// in it.  views/analyze.js owns the nodes and calls in here for the answers:
// what the sample is, which buttons may be pressed, what a run does, and
// which of the finished steps still describe what is on screen.
//
// The client and the fetchers are injected rather than imported here, so the
// runs below can be driven end to end from a test with no network, no
// browser and no clock.

import { globalObject } from "./global.js";
import {
  takeSample, buildCatalogDigest, identifyPrompt, assessPrompt,
  IDENTIFY_SCHEMA, ASSESS_SCHEMA, checkEcsNames,
} from "./llm.js";
import { dataStreamOf, fieldPresence } from "./elastic.js";
import { explain } from "./net.js";
import { routeSummary, requiredEcs } from "./report.js";

// The whole file is kept in the browser; only the head of it is ever sent.
// Bytes, not characters: a UTF-8 log full of accented vendor names is half
// again as long on the wire as it looks here.
export const MAX_INPUT = 200 * 1024;
export const MAX_INPUT_LABEL = "200 KB";
// How many technology documents to fetch at once for the catalog digest.
export const FETCH_WIDTH = 6;
export const ES_SAMPLE_SIZE = 5;
// A local model on a small box can think for a long time, so the ceiling is
// generous: it is there to stop a run hanging for the rest of the session,
// not to hurry the model along.
export const RUN_TIMEOUT_MS = 20 * 60 * 1000;
export const RUN_TIMEOUT_LABEL = "20 minutes";

// --- the state ------------------------------------------------------------

export function idleStep() {
  return {
    status: "idle", ms: 0, error: null, result: null, dataStream: null,
    stamp: null, controller: null, note: null,
  };
}

/** Everything one visit to the workbench accumulates. */
export function createState() {
  return {
    text: "",
    clipped: false,
    fileName: null,
    progress: null,          // {done, total} while the digest is loading
    identify: idleStep(),
    choice: { techId: "", datasetId: "", format: "" },
    assess: idleStep(),
    elastic: idleStep(),
    // {technology id: why its document could not be fetched}
    docErrors: {},
    // The Elastic URL the panel would query, as of the last paint.
    elasticUrl: "",
  };
}

// The run survives a trip to Settings and back: the shell rebuilds the view
// from scratch on every route change, so what was pasted lives here.  Tests
// take their own with createState().
export const state = createState();

// The error an abort raises inside Studio's own loops, shaped like the one
// the client throws so the run's catch reports it as a cancellation.
export function cancelled() {
  const err = new Error("The run was cancelled.");
  err.aborted = true;
  return err;
}

// A run the admin cancelled, or one the timeout cut off: not an error, and
// not an answer either, so it is reported plainly with a way to run again.
export function cancelledStep(started, stamp, timedOut) {
  return {
    ...idleStep(),
    status: "cancelled",
    ms: Date.now() - started,
    stamp,
    note: timedOut
      ? `Cancelled: no answer after ${RUN_TIMEOUT_LABEL}.`
      : "Cancelled.",
  };
}

// --- the sample -----------------------------------------------------------

// A cheap content key for the pasted sample (FNV-1a plus the length), so a
// result can be told apart from what is on screen now.
//
// Memoised on the string it was computed from: every repaint stamps the
// inputs several times over, and hashing 200 KB once per panel per keystroke
// is the one loop in this view long enough to be felt.  The cache holds a
// reference to the very string `state.text` already holds, so it costs
// nothing beyond the key itself.
let keyCache = { text: null, key: "" };

export function textKey(text) {
  if (keyCache.text === text) return keyCache.key;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const key = (hash >>> 0).toString(36) + ":" + text.length;
  keyCache = { text, key };
  return key;
}

// The head of `text` that fits in `maxBytes` of UTF-8, cut on a character
// boundary (and never between the halves of a surrogate pair, which would
// send a replacement character instead of the emoji or CJK glyph it splits).
export function clipToBytes(text, maxBytes) {
  const Encoder = globalObject.TextEncoder;
  if (typeof Encoder !== "function") {
    // No encoder to measure with: the character count is the only cap
    // available, and it never keeps more bytes than it claims.
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const encoder = new Encoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let cut = low;
  const last = cut > 0 ? text.charCodeAt(cut - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * What an input event has to write back into the box, or null when it has
 * nothing to write.
 *
 * Only an event that actually clipped is answered: once the sample sits at
 * the cap, every further keystroke is over it, and reassigning the value on
 * each one - which is what putting the caret at the end amounts to - made
 * editing anywhere but the tail impossible.  The cut is always at the end, so
 * a caret before it does not move; one at or past it lands on the new end.
 */
export function clipEdit(incoming, kept, caret) {
  const text = String(incoming === null || incoming === undefined
    ? "" : incoming);
  if (text.length <= kept.length) return null;
  const at = typeof caret === "number" && caret >= 0
    ? Math.min(caret, kept.length)
    : kept.length;
  return { value: kept, caret: at };
}

/** Take a pasted or opened sample, clipped to the cap. */
export function setText(current, text, fileName) {
  const body = String(text || "");
  const kept = clipToBytes(body, MAX_INPUT);
  current.clipped = kept !== body;
  current.text = kept;
  current.fileName = fileName;
  return current;
}

/** The head of the sample that a run actually sends. */
export function sampleInfo(current) {
  return takeSample(current.text);
}

// --- the endpoint ---------------------------------------------------------

/**
 * The host part of an endpoint URL, for a line that says where a run goes
 * without repeating the whole path: "192.0.2.10:11434".
 *
 * Hand-parsed rather than `new URL()`, because this module has to import
 * under Node with no DOM and no base URL to resolve a relative override
 * against: a relative URL is the dev proxy, which is this site.  A value
 * with no scheme is relative unless its first segment could be an
 * authority - it holds a dot or a colon - so "llm/v1" reads as this site
 * while "localhost:11434/v1" and "es.example/v1" name a host.  Any userinfo
 * is dropped — an endpoint written with a key in it must not put that key
 * on the page.
 */
export function endpointHost(url) {
  const text = typeof url === "string" ? url.trim() : "";
  if (text === "") return "";
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(text);
  const rest = scheme ? text.slice(scheme[0].length) : text;
  if (!scheme && rest.charAt(0) === "/") return "this site";
  const authority = rest.split(/[/?#]/)[0];
  if (!scheme && authority.indexOf(".") === -1
      && authority.indexOf(":") === -1) {
    return "this site";
  }
  const at = authority.lastIndexOf("@");
  const host = at === -1 ? authority : authority.slice(at + 1);
  return host === "" ? "this site" : host;
}

/**
 * The one-line answer to "where is this going": "Model: llama3.1:8b at
 * 192.0.2.10:11434".  Whichever half is missing is left out rather than
 * written as an empty string, so a half-configured site still reads.
 */
export function endpointLabel(analysis) {
  const cfg = analysis || {};
  const model = typeof cfg.model === "string" ? cfg.model.trim() : "";
  const host = endpointHost(cfg.api_url);
  if (model === "" && host === "") return "";
  if (host === "") return `Model: ${model}`;
  if (model === "") return `Endpoint: ${host}`;
  return `Model: ${model} at ${host}`;
}

// --- stamps and staleness -------------------------------------------------

/** The inputs every step is computed from, as they stand right now. */
export function inputStamp(current) {
  return {
    sample: textKey(current.text),
    tech: current.choice.techId,
    dataset: current.choice.datasetId,
    format: current.choice.format,
    // A sample is about one cluster: clearing or changing the Elastic URL in
    // Settings makes an answer from the old one exactly as stale as changing
    // the dataset would.
    elasticUrl: current.elasticUrl,
  };
}

// Which of those inputs each step actually depends on. Identify reads only
// the sample; assess reads the sample and the chosen entry; the Elastic
// sample reads only the chosen entry.
export const STAMP_KEYS = {
  identify: ["sample"],
  assess: ["sample", "tech", "dataset", "format"],
  elastic: ["tech", "dataset", "format", "elasticUrl"],
};

/**
 * The step as it should be shown: a finished run whose inputs have since
 * changed is reported as stale rather than passed off as an answer about what
 * is on screen now. Nothing is thrown away — re-running replaces it.
 */
export function shown(current, step, kind) {
  const settled = step.status === "done" || step.status === "error"
    || step.status === "cancelled";
  if (!settled || !step.stamp) return step;
  const now = inputStamp(current);
  const changed = STAMP_KEYS[kind].some((key) => step.stamp[key] !== now[key]);
  return changed ? { ...idleStep(), status: "stale" } : step;
}

// --- the chosen catalog entry ---------------------------------------------

export function datasetsOf(doc) {
  return doc && Array.isArray(doc.datasets) ? doc.datasets : [];
}

export function formatsOf(dataset) {
  return dataset && Array.isArray(dataset.formats) ? dataset.formats : [];
}

/** The catalog row, document, dataset and format the choice names. */
export function pick({ state: current, catalog, docs }) {
  const row = (catalog || []).find(
    (item) => item && item.id === current.choice.techId) || null;
  const doc = docFor(docs, current.choice.techId);
  const dataset = datasetsOf(doc).find(
    (item) => item && item.id === current.choice.datasetId) || null;
  const format = formatsOf(dataset).find(
    (item) => item && item.format === current.choice.format) || null;
  return { row, doc, dataset, format };
}

function docFor(docs, id) {
  if (!id || !docs) return null;
  const doc = docs.get(id);
  return doc || null;
}

// Load the document behind a hand-picked technology, then repaint. A
// failure is recorded rather than swallowed: "no map file yet" and "the
// fetch failed" are different answers and the admin needs to know which.
export function ensureDoc(id, { state: current, docs, repaint }) {
  if (!id || docs.has(id)) return;
  docs.load(id).then(() => {
    delete current.docErrors[id];
    repaint("choice", "assess", "elastic", "report");
  }, (err) => {
    current.docErrors[id] = message(err);
    repaint("choice", "assess", "elastic", "report");
  });
}

/** What the identification says the entry is, as far as the catalog agrees. */
export async function prefill(result, { state: current, catalog, docs }) {
  const techId = String((result && result.technology_id) || "");
  const known = (catalog || []).some((row) => row && row.id === techId);
  current.choice = { techId: known ? techId : "", datasetId: "", format: "" };
  if (!known) return;
  if (!docs.has(techId)) {
    try {
      await docs.load(techId);
      delete current.docErrors[techId];
    } catch (err) {
      // The same distinction ensureDoc keeps: "no map file yet" and "the
      // fetch failed" are different answers, and the choice panel says
      // which one this was.
      current.docErrors[techId] = message(err);
      return;
    }
  }
  const dataset = datasetsOf(docFor(docs, techId)).find(
    (item) => item && item.id === result.dataset_id);
  if (!dataset) return;
  current.choice.datasetId = dataset.id;
  const format = formatsOf(dataset).find(
    (item) => item && item.format === result.format);
  if (format) current.choice.format = format.format;
}

// --- what may be pressed --------------------------------------------------

export function llmReady(config) {
  const cfg = config || {};
  return Boolean(cfg.apiUrl) && Boolean(cfg.model);
}

/** Identify needs an endpoint and something to send. */
export function identifyRules({ state: current, step, config }) {
  const ready = llmReady(config);
  const hasText = current.text.trim() !== "";
  const running = step.status === "running";
  return { ready, hasText, running, enabled: !running && ready && hasText };
}

/**
 * Assess needs all of that plus a chosen entry — and no identification in
 * flight, which rewrites the chosen entry when it lands, so an assessment
 * started underneath it would be about an entry nobody picked.
 */
export function assessRules({ state: current, step, config, picked }) {
  const identifying = current.identify.status === "running";
  const chosen = Boolean(picked && picked.dataset && picked.format);
  const ready = chosen && llmReady(config) && current.text.trim() !== ""
    && !identifying;
  const running = step.status === "running";
  return { identifying, chosen, ready, running, enabled: !running && ready };
}

/**
 * The Elastic panel is only offered when there is somewhere to ask and
 * something to ask for; the button needs a format to read the mapping from.
 */
export function elasticRules({ step, stream, url, format }) {
  const configured = String(url || "") !== "";
  const running = step.status === "running";
  return {
    configured,
    visible: configured && Boolean(stream),
    running,
    enabled: !running && Boolean(format),
  };
}

// --- running --------------------------------------------------------------

// Everything one model run needs to be stoppable: the signal it passes to
// the client, the timeout, and the listener that gives up on it when the
// admin navigates away.  `done()` is called however the run ends.
//
// The timer and the event target are injectable so a test can fire the
// timeout without waiting twenty minutes for it.
export function startRun(options) {
  const opts = options || {};
  const ms = typeof opts.timeoutMs === "number" ? opts.timeoutMs
    : RUN_TIMEOUT_MS;
  const setTimer = typeof opts.setTimer === "function"
    ? opts.setTimer
    : (fn, delay) => globalObject.setTimeout(fn, delay);
  const clearTimer = typeof opts.clearTimer === "function"
    ? opts.clearTimer
    : (handle) => globalObject.clearTimeout(handle);
  const events = opts.events === undefined ? globalObject : opts.events;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimer(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onHash = () => controller.abort();
  const watchable = Boolean(events)
    && typeof events.addEventListener === "function";
  if (watchable) events.addEventListener("hashchange", onHash);
  return {
    controller,
    timedOut: () => timedOut,
    done() {
      clearTimer(timer);
      if (watchable) events.removeEventListener("hashchange", onHash);
    },
  };
}

/**
 * Every mapped technology's document, for the catalog digest.
 *
 * `signal` is the run's own: Cancel during the catalog read stops it at the
 * next document rather than after all 87.  A technology whose document will
 * not load is simply absent from the digest; one 404 must not stop the
 * identification.
 */
export async function loadSources({ state: current, catalog, load, repaint,
                                    signal, width }) {
  const rows = (catalog || []).filter(
    (row) => row && row.id && row.status !== "planned");
  current.progress = { done: 0, total: rows.length };
  const sources = {};
  const queue = rows.slice();
  async function worker() {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (signal && signal.aborted) return;
      let doc = null;
      try {
        doc = await load(row.id);
      } catch (err) {
        doc = null;
      }
      if (doc) sources[row.id] = doc;
      current.progress.done += 1;
      repaint("identify");
    }
  }
  const wanted = typeof width === "number" ? width : FETCH_WIDTH;
  const workers = Math.max(1, Math.min(wanted, rows.length));
  await Promise.all(Array.from({ length: workers }, worker));
  current.progress = null;
  if (signal && signal.aborted) throw cancelled();
  return sources;
}

/**
 * Step 1: ask the model which catalog entry the sample is, then prefill the
 * choice with whatever it named.
 */
export async function runIdentify(deps) {
  const current = deps.state;
  const repaint = deps.repaint;
  const stamp = inputStamp(current);
  const run = (deps.startRun || startRun)();
  current.identify = {
    ...idleStep(), status: "running", stamp, controller: run.controller,
  };
  // Assess is disabled while this runs, so its panel repaints too.
  repaint("identify", "assess");
  const started = Date.now();
  try {
    const sources = await deps.loadSources(run.controller.signal);
    // The status line still reads "reading the catalog"; the slow part is
    // about to start, so say so before waiting on it.
    repaint("identify");
    const digest = buildCatalogDigest(deps.catalog, sources);
    const prompt = identifyPrompt(digest, deps.sampleInfo());
    const result = await deps.client.complete({
      ...prompt, schemaName: "identification", schema: IDENTIFY_SCHEMA,
      signal: run.controller.signal,
    });
    current.identify = {
      ...idleStep(), status: "done", ms: Date.now() - started, result, stamp,
    };
    await prefill(result, deps);
  } catch (err) {
    current.progress = null;
    current.identify = err && err.aborted
      ? cancelledStep(started, stamp, run.timedOut())
      : {
        ...idleStep(), status: "error", ms: Date.now() - started, stamp,
        error: describe(err),
      };
  } finally {
    run.done();
  }
  repaint("identify", "choice", "assess", "elastic", "report");
  return current.identify;
}

/** What the model is told about the entry it is assessing the sample against. */
export function assessContext({ state: current, picked, schema }) {
  const { row, dataset, format } = picked;
  return {
    technology: {
      id: row ? row.id : current.choice.techId,
      name: row ? row.name : "",
      vendor: row ? row.vendor : "",
    },
    dataset: {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description,
      event_categories: dataset.event_categories || [],
      route_summary: routeSummary(dataset.route),
    },
    format,
    other_formats: formatsOf(dataset)
      .map((item) => item && item.format)
      .filter((name) => name && name !== format.format),
    required_ecs: requiredEcs(dataset, schema),
    ecs_version: schema.ecs_version,
    mechanisms: (schema.vocab || {}).mechanisms || [],
  };
}

/** Step 2: how well the chosen entry covers the sample. */
export async function runAssess(deps) {
  const current = deps.state;
  const repaint = deps.repaint;
  // Retry survives a choice being cleared underneath it.
  const picked = typeof deps.choice === "function" ? deps.choice() : deps.choice;
  if (!picked || !picked.dataset || !picked.format) {
    current.assess = {
      // Stamped like any other outcome, so choosing an entry retires this
      // complaint instead of leaving it under the button that answers it.
      ...idleStep(), status: "error", stamp: inputStamp(current),
      error: {
        message: "Choose a technology, dataset and format first.", detail: null,
      },
    };
    repaint("assess", "report");
    return current.assess;
  }
  const stamp = inputStamp(current);
  const run = (deps.startRun || startRun)();
  current.assess = {
    ...idleStep(), status: "running", stamp, controller: run.controller,
  };
  repaint("assess");
  const started = Date.now();
  try {
    const prompt = assessPrompt(
      assessContext({ state: current, picked, schema: deps.schema }),
      deps.sampleInfo());
    const raw = await deps.client.complete({
      ...prompt, schemaName: "assessment", schema: ASSESS_SCHEMA,
      signal: run.controller.signal,
    });
    current.assess = {
      ...idleStep(), status: "done", ms: Date.now() - started, stamp,
      result: checkEcsNames(raw, deps.schema.ecs),
    };
  } catch (err) {
    current.assess = err && err.aborted
      ? cancelledStep(started, stamp, run.timedOut())
      : {
        ...idleStep(), status: "error", ms: Date.now() - started, stamp,
        error: describe(err),
      };
  } finally {
    run.done();
  }
  repaint("assess", "report");
  return current.assess;
}

/** Step 3: which of the mapped ECS targets the cluster actually populates. */
export async function runElastic(deps) {
  const current = deps.state;
  const repaint = deps.repaint;
  const picked = typeof deps.choice === "function" ? deps.choice() : deps.choice;
  const dataset = picked ? picked.dataset : null;
  const format = picked ? picked.format : null;
  const stream = dataStreamOf(dataset);
  const config = deps.config || {};
  current.elasticUrl = String(config.url || "");
  const stamp = inputStamp(current);
  current.elastic = {
    ...idleStep(), status: "running", dataStream: stream, stamp,
  };
  repaint("elastic");
  const started = Date.now();
  try {
    const res = await deps.client.sample(config, stream, ES_SAMPLE_SIZE);
    if (!res.ok) {
      current.elastic = {
        ...idleStep(), status: "error", ms: Date.now() - started, stamp,
        dataStream: stream, error: { message: explain(res), detail: null },
      };
    } else {
      const presence = fieldPresence(res.docs, (format && format.fields) || []);
      current.elastic = {
        ...idleStep(), status: "done", ms: Date.now() - started, stamp,
        dataStream: stream,
        result: {
          dataStream: stream,
          docCount: res.docs.length,
          targets: presence.targets,
          extras: presence.extras,
        },
      };
    }
  } catch (err) {
    current.elastic = {
      ...idleStep(), status: "error", ms: Date.now() - started, stamp,
      dataStream: stream, error: describe(err),
    };
  }
  repaint("elastic", "report");
  return current.elastic;
}

// --- the report -----------------------------------------------------------

/** What reportMarkdown is given: only the steps still current on screen. */
export function reportInput({ state: current, picked, schema }) {
  const row = picked ? picked.row : null;
  const dataset = picked ? picked.dataset : null;
  // Only a step still current for what is on screen goes in: the report
  // must never pair one catalog entry with another entry's assessment.
  const identify = shown(current, current.identify, "identify");
  const assess = shown(current, current.assess, "assess");
  const elasticStep = shown(current, current.elastic, "elastic");
  const elastic = elasticStep.status === "done"
    ? elasticStep.result
    : (elasticStep.status === "error"
      ? { dataStream: elasticStep.dataStream, error: elasticStep.error.message }
      : null);
  return {
    identify: identify.status === "done" ? identify.result : null,
    choice: dataset
      ? {
        technology: row || { id: current.choice.techId },
        dataset: { id: dataset.id, name: dataset.name },
        format: current.choice.format,
      }
      : null,
    assess: assess.status === "done" ? assess.result : null,
    elastic,
    ecsVersion: schema.ecs_version,
  };
}

// --- errors ---------------------------------------------------------------

export function message(err) {
  return (err && err.message) ? err.message : String(err);
}

// An LlmError carries the endpoint's own words; a parse failure carries the
// model's raw text. Both belong on screen rather than in the console.
export function describe(err) {
  const detail = err && (err.raw || err.body);
  return {
    message: message(err),
    detail: detail ? String(detail).slice(0, 4000) : null,
  };
}
