import { invokeTauri } from "@/shared/api/tauri";
import type { LocalStackStatus } from "@/shared/api/types";

/** Report which local-backend setup steps are already satisfied. */
export async function localStackStatus(): Promise<LocalStackStatus> {
  return invokeTauri<LocalStackStatus>("local_stack_status");
}

/**
 * Start the Docker services (Postgres/Redis) for a local relay — the
 * button-equivalent of `docker compose up -d`. Requires a checkout and a
 * running Docker daemon. Throws a string error otherwise.
 */
export async function startLocalServices(): Promise<LocalStackStatus> {
  return invokeTauri<LocalStackStatus>("start_local_services");
}
