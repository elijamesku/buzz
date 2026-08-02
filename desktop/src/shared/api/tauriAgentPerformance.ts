import { invokeTauri } from "@/shared/api/tauri";
import type { AgentPerformance } from "@/shared/api/types";

/**
 * Aggregate an agent's provable performance from its archived turn metrics
 * (kind 44200 — real token usage + cost). Returns all zeros when metric
 * archiving is off or the agent hasn't run; the numbers are never estimated.
 */
export async function getAgentPerformance(
  pubkey: string,
): Promise<AgentPerformance> {
  return invokeTauri<AgentPerformance>("get_agent_performance", { pubkey });
}
