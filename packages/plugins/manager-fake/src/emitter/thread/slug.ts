import { createHash } from "node:crypto";

const NAME_LIMIT = 48;

/**
 * Thread file name for a Feature key. The hash suffix is always appended:
 * slugging alone collides ("fake:42" and "fake/42"), and a collision silently
 * merges two Features' history.
 */
export function slugOf(key: string): string {
  const readable = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NAME_LIMIT)
    .replace(/-+$/g, "");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return readable.length === 0 ? digest : `${readable}-${digest}`;
}
