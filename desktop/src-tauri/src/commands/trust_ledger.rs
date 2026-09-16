//! Trust ledger — earned autonomy backed by owner-signed decisions.
//!
//! Every time the owner approves or rejects a session of an agent's real
//! work, a `KIND_TRUST_DECISION` (43101) event is signed and published. The
//! ledger joins those decisions with the agent's own signed turn metrics
//! (`kind:44200`) into an approval rate and the autonomy level the agent has
//! earned. A `KIND_WORK_RECEIPT` (43102) is a portable, owner-signed snapshot
//! of that ledger — verifiable from the signature alone, no relay required.

use std::collections::BTreeMap;

use nostr::{Event, EventBuilder, JsonUtil, Kind, Tag};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app_state::AppState;
use crate::relay::{query_relay, submit_event_with_keys};

const KIND_TRUST_DECISION: u16 = 43101;
const KIND_WORK_RECEIPT: u16 = 43102;
const KIND_AGENT_TURN_METRIC: u16 = 44200;
const RECEIPT_VERSION: u32 = 1;

// Promotion rule: how many decisions, at what approval rate, earn each level.
const TRUSTED_MIN_DECISIONS: u64 = 5;
const TRUSTED_MIN_RATE: f64 = 0.8;
const AUTONOMOUS_MIN_DECISIONS: u64 = 20;
const AUTONOMOUS_MIN_RATE: f64 = 0.9;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustDecision {
    pub id: String,
    pub session_id: String,
    pub approved: bool,
    pub note: String,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSession {
    pub session_id: String,
    pub channel_id: Option<String>,
    pub turns: u64,
    pub cost_usd: f64,
    pub first_at: i64,
    pub last_at: i64,
    pub decision: Option<bool>,
    pub decided_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustLedger {
    pub agent_pubkey: String,
    pub owner_pubkey: String,
    /// Most recent sessions first, capped for display. Totals cover all of them.
    pub sessions: Vec<WorkSession>,
    pub total_sessions: u64,
    pub total_turns: u64,
    pub total_cost_usd: f64,
    pub decided: u64,
    pub approved: u64,
    pub rejected: u64,
    /// 0.0–1.0; 0 when nothing has been decided.
    pub approval_rate: f64,
    /// "ask" | "trusted" | "autonomous" — the level the ledger supports.
    pub eligible_level: String,
    pub next_level_hint: String,
}

/// The signed content of a work receipt. Everything a verifier needs is here
/// or in the event envelope (issuer pubkey, signature, timestamp).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptSummary {
    pub version: u32,
    pub agent_pubkey: String,
    pub owner_pubkey: String,
    pub issued_at: i64,
    pub total_sessions: u64,
    pub total_turns: u64,
    pub total_cost_usd: f64,
    pub decided: u64,
    pub approved: u64,
    pub rejected: u64,
    pub approval_rate: f64,
    pub eligible_level: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkReceipt {
    pub event_id: String,
    /// The full signed event as JSON — this string *is* the receipt.
    pub receipt_json: String,
    pub summary: ReceiptSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptVerification {
    pub valid: bool,
    pub reason: String,
    pub issuer_pubkey: Option<String>,
    pub agent_pubkey: Option<String>,
    pub issued_at: Option<i64>,
    pub summary: Option<ReceiptSummary>,
}

fn owner_keys(state: &AppState) -> Result<nostr::Keys, String> {
    Ok(state.keys.lock().map_err(|e| e.to_string())?.clone())
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event
        .tags
        .iter()
        .find(|tag| tag.kind().to_string() == name)
        .and_then(|tag| tag.content().map(|value| value.to_string()))
}

fn eligible_level(decided: u64, rate: f64) -> (&'static str, String) {
    if decided >= AUTONOMOUS_MIN_DECISIONS && rate >= AUTONOMOUS_MIN_RATE {
        return ("autonomous", "Top level earned.".to_string());
    }
    if decided >= TRUSTED_MIN_DECISIONS && rate >= TRUSTED_MIN_RATE {
        let need = AUTONOMOUS_MIN_DECISIONS.saturating_sub(decided);
        let hint = if need > 0 {
            format!(
                "{need} more decision{} at ≥{}% approval earns Autonomous.",
                if need == 1 { "" } else { "s" },
                (AUTONOMOUS_MIN_RATE * 100.0) as u32
            )
        } else {
            format!(
                "Approval rate must reach {}% to earn Autonomous.",
                (AUTONOMOUS_MIN_RATE * 100.0) as u32
            )
        };
        return ("trusted", hint);
    }
    let need = TRUSTED_MIN_DECISIONS.saturating_sub(decided);
    let hint = if need > 0 {
        format!(
            "{need} more decision{} at ≥{}% approval earns Trusted.",
            if need == 1 { "" } else { "s" },
            (TRUSTED_MIN_RATE * 100.0) as u32
        )
    } else {
        format!(
            "Approval rate must reach {}% to earn Trusted.",
            (TRUSTED_MIN_RATE * 100.0) as u32
        )
    };
    ("ask", hint)
}

async fn load_sessions(
    state: &AppState,
    owner: &nostr::Keys,
    agent: &str,
) -> Result<BTreeMap<String, WorkSession>, String> {
    let events = query_relay(
        state,
        &[serde_json::json!({
            "kinds": [KIND_AGENT_TURN_METRIC],
            "authors": [agent],
            "limit": 1000,
        })],
    )
    .await?;

    let mut sessions: BTreeMap<String, WorkSession> = BTreeMap::new();
    for event in &events {
        let Ok(payload) = buzz_core_pkg::agent_turn_metric::decrypt_agent_turn_metric(owner, event)
        else {
            continue;
        };
        let Some(session_id) = payload.session_id.clone() else {
            continue;
        };
        let at = chrono::DateTime::parse_from_rfc3339(&payload.timestamp)
            .map(|ts| ts.timestamp())
            .unwrap_or(event.created_at.as_secs() as i64);
        let cost = payload
            .turn
            .as_ref()
            .and_then(|turn| turn.cost_usd)
            .unwrap_or(0.0);
        let entry = sessions
            .entry(session_id.clone())
            .or_insert_with(|| WorkSession {
                session_id,
                channel_id: payload.channel_id.clone(),
                turns: 0,
                cost_usd: 0.0,
                first_at: at,
                last_at: at,
                decision: None,
                decided_at: None,
            });
        entry.turns += 1;
        entry.cost_usd += cost;
        entry.first_at = entry.first_at.min(at);
        entry.last_at = entry.last_at.max(at);
        if entry.channel_id.is_none() {
            entry.channel_id = payload.channel_id.clone();
        }
    }
    Ok(sessions)
}

async fn load_decisions(
    state: &AppState,
    owner_hex: &str,
    agent: &str,
) -> Result<Vec<TrustDecision>, String> {
    let events = query_relay(
        state,
        &[serde_json::json!({
            "kinds": [KIND_TRUST_DECISION],
            "authors": [owner_hex],
            "limit": 1000,
        })],
    )
    .await?;
    let mut decisions: Vec<TrustDecision> = events
        .iter()
        .filter(|event| tag_value(event, "agent").as_deref() == Some(agent))
        .filter_map(|event| {
            let session_id = tag_value(event, "session")?;
            let approved = match tag_value(event, "decision").as_deref() {
                Some("approved") => true,
                Some("rejected") => false,
                _ => return None,
            };
            Some(TrustDecision {
                id: event.id.to_hex(),
                session_id,
                approved,
                note: event.content.clone(),
                at: event.created_at.as_secs() as i64,
            })
        })
        .collect();
    decisions.sort_by_key(|decision| decision.at);
    Ok(decisions)
}

fn build_ledger(
    agent: &str,
    owner: &str,
    mut sessions: BTreeMap<String, WorkSession>,
    decisions: &[TrustDecision],
) -> TrustLedger {
    // The latest decision per session wins; decisions are sorted ascending.
    let mut latest: BTreeMap<&str, &TrustDecision> = BTreeMap::new();
    for decision in decisions {
        latest.insert(decision.session_id.as_str(), decision);
    }
    for (session_id, decision) in &latest {
        if let Some(session) = sessions.get_mut(*session_id) {
            session.decision = Some(decision.approved);
            session.decided_at = Some(decision.at);
        }
    }

    let decided = latest.len() as u64;
    let approved = latest.values().filter(|d| d.approved).count() as u64;
    let rejected = decided - approved;
    let approval_rate = if decided == 0 {
        0.0
    } else {
        approved as f64 / decided as f64
    };
    let (level, hint) = eligible_level(decided, approval_rate);

    let total_sessions = sessions.len() as u64;
    let total_turns = sessions.values().map(|s| s.turns).sum();
    let total_cost_usd = sessions.values().map(|s| s.cost_usd).sum();

    let mut recent: Vec<WorkSession> = sessions.into_values().collect();
    recent.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    recent.truncate(25);

    TrustLedger {
        agent_pubkey: agent.to_string(),
        owner_pubkey: owner.to_string(),
        sessions: recent,
        total_sessions,
        total_turns,
        total_cost_usd,
        decided,
        approved,
        rejected,
        approval_rate,
        eligible_level: level.to_string(),
        next_level_hint: hint,
    }
}

async fn compute_ledger(state: &AppState, agent: &str) -> Result<TrustLedger, String> {
    let owner = owner_keys(state)?;
    let owner_hex = owner.public_key().to_hex();
    let sessions = load_sessions(state, &owner, agent).await?;
    let decisions = load_decisions(state, &owner_hex, agent).await?;
    Ok(build_ledger(agent, &owner_hex, sessions, &decisions))
}

/// An agent's trust ledger: its real work sessions, the owner's signed
/// decisions on them, and the autonomy level those decisions have earned.
#[tauri::command]
pub async fn get_agent_trust_ledger(
    state: State<'_, AppState>,
    pubkey: String,
) -> Result<TrustLedger, String> {
    let agent = pubkey.trim().to_lowercase();
    compute_ledger(&state, &agent).await
}

/// Approve or reject one of an agent's work sessions. Signs and publishes a
/// `KIND_TRUST_DECISION` event, then returns the refreshed ledger.
#[tauri::command]
pub async fn record_trust_decision(
    state: State<'_, AppState>,
    agent_pubkey: String,
    session_id: String,
    approved: bool,
    note: Option<String>,
) -> Result<TrustLedger, String> {
    let agent = agent_pubkey.trim().to_lowercase();
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session id is required".to_string());
    }
    let keys = owner_keys(&state)?;
    let decision = if approved { "approved" } else { "rejected" };
    let builder = EventBuilder::new(Kind::Custom(KIND_TRUST_DECISION), note.unwrap_or_default())
        .tags([
            Tag::parse(["agent", &agent]).map_err(|e| e.to_string())?,
            Tag::parse(["p", &agent]).map_err(|e| e.to_string())?,
            Tag::parse(["session", &session_id]).map_err(|e| e.to_string())?,
            Tag::parse(["decision", decision]).map_err(|e| e.to_string())?,
        ]);
    submit_event_with_keys(builder, &state, &keys, None).await?;
    compute_ledger(&state, &agent).await
}

/// Mint a portable, owner-signed work receipt for an agent from its ledger.
/// The receipt is published to the relay (on the record) and returned as the
/// signed event JSON, which is what gets shared and verified.
#[tauri::command]
pub async fn mint_work_receipt(
    state: State<'_, AppState>,
    agent_pubkey: String,
) -> Result<WorkReceipt, String> {
    let agent = agent_pubkey.trim().to_lowercase();
    let keys = owner_keys(&state)?;
    let ledger = compute_ledger(&state, &agent).await?;
    let summary = ReceiptSummary {
        version: RECEIPT_VERSION,
        agent_pubkey: ledger.agent_pubkey.clone(),
        owner_pubkey: ledger.owner_pubkey.clone(),
        issued_at: chrono::Utc::now().timestamp(),
        total_sessions: ledger.total_sessions,
        total_turns: ledger.total_turns,
        total_cost_usd: ledger.total_cost_usd,
        decided: ledger.decided,
        approved: ledger.approved,
        rejected: ledger.rejected,
        approval_rate: ledger.approval_rate,
        eligible_level: ledger.eligible_level.clone(),
    };
    let content = serde_json::to_string(&summary).map_err(|e| e.to_string())?;
    let event = EventBuilder::new(Kind::Custom(KIND_WORK_RECEIPT), content)
        .tags([
            Tag::parse(["agent", &agent]).map_err(|e| e.to_string())?,
            Tag::parse(["p", &agent]).map_err(|e| e.to_string())?,
        ])
        .sign_with_keys(&keys)
        .map_err(|e| format!("failed to sign receipt: {e}"))?;
    crate::relay::submit_signed_event_with_keys(&event, &state, &keys, None).await?;
    Ok(WorkReceipt {
        event_id: event.id.to_hex(),
        receipt_json: event.as_json(),
        summary,
    })
}

fn invalid(reason: &str) -> ReceiptVerification {
    ReceiptVerification {
        valid: false,
        reason: reason.to_string(),
        issuer_pubkey: None,
        agent_pubkey: None,
        issued_at: None,
        summary: None,
    }
}

/// Verify a work receipt offline: signature, kind, and that the signed
/// summary agrees with the envelope. Needs no relay and no owner keys.
#[tauri::command]
pub fn verify_work_receipt(receipt_json: String) -> ReceiptVerification {
    let Ok(event) = Event::from_json(receipt_json.trim()) else {
        return invalid("Not a signed Buzz event.");
    };
    if event.verify().is_err() {
        return invalid("Signature does not match the issuer — the receipt was altered or forged.");
    }
    if event.kind.as_u16() != KIND_WORK_RECEIPT {
        return invalid("Signed event is not a work receipt.");
    }
    let Ok(summary) = serde_json::from_str::<ReceiptSummary>(&event.content) else {
        return invalid("Receipt content is malformed.");
    };
    let issuer = event.pubkey.to_hex();
    if summary.owner_pubkey != issuer {
        return invalid("Receipt claims a different issuer than the key that signed it.");
    }
    if tag_value(&event, "agent").as_deref() != Some(summary.agent_pubkey.as_str()) {
        return invalid("Receipt's agent tag does not match its signed content.");
    }
    ReceiptVerification {
        valid: true,
        reason: "Signature valid. Issued by the workspace owner.".to_string(),
        issuer_pubkey: Some(issuer),
        agent_pubkey: Some(summary.agent_pubkey.clone()),
        issued_at: Some(event.created_at.as_secs() as i64),
        summary: Some(summary),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decision(session: &str, approved: bool, at: i64) -> TrustDecision {
        TrustDecision {
            id: format!("{session}-{at}"),
            session_id: session.to_string(),
            approved,
            note: String::new(),
            at,
        }
    }

    fn session(id: &str, last_at: i64) -> WorkSession {
        WorkSession {
            session_id: id.to_string(),
            channel_id: None,
            turns: 3,
            cost_usd: 0.5,
            first_at: last_at - 60,
            last_at,
            decision: None,
            decided_at: None,
        }
    }

    #[test]
    fn eligible_level_follows_promotion_rule() {
        assert_eq!(eligible_level(0, 0.0).0, "ask");
        assert_eq!(eligible_level(4, 1.0).0, "ask");
        assert_eq!(eligible_level(5, 0.8).0, "trusted");
        assert_eq!(eligible_level(19, 1.0).0, "trusted");
        assert_eq!(eligible_level(20, 0.9).0, "autonomous");
        assert_eq!(eligible_level(20, 0.85).0, "trusted");
    }

    #[test]
    fn latest_decision_per_session_wins() {
        let mut sessions = BTreeMap::new();
        sessions.insert("s1".to_string(), session("s1", 100));
        sessions.insert("s2".to_string(), session("s2", 200));
        let decisions = vec![
            decision("s1", false, 10),
            decision("s1", true, 20),
            decision("s2", false, 30),
        ];
        let ledger = build_ledger("agent", "owner", sessions, &decisions);
        assert_eq!(ledger.decided, 2);
        assert_eq!(ledger.approved, 1);
        assert_eq!(ledger.rejected, 1);
        assert!((ledger.approval_rate - 0.5).abs() < f64::EPSILON);
        let s1 = ledger
            .sessions
            .iter()
            .find(|s| s.session_id == "s1")
            .unwrap();
        assert_eq!(s1.decision, Some(true));
        assert_eq!(ledger.sessions[0].session_id, "s2", "newest session first");
    }

    #[test]
    fn minted_receipt_round_trips_through_verify() {
        let keys = nostr::Keys::generate();
        let agent = "a".repeat(64);
        let summary = ReceiptSummary {
            version: RECEIPT_VERSION,
            agent_pubkey: agent.clone(),
            owner_pubkey: keys.public_key().to_hex(),
            issued_at: 1,
            total_sessions: 3,
            total_turns: 9,
            total_cost_usd: 1.25,
            decided: 3,
            approved: 3,
            rejected: 0,
            approval_rate: 1.0,
            eligible_level: "ask".to_string(),
        };
        let event = EventBuilder::new(
            Kind::Custom(KIND_WORK_RECEIPT),
            serde_json::to_string(&summary).unwrap(),
        )
        .tags([Tag::parse(["agent", &agent]).unwrap()])
        .sign_with_keys(&keys)
        .unwrap();

        let ok = verify_work_receipt(event.as_json());
        assert!(ok.valid, "{}", ok.reason);
        assert_eq!(
            ok.issuer_pubkey.as_deref(),
            Some(keys.public_key().to_hex().as_str())
        );

        // Tamper with the signed content: signature must fail. The content
        // is a JSON string inside the event JSON, so its quotes are escaped.
        let tampered = event
            .as_json()
            .replace("\\\"approved\\\":3", "\\\"approved\\\":30");
        assert_ne!(tampered, event.as_json(), "tamper must change the bytes");
        let bad = verify_work_receipt(tampered);
        assert!(!bad.valid);
    }

    #[test]
    fn wrong_kind_is_rejected() {
        let keys = nostr::Keys::generate();
        let event = EventBuilder::new(Kind::Custom(KIND_TRUST_DECISION), "")
            .sign_with_keys(&keys)
            .unwrap();
        assert!(!verify_work_receipt(event.as_json()).valid);
    }
}
