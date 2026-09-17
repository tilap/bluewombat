#!/usr/bin/env node
/**
 * Bootstrap Planner: one Subtask that is the FeatureStandard itself.
 * FeatureBreakdown appends --intention, --key, --max-units.
 */
import { emitPlan, emitRefusal, take } from "@bluewombat/slot-kit";

const intention = (take(process.argv, "--intention") ?? "").trim();
if (intention.length === 0) {
  emitRefusal("The FeatureStandard has no intention to turn into a Subtask.");
  process.exit(0);
}

emitPlan([
  {
    id: "A",
    intention,
    definition_of_done: "The intention is realized in the workspace.",
    depends_on: [],
  },
]);
