import assert from "node:assert/strict";

import "./support/browser.mjs";

import { bundle } from "./support/bundle.mjs";
import { appkitSrc, fakeClient } from "./support/expiry.mjs";
import { mountHook } from "./support/host.mjs";
import { fixture } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// The person signs out while an in-place sign-in is still waiting for OpenKey. When OpenKey answers, the sign-in
// must not bring the session back: nothing is adopted, the new client is signed out, and its saved session and
// renewal receipt are cleared, so a reload stays signed out. The real hook, with the real sign-out and clearing.

const { module: app, cleanup } = await bundle('export { useTinyCloudApp } from "./useTinyCloudApp.js";', appkitSrc);
const { owner, receipt } = await fixture();
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

// Each sign-in the fake OpenKey is asked for waits on `gate`; when it answers, it leaves what the real sign-in
// leaves behind: a saved session and the renewal receipt.
const queue = [];
globalThis.__connectOpenKeyTinyCloud = async () => {
  const next = queue.shift();
  await next.gate?.promise;
  globalThis.localStorage.setItem(sessionKey, "{}");
  saveRenewalReceipt(PAIN_MANIFEST, address, receipt);
  return { tcw: next.tcw, session: { address }, openkey: { signOut: async () => ({ revoked: true }) }, openKeyAddress: address, renewsUntil: null };
};
const stored = () => ({ session: globalThis.localStorage.getItem(sessionKey), receipt: loadRenewalReceipt(PAIN_MANIFEST, address) });

async function signedIn() {
  clearStorage();
  const first = fakeClient("ok");
  queue.push({ tcw: first });
  const hook = await mountHook(() => app.useTinyCloudApp(PAIN_MANIFEST));
  await hook.run(() => hook.value.signIn());
  assert.equal(hook.value.tcw, first);
  return { hook, first };
}
/** Starts `start()`; resolves `{ promise }` once React has flushed what it did synchronously. */
async function pending(hook, start) {
  let promise;
  await hook.run(async () => {
    promise = start();
    await tick();
  });
  return { promise };
}
const signOutNow = (hook) => hook.run(() => hook.value.signOut());

try {
  // Reauthorize pending, sign out, then OpenKey answers: nothing comes back.
  {
    const { hook, first } = await signedIn();
    const gate = deferred();
    const late = fakeClient("ok");
    queue.push({ tcw: late, gate });
    const { promise: reauthorizing } = await pending(hook, () => hook.value.reauthorize());
    assert.equal(hook.value.signingIn, true);
    await signOutNow(hook);
    assert.equal(hook.value.session, null);
    let signedOutCalls = 0;
    late.signOut = async () => void (signedOutCalls += 1);
    await hook.run(async () => {
      gate.resolve();
      assert.equal(await reauthorizing, false, "the late sign-in reports it did not take");
    });
    assert.equal(hook.value.session, null, "still signed out");
    assert.equal(hook.value.tcw, null);
    assert.equal(hook.value.openKeyAddress, "");
    assert.equal(hook.value.renewsUntil, null);
    assert.equal(hook.value.error, "");
    assert.equal(hook.value.signingIn, false);
    assert.equal(signedOutCalls, 1, "the new client was signed out");
    assert.notEqual(hook.value.tcw, first, "the old client does not come back");
    assert.deepEqual(stored(), { session: null, receipt: null }, "nothing saved for a reload to restore");
    await hook.unmount();
  }

  // The prompt's "Sign in again" (resume) the same way: the kept action is not run on the late client.
  {
    const { hook } = await signedIn();
    const gate = deferred();
    const late = fakeClient("ok");
    queue.push({ tcw: late, gate });
    let ran = 0;
    await hook.run(async () => {
      await hook.value.runWithSession(async () => {
        throw { code: "AUTH_UNAUTHORIZED", meta: { status: 401 } };
      });
    });
    assert.equal(hook.value.expired, true);
    const { promise: resuming } = await pending(hook, () => hook.value.resume());
    // The kept action would write if it ran: it is the one set above, so count through the late client.
    late.space = () => ((ran += 1), fakeClient("ok").space());
    await signOutNow(hook);
    await hook.run(async () => {
      gate.resolve();
      assert.deepEqual(await resuming, { done: false });
    });
    assert.equal(ran, 0);
    assert.equal(hook.value.session, null);
    assert.equal(hook.value.expired, false, "signed out clears the prompt too");
    assert.deepEqual(stored(), { session: null, receipt: null });
    await hook.unmount();
  }

  // A sign-in that did not overlap a sign-out is unaffected, and so is one started after it.
  {
    const { hook } = await signedIn();
    const second = fakeClient("ok");
    queue.push({ tcw: second });
    await hook.run(() => hook.value.reauthorize());
    assert.equal(hook.value.tcw, second, "an ordinary in-place sign-in is adopted");
    assert.ok(stored().session && stored().receipt);
    await signOutNow(hook);
    assert.deepEqual(stored(), { session: null, receipt: null });
    const third = fakeClient("ok");
    queue.push({ tcw: third });
    await hook.run(() => hook.value.signIn());
    assert.equal(hook.value.tcw, third, "signing in after a sign-out works");
    assert.ok(stored().session);
    await hook.unmount();
  }
} finally {
  cleanup();
  delete globalThis.__connectOpenKeyTinyCloud;
}

console.log("renewal sign-out race tests passed");
process.exit(0);
