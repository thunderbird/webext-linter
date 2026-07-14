// A private, pristine copy of the shipped model table (assets/llm) for the tests
// that exercise the OpenAI negotiation: it WRITES what it learns back to the
// table, so no test may run against the real files.
//
// The copy is stripped of its `learned` entries, because the shipped file's are
// not a constant: a real run against a model the table does not know appends one.
// A test that asserted against whatever happened to be there would pass or fail by
// accident of who ran the linter last.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The shipped table's directory. */
export const LLM_ASSETS = path.resolve(here, "../../assets/llm");

/**
 * Copy the shipped table to a fresh temp directory, with nothing learned yet.
 * Comments and hand-written entries survive (a test asserts they do).
 * @returns {string}  The directory, for resetLlmSettings().
 */
export function copyLlmTable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-llm-"));
  for (const name of fs.readdirSync(LLM_ASSETS)) {
    const doc = YAML.parseDocument(
      fs.readFileSync(path.join(LLM_ASSETS, name), "utf8")
    );
    if (doc.has("learned")) {
      doc.set("learned", doc.createNode([]));
    }
    fs.writeFileSync(path.join(dir, name), doc.toString());
  }
  return dir;
}
