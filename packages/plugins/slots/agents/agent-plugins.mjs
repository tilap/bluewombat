import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { listOption, textOption } from "@bluewombat/slot-kit";

// The plugin folders an agent starts with, shared by every vendor wrapper.
//
//   --plugin-dir DIR      a folder of the operator's own (the Mason home's
//                         core plugins). Repeatable, loaded first, in order
//   --app-deck-profile PATH
//                         the app's deck profile for this role, as a path in the
//                         checkout: `[<app dir>/].ai/profiles/<name>`. The base
//                         and that profile, as the app's locks pin them
//   --plugins-out DIR     where the profile is materialized, one folder per
//                         workspace and profile (<DIR>/<workspace>/<profile>).
//                         Required with --app-deck-profile: never the
//                         workspace, whose tree the Gates read
//   --deck-bin PATH       the deck CLI. Default: the @pinkpuma/deck this
//                         package depends on
//
// The profile is read from the working directory — the checkout the agent
// works on — so a role gets what the project committed at that commit, not
// what the operator has installed. Agents of one Mason may run side by side
// (ticket.maxParallel above 1): each workspace has its own folder, so one
// agent's plugins are never rewritten under another, and the runs of deck
// that fill them take turns, because deck's cache has no lock of its own.

const PROFILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Where a deck profile is, from the path the config gives: the app folder that
 * holds `.ai/` (empty for the checkout itself) and the profile's name. deck
 * keeps its profiles in `<app>/.ai/profiles/<name>`, so that is the shape; the
 * app folder is what a Project can place elsewhere.
 *
 * The same rule as the config's own reading of the key (`parseAppDeckProfile`
 * in the runtime), written again because a slot depends on neither.
 *
 * @param {string} given
 * @returns {{ ok: true, root: string, name: string } | { ok: false, reason: string }}
 */
export function parseAppDeckProfile(given) {
  const matched = /^(?:(.*?)\/)?\.ai\/profiles\/([^/]+)\/?$/.exec(given.trim());
  const name = matched?.[2];
  if (matched === null || name === undefined || !PROFILE_NAME.test(name) || name === "current") {
    return {
      ok: false,
      reason: `The --app-deck-profile "${given}" is not a deck profile path: [<app dir>/].ai/profiles/<name>.`,
    };
  }
  const root = matched[1] ?? ".";
  if (isAbsolute(root) || root.split("/").includes("..")) {
    return {
      ok: false,
      reason: `The --app-deck-profile "${given}" must stay inside the checkout.`,
    };
  }
  return { ok: true, root, name };
}

/**
 * @typedef {import("@bluewombat/slot-kit").AgentPlugin} AgentPlugin
 * @typedef {{ ok: true, plugins: AgentPlugin[], prompt: string | undefined, notes: string[] }
 *   | { ok: false, reason: string }} LoadedPlugins
 */

/**
 * @param {import("@bluewombat/slot-kit").OptionValues} options
 * @param {string} cwd
 * @returns {LoadedPlugins}
 */
export function loadPlugins(options, cwd) {
  /** @type {AgentPlugin[]} */
  const plugins = [];
  for (const dir of listOption(options, "pluginDir")) {
    const path = resolve(cwd, dir);
    if (!isDirectory(path)) {
      return { ok: false, reason: `The --plugin-dir ${dir} is not a folder.` };
    }
    plugins.push({ id: pluginId(path), path, from: "local", integrity: null });
  }
  const given = textOption(options, "appDeckProfile");
  if (given === undefined) {
    return { ok: true, plugins, prompt: undefined, notes: [] };
  }
  const located = parseAppDeckProfile(given);
  if (!located.ok) {
    return located;
  }
  const { root, name: profile } = located;
  const out = textOption(options, "pluginsOut");
  if (out === undefined) {
    return {
      ok: false,
      reason: "--app-deck-profile needs --plugins-out: the profile is built outside the workspace.",
    };
  }
  // The app is where deck is run: the checkout, or a folder of it that holds
  // its own `.ai/` (an app of a monorepo).
  const appDir = resolve(cwd, root);
  const hasBase = existsSync(join(appDir, "ai-plugin.json"));
  // deck's own rule: a profile is a folder of .ai/profiles that holds a request.
  const hasProfile = existsSync(join(appDir, ".ai", "profiles", profile, "ai-plugin.json"));
  if (!hasBase && !hasProfile) {
    return {
      ok: true,
      plugins,
      prompt: undefined,
      notes: [`The app has no deck setup: no plugin for profile ${given}.`],
    };
  }
  const deck = deckBin(options);
  if (!deck.ok) {
    return deck;
  }
  const outRoot = resolve(cwd, out);
  const args = [
    deck.path,
    "materialize",
    "-C",
    appDir,
    "--out",
    join(outRoot, workspaceSegment(cwd), profile),
    "--json",
    ...(hasProfile ? ["--profile", profile] : []),
  ];
  // No timeout: this runs inside the agent wrapper's own process group, so
  // the slot's deadline ends deck with it.
  /** @type {import("node:child_process").SpawnSyncReturns<string>} */
  let run;
  try {
    run = takingTurns(outRoot, () => {
      retireStaleFolders(outRoot);
      markWorkspace(outRoot, cwd);
      return spawnSync(process.execPath, args, { cwd, encoding: "utf8" });
    });
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `deck materialize could not start for profile ${profile}: ${said}`,
    };
  }
  if (run.error !== undefined || run.status !== 0) {
    const said = (run.stderr || run.error?.message || `exit ${run.status}`).trim();
    return {
      ok: false,
      reason: `deck materialize refused profile ${profile}: ${said} Run deck install in the project and commit its locks.`,
    };
  }
  const result = parseMaterialized(run.stdout);
  if (result === undefined) {
    return { ok: false, reason: `deck materialize answered no JSON for profile ${profile}.` };
  }
  for (const plugin of result.plugins) {
    plugins.push({ ...plugin, from: "deck" });
  }
  return {
    ok: true,
    plugins,
    prompt: profilePrompt(result.prompt),
    notes: hasProfile ? [] : [`The app has no deck profile ${given}: base plugins only.`],
  };
}

