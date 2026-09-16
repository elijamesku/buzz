//! Time machine — the org's history as a scrubbable, replayable timeline.
//!
//! Everything in Buzz is a signed event, so "what was happening at 3:12pm"
//! is a query, not a guess. This returns a compact, time-ordered slice of the
//! event log; the desktop reconstructs who was working, which rooms were
//! live, and what was in flight at any instant from it.

use nostr::Event;
use serde::Serialize;
use tauri::State;

use crate::app_state::AppState;
use crate::relay::query_relay;

const KIND_AGENT_TURN_METRIC: u32 = 44200;
const PREVIEW_CHARS: usize = 140;

// Grouped so each filter stays small; groups never overlap so no event is
// returned twice.
const KIND_GROUPS: &[&[u32]] = &[
    &[40002, 40099],
    &[43001, 43002, 43003, 43004, 43005, 43006],
    &[43101, 43102],
    &[KIND_AGENT_TURN_METRIC],
    &[45001, 45003],
    &[
        46001, 46002, 46003, 46004, 46005, 46006, 46007, 46010, 46011, 46012, 46030, 46031,
    ],
    &[48100, 48101, 48102, 48103, 48107, 48108],
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub id: String,
    pub kind: u32,
    /// Unix seconds.
    pub at: i64,
    pub author: String,
    pub channel_id: Option<String>,
    /// The agent this event is about (turn metrics: the author).
    pub agent: Option<String>,
    pub session_id: Option<String>,
    /// The event this one references (`e` tag) — job results point at their
    /// request, approvals at what they approve.
    pub ref_id: Option<String>,
    pub preview: String,
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event
        .tags
        .iter()
        .find(|tag| tag.kind().to_string() == name)
        .and_then(|tag| tag.content().map(|value| value.to_string()))
}

fn preview_of(content: &str) -> String {
    let single_line = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.chars().count() <= PREVIEW_CHARS {
        return single_line;
    }
    let cut: String = single_line.chars().take(PREVIEW_CHARS - 1).collect();
    format!("{cut}…")
}

fn describe(event: &Event, model: Option<&str>) -> String {
    match event.kind.as_u16() as u32 {
        KIND_AGENT_TURN_METRIC => match model {
            Some(model) => format!("Completed a turn · {model}"),
            None => "Completed a turn".to_string(),
        },
        43101 => {
            let decision = tag_value(event, "decision").unwrap_or_default();
            let note = preview_of(&event.content);
            if note.is_empty() {
                format!("Work {decision}")
            } else {
                format!("Work {decision} — {note}")
            }
        }
        43102 => "Work receipt minted".to_string(),
        48100 => "Huddle started".to_string(),
        48101 => "Joined the huddle".to_string(),
        48102 => "Left the huddle".to_string(),
        48103 => "Huddle ended".to_string(),
        48108 => format!("Meeting summary — {}", preview_of(&event.content)),
        _ => preview_of(&event.content),
    }
}

/// A time-ordered slice of the workspace's event log between `since` and
/// `until` (unix seconds), capped per kind group by `limit`.
#[tauri::command]
pub async fn get_org_timeline(
    state: State<'_, AppState>,
    since: i64,
    until: i64,
    limit: Option<u32>,
) -> Result<Vec<TimelineEvent>, String> {
    if until < since {
        return Err("until must not be before since".to_string());
    }
    let since = since.max(0) as u64;
    let until = until.max(0) as u64;
    let per_group = limit.unwrap_or(400).clamp(1, 1000);

    let filters: Vec<serde_json::Value> = KIND_GROUPS
        .iter()
        .map(|kinds| {
            serde_json::json!({
                "kinds": kinds,
                "since": since,
                "until": until,
                "limit": per_group,
            })
        })
        .collect();
    let events = query_relay(&state, &filters).await?;
    let owner = state.keys.lock().map_err(|e| e.to_string())?.clone();

    let mut timeline: Vec<TimelineEvent> = events
        .iter()
        .map(|event| {
            let kind = event.kind.as_u16() as u32;
            let mut channel_id = tag_value(event, "h");
            let mut session_id = tag_value(event, "session");
            let mut model: Option<String> = None;
            let agent = if kind == KIND_AGENT_TURN_METRIC {
                // Metrics are encrypted to the owner; decrypt when we can so
                // the timeline knows the channel and session, else keep the
                // envelope facts (author + time), which are still signed.
                if let Ok(payload) =
                    buzz_core_pkg::agent_turn_metric::decrypt_agent_turn_metric(&owner, event)
                {
                    if channel_id.is_none() {
                        channel_id = payload.channel_id.clone();
                    }
                    session_id = payload.session_id.clone();
                    model = payload.model.clone();
                }
                Some(event.pubkey.to_hex())
            } else {
                tag_value(event, "agent")
            };
            TimelineEvent {
                id: event.id.to_hex(),
                kind,
                at: event.created_at.as_secs() as i64,
                author: event.pubkey.to_hex(),
                channel_id,
                agent,
                session_id,
                ref_id: tag_value(event, "e"),
                preview: describe(event, model.as_deref()),
            }
        })
        .collect();
    timeline.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
    timeline.dedup_by(|a, b| a.id == b.id);
    Ok(timeline)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_collapses_whitespace_and_truncates() {
        assert_eq!(preview_of("hello\n\n  world"), "hello world");
        let long = "x".repeat(500);
        let preview = preview_of(&long);
        assert_eq!(preview.chars().count(), PREVIEW_CHARS);
        assert!(preview.ends_with('…'));
    }

    #[test]
    fn kind_groups_do_not_overlap() {
        let mut seen = std::collections::HashSet::new();
        for group in KIND_GROUPS {
            for kind in *group {
                assert!(seen.insert(*kind), "kind {kind} appears in two groups");
            }
        }
    }
}
