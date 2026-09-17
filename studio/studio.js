// The page shell: load the published inputs once, keep one context object,
// and hand the whole of <main> to whichever view the hash names.
//
// Views are `render(root, ctx, params)` and own everything inside `root`;
// the shell owns the header, the routing and the shared context.  All five
// views are imported statically, so Tasks 9-11 replace only their own file
// and never touch this one.

import { h, clear, el } from "./lib/dom.js";
import { createStore } from "./lib/store.js";
import { KEYS, loadSettings, effectiveConfig } from "./lib/settings.js";
import { request, explain } from "./lib/net.js";
import * as pickerView from "./views/picker.js";
import * as settingsView from "./views/settings.js";
import * as editorView from "./views/editor.js";
import * as reviewView from "./views/review.js";
import * as deleteView from "./views/delete.js";
import * as analyzeView from "./views/analyze.js";

const NAV = [
  { href: "../index.html", label: "Catalog", route: null },
  { href: "#/", label: "Technologies", route: "picker" },
  { href: "#/analyze", label: "Analyze", route: "analyze" },
  { href: "#/settings", label: "Settings", route: "settings" },
];

// #/tech/<id>[/review|/delete] -> {name, view, params}.  Unknown hashes fall through
// to a small "not found" view rather than silently showing the picker.
export function parseRoute(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const parts = raw.split("/").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return { name: "picker", view: pickerView, params: {} };
  if (parts.length === 1 && parts[0] === "settings") {
    return { name: "settings", view: settingsView, params: {} };
  }
  if (parts.length === 1 && parts[0] === "analyze") {
    return { name: "analyze", view: analyzeView, params: {} };
  }
  if (parts[0] === "tech" && parts.length >= 2) {
    // A hand-typed hash can hold a broken escape; that is a bad route, not
    // a crash.
    let id;
    try {
      id = decodeURIComponent(parts[1]);
    } catch (err) {
      return { name: "notfound", view: notFound, params: { hash: raw } };
    }
    if (parts.length === 2) {
      return { name: "editor", view: editorView, params: { id } };
    }
    if (parts.length === 3 && parts[2] === "review") {
      return { name: "review", view: reviewView, params: { id } };
    }
    if (parts.length === 3 && parts[2] === "delete") {
      return { name: "delete", view: deleteView, params: { id } };
    }
  }
  return { name: "notfound", view: notFound, params: { hash: raw } };
}

const notFound = {
  render(root, ctx, params) {
    root.appendChild(h("section", {},
      h("h1", {}, "Not found"),
      h("p", {}, `No view answers to "#${params.hash}".`),
      h("p", {}, h("a", { href: "#/" }, "Back to technologies"))));
  },
};

// One route render.  The generation counter goes up first and before any
// view code runs, so whatever the outgoing view has in flight can compare
// against it and know it is no longer the view on screen.  The route is
// handed in already parsed, and the header and the error box are hooks, so
// this is the whole of the render loop and it is testable without a DOM.
export function renderRoute(root, ctx, route, { header, onError } = {}) {
  ctx.generation = (Number(ctx.generation) || 0) + 1;
  if (header) header(route.name, ctx);
  clear(root);
  try {
    route.view.render(root, ctx, route.params);
  } catch (err) {
    if (onError) onError(err, root);
    throw err;
  }
  return route;
}

