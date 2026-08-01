import { invokeTauri } from "@/shared/api/tauri";
import type {
  GithubDeviceCode,
  GithubIntegrationStatus,
  GithubPollResult,
} from "@/shared/api/types";

/**
 * Begin the GitHub OAuth Device Flow.
 *
 * Returns the user code + verification URL to surface in the UI, plus the
 * device code used for polling. `clientId` is a GitHub OAuth App (or GitHub
 * App) client id with device flow enabled. `scope` defaults to
 * `repo read:org read:user` when omitted.
 *
 * Throws a string error message on failure.
 */
export async function githubDeviceStart(
  clientId: string,
  scope?: string,
): Promise<GithubDeviceCode> {
  return invokeTauri<GithubDeviceCode>("github_device_start", {
    clientId,
    scope: scope ?? null,
  });
}

/**
 * Poll GitHub once for the device-code exchange.
 *
 * Returns `status: "pending"` / `"slow_down"` while the user authorizes. On
 * `"authorized"` the token has been stored in the OS keyring and the GitHub MCP
 * server written into every agent runtime config. Call on the interval returned
 * by {@link githubDeviceStart}.
 */
export async function githubDevicePoll(
  clientId: string,
  deviceCode: string,
): Promise<GithubPollResult> {
  return invokeTauri<GithubPollResult>("github_device_poll", {
    clientId,
    deviceCode,
  });
}

/** Read the current GitHub connection state (no token material). */
export async function githubIntegrationStatus(): Promise<GithubIntegrationStatus> {
  return invokeTauri<GithubIntegrationStatus>("github_integration_status");
}

/**
 * The built-in GitHub OAuth App client id baked into this build, so the UI can
 * offer one-click Connect. Empty string if no default was baked in (then the
 * user must supply their own). Client ids are public, not secrets.
 */
export async function githubDefaultClientId(): Promise<string> {
  return invokeTauri<string>("github_default_client_id");
}

/**
 * Disconnect GitHub: delete the stored token and remove the injected MCP server
 * from every runtime config. Returns the cleared status.
 */
export async function githubDisconnect(): Promise<GithubIntegrationStatus> {
  return invokeTauri<GithubIntegrationStatus>("github_disconnect");
}
