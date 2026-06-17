async function run() {
  // Property access into the storage namespace requires the "storage" permission,
  // which this manifest does not declare.
  const data = await browser.storage.local.get("key");
  await browser.storage.local.set({ key: data });
}
