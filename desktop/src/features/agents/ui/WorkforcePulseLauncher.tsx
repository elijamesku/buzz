import * as React from "react";
import { createPortal } from "react-dom";
import { Activity } from "lucide-react";

import { WorkforcePulseScreen } from "@/features/agents/ui/WorkforcePulseScreen";

/**
 * Entry point for the Workforce (living-org) view. Renders a launcher button
 * plus the full-screen surface through a portal to `document.body` so neither
 * is affected by transformed / overflow ancestors in the app shell.
 */
export function WorkforcePulseLauncher({
  hidden = false,
}: {
  hidden?: boolean;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <>
      {!open && !hidden ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-[4.75rem] right-4 z-[45] flex items-center gap-2 rounded-full border border-border/60 bg-card/95 px-4 py-2.5 text-sm font-semibold text-foreground shadow-lg backdrop-blur transition-colors hover:bg-card"
          data-testid="open-workforce-pulse"
        >
          <Activity className="h-4 w-4" />
          Workforce
        </button>
      ) : null}
      {open ? <WorkforcePulseScreen onClose={() => setOpen(false)} /> : null}
    </>,
    document.body,
  );
}
