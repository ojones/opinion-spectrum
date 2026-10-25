import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../app";
import { StatementsStore } from "../statements/store";
import { StatementsServiceImpl, type StatementsService } from "../statements/service";
import type { RunRecord } from "../statements/store";
import { WikipediaError, type WikipediaClient, type WikipediaResult } from "../statements/wikipedia";
import { withFlag } from "./with-flag";

const KEY = "test-statements-key";
const AUTH = `Bearer ${KEY}`;

function result(overrides: Partial<WikipediaResult> = {}): WikipediaResult {
  return {
    pageid: 101,
    title: "Ada Lovelace",
    description: "English mathematician",
    url: "https://en.wikipedia.org/?curid=101",
    aliases: [],
    ...overrides,
  };
}

class FakeWikipedia implements WikipediaClient {
  handler: (query: string) => Promise<WikipediaResult[]> = async () => [];
  search(query: string): Promise<WikipediaResult[]> {
    return this.handler(query);
  }
}

function makeService(): { service: StatementsService; wikipedia: FakeWikipedia } {
  const wikipedia = new FakeWikipedia();
  const store = new StatementsStore(new DatabaseSync(":memory:"));
  return { service: new StatementsServiceImpl(store, wikipedia), wikipedia };
}

/** Polls until the background resolution settles the run. */
async function waitForRun(service: StatementsService, id: string): Promise<RunRecord> {
  for (let i = 0; i < 200; i += 1) {
    const run = service.getRun(id);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${id} never settled`);
}

const RUN_KEYS = [
  "candidates",
  "counts",
  "created_at",
  "error_category",
  "id",
  "person",
  "person_query",
  "question",
  "status",
  "updated_at",
  "warnings",
];

beforeAll(() => {
  process.env.STATEMENTS_API_KEY = KEY;
});

afterAll(() => {
  delete process.env.STATEMENTS_API_KEY;
});

describe("flag gating", () => {
  it("leaves /v1 unmounted when the flag is off", async () => {
    const { service } = makeService();
    await withFlag("issue-158", false, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app)
        .post("/v1/research-runs")
        .set("authorization", AUTH)
        .send({ person: "Ada Lovelace", question: "What did she publish?" });
      expect(res.status).toBe(404);
    });
  });

  it("serves /v1 when the flag is on", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app).get("/v1/research-runs/unknown").set("authorization", AUTH);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    });
  });
});

describe("authorization", () => {
  it("returns 401 without an Authorization header", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app).post("/v1/research-runs").send({ person: "a", question: "b" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });
  });

  it("returns 401 with a wrong key", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app).get("/v1/research-runs/x").set("authorization", "Bearer nope");
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("unauthorized");
    });
  });

  it("fails closed with 401 when STATEMENTS_API_KEY is unset", async () => {
    const { service } = makeService();
    const saved = process.env.STATEMENTS_API_KEY;
    delete process.env.STATEMENTS_API_KEY;
    try {
      await withFlag("issue-158", true, async () => {
        const app = createApp({ statementsService: service });
        const res = await request(app).get("/v1/research-runs/x").set("authorization", "Bearer any-value");
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("unauthorized");
      });
    } finally {
      process.env.STATEMENTS_API_KEY = saved;
    }
  });

  it("never logs or returns the API key", async () => {
    const { service, wikipedia } = makeService();
    wikipedia.handler = async () => [result()];
    await withFlag("issue-158", true, async () => {
      const logged: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
      try {
        const app = createApp({ statementsService: service });
        const res = await request(app)
          .post("/v1/research-runs")
          .set("authorization", AUTH)
          .send({ person: "Ada Lovelace", question: "What did she publish?" });
        await waitForRun(service, res.body.id);
        expect(res.text).not.toContain(KEY);
        expect(logged.length).toBeGreaterThan(0);
        for (const line of logged) {
          expect(line).not.toContain(KEY);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("keeps /health open, without a key", async () => {
    await withFlag("issue-158", true, async () => {
      const app = createApp();
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  it("keeps /api/health open", async () => {
    await withFlag("issue-158", true, async () => {
      const app = createApp();
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });
});

describe("POST /v1/research-runs", () => {
  it("rejects missing fields with 422", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app).post("/v1/research-runs").set("authorization", AUTH).send({});
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: { code: "invalid_request", message: expect.any(String) } });
    });
  });

  it("rejects overlong strings with 422", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app)
        .post("/v1/research-runs")
        .set("authorization", AUTH)
        .send({ person: "x".repeat(201), question: "ok?" });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("invalid_request");
    });
  });

  it("accepts a valid request with 202 and the run envelope", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app)
        .post("/v1/research-runs")
        .set("authorization", AUTH)
        .send({ person: "Ada Lovelace", question: "What did she publish?" });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        id: expect.any(String),
        status: "queued",
        status_url: `/v1/research-runs/${res.body.id}`,
      });
    });
  });
});

describe("GET /v1/research-runs/:id", () => {
  it("returns 404 for an unknown id", async () => {
    const { service } = makeService();
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const res = await request(app).get("/v1/research-runs/does-not-exist").set("authorization", AUTH);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("not_found");
    });
  });

  it("returns the run fields and never a provider payload", async () => {
    const { service, wikipedia } = makeService();
    wikipedia.handler = async () => [result()];
    await withFlag("issue-158", true, async () => {
      const app = createApp({ statementsService: service });
      const created = await request(app)
        .post("/v1/research-runs")
        .set("authorization", AUTH)
        .send({ person: "Ada Lovelace", question: "What did she publish?" });
      await waitForRun(service, created.body.id);

      const res = await request(app).get(`/v1/research-runs/${created.body.id}`).set("authorization", AUTH);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(RUN_KEYS);
      expect(res.body.status).toBe("completed");
      expect(res.body.person_query).toBe("Ada Lovelace");
      expect(res.body.question).toBe("What did she publish?");
      expect(JSON.stringify(res.body)).not.toContain("snippet");
    });
  });
});

describe("person resolution", () => {
  it("stores the person and completes the run on a single clear match", async () => {
    const { service, wikipedia } = makeService();
    wikipedia.handler = async () => [result()];
    const run = service.createRun("Ada Lovelace", "What did she publish?");

    const settled = await waitForRun(service, run.id);
    expect(settled.status).toBe("completed");
    expect(settled.person).toMatchObject({
      canonical_name: "Ada Lovelace",
      wikipedia_page_id: 101,
      wikipedia_url: "https://en.wikipedia.org/?curid=101",
    });
    expect(settled.person?.id).toEqual(expect.any(String));
  });

  it("fails with person_not_found when Wikipedia has no results", async () => {
    const { service, wikipedia } = makeService();
    wikipedia.handler = async () => [];
    const run = service.createRun("Nobody Here", "Anything?");

    const settled = await waitForRun(service, run.id);
    expect(settled.status).toBe("failed");
    expect(settled.errorCategory).toBe("person_not_found");
  });

  it("fails with provider_error when the provider times out", async () => {
    const { service, wikipedia } = makeService();
    wikipedia.handler = async () => {
      throw new WikipediaError("request aborted");
    };
    const run = service.createRun("Ada Lovelace", "What did she publish?");

    const settled = await waitForRun(service, run.id);
    expect(settled.status).toBe("failed");
    expect(settled.errorCategory).toBe("provider_error");
  });
});

describe("POST /v1/research-runs/:id/person", () => {
  async function disambiguatingRun(): Promise<{
    app: ReturnType<typeof createApp>;
    service: StatementsService;
    id: string;
  }> {
    const { service, wikipedia } = makeService();
    wikipedia.handler = async () => [
      result({ pageid: 1, title: "Jane Smith" }),
      result({ pageid: 2, title: "Jane Smith (politician)" }),
    ];
    const app = createApp({ statementsService: service });
    const created = await request(app)
      .post("/v1/research-runs")
      .set("authorization", AUTH)
      .send({ person: "Jane Smith", question: "What did she say?" });
    await waitForRun(service, created.body.id);
    return { app, service, id: created.body.id };
  }

  it("lists candidates and completes the run when one is chosen", async () => {
    await withFlag("issue-158", true, async () => {
      const { app, id } = await disambiguatingRun();

      const before = await request(app).get(`/v1/research-runs/${id}`).set("authorization", AUTH);
      expect(before.body.status).toBe("needs_disambiguation");
      expect(before.body.candidates).toEqual([
        { wikipedia_page_id: 1, title: "Jane Smith", description: expect.any(String), url: expect.any(String) },
        {
          wikipedia_page_id: 2,
          title: "Jane Smith (politician)",
          description: expect.any(String),
          url: expect.any(String),
        },
      ]);

      const chosen = await request(app)
        .post(`/v1/research-runs/${id}/person`)
        .set("authorization", AUTH)
        .send({ wikipedia_page_id: 2 });
      expect(chosen.status).toBe(200);
      expect(chosen.body.status).toBe("completed");
      expect(chosen.body.person).toMatchObject({ wikipedia_page_id: 2, canonical_name: "Jane Smith (politician)" });
      expect(chosen.body.candidates).toEqual([]);
    });
  });

  it("rejects an unknown page id with 422", async () => {
    await withFlag("issue-158", true, async () => {
      const { app, id } = await disambiguatingRun();
      const res = await request(app)
        .post(`/v1/research-runs/${id}/person`)
        .set("authorization", AUTH)
        .send({ wikipedia_page_id: 999 });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("invalid_request");
    });
  });

  it("returns 409 when the run is not awaiting disambiguation", async () => {
    await withFlag("issue-158", true, async () => {
      const { app, id } = await disambiguatingRun();
      await request(app)
        .post(`/v1/research-runs/${id}/person`)
        .set("authorization", AUTH)
        .send({ wikipedia_page_id: 1 });

      const res = await request(app)
        .post(`/v1/research-runs/${id}/person`)
        .set("authorization", AUTH)
        .send({ wikipedia_page_id: 2 });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("invalid_state");
    });
  });
});
