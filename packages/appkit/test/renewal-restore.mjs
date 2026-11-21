import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture, generatePrivateKey, privateKeyToAccount } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { RESTORE_OFFLINE_MESSAGE, RESTORE_UNAVAILABLE_MESSAGE, restoreSavedSession, signOutOfTinyCloud } =
  await import("../src/restore.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// Reload restoration with the SDK client and the saved-session storage replaced by recording fakes; the saved
// session record and the owner-signed lease are real (renewal-fixture.mjs), so the receipt is verified for real.

const reset = () => {
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
};

/** `status` is what the saved session is: "loaded" (within its signed end), "renewal-candidate" (past it), or gone. */
function setup({ status = "renewal-candidate", withReceipt = true, receiptFor, restore = {}, read = async () => ({ ok: true, data: { keys: [] } }) } = {}) {
  reset();
  return fixture().then(async (made) => {
    const { owner, record, receipt, lease } = made;
    if (withReceipt) saveRenewalReceipt(PAIN_MANIFEST, owner.address, receiptFor ? await receiptFor(made) : receipt);
    const calls = { plain: 0, renewal: [], cleared: [], created: 0, signOut: 0, cleanup: 0, kv: [] };
    const storage = {
      activeAddress: () => (status === "loaded" ? owner.address : undefined),
      activeAddressForRenewal: () => (status === "missing" ? undefined : owner.address),
      loadRenewalCandidate: async () => ({ status, data: status === "missing" ? null : record }),
      load: async () => (status === "loaded" ? record : null),
      clear: async (address) => void calls.cleared.push(address),
    };
    const tcw = {
      restoreSession: async () => {
        calls.plain += 1;
        return restore.plain ?? { status: "restored", session: { address: owner.address } };
      },
      restoreSessionWithRenewal: async (leaseAuthorization, address) => {
        calls.renewal.push({ leaseAuthorization, address });
        if (restore.renewalThrows) throw restore.renewalThrows;
        return restore.renewal ?? { status: "restored", session: { address: owner.address } };
      },
      space: () => ({
        kv: {
          // Restoring writes nothing: a put or delete here would be a re-publish.
          list: async (query) => {
            calls.kv.push(["list", query.prefix]);
            return read();
          },
          put: async () => void calls.kv.push(["put"]),
          delete: async () => void calls.kv.push(["delete"]),
        },
      }),
      signOut: async () => void (calls.signOut += 1),
      cleanup: () => void (calls.cleanup += 1),
      secrets: { unlock: async () => assert.fail("restore must not touch secrets") },
    };
    const restoreNow = (extra = {}) =>
      restoreSavedSession(PAIN_MANIFEST, {
        storage,
        createClient: async () => {
          calls.created += 1;
          return tcw;
        },
        isOffline: () => false,
        ...extra,
      });
    return { owner, record, receipt, lease, calls, restoreNow, tcw };
  });
}

// Nothing saved: signed out, no client built, nothing to clear.
{
  const { calls, restoreNow } = await setup({ status: "missing", withReceipt: false });
  assert.deepEqual(await restoreNow(), { kind: "signedOut" });
  assert.equal(calls.created, 0);
}

// Past its signed end with its own verified receipt: restored through the lease, after one live read.
{
  const { owner, lease, receipt, calls, restoreNow } = await setup();
  const outcome = await restoreNow();
  assert.equal(outcome.kind, "restored");
  assert.equal(outcome.address, owner.address);
  assert.equal(outcome.renewsUntil, receipt.receipt.leaseExpiresAt);
  assert.deepEqual(calls.renewal, [{ leaseAuthorization: lease.authorization, address: owner.address }]);
  assert.equal(calls.plain, 0);
  assert.deepEqual(calls.kv, [["list", `${PAIN_MANIFEST.app_id}/`]]);
  assert.deepEqual(calls.cleared, []);
  assert.ok(loadRenewalReceipt(PAIN_MANIFEST, owner.address), "the receipt is kept");
}

// Past its signed end with no receipt: no lease restore. The plain restore refuses it and it is cleared.
{
  const { owner, calls, restoreNow } = await setup({ withReceipt: false, restore: { plain: { status: "expired" } } });
  assert.deepEqual(await restoreNow(), { kind: "signedOut" });
  assert.deepEqual(calls.renewal, []);
  assert.equal(calls.plain, 1);
  assert.deepEqual(calls.cleared, [owner.address]);
}

// A receipt that fails verification is never used for a lease restore: signed by another wallet, from a
// different session, or with an extra ability on the lease.
for (const [label, receiptFor] of [
  ["lease signed by another wallet", async () => (await fixture({ leaseSigner: privateKeyToAccount(generatePrivateKey()) })).receipt],
  ["receipt from a different session", async () => (await fixture()).receipt],
  ["extra ability on the lease", async () => (await fixture({ extraAbility: true })).receipt],
]) {
  const { owner, calls, restoreNow } = await setup({ receiptFor, restore: { plain: { status: "expired" } } });
  assert.deepEqual(await restoreNow(), { kind: "signedOut" }, label);
  assert.deepEqual(calls.renewal, [], `${label}: no lease restore`);
  assert.equal(calls.plain, 1, label);
  assert.deepEqual(calls.cleared, [owner.address], label);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null, `${label}: receipt cleared`);
}

