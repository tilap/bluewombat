#!/usr/bin/env node
// Echoes its own arguments back as an enrichment field, to prove what it received.
process.stdout.write(`${JSON.stringify({ title: process.argv.slice(2).join(" ") })}\n`);
