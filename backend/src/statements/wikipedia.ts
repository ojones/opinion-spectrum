export interface WikipediaResult {
  pageid: number;
  title: string;
  description: string;
  url: string;
  aliases: string[];
}

/** Provider failures (timeout, HTTP error, bad payload) become provider_error. */
export class WikipediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WikipediaError";
  }
}

export interface WikipediaClient {
  search(query: string): Promise<WikipediaResult[]>;
}

const USER_AGENT = "opinion-spectrum/1.0 (statements service; contact: app owner)";
const TIMEOUT_MS = 10_000;

/** Parses one MediaWiki `query.search` entry, dropping entries without a page id. */
function toResult(raw: unknown): WikipediaResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const item = raw as Record<string, unknown>;
  const pageid = typeof item.pageid === "number" ? item.pageid : null;
  const title = typeof item.title === "string" ? item.title : null;
  if (pageid === null || title === null) return null;
  const description = typeof item.snippet === "string" ? stripHtml(item.snippet) : "";
  const aliases = Array.isArray(item.redirects)
    ? item.redirects.map((r) => (r as Record<string, unknown>).title).filter((t): t is string => typeof t === "string")
    : [];
  return {
    pageid,
    title,
    description,
    url: `https://en.wikipedia.org/?curid=${pageid}`,
    aliases,
  };
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * The real MediaWiki search client. The only external service in this release;
 * it sits behind WikipediaClient so tests and local runs use a fake.
 */
export class MediaWikiClient implements WikipediaClient {
  private readonly baseUrl: string;

  constructor(baseUrl = "https://en.wikipedia.org/w/api.php") {
    this.baseUrl = baseUrl;
  }

  async search(query: string): Promise<WikipediaResult[]> {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: "10",
      format: "json",
      origin: "*",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl}?${params.toString()}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new WikipediaError(`Wikipedia responded with ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      const queryBlock = body.query as Record<string, unknown> | undefined;
      const search = Array.isArray(queryBlock?.search) ? (queryBlock?.search as unknown[]) : [];
      return search.map(toResult).filter((r): r is WikipediaResult => r !== null);
    } catch (error) {
      if (error instanceof WikipediaError) throw error;
      throw new WikipediaError(error instanceof Error ? error.message : "Wikipedia request failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
