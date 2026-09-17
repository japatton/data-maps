import test from "node:test";
import assert from "node:assert/strict";
import { createProvider, RepoError, webIdeUrl } from "../lib/repo.js";

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method || "GET", headers: init.headers, body: init.body ? JSON.parse(init.body) : null, credentials: init.credentials });
    const r = responses.shift() || { status: 200, body: {} };
    return { ok: r.status < 400, status: r.status, headers: { get: () => "application/json" }, text: async () => JSON.stringify(r.body) };
  };
  return { fn, calls };
}

test("gitlab sequence and bodies", async () => {
  const f = fakeFetch([
    { status: 200, body: { path_with_namespace: "soc/data-maps", web_url: "https://g/soc/data-maps" } },
    { status: 201, body: {} }, { status: 201, body: {} },
    { status: 201, body: { web_url: "https://g/soc/data-maps/-/merge_requests/7" } },
  ]);
  const p = createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "soc/data-maps", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  assert.deepEqual(await p.checkAccess(), { name: "soc/data-maps", url: "https://g/soc/data-maps" });
  await p.createBranch("studio/x");
  await p.commit("studio/x", "msg", [{ path: "data/technologies/x.yml", content: "id: x\n", exists: true }, { path: "data/catalog.yml", content: "technologies: []\n", exists: true }]);
  const mr = await p.openMergeRequest("studio/x", "title", "body");
  assert.equal(mr.url, "https://g/soc/data-maps/-/merge_requests/7");
  assert.equal(f.calls[0].url, "https://g/api/v4/projects/soc%2Fdata-maps");
  assert.equal(f.calls[0].headers["PRIVATE-TOKEN"], "T");
  assert.equal(f.calls[0].credentials, "omit");
  assert.deepEqual(f.calls[1].body, { branch: "studio/x", ref: "main" });
  assert.equal(f.calls[2].body.actions[0].action, "update");
  assert.equal(f.calls[2].body.commit_message, "msg");
  assert.deepEqual(f.calls[3].body, { source_branch: "studio/x", target_branch: "main", title: "title", description: "body", remove_source_branch: true });
});

test("forgejo fetches sha for existing files and base64-encodes", async () => {
  const f = fakeFetch([
    { status: 200, body: { full_name: "jpatton/data-maps", html_url: "https://f/jpatton/data-maps" } },
    { status: 201, body: {} },
    { status: 200, body: { sha: "abc" } },
    { status: 201, body: {} },
    { status: 201, body: { html_url: "https://f/jpatton/data-maps/pulls/3" } },
  ]);
  const p = createProvider("forgejo", { apiUrl: "https://f/api/v1", project: "jpatton/data-maps", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  await p.checkAccess(); await p.createBranch("b");
  await p.commit("b", "m", [{ path: "data/technologies/x.yml", content: "id: x\n", exists: true }, { path: "data/technologies/y.yml", content: "id: ÿ\n", exists: false }]);
  const pr = await p.openMergeRequest("b", "t", "d");
  assert.equal(pr.url, "https://f/jpatton/data-maps/pulls/3");
  assert.equal(f.calls[0].headers.Authorization, "token T");
  assert.deepEqual(f.calls[1].body, { new_branch_name: "b", old_ref_name: "main" });
  assert.equal(f.calls[2].url, "https://f/api/v1/repos/jpatton/data-maps/contents/data%2Ftechnologies%2Fx.yml?ref=b");
  const files = f.calls[3].body.files;
  assert.equal(files[0].operation, "update"); assert.equal(files[0].sha, "abc");
  assert.equal(files[1].operation, "create"); assert.equal(files[1].sha, undefined);
  assert.equal(Buffer.from(files[1].content, "base64").toString("utf8"), "id: ÿ\n");
  assert.deepEqual(f.calls[4].body, { head: "b", base: "main", title: "t", body: "d" });
});

test("errors carry step and status; CORS is recognised", async () => {
  const p = createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "a/b", defaultBranch: "main", token: "T",
    fetchImpl: async () => ({ ok: false, status: 401, headers: { get: () => "application/json" }, text: async () => '{"message":"401 Unauthorized"}' }) });
  await assert.rejects(p.checkAccess(), e => e instanceof RepoError && e.step === "checkAccess" && e.status === 401 && e.body.includes("Unauthorized"));
  const q = createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "a/b", defaultBranch: "main", token: "T", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(q.createBranch("x"), e => e instanceof RepoError && e.cors === true && e.status === 0);
});

test("webIdeUrl substitution", () => {
  assert.equal(webIdeUrl("https://g/-/ide/project/{project}/edit/{branch}/-/{path}", { project: "soc/data-maps", branch: "main", path: "data/catalog.yml" }),
    "https://g/-/ide/project/soc/data-maps/edit/main/-/data/catalog.yml");
});

