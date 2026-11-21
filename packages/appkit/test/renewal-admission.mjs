import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture, generatePrivateKey, iso, originalEnd, privateKeyToAccount, OTHER_RENEWER } from "./support/renewal-fixture.mjs";

const { admitSignInRenewal, loadRenewalReceipt, renewalRestoreFor, verifiedRenewalLease } = await import("../src/renewal.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// The real SDK admission against a stand-in for the session's node: it publishes the renewer identity and
// records every lease presented to /delegate. A real lease is forged and signed by a viem wallet.
const host = "https://node.example.test";
let published;
let delegateStatus;
let presented;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname === "/.well-known/tinycloud/node-keys") return Response.json(published);
  if (url.pathname === "/delegate") {
    presented.push(new Headers(init?.headers).get("Authorization") ?? "");
    if (delegateStatus === "hang") {
      const signal = init?.signal ?? input.signal;
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    }
    return Response.json({ activated: [], skipped: [] }, { status: delegateStatus });
  }
  return new Response("unexpected", { status: 500 });
};

const reset = () => {
  presented = [];
  delegateStatus = 200;
  globalThis.localStorage.clear?.();
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
};

function admit(address, record, renewal, load = async () => record, arrivedAt = performance.now()) {
  return admitSignInRenewal({
    tcw: { activeNodeIdentity: async () => ({ origin: host, nodeDid: "did:key:node" }) },
    manifest: PAIN_MANIFEST,
    address,
    renewal,
    arrivedAt,
    storage: { load },
  });
}

// A lease for the saved grant, signed by its owner for that grant's renewal alone, is admitted and kept.
{
  reset();
  const { owner, record, receipt, lease } = await fixture();
  published = receipt.receipt.nodeIdentity;
  assert.equal(await verifiedRenewalLease(receipt, record), lease.authorization);
  assert.equal(await admit(owner.address, record, receipt), receipt.receipt.leaseExpiresAt);
  assert.deepEqual(presented, [lease.authorization]);
  assert.deepEqual(loadRenewalReceipt(PAIN_MANIFEST, owner.address), receipt);
  // Each app keeps its own receipt.
  assert.equal(loadRenewalReceipt({ app_id: "other.app" }, owner.address), null);
}

