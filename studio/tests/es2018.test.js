// Studio ships as source: whatever is written here is what a browser parses,
// with no transpiler in between.  The floor is ES2018 (Chrome/Edge 64+,
// Firefox 60+, Safari 12+), so the syntax and library calls that arrived
// after it are banned outright rather than remembered.
//
// Every hit names the file and the line, so the fix is obvious from the
// failure alone.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// [token, what to write instead]
const FORBIDDEN = [
  ["Object.hasOwn(", "Object.prototype.hasOwnProperty.call (ES2022)"],
  [".replaceAll(", "split/join or a global regex (ES2021)"],
  ["??", "an explicit === undefined / === null check (ES2020)"],
  ["?.", "an explicit guard (ES2020)"],
  ["globalThis", "lib/global.js's globalObject (ES2020)"],
  ["Promise.any(", "Promise.all or a hand-written race (ES2021)"],
  ["Object.fromEntries(", "a for loop over the entries (ES2019)"],
  [".flat(", "concat or a for loop (ES2019)"],
  [".flatMap(", "map plus concat (ES2019)"],
  [".at(", "an index, guarded for the negative case (ES2022)"],
  [".trimEnd(", "a /\\s+$/ replace (ES2019)"],
  [".trimStart(", "a /^\\s+/ replace (ES2019)"],
  ["catch {", "catch (err) — optional catch binding is ES2019"],
  ["catch{", "catch (err) — optional catch binding is ES2019"],
];

function sources() {
  const files = [path.join(ROOT, "studio.js")];
  for (const dir of ["lib", "views"]) {
    for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.endsWith(".js")) files.push(path.join(ROOT, dir, name));
    }
  }
  return files;
}

test("no post-ES2018 syntax or library calls in the shipped sources", () => {
  const files = sources();
  assert.ok(files.length >= 10, `only found ${files.length} sources`);
  const hits = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const [token, advice] of FORBIDDEN) {
        if (line.includes(token)) {
          hits.push(`${rel}:${index + 1}: '${token}' — use ${advice}`);
        }
      }
    });
  }
  assert.deepEqual(hits, [],
                   `post-ES2018 code found:\n${hits.join("\n")}`);
});

test("the sweep covers every shipped module", () => {
  const rels = sources().map((f) => path.relative(ROOT, f));
  for (const name of ["studio.js", path.join("lib", "repo.js"),
                      path.join("lib", "global.js"),
                      path.join("views", "analyze.js")]) {
    assert.ok(rels.includes(name), `${name} missing from the sweep`);
  }
});

// globalObject is a plain identifier, so a module that names it without
// importing it parses, imports and tests fine — and then throws a
// ReferenceError the first time the line actually runs in a browser. The
// only reliable moment to catch that is here.
test("every file that names globalObject imports it from lib/global.js", () => {
  const missing = [];
  for (const file of sources()) {
    const rel = path.relative(ROOT, file);
    if (rel === path.join("lib", "global.js")) continue;
    const text = readFileSync(file, "utf8");
    if (!text.includes("globalObject")) continue;
    const imported = /import\s*\{[^}]*\bglobalObject\b[^}]*\}\s*from\s*"(\.\/|\.\.\/lib\/)global\.js"/
      .test(text);
    if (!imported) {
      missing.push(`${rel}: names globalObject but does not import it from `
        + "global.js");
    }
  }
  assert.deepEqual(missing, [], missing.join("\n"));
});
