//! Local backend setup as buttons instead of terminal commands.
//!
//! Buzz's relay needs Postgres + Redis (via Docker). For self-hosters running
//! from a checkout, this exposes the `just quickstart` steps to the UI: check
//! what's ready, and start the Docker services with one click. A packaged
//! consumer app has no checkout and should join a hosted relay instead — these
//! commands report `repoAvailable: false` there so the UI can say so.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

/// Snapshot of local-backend readiness, one field per setup step.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LocalStackStatus {
    /// A Buzz checkout (with docker-compose.yml) was found — required to run a
    /// local relay. False in a packaged app.
    pub repo_available: bool,
    pub docker_installed: bool,
    pub docker_running: bool,
    /// Compose services (Postgres/Redis/…) are up.
    pub services_up: bool,
    /// The local relay answers its health probe.
    pub relay_reachable: bool,
    /// Absolute path to the resolved checkout, if any.
    pub repo_path: Option<String>,
}

/// Walk up from the current directory to find the Buzz checkout root
/// (identified by `docker-compose.yml` next to a `Justfile`).
fn repo_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("docker-compose.yml").is_file() && dir.join("Justfile").is_file() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn command_ok(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn services_running(repo: &PathBuf) -> bool {
    // `docker compose ps -q` prints container ids for running services.
    Command::new("docker")
        .args(["compose", "ps", "-q"])
        .current_dir(repo)
        .output()
        .map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn relay_healthy() -> bool {
    let port = std::env::var("BUZZ_HEALTH_PORT").unwrap_or_else(|_| "8080".to_string());
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{port}/health"))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn compute_status() -> LocalStackStatus {
    let repo = repo_root();
    let docker_installed = command_ok("docker", &["--version"]);
    let docker_running = docker_installed && command_ok("docker", &["info"]);
    let services_up = match (&repo, docker_running) {
        (Some(dir), true) => services_running(dir),
        _ => false,
    };
    LocalStackStatus {
        repo_available: repo.is_some(),
        docker_installed,
        docker_running,
        services_up,
        relay_reachable: relay_healthy(),
        repo_path: repo.map(|p| p.display().to_string()),
    }
}

/// Report which local-backend setup steps are already satisfied.
#[tauri::command]
pub async fn local_stack_status() -> Result<LocalStackStatus, String> {
    tokio::task::spawn_blocking(compute_status)
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))
}

/// Start the Docker services (Postgres/Redis/…) for a local relay — the
/// button-equivalent of `docker compose up -d`. Requires a checkout and a
/// running Docker daemon; the relay auto-applies migrations on startup.
#[tauri::command]
pub async fn start_local_services() -> Result<LocalStackStatus, String> {
    tokio::task::spawn_blocking(|| {
        let repo = repo_root().ok_or_else(|| {
            "No Buzz checkout found. A local relay needs the source; a packaged app \
             should join a hosted community instead."
                .to_string()
        })?;
        if !command_ok("docker", &["info"]) {
            return Err("Docker isn't running. Start Docker Desktop, then try again.".to_string());
        }
        let output = Command::new("docker")
            .args(["compose", "up", "-d"])
            .current_dir(&repo)
            .output()
            .map_err(|e| format!("docker compose failed to launch: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "docker compose up failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        Ok(compute_status())
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}
