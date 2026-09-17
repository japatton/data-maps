// The merge request as a state machine: the happy path, every step's
// failure, the drift stop that refuses to write anything, and the one
// outcome that must never be reported as a failure — a merge request that
// was opened before something downstream threw.

import test from "node:test";
import assert from "node:assert/strict";
import { runMergeRequest, checkUpstream, STEPS, stepLabel } from "../lib/review-flow.js";

const FILES = [
  { path: "data/technologies/t.yml", content: "id: t\n", exists: true },
  { path: "data/examples/t/d-1.log", content: "raw\n", exists: false },
];

const EXPECTED = { "data/technologies/t.yml": "id: t\n" };

// A repository that answers every call, recording what it was asked.  Any
// step named in `fail` throws instead, the way repo.js's RepoError does.
function fakeProvider(options) {
  const opts = options || {};
  const calls = [];
  function maybeFail(step) {
    if (opts.fail === step) {
      const err = new Error(`${step}: HTTP 403`);
      err.step = step;
      throw err;
    }
  }
  return {
    calls,
    checkAccess() {
      calls.push(["checkAccess"]);
      maybeFail("checkAccess");
      return Promise.resolve({ name: "data-maps" });
    },
    readFile(path, branch) {
      calls.push(["readFile", path, branch]);
      maybeFail("readFile");
      const remote = opts.remote || {};
      const found = remote[path];
      if (found === undefined) {
        return Promise.resolve({ exists: true, content: EXPECTED[path] });
      }
      return Promise.resolve(found);
    },
    createBranch(branch) {
      calls.push(["createBranch", branch]);
      maybeFail("createBranch");
      return Promise.resolve(true);
    },
    commit(branch, message, files) {
      calls.push(["commit", branch, message, files.length]);
      maybeFail("commit");
      return Promise.resolve(true);
    },
    openMergeRequest(branch, title, body) {
      calls.push(["openMergeRequest", branch, title, body]);
      maybeFail("openMergeRequest");
      return Promise.resolve({ url: "https://forge.example/mr/1" });
    },
  };
}

function run(provider, extra) {
  const steps = [];
  const args = {
    provider,
    files: FILES,
    expected: EXPECTED,
    branch: "studio/t-20260902",
    message: "studio: update t",
    title: "studio: update t",
    body: "the description",
    defaultBranch: "main",
    onStep: (key, status, value) => { steps.push([key, status]); },
    ...(extra || {}),
  };
  return runMergeRequest(args).then((result) => ({ result, steps }));
}

test("the five steps run in order and the merge request comes back", async () => {
  const provider = fakeProvider();
  const { result, steps } = await run(provider);
  assert.equal(result.ok, true);
  assert.equal(result.mr.url, "https://forge.example/mr/1");
  assert.deepEqual(steps.map((entry) => entry[0]),
                   ["checkAccess", "checkAccess", "readFile", "readFile",
                    "createBranch", "createBranch", "commit", "commit",
                    "openMergeRequest", "openMergeRequest"]);
  assert.deepEqual(steps.map((entry) => entry[1]),
                   ["running", "ok", "running", "ok", "running", "ok",
                    "running", "ok", "running", "ok"]);
  // Only the files that already exist are read from the base branch.
  assert.deepEqual(provider.calls[1],
                   ["readFile", "data/technologies/t.yml", "main"]);
  assert.deepEqual(provider.calls[3],
                   ["commit", "studio/t-20260902", "studio: update t", 2]);
});

test("the step notes carry what each step returned", async () => {
  const seen = [];
  await run(fakeProvider(), {
    onStep: (key, status, value) => { if (status === "ok") seen.push([key, value]); },
  });
  assert.deepEqual(seen[0], ["checkAccess", { name: "data-maps" }]);
  // One file existed upstream, so one file was checked; none of FILES is a
  // removal, so nothing is reported missing.
  assert.deepEqual(seen[1], ["readFile", { checked: 1, missing: [] }]);
  assert.equal(seen[4][0], "openMergeRequest");
  assert.equal(seen[4][1].url, "https://forge.example/mr/1");
});

// --- every step's failure -------------------------------------------------

for (const [key, label] of STEPS) {
  test(`a failure at ${key} stops the run and names the step`, async () => {
    const provider = fakeProvider({ fail: key });
    const { result, steps } = await run(provider);
    assert.equal(result.ok, false);
    assert.equal(result.step, key);
    assert.match(result.error.message, /HTTP 403/);
    assert.equal(result.drift, undefined);
    assert.deepEqual(steps[steps.length - 1], [key, "fail"]);
    // Nothing past the failing step was attempted.
    const at = STEPS.findIndex((entry) => entry[0] === key);
    assert.equal(provider.calls.length, at + 1);
    assert.equal(stepLabel(key), label);
  });
}

// --- the drift stop -------------------------------------------------------

test("a file that moved upstream stops the run before the branch exists",
     async () => {
  const provider = fakeProvider({
    remote: { "data/technologies/t.yml": { exists: true, content: "id: t\nname: moved\n" } },
  });
  const { result, steps } = await run(provider);
  assert.equal(result.ok, false);
  assert.equal(result.step, "readFile");
  assert.deepEqual(result.drift.paths, ["data/technologies/t.yml"]);
  assert.equal(result.drift.reasons["data/technologies/t.yml"], "changed");
  assert.match(result.error.message, /changed in the repository/);
  assert.match(result.error.message, /reload Studio/);
  assert.deepEqual(steps[steps.length - 1], ["readFile", "fail"]);
  // The branch is never created: there is nothing to clean up.
  assert.deepEqual(provider.calls.map((call) => call[0]),
                   ["checkAccess", "readFile"]);
});

