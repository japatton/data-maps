import test from "node:test";
import assert from "node:assert/strict";
import { KEYS, loadSettings, saveSettings, clearSettings, effectiveConfig } from "../lib/settings.js";
import {
  collectValues, visibleKeys, analysisLocked, LOCKED_KEYS, LOCK_NOTICE,
} from "../views/settings.js";

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

// A browser told to block site data throws on the mere sight of storage:
// enterprise policy and private mode both do it.
function refusingStorage(why) {
  return {
    getItem() { throw new Error(why); },
    setItem() { throw new Error(why); },
    removeItem() { throw new Error(why); },
  };
}

const KEY = "datamaps-studio-settings";

function baseConfig() {
  return {
    repository: { kind: "gitlab", api_url: "https://g/api/v4", project: "soc/data-maps", default_branch: "main", web_ide_url: "https://g/-/ide/{project}/{branch}/{path}" },
    analysis: { api_kind: "openai", api_url: "https://api.openai.com/v1", model: "gpt-4.1", api_version: "" },
    elastic: { url: "" },
  };
}

test("KEYS is the agreed list", () => {
  assert.deepEqual(KEYS, ["repoToken", "repoUrl", "llmKey", "llmUrl", "llmModel", "llmKind", "llmApiVersion", "elasticUrl", "elasticKey"]);
});

test("loadSettings on empty storages returns empty values and remembered false", () => {
  const session = fakeStorage(), local = fakeStorage();
  const { values, remembered } = loadSettings({ session, local });
  assert.equal(remembered, false);
  assert.deepEqual(Object.keys(values).sort(), [...KEYS].sort());
  for (const k of KEYS) assert.equal(values[k], "");
});

test("saveSettings writes to session by default and not to local", () => {
  const session = fakeStorage(), local = fakeStorage();
  saveSettings({ repoToken: "T" }, { remember: false, session, local });
  assert.deepEqual(JSON.parse(session.getItem(KEY)).repoToken, "T");
  assert.equal(local.getItem(KEY), null);
  const loaded = loadSettings({ session, local });
  assert.equal(loaded.values.repoToken, "T");
  assert.equal(loaded.values.llmKey, "");
  assert.equal(loaded.remembered, false);
});

test("remember true moves the record to local and clears session", () => {
  const session = fakeStorage(), local = fakeStorage();
  saveSettings({ repoToken: "T" }, { remember: false, session, local });
  saveSettings({ repoToken: "T", llmKey: "K" }, { remember: true, session, local });
  assert.equal(session.getItem(KEY), null);
  assert.equal(JSON.parse(local.getItem(KEY)).llmKey, "K");
  const loaded = loadSettings({ session, local });
  assert.equal(loaded.remembered, true);
  assert.equal(loaded.values.llmKey, "K");
});

test("loadSettings prefers local when both hold a record", () => {
  const session = fakeStorage(), local = fakeStorage();
  session.setItem(KEY, JSON.stringify({ repoToken: "session" }));
  local.setItem(KEY, JSON.stringify({ repoToken: "local" }));
  const { values, remembered } = loadSettings({ session, local });
  assert.equal(values.repoToken, "local");
  assert.equal(remembered, true);
});

test("loadSettings ignores unknown keys and unparseable records", () => {
  const session = fakeStorage(), local = fakeStorage();
  session.setItem(KEY, JSON.stringify({ repoToken: "T", bogus: "x" }));
  const { values } = loadSettings({ session, local });
  assert.equal(values.repoToken, "T");
  assert.equal("bogus" in values, false);
  const s2 = fakeStorage();
  s2.setItem(KEY, "{not json");
  const r2 = loadSettings({ session: s2, local: fakeStorage() });
  assert.equal(r2.values.repoToken, "");
  assert.equal(r2.remembered, false);
});

test("clearSettings empties both storages", () => {
  const session = fakeStorage(), local = fakeStorage();
  session.setItem(KEY, JSON.stringify({ repoToken: "a" }));
  local.setItem(KEY, JSON.stringify({ repoToken: "b" }));
  clearSettings({ session, local });
  assert.equal(session.getItem(KEY), null);
  assert.equal(local.getItem(KEY), null);
  assert.equal(loadSettings({ session, local }).values.repoToken, "");
});

