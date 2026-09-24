import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentWatchStore } from "../src/adapters/outbound/external-work/file-agent-watch-store.js";
import {
  createAgentWatchRecord,
  hashWatchOwnerId,
  recordWatchObservation,
  stopWatch,
} from "../src/domain/external-work/index.js";

const directories: string[] = [];

function newStore(): { store: FileAgentWatchStore; file: string } {
  const directory = mkdtempSync(join(tmpdir(), "watches-"));
  directories.push(directory);
  const file = join(directory, "agent-watches-v1.json");
  return { store: new FileAgentWatchStore({ directory }), file };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const OWNER = hashWatchOwnerId("alice");
const BASE = {
  ownerId: OWNER,
  host: "mac-mini" as const,
  harness: "herdr" as const,
  agentSessionValue: "3fdb0b0b-4dd0-4c0d-8d0d-de71b00e5eea",
  paneId: "w6:p1",
  objective: "Archive the amp-sim recordings.",
  acceptanceCriteria: ["Archive verified"],
};

describe("FileAgentWatchStore", () => {
  it("persists watches atomically and reloads them across restarts", async () => {
    const { store, file } = newStore();
    const watch = createAgentWatchRecord({ ...BASE, now: 100 });
    await store.put(watch);
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ schemaVersion: 1, watches: [{ watchId: watch.watchId }] });

    // A fresh store instance is a gateway restart: watches survive.
    const restarted = new FileAgentWatchStore({ directory: join(file, "..") });
    const loaded = await restarted.load(watch.watchId);
    expect(loaded).toMatchObject({ watchId: watch.watchId, host: "mac-mini", status: "watching" });
    const listed = await restarted.list({ ownerId: OWNER });
    expect(listed).toHaveLength(1);
    // Owner scoping hides other owners' watches.
    expect(await restarted.list({ ownerId: hashWatchOwnerId("bob") })).toHaveLength(0);
    await restarted.close();
  });

  it("advances revisions under conflict checks and refuses identity rewrites", async () => {
    const { store } = newStore();
    const watch = createAgentWatchRecord({ ...BASE, now: 100 });
    await store.put(watch);
    const updated = recordWatchObservation(watch, {
      now: 150,
      observation: { state: "working", agentStatus: "working", at: 150 },
      summary: "Agent working.",
    });
    await store.update(watch.watchId, () => updated, { expectedRevision: watch.revision });
    await expect(store.update(watch.watchId, (current) => current, { expectedRevision: watch.revision }))
      .rejects.toThrow(/revision conflict/);
    await expect(store.update(watch.watchId, (current) => ({
      ...current,
      revision: current.revision + 1,
      ownerId: hashWatchOwnerId("mallory"),
    }))).rejects.toThrow(/immutable/);
    await expect(store.update(`watch_${"0".repeat(32)}`, (current) => current)).rejects.toThrow(/not found/);
  });

  it("prunes stopped watches by age and count, never active ones", async () => {
    const { store } = newStore();
    const active = createAgentWatchRecord({ ...BASE, now: 100 });
    await store.put(active);
    const stoppedOld = stopWatch(
      createAgentWatchRecord({ ...BASE, paneId: "w7:p1", now: 100 }),
      { now: 150, reason: "done watching" },
    );
    await store.put(stoppedOld);
    const pruned = await store.prune({ stoppedBefore: 200 });
    expect(pruned.watchIds).toEqual([stoppedOld.watchId]);
    expect(await store.load(stoppedOld.watchId)).toBeUndefined();
    expect(await store.load(active.watchId)).toBeDefined();
  });
});
