// Build tooling: it sits OUTSIDE --sca-source, so it is a build file and never
// reviewed as add-on code. Names a fake API that would be reported if it were.
browser.totallyFakeBuildNamespace.doThing();
