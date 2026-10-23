// A JUnit XML report, reduced to what a Gate needs: one entry per test case, what happened to
// it, and the words of its failure. Playwright, Vitest, Jest, pytest and the JVM runners all
// write this shape; none of them is asked for more than `testcase` with an optional `failure`,
// `error` or `skipped` child.
//
// Not a general XML parser: it reads the elements above, decodes the five predefined entities and
// CDATA, and leaves the rest alone.

/**
 * @typedef {object} TestCase
 * @property {string} name
 * @property {string} suite The `classname`, or the enclosing suite's name.
 * @property {"passed" | "failed" | "skipped"} status
 * @property {string} message The first line of what went wrong, when it did.
 * @property {string} detail The failure's own text: the step and the stack.
 * @property {string[]} attachments Paths the runner says it saved for this case (traces, shots).
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** @param {string} text */
function decode(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner)
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (whole, code) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }
      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }
      return ENTITIES[/** @type {keyof typeof ENTITIES} */ (code)] ?? whole;
    });
}

/** @param {string} tag the opening tag text, `<testcase a="b" …>` */
function attributesOf(tag) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[match[1] ?? ""] = decode(match[3] ?? match[4] ?? "");
  }
  return out;
}

/**
 * @param {string} xml
 * @returns {TestCase[]}
 */
export function parseJunit(xml) {
  /** @type {TestCase[]} */
  const cases = [];
  // The enclosing suite names, to give a case a home when it has no classname.
  const events = xml.matchAll(
    /<testsuite\b[^>]*>|<\/testsuite>|<testcase\b[^>]*\/>|<testcase\b[^>]*>[\s\S]*?<\/testcase>/g,
  );
  /** @type {string[]} */
  const suites = [];
  for (const event of events) {
    const text = event[0];
    if (text.startsWith("</testsuite")) {
      suites.pop();
      continue;
    }
    if (text.startsWith("<testsuite")) {
      if (!text.endsWith("/>")) {
        suites.push(attributesOf(text).name ?? "");
      }
      continue;
    }
    const open = text.match(/^<testcase\b[^>]*>/)?.[0] ?? text;
    const attributes = attributesOf(open);
    const body = text.endsWith("/>") && open === text ? "" : text.slice(open.length);
    cases.push(caseOf(attributes, body, suites.at(-1) ?? ""));
  }
  return cases;
}

/**
 * @param {Record<string, string>} attributes
 * @param {string} body
 * @param {string} suite
 * @returns {TestCase}
 */
function caseOf(attributes, body, suite) {
  const failure = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
  const skipped = /<skipped\b/.test(body);
  const detail = failure === null ? "" : decode(failure[3] ?? "").trim();
  const said = failure === null ? "" : (attributesOf(`<x ${failure[2] ?? ""}>`).message ?? "");
  const message = (said.length > 0 ? said : (detail.split("\n")[0] ?? "")).trim();
  /** @type {string[]} */
  const attachments = [];
  for (const match of body.matchAll(/\[\[ATTACHMENT\|([^\]]+)\]\]/g)) {
    attachments.push((match[1] ?? "").trim());
  }
  return {
    name: attributes.name ?? "",
    suite: attributes.classname ?? suite,
    status: failure !== null ? "failed" : skipped ? "skipped" : "passed",
    message,
    detail,
    attachments,
  };
}

/**
 * Which of the manifest's scenario ids a test case name carries. An id is found as a whole
 * token, so `E1` is not in `E10 …`.
 *
 * @param {string} name
 * @param {readonly string[]} ids
 * @returns {string | undefined}
 */
export function scenarioOf(name, ids) {
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(name)) {
      return id;
    }
  }
  return undefined;
}