async function boot() {
  const app = el("app");
  const wanted = ["schema.json", "config.json", "source/catalog.json"];
  // Started with the three required documents, awaited after them: a site
  // built before examples existed simply has no examples.json, and that is
  // not a reason to refuse to start.
  const examplesRequest = getJson("examples.json");
  const loaded = await Promise.all(wanted.map((url) => getJson(url)));
  const failed = loaded
    .map((result, index) => (result.ok ? null : `${wanted[index]} — ${result.why}`))
    .filter((line) => line !== null);
  if (failed.length) {
    // What to do next follows from what the requests actually said: a
    // request that never got an answer is a file:// or CORS problem, and one
    // that got an answer is a site that was not built (or not built here).
    const unanswered = loaded.some(
      (result) => !result.ok && (result.cors || result.status === 0));
    clear(app).appendChild(h("section", {},
      h("h1", {}, "Studio could not start"),
      h("p", { class: "error" }, "Could not load:"),
      h("ul", {}, failed.map((line) => h("li", { class: "error" }, line))),
      h("p", { class: "muted" }, unanswered
        ? "No answer came back at all, which is what opening these files "
          + "directly looks like: serve the built site instead. Run: "
          + ".venv/bin/python3 -m datamaps.build, then tools/studio_dev.py"
        : "The server answered, but not with these files. Build the site "
          + "and serve that copy: .venv/bin/python3 -m datamaps.build, then "
          + "tools/studio_dev.py")));
    return;
  }
  const [schema, config, catalogDoc] = loaded.map((result) => result.json);
  const examplesResult = await examplesRequest;
  const examples = (examplesResult.ok && examplesResult.json
    && typeof examplesResult.json === "object")
    ? examplesResult.json
    : {};

  const catalog = Array.isArray(catalogDoc.technologies)
    ? catalogDoc.technologies
    : [];
  const sourcesCache = new Map();
  const loadSource = createSourceLoader(getJson, sourcesCache);

  const ctx = {
    schema,
    config,
    catalog,
    // The published example records, {tech: {dataset: [{label, path, size}]}}.
    // Empty when the site has none; the editor checks new records against it.
    examples,
    // A record attached from Analyze while another technology was loaded.
    // The editor consumes it once it has settled which document it is
    // showing, and clears it.
    pendingExample: null,
    // Bumped by renderRoute on every route render.  A view's async
    // continuation captures it and paints nothing once it no longer
    // matches, so a slow load can never paint over the view that replaced
    // it.
    generation: 0,
    // A one-shot message for the view about to be drawn (Settings sets it
    // before navigating back to itself); the view clears it as it paints.
    flash: null,
    settings: readSettings(),
    store: createStore({ schema }),
    navigate,
    sourcesCache,
    loadSource,
    effective,
    // Which dataset/format/section the editor has open, kept across a
    // re-render by the shell so Task 9 can stash it here.
    editorSelection: {},
  };

  function effective() {
    return effectiveConfig(ctx.config, ctx.settings.values);
  }

  function navigate(hash) {
    const next = String(hash || "#/");
    if (window.location.hash === next) render();
    else window.location.hash = next;
  }

  function render() {
    // Settings live in browser storage and another tab may have changed
    // them, so they are re-read on every route change: the header pill and
    // effective() then always describe what a request would actually use.
    ctx.settings = readSettings();
    const route = parseRoute(window.location.hash);
    // The stylesheet widens the editor and only the editor, so it has to be
    // told which route is on screen; this is the one place that knows.
    if (document.body) document.body.setAttribute("data-route", route.name);
    renderRoute(app, ctx, route, {
      header: drawHeader,
      onError: (err, root) => {
        clear(root).appendChild(h("section", {},
          h("h1", {}, "This view failed to render"),
          h("p", { class: "error" }, String((err && err.message) || err)),
          h("p", {}, h("a", { href: "#/" }, "Back to technologies"))));
      },
    });
  }

  window.addEventListener("hashchange", render);
  if (!window.location.hash) window.location.hash = "#/";
  render();
}

function drawHeader(routeName, ctx) {
  const header = el("chrome");
  if (!header) return;
  const hasToken = Boolean(ctx.settings.values.repoToken);
  clear(header);
  header.appendChild(h("h1", {}, h("a", { href: "#/" }, "Studio")));
  header.appendChild(h("nav", {}, NAV.map((item) => h("a", {
    href: item.href,
    class: item.route === routeName ? "active" : null,
  }, item.label))));
  header.appendChild(h("span", {
    class: `pill ${hasToken ? "pill-on" : "pill-off"}`,
    title: "Set in Settings; kept in this browser only",
  }, hasToken ? "repository token set" : "no repository token"));
}

