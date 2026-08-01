//! GitHub connector — OAuth Device Flow + GitHub MCP server injection.
//!
//! The Integrations settings page uses these commands to connect a GitHub
//! account once and hand every agent GitHub tools:
//!
//! 1. `github_device_start` calls GitHub's device-code endpoint. The UI shows
//!    the returned `user_code` and opens `verification_uri` so the user can
//!    authorize in the browser.
//! 2. `github_device_poll` exchanges the device code for an access token. While
//!    the user has not yet authorized it returns `status: "pending"` (or
//!    `"slow_down"`). Once authorized it stores the token in the OS keyring,
//!    resolves the account login, writes the GitHub MCP server into every agent
//!    runtime config (see [`mcp_inject`]), records a status file, and returns
//!    `status: "authorized"`.
//! 3. `github_integration_status` reports the current connection.
//! 4. `github_disconnect` deletes the token and removes the injected server.
//!
//! Device Flow needs an OAuth App (or GitHub App) **client id** with device
//! flow enabled; the UI collects it. No client secret is required or stored.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::managed_agents::mcp_inject::{self, McpServerSpec};
use crate::managed_agents::storage::{atomic_write_json_restricted, managed_agents_base_dir};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";
const DEFAULT_SCOPE: &str = "repo read:org read:user";
const USER_AGENT: &str = "buzz-desktop-github-connector";
const KEYRING_TOKEN_KEY: &str = "github_integration_token";
const STATUS_FILE: &str = "github-integration.json";
const MCP_SERVER_NAME: &str = "github";

/// Baked-in default GitHub OAuth App client id, so users get one-click Connect
/// without pasting anything. OAuth App **client ids are public** (not secrets —
/// device flow uses no client secret), so embedding one is safe. A build can
/// override it via `BUZZ_BUILD_GITHUB_CLIENT_ID` (surfaced by build.rs as
/// `BUZZ_DESKTOP_BUILD_GITHUB_CLIENT_ID`); empty override falls back here.
const DEFAULT_GITHUB_CLIENT_ID: &str = "Ov23litXNJlAtam2CEpB";

fn baked_client_id() -> &'static str {
    match option_env!("BUZZ_DESKTOP_BUILD_GITHUB_CLIENT_ID") {
        Some(v) if !v.is_empty() => v,
        _ => DEFAULT_GITHUB_CLIENT_ID,
    }
}

// ── Serialized shapes ───────────────────────────────────────────────────────

/// Result of `github_device_start` — mirrors GitHub's device-code response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubDeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// Result of `github_device_poll`.
///
/// `status` is one of `"pending"`, `"slow_down"`, `"authorized"`, `"error"`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPollResult {
    pub status: String,
    /// Present when `status == "authorized"`.
    pub login: Option<String>,
    /// Human-readable message when `status == "error"`.
    pub error: Option<String>,
    /// Runtimes the MCP server was written into (`status == "authorized"`).
    pub runtimes: Vec<String>,
    /// Non-fatal per-runtime injection failures, `"<runtime>: <reason>"`.
    pub warnings: Vec<String>,
}

/// Persisted (token-free) connection state, also returned by
/// `github_integration_status`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIntegrationStatus {
    pub connected: bool,
    pub login: Option<String>,
    pub scope: Option<String>,
    pub client_id: Option<String>,
    pub connected_at: Option<String>,
    /// Runtimes the server was injected into at connect time.
    #[serde(default)]
    pub runtimes: Vec<String>,
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn secret_store() -> &'static crate::secret_store::SecretStore {
    crate::secret_store::SecretStore::shared(crate::app_state::keyring_service())
}

fn status_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(managed_agents_base_dir(app)?.join(STATUS_FILE))
}

fn load_status(app: &AppHandle) -> GithubIntegrationStatus {
    let Ok(path) = status_path(app) else {
        return GithubIntegrationStatus::default();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => GithubIntegrationStatus::default(),
    }
}

