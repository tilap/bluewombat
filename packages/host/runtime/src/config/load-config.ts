import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type AgentRole,
  type Agents,
  expandAgentPass,
  readAgents,
  SHORT_PASS_KEYS,
} from "./agent-shorthand.js";
import type {
  AuthoritySpec,
  FeatureSpec,
  GatedPassSpec,
  HostDraft,
  HostGateSpec,
  ManagerSpec,
  ObservabilitySpec,
  PassSpec,
  ReviewSpec,
  SkipWhen,
  StageSpec,
  TicketSpec,
} from "./types.js";
import { SKIP_WHEN } from "./types.js";

const KNOWN_KEYS = new Set([
  "featureTracker",
  "ticketTracker",
  "home",
  "workLine",
  "workspaceRoot",
  "ledger",
  "persist",
  "agents",
  "builder",
  "ticket",
  "feature",
  "authority",
  "observability",
  "timeoutMs",
  "pollIntervalMs",
]);

const WORK_LINE_KEYS = new Set([
  "stable",
  "targetStable",
  "branch",
  "isolation",
  "isolationOptions",
  "warm",
]);
const PASS_KEYS = new Set(["cmd", "timeoutMs"]);
const GATED_PASS_KEYS = new Set(["cmd", "timeoutMs", "gates"]);
const STAGE_KEYS = new Set(["featureTest", "producer", "repair", "gates", "maxAttempts"]);
const TICKET_KEYS = new Set([
  "maxParallel",
  "maxAttempts",
  "maxRefusals",
  "fix",
  "validate",
  "gates",
]);
const FEATURE_KEYS = new Set(["maxAttempts", "maxRefusals", "fix", "validate", "gates"]);
const GATES_KEYS = new Set(["defaultTimeoutMs", "gates"]);
const AUTHORITY_KEYS = new Set(["enabled", "publish", "refresh", "describe"]);
const OBSERVABILITY_KEYS = new Set(["streams"]);
const STREAMS_KEYS = new Set(["enabled", "dir", "keep"]);
const STREAM_NAMES = new Set(["stdout", "stderr"]);

