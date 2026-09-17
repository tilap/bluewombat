/**
 * The environment every git this package spawns runs with — the identity the
 * system commits under, and how it authenticates against the remote. Both
 * come from the reference the manager named, read once by `reference.parse`
 * at boot; every later `git` (clone, ls-remote, fold) picks them up here.
 *
 * Nothing is written to disk: the credential helper is an inline shell
 * function that reads the token from the environment at the moment git asks,
 * so `.git/config` never holds it and a `git` run by hand in the copy does
 * not either.
 */

export type GitIdentity = { name: string; email: string };

let current: Record<string, string> = {};

/** What `reference.parse` decided for this run; empty until it ran. */
export function runEnv(): Record<string, string> {
  return { ...current };
}

export function setRunEnv(env: Record<string, string>): void {
  current = { ...env };
}

/** For tests: back to a process that inherits its own git identity. */
export function clearRunEnv(): void {
  current = {};
}

/**
 * Build the environment for one reference. `credentialEnv` names the
 * variable the token is in; the helper reads it when git asks, and refuses a
 * terminal prompt so a missing token fails rather than hangs.
 */
export function envFor(input: {
  author?: GitIdentity | undefined;
  credentialEnv?: string | undefined;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (input.author !== undefined) {
    env.GIT_AUTHOR_NAME = input.author.name;
    env.GIT_AUTHOR_EMAIL = input.author.email;
    env.GIT_COMMITTER_NAME = input.author.name;
    env.GIT_COMMITTER_EMAIL = input.author.email;
  }
  if (input.credentialEnv !== undefined) {
    // An empty helper first: it clears the list, so the machine's own helpers
    // (a keychain with the operator's account) are not asked before ours.
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = "credential.helper";
    env.GIT_CONFIG_VALUE_0 = "";
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 = `!f() { echo username=x-access-token; echo "password=\${${input.credentialEnv}}"; }; f`;
    env.GIT_TERMINAL_PROMPT = "0";
  }
  return env;
}
