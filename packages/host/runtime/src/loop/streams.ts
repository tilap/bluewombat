import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join, relative } from "node:path";
import type { Journal } from "./journal.js";

/**
 * The noise level of the film: what a child said, as it said it.
 *
 * Three things are written about a run, and they are not the same kind of
 * thing. The WorkLedger is truth and is never lost. The journal is the film —
 * which phase ran, what each check answered — written synchronously so it lands
 * before the next phase starts. This is the noise underneath: the raw output of
 * every child, which is large, arrives in bursts, and is worth nothing if
 * keeping it can slow a run down or take it out.
 *
 * So it is written asynchronously and is allowed to be lost. A dropped chunk
 * costs a gap in a film; a synchronous write of an agent's stream would cost
 * the run. The journal's own docstring already says it is not truth — this is
 * one step further down.
 *
 * Off unless a Project asks for it, and that is not caution for its own sake:
 * the stream is the Project's own material in the clear — its code, its
 * prompts, whatever the agent read out loud. Same rule as a transcript.
 */

export type ChildSink = {
  write(stream: "stdout" | "stderr", chunk: string): void;
  close(): void;
};

/** Which child is speaking, in Host's terms rather than any one Transformer's. */
export type StreamSubject = {
  /** The Feature this serves, when the Transformer knew it. */
  key?: string | undefined;
  /** The Task, or `breakdown` for a Planner — the name its transcript is filed under. */
  id: string;
  attempt?: number | undefined;
  gateId?: string | undefined;
};

export type Streams = {
  open(subject: StreamSubject): ChildSink | undefined;
};

export type StreamsSpec = {
  /** Where the files go. Already resolved against the config directory. */
  dir: string;
  /** Which of the child's two streams to keep. Empty keeps nothing. */
  keep: readonly ("stdout" | "stderr")[];
  /** Where the pointer to each file is recorded, so a reader can find it. */
  journal: Journal;
};

/**
 * One file per child, filed the way a transcript is.
 *
 * Same directory per Feature and same stem as `openTranscript` writes, so the
 * prompt a slot kept and the stream underneath it sit side by side and join by
 * name rather than by guesswork.
 */
export function openStreams(spec: StreamsSpec): Streams {
  const keep = new Set(spec.keep);
  return {
    open(subject) {
      if (keep.size === 0) {
        return undefined;
      }
      try {
        const dir = join(spec.dir, slug(subject.key ?? "no-context"));
        mkdirSync(dir, { recursive: true });
        const path = join(dir, fileNameOf(subject));
        const file = createWriteStream(path, { flags: "a" });
        // A film is not part of the run: a disk that fills up, or a path that
        // cannot be written, must not reach the Task that is working.
        file.on("error", () => {});
        // The pointer, in the film proper. Without it the only way from a
        // journal line to the stream behind it is to rebuild this name by hand.
        spec.journal.append({
          event: "stream-opened",
          ...(subject.key === undefined ? {} : { key: subject.key }),
          task_id: subject.id,
          ...(subject.attempt === undefined ? {} : { attempt: subject.attempt }),
          ...(subject.gateId === undefined ? {} : { gate_id: subject.gateId }),
          path: relative(spec.dir, path),
        });
        return sinkOf(file, keep);
      } catch {
        // Could not open it: the run carries on unfilmed.
        return undefined;
      }
    },
  };
}

function sinkOf(file: WriteStream, keep: ReadonlySet<"stdout" | "stderr">): ChildSink {
  let closed = false;
  return {
    write(stream, chunk) {
      if (closed || !keep.has(stream) || chunk.length === 0) {
        return;
      }
      // One object per chunk rather than raw bytes: the stamps are what let a
      // reader replay the stream at the speed it happened, and a torn last line
      // is already handled by `parseJournalChunk`, which reads this shape.
      try {
        file.write(`${JSON.stringify({ at: new Date().toISOString(), stream, text: chunk })}\n`);
      } catch {
        // Lost a chunk. That is what this level is allowed to do.
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      try {
        file.end();
      } catch {
        // Already gone.
      }
    },
  };
}

/**
 * `<id>-attempt-<n>[-gate-<id>]-<stamp>.ndjson`.
 *
 * Stamped because a Feature resumed by a human starts its Attempt count again,
 * and two rounds would otherwise write the same name. The journal names the
 * file it opened, so nothing has to reconstruct this.
 */
function fileNameOf(subject: StreamSubject): string {
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  const gate = subject.gateId === undefined ? "" : `-gate-${slug(subject.gateId)}`;
  return `${slug(subject.id)}-attempt-${subject.attempt ?? 1}${gate}-${stamp}.ndjson`;
}

/** The slug `openTranscript` uses, so both land under the same directory name. */
function slug(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "unnamed" : cleaned.slice(0, 80);
}
