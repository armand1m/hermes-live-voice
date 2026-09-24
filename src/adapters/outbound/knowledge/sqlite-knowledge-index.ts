import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type {
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexPort,
  KnowledgeKind,
  KnowledgeSearchOptions,
} from "../../../application/knowledge/ports/knowledge-index.port.js";
import { queryTerms } from "../../../application/knowledge/query-terms.js";

// SQLite FTS5 over node:sqlite (Node >= 22.5, no npm dependency). The index is
// a derived cache: it can be deleted at any time and is rebuilt from its
// sources, so it never needs migrations — a schema change bumps the file name.

const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 4_000;
const DEFAULT_LIMIT = 5;

type SqliteStatement = {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
};
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

/**
 * Open the index, or return undefined when this Node build has no
 * node:sqlite / FTS5 (the feature then stays off instead of failing startup).
 */
export async function openSqliteKnowledgeIndex(path: string): Promise<SqliteKnowledgeIndex | undefined> {
  let DatabaseSync: new (path: string) => SqliteDatabase;
  try {
    // Loaded lazily: node:sqlite emits an ExperimentalWarning on some Node
    // versions and does not exist at all before 22.5.
    // The specifier is a variable so type declarations for Node 20 (which
    // lacks the module) still compile.
    const specifier = "node:sqlite";
    ({ DatabaseSync } = await import(specifier) as { DatabaseSync: new (path: string) => SqliteDatabase });
  } catch {
    return undefined;
  }
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // The index holds task prompts and results: owner-only like the task
    // store. SQLite gives its -wal/-shm files the main file's permissions.
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        id UNINDEXED, kind UNINDEXED, owner UNINDEXED, title, body, updated UNINDEXED,
        tokenize = 'porter unicode61'
      );
    `);
  } catch (error) {
    db.close();
    if (/fts5/iu.test(String(error))) return undefined;
    throw error;
  }
  return new SqliteKnowledgeIndex(db);
}

export class SqliteKnowledgeIndex implements KnowledgeIndexPort {
  private readonly deleteById: SqliteStatement;
  private readonly insert: SqliteStatement;

  constructor(private readonly db: SqliteDatabase) {
    this.deleteById = db.prepare("DELETE FROM docs WHERE id = ?");
    this.insert = db.prepare("INSERT INTO docs (id, kind, owner, title, body, updated) VALUES (?, ?, ?, ?, ?, ?)");
  }

  upsert(documents: readonly KnowledgeDocument[]): void {
    if (documents.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const doc of documents) {
        this.deleteById.run(doc.id);
        this.insert.run(
          doc.id,
          doc.kind,
          doc.ownerId ?? "",
          clean(doc.title, MAX_TITLE_CHARS),
          clean(doc.body, MAX_BODY_CHARS),
          Math.trunc(doc.updatedAt),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  retainOnly(kind: KnowledgeKind, keepIds: ReadonlySet<string>): void {
    const existing = this.db.prepare("SELECT id FROM docs WHERE kind = ?").all(kind);
    const stale = existing.map((row) => String(row.id)).filter((id) => !keepIds.has(id));
    if (stale.length === 0) return;
    this.db.exec("BEGIN");
    try {
      for (const id of stale) this.deleteById.run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string, options: KnowledgeSearchOptions = {}): KnowledgeHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const match = terms.map((term) => `"${term}"`).join(" OR ");
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 20));
    const kinds = options.kinds?.length ? options.kinds : undefined;
    const rows = this.db.prepare(`
      SELECT id, kind, owner, title, body, updated,
             snippet(docs, 4, '', '', '…', 24) AS excerpt
      FROM docs
      WHERE docs MATCH ?
        ${kinds ? `AND kind IN (${kinds.map(() => "?").join(", ")})` : ""}
        AND (owner = '' OR owner = ?)
      ORDER BY bm25(docs, 0, 0, 0, 4.0, 1.0, 0)
      LIMIT ?
    `).all(match, ...(kinds ?? []), options.ownerId ?? "", limit * 3);
    const hits = rows.map((row) => {
      const title = String(row.title);
      const body = String(row.body);
      return {
        id: String(row.id),
        kind: String(row.kind) as KnowledgeKind,
        title,
        snippet: String(row.excerpt || body).slice(0, 400),
        updatedAt: Number(row.updated),
        matchedTerms: countMatchedTerms(`${title} ${body}`, terms),
      };
    });
    // BM25 ranks; a hit that matches more distinct terms of the question is
    // the stronger answer, so it leads among near-equal ranks.
    return hits
      .map((hit, rank) => ({ hit, rank }))
      .sort((a, b) => b.hit.matchedTerms - a.hit.matchedTerms || a.rank - b.rank)
      .slice(0, limit)
      .map(({ hit }) => hit);
  }

  count(kind?: KnowledgeKind): number {
    const row = kind
      ? this.db.prepare("SELECT count(*) AS n FROM docs WHERE kind = ?").get(kind)
      : this.db.prepare("SELECT count(*) AS n FROM docs").get();
    return Number(row?.n ?? 0);
  }

  close(): void {
    this.db.close();
  }
}


function countMatchedTerms(text: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase();
  // Porter stems match inflections; a 5-char prefix approximates that here.
  return terms.filter((term) => haystack.includes(term.length > 5 ? term.slice(0, 5) : term)).length;
}

function clean(value: string, max: number): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, max);
}
