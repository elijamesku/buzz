import { invokeTauri } from "@/shared/api/tauri";
import type {
  LatestHuddle,
  MeetingSummary,
  TranscriptSegment,
} from "@/shared/api/types";

/** Find a channel's most recent huddle (to show its meeting notes). */
export async function getLatestHuddle(
  channelId: string,
): Promise<LatestHuddle | null> {
  return invokeTauri<LatestHuddle | null>("get_latest_huddle", { channelId });
}

/** Read a huddle's transcript segments, ordered by time. */
export async function getMeetingTranscript(
  huddleId: string,
): Promise<TranscriptSegment[]> {
  return invokeTauri<TranscriptSegment[]>("get_meeting_transcript", {
    huddleId,
  });
}

/** Read a huddle's latest meeting summary, if one has been posted. */
export async function getMeetingSummary(
  huddleId: string,
): Promise<MeetingSummary | null> {
  return invokeTauri<MeetingSummary | null>("get_meeting_summary", {
    huddleId,
  });
}

/** Record one transcript segment for a huddle (called by STT producers). */
export async function recordTranscriptSegment(
  channelId: string,
  huddleId: string,
  text: string,
): Promise<void> {
  return invokeTauri<void>("record_transcript_segment", {
    channelId,
    huddleId,
    text,
  });
}

/** Post a meeting summary for a huddle to its channel. */
export async function postMeetingSummary(
  channelId: string,
  huddleId: string,
  text: string,
): Promise<void> {
  return invokeTauri<void>("post_meeting_summary", {
    channelId,
    huddleId,
    text,
  });
}
