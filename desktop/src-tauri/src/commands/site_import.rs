//! Website import — capture a site's pages and assets into a local workspace so
//! agents can rebuild it as code ("Claude design").
//!
//! A team member pastes a site URL (e.g. their Webflow marketing site) in the
//! Design settings. This performs a bounded, same-origin crawl: it snapshots
//! each page's raw HTML, downloads the same-origin assets those pages reference
//! (stylesheets, images, scripts, fonts), and writes a `MIGRATION.md` brief.
//! The output lands in `~/buzz-site-imports/<host>_<timestamp>/` — a clean
//! source of truth an agent then rebuilds into an Astro/Tailwind codebase.
//!
//! It does NOT execute page JavaScript, which suits mostly-static marketing
//! sites (Webflow output is static HTML/CSS). Requests are SSRF-guarded: URLs
//! resolving to private/loopback addresses are refused.

use std::collections::{BTreeSet, VecDeque};
use std::hash::{Hash, Hasher};
use std::net::{IpAddr, ToSocketAddrs};
use std::path::Path;

use serde::Serialize;
use url::Url;

const DEFAULT_MAX_PAGES: u32 = 12;
const HARD_MAX_PAGES: u32 = 50;
const MAX_ASSETS: usize = 300;
const MAX_BYTES_PER_FILE: usize = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_SECS: u64 = 20;
const USER_AGENT: &str = "buzz-desktop-site-import";
const ASSET_EXTS: &[&str] = &[
    "css", "js", "mjs", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "woff", "woff2",
    "ttf", "otf", "eot", "mp4", "webm", "pdf", "json", "xml", "txt",
];

// ── Serialized shapes ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPage {
    pub url: String,
    /// Path relative to the import destination (e.g. `pages/index.html`).
    pub path: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteImportResult {
    /// Absolute path to the import workspace directory.
    pub destination: String,
    pub host: String,
    pub pages: Vec<ImportedPage>,
    pub asset_count: usize,
    /// Non-fatal issues (skipped/failed pages or assets).
    pub warnings: Vec<String>,
}

// ── SSRF guard ──────────────────────────────────────────────────────────────

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // CGNAT 100.64.0.0/10
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // ULA fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // link-local fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Refuse URLs that are not http(s) or that resolve to a private/internal host.
fn ensure_public_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("unsupported URL scheme: {}", url.scheme()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    if host.eq_ignore_ascii_case("localhost") {
        return Err("refusing to fetch localhost".to_string());
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("could not resolve {host}: {e}"))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_private_ip(addr.ip()) {
            return Err(format!(
                "refusing to fetch {host}: resolves to a private/internal address"
            ));
        }
    }
    if !any {
        return Err(format!("could not resolve {host}"));
    }
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|e| format!("build http client: {e}"))
}

