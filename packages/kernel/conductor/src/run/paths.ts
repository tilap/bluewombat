import { join } from "node:path";

export function featureWorkspacePath(workspaceRoot: string, key: string): string {
  return join(workspaceRoot, encodeURIComponent(key), "feature");
}

export function subtaskWorkspacePath(
  workspaceRoot: string,
  key: string,
  subtaskId: string,
): string {
  return join(workspaceRoot, encodeURIComponent(key), `subtask-${encodeURIComponent(subtaskId)}`);
}
