import { invokeTauri } from "@/shared/api/tauri";
import type { TimelineEvent } from "@/shared/api/types";

/** A time-ordered slice of the workspace event log (unix seconds, inclusive). */
export async function getOrgTimeline(input: {
  since: number;
  until: number;
  limit?: number;
}): Promise<TimelineEvent[]> {
  return invokeTauri<TimelineEvent[]>("get_org_timeline", {
    since: input.since,
    until: input.until,
    limit: input.limit ?? null,
  });
}
