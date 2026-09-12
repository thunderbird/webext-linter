// A readable vendored copy of a markdown renderer, at a version with a known advisory.
export function render(md) {
  return String(md).replace(/^# (.*)$/gm, "<h1>$1</h1>");
}
