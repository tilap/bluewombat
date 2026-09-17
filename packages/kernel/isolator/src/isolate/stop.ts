export type IsolationStop = "clock" | "interrupt";

export class IsolationStoppedError extends Error {
  readonly stop: IsolationStop;

  constructor(stop: IsolationStop) {
    super(
      stop === "clock"
        ? "The Isolation clock fired."
        : "A stop signal arrived before Isolation completed.",
    );
    this.name = "IsolationStoppedError";
    this.stop = stop;
  }
}

export async function throwIfStopped(shouldStop: () => IsolationStop | undefined): Promise<void> {
  const stop = shouldStop();
  if (stop !== undefined) {
    throw new IsolationStoppedError(stop);
  }
}
