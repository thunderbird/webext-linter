// Keeps the tests that exercise the OpenAI negotiation off the developer's own
// state: a negotiated shape is cached on disk (src/llm/negotiated.js), so every such
// test points that cache at a fresh temp directory. The shipped model table itself
// (assets/llm) is read-only, so tests read the real one - what they assert about it
// is what a real run gets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resetNegotiated } from "../../src/llm/negotiated.js";
import { resetLlmSettings } from "../../src/llm/settings.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The shipped model table's directory. */
export const LLM_ASSETS = path.resolve(here, "../../assets/llm");

/**
 * Send this test's negotiated-shape cache to a temp directory of its own, and drop
 * whatever an earlier test resolved or learned.
 * @returns {string}  The cache directory, for asserting what was written.
 */
export function isolateLlmCache() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-llm-"));
  resetNegotiated(dir);
  resetLlmSettings();
  return dir;
}