test("a file the branch does not have is a different reason, and says so",
     async () => {
  const provider = fakeProvider({
    remote: { "data/technologies/t.yml": { exists: false, content: "" } },
  });
  const { result } = await run(provider);
  assert.equal(result.ok, false);
  assert.equal(result.drift.reasons["data/technologies/t.yml"], "missing");
  assert.match(result.error.message, /does not exist on main/);
  assert.match(result.error.message, /token may not be allowed to read it/);
});

test("with no baseline to compare, no drift is claimed", async () => {
  // A draft saved before Studio recorded a baseline: the branch has moved on
  // and nothing here can tell, so the run is allowed to proceed.
  const provider = fakeProvider({
    remote: { "data/technologies/t.yml": { exists: true, content: "moved\n" } },
  });
  const { result } = await run(provider, { expected: {} });
  assert.equal(result.ok, true);
});

test("checkUpstream counts the files it checked", async () => {
  const provider = fakeProvider();
  const result = await checkUpstream({
    provider, files: FILES, expected: EXPECTED, branch: "main",
  });
  assert.deepEqual(result, { checked: 1, missing: [] });
  assert.deepEqual(provider.calls,
                   [["readFile", "data/technologies/t.yml", "main"]]);
});

// --- removals ---------------------------------------------------------------

test("a removal whose path is already gone is dropped, not failed", async () => {
  const provider = {
    async checkAccess() { return { name: "r", url: "u" }; },
    async readFile(path) {
      if (path === "data/examples/x/gone.log") return { exists: false, content: "", status: 404 };
      return { exists: true, content: "technologies: []\n", status: 200 };
    },
    async createBranch() {},
    async commit(branch, message, files) { this.committed = files; },
    async openMergeRequest() { return { url: "https://mr/1" }; },
  };
  const files = [
    { path: "data/technologies/x.yml", remove: true },
    { path: "data/catalog.yml", content: "technologies: []\n", exists: true },
    { path: "data/examples/x/gone.log", remove: true },
  ];
  const out = await runMergeRequest({
    provider, files, expected: { "data/catalog.yml": "technologies: []\n" },
    branch: "studio/x", message: "m", title: "t", body: "b", defaultBranch: "main",
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.missing, ["data/examples/x/gone.log"]);
  assert.deepEqual(provider.committed.map((f) => f.path),
    ["data/technologies/x.yml", "data/catalog.yml"]);
});

test("a removal that is still there is committed", async () => {
  const provider = {
    async checkAccess() { return { name: "r", url: "u" }; },
    async readFile() { return { exists: true, content: "technologies: []\n", status: 200 }; },
    async createBranch() {},
    async commit(branch, message, files) { this.committed = files; },
    async openMergeRequest() { return { url: "https://mr/1" }; },
  };
  const files = [{ path: "data/technologies/x.yml", remove: true }];
  const out = await runMergeRequest({
    provider, files, expected: {}, branch: "b", message: "m", title: "t",
    body: "d", defaultBranch: "main",
  });
  assert.equal(out.ok, true);
  assert.deepEqual(provider.committed.map((f) => f.path), ["data/technologies/x.yml"]);
});

test("a technology document edited since the build blocks the delete", async () => {
  const provider = {
    async checkAccess() { return { name: "r", url: "u" }; },
    async readFile() { return { exists: true, content: "id: x\nname: edited\n", status: 200 }; },
    async createBranch() { throw new Error("must not reach createBranch"); },
    async commit() {}, async openMergeRequest() { return { url: "x" }; },
  };
  const out = await runMergeRequest({
    provider,
    files: [{ path: "data/technologies/x.yml", remove: true }],
    expected: { "data/technologies/x.yml": "id: x\n" },
    branch: "b", message: "m", title: "t", body: "d", defaultBranch: "main",
  });
  assert.equal(out.ok, false);
  assert.equal(out.step, "readFile");
  assert.ok(out.drift);
});

test("a delete with nothing left to do is refused before the branch exists", async () => {
  let branched = false;
  const provider = {
    async checkAccess() { return { name: "r", url: "u" }; },
    async readFile() { return { exists: false, content: "", status: 404 }; },
    async createBranch() { branched = true; },
    async commit() {},
    async openMergeRequest() { return { url: "x" }; },
  };
  const out = await runMergeRequest({
    provider, files: [{ path: "data/technologies/x.yml", remove: true }],
    expected: {}, branch: "b", message: "m", title: "t", body: "d",
    defaultBranch: "main",
  });
  assert.equal(out.ok, false);
  assert.equal(out.step, "readFile");
  assert.equal(branched, false);
  assert.match(String(out.error.message), /nothing left to delete/i);
});

// --- the outcome that must not be reported as a failure -------------------

test("a throw after the merge request was opened still reports the request",
     async () => {
  const provider = fakeProvider();
  const { result } = await run(provider, {
    onStep: (key, status) => {
      // The painting of the final tick fails; the merge request is already
      // out there, and telling the admin to retry would be worse than
      // saying nothing.
      if (key === "openMergeRequest" && status === "ok") {
        throw new Error("the page went away");
      }
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mr.url, "https://forge.example/mr/1");
  assert.equal(result.step, undefined);
});

test("a run with no onStep at all still works", async () => {
  const result = await runMergeRequest({
    provider: fakeProvider(),
    files: FILES,
    expected: EXPECTED,
    branch: "b",
    message: "m",
    title: "t",
    body: "",
    defaultBranch: "main",
  });
  assert.equal(result.ok, true);
});
