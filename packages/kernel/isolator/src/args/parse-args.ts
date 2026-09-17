import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Invocation, ParseResult } from "../types.js";

const ISOLATOR_FLAGS = new Set([
  "--id",
  "--parent",
  "--child",
  "--duration-ms",
  "--on-status",
  "--strategy",
]);

function isIsolatorFlag(token: string): boolean {
  return ISOLATOR_FLAGS.has(token);
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
    if (token !== undefined && isIsolatorFlag(token)) {
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathsOverlap(parent: string, child: string): boolean {
  const parentResolved = resolve(parent);
  const childResolved = resolve(child);
  if (parentResolved === childResolved) {
    return true;
  }
  const fromParent = relative(parentResolved, childResolved);
  const fromChild = relative(childResolved, parentResolved);
  const childInsideParent =
    fromParent !== "" && !fromParent.startsWith("..") && !isAbsolute(fromParent);
  const parentInsideChild =
    fromChild !== "" && !fromChild.startsWith("..") && !isAbsolute(fromChild);
  return childInsideParent || parentInsideChild;
}

function snapshotPartial(
  id: string | undefined,
  onStatusArgv: string[] | undefined,
): { id?: string; onStatusArgv?: string[] } {
  const partial: { id?: string; onStatusArgv?: string[] } = {};
  if (id !== undefined && id.length > 0) {
    partial.id = id;
  }
  if (onStatusArgv !== undefined) {
    partial.onStatusArgv = onStatusArgv;
  }
  return partial;
}

function withPartial(
  reason: string,
  id: string | undefined,
  onStatusArgv: string[] | undefined,
): ParseResult {
  const failure: ParseResult = { ok: false, reason };
  const partial = snapshotPartial(id, onStatusArgv);
  if (partial.id !== undefined) {
    failure.id = partial.id;
  }
  if (partial.onStatusArgv !== undefined) {
    failure.onStatusArgv = partial.onStatusArgv;
  }
  return failure;
}

/**
 * Parse Isolator CLI argv (without node/script). Malformed input → not ok.
 */
export function parseArgs(argv: string[]): ParseResult {
  let id: string | undefined;
  let parent: string | undefined;
  let child: string | undefined;
  let durationMs: number | undefined;
  let strategy: string | undefined;
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
        return withPartial("Missing value for --id.", id, onStatusArgv);
      }
      id = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--parent") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return withPartial("Missing value for --parent.", id, onStatusArgv);
      }
      parent = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--child") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return withPartial("Missing value for --child.", id, onStatusArgv);
      }
      child = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--duration-ms") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return withPartial("Missing value for --duration-ms.", id, onStatusArgv);
      }
      const value = parsePositiveInt(taken.value);
      if (value === null) {
        return withPartial("--duration-ms must be a positive integer.", id, onStatusArgv);
      }
      durationMs = value;
      i = taken.next;
      continue;
    }

    if (token === "--strategy") {
      const taken = takeValue(argv, i);
      if (!taken) {
        return withPartial("Missing value for --strategy.", id, onStatusArgv);
      }
      if (taken.value.length === 0) {
        return withPartial(
          "--strategy must be a non-empty package name or path.",
          id,
          onStatusArgv,
        );
      }
      strategy = taken.value;
      i = taken.next;
      continue;
    }

    if (token === "--on-status") {
      const command = takeCommandArgv(argv, i + 1);
      if (!command) {
        return withPartial("Missing non-empty command after --on-status --.", id, onStatusArgv);
      }
      onStatusArgv = command.command;
      i = command.next;
      continue;
    }

    return withPartial(`Unknown argument "${token}".`, id, onStatusArgv);
  }

  if (id === undefined) {
    return withPartial("Missing required --id.", id, onStatusArgv);
  }
  if (id.length === 0) {
    return withPartial("--id must be non-empty.", undefined, onStatusArgv);
  }
  if (parent === undefined) {
    return withPartial("Missing required --parent.", id, onStatusArgv);
  }
  if (child === undefined) {
    return withPartial("Missing required --child.", id, onStatusArgv);
  }
  if (durationMs === undefined) {
    return withPartial("Missing required --duration-ms.", id, onStatusArgv);
  }
  if (strategy === undefined) {
    return withPartial(
      "Missing required --strategy. Pass a package name or path that exports strategy.",
      id,
      onStatusArgv,
    );
  }

  if (!isAbsolute(parent)) {
    return withPartial("--parent must be an absolute path.", id, onStatusArgv);
  }
  if (!isAbsolute(child)) {
    return withPartial("--child must be an absolute path.", id, onStatusArgv);
  }
  if (!existsSync(parent)) {
    return withPartial(`--parent does not exist: ${parent}`, id, onStatusArgv);
  }
  if (!isDirectory(parent)) {
    return withPartial(`--parent is not a directory: ${parent}`, id, onStatusArgv);
  }
  if (existsSync(child)) {
    return withPartial(`--child already exists: ${child}`, id, onStatusArgv);
  }
  const childContainer = dirname(child);
  if (existsSync(childContainer) && !isDirectory(childContainer)) {
    return withPartial(
      `Child containing directory is not a directory: ${childContainer}`,
      id,
      onStatusArgv,
    );
  }
  if (pathsOverlap(parent, child)) {
    return withPartial(
      "--parent and --child must not be the same path, and neither may be a prefix of the other.",
      id,
      onStatusArgv,
    );
  }

  const invocation: Invocation = {
    id,
    parent: resolve(parent),
    child: resolve(child),
    durationMs,
  };
  if (onStatusArgv !== undefined) {
    invocation.onStatusArgv = onStatusArgv;
  }
  return { ok: true, invocation, strategy };
}
