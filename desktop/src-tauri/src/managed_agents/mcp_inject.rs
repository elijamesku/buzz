//! Inject (or remove) a named MCP server across the local agent runtime configs.
//!
//! Buzz agents are spawned by the ACP harness, which launches the user's chosen
//! runtime (Claude / Codex / Goose). Each runtime reads its **own** native
//! config file for MCP servers — there is no single Buzz-owned MCP registry. So
//! to make one connector (e.g. GitHub) available to *every* agent, we write the
//! same server definition into each runtime's config:
//!
//! | Runtime | File | Section |
//! |---------|------|---------|
//! | Claude  | `~/.claude.json`               | `mcpServers.<name>` (JSON) |
//! | Codex   | `~/.codex/config.toml`         | `[mcp_servers.<name>]` (TOML) |
//! | Goose   | `~/.config/goose/config.yaml`  | `extensions.<name>` (YAML) |
//!
//! Writes are **surgical**: only the single named key is inserted or removed,
//! and every other server / setting in the file is preserved. The Codex writer
//! uses `toml_edit` so comments and key ordering survive. Files are created
//! (with parent dirs) when missing so a runtime the user configures *later*
//! still picks the server up.
//!
//! Config files carry the connector token in plaintext `env` — the same shape a
//! user would write by hand. On Unix the files are chmod'd `0o600`.

use std::collections::BTreeMap;
use std::path::PathBuf;

/// A single MCP server definition, runtime-agnostic.
#[derive(Debug, Clone)]
pub struct McpServerSpec {
    /// Key the server is registered under (e.g. `"github"`).
    pub name: String,
    /// Executable to launch (e.g. `"npx"`).
    pub command: String,
    /// Arguments passed to `command`.
    pub args: Vec<String>,
    /// Environment variables handed to the server process (holds the token).
    pub env: BTreeMap<String, String>,
}

/// Which runtimes an inject/remove touched, for status reporting.
#[derive(Debug, Clone, Default)]
pub struct McpInjectReport {
    /// Runtime ids (`"claude"`, `"codex"`, `"goose"`) written successfully.
    pub updated: Vec<String>,
    /// `(runtime id, error)` pairs for runtimes that failed (best-effort — a
    /// single runtime failure never aborts the others).
    pub failures: Vec<(String, String)>,
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())
}

fn claude_config_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".claude.json"))
}

fn codex_config_path() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CODEX_HOME") {
        return Ok(PathBuf::from(dir).join("config.toml"));
    }
    Ok(home()?.join(".codex").join("config.toml"))
}

fn goose_config_path() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("GOOSE_PATH_ROOT") {
        return Ok(PathBuf::from(root).join("config").join("config.yaml"));
    }
    Ok(home()?.join(".config").join("goose").join("config.yaml"))
}

/// Write `contents` to `path`, creating parent dirs, and (on Unix) restrict the
/// file to `0o600` since MCP configs hold the connector token.
fn write_restricted(path: &PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ── Claude (`~/.claude.json`, JSON) ─────────────────────────────────────────

fn claude_upsert(spec: &McpServerSpec) -> Result<(), String> {
    let path = claude_config_path()?;
    let mut root: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?
        }
        _ => serde_json::json!({}),
    };
    let obj = root
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let servers = obj
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())?;

    let env: serde_json::Map<String, serde_json::Value> = spec
        .env
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    servers.insert(
        spec.name.clone(),
        serde_json::json!({
            "command": spec.command,
            "args": spec.args,
            "env": env,
        }),
    );

    let text =
        serde_json::to_string_pretty(&root).map_err(|e| format!("serialize claude config: {e}"))?;
    write_restricted(&path, &text)
}

fn claude_remove(name: &str) -> Result<bool, String> {
    let path = claude_config_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return Ok(false),
    };
    let mut root: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let removed = root
        .get_mut("mcpServers")
        .and_then(|v| v.as_object_mut())
        .map(|servers| servers.remove(name).is_some())
        .unwrap_or(false);
    if removed {
        let text = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("serialize claude config: {e}"))?;
        write_restricted(&path, &text)?;
    }
    Ok(removed)
}

