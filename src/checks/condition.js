// The condition a prompt step is printed under (`when:` in assets/registry.yaml): a boolean
// expression over named facts, with AND, OR, NOT and parentheses.
//
//   expr   := term (OR term)*
//   term   := factor (AND factor)*
//   factor := NOT factor | "(" expr ")" | name | call
//   call   := "value" "(" name "," name ")"
//
// `value(phase, id)` holds once the phase that asks for that process value returned that id
// (src/report/loop.js accept). It is the one function: a process value is declared in the
// registry and read in the registry, so its names never reach the code as constants.
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

/** The functions a condition may call. */
const FUNCTIONS = new Set(["value"]);

/**
 * @typedef {{name: string} | {call: string, args: string[]} | {not: ConditionTree}
 *   | {and: ConditionTree[]} | {or: ConditionTree[]}} ConditionTree
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
    if (c === "(" || c === ")" || c === ",") {
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
    if (peek() !== "(") {
      return { name: t };
    }
    if (!FUNCTIONS.has(t)) {
      throw new Error(`"${t}" is not a function ${where()}`);
    }
    pos++;
    const args = [argument()];
    while (peek() === ",") {
      pos++;
      args.push(argument());
    }
    if (peek() !== ")") {
      throw new Error(`expected ")" ${where()}`);
    }
    pos++;
    if (args.length !== 2) {
      throw new Error(`${t}() takes two names, given ${args.length}`);
    }
    return { call: t, args };
  };
  const argument = () => {
    const t = peek();
    if (t === undefined || t === "(" || t === ")" || t === "," || !isName(t)) {
      throw new Error(`expected a name ${where()}`);
    }
    pos++;
    return t;
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
 * Every fact name a condition reads, once each. A call's arguments are not facts.
 * @param {ConditionTree} tree
 * @returns {string[]}
 */
export function namesOf(tree) {
  if ("name" in tree) {
    return [tree.name];
  }
  if ("call" in tree) {
    return [];
  }
  if ("not" in tree) {
    return namesOf(tree.not);
  }
  return [...new Set((tree.and ?? tree.or).flatMap(namesOf))];
}

/**
 * Every call a condition makes, for its reader to check the arguments against what they
 * name.
 * @param {ConditionTree} tree
 * @returns {{call: string, args: string[]}[]}
 */
export function callsOf(tree) {
  if ("call" in tree) {
    return [tree];
  }
  if ("name" in tree) {
    return [];
  }
  if ("not" in tree) {
    return callsOf(tree.not);
  }
  return (tree.and ?? tree.or).flatMap(callsOf);
}

/**
 * Whether a condition holds, given the facts true now and the process values returned so
 * far.
 * @param {ConditionTree} tree
 * @param {Set<string>} facts
 * @param {Object<string, string>} [values]  Phase name -> the id it returned.
 * @returns {boolean}
 */
export function holds(tree, facts, values = {}) {
  if ("name" in tree) {
    return facts.has(tree.name);
  }
  if ("call" in tree) {
    const [phase, id] = tree.args;
    return Object.hasOwn(values, phase) && values[phase] === id;
  }
  if ("not" in tree) {
    return !holds(tree.not, facts, values);
  }
  return "and" in tree
    ? tree.and.every((t) => holds(t, facts, values))
    : tree.or.some((t) => holds(t, facts, values));
}
