// The picker's one pure helper: which catalog rows wear a "draft" badge.
// The table itself needs a DOM and is exercised by hand against the dev
// server.

import test from "node:test";
import assert from "node:assert/strict";
import { draftIds } from "../views/picker.js";

const CATALOG = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("draftIds asks the store for every row that has an id", () => {
  const asked = [];
  const store = {
    hasDraft: (id) => { asked.push(id); return id !== "b"; },
  };
  const ids = draftIds(store, CATALOG.concat([null, {}]));
  assert.deepEqual(Array.from(ids).sort(), ["a", "c"]);
  assert.deepEqual(asked, ["a", "b", "c"]);
  assert.equal(draftIds(store, null).size, 0);
});

// A browser in private mode can refuse storage per read.  One refusal costs
// that row's badge; the rows after it are still asked.
test("a throwing store costs one badge, not the rest of the table", () => {
  const store = {
    hasDraft: (id) => {
      if (id === "a") throw new Error("blocked");
      return true;
    },
  };
  assert.deepEqual(Array.from(draftIds(store, CATALOG)).sort(), ["b", "c"]);
});

test("a store that refuses everything leaves every badge off", () => {
  const store = { hasDraft: () => { throw new Error("blocked"); } };
  assert.equal(draftIds(store, CATALOG).size, 0);
});
