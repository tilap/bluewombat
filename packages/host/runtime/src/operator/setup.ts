import type { SetupStep } from "@bluewombat/manager-kit";
import { CLI_NAME } from "@bluewombat/manager-kit";
import { parseArgs } from "../config/parse-args.js";
import { contextOf, distinctManagers, loadManagerModule, requestOf } from "../plugins/manager.js";

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

  // The tracker round trips below can take a while: say something first.
  input.write(
    apply ? "Applying the configuration to the tracker...\n\n" : "Checking the tracker...\n\n",
  );

  const common = {
    configDir: invocation.configDir,
    durationMs: invocation.timeoutMs,
    interruptFlag: input.interruptFlag ?? { interrupted: false },
    env: input.env,
  };
  const steps: SetupStep[] = [];
  for (const one of distinctManagers(invocation)) {
    const request = requestOf(one.spec, common, one.sides);
    const loaded = await loadManagerModule(request);
    if (!loaded.ok) {
      input.write(`${loaded.reason}\n`);
      return 2;
    }
    if (loaded.module.setupManager === undefined) {
      input.write(`${String(one.spec.package)} has nothing to set up.\n`);
      continue;
    }
    const result = await loaded.module.setupManager(contextOf(request), { apply });
    steps.push(...result.steps);
  }
  for (const step of steps) {
    const detail = step.detail === undefined ? "" : ` — ${step.detail}`;
    input.write(`${MARKS[step.state]}  ${step.summary}${detail}\n`);
  }
  const result = { steps };

  const blocked = result.steps.filter((step) => step.state === "blocked").length;
  if (blocked > 0) {
    input.write(`\n${blocked} step(s) blocked.\n`);
    return 1;
  }
  const missing = result.steps.filter((step) => step.state === "missing").length;
  if (missing > 0) {
    input.write(`\n${missing} step(s) to apply. Run: ${CLI_NAME} setup --apply\n`);
    return 0;
  }
  const applied = result.steps.filter((step) => step.state === "applied").length;
  input.write(applied > 0 ? `\n${applied} step(s) applied.\n` : "\nNothing to do.\n");
  return 0;
}
