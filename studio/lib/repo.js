// Branch, commit and merge request against GitLab or Forgejo, straight from
// the browser. Every call goes through net.js, so a blocked request is a
// RepoError with cors set rather than an opaque TypeError.

import { request } from "./net.js";

export class RepoError extends Error {
  constructor(step, result) {
    super(`${step}: ${result.cors ? "blocked by the browser (CORS or unreachable)" : "HTTP " + result.status}`);
    this.name = "RepoError";
    this.step = step;
    this.status = result.status;
    this.body = result.body;
    this.cors = result.cors;
  }
}

export function createProvider(kind, options = {}) {
  if (kind === "gitlab") return gitlab(options);
  if (kind === "forgejo") return forgejo(options);
  throw new Error(`Unknown repository kind: ${kind}`);
}

export function webIdeUrl(template, { project, branch, path }) {
  // split/join rather than replace: a value containing "$&" must not be
  // re-expanded, and String.prototype.replaceAll is newer than Studio's floor.
  return fill(fill(fill(String(template), "{project}", project),
                   "{branch}", branch),
              "{path}", path);
}

function fill(template, token, value) {
  return template.split(token).join(String(value));
}

function gitlab({ apiUrl, project, defaultBranch, token, fetchImpl }) {
  const headers = { "PRIVATE-TOKEN": token };
  const projectUrl = `${trimSlash(apiUrl)}/projects/${encodeURIComponent(project)}`;

  return {
    async checkAccess() {
      const r = await call("checkAccess", projectUrl, { headers, fetchImpl });
      const data = r.json || {};
      return { name: data.path_with_namespace, url: data.web_url };
    },

    // {exists, content, status} for one file at `ref`; a 404 is "not there",
    // not a failure, because a file this commit creates has no upstream copy.
    async readFile(path, ref) {
      const url = `${projectUrl}/repository/files/${encodeURIComponent(path)}`
        + `?ref=${encodeURIComponent(ref)}`;
      return readAt("readFile", path, url, { headers, fetchImpl });
    },

    async createBranch(name) {
      await call("createBranch", `${projectUrl}/repository/branches`, {
        method: "POST", headers, fetchImpl,
        json: { branch: name, ref: defaultBranch },
      });
    },

    async commit(branch, message, files) {
      await call("commit", `${projectUrl}/repository/commits`, {
        method: "POST", headers, fetchImpl,
        json: {
          branch,
          commit_message: message,
          actions: files.map((f) => (f.remove
            ? { action: "delete", file_path: f.path }
            : {
                action: f.exists ? "update" : "create",
                file_path: f.path,
                content: f.content,
              })),
        },
      });
    },

    async openMergeRequest(branch, title, body) {
      const r = await call("openMergeRequest", `${projectUrl}/merge_requests`, {
        method: "POST", headers, fetchImpl,
        json: {
          source_branch: branch,
          target_branch: defaultBranch,
          title,
          description: body,
          remove_source_branch: true,
        },
      });
      return { url: (r.json || {}).web_url };
    },
  };
}

function forgejo({ apiUrl, project, defaultBranch, token, fetchImpl }) {
  const headers = { Authorization: `token ${token}` };
  const repoUrl = `${trimSlash(apiUrl)}/repos/${project}`;

  return {
    async checkAccess() {
      const r = await call("checkAccess", repoUrl, { headers, fetchImpl });
      const data = r.json || {};
      return { name: data.full_name, url: data.html_url };
    },

    async readFile(path, ref) {
      const url = `${repoUrl}/contents/${encodeURIComponent(path)}`
        + `?ref=${encodeURIComponent(ref)}`;
      return readAt("readFile", path, url, { headers, fetchImpl });
    },

    async createBranch(name) {
      await call("createBranch", `${repoUrl}/branches`, {
        method: "POST", headers, fetchImpl,
        json: { new_branch_name: name, old_ref_name: defaultBranch },
      });
    },

    async commit(branch, message, files) {
      const entries = [];
      for (const f of files) {
        if (f.remove) {
          // Same contents GET the update path makes: Forgejo will take a
          // delete without a sha, and then it cannot tell a stale path from
          // a current one.  Sending it makes a moved file fail loudly.
          const gone = `${repoUrl}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`;
          const found = await call("commit", gone, { headers, fetchImpl });
          entries.push({
            operation: "delete",
            path: f.path,
            sha: (found.json || {}).sha,
          });
          continue;
        }
        const entry = {
          operation: f.exists ? "update" : "create",
          path: f.path,
          content: base64Utf8(f.content),
        };
        if (f.exists) {
          // Forgejo needs the blob sha of the file being replaced.
          const url = `${repoUrl}/contents/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(branch)}`;
          const r = await call("commit", url, { headers, fetchImpl });
          entry.sha = (r.json || {}).sha;
        }
        entries.push(entry);
      }
      await call("commit", `${repoUrl}/contents`, {
        method: "POST", headers, fetchImpl,
        json: { branch, message, files: entries },
      });
    },

    async openMergeRequest(branch, title, body) {
      const r = await call("openMergeRequest", `${repoUrl}/pulls`, {
        method: "POST", headers, fetchImpl,
        json: { head: branch, base: defaultBranch, title, body },
      });
      return { url: (r.json || {}).html_url };
    },
  };
}

async function call(step, url, opts) {
  const r = await request(url, opts);
  if (!r.ok) throw new RepoError(step, r);
  return r;
}

// Both APIs answer a file read with the same shape: a JSON object carrying
// the content base64-encoded.  Anything but a 200 or a 404 is a failure the
// caller must see, and a 200 with no content string is one too: a caller
// comparing against "" would read a large file as "changed".
//
// The result carries `status` as well as `exists` so the caller can tell a
// file that is genuinely not on the branch from one that came back and
// disagreed - the two need different advice, and `exists: false` alone does
// not say which happened.
async function readAt(step, path, url, opts) {
  const r = await request(url, opts);
  if (r.status === 404) return { exists: false, content: "", status: r.status };
  if (!r.ok) throw new RepoError(step, r);
  const data = r.json || {};
  if (typeof data.content !== "string") {
    throw new Error(`${step}: ${path} came back without its content`);
  }
  return {
    exists: true,
    content: decodeBase64Utf8(data.content),
    status: r.status,
  };
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, "");
}

// atob answers with one latin-1 code unit per byte, so the bytes have to be
// gathered up and decoded as UTF-8 before the text is anything but mojibake.
// The APIs wrap long payloads, so the whitespace goes first.
function decodeBase64Utf8(text) {
  const binary = atob(String(text).replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// btoa works on latin-1 code units, so encode to UTF-8 bytes first and feed
// them in chunks small enough for the argument limit.
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
