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
// add-on has no add-on-relative spelling, so a key set written against the add-on could never
// hold one.
//
// So there are three ways to hold a set of the submission's files, and which one a reader is
// given says what it can do with them:
//
//   FileStore  every key the artifact has, and the bytes behind them, read on demand.
//   FileView   a subset of one store's keys, reading its bytes through that store.
//   PathList   paths and nothing else - an ANSWER about files rather than a store of them.
//
// A PathList needs no construct of its own: an array of paths already cannot read bytes, so
// the type is the whole of it. It is deliberately not called a FileList - it holds no file
// content, and its members may name directories (a recorded node_modules) as readily as
// files.
//
// A path written INSIDE a declaration - a VENDOR entry naming the file it covers - is
// relative to the file that declares it, so it is joined at the READ, against that file's
// own directory. Never baked into the keys, which is what keeps a key set able to name the
// whole submission.
//
// The store and the view both present the read side of the Map surface the review uses
// (`get`/`has`/`keys`/`size` and iteration), so a store, a view and a plain Map are
// interchangeable to a reader - which is why the unit tests can still hand a check a
// hand-built Map.
//
// Belongs here: the store, the view, the lazy read behind both, the PathList type, and
// withExperiment - the one place that says what "everything the add-on ships" means. Does NOT belong here:
// which files exist (-> ./load.js walks the tree), how an archive is split into views
// (-> ./load.js scaViews), or what any of them MEAN to a check (-> src/checks/*).

import fs from "node:fs";
import path from "node:path";
import { rethrowIfFatal } from "../lib/errors.js";

/**
 * Posix paths into the SUBMISSION, and no bytes: what a load RECORDED without reading (a
 * node_modules it refused to walk, a committed archive, every directory it entered) or what
 * an analysis COLLECTED (the files a build reaches). The submission's frame, like every
 * key set here - a list of absolute paths is something else and says so
 * (src/addon/sca-root.js).
 * @typedef {string[]} PathList
 */

/**
 * A key set over files on disk, read on demand.
 *
 * READ-ONLY, like every key set here: a store is the artifact as it arrived. A set of the
 * submission's files that reviews less than the artifact holds - one part of a partitioned
 * archive - is a VIEW, which is given the keys it holds when it is built.
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
      } catch (err) {
        rethrowIfFatal(err);
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
 * that sits inside it (the add-on source excludes the Experiment implementation). What it holds
 * is settled when it is built - like the store, a view offers no way to drop a key afterwards.
 * Nothing is re-keyed: every view spells a file the way the submission does, which is the only
 * frame that can name the whole of it.
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
 * WebExtension checks never false-positive on Services/ChromeUtils. But a pass that asks
 * about every file the submission holds reads this instead:
 *
 *   - the JS sources (collectJsSources) - each check scopes itself from there, so the
 *     Experiment is linted like any code;
 *   - what a file IS - minified, obfuscated, a known library, parsable at all - because
 *     privileged code shipped unreadable is worse than ordinary code shipped unreadable,
 *     not exempt;
 *   - the vendor pass - a library declared inside the Experiment folder is a declared
 *     library like any other, and matching it against `files` alone would call it missing
 *     and skip its audit;
 *   - the build trace - a build step may name a script kept in the Experiment folder, and
 *     it runs on the reviewer's machine like any other.
 *
 * A single lookup reads through fileIn below, which gives the same answer without the
 * copy.
 *
 * Merging is always safe because the two views are disjoint by construction: the archive
 * partition put every file in exactly one of them (src/addon/load.js scaViews), so nothing
 * is shadowed and nothing is counted twice. Where the developer PUT the Experiment folder -
 * inside the add-on or beside it - changes only how its files are spelled, never whether
 * they are reviewed. A built XPI has no separate Experiment view at all (it ships its
 * implementation like any other file), so this hands back its files unchanged.
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

/**
 * One file of the submission by its key, the Experiment included - the lookup form of
 * withExperiment, for a caller that wants one file rather than all of them. Asks each view
 * in turn instead of merging them, since a per-file lookup would otherwise copy both maps
 * each time; the answer is the same because the views are disjoint.
 * @param {object} addon
 * @param {string} key
 * @returns {Buffer|undefined}
 */
export function fileIn(addon, key) {
  return addon?.files?.get(key) ?? addon?.experiment?.get(key);
}
