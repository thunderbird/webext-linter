// The submission's files as ONE store plus the views a review reads it through.
//
// A submission is already on disk for the whole review - a directory is reviewed where it
// lies, and a packed .xpi is extracted before it is walked (../addon/load.js) - so the bytes
// need not be held a second time. The store keeps a key and a path, and reads a file the
// first time something asks for it.
//
// A VIEW is a store plus the keys it holds. It carries no bytes and no entries of its own,
// and it does not re-key: every view spells a file the way the SUBMISSION does, because that
// is the one frame in which every part of a submission can be named. A file beside the
// add-on has no add-on-relative spelling, so a corpus keyed against the add-on could never
// hold one.
//
// A path written INSIDE a declaration - a VENDOR entry naming the file it covers - is
// relative to the file that declares it, so it is joined at the READ, against that file's
// own directory. Never baked into the keys, which is what keeps the corpus able to name the
// whole submission.
//
// Both present the Map surface the review already uses (`get`/`has`/`keys`/`size`/`delete`
// and iteration), so a corpus, a view and a plain Map are interchangeable - which is why the
// unit tests can still hand a check a hand-built Map.
//
// Belongs here: the store, the view, the lazy read behind both, and withExperiment - the
// one place that says what "everything the add-on ships" means. Does NOT belong here:
// which files exist (-> ./load.js walks the tree), how an archive is split into views
// (-> ./load.js scaViews), or what any of them MEAN to a check (-> src/checks/*).

import fs from "node:fs";
import path from "node:path";

/**
 * A key set over files on disk, read on demand.
 *
 * READ-ONLY, and deliberately: a store is the artifact as it arrived, so it offers no way to
 * drop a key. A corpus that reviews less than the artifact holds - the manifest lifted off,
 * one part of a partitioned archive - is a VIEW, which owns its own key set and can.
 *
 * The cache is unbounded on purpose: a review reads most of what it enumerates (it parses,
 * hashes and classifies), so evicting would mean reading the same file twice for no saving.
 * What is never read - images, fonts, a committed archive - is never paid for.
 */
export class FileStore {
  #root;
  #keys;
  #cache = new Map();

  /**
   * @param {string} root  Absolute path the keys are relative to.
   * @param {Iterable<string>} keys  Posix, root-relative.
   */
  constructor(root, keys) {
    this.#root = root;
    this.#keys = new Set(keys);
  }

  /** @returns {number} */
  get size() {
    return this.#keys.size;
  }

  /** @param {string} key @returns {boolean} */
  has(key) {
    return this.#keys.has(key);
  }

  /**
   * The file's bytes, or undefined when this store does not hold that key. A key that IS
   * held but has since left the disk reads as empty rather than throwing: the review is a
   * snapshot of a tree it does not own, and a mid-review deletion must not abort it.
   * @param {string} key
   * @returns {Buffer|undefined}
   */
  get(key) {
    if (!this.#keys.has(key)) {
      return undefined;
    }
    if (!this.#cache.has(key)) {
      const full = path.join(this.#root, ...key.split("/"));
      let buf;
      try {
        buf = fs.readFileSync(full);
      } catch {
        buf = Buffer.alloc(0);
      }
      this.#cache.set(key, buf);
    }
    return this.#cache.get(key);
  }

  /** @returns {IterableIterator<string>} */
  keys() {
    return this.#keys.values();
  }

  /** @returns {IterableIterator<[string, Buffer]>} */
  *entries() {
    for (const key of this.#keys) {
      yield [key, this.get(key)];
    }
  }

  /** @returns {IterableIterator<[string, Buffer]>} */
  [Symbol.iterator]() {
    return this.entries();
  }
}

/**
 * A view of `store` restricted to the keys it names, in the STORE's frame.
 *
 * `keys` are listed rather than derived from a prefix, because a view may exclude a subtree
 * that sits inside it (the add-on source excludes the Experiment implementation). Nothing is
 * re-keyed: every view spells a file the way the submission does, which is the only frame
 * that can name the whole of it.
 * @param {FileStore|Map<string, Buffer>} store
 * @param {{keys: Iterable<string>}} args
 * @returns {object}  The Map surface, over store keys.
 */
export function fileView(store, { keys }) {
  const held = new Set(keys);
  const view = {
    get size() {
      return held.size;
    },
    /** @param {string} key */
    has: (key) => held.has(key),
    /** @param {string} key */
    get: (key) => (held.has(key) ? store.get(key) : undefined),
    /** @param {string} key */
    delete: (key) => held.delete(key),
    *keys() {
      yield* held;
    },
    *entries() {
      for (const key of held) {
        yield [key, store.get(key)];
      }
    },
  };
  view[Symbol.iterator] = view.entries;
  return view;
}

/**
 * The add-on's files INCLUDING its privileged Experiment implementation.
 *
 * `addon.files` is the add-on's WebExtension code: the Experiment is kept out of it so the
 * API, permission and eval checks never false-positive on Services/ChromeUtils. But a pass
 * that asks what a file IS - minified, obfuscated, a known library, parsable at all - is
 * asking about every file the add-on ships, and privileged code shipped unreadable is worse
 * than ordinary code shipped unreadable, not exempt. Those passes read this.
 *
 * Merging is always safe because the two corpora are disjoint by construction: the archive
 * partition put every file in exactly one of them (src/addon/load.js scaViews), so nothing
 * is shadowed and nothing is counted twice. Where the developer PUT the Experiment folder -
 * inside the add-on or beside it - changes only how its files are spelled, never whether
 * they are reviewed. A built XPI has no separate Experiment view at all (it ships its
 * implementation like any other file), so this is its own corpus, unchanged.
 * @param {object} addon
 * @returns {object}  The Map surface over both.
 */
export function withExperiment(addon) {
  const exp = addon?.experiment;
  if (!exp || exp.size === 0) {
    return addon.files;
  }
  return new Map([...addon.files, ...exp]);
}