// A session still within its signed end restores plainly (no lease needed) and shows the lease it keeps.
{
  const { owner, receipt, calls, restoreNow } = await setup({ status: "loaded" });
  const outcome = await restoreNow();
  assert.equal(outcome.kind, "restored");
  assert.equal(outcome.renewsUntil, receipt.receipt.leaseExpiresAt);
  assert.equal(calls.plain, 1);
  assert.deepEqual(calls.renewal, []);
  assert.deepEqual(calls.kv, [], "a plain restore reads nothing and writes nothing");
  assert.equal(owner.address, outcome.address);
}

// ...and shows no lease line when it keeps none, or one that doesn't verify.
for (const options of [{ withReceipt: false }, { receiptFor: async () => (await fixture()).receipt }]) {
  const { restoreNow } = await setup({ status: "loaded", ...options });
  const outcome = await restoreNow();
  assert.equal(outcome.kind, "restored");
  assert.equal(outcome.renewsUntil, null);
}

// A network failure keeps the saved session and receipt: nothing cleared, the user is told to reload.
for (const [label, options, isOffline] of [
  ["fetch failure", { restore: { plain: { status: "restore-failed", error: new TypeError("Failed to fetch") } } }, false],
  ["5xx", { restore: { plain: { status: "restore-failed", error: Object.assign(new Error("HTTP 503"), { status: 503 }) } } }, false],
  ["offline", { restore: { plain: { status: "restore-failed", error: new Error("whatever") } } }, true],
  ["lease restore throws a timeout", { restore: { renewalThrows: Object.assign(new Error("timed out"), { name: "TimeoutError" }) } }, false],
]) {
  const { owner, calls, restoreNow } = await setup({ status: label.startsWith("lease") ? "renewal-candidate" : "loaded", ...options });
  const outcome = await restoreNow({ isOffline: () => isOffline });
  assert.deepEqual(outcome, { kind: "unavailable", message: isOffline ? RESTORE_OFFLINE_MESSAGE : RESTORE_UNAVAILABLE_MESSAGE }, label);
  assert.deepEqual(calls.cleared, [], `${label}: saved session kept`);
  assert.ok(loadRenewalReceipt(PAIN_MANIFEST, owner.address), `${label}: receipt kept`);
  assert.equal(calls.cleanup, 1, label);
}

// A definitive refusal clears the saved session and the receipt, and leaves the user signed out.
for (const status of ["expired", "corrupt", "missing", "stale"]) {
  const { owner, calls, restoreNow } = await setup({ status: "loaded", restore: { plain: { status } } });
  assert.deepEqual(await restoreNow(), { kind: "signedOut" }, status);
  assert.deepEqual(calls.cleared, [owner.address], status);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null, status);
}
{
  // The node refuses the lease restore itself with a non-network error.
  const { owner, calls, restoreNow } = await setup({ restore: { renewal: { status: "restore-failed", error: Object.assign(new Error("renewal authority inactive"), { code: "RENEWAL_AUTHORITY_INACTIVE" }) } } });
  assert.deepEqual(await restoreNow(), { kind: "signedOut" });
  assert.deepEqual(calls.cleared, [owner.address]);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// After a lease restore the node must accept the session on one live read: 401/403 signs out and clears...
for (const status of [401, 403]) {
  const { owner, calls, restoreNow } = await setup({ read: async () => ({ ok: false, error: { code: "AUTH", meta: { status } } }) });
  assert.deepEqual(await restoreNow(), { kind: "signedOut" }, `read ${status}`);
  assert.deepEqual(calls.cleared, [owner.address]);
  assert.equal(calls.signOut, 1);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}
// ...an unreachable node keeps everything.
{
  const { owner, calls, restoreNow } = await setup({ read: async () => ({ ok: false, error: { code: "NETWORK_ERROR", message: "Failed to fetch" } }) });
  assert.equal((await restoreNow()).kind, "unavailable");
  assert.deepEqual(calls.cleared, []);
  assert.equal(calls.signOut, 0);
  assert.ok(loadRenewalReceipt(PAIN_MANIFEST, owner.address));
}

// Restore never publishes, never writes: the fake kv saw no put or delete on any path above is covered per case;
// here the plain and the lease paths are checked once more together.
{
  for (const status of ["loaded", "renewal-candidate"]) {
    const { calls, restoreNow } = await setup({ status });
    await restoreNow();
    assert.equal(calls.kv.filter(([method]) => method !== "list").length, 0, status);
  }
}

// Sign-out clears the saved session and the receipt.
{
  const { owner, calls, tcw } = await setup();
  await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, { createOpenKey: () => ({ signOut: async () => ({ revoked: true }) }) });
  assert.equal(calls.signOut, 1);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

console.log("renewal restore tests passed");
process.exit(0);
