import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Wrapper around tools/brain-failover/selftest.py so `npm test` covers the
// failover controller's state machine too. The python side is hermetic:
// scripted probes, no service restarts, no notifications, no network.
const selftest = fileURLToPath(new URL("../tools/brain-failover/selftest.py", import.meta.url));

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });

describe.skipIf(python.error !== undefined || !python.stdout?.includes("Python"))("brain-failover controller (python selftest)", () => {
  it("walks down→failover→up→restore with no real side effects", () => {
    const run = spawnSync("python3", [selftest], { encoding: "utf8", timeout: 120_000 });
    expect(run.status).toBe(0);
    const lines = (run.stdout ?? "").trim().split("\n");
    const summary = JSON.parse(lines[lines.length - 1]);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBeGreaterThan(20);
    // Evidence the dry-run path really was side-effect free.
    expect(run.stdout).toContain("no s2s env file written");
  });
});
