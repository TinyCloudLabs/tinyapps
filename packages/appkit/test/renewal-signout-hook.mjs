import assert from "node:assert/strict";

import "./support/browser.mjs";

import { bundle } from "./support/bundle.mjs";
import { appkitSrc, fakeClient } from "./support/expiry.mjs";
import { mountHook } from "./support/host.mjs";

const { renewalMayContinueNoticeFor, signedOutNoticeFor } = await import("../src/restore.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// The hook's sign-out, with React's own state: the signed-out screen shows right after the local sign-out, before
// OpenKey answers; it shows even when a local step throws; a notice that arrives after a newer sign-in or
// sign-out is dropped; only `revoked === true` gives the confirmed line.

const { module: app, cleanup } = await bundle('export { useTinyCloudApp } from "./useTinyCloudApp.js";', appkitSrc);
const address = "0x1111111111111111111111111111111111111111";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

const signIns = [];
globalThis.__connectOpenKeyTinyCloud = async () => {
  const next = signIns.shift();
  return { tcw: next.tcw, session: { address }, openkey: next.openkey, openKeyAddress: address, renewsUntil: null };
};
const openKeyAnswering = (answer) => ({ asked: 0, signOut() { this.asked += 1; return answer.promise; } });
async function signedIn() {
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
  const answer = deferred();
  const openkey = openKeyAnswering(answer);
  const tcw = fakeClient("ok");
  signIns.push({ tcw, openkey });
  const hook = await mountHook(() => app.useTinyCloudApp(PAIN_MANIFEST));
  await hook.run(() => hook.value.signIn());
  assert.equal(hook.value.tcw, tcw);
  return { hook, answer, openkey, tcw };
}
/** Presses sign out; resolves `{ finished }` once the local part has shown, while OpenKey has not answered. */
async function pressSignOut(hook) {
  let finished;
  await hook.run(async () => {
    finished = hook.value.signOut();
    await tick();
  });
  return { finished };
}

try {
  // The screen is signed out as soon as the local sign-out is done, with no notice yet; OpenKey was asked once.
  for (const [answer, expected] of [
    [{ revoked: true }, signedOutNoticeFor("Pain Tracker")],
    [{ revoked: false }, renewalMayContinueNoticeFor("Pain Tracker")],
    [undefined, renewalMayContinueNoticeFor("Pain Tracker")],
  ]) {
    const { hook, answer: pending, openkey } = await signedIn();
    const { finished } = await pressSignOut(hook);
    assert.equal(hook.value.session, null, "signed out before OpenKey answered");
    assert.equal(hook.value.tcw, null);
    assert.equal(hook.value.signOutNotice, null, "no notice while OpenKey is awaited");
    assert.equal(hook.value.signingOut, false);
    assert.equal(openkey.asked, 1);
    await hook.run(async () => {
      pending.resolve(answer);
      assert.equal(await finished, expected);
    });
    assert.equal(hook.value.signOutNotice, expected);
    await hook.unmount();
  }

  // OpenKey rejecting (cancelled in its window) gives the warning.
  {
    const { hook, answer, tcw } = await signedIn();
    const { finished } = await pressSignOut(hook);
    await hook.run(async () => {
      answer.reject({ code: "USER_CANCELLED" });
      assert.equal(await finished, renewalMayContinueNoticeFor("Pain Tracker"));
    });
    assert.equal(hook.value.session, null);
    await hook.unmount();
  }

  // A local step that throws: the screen is still cleared, before and whatever OpenKey does, and the error reaches the caller.
  {
    const { hook, answer, openkey } = await signedIn();
    const removeItem = globalThis.localStorage.removeItem;
    globalThis.localStorage.removeItem = () => {
      throw new Error("storage is full");
    };
    let thrown;
    try {
      await hook.run(async () => {
        try {
          await hook.value.signOut();
        } catch (err) {
          thrown = err;
        }
      });
    } finally {
      globalThis.localStorage.removeItem = removeItem;
    }
    assert.equal(thrown?.message, "storage is full");
    assert.equal(hook.value.session, null, "cleared despite the throw");
    assert.equal(hook.value.tcw, null);
    assert.equal(hook.value.signingOut, false);
    assert.equal(openkey.asked, 1, "OpenKey was still asked");
    // Signing in again works and is not blocked by the earlier sign-out.
    const again = fakeClient("ok");
    signIns.push({ tcw: again, openkey: openKeyAnswering(deferred()) });
    await hook.run(() => hook.value.signIn());
    assert.equal(hook.value.tcw, again);
    await hook.unmount();
  }

  // A late answer after a new sign-in is dropped, and does not touch the new session.
  {
    const { hook, answer } = await signedIn();
    const { finished } = await pressSignOut(hook);
    const next = fakeClient("ok");
    signIns.push({ tcw: next, openkey: openKeyAnswering(deferred()) });
    await hook.run(() => hook.value.signIn());
    assert.equal(hook.value.tcw, next);
    await hook.run(async () => {
      answer.resolve({ revoked: true });
      assert.equal(await finished, null, "the stale answer gives no notice");
    });
    assert.equal(hook.value.signOutNotice, null);
    assert.equal(hook.value.tcw, next, "the new session is still there");
    assert.ok(hook.value.session);
    await hook.unmount();
  }

  // A late answer after a newer sign-out is dropped too: only the newer one's answer shows.
  {
    const { hook, answer: first } = await signedIn();
    const { finished: firstFinished } = await pressSignOut(hook);
    const secondAnswer = deferred();
    signIns.push({ tcw: fakeClient("ok"), openkey: openKeyAnswering(secondAnswer) });
    await hook.run(() => hook.value.signIn());
    const { finished: secondFinished } = await pressSignOut(hook);
    assert.equal(hook.value.session, null);
    await hook.run(async () => {
      first.resolve({ revoked: false });
      assert.equal(await firstFinished, null);
    });
    assert.equal(hook.value.signOutNotice, null, "the older answer is not shown");
    await hook.run(async () => {
      secondAnswer.resolve({ revoked: true });
      assert.equal(await secondFinished, signedOutNoticeFor("Pain Tracker"));
    });
    assert.equal(hook.value.signOutNotice, signedOutNoticeFor("Pain Tracker"));
    await hook.unmount();
  }
} finally {
  cleanup();
  delete globalThis.__connectOpenKeyTinyCloud;
}

console.log("renewal sign-out hook tests passed");
process.exit(0);
