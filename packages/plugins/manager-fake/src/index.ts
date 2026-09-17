import { existsSync, mkdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  type CreateManagerResult,
  type Finding,
  intOption,
  type ManagerContext,
  type ManagerScaffold,
  PRODUCT,
  rejectUnknownOptions,
  stringOption,
} from "@bluewombat/manager-kit";
import { createFakeManager } from "./manager.js";

export type { FakeManagerOptions } from "./manager.js";
export { createFakeManager } from "./manager.js";

const KNOWN_OPTIONS = ["source", "target", "defaultPriority"] as const;

type Read =
  | { ok: true; source: string; target: string; defaultPriority: number | undefined }
  | { ok: false; reason: string };

/**
 * `manager: "@bluewombat/manager-fake"` in the config resolves here. Paths are
 * relative to the config file, so a checked-in example needs no absolute path.
 */
export function createManager(context: ManagerContext): CreateManagerResult {
  const read = readOptions(context);
  if (!read.ok) {
    return read;
  }
  if (!existsSync(read.source) || !statSync(read.source).isDirectory()) {
    return { ok: false, reason: `managerOptions "source" is not a directory: ${read.source}` };
  }
  mkdirSync(read.target, { recursive: true });
  const options: Parameters<typeof createFakeManager>[0] = {
    source: read.source,
    emitterTarget: read.target,
    durationMs: context.durationMs,
    interruptFlag: context.interruptFlag,
  };
  if (read.defaultPriority !== undefined) {
    options.defaultPriority = read.defaultPriority;
  }
  return { ok: true, manager: createFakeManager(options) };
}

const DEFAULT_SOURCE = `./.${PRODUCT}/source`;
const DEFAULT_TARGET = `./.${PRODUCT}/threads`;

/**
 * What `mason init` writes. `createManager` still refuses a missing Source:
 * this only prepares the directories so the first file has somewhere to go.
 */
export function scaffoldManager(context: ManagerContext): ManagerScaffold {
  const source =
    typeof context.options.source === "string" ? context.options.source : DEFAULT_SOURCE;
  const target =
    typeof context.options.target === "string" ? context.options.target : DEFAULT_TARGET;
  return {
    options: { source, target },
    nextSteps: [`drop a JSON intention into ${source}`],
    prepare(cwd: string) {
      mkdirSync(resolve(cwd, source), { recursive: true });
      mkdirSync(resolve(cwd, target), { recursive: true });
    },
  };
}

/** What `mason doctor` reports. Filesystem only, no network. */
export function checkManager(context: ManagerContext): Finding[] {
  const read = readOptions(context);
  if (!read.ok) {
    return [{ level: "fail", label: "manager options", detail: read.reason }];
  }
  const sourceOk = existsSync(read.source) && statSync(read.source).isDirectory();
  return [
    sourceOk
      ? { level: "ok", label: "Source directory", detail: read.source }
      : { level: "fail", label: "Source directory", detail: `not a directory: ${read.source}` },
    existsSync(read.target)
      ? { level: "ok", label: "Thread directory", detail: read.target }
      : { level: "warn", label: "Thread directory", detail: `created on run: ${read.target}` },
  ];
}

function readOptions(context: ManagerContext): Read {
  const known = rejectUnknownOptions(context.options, KNOWN_OPTIONS);
  if (!known.ok) {
    return known;
  }
  const source = stringOption(context.options, "source");
  if (!source.ok) {
    return source;
  }
  if (source.value === undefined) {
    return { ok: false, reason: 'managerOptions "source" is required (directory of intentions).' };
  }
  const target = stringOption(context.options, "target");
  if (!target.ok) {
    return target;
  }
  if (target.value === undefined) {
    return { ok: false, reason: 'managerOptions "target" is required (directory of Threads).' };
  }
  const defaultPriority = intOption(context.options, "defaultPriority", 0, 100);
  if (!defaultPriority.ok) {
    return defaultPriority;
  }
  return {
    ok: true,
    source: absolute(source.value, context.configDir),
    target: absolute(target.value, context.configDir),
    defaultPriority: defaultPriority.value,
  };
}

function absolute(path: string, configDir: string): string {
  return isAbsolute(path) ? path : resolve(configDir, path);
}
