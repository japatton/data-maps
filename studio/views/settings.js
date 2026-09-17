// #/settings — the tokens, keys and endpoint overrides, and a plain
// statement of where they go.  Nothing here is ever committed or published:
// the values live in this browser's session storage, or in local storage
// when the admin asks to be remembered.

import { h } from "../lib/dom.js";
import { textField, selectField, checkbox } from "../lib/forms.js";
import { KEYS, saveSettings, clearSettings } from "../lib/settings.js";

const API_KINDS = ["openai", "azure"];

// The settings a site can pin, and what the page says instead of drawing
// them.  `analysis.allow_override: false` means the deployment chose the
// model and where it runs; the API key is not on this list, because it
// belongs to the person and never travels in the published config.
export const LOCKED_KEYS = ["llmUrl", "llmModel", "llmKind", "llmApiVersion"];

export const LOCK_NOTICE =
  "This site fixes the analysis endpoint; the URL, model, kind and " +
  "api-version come from the published configuration.";

export function analysisLocked(config) {
  return ((config || {}).analysis || {}).allow_override === false;
}

// Which fields this visit actually draws.  A pinned key keeps whatever this
// browser has stored — collectValues writes back what it does not draw — so
// the values are ready again for a site that allows them.
export function visibleKeys(keys, config) {
  if (!analysisLocked(config)) return keys.slice();
  return keys.filter((key) => LOCKED_KEYS.indexOf(key) === -1);
}

// Label, input type and the config key an empty override falls back to.
const FIELDS = {
  repoToken: {
    label: "Repository token", type: "password",
    help: "Sent only to the repository API, as PRIVATE-TOKEN (GitLab) or " +
          "Authorization (Forgejo).",
  },
  repoUrl: {
    label: "Repository API URL", type: "text",
    placeholder: (config) => (config.repository || {}).api_url,
    help: "Override the published URL — point it at the dev proxy when the " +
          "repository does not send CORS headers.",
  },
  llmKey: { label: "Analysis API key", type: "password" },
  llmUrl: {
    label: "Analysis API URL", type: "text",
    placeholder: (config) => (config.analysis || {}).api_url,
  },
  llmModel: {
    label: "Analysis model", type: "text",
    placeholder: (config) => (config.analysis || {}).model,
  },
  llmKind: {
    label: "Analysis API kind", type: "select", options: API_KINDS,
    placeholder: (config) => (config.analysis || {}).api_kind,
  },
  llmApiVersion: {
    label: "Analysis api-version", type: "text",
    placeholder: (config) => (config.analysis || {}).api_version,
    help: "Azure only.",
  },
  elasticUrl: {
    label: "Elastic URL", type: "text",
    placeholder: (config) => (config.elastic || {}).url,
  },
  elasticKey: {
    label: "Elastic API key", type: "password",
    help: "Sent as Authorization: ApiKey.",
  },
};

// What Save writes, key by key.
//
// Trimmed on the way out: a token pasted with a trailing newline is the usual
// way to send an unusable Authorization header, and the effective panel must
// show what a request would really use.
//
// A key with no control on the page keeps the value already retained instead
// of being written back as "": saving is a whole-record write, so a field
// this page never drew would otherwise clear a stored token nobody touched.
export function collectValues(keys, controls, retained) {
  const kept = retained || {};
  const out = {};
  for (const key of keys) {
    const control = controls && typeof controls.get === "function"
      ? controls.get(key) : null;
    const value = control ? control.value : kept[key];
    out[key] = String(value === null || value === undefined ? "" : value)
      .trim();
  }
  return out;
}

