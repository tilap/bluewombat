export type ConductorRefusalCode =
  | "stable-missing"
  | "root-invalid"
  | "persist-failed"
  | "interrupted"
  | "isolate-failed"
  | "line-refresh-failed"
  | "warm-failed"
  | "transformer-invalid"
  | "unavailable"
  | "not-found"
  | "point-of-no-return"
  | "project-busy"
  | "illegal-transition";

export type ProjectRunResult =
  | { outcome: "idle" }
  | { outcome: "done"; key: string }
  | { outcome: "escalated"; key: string }
  | { outcome: "paused"; key?: string }
  | { outcome: "refused"; code: ConductorRefusalCode };