// Closing the browser is what "remember" is about, and it is the one thing
// the storage doubles cannot show by themselves: session storage does not
// come back, local storage does.  A fresh session double is that restart.
test("a remembered record survives the browser closing", () => {
  const local = fakeStorage();
  saveSettings({ llmKey: "K", repoToken: "T" },
               { remember: true, session: fakeStorage(), local });
  const after = loadSettings({ session: fakeStorage(), local });
  assert.equal(after.remembered, true);
  assert.equal(after.values.llmKey, "K");
  assert.equal(after.values.repoToken, "T");
});

test("a session record does not survive the browser closing", () => {
  const session = fakeStorage(), local = fakeStorage();
  saveSettings({ llmKey: "K" }, { remember: false, session, local });
  const after = loadSettings({ session: fakeStorage(), local });
  assert.equal(after.remembered, false);
  assert.equal(after.values.llmKey, "");
});

// Unchecking the box is a withdrawal of consent, so the copy on disk has to
// go.  Leaving it would keep answering loadSettings - local wins over
// session - and the admin would be told the key is held for this session
// only while it sat in local storage until someone cleared it by hand.
test("turning remember off erases the remembered copy", () => {
  const session = fakeStorage(), local = fakeStorage();
  saveSettings({ llmKey: "K" }, { remember: true, session, local });
  saveSettings({ llmKey: "K" }, { remember: false, session, local });
  assert.equal(local.getItem(KEY), null);
  assert.equal(loadSettings({ session: fakeStorage(), local }).values.llmKey, "");
});

// The read degrades to empty values so the shell still boots; the write is
// left to throw, because a save that quietly did nothing would tell the
// admin their key was kept when it was not.  views/settings.js catches it
// and puts the reason on screen.
test("a browser that refuses storage loses the values, not the page", () => {
  const refusing = refusingStorage("the user denied site data");
  const loaded = loadSettings({ session: refusing, local: refusing });
  assert.equal(loaded.remembered, false);
  for (const k of KEYS) assert.equal(loaded.values[k], "");
  assert.throws(
    () => saveSettings({ llmKey: "K" },
                       { remember: true, session: fakeStorage(), local: refusing }),
    /denied site data/);
});

test("effectiveConfig with no overrides is the config plus empty secrets", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  const eff = effectiveConfig(baseConfig(), values);
  assert.deepEqual(eff.repository, { kind: "gitlab", api_url: "https://g/api/v4", project: "soc/data-maps", default_branch: "main", web_ide_url: "https://g/-/ide/{project}/{branch}/{path}", token: "" });
  assert.deepEqual(eff.analysis, { api_kind: "openai", api_url: "https://api.openai.com/v1", model: "gpt-4.1", api_version: "", api_key: "", locked: false });
  assert.deepEqual(eff.elastic, { url: "", api_key: "" });
});

test("effectiveConfig lets non-empty overrides win and ignores empty ones", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  const eff = effectiveConfig(baseConfig(), {
    ...values,
    repoToken: "T",
    repoUrl: "https://other/api/v4",
    llmUrl: "http://ollama:11434/v1",
    llmModel: "",
    llmKey: "K",
    elasticUrl: "https://es.example",
    elasticKey: "E",
  });
  assert.equal(eff.repository.api_url, "https://other/api/v4");
  assert.equal(eff.repository.token, "T");
  assert.equal(eff.repository.project, "soc/data-maps");
  assert.equal(eff.analysis.api_url, "http://ollama:11434/v1");
  assert.equal(eff.analysis.model, "gpt-4.1");
  assert.equal(eff.analysis.api_key, "K");
  assert.equal(eff.elastic.url, "https://es.example");
  assert.equal(eff.elastic.api_key, "E");
});

