// Selection state over the picker index (exports/picker.json).  Pure:
// every function returns a new state and never touches the DOM.

export function findTech(index, id) {
  return (index.technologies || []).find((t) => t.id === id) || null;
}

export function findDataset(tech, id) {
  return tech ? (tech.datasets || []).find((d) => d.id === id) || null : null;
}

export function findFormat(dataset, id) {
  return dataset ? (dataset.formats || []).find((f) => f.format === id) || null : null;
}

function recommendedFormat(dataset) {
  if (!dataset || !dataset.formats || !dataset.formats.length) return null;
  const rec = dataset.formats.find((f) => f.recommended);
  return (rec || dataset.formats[0]).format;
}

export function resolve(index, wanted) {
  const notices = [];
  const state = { tech: null, dataset: null, format: null,
                  cribl: wanted.cribl !== false, dest: "elastic" };
  const dests = index.destinations || ["elastic"];
  if (wanted.dest && dests.indexOf(wanted.dest) === -1) {
    notices.push("destination '" + wanted.dest + "' is not available; using elastic");
  } else if (wanted.dest) {
    state.dest = wanted.dest;
  }
  const tech = wanted.tech ? findTech(index, wanted.tech) : null;
  if (wanted.tech && !tech) {
    notices.push("no technology '" + wanted.tech + "'");
    return { state, notice: notices.join("; ") };
  }
  state.tech = tech ? tech.id : null;
  const dataset = wanted.dataset ? findDataset(tech, wanted.dataset) : null;
  if (wanted.dataset && !dataset) {
    notices.push("no dataset '" + wanted.dataset + "' on " + (tech ? tech.id : "?"));
    return { state, notice: notices.join("; ") };
  }
  state.dataset = dataset ? dataset.id : null;
  if (dataset) {
    const format = wanted.format ? findFormat(dataset, wanted.format) : null;
    if (wanted.format && !format) {
      notices.push("no format '" + wanted.format + "' on " + dataset.id);
    }
    state.format = format ? format.format : recommendedFormat(dataset);
  }
  return { state, notice: notices.length ? notices.join("; ") : null };
}

export function select(index, state, level, value) {
  const next = Object.assign({}, state);
  if (level === "tech") {
    next.tech = value || null;
    next.dataset = null;
    next.format = null;
  } else if (level === "dataset") {
    next.dataset = value || null;
    next.format = recommendedFormat(findDataset(findTech(index, next.tech), next.dataset));
  } else if (level === "format") {
    next.format = value || null;
  } else if (level === "cribl") {
    next.cribl = Boolean(value);
  } else if (level === "dest") {
    next.dest = value || "elastic";
  }
  return next;
}

export function options(index, state) {
  const tech = findTech(index, state.tech);
  const dataset = findDataset(tech, state.dataset);
  return {
    techs: (index.technologies || []).map((t) => ({ id: t.id, name: t.name, category: t.category })),
    datasets: tech ? tech.datasets.map((d) => ({ id: d.id, name: d.name })) : [],
    formats: dataset ? dataset.formats.slice() : [],
  };
}

export function current(index, state) {
  const tech = findTech(index, state.tech);
  const dataset = findDataset(tech, state.dataset);
  const format = findFormat(dataset, state.format);
  if (!tech || !dataset || !format) return null;
  return { tech, dataset, format };
}
