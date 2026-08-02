//! Design workspace — clone a team's frontend repo so agents can work from the
//! real source (the identical-match path, vs. scraping a live URL).
//!
//! The Design surface asks for a repo link; this clones it using the GitHub
//! connector's stored token (so private repos work with zero extra setup) into
//! `~/buzz-design-projects/<owner>_<repo>/`, strips the token back out of the
//! git remote, and detects the frontend framework so an agent has context.

use serde::Serialize;
use tauri::AppHandle;

/// Keyring key the GitHub connector stores its OAuth token under.
const GITHUB_TOKEN_KEY: &str = "github_integration_token";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRepoResult {
    pub owner: String,
    pub repo: String,
    /// Absolute path to the cloned working tree.
    pub path: String,
    /// Detected frontend framework (e.g. "Next.js", "Astro"), if recognized.
    pub framework: Option<String>,
    /// Default branch checked out.
    pub branch: Option<String>,
    /// Whether a fresh clone happened (false = already present).
    pub cloned: bool,
    /// True when a stored GitHub token was used (private repos).
    pub authenticated: bool,
}

fn github_token() -> Option<String> {
    crate::secret_store::SecretStore::shared(crate::app_state::keyring_service())
        .load(GITHUB_TOKEN_KEY)
        .ok()
        .flatten()
        .filter(|t| !t.trim().is_empty())
}

/// Parse an owner/repo out of the many shapes a user might paste:
/// `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo(.git)`,
/// or a full `git@github.com:owner/repo.git` SSH URL.
fn parse_owner_repo(input: &str) -> Result<(String, String), String> {
    let mut s = input.trim().trim_end_matches('/').to_string();
    if let Some(rest) = s.strip_prefix("git@github.com:") {
        s = rest.to_string();
    } else {
        for prefix in [
            "https://github.com/",
            "http://github.com/",
            "github.com/",
            "https://www.github.com/",
        ] {
            if let Some(rest) = s.strip_prefix(prefix) {
                s = rest.to_string();
                break;
            }
        }
    }
    s = s.trim_end_matches(".git").trim_matches('/').to_string();
    let parts: Vec<&str> = s.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() != 2 {
        return Err("Enter a GitHub repo as owner/repo or a github.com URL.".to_string());
    }
    let owner = parts[0];
    let repo = parts[1];
    let ok = |seg: &str| {
        !seg.is_empty()
            && seg
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !ok(owner) || !ok(repo) {
        return Err("That doesn't look like a valid owner/repo.".to_string());
    }
    Ok((owner.to_string(), repo.to_string()))
}

fn detect_framework(repo_dir: &std::path::Path) -> Option<String> {
    let pkg = std::fs::read_to_string(repo_dir.join("package.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&pkg).ok()?;
    let mut deps = serde_json::Map::new();
    for key in ["dependencies", "devDependencies"] {
        if let Some(obj) = json.get(key).and_then(|v| v.as_object()) {
            for (k, v) in obj {
                deps.insert(k.clone(), v.clone());
            }
        }
    }
    let has = |name: &str| deps.contains_key(name);
    // Order matters — check the most specific meta-framework first.
    if has("next") {
        Some("Next.js")
    } else if has("astro") {
        Some("Astro")
    } else if has("@remix-run/react") {
        Some("Remix")
    } else if has("gatsby") {
        Some("Gatsby")
    } else if has("nuxt") {
        Some("Nuxt")
    } else if has("@sveltejs/kit") {
        Some("SvelteKit")
    } else if has("vite") {
        Some("Vite")
    } else if has("react") {
        Some("React")
    } else if has("vue") {
        Some("Vue")
    } else if has("svelte") {
        Some("Svelte")
    } else {
        None
    }
    .map(str::to_string)
}

/// Redact a token that may appear in git's error output before surfacing it.
fn redact(text: &str, token: Option<&str>) -> String {
    match token {
        Some(t) if !t.is_empty() => text.replace(t, "***"),
        _ => text.to_string(),
    }
}

fn git(args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("git not available: {e}"))
}

fn clone_blocking(owner: String, repo: String) -> Result<DesignRepoResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let root = home.join("buzz-design-projects");
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let dest = root.join(format!("{owner}_{repo}"));

    let token = github_token();
    let authenticated = token.is_some();
    let public_url = format!("https://github.com/{owner}/{repo}.git");

    // Already cloned? Report it without touching anything.
    if dest.join(".git").is_dir() {
        let branch = current_branch(&dest);
        return Ok(DesignRepoResult {
            framework: detect_framework(&dest),
            branch,
            path: dest.display().to_string(),
            owner,
            repo,
            cloned: false,
            authenticated,
        });
    }
    if dest.exists() {
        return Err(format!(
            "{} already exists but is not a git checkout.",
            dest.display()
        ));
    }

    let clone_url = match &token {
        Some(t) => format!("https://x-access-token:{t}@github.com/{owner}/{repo}.git"),
        None => public_url.clone(),
    };
    let dest_str = dest
        .to_str()
        .ok_or_else(|| "destination path is not UTF-8".to_string())?;

    let output = git(&[
        "clone",
        "--depth",
        "1",
        "--end-of-options",
        &clone_url,
        dest_str,
    ])?;
    if !output.status.success() {
        let err = redact(&String::from_utf8_lossy(&output.stderr), token.as_deref());
        return Err(format!("git clone failed: {}", err.trim()));
    }

    // Never leave the token behind in the repo's remote config.
    let _ = std::process::Command::new("git")
        .args(["-C", dest_str, "remote", "set-url", "origin", &public_url])
        .output();

    Ok(DesignRepoResult {
        framework: detect_framework(&dest),
        branch: current_branch(&dest),
        path: dest.display().to_string(),
        owner,
        repo,
        cloned: true,
        authenticated,
    })
}

fn current_branch(repo_dir: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .args([
            "-C",
            repo_dir.to_str()?,
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!branch.is_empty() && branch != "HEAD").then_some(branch)
}

/// Clone a frontend repo into the design workspace, authenticating with the
/// GitHub connector's token when present. `repo` accepts `owner/repo` or any
/// github.com URL form.
#[tauri::command]
pub async fn clone_design_repo(_app: AppHandle, repo: String) -> Result<DesignRepoResult, String> {
    let (owner, name) = parse_owner_repo(&repo)?;
    tokio::task::spawn_blocking(move || clone_blocking(owner, name))
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_repo_shapes() {
        let cases = [
            "elijamesku/buzz",
            "github.com/elijamesku/buzz",
            "https://github.com/elijamesku/buzz",
            "https://github.com/elijamesku/buzz.git",
            "git@github.com:elijamesku/buzz.git",
            "  https://github.com/elijamesku/buzz/  ",
        ];
        for c in cases {
            let (o, r) = parse_owner_repo(c).unwrap_or_else(|_| panic!("parse {c}"));
            assert_eq!((o.as_str(), r.as_str()), ("elijamesku", "buzz"), "{c}");
        }
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse_owner_repo("not-a-repo").is_err());
        assert!(parse_owner_repo("https://github.com/only-owner").is_err());
        assert!(parse_owner_repo("a/b/c").is_err());
    }

    #[test]
    fn redacts_token() {
        assert_eq!(
            redact("fatal: bad https://x:tok123@h", Some("tok123")),
            "fatal: bad https://x:***@h"
        );
    }
}
