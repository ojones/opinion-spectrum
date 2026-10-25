# Intake

Source: https://github.com/ojones/ai-factory/issues/153
Cost cap: $2.00 (default)

## Spec

Build the first slice of a Public Figure Statements Service: an API where a caller starts a "research run" for a public figure and a question, and the service resolves who the figure is on Wikipedia. This release records and resolves runs only. Later releases (listed at the end) add discovery, extraction, search and review on top, so keep the persistence and provider code behind small modules those releases can extend.

**Why it exists.** The whole service records evidence-backed candidate statements by public figures, never definitive beliefs. Nothing in this release extracts or presents any statement.

**Stack and constraints.**
- The Factory's Express + TypeScript backend starter, one container, free npm dependencies only. API only: no UI in this release, leave the React frontend as it is.
- Storage is SQLite through Node's built-in `node:sqlite` (no database server and no native npm dependency), reached only through one persistence module so it can move to PostgreSQL later. Ids are UUIDs, timestamps are UTC ISO-8601, and the schema is created by additive migrations that run at startup.
- The database file lives under `DATA_DIR` (`/data`, the app's Fly volume) via `dataPath("statements.db")`, so it survives deploys and restarts. The app runs as one instance; do not design for several instances sharing the file.
- Wikipedia is the only external service. Its client sends a descriptive User-Agent, has a 10 second timeout, and sits behind an interface. Tests and local development use a fake Wikipedia client; no test may use the network.

**Requirements.**
1. Every `/v1` route requires `Authorization: Bearer <key>`, compared with the secret `STATEMENTS_API_KEY` (the owner sets its value). A missing or wrong key returns 401. The existing `/health` route stays open and unchanged.
2. `POST /v1/research-runs` takes `{"person": "Jane Doe", "question": "What has she said about nuclear energy?"}`. `person` and `question` are required, non-blank strings of at most 200 and 500 characters; anything else returns 422 with the error shape below. It stores the run and returns `202` with `{"id": "...", "status": "queued", "status_url": "/v1/research-runs/..."}`.
3. `GET /v1/research-runs/{id}` returns `id`, `status`, `person_query`, `question`, the resolved person (or null), the candidates while the status is `needs_disambiguation`, `counts` (all zero in this release), `warnings`, `error_category` when failed, and `created_at` / `updated_at`. An unknown id returns 404. It never returns provider payloads.
4. After the run is created, the service resolves the person in the background of the same process through the MediaWiki search API. One clear match (exactly one result, or a top result whose title equals the query ignoring case while no other result does) stores a `people` record (`canonical_name`, `description`, `wikipedia_page_id`, `wikipedia_url`, aliases from redirects where the API gives them) and the run becomes `completed`.
5. Several plausible matches put the run in `needs_disambiguation` and keep the candidates (page id, title, short description, URL). `POST /v1/research-runs/{id}/person` with `{"wikipedia_page_id": 123}` selects one of those candidates, stores the person and completes the run. A page id that is not one of the candidates returns 422, and a run that is not waiting returns 409.
6. No match makes the run `failed` with `error_category: "person_not_found"`. A Wikipedia timeout or error makes it `failed` with `"provider_error"` (retries come in a later release).
7. Errors use one shape everywhere: `{"error": {"code": "...", "message": "..."}}` with stable codes (`unauthorized`, `invalid_request`, `not_found`, `invalid_state`).
8. A person is never identified by name alone: two people with the same name but different `wikipedia_page_id` are two records.

**Run states** are `queued`, `running`, `needs_disambiguation`, `completed`, `failed`. (`completed_with_warnings` arrives later.) In this release a run ends after person resolution.

**Secrets.** `STATEMENTS_API_KEY`, read by the backend and never logged or returned.

**Out of scope.** Discovery of source articles, fetching article text, any model call, statements, search, review, retries, replay, idempotency keys, rate limiting, API key management, a UI, web search beyond Wikipedia, a hosted database, backups beyond Fly's daily volume snapshots, running more than one instance.

**Decisions already made.** Wikipedia is the only source; SQLite is the store; one shared API key; no web search provider. Do not ask about these.
