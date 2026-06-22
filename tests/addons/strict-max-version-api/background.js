async function run() {
  await browser.messages.tags.list(); // added in TB 121, beyond strict_max_version 110.*
}
