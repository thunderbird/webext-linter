// Terminal color for the live feed and the report - applied only when writing
// to an interactive screen, never to a file or a pipe. The CLI enables it once
// (setColor) when stdout is a TTY and the format is text. Everything else - the
// golden harness, unit tests, JSON, or a piped run - stays plain, so nothing
// downstream ever has to undo it.
//
// Belongs here: setColor and the red/green/yellow/blue/brightCyan/grey wrappers.
// Does NOT belong here: WHICH text is colored (the feed note in
// src/checks/registry.js, the issues in src/report/format.js) or WHEN color is
// enabled (src/cli.js reads process.stdout.isTTY).

let enabled = false;

/**
 * Enable or disable color. The CLI turns it on only for an interactive text run.
 * @param {boolean|undefined} v
 */
export function setColor(v) {
  enabled = Boolean(v);
}

/**
 * Wrap text in an ANSI SGR color when enabled, else return it unchanged.
 * @param {number|string} code  The SGR color code (or a compound "1;96").
 * @param {string} s
 * @returns {string}
 */
function paint(code, s) {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s);
}

/** @param {string} s @returns {string} */
export const red = (s) => paint(31, s);
/** @param {string} s @returns {string} */
export const green = (s) => paint(32, s);
/** @param {string} s @returns {string} */
export const yellow = (s) => paint(33, s);
/**
 * Bright blue (SGR 94) - the manual-review / "unsure" color, kept vivid so it
 * leads against the dim-grey suggested response.
 * @param {string} s @returns {string}
 */
export const blue = (s) => paint(94, s);
/**
 * Bold bright cyan (SGR 1;96) - the Extended manual-review accent. A vivid, distinct
 * hue from the blue (SGR 94) Standard section so the escalated items stand out and
 * the two sections are easy to tell apart.
 * @param {string} s @returns {string}
 */
export const brightCyan = (s) => paint("1;96", s);
/**
 * Dim grey (SGR 90 "bright black" - a muted grey that recedes against color).
 * @param {string} s @returns {string}
 */
export const grey = (s) => paint(90, s);
