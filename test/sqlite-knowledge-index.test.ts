import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSqliteKnowledgeIndex } from "../src/adapters/outbound/knowledge/sqlite-knowledge-index.js";
import { queryTerms } from "../src/application/knowledge/query-terms.js";

describe("queryTerms", () => {
  it("keeps distinct content words and drops stopwords, short words, and FTS syntax", () => {
    expect(queryTerms('What did we do about the "flaky" deploy tests? AND OR NEAR(x)')).toEqual([
      "flaky", "deploy", "tests", "near",
    ]);
    expect(queryTerms("how are you")).toEqual([]);
    expect(queryTerms("what's my name")).toEqual(["name"]);
  });
});

describe("SqliteKnowledgeIndex", () => {
  async function index() {
    const opened = await openSqliteKnowledgeIndex(":memory:");
    if (!opened) throw new Error("node:sqlite with FTS5 is required for this test");
    return opened;
  }

  it("finds documents by stemmed terms and prefers hits matching more of the question", async () => {
    const knowledge = await index();
    knowledge.upsert([
      { id: "task:1", kind: "task", ownerId: "owner_a", title: "Deploy fix", body: "Fixed the flaky deploying tests on exodia.", updatedAt: 1 },
      { id: "skill:herdr", kind: "skill", title: "herdr-local-agents", body: "Use when driving herdr agents on exodia.", updatedAt: 2 },
      { id: "session:9", kind: "session", title: "Release planning", body: "Continue the release checklist.", updatedAt: 3 },
    ]);
    const hits = knowledge.search("what happened with the flaky deploy test on exodia", { ownerId: "owner_a" });
    expect(hits[0]).toMatchObject({ id: "task:1", kind: "task", title: "Deploy fix" });
    expect(hits[0]!.matchedTerms).toBeGreaterThanOrEqual(3);
    expect(hits.map((hit) => hit.id)).toContain("skill:herdr");
    expect(knowledge.search("release checklist", { kinds: ["session"] }).map((hit) => hit.id)).toEqual(["session:9"]);
    knowledge.close();
  });

  it("never returns another owner's private documents", async () => {
    const knowledge = await index();
    knowledge.upsert([
      { id: "task:a", kind: "task", ownerId: "owner_a", title: "Tax return", body: "Filed the tax return.", updatedAt: 1 },
      { id: "memory:1", kind: "memory", title: "Memory", body: "User files the tax return in April.", updatedAt: 1 },
    ]);
    expect(knowledge.search("tax return", { ownerId: "owner_b" }).map((hit) => hit.id)).toEqual(["memory:1"]);
    expect(knowledge.search("tax return", { ownerId: "owner_a" }).map((hit) => hit.id).sort()).toEqual(["memory:1", "task:a"]);
    knowledge.close();
  });

  it("replaces documents by id and syncs a source with retainOnly", async () => {
    const knowledge = await index();
    knowledge.upsert([
      { id: "skill:a", kind: "skill", title: "alpha", body: "old text", updatedAt: 1 },
      { id: "skill:b", kind: "skill", title: "beta", body: "kept", updatedAt: 1 },
    ]);
    knowledge.upsert([{ id: "skill:a", kind: "skill", title: "alpha", body: "new wording", updatedAt: 2 }]);
    expect(knowledge.count("skill")).toBe(2);
    expect(knowledge.search("wording")).toHaveLength(1);
    expect(knowledge.search("old text")).toHaveLength(0);
    knowledge.retainOnly("skill", new Set(["skill:a"]));
    expect(knowledge.count("skill")).toBe(1);
    knowledge.close();
  });

  it("creates the index file and its WAL owner-only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "knowledge-perms-"));
    try {
      const path = join(directory, "state", "knowledge-v1.sqlite");
      const knowledge = await openSqliteKnowledgeIndex(path);
      knowledge!.upsert([{ id: "task:1", kind: "task", title: "t", body: "b", updatedAt: 1 }]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      knowledge!.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
