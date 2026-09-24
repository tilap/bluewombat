#!/usr/bin/env node
/** A reviewer that refuses the assembled feature, having done nothing else. */
process.stdout.write(
  `${JSON.stringify({
    type: "result",
    is_error: false,
    result: "MASON_VERDICT: REFUSED: the CLI flag from the intention is missing from the diff.",
  })}\n`,
);
process.exit(0);
