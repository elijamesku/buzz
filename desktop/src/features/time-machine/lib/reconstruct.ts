import {
  KIND_APPROVAL_DENIED,
  KIND_APPROVAL_DENY,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_GRANTED,
  KIND_APPROVAL_REQUEST,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_STARTED,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_JOB_REQUEST,
  KIND_JOB_RESULT,
  KIND_STREAM_MESSAGE_V2,
  KIND_TRUST_DECISION,
  KIND_WORK_RECEIPT,
} from "@/shared/constants/kinds";
import type { TimelineEvent } from "@/shared/api/types";

const KIND_AGENT_TURN_METRIC = 44200;

/** How long after its last event an agent still counts as "working". */
export const DEFAULT_ACTIVE_WINDOW_SEC = 15 * 60;

export type ActiveAgent = {
  pubkey: string;
  lastAt: number;
  channelId: string | null;
};

export type LiveChannel = {
  channelId: string;
  lastAt: number;
  events: number;
};

/**
 * The org at one instant, rebuilt purely from the signed event log up to
 * `at`. Deterministic: same events + same `at` → same snapshot.
 */
export type OrgSnapshot = {
  at: number;
  /** Agents with signed activity inside the active window, most recent first. */
  activeAgents: ActiveAgent[];
  /** Channels with any event inside the active window, most recent first. */
  liveChannels: LiveChannel[];
  /** Huddles started and not yet ended. */
  liveHuddles: TimelineEvent[];
  /** Job requests with no result / cancel / error yet. */
  openJobs: TimelineEvent[];
  /** Approval requests with no grant / deny yet. */
  pendingApprovals: TimelineEvent[];
  trustDecisions: number;
  receipts: number;
  /** Everything at or before `at`, oldest first. */
  history: TimelineEvent[];
};

const JOB_CLOSERS = new Set([KIND_JOB_RESULT, KIND_JOB_CANCEL, KIND_JOB_ERROR]);
const APPROVAL_CLOSERS = new Set([
  KIND_APPROVAL_GRANTED,
  KIND_APPROVAL_DENIED,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
]);

function agentOf(event: TimelineEvent): string | null {
  if (event.agent) return event.agent;
  if (event.kind === KIND_AGENT_TURN_METRIC) return event.author;
  return null;
}

export function reconstructAt(
  events: TimelineEvent[],
  at: number,
  activeWindowSec = DEFAULT_ACTIVE_WINDOW_SEC,
): OrgSnapshot {
  const history = events.filter((event) => event.at <= at);
  const windowStart = at - activeWindowSec;

  const agents = new Map<string, ActiveAgent>();
  const channels = new Map<string, LiveChannel>();
  const huddles = new Map<string, TimelineEvent>();
  const jobs = new Map<string, TimelineEvent>();
  const approvals = new Map<string, TimelineEvent>();
  let trustDecisions = 0;
  let receipts = 0;

  for (const event of history) {
    const inWindow = event.at >= windowStart;

    // Decisions and receipts are *about* an agent, not the agent working.
    const agent = agentOf(event);
    const isAboutAgent =
      event.kind === KIND_TRUST_DECISION || event.kind === KIND_WORK_RECEIPT;
    if (agent && inWindow && !isAboutAgent) {
      const prior = agents.get(agent);
      if (!prior || prior.lastAt <= event.at) {
        agents.set(agent, {
          pubkey: agent,
          lastAt: event.at,
          channelId: event.channelId ?? prior?.channelId ?? null,
        });
      }
    }

    if (event.channelId && inWindow) {
      const prior = channels.get(event.channelId);
      channels.set(event.channelId, {
        channelId: event.channelId,
        lastAt: Math.max(prior?.lastAt ?? 0, event.at),
        events: (prior?.events ?? 0) + 1,
      });
    }

    switch (event.kind) {
      case KIND_HUDDLE_STARTED:
        huddles.set(event.id, event);
        break;
      case KIND_HUDDLE_ENDED:
        if (event.refId) huddles.delete(event.refId);
        break;
      case KIND_JOB_REQUEST:
        jobs.set(event.id, event);
        break;
      case KIND_APPROVAL_REQUEST:
        approvals.set(event.id, event);
        break;
      case KIND_TRUST_DECISION:
        trustDecisions += 1;
        break;
      case KIND_WORK_RECEIPT:
        receipts += 1;
        break;
      default:
        if (JOB_CLOSERS.has(event.kind) && event.refId) {
          jobs.delete(event.refId);
        } else if (APPROVAL_CLOSERS.has(event.kind) && event.refId) {
          approvals.delete(event.refId);
        }
    }
  }

  const byRecency = <T extends { lastAt: number }>(a: T, b: T) =>
    b.lastAt - a.lastAt;

  return {
    at,
    activeAgents: [...agents.values()].sort(byRecency),
    liveChannels: [...channels.values()].sort(byRecency),
    liveHuddles: [...huddles.values()],
    openJobs: [...jobs.values()],
    pendingApprovals: [...approvals.values()],
    trustDecisions,
    receipts,
    history,
  };
}

/**
 * Event counts per equal-width bucket across [since, until] — the activity
 * profile drawn above the scrubber. `buckets` must be ≥ 1.
 */
export function bucketActivity(
  events: TimelineEvent[],
  since: number,
  until: number,
  buckets: number,
): number[] {
  const counts = new Array<number>(Math.max(1, buckets)).fill(0);
  const span = Math.max(1, until - since);
  for (const event of events) {
    if (event.at < since || event.at > until) continue;
    const index = Math.min(
      counts.length - 1,
      Math.floor(((event.at - since) / span) * counts.length),
    );
    counts[index] += 1;
  }
  return counts;
}

/** Human label for a timeline kind — what happened, not the number. */
export function describeKind(kind: number): string {
  switch (kind) {
    case KIND_STREAM_MESSAGE_V2:
      return "Message";
    case 40099:
      return "System";
    case KIND_JOB_REQUEST:
      return "Job requested";
    case 43002:
      return "Job accepted";
    case 43003:
      return "Job progress";
    case KIND_JOB_RESULT:
      return "Job done";
    case KIND_JOB_CANCEL:
      return "Job cancelled";
    case KIND_JOB_ERROR:
      return "Job failed";
    case KIND_TRUST_DECISION:
      return "Trust decision";
    case KIND_WORK_RECEIPT:
      return "Receipt";
    case KIND_AGENT_TURN_METRIC:
      return "Agent turn";
    case 45001:
      return "Forum post";
    case 45003:
      return "Forum reply";
    case KIND_APPROVAL_REQUEST:
      return "Approval needed";
    case KIND_APPROVAL_GRANTED:
    case KIND_APPROVAL_GRANT:
      return "Approved";
    case KIND_APPROVAL_DENIED:
    case KIND_APPROVAL_DENY:
      return "Denied";
    case KIND_HUDDLE_STARTED:
      return "Huddle";
    case 48101:
      return "Joined huddle";
    case 48102:
      return "Left huddle";
    case KIND_HUDDLE_ENDED:
      return "Huddle ended";
    case 48107:
      return "Transcript";
    case 48108:
      return "Meeting summary";
    default:
      if (kind >= 46001 && kind <= 46007) return "Workflow";
      return "Event";
  }
}