export type LoadedConfig = { ok: true; invocation: HostDraft } | { ok: false; reason: string };

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
  const invocation: HostDraft = { configDir };

  for (const side of ["featureTracker", "ticketTracker"] as const) {
    const spec = readManagerSpec(object[side], side);
    if (spec.ok === false) {
      return spec;
    }
    if (spec.value !== undefined) {
      invocation[side] = spec.value;
    }
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
    if (workLine.targetStable !== undefined) {
      invocation.workLineTargetStable = workLine.targetStable;
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
    if (workLine.warm !== undefined) {
      invocation.workLineWarm = workLine.warm;
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

  let agents: Agents = new Map();
  if (object.agents !== undefined) {
    const read = readAgents(object.agents, configDir);
    if (read.ok === false) {
      return read;
    }
    agents = read.value;
  }

  if (object.builder !== undefined) {
    const builder = readBuilder(object.builder, configDir, agents);
    if (builder.ok === false) {
      return builder;
    }
    invocation.builder = builder.value;
  }

  if (object.ticket !== undefined) {
    const ticket = readTicket(object.ticket, configDir, agents);
    if (ticket.ok === false) {
      return ticket;
    }
    invocation.ticket = ticket.value;
  }

  if (object.feature !== undefined) {
    const feature = readFeature(object.feature, configDir, agents);
    if (feature.ok === false) {
      return feature;
    }
    invocation.feature = feature.value;
  }

  if (object.authority !== undefined) {
    const authority = readAuthority(object.authority, configDir, agents);
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

  const pollIntervalMs = positiveIntField(object, "pollIntervalMs");
  if (pollIntervalMs.ok === false) {
    return pollIntervalMs;
  }
  if (pollIntervalMs.value !== undefined) {
    invocation.pollIntervalMs = pollIntervalMs.value;
  }

  const featureTestRefusal = checkFeatureTestDeclaration(invocation);
  if (featureTestRefusal !== undefined) {
    return { ok: false, reason: featureTestRefusal };
  }

  return { ok: true, invocation };
}

/**
 * The feature-test check is declared by a pair: `builder.featureTest`, which makes the Ticket that holds the
 * suite, and a Feature Gate with `skipWhen: skip-feature-test`, which runs it. One without the other
 * is a check that never runs or a Ticket nobody judges, so neither is accepted alone. A `skipWhen`
 * outside a Feature's Gates has nothing to read.
 */
function checkFeatureTestDeclaration(invocation: HostDraft): string | undefined {
  const outside: [string, HostGateSpec[] | undefined][] = [
    ["builder.gates", invocation.builder?.producer.gates],
    ["builder.featureTest.gates", invocation.builder?.featureTest?.gates],
    ["ticket.gates", invocation.ticket?.gates],
    ["ticket.fix.gates", invocation.ticket?.fix?.gates],
    ["ticket.validate.gates", invocation.ticket?.validate?.gates],
  ];
  for (const [key, gates] of outside) {
    const bad = gates?.find((gate) => gate.skipWhen !== undefined);
    if (bad !== undefined) {
      return `Config "${key}" gate "${bad.id}" has "skipWhen", which only a Feature's gates (feature.validate, feature.gates, feature.fix) can have.`;
    }
  }
  const feature = invocation.feature;
  const skippable = [
    ...(feature?.validate.gates ?? []),
    ...(feature?.gates ?? []),
    ...(feature?.fix.gates ?? []),
  ].filter((gate) => gate.skipWhen === "skip-feature-test");
  const declared = invocation.builder?.featureTest !== undefined;
  if (skippable.length > 0 && !declared) {
    return `Config gate "${skippable[0]?.id}" has "skipWhen: skip-feature-test", so the feature-test check is declared: "builder.featureTest" is required (the pass that makes the Ticket holding the suite).`;
  }
  if (declared && feature !== undefined && skippable.length === 0) {
    return 'Config "builder.featureTest" is declared, but no Feature gate runs the suite. Add a gate to "feature.validate.gates" with "skipWhen: skip-feature-test".';
  }
  return undefined;
}

type StringResult = { ok: true; value: string | undefined } | { ok: false; reason: string };

const MANAGER_SPEC_KEYS = new Set(["package", "options"]);

function readManagerSpec(
  value: unknown,
  side: string,
): { ok: true; value: Partial<ManagerSpec> | undefined } | { ok: false; reason: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: `Config "${side}" must be a YAML mapping (package, options).` };
  }
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!MANAGER_SPEC_KEYS.has(key)) {
      return { ok: false, reason: `Config "${side}" has unknown key "${key}".` };
    }
  }
  const spec: Partial<ManagerSpec> = {};
  const name = stringField(object, "package");
  if (name.ok === false) {
    return { ok: false, reason: name.reason.replace('"package"', `"${side}.package"`) };
  }
  if (name.value !== undefined) {
    spec.package = name.value;
  }
  if (object.options !== undefined) {
    const options = object.options;
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      return { ok: false, reason: `Config "${side}.options" must be a YAML mapping.` };
    }
    spec.options = { ...(options as Record<string, unknown>) };
  }
  return { ok: true, value: spec };
}

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
      targetStable?: string;
      branch?: string;
      isolation?: string;
      isolationOptions?: Record<string, unknown>;
      warm?: PassSpec;
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
  const targetStable = stringField(object, "targetStable");
  if (targetStable.ok === false) {
    return { ok: false, reason: `Config "workLine.targetStable" must be a non-empty string.` };
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
  let warm: PassSpec | undefined;
  if (object.warm !== undefined) {
    const read = readPass(object.warm, configDir, "workLine.warm");
    if (read.ok === false) {
      return read;
    }
    warm = read.value;
  }
  return {
    ok: true,
    ...(stable.value === undefined ? {} : { stable: resolve(configDir, stable.value) }),
    ...(targetStable.value === undefined
      ? {}
      : { targetStable: resolve(configDir, targetStable.value) }),
    ...(branch.value === undefined ? {} : { branch: branch.value }),
    ...(isolation.value === undefined ? {} : { isolation: isolation.value }),
    ...(isolationOptions === undefined
      ? {}
      : { isolationOptions: isolationOptions as Record<string, unknown> }),
    ...(warm === undefined ? {} : { warm }),
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
  agents: Agents,
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
  if (describe !== null && typeof describe === "object" && !Array.isArray(describe)) {
    const short = describe as Record<string, unknown>;
    for (const name of Object.keys(short)) {
      if (!SHORT_PASS_KEYS.has(name)) {
        return { ok: false, reason: `Config "authority.describe" has unknown key "${name}".` };
      }
    }
    const argv = expandAgentPass(
      short,
      "authority.describe",
      agents,
      configDir,
      "authority.describe",
    );
    if (argv.ok === false) {
      return argv;
    }
    spec.describeArgv = argv.value;
  } else if (describe !== undefined) {
    if (
      !Array.isArray(describe) ||
      describe.length === 0 ||
      describe.some((token) => typeof token !== "string")
    ) {
      return {
        ok: false,
        reason:
          'Config "authority.describe" must be a non-empty array of strings, or an agent pass ({ agent: … }).',
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
    // Task workspace and be folded into the ticket.
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
): { ok: true; value: HostGateSpec[] } | { ok: false; reason: string } {
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
  // A bare `gates:` in YAML is a null: an empty list, written the short way.
  const entries = object.gates;
  if (entries === undefined || entries === null) {
    return { ok: true, value: [] };
  }
  if (!Array.isArray(entries)) {
    return { ok: false, reason: `Config "${key}.gates" must be an array.` };
  }
  const gates: HostGateSpec[] = [];
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
    const skipWhen = (entry as { skipWhen?: unknown }).skipWhen;
    if (skipWhen !== undefined && !SKIP_WHEN.includes(skipWhen as SkipWhen)) {
      return {
        ok: false,
        reason: `Config gate "${id}" has "skipWhen: ${String(skipWhen)}". Known: ${SKIP_WHEN.join(", ")}.`,
      };
    }
    gates.push({
      id,
      argv: resolveArgv(argv as string[], configDir),
      timeoutMs,
      ...(skipWhen === undefined ? {} : { skipWhen: skipWhen as SkipWhen }),
    });
  }
  return { ok: true, value: gates };
}

/**
 * The producer, and the two passes that are not a first one.
 *
 * `timeoutMs` is required: without it nothing bounds an agent, and an agent
 * that never returns is the failure this shape exists to prevent. `repair` and
 * `ticket` inherit both the command and the ceiling, so a Project with one
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
 * A command, and its own Gate sequence — `ticket.fix`, `ticket.validate`.
 * `builder.producer` and `builder.repair` read the same shape with `gated`
 * false: their Gates are the one `builder.gates` list, read by `readBuilder`.
 * Deliberately its own ~10 lines rather than a parameterized `readPass`: each
 * reader's error messages and key set stay independently legible.
 */
function readGatedPass(
  value: unknown,
  configDir: string,
  key: AgentRole,
  agents: Agents,
  gated = true,
): { ok: true; value: GatedPassSpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: `Config "${key}" must be a YAML mapping with "cmd" (or "agent") and "timeoutMs".`,
    };
  }
  const object = value as Record<string, unknown>;
  const short = object.agent !== undefined;
  for (const name of Object.keys(object)) {
    if (!gated && name === "gates") {
      return {
        ok: false,
        reason:
          `Config "${key}" has no "gates". The builder's Gates are "builder.gates": ` +
          "one list, judging the producer and the repair alike.",
      };
    }
    const known = GATED_PASS_KEYS.has(name) || (short && SHORT_PASS_KEYS.has(name));
    if (!known) {
      return { ok: false, reason: `Config "${key}" has unknown key "${name}".` };
    }
  }
  let cmd: string[];
  if (short) {
    const expanded = expandAgentPass(object, key, agents, configDir, key);
    if (expanded.ok === false) {
      return expanded;
    }
    cmd = expanded.value;
  } else {
    const written = stringArrayField(object, "cmd");
    if (written.ok === false || written.value === undefined) {
      return {
        ok: false,
        reason: `Config "${key}.cmd" must be a non-empty array of strings, or "${key}.agent" an agent of "agents".`,
      };
    }
    cmd = resolveArgv(written.value, configDir);
  }
  const timeoutMs = positiveIntField(object, "timeoutMs");
  if (timeoutMs.ok === false || timeoutMs.value === undefined) {
    return {
      ok: false,
      reason: `Config "${key}" needs a positive "timeoutMs": nothing else bounds a command.`,
    };
  }
  let gates: HostGateSpec[] = [];
  if (object.gates !== undefined) {
    const read = readGates(object.gates, configDir, `${key}.gates`);
    if (read.ok === false) {
      return read;
    }
    gates = read.value;
  }
  return { ok: true, value: { cmd, timeoutMs: timeoutMs.value, gates } };
}

/**
 * A review: an agent and its Gates, or `agent: false` and the Gates alone.
 * The agent is turned off by saying so; a review with neither an agent nor a
 * Gate would judge nothing, and is refused.
 */
function readReview(
  value: unknown,
  configDir: string,
  key: AgentRole,
  agents: Agents,
): { ok: true; value: ReviewSpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      reason: `Config "${key}" must be a YAML mapping with an agent (or "cmd") and "timeoutMs", or "agent: false" and "gates".`,
    };
  }
  const object = value as Record<string, unknown>;
  if (object.agent !== false) {
    return readGatedPass(value, configDir, key, agents);
  }
  for (const name of Object.keys(object)) {
    if (name !== "agent" && name !== "gates") {
      return {
        ok: false,
        reason: `Config "${key}" has "agent: false", so it has no "${name}": only its "gates" run.`,
      };
    }
  }
  // No Gates either: the review is off, which is how a Project says it.
  if (object.gates === undefined || object.gates === null) {
    return { ok: true, value: { agent: false, gates: [] } };
  }
  const gates = readGates(object.gates, configDir, `${key}.gates`);
  if (gates.ok === false) {
    return gates;
  }
  return { ok: true, value: { agent: false, gates: gates.value } };
}

