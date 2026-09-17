import { copyFold } from "./fold.js";
import { copyIsolation } from "./isolation.js";
import type { IsolationStrategy } from "./types.js";

export const strategy: IsolationStrategy = {
  isolation: copyIsolation,
  fold: copyFold,
};
