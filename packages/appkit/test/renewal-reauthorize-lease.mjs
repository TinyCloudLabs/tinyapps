import assert from "node:assert/strict";

import "./support/browser.mjs";

import { bundle } from "./support/bundle.mjs";
import { appkitSrc, fakeClient } from "./support/expiry.mjs";
import { mountHook } from "./support/host.mjs";
import { fixture } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// "Sign in again" with a renewal lease on file restores through the lease, with no OpenKey window. The saved
// session (past its signed end) and the owner-signed receipt are the real fixtures; the SDK client and its saved
// session storage are recording stand-ins handed to the real restore (see support/bundle.mjs), because the SDK's own
// lease exchange needs a real node. The real hook, restore, receipt check and sign-out run.

const { module: app, cleanup } = await bundle('export { useTinyCloudApp } from "./useTinyCloudApp.js";', appkitSrc);
const { owner, record, receipt, lease } = await fixture();
const address = owner.address;
const sessionKey = `tinyapps:${PAIN_MANIFEST.app_id}:session:${address.toLowerCase()}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
};
const clearStorage = () => {
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
};
const stored = () => ({ session: globalThis.localStorage.getItem(sessionKey), receipt: loadRenewalReceipt(PAIN_MANIFEST, address) });

let connects = 0;
const queue = [];
globalThis.__connectOpenKeyTinyCloud = async () => {
  connects += 1;
  const next = queue.shift();
  return { tcw: next, session: { address }, openkey: { signOut: async () => ({ revoked: true }) }, openKeyAddress: address, renewsUntil: null };
};

/** The client the lease restore builds: records the lease exchange, and (like the SDK) saves what it restored. */
function leaseClient({ gate } = {}) {
  const client = fakeClient("ok");
  client.leaseCalls = [];
  client.plainCalls = 0;
  client.signedOut = 0;
  client.restoreSession = async () => (client.plainCalls++, { status: "expired" });
  client.restoreSessionWithRenewal = async (authorization, who) => {
    client.leaseCalls.push([authorization, who]);
    await gate?.promise;
    // The renewed session is persisted by the restore itself, and the receipt is kept beside it.
    globalThis.localStorage.setItem(sessionKey, "{}");
    saveRenewalReceipt(PAIN_MANIFEST, address, receipt);
    return { status: "restored", session: { address } };
  };
  client.signOut = async () => void (client.signedOut += 1);
  return client;
}

/** A saved session past its signed end beside its receipt: what a lease renews. */
const savedPastItsEnd = (client) => {
  globalThis.__restoreDeps = {
    storage: {
      activeAddress: () => undefined,
      activeAddressForRenewal: () => address,
      loadRenewalCandidate: async () => ({ status: "renewal-candidate", data: record }),
      load: async () => null,
      clear: async () => undefined,
    },
    createClient: async () => client,
    isOffline: () => false,
  };
};

async function endedUnderAnEntry() {
  clearStorage();
  connects = 0;
  const first = fakeClient("ok");
  queue.push(first);
  const hook = await mountHook(() => app.useTinyCloudApp(PAIN_MANIFEST));
  await hook.run(() => hook.value.signIn());
  assert.equal(hook.value.tcw, first);
  connects = 0;
  // The entry: a write that the session's end refuses, kept for the retry. The retry's write is counted.
  const writes = [];
  const entry = async (tcw) => {
    const result = await tcw.space().kv.put("entry.json", { text: "kept" });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, meta: result.error.meta });
    writes.push(tcw);
  };
  first.mode = "ended";
  await hook.run(async () => void (await hook.value.runWithSession(entry)));
  assert.equal(hook.value.expired, true);
  assert.equal(writes.length, 0);
  // Past the signed end, the saved session and its receipt are on file.
  saveRenewalReceipt(PAIN_MANIFEST, address, receipt);
  globalThis.localStorage.setItem(sessionKey, "{}");
  return { hook, first, writes };
}

try {
  // (1) Sign in again restores through the lease: no OpenKey window, the kept entry saves exactly once on the
  // restored client, and the state is signed in with the lease end shown.
  {
    const { hook, first, writes } = await endedUnderAnEntry();
    const restored = leaseClient();
    savedPastItsEnd(restored);
    let resumed;
    await hook.run(async () => void (resumed = await hook.value.resume()));
    assert.deepEqual(resumed, { done: true, value: undefined });
    assert.deepEqual(restored.leaseCalls, [[lease.authorization, address]], "restored through the verified lease, for the saved address");
    assert.equal(restored.plainCalls, 0);
    assert.equal(connects, 0, "no OpenKey sign-in");
    assert.deepEqual(writes, [restored], "the kept entry saved once, on the restored client");
    assert.equal(restored.writes.length, 1);
    assert.equal(first.writes.length, 0);
    assert.equal(hook.value.tcw, restored);
    assert.ok(hook.value.session);
    assert.equal(hook.value.openKeyAddress, address);
    assert.equal(hook.value.renewsUntil, receipt.receipt.leaseExpiresAt);
    assert.equal(hook.value.expired, false);
    assert.equal(hook.value.error, "");
    assert.equal(hook.value.signingIn, false);
    assert.ok(stored().session && stored().receipt, "the lease and the session stay saved");
    await hook.unmount();
  }

  // (2) Sign out while the lease restore is still waiting. When it answers, the session is not brought back: no
  // saved session, no receipt, signed out, the restored client signed out, and the kept entry is not saved.
  {
    const { hook, first, writes } = await endedUnderAnEntry();
    const gate = deferred();
    const restored = leaseClient({ gate });
    savedPastItsEnd(restored);
    let resuming;
    await hook.run(async () => {
      resuming = hook.value.resume();
      await tick();
    });
    assert.equal(hook.value.signingIn, true);
    assert.equal(restored.leaseCalls.length, 1, "the restore is under way");
    await hook.run(() => hook.value.signOut());
    assert.equal(hook.value.session, null);
    assert.deepEqual(stored(), { session: null, receipt: null }, "sign-out cleared what was saved");
    let result;
    await hook.run(async () => {
      gate.resolve();
      result = await resuming;
    });
    assert.deepEqual(result, { done: false });
    assert.equal(writes.length, 0, "the kept action did not run");
    assert.equal(restored.writes.length, 0);
    assert.equal(hook.value.session, null, "still signed out");
    assert.equal(hook.value.tcw, null);
    assert.notEqual(hook.value.tcw, first);
    assert.equal(hook.value.openKeyAddress, "");
    assert.equal(hook.value.renewsUntil, null);
    assert.equal(hook.value.expired, false);
    assert.equal(hook.value.signingIn, false);
    assert.equal(restored.signedOut, 1, "the late client was signed out");
    assert.deepEqual(stored(), { session: null, receipt: null }, "what the restore saved is cleared again");
    assert.equal(connects, 0);
    await hook.unmount();
  }
} finally {
  cleanup();
  delete globalThis.__connectOpenKeyTinyCloud;
  delete globalThis.__restoreDeps;
}

console.log("renewal reauthorize lease tests passed");
process.exit(0);
