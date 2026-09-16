import assert from "node:assert/strict";
import test from "node:test";

import { bucketActivity, reconstructAt } from "./reconstruct.ts";

const AGENT = "a".repeat(64);
const HUMAN = "b".repeat(64);

function ev(partial) {
  return {
    id: partial.id ?? `${partial.kind}-${partial.at}`,
    kind: partial.kind,
    at: partial.at,
    author: partial.author ?? HUMAN,
    channelId: partial.channelId ?? null,
    agent: partial.agent ?? null,
    sessionId: partial.sessionId ?? null,
    refId: partial.refId ?? null,
    preview: partial.preview ?? "",
  };
}

test("reconstructAt_ignoresEventsAfterTheInstant", () => {
  const events = [
    ev({ kind: 40002, at: 100, channelId: "c1" }),
    ev({ kind: 40002, at: 200, channelId: "c2" }),
  ];
  const snap = reconstructAt(events, 150, 60);
  assert.equal(snap.history.length, 1);
  assert.deepEqual(
    snap.liveChannels.map((c) => c.channelId),
    ["c1"],
  );
});

test("reconstructAt_agentIsWorkingOnlyInsideTheActiveWindow", () => {
  const events = [ev({ kind: 44200, at: 100, author: AGENT, channelId: "c1" })];
  assert.equal(reconstructAt(events, 150, 60).activeAgents.length, 1);
  assert.equal(reconstructAt(events, 500, 60).activeAgents.length, 0);
  assert.equal(reconstructAt(events, 150, 60).activeAgents[0].pubkey, AGENT);
});

test("reconstructAt_openJobsCloseOnResultCancelOrError", () => {
  const events = [
    ev({ id: "j1", kind: 43001, at: 10 }),
    ev({ id: "j2", kind: 43001, at: 11 }),
    ev({ id: "j3", kind: 43001, at: 12 }),
    ev({ kind: 43004, at: 20, refId: "j1" }),
    ev({ kind: 43006, at: 21, refId: "j2" }),
  ];
  const before = reconstructAt(events, 15);
  assert.equal(before.openJobs.length, 3);
  const after = reconstructAt(events, 30);
  assert.deepEqual(
    after.openJobs.map((j) => j.id),
    ["j3"],
  );
});

test("reconstructAt_pendingApprovalsCloseOnGrantOrDeny", () => {
  const events = [
    ev({ id: "a1", kind: 46010, at: 10 }),
    ev({ id: "a2", kind: 46010, at: 11 }),
    ev({ kind: 46030, at: 20, refId: "a1" }),
  ];
  const snap = reconstructAt(events, 30);
  assert.deepEqual(
    snap.pendingApprovals.map((a) => a.id),
    ["a2"],
  );
});

test("reconstructAt_huddleIsLiveUntilEnded", () => {
  const events = [
    ev({ id: "h1", kind: 48100, at: 10, channelId: "c1" }),
    ev({ kind: 48103, at: 50, refId: "h1", channelId: "c1" }),
  ];
  assert.equal(reconstructAt(events, 30).liveHuddles.length, 1);
  assert.equal(reconstructAt(events, 60).liveHuddles.length, 0);
});

test("reconstructAt_countsTrustDecisionsAndReceiptsWithoutMarkingAgentActive", () => {
  const events = [
    ev({ kind: 43101, at: 10, agent: AGENT }),
    ev({ kind: 43102, at: 11, agent: AGENT }),
  ];
  const snap = reconstructAt(events, 20, 60);
  assert.equal(snap.trustDecisions, 1);
  assert.equal(snap.receipts, 1);
  assert.equal(
    snap.activeAgents.length,
    0,
    "decisions and receipts are about the agent, not the agent working",
  );
});

test("bucketActivity_distributesEventsAcrossBuckets", () => {
  const events = [
    ev({ kind: 40002, at: 0 }),
    ev({ kind: 40002, at: 5 }),
    ev({ kind: 40002, at: 99 }),
    ev({ kind: 40002, at: 100 }),
    ev({ kind: 40002, at: 500 }), // outside range — ignored
  ];
  const buckets = bucketActivity(events, 0, 100, 4);
  assert.equal(buckets.length, 4);
  assert.equal(buckets[0], 2);
  assert.equal(buckets[3], 2);
  assert.equal(
    buckets.reduce((a, b) => a + b, 0),
    4,
  );
});
