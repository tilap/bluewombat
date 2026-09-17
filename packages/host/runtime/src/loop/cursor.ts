import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function cursorPath(ledgerRoot: string): string {
  return join(ledgerRoot, "cursor");
}

export async function loadCursor(ledgerRoot: string): Promise<string | undefined> {
  try {
    const text = (await readFile(cursorPath(ledgerRoot), "utf8")).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCursor(ledgerRoot: string, cursor: string): Promise<void> {
  const path = cursorPath(ledgerRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${cursor}\n`, "utf8");
}
