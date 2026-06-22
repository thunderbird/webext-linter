// runtime.onRestartRequired exists in the schema but is annotated
// version_added: false - a Firefox API documented but unsupported in Thunderbird.
// unknown-api flags it as unsupported (the schemas carry no `unsupported` key, so
// version_added: false is how "not available anywhere" is encoded).
browser.runtime.onRestartRequired.addListener((reason) => {
  console.log("restart required", reason);
});