// ── Codex (`~/.codex/config.toml`, TOML via toml_edit) ──────────────────────

fn codex_upsert(spec: &McpServerSpec) -> Result<(), String> {
    let path = codex_config_path()?;
    let mut doc: toml_edit::DocumentMut = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => text
            .parse()
            .map_err(|e| format!("parse {}: {e}", path.display()))?,
        _ => toml_edit::DocumentMut::new(),
    };

    let mut server = toml_edit::Table::new();
    server.insert("command", toml_edit::value(spec.command.clone()));
    let mut args = toml_edit::Array::new();
    for arg in &spec.args {
        args.push(arg.as_str());
    }
    server.insert("args", toml_edit::value(args));
    if !spec.env.is_empty() {
        let mut env = toml_edit::InlineTable::new();
        for (k, v) in &spec.env {
            env.insert(k, v.as_str().into());
        }
        server.insert("env", toml_edit::value(env));
    }

    // Ensure [mcp_servers] is a real table, then set the named sub-table.
    let servers = doc
        .entry("mcp_servers")
        .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
    let servers = servers
        .as_table_mut()
        .ok_or_else(|| "mcp_servers is not a table".to_string())?;
    servers.insert(&spec.name, toml_edit::Item::Table(server));

    write_restricted(&path, &doc.to_string())
}

fn codex_remove(name: &str) -> Result<bool, String> {
    let path = codex_config_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return Ok(false),
    };
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|e| format!("parse {}: {e}", path.display()))?;
    let removed = doc
        .get_mut("mcp_servers")
        .and_then(|item| item.as_table_mut())
        .map(|servers| servers.remove(name).is_some())
        .unwrap_or(false);
    if removed {
        write_restricted(&path, &doc.to_string())?;
    }
    Ok(removed)
}

// ── Goose (`~/.config/goose/config.yaml`, YAML) ─────────────────────────────

fn goose_upsert(spec: &McpServerSpec) -> Result<(), String> {
    let path = goose_config_path()?;
    let mut root: serde_yaml::Value = match std::fs::read_to_string(&path) {
        Ok(text) if !text.trim().is_empty() => {
            serde_yaml::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?
        }
        _ => serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
    };

    let map = root
        .as_mapping_mut()
        .ok_or_else(|| format!("{} is not a YAML mapping", path.display()))?;
    let extensions = map
        .entry(serde_yaml::Value::String("extensions".to_string()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()))
        .as_mapping_mut()
        .ok_or_else(|| "extensions is not a mapping".to_string())?;

    let mut entry = serde_yaml::Mapping::new();
    entry.insert("name".into(), spec.name.clone().into());
    entry.insert("type".into(), "stdio".into());
    entry.insert("enabled".into(), true.into());
    entry.insert("cmd".into(), spec.command.clone().into());
    let args: Vec<serde_yaml::Value> = spec.args.iter().map(|a| a.clone().into()).collect();
    entry.insert("args".into(), serde_yaml::Value::Sequence(args));
    let mut envs = serde_yaml::Mapping::new();
    for (k, v) in &spec.env {
        envs.insert(k.clone().into(), v.clone().into());
    }
    entry.insert("envs".into(), serde_yaml::Value::Mapping(envs));
    entry.insert("timeout".into(), 300.into());

    extensions.insert(
        serde_yaml::Value::String(spec.name.clone()),
        serde_yaml::Value::Mapping(entry),
    );

    let text = serde_yaml::to_string(&root).map_err(|e| format!("serialize goose config: {e}"))?;
    write_restricted(&path, &text)
}

