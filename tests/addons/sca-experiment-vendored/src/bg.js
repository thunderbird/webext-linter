// The add-on's own WebExtension code, loading a library the developer keeps in the
// Experiment folder and declares in VENDORS.md.
import { slugify } from "./experiment/lib/thing.js";
console.log(slugify("ready"));
