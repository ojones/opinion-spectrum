import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPath } from "../data-dir";
import { StatementsServiceImpl, type StatementsService } from "./service";
import { StatementsStore } from "./store";
import { MediaWikiClient } from "./wikipedia";

let service: StatementsService | null = null;

/**
 * The app's single service instance. The SQLite file is opened lazily on the
 * first /v1 request, so an instance with the feature off never creates it.
 */
export function getStatementsService(): StatementsService {
  if (service) return service;

  const file = dataPath("statements.db");
  mkdirSync(path.dirname(file), { recursive: true });
  const store = new StatementsStore(new DatabaseSync(file));
  service = new StatementsServiceImpl(store, new MediaWikiClient());
  return service;
}
