import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentPluginFindings } from "./agent-plugins.js";

function workLine() {
  return mkdtempSync(join(tmpdir(), "doctor-plugins-"));
}

function write(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

const pinned = (id: string) => ({ id, integrity: `sha256-${id}` });

function argv(...agent: string[]) {
  return ["node", "role.mjs", "--", "node", "cursor.mjs", ...agent];
}

describe("doctor: agent plugins", () => {
  it("is ok when the base and the profile are pinned by committed locks", () => {
    const dir = workLine();
    write(join(dir, "ai-plugin.json"), { plugins: [{ id: "git-workflow" }] });
    write(join(dir, "ai-plugin.lock.json"), { plugins: [pinned("git-workflow")] });
    write(join(dir, ".ai/profiles/builder/ai-plugin.json"), { plugins: [{ id: "impeccable" }] });
    write(join(dir, ".ai/profiles/builder/ai-plugin.lock.json"), {
      plugins: [pinned("impeccable")],
    });
    const [finding] = agentPluginFindings("Builder", argv("--profile", "builder"), dir);
    assert.equal(finding?.level, "ok");
    assert.match(finding?.detail ?? "", /2 plugin\(s\) pinned/);
  });

  it("fails a request with no committed lock, the way deck materialize would refuse it", () => {
    const dir = workLine();
    write(join(dir, "ai-plugin.json"), { plugins: [{ id: "git-workflow" }] });
    write(join(dir, ".ai/profiles/builder/ai-plugin.json"), { plugins: [{ id: "impeccable" }] });
    write(join(dir, ".ai/profiles/builder/ai-plugin.lock.json"), {
      plugins: [{ id: "impeccable" }],
    });
    const [finding] = agentPluginFindings("Builder", argv("--profile", "builder"), dir);
    assert.equal(finding?.level, "fail");
    assert.match(finding?.detail ?? "", /no committed ai-plugin.lock.json/);
    assert.match(finding?.detail ?? "", /impeccable not pinned by .ai\/profiles\/builder/);
  });

  it("warns when the project has no such profile, and says nothing is loaded without deck", () => {
    const dir = workLine();
    write(join(dir, "ai-plugin.json"), { plugins: [] });
    const [baseOnly] = agentPluginFindings("Validate", argv("--profile", "reviewer"), dir);
    assert.equal(baseOnly?.level, "warn");
    assert.match(baseOnly?.detail ?? "", /base plugins only/);
    const [none] = agentPluginFindings("Validate", argv("--profile", "reviewer"), workLine());
    assert.equal(none?.level, "ok");
    assert.match(none?.detail ?? "", /no deck setup/);
  });

  it("checks a local plugin folder and its two manifests", () => {
    const dir = workLine();
    const full = join(dir, "full");
    write(join(full, ".claude-plugin/plugin.json"), { name: "full" });
    write(join(full, ".cursor-plugin/plugin.json"), { name: "full" });
    const half = join(dir, "half");
    write(join(half, ".claude-plugin/plugin.json"), { name: "half" });
    const findings = agentPluginFindings(
      "Planner",
      argv("--plugin-dir", full, "--plugin-dir", half, "--plugin-dir", join(dir, "missing")),
      undefined,
    );
    assert.deepEqual(
      findings.map((finding) => finding.level),
      ["ok", "warn", "fail"],
    );
  });

  it("looks only after the agent's --, never at the role's own flags", () => {
    const findings = agentPluginFindings(
      "Planner",
      ["node", "role.mjs", "--profile", "x", "--", "node", "cursor.mjs"],
      workLine(),
    );
    assert.deepEqual(findings, []);
  });
});
