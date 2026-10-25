import { logger } from "../logger";
import { resolvePerson } from "./resolution";
import type { StatementsStore, RunRecord } from "./store";
import { WikipediaError, type WikipediaClient } from "./wikipedia";

export interface StatementsService {
  createRun(personQuery: string, question: string): RunRecord;
  getRun(id: string): RunRecord | null;
  selectCandidate(id: string, wikipediaPageId: number): SelectResult;
}

export type SelectResult =
  { ok: true; run: RunRecord } | { ok: false; reason: "not_found" | "invalid_page" | "invalid_state" };

export class StatementsServiceImpl implements StatementsService {
  private readonly store: StatementsStore;
  private readonly wikipedia: WikipediaClient;

  constructor(store: StatementsStore, wikipedia: WikipediaClient) {
    this.store = store;
    this.wikipedia = wikipedia;
  }

  createRun(personQuery: string, question: string): RunRecord {
    const run = this.store.createRun({ id: crypto.randomUUID(), personQuery, question });
    // Resolve in the background of the same process; the response returns first.
    void this.resolveInBackground(run.id, personQuery);
    return run;
  }

  getRun(id: string): RunRecord | null {
    return this.store.getRun(id);
  }

  selectCandidate(id: string, wikipediaPageId: number): SelectResult {
    const run = this.store.getRun(id);
    if (!run) return { ok: false, reason: "not_found" };
    if (run.status !== "needs_disambiguation") return { ok: false, reason: "invalid_state" };

    const candidate = run.candidates.find((c) => c.wikipedia_page_id === wikipediaPageId);
    if (!candidate) return { ok: false, reason: "invalid_page" };

    this.store.setRunPerson(id, {
      canonicalName: candidate.title,
      description: candidate.description,
      wikipediaPageId: candidate.wikipedia_page_id,
      wikipediaUrl: candidate.url,
      aliases: [],
    });
    return { ok: true, run: this.store.getRun(id) as RunRecord };
  }

  private async resolveInBackground(id: string, personQuery: string): Promise<void> {
    try {
      this.store.setRunStatus(id, "running");
      const results = await this.wikipedia.search(personQuery);
      const resolution = resolvePerson(results);

      if (resolution.kind === "person") {
        this.store.setRunPerson(id, resolution.person);
        return;
      }
      if (resolution.kind === "candidates") {
        this.store.setRunCandidates(id, resolution.candidates);
        return;
      }
      this.store.setRunStatus(id, "failed", "person_not_found");
    } catch (error) {
      // Provider timeouts and errors (including a bad payload) all fail the run.
      // Only the run id and the category are logged — never the provider payload.
      const reason = error instanceof WikipediaError ? error.message : "unexpected error";
      logger.error("research_run_resolution_failed", { run_id: id, reason });
      this.store.setRunStatus(id, "failed", "provider_error");
    }
  }
}
