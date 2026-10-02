// Terminal color for the live feed and the report - applied only when writing
// to an interactive screen, never to a file or a pipe. The CLI enables it once
// (setColor) when stdout is a TTY and the format is text. Everything else - the
// golden harness, unit tests, JSON, or a piped run - stays plain.
//
// A wrapper does not put an escape code in the text. It puts a MARKER there - a
// private-use character, a token drawn at random for this run, and the colour code - so the
// text can pass the terminal guard (src/util/text.js displayTerminal), which removes every
// control character from every source, ours included. The one door to the terminal
// (src/util/log.js) turns the markers into escape codes AFTER that guard (applyColor). A
// submission cannot forge one: it does not know the token, and a look-alike without it
// stays inert text.
//
// Belongs here: setColor, the red/green/yellow/blue/brightCyan/grey wrappers, the marker
// format, and applyColor / withoutColor, which are the only readers of it.
// Does NOT belong here: WHICH text is colored (the feed note in
// src/checks/registry.js, the issues in src/report/format.js) or WHEN color is
// enabled (src/cli.js reads process.stdout.isTTY).

import { randomBytes } from "node:crypto";

let enabled = false;

// A marker: OPEN, the token, ":", the SGR code, CLOSE. Neither private-use character is a
// control or format character, so the terminal guard leaves them in place.
const OPEN = "\uE000";
const CLOSE = "\uE001";
const TOKEN = randomBytes(8).toString("hex");
const MARKER = new RegExp(`${OPEN}${TOKEN}:([0-9;]+)${CLOSE}`, "g");

/**
 * Enable or disable color. The CLI turns it on only for an interactive text run.
 * @param {boolean|undefined} v
 */
export function setColor(v) {
  enabled = Boolean(v);
}

/**
 * Wrap text in markers for an SGR color when enabled, else return it unchanged.
 * @param {number|string} code  The SGR color code (or a compound "1;96").
 * @param {string} s
 * @returns {string}
 */
function paint(code, s) {
  return enabled ? `${mark(code)}${s}${mark(0)}` : String(s);
}

/** @param {number|string} code @returns {string} */
function mark(code) {
  return `${OPEN}${TOKEN}:${code}${CLOSE}`;
}

/**
 * Turn this run's markers into ANSI escape codes - the last step before a write to the
 * terminal, after its guard. Anything that only looks like a marker is left alone.
 * @param {string} text
 * @returns {string}
 */
export function applyColor(text) {
  return text.replace(MARKER, (_, code) => `\x1b[${code}m`);
}

/**
 * Remove this run's markers - for text that goes to a FILE, which carries no colour.
 * @param {string} text
 * @returns {string}
 */
export function withoutColor(text) {
  return text.replace(MARKER, "");
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
