import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { RESTORE_OFFLINE_MESSAGE, RESTORE_UNAVAILABLE_MESSAGE, isTransientRestoreError, restoreSavedSession } = await import("../src/restore.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// When a lease-renewed restore fails, the saved session and its receipt are kept only on a clearly transient
// failure (network, timeout, 408/429/5xx, offline) so a reload can retry. Every other answer ends the session:
// a status that is not a restore, any refusal (401/403 or other 4xx), a renewal refusal code, an error nobody
// recognises, a lapsed lease end.
// The saved record and the owner-signed lease are real; the SDK client and the saved-session storage are fakes.

const reset = () => {
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
};

async function setup({ status = "renewal-candidate", restore = {}, read, leaseEnded = false } = {}) {
  reset();
  const { owner, record, receipt, lease } = await fixture();
  saveRenewalReceipt(PAIN_MANIFEST, owner.address, receipt);
  const calls = { cleared: [], plain: 0, renewal: 0, signOut: 0 };
  const storage = {
    activeAddress: () => (status === "loaded" ? owner.address : undefined),
    activeAddressForRenewal: () => owner.address,
    loadRenewalCandidate: async () => ({ status, data: record }),
    load: async () => (status === "loaded" ? record : null),
    clear: async (address) => void calls.cleared.push(address),
  };
  const restored = { status: "restored", session: { address: owner.address } };
  const tcw = {
    restoreSession: async () => {
      calls.plain += 1;
      if (restore.plainThrows) throw restore.plainThrows;
      return restore.plain ?? restored;
    },
    restoreSessionWithRenewal: async () => {
      calls.renewal += 1;
      if (restore.renewalThrows) throw restore.renewalThrows;
      return restore.renewal ?? restored;
    },
    space: () => ({ kv: { list: async () => (read ? read() : { ok: true, data: { keys: [] } }) } }),
    signOut: async () => void (calls.signOut += 1),
    cleanup: () => undefined,
  };
  const run = async ({ offline = false } = {}) => {
    // A lease past its end renews nothing: the clock reads 8 days on, past the 7-day lease the receipt carries.
    const clock = Date.now;
    if (leaseEnded) Date.now = () => clock() + 8 * 24 * 60 * 60 * 1000;
    try {
      return await restoreSavedSession(PAIN_MANIFEST, { storage, createClient: async () => tcw, isOffline: () => offline });
    } finally {
      Date.now = clock;
    }
  };
  return { owner, lease, calls, run };
}

const withCode = (message, props) => Object.assign(new Error(message), props);
const keptAll = (owner, calls, label) => {
  assert.deepEqual(calls.cleared, [], `${label}: saved session kept`);
  assert.ok(loadRenewalReceipt(PAIN_MANIFEST, owner.address), `${label}: receipt kept`);
};
const droppedAll = (owner, calls, label) => {
  assert.deepEqual(calls.cleared, [owner.address], `${label}: saved session dropped`);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null, `${label}: receipt dropped`);
};

// Transient failures of the lease restore keep the receipt and the saved session.
for (const [label, restore, options] of [
  ["network failure", { renewal: { status: "restore-failed", error: new TypeError("Failed to fetch") } }],
  ["network failure wrapped in a cause", { renewal: { status: "restore-failed", error: new Error("restore failed", { cause: new TypeError("fetch failed") }) } }],
  ["timeout", { renewal: { status: "restore-failed", error: Object.assign(new Error("timed out"), { name: "TimeoutError" }) } }],
  ["abort", { renewal: { status: "restore-failed", error: Object.assign(new Error("aborted"), { name: "AbortError" }) } }],
  ["5xx", { renewal: { status: "restore-failed", error: Object.assign(new Error("service down"), { status: 503 }) } }],
  ["408", { renewal: { status: "restore-failed", error: Object.assign(new Error("slow"), { status: 408 }) } }],
  ["429", { renewal: { status: "restore-failed", error: Object.assign(new Error("slow down"), { status: 429 }) } }],
  ["HTTP 502 in the message", { renewal: { status: "restore-failed", error: new Error("HTTP 502 Bad Gateway") } }],
  ["restore throws a network error", { renewalThrows: new TypeError("Failed to fetch") }],
  // An offline device cannot tell a refusal from a network failure: keep.
  ["offline, whatever the error", { renewal: { status: "restore-failed", error: new Error("something unexpected") } }, { offline: true }],
]) {
  const { owner, calls, run } = await setup({ restore });
  const outcome = await run(options);
  assert.equal(outcome.kind, "unavailable", label);
  assert.equal(outcome.message, options?.offline ? RESTORE_OFFLINE_MESSAGE : RESTORE_UNAVAILABLE_MESSAGE, label);
  assert.equal(calls.renewal, 1, `${label}: restored through the lease`);
  keptAll(owner, calls, label);
}

// The same failures keep a plain restore too.
{
  const { owner, calls, run } = await setup({ status: "loaded", restore: { plain: { status: "restore-failed", error: new TypeError("Failed to fetch") } } });
  assert.equal((await run()).kind, "unavailable");
  keptAll(owner, calls, "plain network failure");
}

