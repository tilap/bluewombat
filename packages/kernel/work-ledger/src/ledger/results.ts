import type { RefusalCode } from "../records.js";

export type CommandOk = { ok: true };
export type CommandRefused = { ok: false; code: RefusalCode };
export type CommandResult = CommandOk | CommandRefused;

export function refused(code: RefusalCode): CommandRefused {
  return { ok: false, code };
}
