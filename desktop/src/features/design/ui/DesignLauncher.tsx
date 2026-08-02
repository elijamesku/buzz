import * as React from "react";
import { createPortal } from "react-dom";
import { PenTool } from "lucide-react";

import { DesignWorkspaceScreen } from "./DesignWorkspaceScreen";

/**
 * Entry point for the Design workspace. Renders a launcher button plus the
 * full-screen workspace through a portal to `document.body`, so neither is
 * affected by transformed / `will-change` / `overflow` ancestors in the app
 * shell (which, in WebKit, can trap `position: fixed` children).
 */
export function DesignLauncher({
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
          className="fixed bottom-4 right-4 z-[45] flex items-center gap-2 rounded-full border border-border/60 bg-card/95 px-4 py-2.5 text-sm font-semibold text-foreground shadow-lg backdrop-blur transition-colors hover:bg-card"
          data-testid="open-design-workspace"
        >
          <PenTool className="h-4 w-4" />
          Design
        </button>
      ) : null}
      {open ? <DesignWorkspaceScreen onClose={() => setOpen(false)} /> : null}
    </>,
    document.body,
  );
}
