import { createHash } from "node:crypto";

/**
 * A ref name for one Isolation, from its id.
 *
 * An unnamed Child leaves nothing behind: once its directory is gone, no one
 * can see what the work was. The name is derived rather than asked for, so the
 * contract keeps one id and gains no second identity to keep in step.
 */
/**
 * What the branch is named after: the tracked item it works on, not the tool
 * that made it. The tool is one git user among others on the repository; the
 * branch outlives its run and is read by people who never heard of it.
 */
const REF_PREFIX = "issue";

/**
 * `<scheme>:<path>#<number>[:<rest>]` is how a tracker names an item — a
 * GitHub issue, a GitLab one — and inside one Project the work line belongs to
 * one repository, so the number alone tells the branches apart. An id in any
 * other shape keeps its whole slug.
 */
const TRACKED_ITEM = /^[a-z][a-z0-9+.-]*:(?:[^#]*\/)?[^#/]*#(\d+)(?::(.+))?$/i;

/** Where a slug is cut; past it, a digest of the whole id keeps two long ids apart. */
const MAX_SLUG = 80;
const DIGEST_LENGTH = 7;

export function branchNameOf(id: string): string {
  const item = TRACKED_ITEM.exec(id);
  const short =
    item?.[1] === undefined ? id : item[2] === undefined ? item[1] : `${item[1]}:${item[2]}`;
  const slug = short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_SLUG) {
    return `${REF_PREFIX}/${slug.length > 0 ? slug : "isolation"}`;
  }
  // Two ids that differ only past the cut would otherwise share a name, and
  // `-B` would reset one Isolation's branch onto the other's. The digest is
  // of the id as given, so the name stays a function of the id alone.
  const digest = createHash("sha256").update(id).digest("hex").slice(0, DIGEST_LENGTH);
  const head = slug.slice(0, MAX_SLUG - DIGEST_LENGTH - 1).replace(/-+$/, "");
  return `${REF_PREFIX}/${head}-${digest}`;
}
