import { stringify as stringifyYaml } from "yaml";

/**
 * Test fixtures describe a config by its parts (`featureTracker`, `ticketTracker`, `builder`,
 * `ticket`, `feature`), one object each. A config file groups them by level: `ticket` holds its
 * tracker and its build, `feature` its tracker and its test. This writes a fixture as the file.
 * A fixture already in the file's shape (a `tracker` inside `ticket` or `feature`) is left alone.
 */
export function fixtureYaml(fixture: Record<string, unknown>): string {
  const { featureTracker, ticketTracker, builder, ticket, feature, ...rest } = fixture;
  const { featureTest, ...build } = (builder ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  const ticketBlock = {
    ...(ticketTracker === undefined ? {} : { tracker: ticketTracker }),
    ...(builder === undefined ? {} : { build }),
    ...((ticket ?? {}) as Record<string, unknown>),
  };
  const featureBlock = {
    ...(featureTracker === undefined ? {} : { tracker: featureTracker }),
    ...(featureTest === undefined ? {} : { test: featureTest }),
    ...((feature ?? {}) as Record<string, unknown>),
  };
  if (Object.keys(ticketBlock).length > 0 || ticket !== undefined) {
    out.ticket = ticketBlock;
  }
  if (Object.keys(featureBlock).length > 0 || feature !== undefined) {
    out.feature = featureBlock;
  }
  return stringifyYaml(out);
}
