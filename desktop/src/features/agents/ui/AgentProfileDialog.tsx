import * as React from "react";
import { Activity } from "lucide-react";

import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import { useAgentWorking } from "@/features/agents/agentWorkingSignal";
import { getAgentPerformance } from "@/shared/api/tauriAgentPerformance";
import type { AgentPerformance } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { UserAvatar } from "@/shared/ui/UserAvatar";

/**
 * An agent's "coworker profile": identity + config now, and a performance card
 * (approval, cost, throughput) that fills in as the agent completes real work.
 * Styled to match the app's agent cards (rounded-2xl, border-border/70,
 * muted surfaces) rather than introducing a new look.
 */
export function AgentProfileDialog({
  avatarUrl,
  name,
  onOpenChange,
  onViewActivity,
  open,
  pubkey,
}: {
  avatarUrl: string | null;
  name: string;
  onOpenChange: (open: boolean) => void;
  onViewActivity: () => void;
  open: boolean;
  pubkey: string;
}): React.ReactElement {
  const { data: agents } = useManagedAgentsQuery();
  const { data: personas } = usePersonasQuery();
  const work = useAgentWorking(pubkey);
  const [perf, setPerf] = React.useState<AgentPerformance | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    setPerf(null);
    void getAgentPerformance(pubkey)
      .then((result) => {
        if (active) setPerf(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [open, pubkey]);

  const agent = React.useMemo(() => {
    const key = normalizePubkey(pubkey);
    return agents?.find((a) => normalizePubkey(a.pubkey) === key) ?? null;
  }, [agents, pubkey]);

  // Persona-linked agents leave model/provider/runtime null on the record and
  // inherit them from the persona — fall back so the card shows real config.
  const persona = React.useMemo(
    () =>
      agent?.personaId
        ? (personas?.find((p) => p.id === agent.personaId) ?? null)
        : null,
    [personas, agent?.personaId],
  );
  const model = agent?.model ?? persona?.model ?? "—";
  const provider = agent?.provider ?? persona?.provider ?? "—";
  const runtime = agent?.runtime ?? persona?.runtime ?? "—";

  const status: { label: string; tone: "working" | "available" | "idle" } =
    work.working
      ? { label: "Working now", tone: "working" }
      : agent?.status === "running"
        ? { label: "Available", tone: "available" }
        : { label: "Idle", tone: "idle" };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <UserAvatar avatarUrl={avatarUrl} displayName={name} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{name}</span>
              <StatusPill status={status} />
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Config */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Row label="Model" value={model} />
            <Row label="Provider" value={provider} />
            <Row label="Runtime" value={runtime} />
            <Row label="Tools" value={agent?.mcpCommand?.trim() || "default"} />
          </dl>

          {/* Performance card */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Performance
            </p>
            {perf && perf.turns > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Stat
                    label="Cost today"
                    value={`$${perf.costTodayUsd.toFixed(2)}`}
                  />
                  <Stat label="Tasks done" value={String(perf.tasks)} />
                  <Stat
                    label="Tokens"
                    value={formatCompact(perf.tokensTotal)}
                  />
                  <Stat label="Approval rate" value="—" />
                </div>
                <p className="mt-2 text-2xs text-muted-foreground/70">
                  From this agent's own signed turn metrics — real usage, never
                  estimated. Approval rate lands once approvals are wired.
                </p>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">No activity yet</p>
                <p className="mt-1 text-2xs text-muted-foreground/70">
                  Cost, tokens, and tasks appear here from this agent's signed
                  turn metrics once it works in the live workspace.
                </p>
              </div>
            )}
          </div>

          <Button className="w-full" onClick={onViewActivity}>
            <Activity className="h-4 w-4" />
            View activity
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Row({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground">
        {value}
      </dd>
    </>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/50 px-3 py-2.5">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="text-2xs text-muted-foreground">{label}</p>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: { label: string; tone: "working" | "available" | "idle" };
}): React.ReactElement {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex items-center gap-1.5 text-2xs font-normal",
        status.tone === "idle" ? "text-muted-foreground" : "text-emerald-600",
      )}
    >
      <span className="relative flex size-1.5 shrink-0">
        {status.tone === "working" ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex size-1.5 rounded-full",
            status.tone === "idle"
              ? "bg-muted-foreground/50"
              : "bg-emerald-500",
          )}
        />
      </span>
      {status.label}
    </span>
  );
}
