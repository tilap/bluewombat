import { createInterface } from "node:readline/promises";

/** Reads one line. Injected, so the wizard is testable without a terminal. */
export type Ask = (question: string) => Promise<string>;

/**
 * The person stopped answering — Ctrl-C, Ctrl-D, or a pipe that ran dry.
 * Thrown rather than returned so no caller can mistake it for an empty answer
 * and ask the same question again.
 */
export class PromptAbandoned extends Error {
  constructor() {
    super("Cancelled. Nothing written.");
    this.name = "PromptAbandoned";
  }
}

/** How many times a question is re-asked before giving up on it. */
const MAX_TRIES = 3;

export type AskOptions = {
  fallback?: string;
  required?: boolean;
  /** Where a "that answer will not do" hint goes. */
  write?: (line: string) => void;
};

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * A reader over the real terminal. Call `close` when the wizard is done.
 *
 * Lines are queued rather than read one `question` at a time: a pipe delivers
 * every line at once, and anything arriving between two questions would
 * otherwise be dropped on the floor. Once the input ends — EOF, or Ctrl-C —
 * every read throws, so the wizard stops on the spot instead of re-asking.
 */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const arrived: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;

  const end = (): void => {
    ended = true;
    const pending = waiting.splice(0);
    // The cursor is sitting after a prompt that will never be answered.
    if (pending.length > 0) {
      process.stdout.write("\n");
    }
    for (const next of pending) {
      next(null);
    }
  };

  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next === undefined) {
      arrived.push(line);
      return;
    }
    next(line);
  });
  // Without this listener a Ctrl-C at a prompt is swallowed by readline.
  rl.on("SIGINT", () => {
    rl.close();
  });
  rl.on("close", end);

  return {
    ask: async (question) => {
      const queued = arrived.shift();
      if (queued !== undefined) {
        process.stdout.write(question);
        return queued.trim();
      }
      if (ended) {
        throw new PromptAbandoned();
      }
      process.stdout.write(question);
      const line = await new Promise<string | null>((resolve) => waiting.push(resolve));
      if (line === null) {
        throw new PromptAbandoned();
      }
      return line.trim();
    },
    close: () => rl.close(),
  };
}

/** `Question (fallback): `, with the fallback used for an empty answer. */
export async function askText(ask: Ask, prompt: string, options: AskOptions = {}): Promise<string> {
  const suffix = options.fallback === undefined ? "" : ` (${options.fallback})`;
  for (let tries = 0; tries < MAX_TRIES; tries += 1) {
    const answer = await ask(`${prompt}${suffix}: `);
    if (answer.length > 0) {
      return answer;
    }
    if (options.fallback !== undefined) {
      return options.fallback;
    }
    if (options.required !== true) {
      return "";
    }
    options.write?.("  This one is required.\n");
  }
  throw new PromptAbandoned();
}

export async function askYesNo(
  ask: Ask,
  prompt: string,
  fallback: boolean,
  write?: (line: string) => void,
): Promise<boolean> {
  const suffix = fallback ? "[Y/n]" : "[y/N]";
  for (let tries = 0; tries < MAX_TRIES; tries += 1) {
    const answer = (await ask(`${prompt} ${suffix}: `)).toLowerCase();
    if (answer.length === 0) {
      return fallback;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    write?.("  Answer y or n.\n");
  }
  throw new PromptAbandoned();
}

/** A numbered list. Returns the chosen index. */
export async function askChoice(
  ask: Ask,
  write: (line: string) => void,
  prompt: string,
  choices: readonly string[],
): Promise<number> {
  choices.forEach((choice, index) => {
    write(`  ${index + 1}) ${choice}\n`);
  });
  for (let tries = 0; tries < MAX_TRIES; tries += 1) {
    const answer = await ask(`${prompt} (1-${choices.length}): `);
    const picked = Number(answer);
    if (Number.isInteger(picked) && picked >= 1 && picked <= choices.length) {
      return picked - 1;
    }
    write(`  Pick a number between 1 and ${choices.length}.\n`);
  }
  throw new PromptAbandoned();
}
