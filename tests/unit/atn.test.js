// Unit tests for resolveReviewUrl: the ATN slug lookup -> reviewer review-page
// URL, with the network injected. Best-effort - any failure yields null.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveReviewUrl } from "../../src/addon/atn.js";

const manifest = (id) => ({ browser_specific_settings: { gecko: { id } } });

test("resolveReviewUrl builds the review URL from the looked-up slug", async () => {
  let requested;
  const url = await resolveReviewUrl({
    manifest: manifest("spamshield@alcaspamshield"),
    fetchJson: async (u) => {
      requested = u;
      return { slug: "spamshield-antispam" };
    },
  });
  assert.equal(
    url,
    "https://addons.thunderbird.net/reviewers/review/spamshield-antispam"
  );
  // The gecko id is sent (URL-encoded) to the ATN add-on detail API.
  assert.match(requested, /addons\/addon\/spamshield%40alcaspamshield\/$/);
});

test("resolveReviewUrl reads the legacy applications.gecko.id too", async () => {
  const url = await resolveReviewUrl({
    manifest: { applications: { gecko: { id: "x@y" } } },
    fetchJson: async () => ({ slug: "the-slug" }),
  });
  assert.equal(url, "https://addons.thunderbird.net/reviewers/review/the-slug");
});

test("resolveReviewUrl returns null when it cannot resolve", async () => {
  // No gecko id -> no lookup at all.
  let called = false;
  assert.equal(
    await resolveReviewUrl({
      manifest: {},
      fetchJson: async () => {
        called = true;
        return {};
      },
    }),
    null
  );
  assert.equal(called, false);

  // Resolves to a listing with no slug.
  assert.equal(
    await resolveReviewUrl({
      manifest: manifest("a@b"),
      fetchJson: async () => ({}),
    }),
    null
  );

  // Lookup fails (offline / 404 / timeout).
  assert.equal(
    await resolveReviewUrl({
      manifest: manifest("a@b"),
      fetchJson: async () => {
        throw new Error("offline");
      },
    }),
    null
  );
});
