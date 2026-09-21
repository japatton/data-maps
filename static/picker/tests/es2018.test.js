// The picker ships as source: whatever is written here is what a browser
// parses, with no transpiler in between.  The floor is ES2018 (Chrome/Edge
// 64+, Firefox 60+, Safari 12+), so the syntax and library calls that
// arrived after it are banned outright rather than remembered.  Same sweep
// as studio/tests/es2018.test.js, pointed at static/picker/.
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
  ["globalThis", "window — the picker only ever runs in a browser (ES2020)"],
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
  const files = [];
  for (const name of readdirSync(ROOT).sort()) {
    if (name.endsWith(".js")) files.push(path.join(ROOT, name));
  }
  return files;
}

test("no post-ES2018 syntax or library calls in the shipped sources", () => {
  const files = sources();
  assert.ok(files.length >= 4, `only found ${files.length} sources`);
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
  for (const name of ["picker.js", "render.js", "state.js", "hash.js"]) {
    assert.ok(rels.includes(name), `${name} missing from the sweep`);
  }
});