/**
 * Making the unit of work: both passes named, neither borrowing the other's command.
 */
function readBuilder(
  value: unknown,
  configDir: string,
  agents: Agents,
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
  let featureTest: GatedPassSpec | undefined;
  if (object.featureTest !== undefined) {
    const read = readGatedPass(object.featureTest, configDir, "builder.featureTest", agents);
    if (read.ok === false) {
      return read;
    }
    featureTest = read.value;
  }
  if (object.producer === undefined) {
    return { ok: false, reason: 'Config "builder" needs a "producer".' };
  }
  if (object.repair === undefined) {
    return { ok: false, reason: 'Config "builder" needs a "repair".' };
  }
  const readProducer = readGatedPass(object.producer, configDir, "builder.producer", agents, false);
  if (readProducer.ok === false) {
    return readProducer;
  }
  const readRepair = readGatedPass(object.repair, configDir, "builder.repair", agents, false);
  if (readRepair.ok === false) {
    return readRepair;
  }
  let gates: HostGateSpec[] = [];
  if (object.gates !== undefined) {
    const read = readGates(object.gates, configDir, "builder.gates");
    if (read.ok === false) {
      return read;
    }
    gates = read.value;
  }
  // One list, two passes: a repair is judged by exactly what judged the producer,
  // so it cannot undo what a Gate refused. Implementer still takes two sequences.
  const spec: StageSpec = {
    producer: { ...readProducer.value, gates },
    repair: { ...readRepair.value, gates: [...gates] },
    ...(featureTest === undefined ? {} : { featureTest }),
  };
  const maxAttempts = positiveIntField(object, "maxAttempts");
  if (maxAttempts.ok === false) {
    return { ok: false, reason: 'Config "builder.maxAttempts" must be a positive integer.' };
  }
  if (maxAttempts.value !== undefined) {
    spec.maxAttempts = maxAttempts.value;
  }
  return { ok: true, value: spec };
}