// The one live read after a lease restore: a failure to reach the node keeps everything, 503 beside 403...
for (const [label, error] of [
  ["503", { code: "SERVER", meta: { status: 503 } }],
  ["network", { code: "NETWORK_ERROR", message: "Failed to fetch" }],
  ["timeout", { name: "TimeoutError", message: "The operation timed out" }],
]) {
  const { owner, calls, run } = await setup({ read: async () => ({ ok: false, error }) });
  assert.equal((await run()).kind, "unavailable", `live read ${label}`);
  assert.equal(calls.signOut, 0, `live read ${label}`);
  keptAll(owner, calls, `live read ${label}`);
}
// ...and any refusal drops them: 401/403, another 4xx, an error nobody recognises.
for (const [label, error] of [
  ["401", { code: "AUTH", meta: { status: 401 } }],
  ["403", { code: "AUTH", meta: { status: 403 } }],
  ["404", { code: "NOT_FOUND", meta: { status: 404 } }],
  ["unknown", { code: "WEIRD" }],
]) {
  const { owner, calls, run } = await setup({ read: async () => ({ ok: false, error }) });
  assert.deepEqual(await run(), { kind: "signedOut" }, `live read ${label}`);
  assert.equal(calls.signOut, 1, `live read ${label}`);
  droppedAll(owner, calls, `live read ${label}`);
}

// The lease restore itself: 403 drops, 503 keeps (the pair), and so does every other non-transient failure.
{
  const { owner, calls, run } = await setup({ restore: { renewal: { status: "restore-failed", error: Object.assign(new Error("forbidden"), { status: 403 }) } } });
  assert.deepEqual(await run(), { kind: "signedOut" });
  droppedAll(owner, calls, "lease restore 403");
}
{
  const { owner, calls, run } = await setup({ restore: { renewal: { status: "restore-failed", error: Object.assign(new Error("unavailable"), { status: 503 }) } } });
  assert.equal((await run()).kind, "unavailable");
  keptAll(owner, calls, "lease restore 503");
}
for (const [label, restore] of [
  ["404", { renewal: { status: "restore-failed", error: Object.assign(new Error("gone"), { status: 404 }) } }],
  ["unknown error", { renewal: { status: "restore-failed", error: new Error("something unexpected") } }],
  ["unknown thrown value", { renewalThrows: "boom" }],
  ["no error at all", { renewal: { status: "restore-failed" } }],
  ["wrapped 403", { renewalThrows: new Error("wrapped", { cause: { status: 403 } }) }],
]) {
  const { owner, calls, run } = await setup({ restore });
  assert.deepEqual(await run(), { kind: "signedOut" }, label);
  droppedAll(owner, calls, `lease restore ${label}`);
}

// A renewal refusal code is an answer even when the error also looks transient.
for (const code of ["RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_EXPIRED", "RENEWAL_LEASE_ORIGINAL_EXPIRED"]) {
  for (const extra of [{}, { status: 503 }]) {
    const { owner, calls, run } = await setup({ restore: { renewal: { status: "restore-failed", error: Object.assign(new Error("refused"), { code, ...extra }) } } });
    assert.deepEqual(await run(), { kind: "signedOut" }, code);
    droppedAll(owner, calls, code);
  }
}

// Every status but `restore-failed` is a verdict, storage unavailable and disabled included.
for (const status of ["expired", "corrupt", "stale", "missing", "storage-unavailable", "disabled"]) {
  const { owner, calls, run } = await setup({ restore: { renewal: { status } } });
  assert.deepEqual(await run(), { kind: "signedOut" }, status);
  droppedAll(owner, calls, status);
}

// A receipt past its lease end renews nothing: it is dropped and no lease restore is tried. The plain restore
// then decides the saved session: past its signed end it is expired and dropped...
{
  const { owner, calls, run } = await setup({ leaseEnded: true, restore: { plain: { status: "expired" } } });
  assert.deepEqual(await run(), { kind: "signedOut" });
  assert.equal(calls.renewal, 0, "no lease restore with a lapsed lease");
  assert.equal(calls.plain, 1);
  droppedAll(owner, calls, "lapsed lease, expired session");
}
// ...and still within its signed end it restores finite, with no lease line, and the lapsed receipt is gone.
{
  const { owner, calls, run } = await setup({ leaseEnded: true, status: "loaded" });
  const outcome = await run();
  assert.equal(outcome.kind, "restored");
  assert.equal(outcome.renewsUntil, null);
  assert.equal(calls.renewal, 0);
  assert.deepEqual(calls.cleared, []);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// A plain (not lease) restore that fails with something unrecognised ends the session too.
{
  const { owner, calls, run } = await setup({ status: "loaded", restore: { plain: { status: "restore-failed", error: new Error("???") } } });
  assert.deepEqual(await run(), { kind: "signedOut" });
  droppedAll(owner, calls, "plain unknown");
}

// What counts as transient.
assert.equal(isTransientRestoreError(new TypeError("Failed to fetch")), true);
assert.equal(isTransientRestoreError({ status: 429 }), true);
assert.equal(isTransientRestoreError(new Error("outer", { cause: { name: "AbortError" } })), true);
assert.equal(isTransientRestoreError({ status: 403 }), false);
assert.equal(isTransientRestoreError({ status: 404 }), false);
assert.equal(isTransientRestoreError(new Error("Persisted session is corrupt")), false);
assert.equal(isTransientRestoreError(undefined), false);

console.log("renewal keep tests passed");
process.exit(0);
