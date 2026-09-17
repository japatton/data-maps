// The binding Tasks 9-11 must keep: every Studio module loads under Node,
// with no DOM in sight.  A view that touched `document` at module scope
// would still work in the browser and would quietly make every other
// module's tests unrunnable, so the rule is checked rather than remembered.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function studioModules() {
  const files = [path.join(ROOT, "studio.js")];
  for (const dir of ["lib", "views"]) {
    for (const name of readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.endsWith(".js")) files.push(path.join(ROOT, dir, name));
    }
  }
  return files;
}

test("every Studio module imports under Node, with no DOM", async () => {
  assert.equal(typeof globalThis.document, "undefined",
               "this test is meaningless with a DOM present");
  const files = studioModules();
  assert.ok(files.length >= 10, `only found ${files.length} modules`);
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      assert.fail(`${rel} must import without a DOM: ${err.message}`);
    }
  }
});

test("the module sweep covers the views and the shell", () => {
  const rels = studioModules().map((f) => path.relative(ROOT, f));
  for (const name of ["studio.js", path.join("lib", "store.js"),
                      path.join("views", "picker.js"),
                      path.join("views", "settings.js")]) {
    assert.ok(rels.includes(name), `${name} missing from the sweep`);
  }
});
