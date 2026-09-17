export type Repository = { owner: string; name: string };

/** GitHub's own shape for `owner/name`. */
const REPO_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function parseRepo(raw: string): Repository | null {
  const matched = REPO_PATTERN.exec(raw);
  if (matched === null) {
    return null;
  }
  const [, owner, name] = matched;
  if (owner === undefined || name === undefined) {
    return null;
  }
  return { owner, name };
}
