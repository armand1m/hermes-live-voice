/** What a knowledge document was derived from. */
export type KnowledgeKind = "task" | "session" | "skill" | "memory";

export interface KnowledgeDocument {
  /** Stable identity: re-upserting the same id replaces the document. */
  id: string;
  kind: KnowledgeKind;
  /** Owner scope for owner-private sources (tasks); absent means shared. */
  ownerId?: string;
  title: string;
  body: string;
  updatedAt: number;
}

export interface KnowledgeHit {
  id: string;
  kind: KnowledgeKind;
  title: string;
  /** Bounded excerpt around the matched terms. */
  snippet: string;
  updatedAt: number;
  /** Distinct query terms found in the title or body. */
  matchedTerms: number;
}

export interface KnowledgeSearchOptions {
  limit?: number;
  kinds?: readonly KnowledgeKind[];
  /** Owner-private documents of other owners are never returned. */
  ownerId?: string;
}

/**
 * Local lexical index over the assistant's own history (finished tasks,
 * Hermes session titles, skills, memory). Synchronous by design: a query is a
 * few milliseconds, cheap enough to run inside a voice turn.
 */
export interface KnowledgeIndexPort {
  upsert(documents: readonly KnowledgeDocument[]): void;
  /** Drop every document of one kind whose id is not in `keepIds` (source sync). */
  retainOnly(kind: KnowledgeKind, keepIds: ReadonlySet<string>): void;
  search(query: string, options?: KnowledgeSearchOptions): KnowledgeHit[];
  count(kind?: KnowledgeKind): number;
  close(): void;
}
