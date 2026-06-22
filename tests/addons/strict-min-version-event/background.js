// Modeled on a real submission (mailmindr): strict_min_version 102.0 but the
// compose.onAfterSend event was only added in Thunderbird 105, so installs on
// 102-104 break. strict-min-version-api flags the event listener; the pinned
// strict_max_version on this non-Experiment also trips non-experiment-strict-max-version.
browser.compose.onAfterSend.addListener((tab, info) => {
  console.log("sent", tab.id, info);
});
