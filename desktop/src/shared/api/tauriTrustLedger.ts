import { invokeTauri } from "@/shared/api/tauri";
import type {
  ReceiptVerification,
  TrustLedger,
  WorkReceipt,
} from "@/shared/api/types";

/** An agent's trust ledger: real sessions, signed decisions, earned level. */
export async function getAgentTrustLedger(
  pubkey: string,
): Promise<TrustLedger> {
  return invokeTauri<TrustLedger>("get_agent_trust_ledger", { pubkey });
}

/** Approve or reject one session. Signs + publishes; returns the fresh ledger. */
export async function recordTrustDecision(input: {
  agentPubkey: string;
  sessionId: string;
  approved: boolean;
  note?: string;
}): Promise<TrustLedger> {
  return invokeTauri<TrustLedger>("record_trust_decision", {
    agentPubkey: input.agentPubkey,
    sessionId: input.sessionId,
    approved: input.approved,
    note: input.note ?? null,
  });
}

/** Mint an owner-signed, portable work receipt for an agent. */
export async function mintWorkReceipt(
  agentPubkey: string,
): Promise<WorkReceipt> {
  return invokeTauri<WorkReceipt>("mint_work_receipt", { agentPubkey });
}

/** Verify a receipt offline — signature, kind, and content consistency. */
export async function verifyWorkReceipt(
  receiptJson: string,
): Promise<ReceiptVerification> {
  return invokeTauri<ReceiptVerification>("verify_work_receipt", {
    receiptJson,
  });
}
