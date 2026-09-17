// A manager whose tracker is never ready, to prove `mason init` still
// succeeds: it wrote its files, and a setup plan is only a report.
export function createManager() {
  return { ok: false, reason: "This stub only implements setup." };
}

export function setupManager() {
  return {
    ok: false,
    steps: [{ id: "token", summary: "a token", state: "blocked", detail: "not set" }],
  };
}
