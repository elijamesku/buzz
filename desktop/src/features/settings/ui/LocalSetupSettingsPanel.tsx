import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CheckCircle2,
  Circle,
  Download,
  Server,
  TriangleAlert,
} from "lucide-react";

import {
  localStackStatus,
  startLocalServices,
} from "@/shared/api/tauriLocalStack";
import type { LocalStackStatus } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

const DOCKER_URL = "https://www.docker.com/products/docker-desktop/";

/**
 * Runs the local relay backend from buttons instead of terminal commands — a
 * live checklist (Docker installed → running → services → relay) with a one-
 * click "Start services". For a source checkout; a packaged app points people
 * to a hosted relay instead.
 */
export function LocalSetupSettingsPanel(): React.ReactElement {
  const [status, setStatus] = React.useState<LocalStackStatus | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await localStackStatus());
    } catch {
      // Leave prior status; the checklist just won't advance.
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const startServices = async () => {
    setStarting(true);
    setError(null);
    try {
      setStatus(await startLocalServices());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="settings-local-setup"
    >
      <SettingsSectionHeader
        title="Local setup"
        description="Run your own Buzz relay from here — no terminal required."
      />

      {status && !status.repoAvailable ? (
        <div className="rounded-2xl border border-border/70 bg-muted/40 p-5 text-sm text-muted-foreground">
          This build has no source checkout, so it can't run its own relay.
          That's fine —{" "}
          <span className="text-foreground">join a hosted community</span>{" "}
          instead and you're up in seconds, no Docker needed.
        </div>
      ) : (
        <div className="rounded-2xl border border-border/70 bg-card/40">
          <div className="flex items-start gap-4 p-5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
              <Server className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold text-foreground">
                Local relay
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Buzz's relay needs Postgres + Redis, which run in Docker. Get
                Docker running, then start the services with one click.
              </p>

              <ol className="mt-4 space-y-2.5">
                <Step
                  done={!!status?.dockerInstalled}
                  label="Docker installed"
                  action={
                    status && !status.dockerInstalled ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void openUrl(DOCKER_URL)}
                      >
                        <Download className="h-4 w-4" />
                        Get Docker
                      </Button>
                    ) : null
                  }
                />
                <Step
                  done={!!status?.dockerRunning}
                  label="Docker running"
                  hint={
                    status?.dockerInstalled && !status.dockerRunning
                      ? "Open Docker Desktop and wait for it to start."
                      : undefined
                  }
                />
                <Step
                  done={!!status?.servicesUp}
                  label="Postgres + Redis running"
                  action={
                    status?.dockerRunning && !status.servicesUp ? (
                      <Button
                        size="sm"
                        disabled={starting}
                        onClick={() => void startServices()}
                      >
                        {starting ? <Spinner size={14} /> : null}
                        {starting ? "Starting…" : "Start services"}
                      </Button>
                    ) : null
                  }
                />
                <Step
                  done={!!status?.relayReachable}
                  label="Relay online"
                  hint={
                    status?.servicesUp && !status.relayReachable
                      ? "Services are up — launch the relay from the app menu (or `just dev`)."
                      : undefined
                  }
                />
              </ol>

              {error ? (
                <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
                  <TriangleAlert className="h-4 w-4 shrink-0" />
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Step({
  action,
  done,
  hint,
  label,
}: {
  action?: React.ReactNode;
  done: boolean;
  hint?: string;
  label: string;
}): React.ReactElement {
  return (
    <li className="flex items-center gap-3">
      {done ? (
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
      ) : (
        <Circle className="h-5 w-5 shrink-0 text-muted-foreground/40" />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm",
            done ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          {label}
        </p>
        {hint ? (
          <p className="text-2xs text-muted-foreground/70">{hint}</p>
        ) : null}
      </div>
      {action}
    </li>
  );
}
