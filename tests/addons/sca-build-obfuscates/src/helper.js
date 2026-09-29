// Perfectly ordinary source, loaded by the options page. A review that reads only the
// archive sees nothing wrong, because there IS nothing wrong here - the obfuscation is
// introduced by the build that produces the shipped copy.
function tideLabel(name) {
  return `tide-reader: ${name}`;
}
console.log(tideLabel("helper"));
