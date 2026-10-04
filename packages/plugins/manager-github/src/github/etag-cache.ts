/**
 * The last answer GitHub gave to each URL this manager read, with its `etag`.
 *
 * Asked again with `If-None-Match`, GitHub answers 304 when nothing changed —
 * and a 304 sent with an Authorization header does not count against the
 * token's hourly budget. The answer kept here is then handed back as is, so a
 * caller sees exactly what a full read would have given it: a page of issues
 * not yet consumed is delivered again, never skipped.
 *
 * Lives as long as the manager does: one `mason run`. Bounded, least recently
 * used out first.
 */
export type CachedAnswer = {
  etag: string;
  /** The response a full read returned, handed back on a 304. */
  response: unknown;
};

const DEFAULT_LIMIT = 64;

export type EtagCache = {
  get(url: string): CachedAnswer | undefined;
  set(url: string, answer: CachedAnswer): void;
};

export function createEtagCache(limit = DEFAULT_LIMIT): EtagCache {
  const answers = new Map<string, CachedAnswer>();
  return {
    get(url) {
      const answer = answers.get(url);
      if (answer !== undefined) {
        // Read again: the most recently used goes to the back of the line.
        answers.delete(url);
        answers.set(url, answer);
      }
      return answer;
    },
    set(url, answer) {
      answers.delete(url);
      answers.set(url, answer);
      while (answers.size > limit) {
        const oldest = answers.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        answers.delete(oldest);
      }
    },
  };
}
