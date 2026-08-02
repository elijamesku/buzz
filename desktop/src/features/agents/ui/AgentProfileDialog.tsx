import * as React from "react";
import { Activity } from "lucide-react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useAgentWorking } from "@/features/agents/agentWorkingSignal";
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
  const work = useAgentWorking(pubkey);

  const agent = React.useMemo(() => {
    const key = normalizePubkey(pubkey);
    return agents?.find((a) => normalizePubkey(a.pubkey) === key) ?? null;
  }, [agents, pubkey]);

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
            <Row label="Model" value={agent?.model ?? "—"} />
            <Row label="Provider" value={agent?.provider ?? "—"} />
            <Row label="Runtime" value={agent?.runtime ?? "—"} />
            <Row label="Tools" value={agent?.mcpCommand?.trim() || "default"} />
          </dl>

          {/* Performance card */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Performance
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Approval rate" value="—" />
              <Stat label="Cost today" value="—" />
              <Stat label="Tasks done" value="—" />
              <Stat label="Avg response" value="—" />
            </div>
            <p className="mt-2 text-2xs text-muted-foreground/70">
              Fills in as this agent completes work in the live workspace.
            </p>
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
