// Resolves the ATN reviewer "review this add-on" URL for a submission, so the
// text report can point the reviewer at the page where they complete the manual
// review. The listing slug is not in the manifest, so it is looked up from the
// ATN API by the add-on's gecko id, and the review URL is built from that slug.
// Best-effort: any problem (no gecko id, the add-on is not listed yet, offline,
// a timeout) yields null and the report simply omits the line.
//
// Belongs here: the ATN slug lookup (resolveReviewUrl) and its default network
// transport. Does NOT belong here: where the URL is printed (the Manual review
// section in src/report/format.js) or when the lookup runs (src/pipeline.js,
// gated to text reports).

import { ATN_FETCH_TIMEOUT_MS } from "../config.js";

/** @typedef {import("./load.js").Manifest} Manifest */

// The public ATN add-on detail API (accepts the gecko id as the identifier) and
// the reviewer review-page base the slug is appended to.
const ATN_ADDON_API =
  "https://services.addons.thunderbird.net/api/v4/addons/addon/";
const REVIEW_BASE = "https://addons.thunderbird.net/reviewers/review/";

/**
 * The ATN reviewer review-page URL for an add-on, or null when it cannot be
 * resolved (no gecko id, the add-on is not listed, or the lookup fails).
 * @param {object} params
 * @param {Manifest} params.manifest
 * @param {(url: string) => Promise<object>} [params.fetchJson]  Injectable
 *   transport (the default is a timeout-capped fetch; tests inject their own).
 * @returns {Promise<?string>}
 */
export async function resolveReviewUrl({
  manifest,
  fetchJson = defaultFetchJson,
}) {
  const id =
    manifest?.browser_specific_settings?.gecko?.id ??
    manifest?.applications?.gecko?.id;
  if (!id) {
    return null;
  }
  try {
    const data = await fetchJson(`${ATN_ADDON_API}${encodeURIComponent(id)}/`);
    return data?.slug ? `${REVIEW_BASE}${data.slug}` : null;
  } catch {
    return null;
  }
}

/**
 * The default transport: a timeout-capped GET returning parsed JSON.
 * @param {string} url
 * @returns {Promise<object>}
 */
async function defaultFetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATN_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}
