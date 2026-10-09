import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GateSpec, Invocation, ParseResult } from "../types.js";

const BREAKDOWN_FLAGS = new Set([
  "--feature",
  "--max-feature-bytes",
  "--max-units",
  "--planner",
  "--planner-duration-ms",
  "--on-status",
  "--at",
  "--workspace",
  "--gate",
  "--gate-timeout-ms",
]);

function isBreakdownFlag(token: string): boolean {
  return BREAKDOWN_FLAGS.has(token);
}

function takeValue(argv: string[], index: number): { value: string; next: number } | null {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return null;
  }
  return { value, next: index + 2 };
}

function takeCommandArgv(
  argv: string[],
  start: number,
): { command: string[]; next: number } | null {
  if (argv[start] !== "--") {
    return null;
  }
  const command: string[] = [];
  let i = start + 1;
  while (i < argv.length) {
    const token = argv[i];
    if (token !== undefined && isBreakdownFlag(token)) {
      break;
    }
    if (token !== undefined) {
      command.push(token);
    }
    i += 1;
  }
  if (command.length === 0) {
    return null;
  }
  return { command, next: i };
}

function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}

function parseAt(raw: string): string | null {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return null;
  }
  return new Date(ms).toISOString();
}

/**
 * Parse FeatureBreakdown CLI argv (without node/script). Malformed input → not ok.
 * Does not read stdin.
 */
export function parseArgs(argv: string[]): ParseResult {
  let featureJson: string | undefined;
  let maxFeatureBytes: number | undefined;
  let maxUnits: number | undefined;
  let plannerArgv: string[] | undefined;
  let plannerDurationMs: number | undefined;
  let onStatusArgv: string[] | undefined;
  let plannedAt: string | undefined;
  let workspace: string | undefined;
  const gates: GateSpec[] = [];
  const seenGateIds = new Set<string>();
  let gateTimeoutMs: number | undefined;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }

    if (token === "--feature") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --feature." };
      }
      featureJson = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--max-feature-bytes") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --max-feature-bytes." };
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return { ok: false, reason: "--max-feature-bytes must be a positive integer." };
      }
      maxFeatureBytes = value;
      i = taken.next;
      continue;
    }

    if (token === "--max-units") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --max-units." };
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return { ok: false, reason: "--max-units must be a positive integer." };
      }
      maxUnits = value;
      i = taken.next;
      continue;
    }

    if (token === "--planner") {
      const command = takeCommandArgv(argv, i + 1);
      if (!command) {
        return { ok: false, reason: "Missing non-empty Planner command after --planner --." };
      }
      plannerArgv = command.command;
      i = command.next;
      continue;
    }

    if (token === "--planner-duration-ms") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --planner-duration-ms." };
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return { ok: false, reason: "--planner-duration-ms must be a positive integer." };
      }
      plannerDurationMs = value;
      i = taken.next;
      continue;
    }

    if (token === "--on-status") {
      const command = takeCommandArgv(argv, i + 1);
      if (!command) {
        return { ok: false, reason: "Missing non-empty command after --on-status --." };
      }
      onStatusArgv = command.command;
      i = command.next;
      continue;
    }

    if (token === "--at") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --at." };
      }
      const value = parseAt(taken.value);
      if (value === null) {
        return { ok: false, reason: "--at must be a parseable ISO-8601 timestamp." };
      }
      plannedAt = value;
      i = taken.next;
      continue;
    }

    if (token === "--workspace") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --workspace." };
      }
      workspace = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--gate") {
      const idTaken = takeValue(argv, i);
      if (!idTaken) {
        return { ok: false, reason: "Missing Gate id after --gate." };
      }
      const gateId = idTaken.value;
      if (seenGateIds.has(gateId)) {
        return { ok: false, reason: `Duplicate Gate id "${gateId}".` };
      }
      const command = takeCommandArgv(argv, idTaken.next);
      if (!command) {
        return {
          ok: false,
          reason: `Missing non-empty Gate command after --gate ${gateId} --.`,
        };
      }
      if (gateTimeoutMs === undefined) {
        return {
          ok: false,
          reason: `Gate "${gateId}" has no --gate-timeout-ms. Nothing else would bound it.`,
        };
      }
      seenGateIds.add(gateId);
      gates.push({ id: gateId, argv: command.command, timeoutMs: gateTimeoutMs });
      gateTimeoutMs = undefined;
      i = command.next;
      continue;
    }

    if (token === "--gate-timeout-ms") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --gate-timeout-ms." };
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return { ok: false, reason: "--gate-timeout-ms must be a positive integer." };
      }
      // Applies to the next --gate, so one ceiling per Gate is one flag.
      gateTimeoutMs = value;
      i = taken.next;
      continue;
    }

    return { ok: false, reason: `Unknown argument "${token}".` };
  }

  if (workspace === undefined) {
    return { ok: false, reason: "Missing required --workspace." };
  }
  if (!isAbsolute(workspace)) {
    return { ok: false, reason: "--workspace must be an absolute path." };
  }
  if (!existsSync(workspace)) {
    return { ok: false, reason: `--workspace does not exist: ${workspace}` };
  }
  try {
    if (!statSync(workspace).isDirectory()) {
      return { ok: false, reason: `--workspace is not a directory: ${workspace}` };
    }
  } catch {
    return { ok: false, reason: `--workspace is not usable: ${workspace}` };
  }

  if (maxFeatureBytes === undefined) {
    return { ok: false, reason: "Missing required --max-feature-bytes." };
  }
  if (maxUnits === undefined) {
    return { ok: false, reason: "Missing required --max-units." };
  }
  if (plannerArgv === undefined) {
    return { ok: false, reason: "Missing required --planner." };
  }
  if (plannerDurationMs === undefined) {
    return { ok: false, reason: "Missing required --planner-duration-ms." };
  }

  const invocation: Invocation = {
    maxFeatureBytes,
    maxUnits,
    plannerArgv,
    plannerDurationMs,
    workspace,
    gates,
  };
  if (featureJson !== undefined) {
    invocation.featureJson = featureJson;
  }
  if (onStatusArgv !== undefined) {
    invocation.onStatusArgv = onStatusArgv;
  }
  if (plannedAt !== undefined) {
    invocation.plannedAt = plannedAt;
  }
  return { ok: true, invocation };
}