fn short_hash(input: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn extension_of(url: &Url) -> Option<String> {
    let path = url.path();
    let last = path.rsplit('/').next()?;
    let ext = last.rsplit_once('.')?.1;
    if ext.is_empty() || ext.len() > 5 {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

fn looks_like_asset(url: &Url) -> bool {
    extension_of(url)
        .map(|ext| ASSET_EXTS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Turn a page URL into a stable, filesystem-safe HTML filename.
fn page_filename(url: &Url) -> String {
    let trimmed = url.path().trim_matches('/');
    if trimmed.is_empty() {
        return "index.html".to_string();
    }
    let mut slug: String = trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    if !slug.to_ascii_lowercase().ends_with("_html") && !slug.to_ascii_lowercase().ends_with("html")
    {
        slug.push_str("_html");
    }
    // Replace the trailing `_html` marker with a real extension.
    let base = slug.trim_end_matches("_html").trim_end_matches("html");
    let base = base.trim_end_matches('_');
    let base = if base.is_empty() { "index" } else { base };
    format!("{base}.html")
}

fn asset_filename(url: &Url) -> String {
    let last = url.path().rsplit('/').next().unwrap_or("");
    let (stem, ext) = match last.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, e),
        _ => (last, "bin"),
    };
    let safe_stem: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(48)
        .collect();
    let safe_stem = if safe_stem.is_empty() {
        "asset"
    } else {
        &safe_stem
    };
    // Prefix a short hash of the full URL so same-named assets from different
    // paths never collide.
    format!("{}_{}.{}", short_hash(url.as_str()), safe_stem, ext)
}

/// Normalize a URL for the visited set: drop the fragment and any trailing
/// slash so `/about` and `/about/` and `/about#top` are one page.
fn canonical_key(url: &Url) -> String {
    let mut u = url.clone();
    u.set_fragment(None);
    let s = u.as_str().trim_end_matches('/').to_string();
    s
}

/// Extract `href`/`src` attribute values from raw HTML.
fn extract_links(html: &str) -> Vec<String> {
    // Not a full HTML parser — a targeted attribute scan. Good enough to
    // discover pages and assets on static marketing sites.
    let re = regex::Regex::new(r#"(?i)(?:href|src|data-src)\s*=\s*["']([^"'>\s]+)["']"#)
        .expect("static regex");
    re.captures_iter(html)
        .filter_map(|c| c.get(1).map(|m| m.as_str().to_string()))
        .collect()
}

fn same_host(a: &Url, b: &Url) -> bool {
    match (a.host_str(), b.host_str()) {
        (Some(x), Some(y)) => x.eq_ignore_ascii_case(y),
        _ => false,
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("write {}: {e}", path.display()))
}

// ── Crawl ───────────────────────────────────────────────────────────────────

fn run_import(entry: &str, max_pages: u32) -> Result<SiteImportResult, String> {
    let entry_url = Url::parse(entry.trim()).map_err(|e| format!("invalid URL: {e}"))?;
    ensure_public_url(&entry_url)?;

    let host = entry_url
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?
        .to_string();
    let max_pages = max_pages.clamp(1, HARD_MAX_PAGES);

    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let safe_host: String = host
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let dest = home
        .join("buzz-site-imports")
        .join(format!("{safe_host}_{stamp}"));

    let http = client()?;
    let mut warnings: Vec<String> = Vec::new();
    let mut pages: Vec<ImportedPage> = Vec::new();
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut assets_seen: BTreeSet<String> = BTreeSet::new();
    let mut asset_count = 0usize;

    let mut queue: VecDeque<Url> = VecDeque::new();
    queue.push_back(entry_url.clone());
    visited.insert(canonical_key(&entry_url));

    while let Some(page_url) = queue.pop_front() {
        if pages.len() as u32 >= max_pages {
            break;
        }
        // Re-validate every URL we actually fetch (queue only ever holds
        // same-host links, but this keeps the SSRF guard on the hot path).
        if let Err(e) = ensure_public_url(&page_url) {
            warnings.push(format!("skip {page_url}: {e}"));
            continue;
        }

        let resp = match http.get(page_url.clone()).send() {
            Ok(r) => r,
            Err(e) => {
                warnings.push(format!("fetch {page_url} failed: {e}"));
                continue;
            }
        };
        if !resp.status().is_success() {
            warnings.push(format!("fetch {page_url}: HTTP {}", resp.status()));
            continue;
        }
        let is_html = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|ct| ct.contains("text/html"))
            .unwrap_or(true);
        let body = match resp.text() {
            Ok(b) => b,
            Err(e) => {
                warnings.push(format!("read {page_url} failed: {e}"));
                continue;
            }
        };
        if !is_html {
            continue;
        }

        let filename = page_filename(&page_url);
        let rel = format!("pages/{filename}");
        if let Err(e) = write_file(&dest.join(&rel), body.as_bytes()) {
            warnings.push(e);
            continue;
        }
        pages.push(ImportedPage {
            url: page_url.to_string(),
            path: rel,
            bytes: body.len(),
        });

        // Discover links: enqueue same-host pages, download same-host assets.
        for raw in extract_links(&body) {
            if raw.starts_with("data:")
                || raw.starts_with("mailto:")
                || raw.starts_with("tel:")
                || raw.starts_with("javascript:")
            {
                continue;
            }
            let Ok(resolved) = page_url.join(&raw) else {
                continue;
            };
            if !same_host(&resolved, &entry_url) {
                continue;
            }
            if looks_like_asset(&resolved) {
                if asset_count >= MAX_ASSETS {
                    continue;
                }
                let key = canonical_key(&resolved);
                if !assets_seen.insert(key) {
                    continue;
                }
                match download_asset(&http, &resolved, &dest) {
                    Ok(()) => asset_count += 1,
                    Err(e) => warnings.push(e),
                }
            } else {
                let key = canonical_key(&resolved);
                if visited.contains(&key) {
                    continue;
                }
                // Only enqueue if we still have page budget.
                if (visited.len() as u32) < HARD_MAX_PAGES {
                    visited.insert(key);
                    queue.push_back(resolved);
                }
            }
        }
    }

    if pages.is_empty() {
        return Err(format!(
            "no pages could be captured from {host} (site may be JS-rendered or blocked)"
        ));
    }

    write_migration_brief(&dest, &host, &entry_url, &pages, asset_count).unwrap_or_else(|e| {
        warnings.push(format!("MIGRATION.md not written: {e}"));
    });

    Ok(SiteImportResult {
        destination: dest.to_string_lossy().into_owned(),
        host,
        pages,
        asset_count,
        warnings,
    })
}

fn download_asset(http: &reqwest::blocking::Client, url: &Url, dest: &Path) -> Result<(), String> {
    let resp = http
        .get(url.clone())
        .send()
        .map_err(|e| format!("asset {url} failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("asset {url}: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .map_err(|e| format!("asset {url} read failed: {e}"))?;
    if bytes.len() > MAX_BYTES_PER_FILE {
        return Err(format!("asset {url} skipped: exceeds size cap"));
    }
    write_file(&dest.join("assets").join(asset_filename(url)), &bytes)
}

fn write_migration_brief(
    dest: &Path,
    host: &str,
    entry: &Url,
    pages: &[ImportedPage],
    asset_count: usize,
) -> Result<(), String> {
    let mut md = String::new();
    md.push_str(&format!("# Site import — {host}\n\n"));
    md.push_str(&format!("- **Source:** {entry}\n"));
    md.push_str(&format!(
        "- **Captured:** {}\n",
        chrono::Utc::now().to_rfc3339()
    ));
    md.push_str(&format!("- **Pages:** {}\n", pages.len()));
    md.push_str(&format!("- **Assets:** {asset_count}\n\n"));
    md.push_str("## Pages\n\n");
    for page in pages {
        md.push_str(&format!("- `{}` — {}\n", page.path, page.url));
    }
    md.push_str(
        "\n## Next steps (Claude design)\n\n\
         Raw HTML is in `pages/`, downloaded assets in `assets/`. Hand this \
         directory to an agent to rebuild the site as an Astro + Tailwind \
         codebase: extract the design tokens (colors, spacing, type), turn \
         shared markup into components, and port each page. This capture is \
         the source of truth — no page JavaScript was executed.\n",
    );
    write_file(&dest.join("MIGRATION.md"), md.as_bytes())
}

// ── Command ─────────────────────────────────────────────────────────────────

/// Import a website: crawl same-origin pages (bounded), snapshot HTML, download
/// referenced same-origin assets, and write a migration brief. Returns a
/// summary of what was captured and where.
#[tauri::command]
pub async fn import_website(
    url: String,
    max_pages: Option<u32>,
) -> Result<SiteImportResult, String> {
    let max = max_pages.unwrap_or(DEFAULT_MAX_PAGES);
    tokio::task::spawn_blocking(move || run_import(&url, max))
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssrf_blocks_private_and_localhost() {
        assert!(ensure_public_url(&Url::parse("http://localhost/").unwrap()).is_err());
        assert!(ensure_public_url(&Url::parse("http://127.0.0.1/").unwrap()).is_err());
        assert!(ensure_public_url(&Url::parse("http://192.168.1.10/").unwrap()).is_err());
        assert!(ensure_public_url(&Url::parse("ftp://example.com/").unwrap()).is_err());
    }

    #[test]
    fn page_filename_slugs() {
        assert_eq!(
            page_filename(&Url::parse("https://x.com/").unwrap()),
            "index.html"
        );
        assert_eq!(
            page_filename(&Url::parse("https://x.com/about").unwrap()),
            "about.html"
        );
        assert_eq!(
            page_filename(&Url::parse("https://x.com/blog/post-1").unwrap()),
            "blog_post_1.html"
        );
    }

    #[test]
    fn classifies_assets() {
        assert!(looks_like_asset(
            &Url::parse("https://x.com/a/style.css").unwrap()
        ));
        assert!(looks_like_asset(
            &Url::parse("https://x.com/logo.png").unwrap()
        ));
        assert!(!looks_like_asset(
            &Url::parse("https://x.com/about").unwrap()
        ));
    }

    #[test]
    fn extracts_href_and_src() {
        let html = r#"<a href="/about">A</a><img src="/logo.png"><link href="/s.css">"#;
        let links = extract_links(html);
        assert!(links.contains(&"/about".to_string()));
        assert!(links.contains(&"/logo.png".to_string()));
        assert!(links.contains(&"/s.css".to_string()));
    }
}
