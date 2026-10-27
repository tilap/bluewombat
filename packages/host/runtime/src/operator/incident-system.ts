import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HostInvocation, ReviewSpec } from "../config/types.js";
import { hasAgent } from "../config/types.js";

/**
 * What the run was made of, as far as a stop could depend on it.
 *
 * Versions, then what the configuration switched on, said in words and numbers.
 * A command's arguments are not copied: one can carry a key. The raw
 * configuration is included only when asked, with the values of keys that look
 * like secrets blanked.
 */
export type SystemFacts = {
  bluewombat: { host: string; node: string; platform: string };
  /** `@bluewombat/*` packages found where the Project installed them. */
  packages: { name: string; version: string }[];
  config: {
    path?: string;
    dir: string;
    featureTracker: string;
    ticketTracker: string;
    persist: string;
    isolation: string;
    authority: "enabled" | "disabled" | "none";
    maxParallel: number;
    limits: Record<string, number>;
    reviews: Record<string, string>;
    gates: Record<string, string[]>;
    agents: Record<string, string>;
    streams: "on" | "off";
    /** The configuration file itself, secrets blanked. Only with `--with-config`. */
    raw?: string;
  };
};

export type SystemInput = {
  invocation: HostInvocation;
  configPath?: string;
  hostVersion: string;
  withConfig: boolean;
};

export function systemOf(input: SystemInput): SystemFacts {
  const { invocation } = input;
  const config: SystemFacts["config"] = {
    dir: invocation.configDir,
    featureTracker: invocation.featureTracker.package,
    ticketTracker: invocation.ticketTracker.package,
    persist: invocation.persist,
    isolation: invocation.workLineIsolation,
    authority:
      invocation.authority === undefined
        ? "none"
        : invocation.authority.enabled
          ? "enabled"
          : "disabled",
    maxParallel: invocation.ticket.maxParallel ?? 1,
    limits: limitsOf(invocation),
    reviews: reviewsOf(invocation),
    gates: gatesOf(invocation),
    agents: agentsOf(invocation),
    streams: invocation.observability?.streams?.enabled === true ? "on" : "off",
  };
  if (input.configPath !== undefined) {
    config.path = input.configPath;
    if (input.withConfig) {
      const raw = readConfig(input.configPath);
      if (raw !== undefined) {
        config.raw = raw;
      }
    }
  }
  return {
    bluewombat: { host: input.hostVersion, node: process.version, platform: process.platform },
    packages: packagesOf(invocation.configDir),
    config,
  };
}

function limitsOf(invocation: HostInvocation): Record<string, number> {
  const limits: Record<string, number | undefined> = {
    timeoutMs: invocation.timeoutMs,
    "builder.maxAttempts": invocation.builder.maxAttempts,
    "ticket.maxAttempts": invocation.ticket.maxAttempts,
    "ticket.maxRefusals": invocation.ticket.maxRefusals,
    "feature.maxAttempts": invocation.feature?.maxAttempts,
    "feature.maxRefusals": invocation.feature?.maxRefusals,
    pollIntervalMs: invocation.pollIntervalMs,
  };
  return Object.fromEntries(
    Object.entries(limits).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
}

/** For each pass: whether an agent runs, or only Gates, or nothing. */
function reviewsOf(invocation: HostInvocation): Record<string, string> {
  const word = (review: ReviewSpec | undefined): string => {
    if (review === undefined) {
      return "off";
    }
    if (hasAgent(review)) {
      return "agent + gates";
    }
    return review.gates.length > 0 ? "gates only" : "off";
  };
  const found: Record<string, string> = {
    "builder.featureTest": invocation.builder.featureTest === undefined ? "off" : "agent + gates",
    "ticket.fix": invocation.ticket.fix === undefined ? "off" : "agent + gates",
    "ticket.validate": word(invocation.ticket.validate),
  };
  if (invocation.feature !== undefined) {
    found["feature.validate"] = word(invocation.feature.validate);
    found["feature.fix"] = "agent + gates";
  }
  return found;
}

/** The ids of each sequence, in order, with the condition that leaves one out. */
function gatesOf(invocation: HostInvocation): Record<string, string[]> {
  const ids = (gates: { id: string; skipWhen?: string }[] | undefined): string[] =>
    (gates ?? []).map((gate) =>
      gate.skipWhen === undefined ? gate.id : `${gate.id} (skipWhen ${gate.skipWhen})`,
    );
  const found: Record<string, string[]> = {
    "builder.gates": ids(invocation.builder.producer.gates),
    "builder.featureTest.gates": ids(invocation.builder.featureTest?.gates),
    "ticket.fix.gates": ids(invocation.ticket.fix?.gates),
    "ticket.validate.gates": ids(invocation.ticket.validate?.gates),
    "feature.validate.gates": ids(invocation.feature?.validate.gates),
    "feature.fix.gates": ids(invocation.feature?.fix.gates),
    "feature.gates": ids(invocation.feature?.gates),
  };
  return Object.fromEntries(Object.entries(found).filter(([, list]) => list.length > 0));
}

/** The program each agent starts, by name (and the script, behind `node`). The rest of the command may hold a key, so none is copied. */
function agentsOf(invocation: HostInvocation): Record<string, string> {
  const agentOf = (review: ReviewSpec | undefined): string[] | undefined =>
    review !== undefined && hasAgent(review) ? review.cmd : undefined;
  const found: Record<string, string[] | undefined> = {
    "builder.producer": invocation.builder.producer.cmd,
    "builder.repair": invocation.builder.repair.cmd,
    "builder.featureTest": invocation.builder.featureTest?.cmd,
    "ticket.fix": invocation.ticket.fix?.cmd,
    "ticket.validate": agentOf(invocation.ticket.validate),
    "feature.fix": invocation.feature?.fix.cmd,
    "feature.validate": agentOf(invocation.feature?.validate),
  };
  const names: Record<string, string> = {};
  for (const [role, cmd] of Object.entries(found)) {
    const program = cmd?.[0];
    if (program !== undefined) {
      // `node wrapper.mjs` says more by the script it runs than by `node`.
      const script = basename(program) === "node" ? cmd?.[1] : undefined;
      names[role] = [basename(program), ...(script === undefined ? [] : [basename(script)])].join(
        " ",
      );
    }
  }
  return names;
}

/** `@bluewombat/*` as the Project installed them: the versions the run actually used. */
function packagesOf(configDir: string): SystemFacts["packages"] {
  const root = join(configDir, "node_modules", "@bluewombat");
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  const found: SystemFacts["packages"] = [];
  for (const name of names) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(root, name, "package.json"), "utf8"));
      const version = (manifest as { version?: unknown }).version;
      found.push({
        name: `@bluewombat/${name}`,
        version: typeof version === "string" ? version : "unknown",
      });
    } catch {
      // Not a package: a stray file or a broken link.
    }
  }
  return found;
}

const SECRET_KEY =
  /^(\s*(?:-\s+)?[\w.-]*(?:token|secret|password|passwd|api[-_]?key|credential|private[-_]?key)[\w.-]*\s*:)\s*\S.*$/i;

function readConfig(path: string): string | undefined {
  try {
    return redact(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Blank the value of any `key: value` line whose key looks like a secret. */
export function redact(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(SECRET_KEY, "$1 <redacted>"))
    .join("\n");
}
