// The whole of Studio's rendering vocabulary: build an element, empty an
// element, find one by id.  No framework, no build step.
//
// Nothing here touches `document` at import time, so every module that draws
// a view still imports cleanly under Node.

// h("input", {type: "text", value: "x", oninput: fn}, "label text", [more])
//
// Attribute rules:
//   - `class`      -> className
//   - `dataset`    -> an object copied onto el.dataset
//   - `style`      -> a string set as the style attribute, or an object of
//                     camelCase properties
//   - on*          -> addEventListener("*", fn) when the value is a function
//   - value/checked/disabled/selected -> set as properties, because the
//     matching attributes are only the *initial* value and do nothing at all
//     on a <textarea>
//   - true         -> a bare attribute; false/null/undefined -> omitted
//   - anything else-> setAttribute(key, String(value))
//
// Children may be strings, numbers, nodes, nested arrays, or null/undefined/
// false (skipped), so `cond && h(...)` reads naturally.
const PROPS = ["value", "checked", "disabled", "selected", "indeterminate"];

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const key of Object.keys(attrs || {})) {
    const value = attrs[key];
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      node.className = String(value);
    } else if (key === "dataset") {
      for (const name of Object.keys(value)) {
        node.dataset[name] = String(value[name]);
      }
    } else if (key === "style" && typeof value === "object") {
      for (const name of Object.keys(value)) node.style[name] = value[name];
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (PROPS.includes(key)) {
      node[key] = value;
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false ||
        child === true) {
      continue;
    }
    if (Array.isArray(child)) {
      append(node, child);
    } else if (typeof child === "object" && child.nodeType) {
      node.appendChild(child);
    } else {
      node.appendChild(document.createTextNode(String(child)));
    }
  }
}

// A text file saved straight out of the browser, with no server to ask.
// The object URL is revoked on a timer rather than immediately: revoking it
// in the same tick can beat the click in some browsers, and the download
// then silently produces nothing.
export function downloadText(name, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = h("a", { href: url, download: name, style: "display:none" });
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function el(id) {
  return document.getElementById(id);
}
