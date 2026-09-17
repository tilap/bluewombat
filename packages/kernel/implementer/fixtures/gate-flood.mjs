#!/usr/bin/env node
// A child that never stops writing. Its answer cannot be read.
const line = `${"y".repeat(1023)}\n`;
function pump() {
  for (let i = 0; i < 256; i++) {
    if (!process.stdout.write(line)) {
      process.stdout.once("drain", pump);
      return;
    }
  }
  setImmediate(pump);
}
pump();
