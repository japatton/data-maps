// Secrets and per-workstation overrides live only in the browser: session
// storage by default, local storage when the admin asks to be remembered.
// Storages are injectable so the tests never need a DOM.

import { globalObject } from "./global.js";

export const STORAGE_KEY = "datamaps-studio-settings";

export const KEYS = [
  "repoToken",
  "repoUrl",
  "llmKey",
  "llmUrl",
  "llmModel",
  "llmKind",
  "llmApiVersion",
  "elasticUrl",
  "elasticKey",
];

export function loadSettings({
  session = globalObject.sessionStorage,
  local = globalObject.localStorage,
} = {}) {
  const remembered = readRecord(local);
  if (remembered) return { values: remembered, remembered: true };
  const transient = readRecord(session);
  if (transient) return { values: transient, remembered: false };
  return { values: emptyValues(), remembered: false };
}

export function saveSettings(values, {
  remember = false,
  session = globalObject.sessionStorage,
  local = globalObject.localStorage,
} = {}) {
  // Every value is trimmed on the way in: a token or URL pasted with a
  // trailing space or newline is the commonest cause of a 401 that reads
  // like a permissions problem, and no setting here is meant to carry
  // surrounding whitespace.
  const record = {};
  for (const key of KEYS) {
    record[key] = typeof values[key] === "string" ? values[key].trim() : "";
  }
  const target = remember ? local : session;
  const other = remember ? session : local;
  target.setItem(STORAGE_KEY, JSON.stringify(record));
  other.removeItem(STORAGE_KEY);
}

export function clearSettings({
  session = globalObject.sessionStorage,
  local = globalObject.localStorage,
} = {}) {
  session.removeItem(STORAGE_KEY);
  local.removeItem(STORAGE_KEY);
}

// The site config with the browser-held overrides applied: a non-empty
// override wins, an empty one leaves the configured value alone.
//
// One exception: a site may pin the analysis endpoint with
// `analysis.allow_override: false`, and then the URL, model, kind and
// api-version come from the published configuration whatever this browser
// has stored.  The stored values are ignored rather than erased, so a
// browser that has them keeps them for a site that allows them.  The key is
// never pinned: it belongs to the person, not to the deployment, and the
// published config never carries one.  `analysis.locked` says which of the
// two worlds the caller is in, so the views need not reread the config.
export function effectiveConfig(config, values) {
  const repository = config.repository || {};
  const analysis = config.analysis || {};
  const elastic = config.elastic || {};
  // An older config with no such key is an unlocked one: absent means true.
  const locked = analysis.allow_override === false;
  // The lock applies per key rather than per branch: the repository and
  // Elastic overrides are how an admin reaches a dev proxy and keep working
  // either way, and so does the analysis key, which belongs to the person
  // and never appears in the published config.
  const pinned = locked
    ? (value, fallback) => fallback
    : override;
  return {
    repository: {
      ...repository,
      api_url: override(values.repoUrl, repository.api_url),
      token: text(values.repoToken),
    },
    analysis: {
      api_kind: pinned(values.llmKind, analysis.api_kind),
      api_url: pinned(values.llmUrl, analysis.api_url),
      model: pinned(values.llmModel, analysis.model),
      api_version: pinned(values.llmApiVersion, analysis.api_version),
      api_key: text(values.llmKey),
      locked,
    },
    elastic: {
      url: override(values.elasticUrl, elastic.url),
      api_key: text(values.elasticKey),
    },
  };
}

function override(value, fallback) {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function emptyValues() {
  const values = {};
  for (const key of KEYS) values[key] = "";
  return values;
}

// Returns null when there is no usable record, so the caller can fall
// through to the next storage. Unknown keys are dropped.
function readRecord(storage) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch (err) {
    return null;
  }
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const values = emptyValues();
  for (const key of KEYS) {
    if (typeof parsed[key] === "string") values[key] = parsed[key];
  }
  return values;
}