/**
 * Judging the assembled ticket. A command here is a fix of what a judgement
 * refused, not a second first-pass of the request.
 */
function readTicket(
  value: unknown,
  configDir: string,
  agents: Agents,
): { ok: true; value: TicketSpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "ticket" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (name === "producer" || name === "repair") {
      return {
        ok: false,
        reason:
          `Config "ticket" has no "${name}". The assembled ticket is judged ` +
          '("ticket.gates"); a refusal is "ticket.fix".',
      };
    }
    if (!TICKET_KEYS.has(name)) {
      return { ok: false, reason: `Config "ticket" has unknown key "${name}".` };
    }
  }
  if (object.validate === undefined) {
    return {
      ok: false,
      reason:
        'Config "ticket" needs a "validate": the review of the assembled ticket. To turn it off, write "validate: { agent: false }".',
    };
  }
  const spec: TicketSpec = { gates: [] };
  if (object.fix !== undefined) {
    const read = readGatedPass(object.fix, configDir, "ticket.fix", agents);
    if (read.ok === false) {
      return read;
    }
    spec.fix = read.value;
  }
  if (object.validate !== undefined) {
    const read = readReview(object.validate, configDir, "ticket.validate", agents);
    if (read.ok === false) {
      return read;
    }
    spec.validate = read.value;
  }
  for (const key of ["maxParallel", "maxAttempts", "maxRefusals"] as const) {
    const read = positiveIntField(object, key);
    if (read.ok === false) {
      return { ok: false, reason: `Config "ticket.${key}" must be a positive integer.` };
    }
    if (read.value !== undefined) {
      spec[key] = read.value;
    }
  }
  if (object.gates !== undefined) {
    const gates = readGates(object.gates, configDir, "ticket.gates");
    if (gates.ok === false) {
      return gates;
    }
    spec.gates = gates.value;
  }
  return { ok: true, value: spec };
}