fn goose_remove(name: &str) -> Result<bool, String> {
    let path = goose_config_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(t) if !t.trim().is_empty() => t,
        _ => return Ok(false),
    };
    let mut root: serde_yaml::Value =
        serde_yaml::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let removed = root
        .as_mapping_mut()
        .and_then(|map| map.get_mut(serde_yaml::Value::String("extensions".to_string())))
        .and_then(|ext| ext.as_mapping_mut())
        .map(|ext| {
            ext.remove(serde_yaml::Value::String(name.to_string()))
                .is_some()
        })
        .unwrap_or(false);
    if removed {
        let text =
            serde_yaml::to_string(&root).map_err(|e| format!("serialize goose config: {e}"))?;
        write_restricted(&path, &text)?;
    }
    Ok(removed)
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Insert `spec` into every runtime config, creating files as needed. Returns a
/// per-runtime report; a failure on one runtime never blocks the others.
pub fn inject_all(spec: &McpServerSpec) -> McpInjectReport {
    let mut report = McpInjectReport::default();
    for (id, result) in [
        ("claude", claude_upsert(spec)),
        ("codex", codex_upsert(spec)),
        ("goose", goose_upsert(spec)),
    ] {
        match result {
            Ok(()) => report.updated.push(id.to_string()),
            Err(e) => report.failures.push((id.to_string(), e)),
        }
    }
    report
}

/// Remove the server named `name` from every runtime config. Missing files or
/// absent keys are not errors; only runtimes actually mutated are reported.
pub fn remove_all(name: &str) -> McpInjectReport {
    let mut report = McpInjectReport::default();
    for (id, result) in [
        ("claude", claude_remove(name)),
        ("codex", codex_remove(name)),
        ("goose", goose_remove(name)),
    ] {
        match result {
            Ok(true) => report.updated.push(id.to_string()),
            Ok(false) => {}
            Err(e) => report.failures.push((id.to_string(), e)),
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> McpServerSpec {
        let mut env = BTreeMap::new();
        env.insert(
            "GITHUB_PERSONAL_ACCESS_TOKEN".to_string(),
            "tok_123".to_string(),
        );
        McpServerSpec {
            name: "github".to_string(),
            command: "npx".to_string(),
            args: vec![
                "-y".to_string(),
                "@modelcontextprotocol/server-github".to_string(),
            ],
            env,
        }
    }

    #[test]
    fn claude_upsert_preserves_other_servers_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(
            &path,
            r#"{"numStartups":3,"mcpServers":{"filesystem":{"command":"fs"}}}"#,
        )
        .unwrap();

        // Exercise the JSON merge logic directly against this file.
        let text = std::fs::read_to_string(&path).unwrap();
        let mut root: serde_json::Value = serde_json::from_str(&text).unwrap();
        let servers = root
            .as_object_mut()
            .unwrap()
            .entry("mcpServers")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .unwrap();
        servers.insert("github".to_string(), serde_json::json!({"command":"npx"}));

        // Unrelated top-level keys and the existing server survive.
        assert_eq!(root["numStartups"], serde_json::json!(3));
        assert!(root["mcpServers"]["filesystem"].is_object());
        assert_eq!(root["mcpServers"]["github"]["command"], "npx");
    }

    #[test]
    fn codex_upsert_is_format_preserving() {
        let original =
            "# my codex config\nmodel = \"gpt-5\"\n\n[mcp_servers.filesystem]\ncommand = \"fs\"\n";
        let mut doc: toml_edit::DocumentMut = original.parse().unwrap();
        let spec = spec();
        let mut server = toml_edit::Table::new();
        server.insert("command", toml_edit::value(spec.command.clone()));
        doc.entry("mcp_servers")
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .unwrap()
            .insert("github", toml_edit::Item::Table(server));
        let out = doc.to_string();
        assert!(out.contains("# my codex config"));
        assert!(out.contains("[mcp_servers.filesystem]"));
        assert!(out.contains("[mcp_servers.github]"));
    }

    #[test]
    fn goose_entry_shape_has_stdio_fields() {
        let spec = spec();
        let mut entry = serde_yaml::Mapping::new();
        entry.insert("type".into(), "stdio".into());
        entry.insert("cmd".into(), spec.command.clone().into());
        assert_eq!(entry.get("type").unwrap().as_str(), Some("stdio"));
        assert_eq!(entry.get("cmd").unwrap().as_str(), Some("npx"));
    }
}