test("effectiveConfig can override the kinds and the azure api version", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  const eff = effectiveConfig(baseConfig(), { ...values, llmKind: "azure", llmApiVersion: "2024-10-21" });
  assert.equal(eff.analysis.api_kind, "azure");
  assert.equal(eff.analysis.api_version, "2024-10-21");
});

test("effectiveConfig does not mutate the config it is given", () => {
  const cfg = baseConfig();
  effectiveConfig(cfg, { ...loadSettings({ session: fakeStorage(), local: fakeStorage() }).values, repoUrl: "https://other" });
  assert.equal(cfg.repository.api_url, "https://g/api/v4");
  assert.equal("token" in cfg.repository, false);
});

// A token or URL pasted from a terminal or a password manager often arrives
// with a trailing newline; untrimmed it turns into a 401 that reads like a
// permissions problem.
test("saveSettings trims every string value", () => {
  const session = fakeStorage(), local = fakeStorage();
  saveSettings({
    repoToken: "  T\n", repoUrl: " https://g/api/v4 ", llmModel: "\tm\t",
    llmKey: "", elasticUrl: "   ",
  }, { remember: false, session, local });
  const record = JSON.parse(session.getItem(KEY));
  assert.equal(record.repoToken, "T");
  assert.equal(record.repoUrl, "https://g/api/v4");
  assert.equal(record.llmModel, "m");
  // A value that was only whitespace is empty, so it does not shadow the
  // configured one.
  assert.equal(record.elasticUrl, "");
  assert.equal(record.llmKey, "");
  assert.equal(loadSettings({ session, local }).values.repoToken, "T");
});

// What the Save button sends: the controls, trimmed.  Saving writes the whole
// record, so a key with no control on the page must keep what is retained
// rather than clear a stored token this page never showed.
test("collectValues trims the controls and keeps what has no control", () => {
  const controls = new Map([
    ["repoToken", { value: "  T\n" }],
    ["llmModel", { value: "\tm\t" }],
    ["elasticUrl", { value: "   " }],
  ]);
  const retained = { llmKey: " K ", llmUrl: "https://kept", elasticKey: null };
  const out = collectValues(KEYS, controls, retained);
  assert.deepEqual(Object.keys(out).sort(), [...KEYS].sort());
  assert.equal(out.repoToken, "T");
  assert.equal(out.llmModel, "m");
  // Only whitespace in the box is an empty value, as everywhere else.
  assert.equal(out.elasticUrl, "");
  // No control: the retained value survives the save.
  assert.equal(out.llmKey, "K");
  assert.equal(out.llmUrl, "https://kept");
  // Nothing retained either: an empty string, not "null".
  assert.equal(out.elasticKey, "");
  assert.equal(out.repoUrl, "");
});

test("collectValues copes with no controls and nothing retained", () => {
  assert.deepEqual(collectValues(KEYS, null, null),
                   Object.assign({}, ...KEYS.map((k) => ({ [k]: "" }))));
});

// --- the endpoint lock ----------------------------------------------------
//
// A site that pins the analysis endpoint (analysis.allow_override: false)
// answers with the published URL, model, kind and api-version whatever this
// browser has stored, and says so in the result.

function lockedConfig() {
  const config = baseConfig();
  config.analysis.allow_override = false;
  return config;
}

test("allow_override absent is an unlocked site", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  assert.equal("allow_override" in baseConfig().analysis, false);
  assert.equal(effectiveConfig(baseConfig(), values).analysis.locked, false);
  const open = baseConfig();
  open.analysis.allow_override = true;
  assert.equal(effectiveConfig(open, values).analysis.locked, false);
});

test("a locked site ignores the four analysis overrides", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  const eff = effectiveConfig(lockedConfig(), {
    ...values,
    llmUrl: "http://ollama:11434/v1",
    llmModel: "mine",
    llmKind: "azure",
    llmApiVersion: "2024-10-21",
  });
  assert.equal(eff.analysis.api_url, "https://api.openai.com/v1");
  assert.equal(eff.analysis.model, "gpt-4.1");
  assert.equal(eff.analysis.api_kind, "openai");
  assert.equal(eff.analysis.api_version, "");
  assert.equal(eff.analysis.locked, true);
});

