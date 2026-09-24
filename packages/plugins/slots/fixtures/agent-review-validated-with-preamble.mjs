#!/usr/bin/env node
/**
 * A reviewer that reasons out loud before its verdict, and whose reasoning
 * happens to use the bare words "validated" and "refused" in unrelated
 * sentences — exactly what a loose "search anywhere" parse would misread.
 * Only the `MASON_VERDICT:` line is the answer.
 */
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    is_error: false,
    result:
      "Each unit was already validated on its own before assembly. An earlier " +
      "round of this same feature was refused for an unrelated reason that is " +
      "now fixed, so I only need to judge the whole against the intention.\n" +
      "MASON_VERDICT: VALIDATED",
  })}\n`,
);
process.exit(0);
