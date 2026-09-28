import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GateSpec } from "@bluewombat/implementer";
import { parse as parseYaml } from "yaml";
import type {
  AssemblySpec,
  AuthoritySpec,
  HostInvocation,
  ObservabilitySpec,
  PassSpec,
  StageSpec,
} from "./types.js";

const KNOWN_KEYS = new Set([
  "manager",
  "managerOptions",
  "home",
  "workLine",
  "workspaceRoot",
  "ledger",
  "persist",
  "planner",
  "builder",
  "assembly",
  "authority",
  "observability",
  "timeoutMs",
  "maxRefusals",
  "pollIntervalMs",
]);

const WORK_LINE_KEYS = new Set(["stable", "branch", "isolation", "isolationOptions"]);
const PASS_KEYS = new Set(["cmd", "timeoutMs"]);
const STAGE_KEYS = new Set(["producer", "repair", "maxAttempts", "gates"]);
const ASSEMBLY_KEYS = new Set(["fix", "validate", "maxAttempts", "gates"]);
const GATES_KEYS = new Set(["defaultTimeoutMs", "gates"]);
const AUTHORITY_KEYS = new Set(["enabled", "publish", "refresh", "describe"]);
const OBSERVABILITY_KEYS = new Set(["streams"]);
const STREAMS_KEYS = new Set(["enabled", "dir", "keep"]);
const STREAM_NAMES = new Set(["stdout", "stderr"]);

export type LoadedConfig =
  | { ok: true; invocation: Partial<HostInvocation> }
  | { ok: false; reason: string };

/**
 * Read one YAML document and resolve relative paths against the file's directory.
 */
