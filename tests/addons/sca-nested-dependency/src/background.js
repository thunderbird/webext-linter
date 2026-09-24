// The archive the reviewer builds from links a local package via file:, which npm
// resolves entirely from disk - authored code, reviewed wherever it sits. That linked
// package's OWN declared dependencies are real external sources npm ci installs from
// the registry, and are classified exactly like the root's (see nested-helper/).
console.log("sca-nested-dependency background");
