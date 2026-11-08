import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SupervisorConfig } from "./config.js";
import { type Decision, lastJson, parseDecision } from "./decision.js";
import { type Exec, type ExecResult, fill, succeeded, tail } from "./exec.js";
import {
  arbiterPrompt,
  type Brief,
  remedyPrompt,
  rootcausePrompt,
  skepticPrompt,
} from "./prompts.js";

export type Deliberation =
  | { ok: true; decision: Decision; reports: Record<string, string> }
  | { ok: false; reason: string; reports: Record<string, string> };

const ANALYSTS = [
  ["rootcause", rootcausePrompt],
  ["remedy", remedyPrompt],
  ["skeptic", skepticPrompt],
] as const;

/** Cap what one member's report adds to the arbiter's page. */
const REPORT_CHARS = 30_000;

export type AgentRunInput = {
  config: SupervisorConfig;
  exec: Exec;
  role: string;
  prompt: string;
  /** Where the prompt and the answer are filed. */
  dir: string;
  cwd: string;
  addDirs: string[];
};

/** One agent, once: its prompt written down, its answer kept. */
export async function runAgent(input: AgentRunInput): Promise<{ ok: boolean; text: string }> {
  mkdirSync(input.dir, { recursive: true });
  const promptFile = join(input.dir, `${input.role}.prompt.md`);
  writeFileSync(promptFile, input.prompt);
  const spec = input.config.agents[input.role];
  if (spec === undefined) {
    return { ok: false, text: `no agent configured for ${input.role}` };
  }
  const result = await input.exec(
    fill(
      spec.cmd,
      { prompt: input.prompt, promptFile },
      { addDirArgs: input.addDirs.flatMap((dir) => ["--add-dir", dir]) },
    ),
    { cwd: input.cwd, timeoutMs: spec.timeoutMs },
  );
  const ok = succeeded(result) || answeredBeforeCeiling(result);
  const text = ok ? result.stdout : tail(result);
  writeFileSync(join(input.dir, `${input.role}.out.md`), text);
  return { ok, text };
}

/**
 * Every role ends its answer with a JSON block. An agent cut at its ceiling
 * after writing one finished its work: the answer is kept, not counted as lost.
 */
function answeredBeforeCeiling(result: ExecResult): boolean {
  const value = result.atCeiling === true ? lastJson(result.stdout) : undefined;
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Three members read the same stop from different seats; an arbiter decides.
 *
 * The members run together and apart: none sees another's answer, so they
 * cannot settle on the first idea. The arbiter sees all three and the code.
 * A member that fails does not stop the others; fewer than two answers is no
 * council. An arbiter that answers badly is asked once more, told why.
 */
export async function deliberate(input: {
  config: SupervisorConfig;
  exec: Exec;
  brief: Brief;
  dir: string;
  cwd: string;
}): Promise<Deliberation> {
  const addDirs = [...new Set([...input.brief.codeRoots, input.brief.ledgerRoot])];
  const base = { config: input.config, exec: input.exec, dir: input.dir, cwd: input.cwd, addDirs };
  const answers = await Promise.all(
    ANALYSTS.map(async ([role, prompt]) => ({
      role,
      ...(await runAgent({ ...base, role, prompt: prompt(input.brief) })),
    })),
  );
  const reports: Record<string, string> = {};
  for (const answer of answers) {
    if (answer.ok) {
      reports[answer.role] = answer.text.slice(-REPORT_CHARS);
    }
  }
  if (Object.keys(reports).length < 2) {
    return {
      ok: false,
      reason: `only ${Object.keys(reports).length} of ${ANALYSTS.length} members answered: ${answers
        .filter((a) => !a.ok)
        .map((a) => `${a.role}: ${a.text.slice(0, 200)}`)
        .join(" | ")}`,
      reports,
    };
  }
  const targets = input.config.targets.map((target) => target.name);
  let prompt = arbiterPrompt(input.brief, reports);
  let reason = "";
  for (let round = 0; round < 2; round++) {
    const arbiter = await runAgent({ ...base, role: "arbiter", prompt });
    if (!arbiter.ok) {
      reason = `the arbiter failed: ${arbiter.text.slice(0, 300)}`;
      continue;
    }
    const parsed = parseDecision(arbiter.text, targets);
    if (parsed.ok) {
      return { ok: true, decision: parsed.decision, reports };
    }
    reason = `the arbiter's answer was refused: ${parsed.reason}`;
    prompt = `${arbiterPrompt(input.brief, reports)}\n\n## Your previous answer was refused\n${parsed.reason}\nAnswer again, in the required form.`;
  }
  return { ok: false, reason, reports };
}
