import * as React from "react";
import { Hash, X } from "lucide-react";

import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import {
  getAgentWorkingState,
  subscribeAgentWorkingSignal,
  useAgentWorking,
  useWorkingChannels,
} from "@/features/agents/agentWorkingSignal";
import { AgentProfileDialog } from "@/features/agents/ui/AgentProfileDialog";
import { useChannelsQuery } from "@/features/channels/hooks";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

type Entry = { pubkey: string; name: string; avatarUrl: string | null };

function buildRoster(
  agents: ManagedAgent[],
  personas: AgentPersona[],
): Entry[] {
  const personaById = new Map(personas.map((p) => [p.id, p]));
  return agents
    .map((agent) => {
      const persona = agent.personaId
        ? personaById.get(agent.personaId)
        : undefined;
      return {
        pubkey: agent.pubkey,
        name: agent.name,
        avatarUrl: agent.avatarUrl ?? persona?.avatarUrl ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The living-org view: every agent on one screen, pulsing when it's working.
 * Runs on the live agent-working signal, so the room feels alive as agents
 * pick up and finish work. Click any agent to open its profile.
 */
export function WorkforcePulseScreen({
  onClose,
}: {
  onClose: () => void;
}): React.ReactElement {
  const { data: agents } = useManagedAgentsQuery();
  const { data: personas } = usePersonasQuery();
  const { data: channels } = useChannelsQuery();
  const workingChannels = useWorkingChannels();
  const [selected, setSelected] = React.useState<Entry | null>(null);

  const channelNameById = React.useMemo(
    () => new Map((channels ?? []).map((c) => [c.id, c.name])),
    [channels],
  );

  const roster = React.useMemo(
    () => buildRoster(agents ?? [], personas ?? []),
    [agents, personas],
  );
  const pubkeys = React.useMemo(() => roster.map((r) => r.pubkey), [roster]);

  const workingCount = React.useSyncExternalStore(
    subscribeAgentWorkingSignal,
    () => pubkeys.filter((pk) => getAgentWorkingState(pk).working).length,
  );

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
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-foreground">Workforce</h1>
          <p className="text-sm text-muted-foreground">
            <span className="text-emerald-600">{workingCount} working now</span>
            {" · "}
            {roster.length} {roster.length === 1 ? "agent" : "agents"}
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

      <div className="flex-1 px-6 py-6">
        {workingChannels.length > 0 ? (
          <div className="mb-6">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Active rooms
            </p>
            <div className="flex flex-wrap gap-2">
              {workingChannels.map((room) => (
                <div
                  key={room.channelId}
                  className="flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-3 py-1.5 text-sm"
                >
                  <Hash className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  <span className="font-medium text-foreground">
                    {channelNameById.get(room.channelId) ?? "room"}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {(room.agentNames ?? []).join(", ") ||
                      `${room.agentCount} working`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agents yet. Add a team and they'll show up here, live.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {roster.map((entry) => (
              <PulseCard
                key={entry.pubkey}
                entry={entry}
                onOpen={() => setSelected(entry)}
              />
            ))}
          </div>
        )}
      </div>

      {selected ? (
        <AgentProfileDialog
          avatarUrl={selected.avatarUrl}
          name={selected.name}
          onOpenChange={(open) => !open && setSelected(null)}
          onViewActivity={() => setSelected(null)}
          open={true}
          pubkey={selected.pubkey}
        />
      ) : null}
    </div>
  );
}

function PulseCard({
  entry,
  onOpen,
}: {
  entry: Entry;
  onOpen: () => void;
}): React.ReactElement {
  const work = useAgentWorking(entry.pubkey);
  const working = work.working;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex flex-col items-center gap-3 rounded-2xl border p-5 text-center transition-colors",
        working
          ? "border-emerald-500/40 bg-emerald-500/5"
          : "border-border/70 bg-muted/50 hover:bg-muted/65",
      )}
      data-testid={`workforce-pulse-${entry.pubkey}`}
    >
      <span className="relative">
        {working ? (
          <span className="absolute -inset-1 animate-ping rounded-full bg-emerald-500/25" />
        ) : null}
        <UserAvatar
          avatarUrl={entry.avatarUrl}
          displayName={entry.name}
          size="md"
          className={cn("relative", working && "ring-2 ring-emerald-500/60")}
        />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {entry.name}
        </span>
        <span
          className={cn(
            "mt-0.5 block text-2xs",
            working ? "text-emerald-600" : "text-muted-foreground",
          )}
        >
          {working ? "Working…" : "Available"}
        </span>
      </span>
    </button>
  );
}
