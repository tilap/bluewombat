import { spawnSync } from "node:child_process";
import type { AuthorityPort } from "@bluewombat/conductor";
import { featureWorkspacePath, subjectOf } from "@bluewombat/conductor";
import type { ManagerPort, SubmissionRequest } from "@bluewombat/manager-kit";
import type { PassSpec } from "../config/types.js";
import { describe } from "./describe.js";
import type { Journal } from "./journal.js";

/**
 * The Authority, as Host wires it.
 *
 * Two halves that do not belong to the same world: publishing the work is an
 * operation on a directory Host owns, and offering it to the outside belongs to
 * the FeatureManager. Host runs the first as a slot it never reads into, then
 * hands the second the name that slot published under. Neither of them judges:
 * that is a Gate.
 *
 * The Publisher is a slot for the same reason the Builder is one: `git push` is
 * one way to put work in front of a judge, not the only one, and a Project that
 * places its work some other way changes that command and nothing else.
 */
export function openAuthority(input: {
  manager: ManagerPort;
  workLineStable: string;
  workLineTarget: string;
  publishArgv: string[];
  timeoutMs: number;
  /** The isolation strategy's name for a Child, from its id. */
  refOf: (id: string) => string;
  /** The work line's git environment (identity, credentials), for the Publisher. */
  env?: Record<string, string> | undefined;
  /** How the work describes itself, when the Project has a slot for it. */
  describe?: PassSpec | undefined;
  workspaceRoot?: string | undefined;
  journal?: Journal | undefined;
}): AuthorityPort | undefined {
  const { manager, workLineStable, workLineTarget, publishArgv, timeoutMs, refOf } = input;
  if (manager.submit === undefined || manager.fold === undefined) {
    return undefined;
  }
  const submit = manager.submit.bind(manager);
  const fold = manager.fold.bind(manager);

  return {
    async submit(offer) {
      // The name the strategy gave this feature's Child. What the Publisher
      // does with it — push it, copy it, upload it — is the Publisher's business.
      const ref = refOf(offer.ref);
      const published = publish({
        argv: publishArgv,
        cwd: workLineStable,
        id: offer.key,
        ref,
        target: workLineTarget,
        timeoutMs,
        env: input.env,
      });
      if (!published.ok) {
        input.journal?.append({
          event: "submit-refused",
          key: offer.key,
          by: "publisher",
          reason: published.reason,
        });
        return { outcome: "refused", reason: published.reason };
      }
      // The Project's own words for what it submits, when it has a slot for
      // them; the Authority puts them where its kind of Submission is read.
      // Asked in the feature workspace, where the whole change is.
      let description: SubmissionRequest["description"];
      if (input.describe !== undefined && input.workspaceRoot !== undefined) {
        const asked = describe(input.describe, {
          id: offer.key,
          title: offer.title ?? offer.key,
          intention: offer.intention ?? "",
          target: workLineTarget,
          cwd: featureWorkspacePath(input.workspaceRoot, offer.key),
        });
        if (asked.ok) {
          description = asked.description;
        } else {
          input.journal?.append({ event: "describe-skipped", id: offer.key, detail: asked.detail });
        }
      }
      const submitted = await submit({
        ...offer,
        ref: published.ref,
        target: workLineTarget,
        // What the Submission lists as its work: one line per Subtask, the way
        // the plan was said on the tracker, not the whole intentions.
        ...(offer.steps === undefined ? {} : { steps: offer.steps.map(subjectOf) }),
        ...(description === undefined ? {} : { description }),
      });
      if (submitted.outcome === "refused") {
        input.journal?.append({
          event: "submit-refused",
          key: offer.key,
          by: "authority",
          reason: submitted.reason,
        });
      }
      return submitted;
    },
    async fold(asked) {
      return await fold(asked);
    },
  };
}

type Published = { ok: true; ref: string } | { ok: false; reason: string };

/**
 * Run the Publisher slot in the work line and read the one line it answers.
 *
 * Same contract as every other slot: argv in, one JSON object on stdout. A slot
 * that cannot run at all is a refusal like any other here — the Submission does
 * not happen, the reason reaches the tracker, and the next pass tries again.
 */
function publish(input: {
  argv: string[];
  cwd: string;
  id: string;
  ref: string;
  target: string;
  timeoutMs: number;
  env?: Record<string, string> | undefined;
}): Published {
  const [command, ...rest] = input.argv;
  if (command === undefined) {
    return { ok: false, reason: "No Publisher is configured, so nothing can be submitted." };
  }
  const run = spawnSync(
    command,
    [...rest, "--id", input.id, "--ref", input.ref, "--target", input.target],
    {
      cwd: input.cwd,
      encoding: "utf8",
      timeout: input.timeoutMs,
      env: { ...process.env, ...input.env },
    },
  );
  if (run.error !== undefined) {
    return { ok: false, reason: `Publisher could not run: ${run.error.message}` };
  }
  const answer = lastJsonLine(run.stdout ?? "");
  if (answer === undefined) {
    const detail = `${run.stderr ?? ""}`.trim().slice(-1000);
    return {
      ok: false,
      reason: `Publisher stdout is not a JSON object.${detail.length > 0 ? ` ${detail}` : ""}`,
    };
  }
  if (typeof answer.ref === "string" && answer.ref.length > 0) {
    return { ok: true, ref: answer.ref };
  }
  if (answer.outcome === "refused") {
    const reason = typeof answer.reason === "string" ? answer.reason : "no reason given";
    return { ok: false, reason };
  }
  return { ok: false, reason: "Publisher answered neither a reference nor a refusal." };
}

function lastJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Not the contract line. A slot may write anything else to stderr, but
      // stdout noise is its own bug — keep looking for a line that parses.
    }
  }
  return undefined;
}

/**
 * Bring the work line copy up to what the Authority holds, through the slot the
 * Project named.
 *
 * The other half of the same seam as the Publisher: one puts the work where the
 * judge reads, the other reads back what the judge accepted. `git fetch` is one
 * way to do that, not the only one, so neither belongs in Host.
 */
export function refreshWorkLine(input: {
  workLineStable: string;
  workLineTarget: string;
  refreshArgv: string[];
  timeoutMs: number;
  env?: Record<string, string> | undefined;
}): { ok: boolean; detail?: string } {
  const [command, ...rest] = input.refreshArgv;
  if (command === undefined) {
    return { ok: false, detail: "No Refresher is configured." };
  }
  const run = spawnSync(command, [...rest, "--target", input.workLineTarget], {
    cwd: input.workLineStable,
    encoding: "utf8",
    timeout: input.timeoutMs,
    env: { ...process.env, ...input.env },
  });
  if (run.error !== undefined) {
    return { ok: false, detail: `Refresher could not run: ${run.error.message}` };
  }
  const answer = lastJsonLine(run.stdout ?? "");
  if (answer === undefined) {
    const detail = `${run.stderr ?? ""}`.trim().slice(-500);
    return { ok: false, detail: `Refresher stdout is not a JSON object. ${detail}`.trim() };
  }
  if (answer.ok === true) {
    return { ok: true };
  }
  const reason = typeof answer.reason === "string" ? answer.reason : "no reason given";
  return { ok: false, detail: reason };
}
