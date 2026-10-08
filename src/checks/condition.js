// The condition a prompt step is printed under (`when:` in assets/registry.yaml): a boolean
// expression over named facts, with AND, OR, NOT and parentheses.
//
//   expr   := term (OR term)*
//   term   := factor (AND factor)*
//   factor := NOT factor | "(" expr ")" | name
//
// Names are lower-case words, digits and hyphens (`llm-skip-manual`, `sca`); the operators
// are upper case, so a name can never be read as one. NOT binds tightest, then AND, then OR.
//
// Belongs here: the grammar - parsing a condition, naming what it reads, and evaluating it
// against the facts true now. Does NOT belong here: WHICH facts exist (-> the prompt's own
// vocabulary, src/checks/registry-vocabulary.js), or whether a step prints (-> its reader,
// src/report/phases.js stepsOf and src/report/format.js).
//
// A plain character scan rather than a regex or a parser library: the language is five
// tokens, the text is the registry's own, and a scan says exactly where it stopped.

const OPERATORS = new Set(["AND", "OR", "NOT"]);

/**
 * @typedef {{name: string} | {not: ConditionTree} | {and: ConditionTree[]}
 *   | {or: ConditionTree[]}} ConditionTree
 */

/**
 * Split a condition into words and parentheses, each with where it starts.
 * @param {string} text
 * @returns {{token: string, at: number}[]}
 */
function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ token: c, at: i });
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && isWordChar(text[i])) {
      i++;
    }
    if (i === start) {
      throw new Error(`unexpected "${c}" at ${start + 1}`);
    }
    tokens.push({ token: text.slice(start, i), at: start });
  }
  return tokens;
}

/**
 * @param {string} c
 * @returns {boolean}
 */
function isWordChar(c) {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    (c >= "0" && c <= "9") ||
    c === "-"
  );
}

/**
 * Parse a condition into a tree.
 * @param {string} text
 * @returns {ConditionTree}
 * @throws {Error}  Naming what was expected and where (1-based).
 */
export function parseCondition(text) {
  const tokens = tokenize(String(text ?? ""));
  let pos = 0;
  const peek = () => tokens[pos]?.token;
  const where = () =>
    pos < tokens.length ? `at ${tokens[pos].at + 1}` : "at the end";

  const expr = () => {
    const terms = [term()];
    while (peek() === "OR") {
      pos++;
      terms.push(term());
    }
    return terms.length === 1 ? terms[0] : { or: terms };
  };
  const term = () => {
    const factors = [factor()];
    while (peek() === "AND") {
      pos++;
      factors.push(factor());
    }
    return factors.length === 1 ? factors[0] : { and: factors };
  };
  const factor = () => {
    const t = peek();
    if (t === "NOT") {
      pos++;
      return { not: factor() };
    }
    if (t === "(") {
      pos++;
      const inner = expr();
      if (peek() !== ")") {
        throw new Error(`expected ")" ${where()}`);
      }
      pos++;
      return inner;
    }
    if (t === undefined || t === ")" || OPERATORS.has(t) || !isName(t)) {
      throw new Error(
        t === undefined
          ? `expected a name ${where()}`
          : `expected a name ${where()}, found "${t}"`
      );
    }
    pos++;
    return { name: t };
  };

  const tree = expr();
  if (pos < tokens.length) {
    throw new Error(`unexpected "${tokens[pos].token}" ${where()}`);
  }
  return tree;
}

/**
 * A name is lower case: an upper-case word is an operator, or a misspelt one.
 * @param {string} word
 * @returns {boolean}
 */
function isName(word) {
  return word === word.toLowerCase() && word[0] !== "-";
}

/**
 * Every name a condition reads, once each.
 * @param {ConditionTree} tree
 * @returns {string[]}
 */
export function namesOf(tree) {
  if ("name" in tree) {
    return [tree.name];
  }
  if ("not" in tree) {
    return namesOf(tree.not);
  }
  return [...new Set((tree.and ?? tree.or).flatMap(namesOf))];
}

/**
 * Whether a condition holds, given the facts true now.
 * @param {ConditionTree} tree
 * @param {Set<string>} facts
 * @returns {boolean}
 */
export function holds(tree, facts) {
  if ("name" in tree) {
    return facts.has(tree.name);
  }
  if ("not" in tree) {
    return !holds(tree.not, facts);
  }
  return "and" in tree
    ? tree.and.every((t) => holds(t, facts))
    : tree.or.some((t) => holds(t, facts));
}