// ctx.loadSource: the published technology document for `id`, or null when
// the technology has no file yet.  Fetched at most once per id, even when
// two callers race.
//
// Only a genuine 404 means "no file".  Everything else — offline, CORS, a
// 500, a body that is not JSON — rejects with an Error carrying `status` and
// `cors`, because a caller that read those as null would start a blank
// document and a commit from that state would overwrite the real file.  A
// failure is never cached, so the next call retries.
export function createSourceLoader(fetchJson, cache = new Map()) {
  const pending = new Map();
  return function loadSource(id) {
    if (cache.has(id)) return Promise.resolve(cache.get(id));
    if (pending.has(id)) return pending.get(id);
    const path = `source/${encodeURIComponent(id)}.json`;
    const job = Promise.resolve()
      .then(() => fetchJson(path))
      .then((result) => {
        if (result.ok) {
          cache.set(id, result.json);
          return result.json;
        }
        if (result.status === 404) {
          cache.set(id, null);
          return null;
        }
        const err = new Error(`${path}: ${result.why}`);
        err.status = result.status;
        err.cors = result.cors;
        throw err;
      })
      // In `finally`, not `then`: a request that threw must not wedge the id.
      .finally(() => { pending.delete(id); });
    pending.set(id, job);
    return job;
  };
}

// A JSON GET against the published site, as
// {ok, json, status, cors, why}.  The status and the CORS flag are kept
// rather than collapsed into null: "there is no such file" and "the request
// never got an answer" are different facts, and only the caller knows which
// of them it can act on.
//
// The transport is injected so the rule can be tested without a network:
// `getJson` below is the one the shell actually uses.
//
// Every one of these documents — schema.json, config.json and each
// source/*.json — is part of the published snapshot the editor diffs
// against, so all of them are fetched with `no-store`.  A cached copy would
// make the browser disagree with the site about what was last built, and a
// commit prepared from that copy would undo the rebuild it never saw.
export function createJsonLoader(requestImpl) {
  return async function getJson(url) {
    const result = await requestImpl(url, { noStore: true });
    if (result.ok && result.json !== null) {
      return { ok: true, json: result.json, status: result.status,
               cors: false, why: "" };
    }
    const why = result.ok
      ? `HTTP ${result.status}: the response was not JSON`
      : explain(result);
    return { ok: false, json: null, status: result.status, cors: result.cors,
             why };
  };
}

export const getJson = createJsonLoader(request);

// A browser told to block site data throws on the mere sight of
// localStorage, and loadSettings reads it while resolving its defaults.  A
// shell that dies on every route change would be far worse than one that
// forgets the token.
let warnedAboutStorage = false;

function readSettings() {
  try {
    return loadSettings();
  } catch (err) {
    // Once: the shell re-reads storage on every route change, and a browser
    // that refuses it refuses it every time.
    if (!warnedAboutStorage) {
      warnedAboutStorage = true;
      if (typeof console !== "undefined" && console && console.warn) {
        console.warn("Studio: this browser refused to read stored settings; "
                     + "tokens and keys will not be remembered.", err);
      }
    }
    const values = {};
    for (const key of KEYS) values[key] = "";
    return { values, remembered: false };
  }
}

// Nothing above is allowed to fail silently: an unhandled rejection here
// would leave the page sitting on "Loading…" with no explanation.  The guard
// keeps importing this module inert outside a browser, which is what the
// import test relies on.
if (typeof document !== "undefined") startup();

function startup() {
  return boot().catch((err) => {
    const app = el("app");
    if (!app) throw err;
    clear(app).appendChild(h("section", {},
      h("h1", {}, "Studio could not start"),
      h("p", { class: "error" }, String((err && err.message) || err))));
    throw err;
  });
}
