// A manager whose only job is to let the setup command be tested without a
// tracker: one label that is missing until `apply` is asked for.
export function createManager() {
  return { ok: false, reason: "This stub only implements setup." };
}

export function setupManager(_context, input) {
  return {
    ok: true,
    steps: [
      { id: "label:mason", summary: "label mason", state: "satisfied" },
      {
        id: "label:ready",
        summary: "create label ready",
        state: input.apply ? "applied" : "missing",
      },
    ],
  };
}
