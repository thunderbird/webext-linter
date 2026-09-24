// The add-on ships a disallowed jquery and declares it, but the published file listing
// for the release cannot be read, so nothing shows the copy came from it.
const rows = globalThis.jQuery(".row");
console.log(rows.length);