/**
 * Judging a Feature's whole line, and repairing what that judgement refused.
 * Its own gates, fix and budget: nothing is shared with a Ticket's.
 */
function readFeature(
  value: unknown,
  configDir: string,
  agents: Agents,
): { ok: true; value: FeatureSpec } | { ok: false; reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: 'Config "feature" must be a YAML mapping.' };
  }
  const object = value as Record<string, unknown>;
  for (const name of Object.keys(object)) {
    if (!FEATURE_KEYS.has(name)) {
      return { ok: false, reason: `Config "feature" has unknown key "${name}".` };
    }
  }
  if (object.fix === undefined) {
    return {
      ok: false,
      reason:
        'Config "feature" needs a "fix": what repairs the line when its gates refuse it. There is no feature without one.',
    };
  }
  if (object.validate === undefined) {
    return {
      ok: false,
      reason:
        'Config "feature" needs a "validate": the review of the whole line against the Feature\'s request, whose gates run the project\'s own checks on it.',
    };
  }
  if (object.gates === undefined) {
    return {
      ok: false,
      reason:
        'Config "feature" needs "gates": what judges the published line before it is folded (the CI). They are not borrowed from "ticket".',
    };
  }
  const validate = readReview(object.validate, configDir, "feature.validate", agents);
  if (validate.ok === false) {
    return validate;
  }
  const fix = readGatedPass(object.fix, configDir, "feature.fix", agents);
  if (fix.ok === false) {
    return fix;
  }
  const gates = readGates(object.gates, configDir, "feature.gates");
  if (gates.ok === false) {
    return gates;
  }
  const spec: FeatureSpec = { fix: fix.value, validate: validate.value, gates: gates.value };
  for (const key of ["maxAttempts", "maxRefusals"] as const) {
    const read = positiveIntField(object, key);
    if (read.ok === false) {
      return { ok: false, reason: `Config "feature.${key}" must be a positive integer.` };
    }
    if (read.value !== undefined) {
      spec[key] = read.value;
    }
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
 *
 * `--transcript-dir` and `--agent-home` are Host-owned write paths (films, and
 * the vendor's isolated HOME). Both must resolve against the config directory
 * even before the directory exists. So must `--plugins-out`, where a deck
 * profile is built. `--plugin-dir` is read, not written, but a relative one
 * left as a word would be looked up in the Task workspace — never where the
 * operator's plugin is.
 */
const WRITTEN_PATH_FLAGS = new Set([
  "--transcript-dir",
  "--agent-home",
  "--plugins-out",
  "--plugin-dir",
]);

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
