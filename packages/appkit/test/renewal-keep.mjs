import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { RESTORE_UNAVAILABLE_MESSAGE, restoreSavedSession } = await import("../src/restore.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// When a lease-renewed restore fails, the saved session and its receipt are dropped only on an authoritative
// answer. A failure to reach anything, and any error nobody recognises, keeps both so a reload can retry.
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
  const run = async () => {
    // A lease past its end renews nothing: the clock reads 91 days on, past the 90-day lease the receipt carries.
    const clock = Date.now;
    if (leaseEnded) Date.now = () => clock() + 91 * 24 * 60 * 60 * 1000;
    try {
      return await restoreSavedSession(PAIN_MANIFEST, { storage, createClient: async () => tcw, isOffline: () => false });
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
for (const [label, restore] of [
  ["network failure", { renewal: { status: "restore-failed", error: new TypeError("Failed to fetch") } }],
  ["timeout", { renewal: { status: "restore-failed", error: Object.assign(new Error("timed out"), { name: "TimeoutError" }) } }],
  ["5xx", { renewal: { status: "restore-failed", error: Object.assign(new Error("HTTP 503"), { status: 503 }) } }],
  ["storage unavailable", { renewal: { status: "storage-unavailable" } }],
  ["restore throws a network error", { renewalThrows: new TypeError("Failed to fetch") }],
  // An error nobody recognises is not an answer about the lease.
  ["unknown error", { renewal: { status: "restore-failed", error: new Error("something unexpected") } }],
  ["unknown thrown value", { renewalThrows: "boom" }],
  ["no error at all", { renewal: { status: "restore-failed" } }],
]) {
  const { owner, calls, run } = await setup({ restore });
  assert.deepEqual(await run(), { kind: "unavailable", message: RESTORE_UNAVAILABLE_MESSAGE }, label);
  assert.equal(calls.renewal, 1, `${label}: restored through the lease`);
  keptAll(owner, calls, label);
}

// The one live read after a lease restore: an unrecognised failure keeps everything too.
for (const [label, error] of [
  ["5xx", { code: "SERVER", meta: { status: 502 } }],
  ["network", { code: "NETWORK_ERROR", message: "Failed to fetch" }],
  ["unknown", { code: "WEIRD" }],
]) {
  const { owner, calls, run } = await setup({ read: async () => ({ ok: false, error }) });
  assert.equal((await run()).kind, "unavailable", `live read ${label}`);
  assert.equal(calls.signOut, 0, `live read ${label}`);
  keptAll(owner, calls, `live read ${label}`);
}

// Revoked: the node refuses the restored session on the live read (401/403) or refuses the lease by its own code.
for (const status of [401, 403]) {
  const { owner, calls, run } = await setup({ read: async () => ({ ok: false, error: { code: "AUTH", meta: { status } } }) });
  assert.deepEqual(await run(), { kind: "signedOut" }, `live read ${status}`);
  assert.equal(calls.signOut, 1);
  droppedAll(owner, calls, `live read ${status}`);
}
for (const code of ["RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_EXPIRED", "RENEWAL_LEASE_ORIGINAL_EXPIRED"]) {
  const { owner, calls, run } = await setup({ restore: { renewal: { status: "restore-failed", error: withCode("refused", { code }) } } });
  assert.deepEqual(await run(), { kind: "signedOut" }, code);
  droppedAll(owner, calls, code);
}
{
  // A refusal that arrives as a thrown error with the status on a wrapped cause.
  const { owner, calls, run } = await setup({ restoreThrows: undefined, restore: { renewalThrows: new Error("wrapped", { cause: { status: 403 } }) } });
  assert.deepEqual(await run(), { kind: "signedOut" });
  droppedAll(owner, calls, "wrapped 403");
}

// Expired, corrupt, stale or missing: the saved session answered for itself.
for (const status of ["expired", "corrupt", "stale", "missing"]) {
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

// A plain (not lease) restore that fails with something unrecognised keeps the saved session too.
{
  const { owner, calls, run } = await setup({ status: "loaded", restore: { plain: { status: "restore-failed", error: new Error("???") } } });
  assert.equal((await run()).kind, "unavailable");
  keptAll(owner, calls, "plain unknown");
}

console.log("renewal keep tests passed");
process.exit(0);
