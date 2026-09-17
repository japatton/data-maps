// Shared test fixtures for the Studio browser modules.
//
// SCHEMA is the generated studio/tests/fixtures/schema.json: the real
// vocabularies, key tables and alerting profiles that ship in
// public/studio/schema.json, with the ECS dictionary cut down to the fields
// these tests name.  Regenerate it with
// `python3 -m datamaps.studio --write-fixture`; tests/test_studio.py fails
// with that command when the committed copy has gone stale.
//
// Reading a file is a test-only liberty - the shipped modules are handed the
// schema by the shell and never touch the filesystem - so this import lives
// here rather than anywhere under studio/lib or studio/views.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SCHEMA = JSON.parse(
  readFileSync(path.join(HERE, "fixtures", "schema.json"), "utf8"));

// A fresh, valid technology document with id "t": one dataset "d" carrying a
// direct-only route and a single syslog-cef format with two fields.
export function goodTech() {
  return {
    id: "t",
    name: "Test Technology",
    vendor: "Test Vendor",
    datasets: [{
      id: "d",
      name: "Dataset",
      event_categories: ["network"],
      route: {
        direct: [
          { hop: "cribl", location: "core" },
          { hop: "elastic", data_stream: "logs-test.d" },
        ],
      },
      formats: [{
        format: "syslog-cef",
        parsing: { mechanism: "cribl-pack" },
        recommendations: { direct: { parse_location: "low" } },
        fields: [
          { vendor: "src", ecs: "source.ip", status: "mapped" },
          { vendor: "act", ecs: "event.action", status: "mapped" },
        ],
      }],
    }],
  };
}
