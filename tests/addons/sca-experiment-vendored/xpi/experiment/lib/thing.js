// A small, readable library vendored from a GitHub release rather than from npm.
export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
