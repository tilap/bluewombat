#!/usr/bin/env node
// Exits non-zero: visibility must not take the subscription down.
process.stderr.write("hook failed\n");
process.exit(3);
