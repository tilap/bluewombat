/**
 * What the shipped templates say, and nothing about how a role runs: the
 * plumbing — parse, load, fill, spawn — is `@bluewombat/slot-kit`.
 */
import { take } from "@bluewombat/slot-kit";

/** @param {string | undefined} raw */
export function doneWhen(raw) {
  const done = (raw ?? "").trim();
  return done.length > 0 ? `Done when:\n${done}` : "";
}

/** @param {readonly string[]} argv */
export function attemptOf(argv) {
  const parsed = Number.parseInt(take(argv, "--attempt") ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}