const WORKSPACE_MARK = ".workspace";
const LOCK_NAME = ".materialize.lock";
const LOCK_WAIT_MS = 10 * 60 * 1000;
const LOCK_CREATION_GRACE_MS = 10 * 1000;

/**
 * The folder under `--plugins-out` that belongs to one workspace: the same
 * name every time the same directory asks, a different one for each directory.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function workspaceSegment(cwd) {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 12);
}

/**
 * Record whose folder this is, so that it can be dropped once the workspace is gone.
 *
 * @param {string} outRoot
 * @param {string} cwd
 */
function markWorkspace(outRoot, cwd) {
  const folder = join(outRoot, workspaceSegment(cwd));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, WORKSPACE_MARK), `${resolve(cwd)}\n`);
}

/**
 * Drop the folders of workspaces that no longer exist (a ticket that landed
 * clears its own). Only a folder that carries the mark is touched.
 *
 * @param {string} outRoot
 */
function retireStaleFolders(outRoot) {
  let names;
  try {
    names = readdirSync(outRoot);
  } catch {
    return;
  }
  for (const name of names) {
    const folder = join(outRoot, name);
    let owner;
    try {
      owner = readFileSync(join(folder, WORKSPACE_MARK), "utf8").trim();
    } catch {
      continue;
    }
    if (owner.length > 0 && !existsSync(owner)) {
      rmSync(folder, { recursive: true, force: true });
    }
  }
}

/**
 * Run `work` while holding the lock of `outRoot`: two agents starting together
 * materialize one after the other, since deck's cache has no lock. A lock whose
 * holder is gone is taken over.
 *
 * @template T
 * @param {string} outRoot
 * @param {() => T} work
 * @returns {T}
 */
function takingTurns(outRoot, work) {
  mkdirSync(outRoot, { recursive: true });
  const lock = join(outRoot, LOCK_NAME);
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") {
        throw error;
      }
    }
    if (holderGone(lock)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > giveUpAt) {
      throw new Error(`another agent held ${lock} for more than ${LOCK_WAIT_MS / 60000} minutes`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid));
    return work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Whether the process that took `lock` is gone. A lock with no pid yet was
 * just made: it is given a few seconds to say whose it is.
 *
 * @param {string} lock
 * @returns {boolean}
 */
function holderGone(lock) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, "pid"), "utf8"));
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs > LOCK_CREATION_GRACE_MS;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "ESRCH";
  }
}

/**
 * The filled prompt, then the project's own words for this role.
 *
 * @param {string} prompt
 * @param {string | undefined} profilePromptText
 * @returns {string}
 */
export function withProfilePrompt(prompt, profilePromptText) {
  if (profilePromptText === undefined) {
    return prompt;
  }
  return `${prompt.trimEnd()}\n\n## Project instructions for this role\n\n${profilePromptText}\n`;
}

/**
 * `--plugin-dir` once per plugin folder: what both Cursor and Claude read.
 *
 * @param {readonly AgentPlugin[]} plugins
 * @returns {string[]}
 */
export function pluginDirArgs(plugins) {
  return plugins.flatMap((plugin) => ["--plugin-dir", plugin.path]);
}

/**
 * @param {import("@bluewombat/slot-kit").OptionValues} options
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
function deckBin(options) {
  const given = textOption(options, "deckBin");
  if (given !== undefined) {
    return { ok: true, path: resolve(given) };
  }
  try {
    const manifest = createRequire(import.meta.url).resolve("@pinkpuma/deck/package.json");
    return { ok: true, path: join(dirname(manifest), "bin", "deck.js") };
  } catch {
    return {
      ok: false,
      reason:
        "@pinkpuma/deck is not installed next to @bluewombat/slots. Install it, or pass --deck-bin.",
    };
  }
}

/**
 * @param {string} stdout
 * @returns {{ prompt: string | null, plugins: { id: string, path: string, integrity: string | null }[] } | undefined}
 */
function parseMaterialized(stdout) {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || !Array.isArray(raw.plugins)) {
    return undefined;
  }
  const plugins = [];
  for (const entry of raw.plugins) {
    if (typeof entry?.id !== "string" || typeof entry?.path !== "string") {
      return undefined;
    }
    plugins.push({
      id: entry.id,
      path: entry.path,
      integrity: typeof entry.integrity === "string" ? entry.integrity : null,
    });
  }
  return { prompt: typeof raw.prompt === "string" ? raw.prompt : null, plugins };
}

/**
 * @param {string | null} path
 * @returns {string | undefined}
 */
function profilePrompt(path) {
  if (path === null) {
    return undefined;
  }
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length === 0 ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * The name the plugin's manifest gives, else its folder's.
 *
 * @param {string} dir
 * @returns {string}
 */
function pluginId(dir) {
  for (const manifest of [
    "plugin.json",
    ".cursor-plugin/plugin.json",
    ".claude-plugin/plugin.json",
  ]) {
    try {
      const name = JSON.parse(readFileSync(join(dir, manifest), "utf8")).name;
      if (typeof name === "string" && name.length > 0) {
        return name;
      }
    } catch {
      // try the next manifest
    }
  }
  return basename(dir);
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
