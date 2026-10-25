import type { DatabaseSync } from "node:sqlite";

export type RunStatus = "queued" | "running" | "needs_disambiguation" | "completed" | "failed";
export type ErrorCategory = "person_not_found" | "provider_error";

export interface Candidate {
  wikipedia_page_id: number;
  title: string;
  description: string;
  url: string;
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  personQuery: string;
  question: string;
  person: Record<string, unknown> | null;
  candidates: Candidate[];
  errorCategory: ErrorCategory | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonInput {
  canonicalName: string;
  description: string;
  wikipediaPageId: number;
  wikipediaUrl: string;
  aliases: string[];
}

export interface NewRun {
  id: string;
  personQuery: string;
  question: string;
}

interface RunRow {
  id: string;
  status: string;
  person_query: string;
  question: string;
  person_id: string | null;
  candidates: string | null;
  error_category: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonRow {
  id: string;
  canonical_name: string;
  description: string;
  wikipedia_page_id: number;
  wikipedia_url: string;
  aliases: string;
  created_at: string;
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseCandidates(raw: string | null): Candidate[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Candidate[]) : [];
  } catch {
    return [];
  }
}

/**
 * The only place that talks to SQLite. Every read and write of runs, people
 * and candidates goes through here, so the store can move to a managed
 * database later without touching the routes or the resolution logic.
 */
export class StatementsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.migrate();
  }

  /** Additive migrations, safe to run more than once. */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        person_query TEXT NOT NULL,
        question TEXT NOT NULL,
        person_id TEXT,
        candidates TEXT,
        error_category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS people (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        description TEXT NOT NULL,
        wikipedia_page_id INTEGER NOT NULL UNIQUE,
        wikipedia_url TEXT NOT NULL,
        aliases TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  createRun(input: NewRun): RunRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO runs (id, status, person_query, question, person_id, candidates, error_category, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(input.id, input.personQuery, input.question, now, now);
    return this.getRun(input.id) as RunRecord;
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? this.toRun(row) : null;
  }

  setRunStatus(id: string, status: RunStatus, errorCategory: ErrorCategory | null = null): void {
    this.db
      .prepare(`UPDATE runs SET status = ?, error_category = ?, updated_at = ? WHERE id = ?`)
      .run(status, errorCategory, new Date().toISOString(), id);
  }

  setRunCandidates(id: string, candidates: Candidate[]): void {
    this.db
      .prepare(`UPDATE runs SET status = 'needs_disambiguation', candidates = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(candidates), new Date().toISOString(), id);
  }

  /** Stores (or reuses) a person record and links it to the run, completing it. */
  setRunPerson(id: string, person: PersonInput): void {
    const personId = this.upsertPerson(person);
    this.db
      .prepare(
        `UPDATE runs SET status = 'completed', person_id = ?, candidates = NULL, error_category = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(personId, new Date().toISOString(), id);
  }

  /** Two people with the same name but different page ids are two records. */
  private upsertPerson(person: PersonInput): string {
    const existing = this.db
      .prepare(`SELECT id FROM people WHERE wikipedia_page_id = ?`)
      .get(person.wikipediaPageId) as { id: string } | undefined;
    if (existing) return existing.id;

    const id = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO people (id, canonical_name, description, wikipedia_page_id, wikipedia_url, aliases, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        person.canonicalName,
        person.description,
        person.wikipediaPageId,
        person.wikipediaUrl,
        JSON.stringify(person.aliases),
        new Date().toISOString(),
      );
    return id;
  }

  getPerson(id: string): Record<string, unknown> | null {
    const row = this.db.prepare(`SELECT * FROM people WHERE id = ?`).get(id) as PersonRow | undefined;
    return row ? this.toPerson(row) : null;
  }

  private toRun(row: RunRow): RunRecord {
    return {
      id: row.id,
      status: row.status as RunStatus,
      personQuery: row.person_query,
      question: row.question,
      person: row.person_id ? this.getPerson(row.person_id) : null,
      candidates: parseCandidates(row.candidates),
      errorCategory: row.error_category as ErrorCategory | null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toPerson(row: PersonRow): Record<string, unknown> {
    return {
      id: row.id,
      canonical_name: row.canonical_name,
      description: row.description,
      wikipedia_page_id: row.wikipedia_page_id,
      wikipedia_url: row.wikipedia_url,
      aliases: parseStringArray(row.aliases),
      created_at: row.created_at,
    };
  }
}
