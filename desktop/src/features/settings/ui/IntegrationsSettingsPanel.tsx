import * as React from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  Copy,
  ExternalLink,
  GitFork,
  Plug,
  TriangleAlert,
} from "lucide-react";

import {
  githubDefaultClientId,
  githubDeviceStart,
  githubDevicePoll,
  githubDisconnect,
  githubIntegrationStatus,
} from "@/shared/api/tauriGithubIntegration";
import type {
  GithubDeviceCode,
  GithubIntegrationStatus,
} from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

// A user-supplied client id override is remembered locally (it is not a secret —
// device flow needs no client secret). Absent = use the build's baked-in id.
const CLIENT_ID_STORAGE_KEY = "buzz.integrations.github.clientId";

type ConnectPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "awaiting"; device: GithubDeviceCode }
  | { kind: "error"; message: string };

export function IntegrationsSettingsPanel(): React.ReactElement {
  const [status, setStatus] = React.useState<GithubIntegrationStatus | null>(
    null,
  );
  const [defaultClientId, setDefaultClientId] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const refreshStatus = React.useCallback(async () => {
    try {
      setStatus(await githubIntegrationStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [nextStatus, id] = await Promise.all([
          githubIntegrationStatus().catch(() => null),
          githubDefaultClientId().catch(() => ""),
        ]);
        if (!active) return;
        setStatus(nextStatus);
        setDefaultClientId(id);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      data-testid="settings-integrations"
    >
      <SettingsSectionHeader
        title="Integrations"
        description="Connect external services once and share them with every agent in this community."
      />
      <GithubConnectorCard
        defaultClientId={defaultClientId}
        loading={loading}
        status={status}
        onConnected={refreshStatus}
        onStatus={setStatus}
      />
    </section>
  );
}

function GithubConnectorCard({
  defaultClientId,
  loading,
  status,
  onConnected,
  onStatus,
}: {
  defaultClientId: string;
  loading: boolean;
  status: GithubIntegrationStatus | null;
  onConnected: () => void;
  onStatus: (next: GithubIntegrationStatus) => void;
}): React.ReactElement {
  const connected = status?.connected ?? false;

  return (
    <div className="rounded-xl border border-border/70 bg-card/40">
      <div className="flex items-start gap-4 p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
          <GitFork className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">GitHub</h3>
            <ConnectionBadge connected={connected} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Adds the GitHub MCP server to every agent runtime (Claude, Codex,
            Goose), so agents can read and act on your repos, issues, and pull
            requests.
          </p>

          {loading ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size={16} /> Checking connection…
            </div>
          ) : connected ? (
            <ConnectedPanel status={status} onStatus={onStatus} />
          ) : (
            <DisconnectedPanel
              defaultClientId={defaultClientId}
              onConnected={onConnected}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectionBadge({
  connected,
}: {
  connected: boolean;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium",
        connected
          ? "bg-emerald-500/15 text-emerald-600"
          : "bg-muted text-muted-foreground",
      )}
    >
      <Plug className="h-3 w-3" />
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

function ConnectedPanel({
  status,
  onStatus,
}: {
  status: GithubIntegrationStatus | null;
  onStatus: (next: GithubIntegrationStatus) => void;
}): React.ReactElement {
  const [disconnecting, setDisconnecting] = React.useState(false);

  const disconnect = async () => {
    setDisconnecting(true);
    try {
      onStatus(await githubDisconnect());
    } catch {
      // Leave current status untouched on failure.
    } finally {
      setDisconnecting(false);
    }
  };

  const runtimes = status?.runtimes ?? [];

  return (
    <div className="mt-4 space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Account</dt>
        <dd className="font-medium text-foreground">
          {status?.login ? `@${status.login}` : "—"}
        </dd>
        <dt className="text-muted-foreground">Scopes</dt>
        <dd className="font-mono text-2xs text-foreground/80">
          {status?.scope ?? "—"}
        </dd>
        <dt className="text-muted-foreground">Runtimes</dt>
        <dd className="text-foreground">
          {runtimes.length > 0 ? runtimes.join(", ") : "none detected"}
        </dd>
      </dl>
      <Button
        variant="outline"
        size="sm"
        disabled={disconnecting}
        onClick={() => void disconnect()}
      >
        {disconnecting ? <Spinner size={14} /> : null}
        Disconnect
      </Button>
    </div>
  );
}

function DisconnectedPanel({
  defaultClientId,
  onConnected,
}: {
  defaultClientId: string;
  onConnected: () => void;
}): React.ReactElement {
  const storedOverride = React.useMemo(
    () => localStorage.getItem(CLIENT_ID_STORAGE_KEY) ?? "",
    [],
  );
  // Show the client-id field only when there is no baked-in id, or the user has
  // explicitly chosen to override it. Otherwise it's a one-click Connect.
  const [editingId, setEditingId] = React.useState(
    () => defaultClientId.length === 0 || storedOverride.length > 0,
  );
  const [clientId, setClientId] = React.useState(
    () => storedOverride || defaultClientId,
  );
  const [phase, setPhase] = React.useState<ConnectPhase>({ kind: "idle" });
  const pollRef = React.useRef<number | null>(null);

  // Keep the effective client id in sync once the baked default arrives.
  React.useEffect(() => {
    if (!storedOverride && defaultClientId) setClientId(defaultClientId);
  }, [defaultClientId, storedOverride]);

  const stopPolling = React.useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  React.useEffect(() => stopPolling, [stopPolling]);

  const beginPolling = React.useCallback(
    (device: GithubDeviceCode, id: string) => {
      const deadline = Date.now() + device.expiresIn * 1000;
      let intervalMs = device.interval * 1000;

      const tick = async () => {
        if (Date.now() > deadline) {
          setPhase({
            kind: "error",
            message: "The code expired before authorization. Try again.",
          });
          return;
        }
        try {
          const result = await githubDevicePoll(id, device.deviceCode);
          if (result.status === "authorized") {
            stopPolling();
            onConnected();
            return;
          }
          if (result.status === "error") {
            setPhase({
              kind: "error",
              message: result.error ?? "Authorization failed.",
            });
            return;
          }
          // slow_down → back off an extra 5s per GitHub's guidance.
          if (result.status === "slow_down") {
            intervalMs += 5000;
          }
        } catch (err) {
          setPhase({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        pollRef.current = window.setTimeout(() => void tick(), intervalMs);
      };

      pollRef.current = window.setTimeout(() => void tick(), intervalMs);
    },
    [onConnected, stopPolling],
  );

  const connect = async () => {
    const id = clientId.trim();
    if (!id) {
      setPhase({
        kind: "error",
        message: "Enter a GitHub OAuth App client id first.",
      });
      return;
    }
    // Persist only a genuine override; otherwise rely on the baked default.
    if (id !== defaultClientId) {
      localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
    } else {
      localStorage.removeItem(CLIENT_ID_STORAGE_KEY);
    }
    setPhase({ kind: "starting" });
    try {
      const device = await githubDeviceStart(id);
      setPhase({ kind: "awaiting", device });
      void openUrl(device.verificationUri);
      beginPolling(device, id);
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const cancel = () => {
    stopPolling();
    setPhase({ kind: "idle" });
  };

  const busy = phase.kind === "starting" || phase.kind === "awaiting";

  return (
    <div className="mt-4 space-y-3">
      {editingId ? (
        <div className="text-sm">
          <label
            htmlFor="github-client-id"
            className="mb-1 block font-medium text-foreground"
          >
            OAuth App client id
          </label>
          <Input
            id="github-client-id"
            value={clientId}
            placeholder="Ov23li0123456789abcd"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setClientId(e.target.value)}
          />
          <p className="mt-1 text-2xs text-muted-foreground">
            A GitHub OAuth App (or GitHub App) client id with Device Flow
            enabled. No client secret is needed or stored.
          </p>
        </div>
      ) : null}

      {phase.kind === "awaiting" ? (
        <DeviceCodePrompt device={phase.device} onCancel={cancel} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            size="sm"
            disabled={phase.kind === "starting"}
            onClick={() => void connect()}
          >
            {phase.kind === "starting" ? (
              <Spinner size={14} />
            ) : (
              <GitFork className="h-4 w-4" />
            )}
            Connect GitHub
          </Button>
          {!editingId ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-muted-foreground"
              onClick={() => setEditingId(true)}
            >
              Use a different client id
            </Button>
          ) : null}
          {phase.kind === "error" ? (
            <span className="flex items-center gap-1.5 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4 shrink-0" />
              {phase.message}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DeviceCodePrompt({
  device,
  onCancel,
}: {
  device: GithubDeviceCode;
  onCancel: () => void;
}): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(device.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — the code is visible for manual entry anyway.
    }
  };

  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-4">
      <p className="text-sm text-foreground">
        Enter this code on GitHub to authorize:
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="rounded-md bg-background px-3 py-1.5 font-mono text-lg font-semibold tracking-[0.2em] text-foreground">
          {device.userCode}
        </code>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy code"
          onClick={() => void copyCode()}
        >
          {copied ? (
            <Check className="h-4 w-4 text-emerald-600" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void openUrl(device.verificationUri)}
        >
          <ExternalLink className="h-4 w-4" />
          Open GitHub
        </Button>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner size={14} /> Waiting for authorization…
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
