// The selection lives in the URL hash so a result is a link:
//   #<tech>/<dataset>/<format>?cribl=1|0&dest=elastic
// Pure string functions; picker.js owns location.hash.

const DEFAULTS = { tech: null, dataset: null, format: null, cribl: true, dest: "elastic" };

export function parseHash(hash) {
  const text = (hash || "").replace(/^#/, "");
  const q = text.indexOf("?");
  const pathPart = q === -1 ? text : text.slice(0, q);
  const queryPart = q === -1 ? "" : text.slice(q + 1);
  const segs = pathPart === "" ? [] : pathPart.split("/").map(decodeSafe);
  const out = Object.assign({}, DEFAULTS);
  out.tech = segs[0] || null;
  out.dataset = segs[1] || null;
  out.format = segs[2] || null;
  for (const pair of queryPart.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? "" : decodeSafe(pair.slice(eq + 1));
    if (key === "cribl") {
      if (value === "0") out.cribl = false;
      else if (value === "1") out.cribl = true;
    } else if (key === "dest" && value) {
      out.dest = value;
    }
  }
  return out;
}

export function formatHash(state) {
  const segs = [];
  for (const key of ["tech", "dataset", "format"]) {
    if (!state[key]) break;
    segs.push(encodeURIComponent(state[key]));
  }
  return "#" + segs.join("/") + "?cribl=" + (state.cribl ? "1" : "0")
    + "&dest=" + encodeURIComponent(state.dest || "elastic");
}

function decodeSafe(text) {
  try { return decodeURIComponent(text); } catch (err) { return text; }
}
