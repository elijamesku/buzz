import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Pause, Play } from "lucide-react";

import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useChannelsQuery } from "@/features/channels/hooks";
import {
  bucketActivity,
  describeKind,
  reconstructAt,
  type OrgSnapshot,
} from "@/features/time-machine/lib/reconstruct";
import { getOrgTimeline } from "@/shared/api/tauriTimeMachine";
import type { TimelineEvent } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { UserAvatar } from "@/shared/ui/UserAvatar";

type RangeKey = "24h" | "7d" | "30d";

const RANGES: { key: RangeKey; label: string; seconds: number }[] = [
  { key: "24h", label: "24 hours", seconds: 24 * 60 * 60 },
  { key: "7d", label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { key: "30d", label: "30 days", seconds: 30 * 24 * 60 * 60 },
];
const BUCKETS = 72;
const SWEEP_MS = 30_000;
const TICK_MS = 50;
const FEED_ROWS = 40;

type Named = { name: string; avatarUrl: string | null };

function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 6)}…${pubkey.slice(-4)}`;
}

function formatInstant(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatClock(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeTo(unixSeconds: number, at: number): string {
  const delta = Math.max(0, at - unixSeconds);
  if (delta < 60) return "just now";
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

/**
 * The org's history as a scrubbable, replayable timeline. Every event is
 * signed, so the state at any instant is reconstructed, never guessed.
 */
export function TimeMachineScreen(): React.ReactElement {
  const [rangeKey, setRangeKey] = React.useState<RangeKey>("24h");
  const [until, setUntil] = React.useState(() => Math.floor(Date.now() / 1000));
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[0];
  const since = until - range.seconds;
  const [position, setPosition] = React.useState(1);
  const [playing, setPlaying] = React.useState(false);

  const timeline = useQuery({
    queryKey: ["org-timeline", since, until],
    queryFn: () => getOrgTimeline({ since, until, limit: 500 }),
    staleTime: 30_000,
  });
  const events = React.useMemo(() => timeline.data ?? [], [timeline.data]);

  const at = Math.round(since + position * (until - since));
  const snapshot = React.useMemo(() => reconstructAt(events, at), [events, at]);
  const buckets = React.useMemo(
    () => bucketActivity(events, since, until, BUCKETS),
    [events, since, until],
  );
  const maxBucket = Math.max(1, ...buckets);

  React.useEffect(() => {
    if (!playing) return;
    const step = TICK_MS / SWEEP_MS;
    const id = window.setInterval(() => {
      setPosition((prev) => {
        const next = prev + step;
        if (next >= 1) {
          setPlaying(false);
          return 1;
        }
        return next;
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [playing]);

  const togglePlay = () => {
    if (!playing && position >= 1) setPosition(0);
    setPlaying((prev) => !prev);
  };
  const jumpToNow = () => {
    setPlaying(false);
    setUntil(Math.floor(Date.now() / 1000));
    setPosition(1);
  };

  const { data: agents } = useManagedAgentsQuery();
  const { data: channels } = useChannelsQuery();
  const agentNames = React.useMemo(() => {
    const map = new Map<string, Named>();
    for (const agent of agents ?? []) {
      map.set(normalizePubkey(agent.pubkey), {
        name: agent.name,
        avatarUrl: agent.avatarUrl ?? null,
      });
    }
    return map;
  }, [agents]);
  const channelNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const channel of channels ?? []) map.set(channel.id, channel.name);
    return map;
  }, [channels]);
  const nameOf = (pubkey: string): Named =>
    agentNames.get(normalizePubkey(pubkey)) ?? {
      name: shortKey(pubkey),
      avatarUrl: null,
    };
  const channelOf = (channelId: string | null): string | null =>
    channelId
      ? `#${channelNames.get(channelId) ?? channelId.slice(0, 8)}`
      : null;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="time-machine-screen"
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border/70 px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <History className="size-5" />
            Time machine
          </h1>
          <p className="text-sm text-muted-foreground">
            Every event is signed. Scrub the org's history and watch it replay —
            who was working, which rooms were live, what was waiting.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-border/70 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => {
                setPlaying(false);
                setRangeKey(r.key);
                setPosition(1);
              }}
              className={cn(
                "rounded-lg px-2.5 py-1 text-2xs font-medium transition-colors",
                r.key === rangeKey
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Button
          aria-label={playing ? "Pause replay" : "Replay"}
          onClick={togglePlay}
          size="sm"
          variant={playing ? "secondary" : "default"}
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          {playing ? "Pause" : "Replay"}
        </Button>
      </header>

      <div className="border-b border-border/70 px-6 pb-3 pt-4">
        <div
          aria-hidden
          className="flex h-10 items-end gap-px"
          data-testid="time-machine-activity"
        >
          {buckets.map((count, index) => {
            const reached = index / buckets.length <= position;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-width buckets
                key={index}
                className={cn(
                  "flex-1 rounded-t-sm transition-colors",
                  reached ? "bg-primary/70" : "bg-border/70",
                )}
                style={{
                  height: `${Math.max(4, (count / maxBucket) * 100)}%`,
                }}
              />
            );
          })}
        </div>
        <input
          aria-label="Scrub through time"
          className="mt-1 w-full accent-primary"
          id="time-machine-scrubber"
          max={1000}
          min={0}
          onChange={(event) => {
            setPlaying(false);
            setPosition(Number(event.target.value) / 1000);
          }}
          type="range"
          value={Math.round(position * 1000)}
        />
        <div className="mt-1 flex items-center justify-between text-2xs text-muted-foreground">
          <span>{formatInstant(since)}</span>
          <span
            className="font-medium text-foreground"
            data-testid="time-machine-at"
          >
            {formatInstant(at)}
          </span>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={jumpToNow}
          >
            Now
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8 pt-4">
        {timeline.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the log…</p>
        ) : timeline.isError ? (
          <p className="text-sm text-destructive">
            Couldn't read the event log
            {timeline.error instanceof Error
              ? `: ${timeline.error.message}`
              : "."}
          </p>
        ) : events.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing recorded in the last {range.label}.
            </p>
            <p className="mt-1 text-2xs text-muted-foreground/70">
              Messages, agent turns, huddles, jobs and approvals all land here
              as they happen.
            </p>
          </div>
        ) : (
          <>
            <SnapshotTiles
              at={at}
              channelOf={channelOf}
              nameOf={nameOf}
              snapshot={snapshot}
            />
            <section className="mt-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Up to this moment
              </h2>
              <ol className="divide-y divide-border/60 rounded-2xl border border-border/70">
                {snapshot.history
                  .slice(-FEED_ROWS)
                  .reverse()
                  .map((event) => (
                    <FeedRow
                      channelOf={channelOf}
                      event={event}
                      key={event.id}
                      nameOf={nameOf}
                    />
                  ))}
                {snapshot.history.length === 0 ? (
                  <li className="px-3 py-4 text-sm text-muted-foreground">
                    Nothing had happened yet.
                  </li>
                ) : null}
              </ol>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function SnapshotTiles({
  at,
  channelOf,
  nameOf,
  snapshot,
}: {
  at: number;
  channelOf: (channelId: string | null) => string | null;
  nameOf: (pubkey: string) => Named;
  snapshot: OrgSnapshot;
}): React.ReactElement {
  const inFlight =
    snapshot.openJobs.length +
    snapshot.pendingApprovals.length +
    snapshot.liveHuddles.length;
  return (
    <div className="grid gap-3 md:grid-cols-4" data-testid="time-machine-tiles">
      <Tile
        count={snapshot.activeAgents.length}
        label="Working"
        live={snapshot.activeAgents.length > 0}
      >
        {snapshot.activeAgents.slice(0, 6).map((agent) => {
          const named = nameOf(agent.pubkey);
          return (
            <li className="flex items-center gap-2" key={agent.pubkey}>
              <UserAvatar
                avatarUrl={named.avatarUrl}
                displayName={named.name}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-sm">
                {named.name}
              </span>
              <span className="text-2xs text-muted-foreground">
                {channelOf(agent.channelId) ?? relativeTo(agent.lastAt, at)}
              </span>
            </li>
          );
        })}
      </Tile>
      <Tile
        count={snapshot.liveChannels.length}
        label="Live rooms"
        live={snapshot.liveChannels.length > 0}
      >
        {snapshot.liveChannels.slice(0, 6).map((channel) => (
          <li
            className="flex items-center justify-between gap-2 text-sm"
            key={channel.channelId}
          >
            <span className="min-w-0 truncate">
              {channelOf(channel.channelId)}
            </span>
            <span className="text-2xs text-muted-foreground">
              {channel.events} event{channel.events === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </Tile>
      <Tile count={inFlight} label="In flight" live={inFlight > 0}>
        {snapshot.liveHuddles.map((huddle) => (
          <li className="text-sm" key={huddle.id}>
            Huddle in {channelOf(huddle.channelId) ?? "a room"}
          </li>
        ))}
        {snapshot.openJobs.slice(0, 4).map((job) => (
          <li className="truncate text-sm" key={job.id}>
            Job: {job.preview || "untitled"}
          </li>
        ))}
        {snapshot.pendingApprovals.slice(0, 4).map((approval) => (
          <li className="truncate text-sm" key={approval.id}>
            Awaiting approval: {approval.preview || "workflow step"}
          </li>
        ))}
      </Tile>
      <Tile
        count={snapshot.trustDecisions}
        label="Trust decisions"
        live={false}
      >
        <li className="text-sm text-muted-foreground">
          {snapshot.receipts} receipt{snapshot.receipts === 1 ? "" : "s"} minted
        </li>
      </Tile>
    </div>
  );
}

function Tile({
  children,
  count,
  label,
  live,
}: {
  children: React.ReactNode;
  count: number;
  label: string;
  live: boolean;
}): React.ReactElement {
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/30 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <span className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
          {live ? (
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
            </span>
          ) : null}
          {count}
        </span>
      </div>
      <ul className="mt-2 space-y-1">{children}</ul>
    </div>
  );
}

function FeedRow({
  channelOf,
  event,
  nameOf,
}: {
  channelOf: (channelId: string | null) => string | null;
  event: TimelineEvent;
  nameOf: (pubkey: string) => Named;
}): React.ReactElement {
  const who = nameOf(event.agent ?? event.author).name;
  const room = channelOf(event.channelId);
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <span className="w-14 shrink-0 pt-0.5 text-2xs tabular-nums text-muted-foreground">
        {formatClock(event.at)}
      </span>
      <Badge className="shrink-0" variant="outline">
        {describeKind(event.kind)}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">
          <span className="font-medium">{who}</span>
          {room ? (
            <span className="text-muted-foreground"> in {room}</span>
          ) : null}
        </p>
        {event.preview ? (
          <p className="truncate text-2xs text-muted-foreground">
            {event.preview}
          </p>
        ) : null}
      </div>
    </li>
  );
}