// No lease (flag off, owner unticked, an OpenKey without renewal): no node contacted, nothing stored.
{
  reset();
  const { owner, record, receipt } = await fixture();
  published = receipt.receipt.nodeIdentity;
  assert.equal(await admit(owner.address, record, undefined), null);
  assert.equal(await admit(owner.address, record, null), null);
  assert.deepEqual(presented, []);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// A lease of the 7 days asked for, or shorter, is accepted.
for (const given of [{}, { leaseSeconds: 3 * 86_400 }]) {
  reset();
  const { receipt, record, lease } = await fixture(given);
  assert.equal(await verifiedRenewalLease(receipt, record), lease.authorization, JSON.stringify(given));
}

// A lease that does not check out against the session just signed in is refused: not sent, not stored.
{
  reset();
  const refused = async (label, build, mutateRecord = (record) => record) => {
    const made = await build();
    published = made.receipt.receipt?.nodeIdentity;
    const record = mutateRecord(made.record);
    assert.equal(await verifiedRenewalLease(made.receipt, record), null, `${label}: not verified`);
    assert.equal(await admit(made.owner.address, record, made.receipt), null, `${label}: not admitted`);
    assert.deepEqual(presented, [], `${label}: nothing sent to the node`);
    assert.equal(loadRenewalReceipt(PAIN_MANIFEST, made.owner.address), null, `${label}: nothing stored`);
  };
  await refused("lease signed by another wallet", () => fixture({ leaseSigner: privateKeyToAccount(generatePrivateKey()) }));
  // A lease longer than the 7 days asked for, by a day or by a minute past the clock slack.
  await refused("lease of 8 days", () => fixture({ leaseSeconds: 8 * 86_400 }));
  await refused("lease stating 7 days but ending 2 minutes past them", () => fixture({ endExtraSeconds: 120 }));
  await refused("lease with an extra ability", () => fixture({ extraAbility: true }));
  await refused("lease naming another audience than the receipt's renewer", () => fixture({ leaseAudience: OTHER_RENEWER }));
  await refused("receipt from a different session", async () => {
    const own = await fixture();
    const other = await fixture();
    return { ...own, receipt: other.receipt };
  });
  await refused("receipt whose grant CID is not the session's", async () => {
    const made = await fixture();
    const other = await fixture();
    return {
      ...made,
      receipt: { ...made.receipt, receipt: { ...made.receipt.receipt, originalCid: other.record.tinycloudSession.delegationCid } },
    };
  });
  await refused("session account is not the lease owner", () => fixture(), (record) => ({
    ...record,
    address: privateKeyToAccount(generatePrivateKey()).address,
  }));
  await refused("approved after the grant ended", async () => {
    const late = iso(originalEnd + 1000);
    const made = await fixture({ approvedAt: late });
    return { ...made, receipt: { ...made.receipt, approvedAt: late } };
  });
  await refused("not a receipt at all", async () => ({ ...(await fixture()), receipt: { nonsense: true } }));
}

// The node's renewer no longer the one the lease names: not sent.
{
  reset();
  const { owner, record, receipt } = await fixture();
  published = { ...receipt.receipt.nodeIdentity, renewerEpoch: 1 };
  assert.equal(await admit(owner.address, record, receipt), null);
  assert.deepEqual(presented, []);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// Node refusal keeps no receipt, so the session runs to its signed end.
for (const status of [401, 403, 500]) {
  reset();
  const { owner, record, receipt } = await fixture();
  published = receipt.receipt.nodeIdentity;
  delegateStatus = status;
  assert.equal(await admit(owner.address, record, receipt), null, `node ${status}`);
  assert.equal(presented.length, 1);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// A node that doesn't answer is given up on after five seconds; nothing is kept.
{
  reset();
  const { owner, record, receipt } = await fixture();
  published = receipt.receipt.nodeIdentity;
  delegateStatus = "hang";
  const started = Date.now();
  // AbortSignal.timeout does not keep Node's event loop alive on its own.
  const keepAlive = setInterval(() => undefined, 100);
  assert.equal(await admit(owner.address, record, receipt), null);
  clearInterval(keepAlive);
  assert.ok(Date.now() - started < 7_000);
  assert.equal(presented.length, 1);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// Signed out while the node admitted the lease: no receipt beside a session that is gone.
{
  reset();
  const { owner, record, receipt } = await fixture();
  published = receipt.receipt.nodeIdentity;
  assert.equal(await admit(owner.address, record, receipt, async () => (presented.length === 0 ? record : null)), null);
  assert.equal(presented.length, 1);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// Sent only within a minute of arrival on this device's clock: later, or with no arrival time, never.
{
  reset();
  const { owner, record, receipt } = await fixture();
  published = receipt.receipt.nodeIdentity;
  assert.equal(await admit(owner.address, record, receipt, undefined, performance.now() - 60_001), null);
  // No arrival time (the outcome never came through the sign-in client): not sent.
  assert.equal(
    await admitSignInRenewal({
      tcw: { activeNodeIdentity: async () => ({ origin: host, nodeDid: "did:key:node" }) },
      manifest: PAIN_MANIFEST,
      address: owner.address,
      renewal: receipt,
      arrivedAt: undefined,
      storage: { load: async () => record },
    }),
    null,
  );
  assert.deepEqual(presented, []);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
  // The minute is counted from arrival here, not from OpenKey's approvedAt by the wall clock.
  const wallClock = Date.now;
  Date.now = () => wallClock() + 120_000;
  try {
    assert.equal(await admit(owner.address, record, receipt), receipt.receipt.leaseExpiresAt);
  } finally {
    Date.now = wallClock;
  }
}

// renewalRestoreFor: only a saved session past its signed end with its own verified receipt yields a lease.
{
  reset();
  const { owner, record, receipt, lease } = await fixture();
  const storage = (status, data = record) => ({
    activeAddressForRenewal: () => owner.address,
    loadRenewalCandidate: async () => ({ status, data: status === "missing" ? null : data }),
  });
  // No receipt kept: nothing to restore through.
  assert.equal(await renewalRestoreFor(PAIN_MANIFEST, owner.address, storage("renewal-candidate")), null);
  const { saveRenewalReceipt } = await import("../src/renewal.js");
  saveRenewalReceipt(PAIN_MANIFEST, owner.address, receipt);
  assert.deepEqual(await renewalRestoreFor(PAIN_MANIFEST, owner.address, storage("renewal-candidate")), {
    address: owner.address,
    leaseAuthorization: lease.authorization,
    leaseExpiresAt: receipt.receipt.leaseExpiresAt,
  });
  // A session still within its signed end, or gone, is left to the plain restore.
  assert.equal(await renewalRestoreFor(PAIN_MANIFEST, owner.address, storage("loaded")), null);
  assert.equal(await renewalRestoreFor(PAIN_MANIFEST, owner.address, storage("missing")), null);
  // A receipt kept beside another session fails verification.
  const other = await fixture();
  assert.equal(await renewalRestoreFor(PAIN_MANIFEST, owner.address, storage("renewal-candidate", other.record)), null);
}

globalThis.fetch = realFetch;
console.log("renewal admission tests passed");
process.exit(0);
