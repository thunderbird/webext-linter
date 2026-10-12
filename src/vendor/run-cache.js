// The network one RUN of a review asks through: every answer the run keeps on disk, OSV's
// (./osv-cache.js) and the popularity readings (./popularity-cache.js), in the run's cache
// folder (src/util/dest.js runCache), so every invocation of the run finds what an earlier
// one was answered.
//
// Belongs here: which caches a run's network is wrapped in. Does NOT belong here: what one
// of them keeps (-> each cache's module), or where the folder is (-> src/util/dest.js).

import { withOsvCache } from "./osv-cache.js";
import { withPopularityCache } from "./popularity-cache.js";

/** @typedef {import("./verify.js").VendorNet} VendorNet */

/**
 * `net`, with every endpoint a run keeps answered from the run's cache.
 * @param {VendorNet} net
 * @param {{osv: string, popularity: string}} paths  The run's cache files (runCache).
 * @returns {VendorNet}
 */
export function withRunCache(net, paths) {
  return withOsvCache(withPopularityCache(net, paths.popularity), paths.osv);
}
