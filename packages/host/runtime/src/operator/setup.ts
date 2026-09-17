import type { SetupStep } from "@bluewombat/manager-kit";
import { PRODUCT } from "@bluewombat/manager-kit";
import { parseArgs } from "../config/parse-args.js";
import { contextOf, loadManagerModule } from "../plugins/manager.js";

export type SetupInput = {
  cwd: string;
  argv: string[];
  env: Record<string, string | undefined>;
  write: (line: string) => void;
  interruptFlag?: { interrupted: boolean };
};

const MARKS: Record<SetupStep["state"], string> = {
  satisfied: "ok  ",
  missing: "todo",
  applied: "done",
  blocked: "FAIL",
};

/**
 * Bring the tracker to the shape a run expects.
 *
 * Host knows none of that shape: it resolves the manager, asks it for a plan,
 * and prints what comes back. Without `--apply` nothing is written — creating
 * anything on somebody's tracker is asked for, never assumed.
 */
export async function runSetup(input: SetupInput): Promise<number> {
  const apply = input.argv.includes("--apply");
  const argv = input.argv.filter((token) => token !== "--apply");

  const parsed = parseArgs(argv, { cwd: input.cwd, checkPaths: false });
  if (!parsed.ok) {
    input.write(`${parsed.reason}\n`);
    return 2;
  }
  const invocation = parsed.invocation;

  const request = {
    manager: invocation.manager,
    managerOptions: invocation.managerOptions,
    configDir: invocation.configDir,
    durationMs: invocation.timeoutMs,
    interruptFlag: input.interruptFlag ?? { interrupted: false },
    env: input.env,
  };
  const loaded = await loadManagerModule(request);
  if (!loaded.ok) {
    input.write(`${loaded.reason}\n`);
    return 2;
  }
  if (loaded.module.setupManager === undefined) {
    input.write(`${invocation.manager} has nothing to set up.\n`);
    return 0;
  }

  const result = await loaded.module.setupManager(contextOf(request), { apply });
  for (const step of result.steps) {
    const detail = step.detail === undefined ? "" : ` — ${step.detail}`;
    input.write(`${MARKS[step.state]}  ${step.summary}${detail}\n`);
  }

  const blocked = result.steps.filter((step) => step.state === "blocked").length;
  if (blocked > 0) {
    input.write(`\n${blocked} step(s) blocked.\n`);
    return 1;
  }
  const missing = result.steps.filter((step) => step.state === "missing").length;
  if (missing > 0) {
    input.write(`\n${missing} step(s) to apply. Run: ${PRODUCT} setup --apply\n`);
    return 0;
  }
  const applied = result.steps.filter((step) => step.state === "applied").length;
  input.write(applied > 0 ? `\n${applied} step(s) applied.\n` : "\nNothing to do.\n");
  return 0;
}
