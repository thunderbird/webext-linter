// Each debugger below sits under a condition on RUNTIME DATA, so each one halts
// Thunderbird for an ordinary user the moment the data matches. None of them is a build
// flag, a configuration flag or an add-on option, which is what would make one acceptable.
browser.messageDisplay.onMessageDisplayed.addListener((tab, message) => {
  if (message.author.includes("@")) {
    debugger;
  }
  if (tab.id > 0) {
    for (const part of message.parts ?? []) {
      if (part) {
        debugger;
      }
    }
  }
});

// The shape that IS acceptable, and which a reader has to be able to tell apart: a
// build-time constant. It is raised too, because deciding between the two means
// reading the file.
const DEBUG = false;
if (DEBUG) {
  debugger;
}
