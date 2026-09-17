import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { GateSpec, Invocation, ParseResult } from "../types.js";

const IMPLEMENTER_FLAGS = new Set([
  "--id",
  "--intention",
  "--definition-of-done",
  "--report",
  "--report-from",
  "--context",
  "--stage",
  "--workspace",
  "--builder",
  "--builder-timeout-ms",
  "--repair-builder",
  "--repair-builder-timeout-ms",
  "--gate",
  "--gate-timeout-ms",
  "--max-attempts",
  "--on-status",
]);

function isImplementerFlag(token: string): boolean {
  return IMPLEMENTER_FLAGS.has(token);
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
    if (token !== undefined && isImplementerFlag(token)) {
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

/**
 * Parse Implementer CLI argv (without node/script). Malformed input → not ok.
 */
export function parseArgs(argv: string[]): ParseResult {
  let id: string | undefined;
  let intention: string | undefined;
  let definitionOfDone: string | undefined;
  let report: string | undefined;
  let reportFrom: string | undefined;
  let context: string | undefined;
  let stage: "unit" | "assembly" | undefined;
  let workspace: string | undefined;
  let builderArgv: string[] | undefined;
  let repairArgv: string[] | undefined;
  let builderTimeoutMs: number | undefined;
  let repairTimeoutMs: number | undefined;
  const gates: GateSpec[] = [];
  const seenGateIds = new Set<string>();
  let maxAttempts: number | undefined;
  let gateTimeoutMs: number | undefined;
  let onStatusArgv: string[] | undefined;

  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }

    if (token === "--id") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --id." };
      }
      id = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--intention") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --intention." };
      }
      intention = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--definition-of-done") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --definition-of-done." };
      }
      definitionOfDone = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--report") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --report." };
      }
      report = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--report-from") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --report-from." };
      }
      reportFrom = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--stage") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --stage." };
      }
      if (taken.value !== "unit" && taken.value !== "assembly") {
        return { ok: false, reason: `--stage is unit or assembly, not "${taken.value}".` };
      }
      stage = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--context") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --context." };
      }
      context = taken.value;
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

    if (token === "--builder") {
      const command = takeCommandArgv(argv, i + 1);
      if (!command) {
        return { ok: false, reason: "Missing non-empty Builder command after --builder --." };
      }
      builderArgv = command.command;
      i = command.next;
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

    if (token === "--max-attempts") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: "Missing value for --max-attempts." };
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return { ok: false, reason: "--max-attempts must be a positive integer." };
      }
      maxAttempts = value;
      i = taken.next;
      continue;
    }

    if (token === "--builder-timeout-ms" || token === "--repair-builder-timeout-ms") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return { ok: false, reason: `Missing value for ${token}.` };
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return { ok: false, reason: `${token} must be a positive integer.` };
      }
      if (token === "--builder-timeout-ms") {
        builderTimeoutMs = value;
      } else {
        repairTimeoutMs = value;
      }
      i = taken.next;
      continue;
    }

    if (token === "--repair-builder") {
      const command = takeCommandArgv(argv, i + 1);
      if (!command) {
        return { ok: false, reason: "Missing non-empty command after --repair-builder --." };
      }
      repairArgv = command.command;
      i = command.next;
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

    return { ok: false, reason: `Unknown argument "${token}".` };
  }

  if (id === undefined) {
    return { ok: false, reason: "Missing required --id." };
  }
  if (intention === undefined) {
    return { ok: false, reason: "Missing required --intention." };
  }
  if (definitionOfDone === undefined) {
    return { ok: false, reason: "Missing required --definition-of-done." };
  }
  if (workspace === undefined) {
    return { ok: false, reason: "Missing required --workspace." };
  }
  if (maxAttempts === undefined) {
    return { ok: false, reason: "Missing required --max-attempts." };
  }
  if (builderTimeoutMs === undefined) {
    return { ok: false, reason: "Missing required --builder-timeout-ms." };
  }
  if (repairArgv !== undefined && builderArgv === undefined) {
    return { ok: false, reason: "--repair-builder needs a --builder to fall back to." };
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

  const invocation: Invocation = {
    id,
    intention,
    definitionOfDone,
    workspace,
    ...(builderArgv === undefined ? {} : { builderArgv }),
    ...(repairArgv === undefined ? {} : { repairArgv }),
    gates,
    maxAttempts,
    builderTimeoutMs,
    ...(repairTimeoutMs === undefined ? {} : { repairTimeoutMs }),
  };
  if (report !== undefined) {
    invocation.report = report;
  }
  if (reportFrom !== undefined) {
    invocation.reportFrom = reportFrom;
  }
  if (context !== undefined) {
    invocation.context = context;
  }
  if (stage !== undefined) {
    invocation.stage = stage;
  }
  if (onStatusArgv !== undefined) {
    invocation.onStatusArgv = onStatusArgv;
  }
  return { ok: true, invocation };
}
