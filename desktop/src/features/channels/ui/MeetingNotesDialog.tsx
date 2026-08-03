import type * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import {
  getLatestHuddle,
  getMeetingSummary,
  getMeetingTranscript,
} from "@/shared/api/tauriMeetings";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Spinner } from "@/shared/ui/spinner";

/**
 * Meeting notes for a channel's most recent huddle: the live transcript and,
 * once the huddle ends, its summary. Transcript segments (`KIND_HUDDLE_TRANSCRIPT`)
 * and the summary (`KIND_HUDDLE_SUMMARY`) are produced on the live stack — STT
 * during the call, an agent for the summary — so this fills in when a real
 * huddle happens.
 */
export function MeetingNotesDialog({
  channelId,
  onOpenChange,
  open,
}: {
  channelId: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}): React.ReactElement {
  const { data: huddle } = useQuery({
    queryKey: ["latest-huddle", channelId],
    queryFn: () => getLatestHuddle(channelId),
    enabled: open,
    refetchInterval: open ? 8_000 : false,
  });
  const huddleId = huddle?.huddleId ?? null;

  const { data: transcript } = useQuery({
    queryKey: ["meeting-transcript", huddleId],
    queryFn: () => getMeetingTranscript(huddleId ?? ""),
    enabled: open && !!huddleId,
    refetchInterval: open ? 5_000 : false,
  });
  const { data: summary } = useQuery({
    queryKey: ["meeting-summary", huddleId],
    queryFn: () => getMeetingSummary(huddleId ?? ""),
    enabled: open && !!huddleId,
    refetchInterval: open ? 8_000 : false,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Meeting notes
          </DialogTitle>
        </DialogHeader>

        {!huddleId ? (
          <div className="rounded-2xl border border-dashed border-border/70 bg-muted/30 px-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">No meetings yet</p>
            <p className="mt-1 text-2xs text-muted-foreground/70">
              Start a huddle in this channel — the transcript appears here live,
              and a summary posts when it ends.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Summary
              </p>
              {summary ? (
                <p className="whitespace-pre-wrap rounded-2xl border border-border/70 bg-muted/50 p-4 text-sm text-foreground">
                  {summary.text}
                </p>
              ) : (
                <p className="rounded-2xl border border-dashed border-border/70 bg-muted/30 p-4 text-2xs text-muted-foreground/70">
                  A summary posts here after the meeting ends.
                </p>
              )}
            </div>

            {/* Transcript */}
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Transcript
              </p>
              {transcript && transcript.length > 0 ? (
                <div className="max-h-64 space-y-2 overflow-y-auto rounded-2xl border border-border/70 bg-muted/30 p-4">
                  {transcript.map((segment) => (
                    <p
                      key={`${segment.speaker}-${segment.at}`}
                      className="text-sm"
                    >
                      <span className="mr-1.5 font-mono text-2xs text-muted-foreground">
                        {segment.speaker.slice(0, 8)}
                      </span>
                      <span className="text-foreground">{segment.text}</span>
                    </p>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-2xl border border-dashed border-border/70 bg-muted/30 p-4 text-2xs text-muted-foreground/70">
                  <Spinner size={14} />
                  Transcript appears live as people speak.
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
