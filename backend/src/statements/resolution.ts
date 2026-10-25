import type { Candidate, PersonInput } from "./store";
import type { WikipediaResult } from "./wikipedia";

export type Resolution =
  { kind: "person"; person: PersonInput } | { kind: "candidates"; candidates: Candidate[] } | { kind: "none" };

function toCandidate(result: WikipediaResult): Candidate {
  return {
    wikipedia_page_id: result.pageid,
    title: result.title,
    description: result.description,
    url: result.url,
  };
}

function toPerson(result: WikipediaResult): PersonInput {
  return {
    canonicalName: result.title,
    description: result.description,
    wikipediaPageId: result.pageid,
    wikipediaUrl: result.url,
    aliases: result.aliases,
  };
}

/**
 * Decides who a search names. One result is a clear match, several are
 * ambiguous and become candidates for the caller to choose from, none is a
 * miss. This release does not guess between candidates.
 */
export function resolvePerson(results: WikipediaResult[]): Resolution {
  if (results.length === 0) return { kind: "none" };
  if (results.length === 1) return { kind: "person", person: toPerson(results[0]) };
  return { kind: "candidates", candidates: results.map(toCandidate) };
}
