import type { AuthorityPort, Conductor, ConductorMoment } from "@bluewombat/conductor";
import type { EventName, ManagerPort } from "@bluewombat/manager-kit";
import type { WorkLedger } from "@bluewombat/work-ledger";
import type { HostOptions } from "../config/types.js";
import type { Journal } from "./journal.js";
import type { Streams } from "./streams.js";
import type { Trace } from "./trace.js";

/**
 * What one Host tick needs after composition. Shared so tick, deliveries and
 * report do not import the factory.
 */
export type HostRunInput = {
  options: HostOptions;
  /** The work line as resolved at boot: the directory, and the name work is offered to. */
  workLine: { stable: string; target?: string; env?: Record<string, string> | undefined };
  ledger: WorkLedger;
  conductor: Conductor;
  manager: ManagerPort;
  journal: Journal;
  /** Where a child's raw output was filmed, when the Project asked for it. */
  streams?: Streams;
  trace: Trace;
  /** Present when the Project declared an Authority and the manager can submit. */
  authority?: AuthorityPort;
  /**
   * Where Conductor's moments land during a pass. A tick points it at its own
   * report function before driving, so what is said mid-pass counts as that
   * tick's Events; between ticks nobody listens.
   */
  watcher: { current?: ((moment: ConductorMoment) => Promise<void>) | undefined };
  /**
   * Event ids this process already reported. A fact said once is not said
   * again by this process; the manager's own memory covers a restart.
   */
  said: Set<string>;
};

/** One Delivery (or sweep) within a tick: the run input plus Events collected so far. */
export type HostDeliveryInput = HostRunInput & {
  reported: EventName[];
};
