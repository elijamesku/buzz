import * as React from "react";
import { ChevronRight } from "lucide-react";

import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import type { AgentPersona, ManagedAgent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { UserAvatar } from "@/shared/ui/UserAvatar";

/**
 * One-line "what I do / when to bring me in" blurbs for the built-in team,
 * keyed by the lowercased persona (or agent) name. Custom agents fall back to
 * the first sentence of their system prompt, so the roster is always populated
 * without needing per-persona description plumbing on the backend.
 */
const TEAM_TAGLINES: Record<string, string> = {
  fizz: "Hosts your team — gets you oriented, plans work, and brings the right agent in.",
  honey: "Writing & organizing — clarifies, summarizes, and helps ideas land.",
  bumble:
    "Research — digs into questions, compares options, and cites sources.",
};

type RosterEntry = {
  pubkey: string;
  name: string;
  avatarUrl: string | null;
  tagline: string | null;
};

function firstSentence(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^.*?[.!?](\s|$)/);
  const sentence = (match ? match[0] : trimmed).trim();
  return sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence;
}

function buildRoster(
  agents: ManagedAgent[],
  personas: AgentPersona[],
): RosterEntry[] {
  const personaById = new Map(personas.map((persona) => [persona.id, persona]));
  return agents
    .map((agent) => {
      const persona = agent.personaId
        ? personaById.get(agent.personaId)
        : undefined;
      const personaKey = persona?.displayName?.toLowerCase();
      const nameKey = agent.name.toLowerCase();
      const tagline =
        (personaKey ? TEAM_TAGLINES[personaKey] : undefined) ??
        TEAM_TAGLINES[nameKey] ??
        firstSentence(agent.systemPrompt) ??
        null;
      return {
        pubkey: agent.pubkey,
        name: agent.name,
        avatarUrl: agent.avatarUrl ?? persona?.avatarUrl ?? null,
        tagline,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Always-visible "Your team" roster for the sidebar: each managed agent with
 * its avatar, name, and a one-line reminder of what it's for — so the team's
 * roles are a glance away instead of buried in the welcome thread.
 */
export function TeamRosterSection(): React.ReactElement | null {
  const { data: agents } = useManagedAgentsQuery();
  const { data: personas } = usePersonasQuery();
  const [collapsed, setCollapsed] = React.useState(false);

  const roster = React.useMemo(
    () => buildRoster(agents ?? [], personas ?? []),
    [agents, personas],
  );

  if (roster.length === 0) return null;

  return (
    <div className="group/team mt-1 px-2" data-testid="sidebar-team-roster">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-2xs font-semibold uppercase tracking-wide text-sidebar-foreground/60 transition-colors hover:text-sidebar-foreground"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            !collapsed && "rotate-90",
          )}
        />
        Your team
      </button>

      {!collapsed ? (
        <ul className="mt-0.5 space-y-0.5">
          {roster.map((entry) => (
            <li key={entry.pubkey}>
              <div className="flex items-start gap-2 rounded-md px-1.5 py-1.5">
                <UserAvatar
                  avatarUrl={entry.avatarUrl}
                  displayName={entry.name}
                  size="sm"
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-sidebar-foreground">
                    {entry.name}
                  </p>
                  {entry.tagline ? (
                    <p
                      className="mt-0.5 line-clamp-2 text-2xs leading-snug text-sidebar-foreground/60"
                      title={entry.tagline}
                    >
                      {entry.tagline}
                    </p>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
