export type ProgressWriter = (line: Record<string, unknown>) => void;

export function createStdoutProgressWriter(): ProgressWriter {
  return (line) => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  };
}
