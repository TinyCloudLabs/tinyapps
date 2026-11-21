import assert from "node:assert/strict";

import "./support/browser.mjs";

import { fixture } from "./support/renewal-fixture.mjs";

const { loadRenewalReceipt, saveRenewalReceipt } = await import("../src/renewal.js");
const { renewalMayContinueNoticeFor, signOutOfTinyCloud, signedOutNoticeFor } = await import("../src/restore.js");
const { PAIN_MANIFEST } = await import("../src/manifests.js");

// Sign-out ends the OpenKey session and its leases: the SDK's own signOut is local only. The OpenKey client and
// the SDK client are recording fakes; the receipt is a real owner-signed one.

const reset = () => {
  for (let i = globalThis.localStorage.length - 1; i >= 0; i--) globalThis.localStorage.removeItem(globalThis.localStorage.key(i));
};

async function setup({ withReceipt = true } = {}) {
  reset();
  const { owner, receipt } = await fixture();
  if (withReceipt) saveRenewalReceipt(PAIN_MANIFEST, owner.address, receipt);
  const order = [];
  const tcw = { signOut: async () => void order.push("tcw.signOut") };
  const openkeyClient = (label, behaviour) => ({
    signOut: async () => {
      order.push(`${label}.signOut`);
      return behaviour();
    },
  });
  return { owner, order, tcw, openkeyClient };
}

const revoked = async () => ({ revoked: true });

// The signing tab calls OpenKey signOut on its own client, before the local sign-out, and builds no other client.
{
  const { owner, order, tcw, openkeyClient } = await setup();
  let created = 0;
  const result = await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, {
    openkey: openkeyClient("own", revoked),
    createOpenKey: () => {
      created += 1;
      return openkeyClient("fresh", revoked);
    },
  });
  assert.deepEqual(result, { notice: signedOutNoticeFor("Pain Tracker") });
  assert.deepEqual(order, ["own.signOut", "tcw.signOut"]);
  assert.equal(created, 0);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// The signing tab calls it even for a finite sign-in with no receipt.
{
  const { owner, order, tcw, openkeyClient } = await setup({ withReceipt: false });
  const result = await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, { openkey: openkeyClient("own", revoked) });
  assert.deepEqual(result, { notice: signedOutNoticeFor("Pain Tracker") });
  assert.deepEqual(order, ["own.signOut", "tcw.signOut"]);
}

// A tab restored through the lease has no client: it builds a fresh one.
{
  const { owner, order, tcw, openkeyClient } = await setup();
  let created = 0;
  const result = await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, {
    createOpenKey: () => {
      created += 1;
      return openkeyClient("fresh", revoked);
    },
  });
  assert.deepEqual(result, { notice: signedOutNoticeFor("Pain Tracker") });
  assert.equal(created, 1);
  assert.deepEqual(order, ["fresh.signOut", "tcw.signOut"]);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// A restored tab with no receipt (lost or never kept) still asks OpenKey on a fresh client, so no lease is left
// behind; a confirmed end gives the confirmed notice.
{
  const { owner, order, tcw, openkeyClient } = await setup({ withReceipt: false });
  let created = 0;
  const result = await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, {
    createOpenKey: () => {
      created += 1;
      return openkeyClient("fresh", revoked);
    },
  });
  assert.deepEqual(result, { notice: signedOutNoticeFor("Pain Tracker") });
  assert.equal(created, 1);
  assert.deepEqual(order, ["fresh.signOut", "tcw.signOut"]);
}

// ...and an OpenKey that does not confirm gives the notice there too.
{
  const { owner, order, tcw, openkeyClient } = await setup({ withReceipt: false });
  const result = await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, {
    createOpenKey: () => openkeyClient("fresh", async () => ({ revoked: false })),
  });
  assert.deepEqual(result, { notice: renewalMayContinueNoticeFor("Pain Tracker") });
  assert.deepEqual(order, ["fresh.signOut", "tcw.signOut"]);
}

// Anything but `revoked === true` returns the notice, and the local sign-out and clearing still happen.
const hang = () => new Promise(() => undefined);
for (const [label, behaviour] of [
  ["revoked false", async () => ({ revoked: false })],
  ["revoked missing", async () => ({})],
  ["throws", async () => Promise.reject(new Error("popup blocked"))],
  ["user cancels", async () => Promise.reject({ code: "USER_CANCELLED", message: "cancelled" })],
  ["no answer within the cap", hang],
]) {
  for (const restored of [false, true]) {
    const { owner, order, tcw, openkeyClient } = await setup();
    const client = openkeyClient("ok", behaviour);
    const started = Date.now();
    const result = await signOutOfTinyCloud(PAIN_MANIFEST, tcw, owner.address, {
      ...(restored ? { createOpenKey: () => client } : { openkey: client }),
      timeoutMs: 50,
    });
    assert.deepEqual(result, { notice: renewalMayContinueNoticeFor("Pain Tracker") }, `${label} (restored ${restored})`);
    assert.ok(Date.now() - started < 2_000, `${label}: capped`);
    assert.deepEqual(order, ["ok.signOut", "tcw.signOut"], label);
    assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null, `${label}: receipt cleared`);
  }
}

// A failing local sign-out or an OpenKey client that cannot be built never makes sign-out throw.
{
  const { owner, order } = await setup();
  const result = await signOutOfTinyCloud(
    PAIN_MANIFEST,
    { signOut: async () => Promise.reject(new Error("local failure")) },
    owner.address,
    {
      createOpenKey: () => {
        order.push("create");
        throw new Error("cannot build");
      },
    },
  );
  assert.deepEqual(result, { notice: renewalMayContinueNoticeFor("Pain Tracker") });
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, owner.address), null);
}

// The two notice texts, naming the app they are for.
assert.equal(signedOutNoticeFor("Food Tracker"), "Signed out of Food Tracker in this browser. Food Tracker's access won't renew.");
assert.equal(
  renewalMayContinueNoticeFor("Insight"),
  "You're signed out of Insight in this browser, but OpenKey may still be renewing its access. To stop that, choose Stop renewal under Renewing permissions in OpenKey settings.",
);

console.log("renewal sign-out tests passed");
process.exit(0);