export function render(root, ctx) {
  let remember = ctx.settings.remembered;
  const controls = new Map();
  // The message from the save that navigated back here.  It lives on the
  // shared context rather than in this module, and it is cleared as it is
  // painted: it belongs to one repaint, not to the next visit.
  const flash = ctx.flash || null;
  ctx.flash = null;
  const status = flash
    ? h("p", { class: flash.ok ? "flash" : "error" }, flash.text)
    : h("p", { class: "help" }, " ");

  const form = h("div", {});
  const locked = analysisLocked(ctx.config);
  const shown = visibleKeys(KEYS, ctx.config);
  for (const key of shown) {
    const spec = FIELDS[key] || { label: key, type: "text" };
    const placeholder = typeof spec.placeholder === "function"
      ? spec.placeholder(ctx.config) || ""
      : "";
    const widget = spec.type === "select"
      ? selectField({
        label: spec.label,
        value: ctx.settings.values[key],
        options: spec.options,
        allowEmpty: true,
        emptyLabel: placeholder ? `${placeholder} (published)` : "—",
        help: spec.help,
      })
      : textField({
        label: spec.label,
        type: spec.type,
        value: ctx.settings.values[key],
        placeholder: placeholder ? `${placeholder} (published)` : "",
        mono: spec.type !== "password",
        help: spec.help,
      });
    // The control itself is the only copy of what has been typed: Save reads
    // it back directly, because a value typed with the caret still in the
    // box has not fired `change` yet, and a second copy kept in this module
    // could only disagree with it.
    controls.set(key, widget.querySelector("input, select, textarea"));
    form.appendChild(widget);
    // The sentence stands where the four pinned fields would have been, so
    // the gap between the analysis key and the Elastic settings explains
    // itself; the rail still shows the endpoint they resolve to.
    if (locked && key === "llmKey") {
      form.appendChild(h("p", { class: "notice" }, LOCK_NOTICE));
    }
  }

  const rememberBox = checkbox({
    label: "Remember on this device",
    checked: remember,
    onChange: (v) => { remember = v; },
    help: "On: local storage, so the values survive closing the browser. " +
          "Off: session storage, cleared when this tab closes.",
  });

  function collect() {
    return collectValues(KEYS, controls, ctx.settings.values);
  }

  // saveSettings throws when the browser refuses to write (private mode, or
  // a full quota); the message belongs on screen, not in the console.
  function save() {
    try {
      saveSettings(collect(), { remember });
      ctx.flash = {
        ok: true,
        text: remember ? "Saved on this device."
                       : "Saved for this browser session.",
      };
    } catch (err) {
      ctx.flash = { ok: false, text: `Could not save: ${message(err)}` };
    }
    ctx.navigate("#/settings");
  }

  function forget() {
    try {
      clearSettings();
      ctx.flash = {
        ok: true,
        text: "Cleared. Nothing is stored in this browser any more.",
      };
    } catch (err) {
      ctx.flash = { ok: false, text: `Could not clear: ${message(err)}` };
    }
    ctx.navigate("#/settings");
  }

  root.appendChild(h("section", {},
    h("h1", {}, "Settings"),
    h("p", {},
      "Values stay in this browser and are sent only to the endpoints you " +
      "configure."),
    status,
    h("div", { class: "split" },
      h("div", { class: "pane" },
        h("div", { class: "panel" },
          form,
          rememberBox,
          h("div", { class: "btn-row" },
            h("button", { type: "button", class: "btn btn-primary", onclick: save },
              "Save"),
            h("button", { type: "button", class: "btn", onclick: forget },
              "Forget everything"),
            h("span", { class: "muted" },
              ctx.settings.remembered
                ? "Currently remembered on this device."
                : "Currently held for this session only.")))),
      h("div", { class: "rail" }, effectivePanel(ctx)))));
}

// What a request would actually use right now, so an override that did not
// take is visible without opening the console.
function effectivePanel(ctx) {
  const eff = ctx.effective();
  const repo = ctx.config.repository || {};
  return h("div", {},
    h("h3", {}, "Effective endpoints"),
    row("Repository kind", repo.kind),
    row("Repository API", eff.repository.api_url),
    row("Project", repo.project),
    row("Default branch", repo.default_branch),
    row("Repository token", secret(eff.repository.token)),
    h("h3", {}, "Analysis"),
    // The rail is the answer to "what would a run actually use", so it keeps
    // showing the endpoint whether or not this browser could have changed it.
    eff.analysis.locked ? h("p", { class: "muted" }, "Fixed by this site.")
                        : null,
    row("Kind", eff.analysis.api_kind),
    row("API", eff.analysis.api_url),
    row("Model", eff.analysis.model),
    row("api-version", eff.analysis.api_version),
    row("API key", secret(eff.analysis.api_key)),
    h("h3", {}, "Elastic"),
    row("URL", eff.elastic.url),
    row("API key", secret(eff.elastic.api_key)));
}

function row(label, value) {
  return h("p", { class: "help" },
    h("span", { class: "field-label" }, label),
    h("span", { class: "mono" }, value ? String(value) : "—"));
}

function secret(value) {
  return value ? "set" : "not set";
}

function message(err) {
  return (err && err.message) ? err.message : String(err);
}
