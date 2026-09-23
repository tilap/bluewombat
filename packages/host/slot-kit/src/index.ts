/**
 * What a slot needs to answer the Transformer that spawned it.
 *
 * A slot is an opaque command: Implementer spawns a Builder and its Gates,
 * FeatureBreakdown spawns a Planner, and each one reads argv and writes one
 * JSON line on stdout. Nothing here is required to fill a slot — a shell script
 * that prints the right line is a Gate. This is the plumbing that every slot
 * written in Node would otherwise write again.
 */

export type {
  AgentExtras,
  AgentInvocation,
  AgentRun,
  AgentUsage,
  SerializeAbout,
  SerializedRun,
} from "./agent.js";
export {
  deserializeRun,
  extrasOf,
  findExecutable,
  readResult,
  runAgent,
  serializeRun,
} from "./agent.js";
export {
  BUILDER_FLAGS,
  GATE_FLAGS,
  MESSAGE_FLAGS,
  ownArgv,
  PLANNER_FLAGS,
  PUBLISHER_FLAGS,
  REFRESHER_FLAGS,
  splitRunner,
  stageOf,
  take,
} from "./argv.js";
export type { Failure, Verdict, Write } from "./emit.js";
export {
  emitFailure,
  emitMessage,
  emitPlan,
  emitPublication,
  emitPublishRefusal,
  emitRefreshed,
  emitRefreshRefusal,
  emitRefusal,
  emitVerdict,
  writeContract,
  writeDiagnostic,
} from "./emit.js";
export type { FinishedRun } from "./finish.js";
export { failureOf, finishRun } from "./finish.js";
export { pathMatchesGlob } from "./glob.js";
export type { OptionRule, OptionSpec, OptionValues, ParsedOptions } from "./options.js";
export { listOption, parseOptions, textOption } from "./options.js";
export type { CheckedPlan, PlanSubtask } from "./plan.js";
export { checkPlan } from "./plan.js";
export type { ReadTemplate, Rendered, TranscriptSubject } from "./prompt.js";
export {
  AGENT_OPTIONS,
  PROMPT_RULES,
  readAgentPrompt,
  readTemplate,
  renderPrompt,
  transcriptFor,
} from "./prompt.js";
export type { AgentAbout, ParsedRole, SpawnedAgent, TranscriptExtras } from "./role.js";
export {
  fillPrompt,
  loadPrompt,
  loadRules,
  parseRole,
  ROLE_OPTIONS,
  spawnFilled,
  transcriptArgs,
} from "./role.js";
export type { Transcript, TranscriptPart, TranscriptSpec } from "./transcript.js";
export { openTranscript, skillsLabel, TRANSCRIPT_PARTS, usageLabel } from "./transcript.js";
