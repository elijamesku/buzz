import { invokeTauri } from "@/shared/api/tauri";
import type { SiteImportResult } from "@/shared/api/types";

/**
 * Import a website into a local workspace so agents can rebuild it as code.
 *
 * Performs a bounded, same-origin crawl of `url`: snapshots each page's HTML,
 * downloads referenced same-origin assets, and writes a MIGRATION.md brief to
 * `~/buzz-site-imports/<host>_<timestamp>/`. Does not execute page JavaScript.
 *
 * `maxPages` caps the crawl (default 12, hard max 50). Throws a string error on
 * failure (invalid/private URL, or no capturable pages).
 */
export async function importWebsite(
  url: string,
  maxPages?: number,
): Promise<SiteImportResult> {
  return invokeTauri<SiteImportResult>("import_website", {
    url,
    maxPages: maxPages ?? null,
  });
}
