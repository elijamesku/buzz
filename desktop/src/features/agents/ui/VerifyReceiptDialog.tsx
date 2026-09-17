import * as React from "react";
import { ShieldCheck, ShieldX } from "lucide-react";

import { verifyWorkReceipt } from "@/shared/api/tauriTrustLedger";
import type { ReceiptVerification } from "@/shared/api/types";
import { truncateNpub } from "@/shared/lib/pubkey";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";

const LEVEL_LABEL: Record<string, string> = {
  ask: "Ask first",
  trusted: "Trusted",
  autonomous: "Autonomous",
};

function formatIssued(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Paste-to-verify for work receipts. Verification is offline and needs no
 * relay: the receipt is a signed event, so the signature alone decides.
 */
export function VerifyReceiptDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const [raw, setRaw] = React.useState("");
  const [result, setResult] = React.useState<ReceiptVerification | null>(null);
  const [busy, setBusy] = React.useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setRaw("");
      setResult(null);
    }
    onOpenChange(next);
  };

  const verify = async () => {
    setBusy(true);
    try {
      setResult(await verifyWorkReceipt(raw));
    } catch (error) {
      setResult({
        valid: false,
        reason: error instanceof Error ? error.message : "Verification failed.",
        issuerPubkey: null,
        agentPubkey: null,
        issuedAt: null,
        summary: null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Verify a work receipt</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste a receipt. Nothing leaves this machine — the signature alone
            decides whether it's real and untampered.
          </p>
          <Textarea
            id="verify-receipt-input"
            className="font-mono text-xs"
            onChange={(event) => setRaw(event.target.value)}
            placeholder='{"id":"…","pubkey":"…","kind":43102,…}'
            rows={6}
            value={raw}
          />
          <Button
            className="w-full"
            disabled={busy || raw.trim().length === 0}
            onClick={() => void verify()}
          >
            {busy ? "Verifying…" : "Verify"}
          </Button>

          {result ? (
            <div
              className="rounded-2xl border border-border/70 bg-muted/30 px-4 py-3"
              data-testid="verify-receipt-result"
            >
              <div className="flex items-center gap-2">
                {result.valid ? (
                  <ShieldCheck className="size-4 text-emerald-600" />
                ) : (
                  <ShieldX className="size-4 text-destructive" />
                )}
                <Badge variant={result.valid ? "success" : "destructive"}>
                  {result.valid ? "Valid" : "Invalid"}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {result.reason}
                </span>
              </div>
              {result.valid && result.summary ? (
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Issuer</dt>
                  <dd className="font-mono text-xs">
                    {truncateNpub(result.issuerPubkey ?? "")}
                  </dd>
                  <dt className="text-muted-foreground">Agent</dt>
                  <dd className="font-mono text-xs">
                    {truncateNpub(result.summary.agentPubkey)}
                  </dd>
                  <dt className="text-muted-foreground">Issued</dt>
                  <dd>{formatIssued(result.issuedAt ?? 0)}</dd>
                  <dt className="text-muted-foreground">Approval</dt>
                  <dd>
                    {result.summary.decided > 0
                      ? `${Math.round(result.summary.approvalRate * 100)}% · ${result.summary.approved} of ${result.summary.decided} sessions`
                      : "No decisions"}
                  </dd>
                  <dt className="text-muted-foreground">Earned level</dt>
                  <dd>
                    {LEVEL_LABEL[result.summary.eligibleLevel] ??
                      result.summary.eligibleLevel}
                  </dd>
                  <dt className="text-muted-foreground">Work</dt>
                  <dd>
                    {result.summary.totalSessions} sessions ·{" "}
                    {result.summary.totalTurns} turns
                    {result.summary.totalCostUsd > 0
                      ? ` · $${result.summary.totalCostUsd.toFixed(2)}`
                      : ""}
                  </dd>
                </dl>
              ) : null}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
