import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { OPENKEY_SIGN_OUT_TIMEOUT_MS, renewalMayContinueNoticeFor, signOutOfTinyCloud, signedOutNoticeFor } = await import("../src/restore.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// OpenKey's sign-out widget waits for a person to press "Sign out", so the wait for its answer is 120 s, and the
// local sign-out never waits for it. A virtual clock stands in for the timers, so the 120 s take no real time.

assert.equal(OPENKEY_SIGN_OUT_TIMEOUT_MS, 120_000);

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let nowMs = 0;
let timers = [];
let nextId = 1;
globalThis.setTimeout = (fn, ms) => {
  const id = nextId++;
  timers.push({ id, at: nowMs + ms, fn });
  return id;
};
globalThis.clearTimeout = (id) => {
  timers = timers.filter((timer) => timer.id !== id);
};
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));
/** Moves the virtual clock to `ms` after the start, firing the timers that fall due on the way in order. */
async function advanceTo(ms) {
  for (;;) {
    const due = timers.filter((timer) => timer.at <= ms).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((timer) => timer !== due);
    nowMs = due.at;
    due.fn();
    await settle();
  }
  nowMs = ms;
  await settle();
}

const reset = () => {
  nowMs = 0;
  timers = [];
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
};

const sessionKey = (address) => `tinyapps:${PAIN_MANIFEST.app_id}:session:${address.toLowerCase()}`;

/** Starts a sign-out whose OpenKey answer (`answerAt` ms, or never) is given by the test; records what happened when. */
async function start({ answerAt, answer = { revoked: true }, reject = false }) {
  reset();
  const { owner, receipt } = await fixture();
  saveRenewalReceipt(PAIN_MANIFEST, owner.address, receipt);
  // A saved session beside the receipt, under the key the app's own storage uses.
  globalThis.localStorage.setItem(sessionKey(owner.address), "{}");
  const events = [];
  const tcw = { signOut: async () => void events.push("tcw.signOut") };
  const openkey = {
    signOut: () => {
      events.push("openkey.signOut asked");
      return new Promise((resolve, rejectPromise) => {
        if (answerAt === undefined) return;
        globalThis.setTimeout(() => {
          events.push(`openkey answered at ${nowMs}`);
          if (reject) rejectPromise({ code: "USER_CANCELLED" });
          else resolve(answer);
        }, answerAt);
      });
    },
  };
  let result;
  const finished = signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, {
    openkey,
    onSignedOut: () => events.push("signed-out screen"),
  }).then((value) => ((result = value), events.push("notice")));
  return { owner, events, finished, result: () => result };
}

const clearedLocally = (owner) => loadRenewalReceipt(PAIN_MANIFEST, owner.address) === null && globalThis.localStorage.getItem(sessionKey(owner.address)) === null;

try {
  // The local sign-out comes first: before OpenKey answers, the client is signed out, the receipt is gone and the
  // signed-out screen has been asked for. Only then does the notice wait for OpenKey.
  {
    const { owner, events, finished, result } = await start({ answerAt: 90_000 });
    await advanceTo(1_000);
    assert.deepEqual(events, ["openkey.signOut asked", "tcw.signOut", "signed-out screen"]);
    assert.ok(clearedLocally(owner), "the receipt and the saved session are cleared before OpenKey answers");
    assert.equal(result(), undefined, "no notice yet");
    await advanceTo(90_000);
    await finished;
    assert.deepEqual(result(), { notice: signedOutNoticeFor("Pain Tracker") });
    assert.equal(events.at(-1), "notice");
  }

  // An answer at 119 s counts: confirmed.
  {
    const { events, finished, result } = await start({ answerAt: 119_000 });
    await advanceTo(118_999);
    assert.equal(result(), undefined);
    await advanceTo(119_000);
    await finished;
    assert.deepEqual(result(), { notice: signedOutNoticeFor("Pain Tracker") });
    assert.ok(events.includes("openkey answered at 119000"));
  }

  // At 120 s with no answer: the standing warning. A later answer changes nothing.
  {
    const { finished, result } = await start({ answerAt: 125_000 });
    await advanceTo(119_999);
    assert.equal(result(), undefined, "still waiting at 119.999 s");
    await advanceTo(120_000);
    await finished;
    assert.deepEqual(result(), { notice: renewalMayContinueNoticeFor("Pain Tracker") });
    await advanceTo(130_000);
    assert.deepEqual(result(), { notice: renewalMayContinueNoticeFor("Pain Tracker") });
  }

  // No answer at all: the same warning at 120 s.
  {
    const { finished, result } = await start({});
    await advanceTo(120_000);
    await finished;
    assert.deepEqual(result(), { notice: renewalMayContinueNoticeFor("Pain Tracker") });
  }

  // Cancelled in the widget, or answered not revoked: the warning, and the local sign-out had already happened.
  for (const options of [{ answerAt: 5_000, reject: true }, { answerAt: 5_000, answer: { revoked: false } }]) {
    const { owner, events, finished, result } = await start(options);
    await advanceTo(5_000);
    await finished;
    assert.deepEqual(result(), { notice: renewalMayContinueNoticeFor("Pain Tracker") });
    assert.ok(clearedLocally(owner));
    assert.ok(events.indexOf("signed-out screen") < events.indexOf("notice"));
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

console.log("renewal late sign-out tests passed");
process.exit(0);
