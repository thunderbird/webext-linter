// What --llm-sca-review accepts as a submission folder: one built add-on and one archive of
// the source it was built from. The rest of that command is a prompt, so this is the only
// part of it that can be wrong about the submission - and being wrong here sends its reader
// to review a file nobody submitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { scaSubmission } from "../../src/addon/submission.js";

/** A folder holding `names`, each an empty file, plus any `dirs`. */
function folder(names, dirs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webext-linter-sub-"));
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), "");
  }
  for (const name of dirs) {
    fs.mkdirSync(path.join(dir, name));
  }
  return dir;
}

// Only archives are counted. A download picks up a README, a licence, a .DS_Store, and a
// reviewer may already have extracted something beside them - none of that makes the
// submission ambiguous, so none of it is an error.
test("the two files are found among whatever else the folder holds", () => {
  const dir = folder(
    ["addon.xpi", "source.tar.gz", "README.txt", ".DS_Store", "notes.md"],
    ["extracted"]
  );
  const s = scaSubmission(dir);
  assert.equal(s.folder, path.resolve(dir));
  assert.equal(path.basename(s.xpi), "addon.xpi");
  assert.equal(path.basename(s.source), "source.tar.gz");
  // Absolute, because the prompt prints them for someone to act on from anywhere.
  assert.ok(path.isAbsolute(s.xpi) && path.isAbsolute(s.source));
  fs.rmSync(dir, { recursive: true, force: true });
});

// An ATN download names the source archive whatever the developer uploaded, mangled: the
// extension is read from the END of the basename, so a double-packed tar keeps its .gz.
test("a mangled double-packed name is still the source archive", () => {
  const dir = folder(["tb-4.3.12.xpi", "conv-4.3.12-src.tar_UubDLRC.gz"]);
  assert.equal(
    path.basename(scaSubmission(dir).source),
    "conv-4.3.12-src.tar_UubDLRC.gz"
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// Each way a folder can fail to be a submission, named in the message: a reader who is told
// "not a submission" has to open the folder themselves to find out why.
test("anything that is not one add-on and one source archive is refused", () => {
  const cases = [
    [["source.zip"], /0 add-on\(s\) \(none\)/],
    [["a.xpi", "b.xpi", "source.zip"], /2 add-on\(s\) \("a\.xpi", "b\.xpi"\)/],
    [["addon.xpi", "README.txt"], /0 source archive\(s\) \(none\)/],
    // Listed in the order the folder gives them, so the test names them one at a time.
    [["addon.xpi", "source.zip", "other.tar.gz"], /2 source archive\(s\)/],
    [["addon.xpi", "source.zip", "other.tar.gz"], /"source\.zip"/],
    [["addon.xpi", "source.zip", "other.tar.gz"], /"other\.tar\.gz"/],
  ];
  for (const [names, message] of cases) {
    const dir = folder(names);
    assert.throws(() => scaSubmission(dir), message, names.join(" + "));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A folder that cannot be read at all says so, rather than reporting it holds no add-on.
test("a folder that is not there says that", () => {
  assert.throws(
    () => scaSubmission(path.join(os.tmpdir(), "webext-linter-no-such-folder")),
    /is not a readable folder/
  );
});