test("gitlab readFile decodes base64 UTF-8 and reads a 404 as absent", async () => {
  const yaml = "id: x\nname: Ünïcode ✓\n";
  const f = fakeFetch([
    { status: 200, body: { file_path: "data/technologies/x.yml", encoding: "base64", content: Buffer.from(yaml, "utf8").toString("base64") } },
    { status: 404, body: { message: "404 File Not Found" } },
  ]);
  const p = createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "soc/data-maps", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  assert.deepEqual(await p.readFile("data/technologies/x.yml", "main"), { exists: true, content: yaml, status: 200 });
  assert.equal(f.calls[0].url, "https://g/api/v4/projects/soc%2Fdata-maps/repository/files/data%2Ftechnologies%2Fx.yml?ref=main");
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].headers["PRIVATE-TOKEN"], "T");
  // The status distinguishes "not on the branch" from a file that came back
  // and disagreed; driftReason turns it into advice.
  assert.deepEqual(await p.readFile("data/technologies/gone.yml", "main"), { exists: false, content: "", status: 404 });
});

test("forgejo readFile decodes base64 UTF-8 and reads a 404 as absent", async () => {
  const yaml = "technologies:\n- {id: ÿ}\n";
  const f = fakeFetch([
    { status: 200, body: { encoding: "base64", content: Buffer.from(yaml, "utf8").toString("base64") } },
    { status: 404, body: { message: "Not Found" } },
  ]);
  const p = createProvider("forgejo", { apiUrl: "https://f/api/v1", project: "jpatton/data-maps", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  assert.deepEqual(await p.readFile("data/catalog.yml", "main"), { exists: true, content: yaml, status: 200 });
  assert.equal(f.calls[0].url, "https://f/api/v1/repos/jpatton/data-maps/contents/data%2Fcatalog.yml?ref=main");
  assert.equal(f.calls[0].headers.Authorization, "token T");
  assert.deepEqual(await p.readFile("data/catalog.yml", "main"), { exists: false, content: "", status: 404 });
});

test("readFile reports a failed read rather than an empty file", async () => {
  const f = fakeFetch([{ status: 500, body: { message: "boom" } }, { status: 200, body: { encoding: "base64" } }]);
  const p = createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "a/b", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  await assert.rejects(p.readFile("data/catalog.yml", "main"),
    e => e instanceof RepoError && e.step === "readFile" && e.status === 500);
  await assert.rejects(p.readFile("data/catalog.yml", "main"),
    e => !(e instanceof RepoError) && /came back without its content/.test(e.message));
});

test("createProvider names the kind it does not know", () => {
  assert.throws(() => createProvider("bogus", {}), (e) =>
    e instanceof Error && !(e instanceof RepoError)
    && e.message === "Unknown repository kind: bogus");
  assert.throws(() => createProvider(undefined, {}),
                /Unknown repository kind: undefined/);
});

// The API base is written by hand in config.yml, so a trailing slash (or
// three) must not produce "…/api/v4//projects/…".
test("a trailing slash on the api url is trimmed, once and for all", async () => {
  const f = fakeFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);
  await createProvider("gitlab", { apiUrl: "https://g/api/v4///", project: "a/b", defaultBranch: "main", token: "T", fetchImpl: f.fn }).checkAccess();
  await createProvider("forgejo", { apiUrl: "https://f/api/v1/", project: "a/b", defaultBranch: "main", token: "T", fetchImpl: f.fn }).checkAccess();
  assert.equal(f.calls[0].url, "https://g/api/v4/projects/a%2Fb");
  assert.equal(f.calls[1].url, "https://f/api/v1/repos/a/b");
});

test("an api url with no trailing slash is left alone", async () => {
  const f = fakeFetch([{ status: 200, body: {} }]);
  await createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "a/b", defaultBranch: "main", token: "T", fetchImpl: f.fn }).checkAccess();
  assert.equal(f.calls[0].url, "https://g/api/v4/projects/a%2Fb");
});

test("gitlab turns a removal into a delete action with no content", async () => {
  const f = fakeFetch([{ status: 201, body: {} }]);
  const p = createProvider("gitlab", { apiUrl: "https://g/api/v4", project: "soc/data-maps", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  await p.commit("studio/x", "msg", [
    { path: "data/catalog.yml", content: "technologies: []\n", exists: true },
    { path: "data/technologies/x.yml", remove: true },
  ]);
  const actions = f.calls[0].body.actions;
  assert.deepEqual(actions[0], { action: "update", file_path: "data/catalog.yml", content: "technologies: []\n" });
  assert.deepEqual(actions[1], { action: "delete", file_path: "data/technologies/x.yml" });
});

test("forgejo fetches the blob sha for a removal and sends operation delete", async () => {
  const f = fakeFetch([
    { status: 200, body: { sha: "deadbeef" } },
    { status: 201, body: {} },
  ]);
  const p = createProvider("forgejo", { apiUrl: "https://f/api/v1", project: "jpatton/data-maps", defaultBranch: "main", token: "T", fetchImpl: f.fn });
  await p.commit("b", "msg", [{ path: "data/technologies/x.yml", remove: true }]);
  assert.equal(f.calls[0].url, "https://f/api/v1/repos/jpatton/data-maps/contents/data%2Ftechnologies%2Fx.yml?ref=b");
  const entry = f.calls[1].body.files[0];
  assert.deepEqual(entry, { operation: "delete", path: "data/technologies/x.yml", sha: "deadbeef" });
  assert.equal("content" in entry, false);
});