export function loadConfig(path: string): LoadedConfig {
  const file = resolve(path);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: `Cannot read config file: ${file}` };
  }
  let parsed: unknown;
  try {
    // `uniqueKeys` (default) refuses a repeated key rather than silently
    // keeping the last one, the way `JSON.parse` used to.
    parsed = parseYaml(raw);
  } catch {
    return { ok: false, reason: `Config is not valid YAML: ${file}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `Config must be a YAML mapping: ${file}` };
  }
  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, reason: `Config has unknown key "${key}".` };
    }
  }

  const configDir = dirname(file);
  const invocation: Partial<HostInvocation> = { configDir };

  const manager = stringField(object, "manager");
  if (manager.ok === false) {
    return manager;
  }
  if (manager.value !== undefined) {
    invocation.manager = manager.value;
  }

  if (object.managerOptions !== undefined) {
    const options = object.managerOptions;
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      return { ok: false, reason: 'Config "managerOptions" must be a YAML mapping.' };
    }
    invocation.managerOptions = { ...(options as Record<string, unknown>) };
  }

  const home = stringField(object, "home");
  if (home.ok === false) {
    return home;
  }
  if (home.value !== undefined) {
    invocation.home = resolve(configDir, home.value);
  }

  if (object.workLine !== undefined) {
    const workLine = readWorkLine(object.workLine, configDir);
    if (workLine.ok === false) {
      return workLine;
    }
    if (workLine.stable !== undefined) {
      invocation.workLineStable = workLine.stable;
    }
    if (workLine.branch !== undefined) {
      invocation.workLineBranch = workLine.branch;
    }
    if (workLine.isolation !== undefined) {
      invocation.workLineIsolation = workLine.isolation;
    }
    if (workLine.isolationOptions !== undefined) {
      invocation.workLineIsolationOptions = workLine.isolationOptions;
    }
  }

  const workspaceRoot = stringField(object, "workspaceRoot");
  if (workspaceRoot.ok === false) {
    return workspaceRoot;
  }
  if (workspaceRoot.value !== undefined) {
    invocation.workspaceRoot = resolve(configDir, workspaceRoot.value);
  }

  const ledger = stringField(object, "ledger");
  if (ledger.ok === false) {
    return ledger;
  }
  if (ledger.value !== undefined) {
    invocation.ledgerRoot = resolve(configDir, ledger.value);
  }

  const persist = stringField(object, "persist");
  if (persist.ok === false) {
    return persist;
  }
  if (persist.value !== undefined) {
    invocation.persist = persist.value;
  }

  if (object.planner !== undefined) {
    const planner = readPass(object.planner, configDir, "planner");
    if (planner.ok === false) {
      return planner;
    }
    invocation.planner = planner.value;
  }

  if (object.builder !== undefined) {
    const builder = readBuilder(object.builder, configDir);
    if (builder.ok === false) {
      return builder;
    }
    invocation.builder = builder.value;
  }

  if (object.assembly !== undefined) {
    const assembly = readAssembly(object.assembly, configDir);
    if (assembly.ok === false) {
      return assembly;
    }
    invocation.assembly = assembly.value;
  }

  if (object.authority !== undefined) {
    const authority = readAuthority(object.authority, configDir);
    if (authority.ok === false) {
      return authority;
    }
    invocation.authority = authority.value;
  }

  if (object.observability !== undefined) {
    const observability = readObservability(object.observability, configDir);
    if (observability.ok === false) {
      return observability;
    }
    invocation.observability = observability.value;
  }

  const timeoutMs = positiveIntField(object, "timeoutMs");
  if (timeoutMs.ok === false) {
    return timeoutMs;
  }
  if (timeoutMs.value !== undefined) {
    invocation.timeoutMs = timeoutMs.value;
  }

  for (const key of ["maxRefusals"] as const) {
    const read = positiveIntField(object, key);
    if (read.ok === false) {
      return read;
    }
    if (read.value !== undefined) {
      invocation[key] = read.value;
    }
  }

  const pollIntervalMs = positiveIntField(object, "pollIntervalMs");
  if (pollIntervalMs.ok === false) {
    return pollIntervalMs;
  }
  if (pollIntervalMs.value !== undefined) {
    invocation.pollIntervalMs = pollIntervalMs.value;
  }

  return { ok: true, invocation };
}

type StringResult = { ok: true; value: string | undefined } | { ok: false; reason: string };

function stringField(object: Record<string, unknown>, key: string): StringResult {
  const value = object[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `Config "${key}" must be a non-empty string.` };
  }
  return { ok: true, value };
}

function stringArrayField(
  object: Record<string, unknown>,
  key: string,
): { ok: true; value: string[] | undefined } | { ok: false; reason: string } {
  const value = object[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return { ok: false, reason: `Config "${key}" must be a non-empty array of strings.` };
  }
  return { ok: true, value: value as string[] };
}

function positiveIntField(
  object: Record<string, unknown>,
  key: string,
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  const value = object[key];
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return { ok: false, reason: `Config "${key}" must be a positive integer.` };
  }
  return { ok: true, value };
}

function readWorkLine(
  value: unknown,
  configDir: string,
):
  | {
      ok: true;
      stable?: string;
      branch?: string;
      isolation?: string;
      isolationOptions?: Record<string, unknown>;
    }
  | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "workLine" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!WORK_LINE_KEYS.has(key)) {
      return { ok: false, reason: `Config "workLine" has unknown key "${key}".` };
    }
  }
  const stable = stringField(object, "stable");
  if (stable.ok === false) {
    return { ok: false, reason: `Config "workLine.stable" must be a non-empty string.` };
  }
  const branch = stringField(object, "branch");
  if (branch.ok === false) {
    return { ok: false, reason: `Config "workLine.branch" must be a non-empty string.` };
  }
  const isolation = stringField(object, "isolation");
  if (isolation.ok === false) {
    return {
      ok: false,
      reason: `Config "workLine.isolation" must be a non-empty package name or path.`,
    };
  }
  const isolationOptions = object.isolationOptions;
  if (
    isolationOptions !== undefined &&
    (isolationOptions === null ||
      typeof isolationOptions !== "object" ||
      Array.isArray(isolationOptions))
  ) {
    return { ok: false, reason: 'Config "workLine.isolationOptions" must be a YAML mapping.' };
  }
  return {
    ok: true,
    ...(stable.value === undefined ? {} : { stable: resolve(configDir, stable.value) }),
    ...(branch.value === undefined ? {} : { branch: branch.value }),
    ...(isolation.value === undefined ? {} : { isolation: isolation.value }),
    ...(isolationOptions === undefined
      ? {}
      : { isolationOptions: isolationOptions as Record<string, unknown> }),
  };
}

/**
 * One Gate sequence: the ceiling a Gate takes when it names none, and the Gates.
 *
 * A Gate without a ceiling is refused rather than given one from somewhere
 * else. Nothing in a Task is bounded by what another child left behind, so a
 * Gate that names none and has no sequence default is a Gate nothing would
 * stop.
 */
/**
 * The Authority block: whether there is an outside judge, and the slot that
 * puts the work in front of it.
 *
 * `enabled` is required rather than defaulted. A Project that publishes to a
 * shared work line and one that keeps every fold local are different products,
 * and neither is the obvious one to assume.
 */
function readAuthority(
  value: unknown,
  configDir: string,
): { ok: true; value: AuthoritySpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "authority" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (!AUTHORITY_KEYS.has(name)) {
      return { ok: false, reason: `Config "authority" has unknown key "${name}".` };
    }
  }
  const enabled = object.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, reason: 'Config "authority.enabled" must be true or false.' };
  }
  if (!enabled) {
    return { ok: true, value: { enabled: false, publishArgv: [], refreshArgv: [] } };
  }
  const slots: Record<string, string[]> = {};
  for (const [key, why] of [
    ["publish", "publishes the work"],
    ["refresh", "reads back what the Authority accepted"],
  ] as const) {
    const value = object[key];
    if (value === undefined) {
      return {
        ok: false,
        reason: `Config "authority.enabled" is true, so "authority.${key}" must name the command that ${why}.`,
      };
    }
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((token) => typeof token !== "string")
    ) {
      return {
        ok: false,
        reason: `Config "authority.${key}" must be a non-empty array of strings.`,
      };
    }
    slots[key] = resolveArgv(value as string[], configDir);
  }
  const spec: AuthoritySpec = {
    enabled,
    publishArgv: slots.publish ?? [],
    refreshArgv: slots.refresh ?? [],
  };
  // Optional: the Project's own words for what it submits.
  const describe = object.describe;
  if (describe !== undefined) {
    if (
      !Array.isArray(describe) ||
      describe.length === 0 ||
      describe.some((token) => typeof token !== "string")
    ) {
      return {
        ok: false,
        reason: 'Config "authority.describe" must be a non-empty array of strings.',
      };
    }
    spec.describeArgv = resolveArgv(describe as string[], configDir);
  }
  return { ok: true, value: spec };
}

/**
 * What a Project asks to be filmed beyond the journal.
 *
 * `enabled` is declared rather than defaulted, like an Authority's: what a
 * stream holds is the Project's own material in the clear — its code, its
 * prompts, whatever an agent read out loud — and a directory happening to exist
 * is not a decision to write that down.
 */
function readObservability(
  value: unknown,
  configDir: string,
): { ok: true; value: ObservabilitySpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "observability" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (!OBSERVABILITY_KEYS.has(name)) {
      return { ok: false, reason: `Config "observability" has unknown key "${name}".` };
    }
  }
  if (object.streams === undefined) {
    return { ok: true, value: {} };
  }
  const streams = object.streams;
  if (streams === null || typeof streams !== "object" || Array.isArray(streams)) {
    return { ok: false, reason: 'Config "observability.streams" must be a YAML mapping.' };
  }
  const fields = streams as Record<string, unknown>;
  for (const name of Object.keys(fields)) {
    if (!STREAMS_KEYS.has(name)) {
      return { ok: false, reason: `Config "observability.streams" has unknown key "${name}".` };
    }
  }
  const enabled = fields.enabled;
  if (typeof enabled !== "boolean") {
    return { ok: false, reason: 'Config "observability.streams.enabled" must be true or false.' };
  }
  const spec: ObservabilitySpec["streams"] = { enabled };
  if (fields.dir !== undefined) {
    if (typeof fields.dir !== "string" || fields.dir.trim().length === 0) {
      return {
        ok: false,
        reason: 'Config "observability.streams.dir" must be a non-empty string.',
      };
    }
    // This system writes here, so it resolves against the config directory —
    // the same rule as a slot's `--transcript-dir`. Left relative to whatever
    // a child's working directory happens to be, the films would land inside a
    // Task workspace and be folded into the feature.
    spec.dir = resolve(configDir, fields.dir);
  }
  if (fields.keep !== undefined) {
    if (
      !Array.isArray(fields.keep) ||
      fields.keep.some((name) => typeof name !== "string" || !STREAM_NAMES.has(name))
    ) {
      return {
        ok: false,
        reason: 'Config "observability.streams.keep" must be an array of "stdout" / "stderr".',
      };
    }
    spec.keep = fields.keep as ("stdout" | "stderr")[];
  }
  return { ok: true, value: { streams: spec } };
}

function readGates(
  value: unknown,
  configDir: string,
  key: string,
): { ok: true; value: GateSpec[] } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `Config "${key}" must be a YAML mapping with "gates".` };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (!GATES_KEYS.has(name)) {
      return { ok: false, reason: `Config "${key}" has unknown key "${name}".` };
    }
  }
  const fallback = positiveIntField(object, "defaultTimeoutMs");
  if (fallback.ok === false) {
    return { ok: false, reason: `Config "${key}.defaultTimeoutMs" must be a positive integer.` };
  }
  const entries = object.gates;
  if (entries === undefined) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, reason: `Config "${key}.gates" must be an array.` };
  }
  const gates: GateSpec[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        reason: `Config "${key}.gates" entries must be objects with "id" and "argv".`,
      };
    }
    const id = (entry as { id?: unknown }).id;
    const argv = (entry as { argv?: unknown }).argv;
    if (typeof id !== "string" || id.trim().length === 0) {
      return { ok: false, reason: `Config "${key}.gates" entry is missing a non-empty "id".` };
    }
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.some((token) => typeof token !== "string")
    ) {
      return {
        ok: false,
        reason: `Config "${key}.gates" entry "${id}" needs a non-empty "argv" array of strings.`,
      };
    }
    const own = (entry as { timeoutMs?: unknown }).timeoutMs;
    if (own !== undefined && (typeof own !== "number" || !Number.isInteger(own) || own <= 0)) {
      return { ok: false, reason: `Config gate "${id}" has a non-positive "timeoutMs".` };
    }
    const timeoutMs = (own as number | undefined) ?? fallback.value;
    if (timeoutMs === undefined) {
      return {
        ok: false,
        reason: `Config gate "${id}" has no "timeoutMs", and "${key}" names no "defaultTimeoutMs".`,
      };
    }
    gates.push({ id, argv: resolveArgv(argv as string[], configDir), timeoutMs });
  }
  return { ok: true, value: gates };
}

/**
 * The producer, and the two passes that are not a first one.
 *
 * `timeoutMs` is required: without it nothing bounds an agent, and an agent
 * that never returns is the failure this shape exists to prevent. `repair` and
 * `assembly` inherit both the command and the ceiling, so a Project with one
 * agent writes one command.
 */
function readPass(
  value: unknown,
  configDir: string,
  key: string,
): { ok: true; value: PassSpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: `Config "${key}" must be a YAML mapping with "cmd" and "timeoutMs".`,
    };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (!PASS_KEYS.has(name)) {
      return { ok: false, reason: `Config "${key}" has unknown key "${name}".` };
    }
  }
  const cmd = stringArrayField(object, "cmd");
  if (cmd.ok === false || cmd.value === undefined) {
    return { ok: false, reason: `Config "${key}.cmd" must be a non-empty array of strings.` };
  }
  const timeoutMs = positiveIntField(object, "timeoutMs");
  if (timeoutMs.ok === false || timeoutMs.value === undefined) {
    return {
      ok: false,
      reason: `Config "${key}" needs a positive "timeoutMs": nothing else bounds a command.`,
    };
  }
  return {
    ok: true,
    value: { cmd: resolveArgv(cmd.value, configDir), timeoutMs: timeoutMs.value },
  };
}

/**
 * Making a Subtask: both passes named, neither borrowing the other's command.
 */
function readBuilder(
  value: unknown,
  configDir: string,
): { ok: true; value: StageSpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "builder" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (!STAGE_KEYS.has(name)) {
      return { ok: false, reason: `Config "builder" has unknown key "${name}".` };
    }
  }
  if (object.producer === undefined) {
    return { ok: false, reason: 'Config "builder" needs a "producer".' };
  }
  if (object.repair === undefined) {
    return { ok: false, reason: 'Config "builder" needs a "repair".' };
  }
  const readProducer = readPass(object.producer, configDir, "builder.producer");
  if (readProducer.ok === false) {
    return readProducer;
  }
  const readRepair = readPass(object.repair, configDir, "builder.repair");
  if (readRepair.ok === false) {
    return readRepair;
  }
  const spec: StageSpec = {
    producer: readProducer.value,
    repair: readRepair.value,
    gates: [],
  };
  const maxAttempts = positiveIntField(object, "maxAttempts");
  if (maxAttempts.ok === false) {
    return { ok: false, reason: 'Config "builder.maxAttempts" must be a positive integer.' };
  }
  if (maxAttempts.value !== undefined) {
    spec.maxAttempts = maxAttempts.value;
  }
  if (object.gates !== undefined) {
    const gates = readGates(object.gates, configDir, "builder.gates");
    if (gates.ok === false) {
      return gates;
    }
    spec.gates = gates.value;
  }
  return { ok: true, value: spec };
}

/**
 * Judging the assembled feature. A command here is a fix of what a judgement
 * refused, not a second first-pass of the request.
 */
function readAssembly(
  value: unknown,
  configDir: string,
): { ok: true; value: AssemblySpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "assembly" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (name === "producer" || name === "repair") {
      return {
        ok: false,
        reason:
          `Config "assembly" has no "${name}". The assembled feature is judged ` +
          '("assembly.gates"); a refusal is "assembly.fix".',
      };
    }
    if (!ASSEMBLY_KEYS.has(name)) {
      return { ok: false, reason: `Config "assembly" has unknown key "${name}".` };
    }
  }
  const spec: AssemblySpec = { gates: [] };
  if (object.fix !== undefined) {
    const read = readPass(object.fix, configDir, "assembly.fix");
    if (read.ok === false) {
      return read;
    }
    spec.fix = read.value;
  }
  if (object.validate !== undefined) {
    const read = readPass(object.validate, configDir, "assembly.validate");
    if (read.ok === false) {
      return read;
    }
    spec.validate = read.value;
  }
  const maxAttempts = positiveIntField(object, "maxAttempts");
  if (maxAttempts.ok === false) {
    return { ok: false, reason: 'Config "assembly.maxAttempts" must be a positive integer.' };
  }
  if (maxAttempts.value !== undefined) {
    spec.maxAttempts = maxAttempts.value;
  }
  if (object.gates !== undefined) {
    const gates = readGates(object.gates, configDir, "assembly.gates");
    if (gates.ok === false) {
      return gates;
    }
    spec.gates = gates.value;
  }
  return { ok: true, value: spec };
}

/**
 * Flags whose value is a path this system writes to.
 *
 * `resolveMaybePath` only resolves what already exists, which is right for an
 * input — a word that happens to look like a path stays a word. An output has
 * not been written yet, so that rule leaves it relative, and it is then
 * resolved against the slot's working directory, which is the Task workspace.
 * A workspace is a git worktree that is published and then destroyed: output
 * left there is committed into the work first, and lost after.
 */
const WRITTEN_PATH_FLAGS = new Set(["--transcript-dir"]);

function resolveArgv(argv: string[], configDir: string): string[] {
  return argv.map((token, at) =>
    WRITTEN_PATH_FLAGS.has(argv[at - 1] ?? "")
      ? resolve(configDir, token)
      : resolveMaybePath(token, configDir),
  );
}

/** A token that names a file next to the config is a path; anything else is a word. */
function resolveMaybePath(value: string, configDir: string): string {
  if (value.startsWith("-")) {
    return value;
  }
  const candidate = resolve(configDir, value);
  try {
    if (
      existsSync(candidate) &&
      (statSync(candidate).isFile() || statSync(candidate).isDirectory())
    ) {
      return candidate;
    }
  } catch {
    return value;
  }
  return value;
}
