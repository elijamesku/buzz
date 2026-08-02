import * as React from "react";
import { Check, Copy, Globe, PenTool, TriangleAlert } from "lucide-react";

import { importWebsite } from "@/shared/api/tauriSiteImport";
import type { SiteImportResult } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

type ImportPhase =
  | { kind: "idle" }
  | { kind: "importing" }
  | { kind: "done"; result: SiteImportResult }
  | { kind: "error"; message: string };

export function DesignSettingsPanel(): React.ReactElement {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="settings-design"
    >
      <SettingsSectionHeader
        title="Design"
        description="Bring a site into code so agents can rebuild and maintain it — the Claude design workflow."
      />
      <SiteImportCard />
    </section>
  );
}

function SiteImportCard(): React.ReactElement {
  const [url, setUrl] = React.useState("");
  const [phase, setPhase] = React.useState<ImportPhase>({ kind: "idle" });

  const runImport = async () => {
    const target = url.trim();
    if (!target) {
      setPhase({ kind: "error", message: "Enter a website URL to import." });
      return;
    }
    const normalized = /^https?:\/\//i.test(target)
      ? target
      : `https://${target}`;
    setPhase({ kind: "importing" });
    try {
      const result = await importWebsite(normalized);
      setPhase({ kind: "done", result });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const importing = phase.kind === "importing";

  return (
    <div className="rounded-xl border border-border/70 bg-card/40">
      <div className="flex items-start gap-4 p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <PenTool className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">
            Import a website
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste a site URL (e.g. your Webflow marketing site). Buzz renders
            each page in a headless browser — so JavaScript-driven navigation
            and content are captured — then snapshots the pages and assets into
            a local workspace an agent can rebuild as an Astro + Tailwind
            codebase. Install Chrome for the full click-through crawl.
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Globe className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Website URL"
                className="pl-8"
                value={url}
                placeholder="yourcompany.com"
                spellCheck={false}
                disabled={importing}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runImport();
                }}
              />
            </div>
            <Button disabled={importing} onClick={() => void runImport()}>
              {importing ? <Spinner size={14} /> : null}
              {importing ? "Importing…" : "Import site"}
            </Button>
          </div>

          {phase.kind === "error" ? (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4 shrink-0" />
              {phase.message}
            </p>
          ) : null}

          {phase.kind === "importing" ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Crawling {url.trim()} — capturing pages and assets…
            </p>
          ) : null}

          {phase.kind === "done" ? (
            <ImportSummary result={phase.result} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ImportSummary({
  result,
}: {
  result: SiteImportResult;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(result.destination);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — the path is shown for manual copy anyway.
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Check className="h-4 w-4 text-emerald-600" />
        Imported {result.host}
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Pages</dt>
        <dd className="text-foreground">{result.pages.length}</dd>
        <dt className="text-muted-foreground">Assets</dt>
        <dd className="text-foreground">{result.assetCount}</dd>
        <dt className="text-muted-foreground">Saved to</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono text-2xs text-foreground/80">
            {result.destination}
          </code>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy path"
            onClick={() => void copyPath()}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </dd>
      </dl>

      {result.pages.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {result.pages.length} page{result.pages.length === 1 ? "" : "s"}{" "}
            captured
          </summary>
          <ul className="mt-2 space-y-0.5">
            {result.pages.map((page) => (
              <li
                key={page.path}
                className="truncate font-mono text-2xs text-muted-foreground"
                title={page.url}
              >
                {page.path}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {result.warnings.length > 0 ? (
        <details className="text-sm">
          <summary
            className={cn("cursor-pointer text-amber-600 hover:text-amber-500")}
          >
            {result.warnings.length} warning
            {result.warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-0.5">
            {result.warnings.map((warning) => (
              <li
                key={warning}
                className="text-2xs leading-snug text-muted-foreground"
              >
                {warning}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="text-2xs text-muted-foreground">
        Next: hand this folder to an agent to rebuild the site as code. A{" "}
        <code className="font-mono">MIGRATION.md</code> brief is included.
      </p>
    </div>
  );
}
