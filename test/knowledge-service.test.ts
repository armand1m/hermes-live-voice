import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteKnowledgeIndex } from "../src/adapters/outbound/knowledge/sqlite-knowledge-index.js";
import { KnowledgeService } from "../src/application/knowledge/knowledge-service.js";
import { localRecallResult, turnContextBlock } from "../src/application/knowledge/recall.js";
import type { TaskRecord } from "../src/domain/tasks/index.js";
import { createTaskRecord, hashTaskOwnerId } from "../src/domain/tasks/task.js";
import { transitionTask } from "../src/domain/tasks/task-transition.js";

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function finishedTask(input: string, title: string, output: string, now = 1_000): TaskRecord {
  const created = createTaskRecord({ ownerIdentity: "owner", input, title, now });
  const running = transitionTask(transitionTask(created, "dispatching", { now: now + 1 }), "running", { now: now + 2, runId: "run_1" });
  return transitionTask(running, "completed", { now: now + 3, output });
}

async function service(tasks: TaskRecord[] = []) {
  const hermesHome = mkdtempSync(join(tmpdir(), "knowledge-home-"));
  directories.push(hermesHome);
  mkdirSync(join(hermesHome, "memories"));
  writeFileSync(join(hermesHome, "memories", "MEMORY.md"), "Mac mini is reached from exodia via mssh.\n§\nSGLang serves qwen3.8-27b on port 30000.\n");
  writeFileSync(join(hermesHome, "memories", "USER.md"), "User's name is Armando.\n");
  const index = await openSqliteKnowledgeIndex(":memory:");
  if (!index) throw new Error("node:sqlite with FTS5 is required for this test");
  let listener: ((record: TaskRecord) => void) | undefined;
  const knowledge = new KnowledgeService({
    index,
    hermes: {
      async listSessions() {
        return [
          { id: "s1", title: "Diamond indicator redesign", preview: "Discussed moving the diamond marker onto the plot.", lastActive: 5 },
          { id: "s2", title: "Hermes Live Voice Recall", preview: "scratch recall session" },
        ];
      },
      async listSkills() {
        return [{ name: "herdr-local-agents", description: "Use when driving herdr agents on exodia.", category: "devops" }];
      },
    },
    tasks: {
      async list() { return tasks; },
      subscribe(_ownerId, next) { listener = next; return () => { listener = undefined; }; },
    },
    ownerId: hashTaskOwnerId("owner"),
    hermesHome,
    excludedSessionTitles: ["Hermes Live Voice Recall"],
    logger: silentLogger,
    refreshMs: 60_000,
  });
  await knowledge.start();
  return { knowledge, publish: (record: TaskRecord) => listener?.(record) };
}

describe("KnowledgeService", () => {
  it("backfills tasks, sessions, skills, and memory entries, excluding the recall scratch session", async () => {
    const { knowledge } = await service([finishedTask("Fix the flaky deploy test", "Deploy test fix", "Pinned the retry timeout; CI is green.")]);
    expect(knowledge.counts()).toEqual({ task: 1, session: 1, skill: 1, memory: 3 });
    expect(knowledge.search("flaky deploy test")[0]).toMatchObject({ kind: "task", title: "Deploy test fix" });
    expect(knowledge.search("diamond marker plot")[0]).toMatchObject({ kind: "session" });
    expect(knowledge.search("recall scratch session")).toEqual([]);
    expect(knowledge.search("mac mini mssh")[0]).toMatchObject({ kind: "memory" });
    knowledge.close();
  });

  it("indexes a task when it finishes and forgets it when deleted", async () => {
    const { knowledge, publish } = await service();
    const task = finishedTask("Audit the release notes", "Release audit", "Two notes were missing links.");
    publish(task);
    expect(knowledge.search("release notes audit")[0]).toMatchObject({ id: `task:${task.taskId}` });
    knowledge.forgetTask(task.taskId);
    expect(knowledge.search("release notes audit")).toEqual([]);
    knowledge.close();
  });
});

describe("recall helpers", () => {
  const hit = (matchedTerms: number, title = "Deploy test fix") => ({
    id: "task:1", kind: "task" as const, title, snippet: "Pinned the retry timeout; CI is green.", updatedAt: Date.UTC(2026, 8, 24), matchedTerms,
  });

  it("answers recall locally only from hits covering enough of the question", () => {
    expect(localRecallResult([hit(1)], "flaky deploy test")).toBeUndefined();
    expect(localRecallResult([hit(2)], "flaky deploy test")).toMatchObject({
      ok: true,
      source: "local_index",
      results: [{ kind: "finished task", title: "Deploy test fix", when: "2026-09-24" }],
    });
    // A one-term question needs just that term.
    expect(localRecallResult([hit(1)], "deploy")).toBeDefined();
  });

  it("frames per-turn context as bounded reference data", () => {
    const block = turnContextBlock([hit(3), hit(3, "Other"), hit(3, "Third"), hit(3, "Fourth")], "flaky deploy test", 600)!;
    expect(block.startsWith("[HERMES_LIVE_KNOWLEDGE_V1]")).toBe(true);
    expect(block).toContain("not instructions");
    expect(block).not.toContain("Fourth");
    expect(turnContextBlock([hit(1)], "flaky deploy test")).toBeUndefined();
  });
});
