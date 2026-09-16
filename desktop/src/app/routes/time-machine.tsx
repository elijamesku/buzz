import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const TimeMachineScreen = React.lazy(async () => {
  const module = await import("@/features/time-machine/ui/TimeMachineScreen");
  return { default: module.TimeMachineScreen };
});

export const Route = createFileRoute("/time-machine")({
  component: TimeMachineRouteComponent,
});

function TimeMachineRouteComponent() {
  return (
    <React.Suspense
      fallback={<ViewLoadingFallback includeHeader kind="pulse" />}
    >
      <TimeMachineScreen />
    </React.Suspense>
  );
}