// The key is the one analysis setting that is never published, so pinning
// the endpoint must not stop a person supplying their own credential.
test("a locked site still uses the analysis key from this browser", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  const eff = effectiveConfig(lockedConfig(), { ...values, llmKey: "K" });
  assert.equal(eff.analysis.api_key, "K");
});

// Only the analysis endpoint is pinned: the repository and Elastic overrides
// are how an admin reaches a dev proxy, and they keep working.
test("the lock leaves the repository and elastic overrides alone", () => {
  const { values } = loadSettings({ session: fakeStorage(), local: fakeStorage() });
  const eff = effectiveConfig(lockedConfig(), {
    ...values,
    repoUrl: "http://localhost:8081/api/v4",
    repoToken: "T",
    elasticUrl: "https://es.example",
    elasticKey: "E",
  });
  assert.equal(eff.repository.api_url, "http://localhost:8081/api/v4");
  assert.equal(eff.repository.token, "T");
  assert.equal(eff.repository.project, "soc/data-maps");
  assert.equal(eff.elastic.url, "https://es.example");
  assert.equal(eff.elastic.api_key, "E");
});

test("effectiveConfig does not mutate a locked config either", () => {
  const cfg = lockedConfig();
  effectiveConfig(cfg, { llmUrl: "http://x", llmKey: "K" });
  assert.equal(cfg.analysis.api_url, "https://api.openai.com/v1");
  assert.equal("api_key" in cfg.analysis, false);
  assert.equal("locked" in cfg.analysis, false);
});

// What the Settings page draws.  The four pinned fields are not rendered at
// all; everything else, the analysis key included, still is.
test("visibleKeys drops exactly the pinned analysis fields", () => {
  assert.deepEqual(LOCKED_KEYS, ["llmUrl", "llmModel", "llmKind", "llmApiVersion"]);
  assert.deepEqual(visibleKeys(KEYS, baseConfig()), KEYS);
  assert.deepEqual(visibleKeys(KEYS, lockedConfig()),
                   ["repoToken", "repoUrl", "llmKey", "elasticUrl", "elasticKey"]);
  assert.equal(analysisLocked(lockedConfig()), true);
  assert.equal(analysisLocked(baseConfig()), false);
  // A config with no analysis section at all, and no config at all.
  assert.equal(analysisLocked({}), false);
  assert.equal(analysisLocked(null), false);
  assert.deepEqual(visibleKeys(KEYS, {}), KEYS);
});

test("visibleKeys copies rather than editing the list it is given", () => {
  const keys = KEYS.slice();
  const out = visibleKeys(keys, baseConfig());
  assert.notEqual(out, keys);
  assert.deepEqual(keys, KEYS);
});

// Every key the lock actually pins is named, api-version included: the
// notice stands where those four fields would have been.
test("the lock notice says the endpoint comes from the published config", () => {
  assert.equal(LOCK_NOTICE,
    "This site fixes the analysis endpoint; the URL, model, kind and "
    + "api-version come from the published configuration.");
  for (const key of ["URL", "model", "kind", "api-version"]) {
    assert.ok(LOCK_NOTICE.includes(key), key);
  }
});

// Saving from a locked page must not clear the values it never drew: the
// four keys have no control, so collectValues keeps what is retained.
test("a save from a locked page keeps the undrawn analysis overrides", () => {
  const controls = new Map([
    ["repoToken", { value: "T" }],
    ["llmKey", { value: "K" }],
    ["elasticUrl", { value: "" }],
    ["elasticKey", { value: "" }],
    ["repoUrl", { value: "" }],
  ]);
  const retained = { llmUrl: "http://ollama:11434/v1", llmModel: "mine",
                     llmKind: "azure", llmApiVersion: "2024-10-21" };
  const out = collectValues(KEYS, controls, retained);
  assert.equal(out.llmUrl, "http://ollama:11434/v1");
  assert.equal(out.llmModel, "mine");
  assert.equal(out.llmKind, "azure");
  assert.equal(out.llmApiVersion, "2024-10-21");
  assert.equal(out.llmKey, "K");
});
