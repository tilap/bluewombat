import { join, resolve } from "node:path";
import { PRODUCT } from "@bluewombat/manager-kit";

/**
 * Where Host keeps what is its own — the ledger, the workspaces, its copy of
 * the work line. One directory, so one line in a `.gitignore` covers it and
 * nothing the system writes lands next to the operator's files.
 *
 * `workspaceRoot` and `ledger` in the config still move each part on its own;
 * this is only where they go when nobody says.
 */
export const DEFAULT_HOME = `./.${PRODUCT}`;

export const HOME_LAYOUT = {
  workspaces: "workspaces",
  ledger: "ledger",
  workLine: "work-line",
} as const;

export function homeOf(configDir: string, home: string | undefined): string {
  return resolve(configDir, home ?? DEFAULT_HOME);
}

export function inHome(home: string, part: keyof typeof HOME_LAYOUT): string {
  return join(home, HOME_LAYOUT[part]);
}
