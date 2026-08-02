import * as React from "react";
import {
  Check,
  Copy,
  GitFork,
  Globe,
  PenTool,
  TriangleAlert,
  X,
} from "lucide-react";

import { cloneDesignRepo } from "@/shared/api/tauriDesignWorkspace";
import { importWebsite } from "@/shared/api/tauriSiteImport";
import type { DesignRepoResult, SiteImportResult } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";

type RepoPhase =
  | { kind: "idle" }
  | { kind: "cloning" }
  | { kind: "done"; result: DesignRepoResult }
  | { kind: "error"; message: string };

type UrlPhase =
  | { kind: "idle" }
  | { kind: "importing" }
  | { kind: "done"; result: SiteImportResult }
  | { kind: "error"; message: string };

/**
 * Full-screen "Claude design" workspace: connect a frontend repo (the
 * identical-match source that agents rebuild from) or, as a fallback for sites
 * with no repo, import from a live URL.
 */
export function DesignWorkspaceScreen({
  onClose,
}: {
  onClose: () => void;
}): React.ReactElement {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/95 px-6 py-4 backdrop-blur">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <PenTool className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-foreground">Design</h1>
          <p className="text-sm text-muted-foreground">
            Point agents at your frontend and let them build — the Claude design
            workflow.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>
      </header>

      <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-6 py-8">
        <ConnectRepoCard />
        <ImportUrlCard />
      </div>
    </div>
  );
}

function ConnectRepoCard(): React.ReactElement {
  const [repo, setRepo] = React.useState("");
  const [phase, setPhase] = React.useState<RepoPhase>({ kind: "idle" });

  const connect = async () => {
    const target = repo.trim();
    if (!target) {
      setPhase({ kind: "error", message: "Enter a repo (owner/repo or URL)." });
      return;
    }
    setPhase({ kind: "cloning" });
    try {
      setPhase({ kind: "done", result: await cloneDesignRepo(target) });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const cloning = phase.kind === "cloning";

  return (
    <div className="rounded-xl border border-border/70 bg-card/40 p-5">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <GitFork className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">
            Connect your frontend repo
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            The real source is the identical-match input. Buzz clones it with
            your GitHub connection (private repos work automatically), and
            agents rebuild and maintain it from there.
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <GitFork className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Frontend repository"
                className="pl-8"
                value={repo}
                placeholder="owner/repo  or  github.com/owner/repo"
                spellCheck={false}
                disabled={cloning}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void connect();
                }}
              />
            </div>
            <Button disabled={cloning} onClick={() => void connect()}>
              {cloning ? <Spinner size={14} /> : null}
              {cloning ? "Cloning…" : "Connect repo"}
            </Button>
          </div>

          {phase.kind === "error" ? (
            <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4 shrink-0" />
              {phase.message}
            </p>
          ) : null}

          {phase.kind === "done" ? <RepoSummary result={phase.result} /> : null}
        </div>
      </div>
    </div>
  );
}

function RepoSummary({
  result,
}: {
  result: DesignRepoResult;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(result.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Path is shown for manual copy.
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Check className="h-4 w-4 text-emerald-600" />
        {result.cloned ? "Cloned" : "Connected"} {result.owner}/{result.repo}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Framework</dt>
        <dd className="text-foreground">{result.framework ?? "unknown"}</dd>
        <dt className="text-muted-foreground">Branch</dt>
        <dd className="text-foreground">{result.branch ?? "—"}</dd>
        <dt className="text-muted-foreground">Auth</dt>
        <dd className="text-foreground">
          {result.authenticated
            ? "GitHub connector token"
            : "public (no token)"}
        </dd>
        <dt className="text-muted-foreground">Path</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded bg-background px-1.5 py-0.5 font-mono text-2xs text-foreground/80">
            {result.path}
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
      <p className="text-2xs text-muted-foreground">
        Next: a design agent works this repo — reads the components and tokens,
        makes changes on a branch, and opens a PR. (Agent execution runs where
        buzz agents run; not in the standalone preview.)
      </p>
    </div>
  );
}

function ImportUrlCard(): React.ReactElement {
  const [url, setUrl] = React.useState("");
  const [phase, setPhase] = React.useState<UrlPhase>({ kind: "idle" });

  const runImport = async () => {
    const target = url.trim();
    if (!target) {
      setPhase({ kind: "error", message: "Enter a website URL." });
      return;
    }
    const normalized = /^https?:\/\//i.test(target)
      ? target
      : `https://${target}`;
    setPhase({ kind: "importing" });
    try {
      setPhase({ kind: "done", result: await importWebsite(normalized) });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const importing = phase.kind === "importing";

  return (
    <details className="rounded-xl border border-border/70 bg-card/40 p-5">
      <summary className="flex cursor-pointer items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Globe className="h-6 w-6" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold text-foreground">
            No repo? Import from a live URL
          </span>
          <span className="mt-1 block text-sm text-muted-foreground">
            Fallback for sites with no source (e.g. Webflow). Buzz renders the
            site in a headless browser and captures its pages and assets for an
            agent to rebuild.
          </span>
        </span>
      </summary>

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
        <Button
          variant="outline"
          disabled={importing}
          onClick={() => void runImport()}
        >
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
      {phase.kind === "done" ? (
        <p className="mt-3 text-sm text-foreground">
          Captured {phase.result.pages.length} page
          {phase.result.pages.length === 1 ? "" : "s"} and{" "}
          {phase.result.assetCount} assets to{" "}
          <code className="font-mono text-2xs text-foreground/80">
            {phase.result.destination}
          </code>
          .
        </p>
      ) : null}
    </details>
  );
}
