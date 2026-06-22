async function run() {
  await browser.messages.oldOne(); // deprecated
  await browser.messages.future(); // added in TB 200, newer than strict_min_version 128.0
}