fn save_status(app: &AppHandle, status: &GithubIntegrationStatus) -> Result<(), String> {
    let path = status_path(app)?;
    let payload =
        serde_json::to_vec_pretty(status).map_err(|e| format!("serialize github status: {e}"))?;
    atomic_write_json_restricted(&path, &payload)
}

/// The GitHub MCP server definition injected into each runtime. Uses the
/// community stdio server over `npx` so no Docker/binary install is required;
/// the OAuth token is passed as `GITHUB_PERSONAL_ACCESS_TOKEN`.
fn github_server_spec(token: &str) -> McpServerSpec {
    let mut env = std::collections::BTreeMap::new();
    env.insert(
        "GITHUB_PERSONAL_ACCESS_TOKEN".to_string(),
        token.to_string(),
    );
    McpServerSpec {
        name: MCP_SERVER_NAME.to_string(),
        command: "npx".to_string(),
        args: vec![
            "-y".to_string(),
            "@modelcontextprotocol/server-github".to_string(),
        ],
        env,
    }
}

fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn json_u64(value: &serde_json::Value, key: &str, default: u64) -> u64 {
    value.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

/// Resolve the authenticated account login for `token`.
fn fetch_login(token: &str) -> Result<String, String> {
    let client = blocking_client()?;
    let resp = client
        .get(USER_URL)
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(token)
        .send()
        .map_err(|e| format!("github user request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "github user request rejected: HTTP {}",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .map_err(|e| format!("github user parse failed: {e}"))?;
    json_str(&body, "login").ok_or_else(|| "github user response missing login".to_string())
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The built-in GitHub OAuth App client id. Lets the UI offer one-click Connect
/// without asking each user to paste a client id — they only authorize their
/// own account.
#[tauri::command]
pub fn github_default_client_id() -> String {
    baked_client_id().to_string()
}

/// Begin the OAuth Device Flow. Returns the user code + verification URL the UI
/// should surface, plus the device code used for polling.
#[tauri::command]
pub async fn github_device_start(
    client_id: String,
    scope: Option<String>,
) -> Result<GithubDeviceCode, String> {
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() {
        return Err("a GitHub OAuth App client id is required".to_string());
    }
    let scope = scope
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SCOPE.to_string());

    tokio::task::spawn_blocking(move || {
        let client = blocking_client()?;
        let resp = client
            .post(DEVICE_CODE_URL)
            .header("Accept", "application/json")
            .form(&[("client_id", client_id.as_str()), ("scope", scope.as_str())])
            .send()
            .map_err(|e| format!("device code request failed: {e}"))?;
        let ok = resp.status().is_success();
        let body: serde_json::Value = resp
            .json()
            .map_err(|e| format!("device code parse failed: {e}"))?;
        if !ok || body.get("error").is_some() {
            let msg = json_str(&body, "error_description")
                .or_else(|| json_str(&body, "error"))
                .unwrap_or_else(|| "device code request rejected".to_string());
            return Err(msg);
        }
        let device_code = json_str(&body, "device_code")
            .ok_or_else(|| "device code response missing device_code".to_string())?;
        let user_code = json_str(&body, "user_code")
            .ok_or_else(|| "device code response missing user_code".to_string())?;
        let verification_uri = json_str(&body, "verification_uri")
            .ok_or_else(|| "device code response missing verification_uri".to_string())?;
        Ok(GithubDeviceCode {
            device_code,
            user_code,
            verification_uri,
            expires_in: json_u64(&body, "expires_in", 900),
            interval: json_u64(&body, "interval", 5),
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Poll GitHub once for the device-code exchange. On success, persist the token,
/// inject the GitHub MCP server into all runtimes, and record status. The UI
/// calls this on the interval returned by `github_device_start`.
#[tauri::command]
pub async fn github_device_poll(
    app: AppHandle,
    client_id: String,
    device_code: String,
) -> Result<GithubPollResult, String> {
    let client_id_for_poll = client_id.trim().to_string();
    let device_code = device_code.trim().to_string();
    if client_id_for_poll.is_empty() || device_code.is_empty() {
        return Err("client id and device code are required".to_string());
    }

    // Network exchange (blocking).
    let exchange = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let client = blocking_client()?;
        let resp = client
            .post(ACCESS_TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", client_id_for_poll.as_str()),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .map_err(|e| format!("token request failed: {e}"))?;
        resp.json::<serde_json::Value>()
            .map_err(|e| format!("token parse failed: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    // Still waiting on the user.
    if let Some(err) = json_str(&exchange, "error") {
        return match err.as_str() {
            "authorization_pending" => Ok(pending("pending")),
            "slow_down" => Ok(pending("slow_down")),
            other => Ok(GithubPollResult {
                status: "error".to_string(),
                login: None,
                error: Some(
                    json_str(&exchange, "error_description").unwrap_or_else(|| other.to_string()),
                ),
                runtimes: Vec::new(),
                warnings: Vec::new(),
            }),
        };
    }

    let Some(token) = json_str(&exchange, "access_token") else {
        return Ok(GithubPollResult {
            status: "error".to_string(),
            login: None,
            error: Some("token response missing access_token".to_string()),
            runtimes: Vec::new(),
            warnings: Vec::new(),
        });
    };
    let scope = json_str(&exchange, "scope");

    // Authorized — resolve login, store the token, inject MCP servers, persist.
    let token_for_login = token.clone();
    let login = tokio::task::spawn_blocking(move || fetch_login(&token_for_login))
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))??;

    secret_store()
        .store(KEYRING_TOKEN_KEY, &token)
        .map_err(|e| format!("store github token: {e}"))?;

    let report = {
        let spec = github_server_spec(&token);
        tokio::task::spawn_blocking(move || mcp_inject::inject_all(&spec))
            .await
            .map_err(|e| format!("spawn_blocking failed: {e}"))?
    };

    let status = GithubIntegrationStatus {
        connected: true,
        login: Some(login.clone()),
        scope: scope.clone(),
        client_id: Some(client_id.trim().to_string()),
        connected_at: Some(chrono::Utc::now().to_rfc3339()),
        runtimes: report.updated.clone(),
    };
    save_status(&app, &status)?;

    let warnings = report
        .failures
        .into_iter()
        .map(|(runtime, err)| format!("{runtime}: {err}"))
        .collect();

    Ok(GithubPollResult {
        status: "authorized".to_string(),
        login: Some(login),
        error: None,
        runtimes: report.updated,
        warnings,
    })
}

fn pending(status: &str) -> GithubPollResult {
    GithubPollResult {
        status: status.to_string(),
        login: None,
        error: None,
        runtimes: Vec::new(),
        warnings: Vec::new(),
    }
}

/// Return the current GitHub connection state (no token material).
#[tauri::command]
pub fn github_integration_status(app: AppHandle) -> Result<GithubIntegrationStatus, String> {
    let mut status = load_status(&app);
    // A dangling status file without a keyring token means the token was wiped
    // out of band — report disconnected rather than lie.
    if status.connected {
        let has_token = secret_store()
            .load(KEYRING_TOKEN_KEY)
            .map(|v| v.is_some())
            .unwrap_or(false);
        if !has_token {
            status = GithubIntegrationStatus::default();
        }
    }
    Ok(status)
}

/// Disconnect GitHub: delete the token and remove the injected MCP server from
/// every runtime config. Best-effort — a failure to clean one runtime does not
/// prevent tearing down the rest or clearing the token.
#[tauri::command]
pub async fn github_disconnect(app: AppHandle) -> Result<GithubIntegrationStatus, String> {
    let _ = secret_store().delete(KEYRING_TOKEN_KEY);
    let _ = tokio::task::spawn_blocking(|| mcp_inject::remove_all(MCP_SERVER_NAME)).await;
    let cleared = GithubIntegrationStatus::default();
    save_status(&app, &cleared)?;
    Ok(cleared)
}
