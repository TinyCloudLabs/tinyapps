import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import "./support/browser.mjs";

// The SDK signs in an owner the location registry doesn't know only from a first-party page (a third-party page
// needs an account that already exists, which would need a signed registry entry here). The apps themselves run
// as third-party pages; nothing in the code under test reads the origin.
globalThis.window.location = { host: "tinycloud.chat", hostname: "tinycloud.chat", origin: "https://tinycloud.chat" };

import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";

import { cacaoFromSiwe, fixture, generatePrivateKey, leaseReceipt, privateKeyToAccount } from "./support/renewal-fixture.mjs";

const { connectOpenKeyTinyCloud } = await import("../src/tinycloud.js");
const { RENEWAL_TIERS, loadRenewalReceipt, renewalAskFor, renewalTierFor, sessionExpirationMsFor } = await import("../src/renewal.js");
const { createRestoreClient, restoreSavedSession, signOutOfTinyCloud } = await import("../src/restore.js");
const { FOOD_MANIFEST, INSIGHT_MANIFEST, PAIN_MANIFEST, encryptionNetworkId } = await import("../src/manifests.js");

// Sign-in with a fake OpenKey that forges owner-signed renewal leases (real crypto) for the very session
// grant it signs, against a stand-in node that records what is sent to it.
const owner = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const address = owner.address;
const host = "https://node.example.test";
const options = { host, openKeyHost: "https://openkey.example.test" };

// Food Tracker's sign-in grant carries decrypt on the owner's encryption network, which the node must hold.
const networkId = encryptionNetworkId(address);
const descriptor = {
  networkId,
  ownerDid: networkId.slice("urn:tinycloud:encryption:".length, -":default".length),
  name: "default",
  members: [{ nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", role: "primary" }],
  threshold: { n: 1, t: 1 },
  state: "active",
  publicEncryptionKey: Buffer.from(generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"),
  alg: "x25519-aes256gcm/v1",
  keyVersion: 1,
  keyBackend: "local-one-of-one",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

let nodeCalls;
let delegateStatus;
const json = (body, init) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("authorization") ?? "";
  nodeCalls.push({ method: init?.method ?? "GET", path: url.pathname, authorization });
  // An owner the location registry doesn't know signs in at the host hint.
  if (/^\/v[12]\/locations\//.test(url.pathname)) return new Response('{"error":"location record not found"}', { status: 404 });
  if (url.pathname === "/info") return json({ protocol: 1, version: "1.26.7", features: [], nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" });
  if (url.pathname === "/.well-known/tinycloud/node-keys") return json(published);
  if (url.pathname === "/delegate") {
    // The sign-in's own session delegation is always accepted; a presented lease gets the node's verdict.
    const isLease = leases.has(authorization.replace(/^Bearer /i, ""));
    return json({ activated: ["stub"], skipped: [] }, { status: isLease ? delegateStatus : 200 });
  }
  if (url.pathname.startsWith("/encryption/networks/")) return json(descriptor);
  if (url.pathname === "/invoke") return json({ written: [], count: 0 });
  return new Response("stub node", { status: 404 });
};

let published;
const leases = new Set();

function applicationsWrites(calls) {
  return calls
    .filter(({ path }) => path === "/invoke")
    .flatMap(({ authorization }) => {
      const payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /i, "").split(".")[1], "base64url").toString());
      return Object.entries(payload.att ?? {}).flatMap(([resource, granted]) =>
        Object.keys(granted).filter((ability) => /\/(put|del|delete)$/.test(ability)).map((ability) => `${ability} ${resource}`),
      );
    })
    .filter((write) => write.includes(":applications/"));
}

const savedSessionKeys = () => [...Array(globalThis.localStorage.length).keys()].map((i) => globalThis.localStorage.key(i));
const reset = () => {
  nodeCalls = [];
  delegateStatus = 200;
  published = undefined;
  leases.clear();
  for (const key of savedSessionKeys()) globalThis.localStorage.removeItem(key);
};
const leaseCalls = () => nodeCalls.filter(({ authorization }) => leases.has(authorization.replace(/^Bearer /i, "")));
const nodeKeyCalls = () => nodeCalls.filter(({ path }) => path === "/.well-known/tinycloud/node-keys");

function approveEverything(request) {
  const selectedActionKeys = [];
  const permissions = [];
  for (const [resource, actions] of Object.entries(extractRecapAttenuations(request.siwe))) {
    const { space, path } = parseCanonicalRecapResource(resource);
    const byService = new Map();
    for (const ability of Object.keys(actions)) {
      const service = ability.split("/")[0];
      if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
      byService.set(service, [...(byService.get(service) ?? []), ability]);
    }
    for (const [service, abilities] of byService) permissions.push({ service, space, path, actions: abilities });
  }
  return { selectedActionKeys, permissions };
}

/**
 * A fake OpenKey. `lease` decides what comes back about renewal: "none" (no `renewal`), "valid", or leaseReceipt
 * options for a forged lease; `narrow` drops one granted resource from the signed message.
 */
function fakeOpenKey({ lease = "none", narrow = false } = {}) {
  const calls = { authorize: [], signMessage: 0 };
  return {
    calls,
    async connect() {
      return { address, keyId: "key_test", keyType: "MANAGED" };
    },
    async authorizeTinyCloud(request, opts) {
      calls.authorize.push({ request, opts });
      let signedMessage = request.siwe;
      if (narrow) {
        const recap = /urn:recap:([A-Za-z0-9_-]+)/.exec(signedMessage)[1];
        const payload = JSON.parse(Buffer.from(recap, "base64url").toString());
        delete payload.att[Object.keys(payload.att)[0]];
        signedMessage = signedMessage.replace(recap, Buffer.from(JSON.stringify(payload)).toString("base64url"));
      }
      const result = {
        protocolVersion: 1,
        address,
        signature: await owner.signMessage({ message: signedMessage }),
        signedMessage,
        ...approveEverything(request),
      };
      if (lease !== "none") {
        const { cid } = await cacaoFromSiwe(owner, request.siwe);
        const made = await leaseReceipt(cid, owner, { leaseSeconds: request.renewal?.leaseLifetimeSeconds, ...(lease === "valid" ? {} : lease) });
        published = made.receipt.receipt.nodeIdentity;
        leases.add(made.receipt.receipt.leaseAuthorization);
        result.renewalChoice = "accepted";
        result.renewal = made.receipt;
      }
      return result;
    },
    async signMessage() {
      calls.signMessage += 1;
      throw new Error("legacy signMessage must not be used for sign-in");
    },
  };
}

const storedSession = (manifest) => globalThis.localStorage.getItem(`tinyapps:${manifest.app_id}:session:${address.toLowerCase()}`);

const DAY = 24 * 60 * 60;
// Each app's tier: what it asks OpenKey for, and how long its session is signed for.
const TIERS = [
  [PAIN_MANIFEST, { purpose: "standing", leaseDays: 90, sessionDays: 7 }],
  [INSIGHT_MANIFEST, { purpose: "standing", leaseDays: 90, sessionDays: 7 }],
  [FOOD_MANIFEST, { purpose: undefined, leaseDays: 7, sessionDays: 1 }],
];

// The ask is always sent, with exactly the keys OpenKey accepts: `purpose` only where the tier names one.
for (const [manifest, tier] of TIERS) {
  assert.deepEqual(
    renewalAskFor(manifest),
    tier.purpose ? { version: 1, leaseLifetimeSeconds: tier.leaseDays * DAY, purpose: tier.purpose } : { version: 1, leaseLifetimeSeconds: tier.leaseDays * DAY },
  );
  assert.equal(sessionExpirationMsFor(manifest), tier.sessionDays * DAY * 1000);
  assert.equal(RENEWAL_TIERS[manifest.app_id], renewalTierFor(manifest));
}

// Every app asks in a window OpenKey can return the lease through, gets the session length of its tier signed,
// has the node admit the lease and keeps it beside the saved session.
for (const [manifest, tier] of TIERS) {
  reset();
  const openkey = fakeOpenKey({ lease: "valid" });
  const signedIn = await connectOpenKeyTinyCloud(manifest, { ...options, openkey });
  const [{ request, opts }] = openkey.calls.authorize;
  assert.deepEqual(request.renewal, renewalAskFor(manifest), `${manifest.app_id}: the ask`);
  assert.equal("purpose" in request.renewal, tier.purpose !== undefined, `${manifest.app_id}: purpose`);
  assert.equal(request.renewal.purpose, tier.purpose);
  assert.equal(opts.mode, "iframe");
  assert.equal(request.expiryChangeable ?? opts.expiryChangeable, true);
  assert.equal(openkey.calls.signMessage, 0);
  assert.equal(leaseCalls().length, 1, `${manifest.app_id}: the node was sent the lease once`);
  const receipt = loadRenewalReceipt(manifest, address);
  assert.equal(receipt.receipt.leaseAuthorization, leaseCalls()[0].authorization.replace(/^Bearer /i, ""));
  assert.equal(receipt.approvedLeaseLifetimeSeconds, tier.leaseDays * DAY);
  assert.equal(signedIn.renewsUntil, receipt.receipt.leaseExpiresAt);
  assert.ok(storedSession(manifest), `${manifest.app_id}: the session is kept for a reload to restore`);
  // The session is signed for the tier's length, in the message OpenKey signs and in the saved record.
  const signedEnd = Date.parse(/Expiration Time: (.+)/.exec(request.siwe)[1]);
  assert.ok(Math.abs(signedEnd - (Date.now() + tier.sessionDays * DAY * 1000)) < 5 * 60 * 1000, `${manifest.app_id}: signed end`);
  const expiresAt = Date.parse(JSON.parse(storedSession(manifest)).expiresAt);
  assert.ok(Math.abs(expiresAt - (Date.now() + tier.sessionDays * DAY * 1000)) < 5 * 60 * 1000, `${manifest.app_id}: saved end`);
  // The receipt is kept outside the SDK's own session prefix, and per app.
  assert.ok(savedSessionKeys().every((key) => !key.startsWith("tinycloud:session:")));
  for (const [other] of TIERS) if (other !== manifest) assert.equal(loadRenewalReceipt(other, address), null);
}

// No lease returned (owner unticked it, flag off, an OpenKey without renewal): the sign-in is finite. No node is
// asked about a lease and nothing is stored for renewal.
{
  reset();
  const openkey = fakeOpenKey({ lease: "none" });
  const signedIn = await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey });
  assert.equal(signedIn.renewsUntil, null);
  assert.equal(nodeKeyCalls().length, 0);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null);
  assert.ok(storedSession(PAIN_MANIFEST), "the finite session is still kept until its signed end");
}

// A lease longer than the tier's own lease is refused (it checks out otherwise): not sent, not kept. Food Tracker's
// lease is 7 days, so what Pain Tracker accepts is too long for it.
for (const [manifest, tooLongDays] of [[PAIN_MANIFEST, 91], [INSIGHT_MANIFEST, 91], [FOOD_MANIFEST, 8], [FOOD_MANIFEST, 90]]) {
  reset();
  const signedIn = await connectOpenKeyTinyCloud(manifest, { ...options, openkey: fakeOpenKey({ lease: { leaseSeconds: tooLongDays * DAY } }) });
  assert.equal(signedIn.renewsUntil, null, `${manifest.app_id} ${tooLongDays} d`);
  assert.equal(leaseCalls().length, 0);
  assert.equal(loadRenewalReceipt(manifest, address), null);
}

// Unticked in OpenKey's own box (no renewal in the result): finite, with the tier's session length and no receipt.
for (const [manifest, tier] of TIERS) {
  reset();
  const signedIn = await connectOpenKeyTinyCloud(manifest, { ...options, openkey: fakeOpenKey({ lease: "none" }) });
  assert.equal(signedIn.renewsUntil, null);
  assert.equal(nodeKeyCalls().length, 0);
  assert.equal(leaseCalls().length, 0);
  assert.equal(loadRenewalReceipt(manifest, address), null);
  const expiresAt = Date.parse(JSON.parse(storedSession(manifest)).expiresAt);
  assert.ok(Math.abs(expiresAt - (Date.now() + tier.sessionDays * DAY * 1000)) < 5 * 60 * 1000, `${manifest.app_id}: finite session end`);
}

// A lease that does not check out is refused: the sign-in goes on finite, the lease is not sent to the node or kept.
for (const [label, lease] of [
  ["signed by another wallet", { leaseSigner: privateKeyToAccount(generatePrivateKey()) }],
  ["with an extra ability", { extraAbility: true }],
]) {
  reset();
  const signedIn = await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease }) });
  assert.equal(signedIn.renewsUntil, null, label);
  assert.equal(leaseCalls().length, 0, `${label}: not sent to the node`);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null, `${label}: not stored`);
}

// A receipt kept from a different session (its own owner-signed lease, but for another grant) is refused too.
{
  reset();
  const openkey = fakeOpenKey({ lease: "valid" });
  const authorize = openkey.authorizeTinyCloud.bind(openkey);
  const otherSession = await fixture();
  const { receipt } = await leaseReceipt(otherSession.record.tinycloudSession.delegationCid, owner);
  published = receipt.receipt.nodeIdentity;
  openkey.authorizeTinyCloud = async (request, opts) => ({ ...(await authorize(request, opts)), renewal: receipt });
  const signedIn = await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey });
  assert.equal(signedIn.renewsUntil, null);
  assert.equal(nodeKeyCalls().length, 0);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null);
}

// A node that refuses the lease leaves the sign-in finite: no receipt.
{
  reset();
  delegateStatus = 403;
  const signedIn = await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: "valid" }) });
  assert.equal(leaseCalls().length, 1);
  assert.equal(signedIn.renewsUntil, null);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null);
}

// A narrowed approval is refused before any lease is admitted or stored, and leaves no session.
{
  reset();
  const openkey = fakeOpenKey({ lease: "valid", narrow: true });
  await assert.rejects(connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey }), { message: "Pain Tracker needs all the permissions it asks for. Sign in again and allow each one." });
  assert.equal(openkey.calls.authorize.length, 1);
  assert.equal(nodeKeyCalls().length, 0);
  assert.equal(leaseCalls().length, 0);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null);
  assert.equal(storedSession(PAIN_MANIFEST), null);
}

// A reload restores the saved sign-in with the real SDK, and shows the lease the sign-in kept. Restoring publishes
// nothing: the node sees no write.
{
  reset();
  await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: "valid" }) });
  const receipt = loadRenewalReceipt(PAIN_MANIFEST, address);
  // The sign-in does publish the manifest, so the write check below is not vacuous.
  assert.ok(applicationsWrites(nodeCalls).length > 0);
  nodeCalls = [];
  const restored = await restoreSavedSession(PAIN_MANIFEST, {
    createClient: (savedAddress) => createRestoreClient(PAIN_MANIFEST, savedAddress, options),
    isOffline: () => false,
  });
  assert.equal(restored.kind, "restored");
  assert.equal(restored.address.toLowerCase(), address.toLowerCase());
  assert.equal(restored.renewsUntil, receipt.receipt.leaseExpiresAt);
  assert.equal(restored.session.address.toLowerCase(), address.toLowerCase());
  // The restore must not re-publish the manifest or write a record to the applications space. (The SDK's own
  // account-registry sync is its business and is a write to the account space, not asserted here.)
  const writes = applicationsWrites(nodeCalls);
  assert.deepEqual(writes, [], "restoring writes nothing to the applications space");
  assert.equal(leaseCalls().length, 0, "the lease is not sent again");

  // Sign-out clears the saved session and the receipt: the next load starts signed out.
  await signOutOfTinyCloud(PAIN_MANIFEST, restored.tcw, address, { createOpenKey: () => ({ signOut: async () => ({ revoked: true }) }) });
  assert.equal(storedSession(PAIN_MANIFEST), null);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null);
  const after = await restoreSavedSession(PAIN_MANIFEST, {
    createClient: (savedAddress) => createRestoreClient(PAIN_MANIFEST, savedAddress, options),
    isOffline: () => false,
  });
  assert.deepEqual(after, { kind: "signedOut" });
}

// A finite sign-in (no lease) restores too, with no lease line.
{
  reset();
  await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: "none" }) });
  const restored = await restoreSavedSession(PAIN_MANIFEST, {
    createClient: (savedAddress) => createRestoreClient(PAIN_MANIFEST, savedAddress, options),
    isOffline: () => false,
  });
  assert.equal(restored.kind, "restored");
  assert.equal(restored.renewsUntil, null);
}

// A reload past Food Tracker's one-day session (day two) restores only through its lease: without one the person
// is signed out, with one it restores through the lease. Pain Tracker's session is signed for 7 days, so on day
// two it restores plainly with no lease.
const dayTwo = async (run) => {
  const clock = Date.now;
  Date.now = () => clock() + 2 * DAY * 1000;
  try {
    return await run();
  } finally {
    Date.now = clock;
  }
};
const restoreNow = (manifest, overrides = (client) => client) =>
  restoreSavedSession(manifest, {
    createClient: async (savedAddress) => overrides(await createRestoreClient(manifest, savedAddress, options)),
    isOffline: () => false,
  });
{
  reset();
  await connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: "none" }) });
  assert.ok(storedSession(FOOD_MANIFEST));
  assert.deepEqual(await dayTwo(() => restoreNow(FOOD_MANIFEST)), { kind: "signedOut" }, "Food, no lease: signed out past day one");
  assert.equal(storedSession(FOOD_MANIFEST), null);
}
{
  reset();
  await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: "none" }) });
  const restored = await dayTwo(() => restoreNow(PAIN_MANIFEST));
  assert.equal(restored.kind, "restored", "Pain, no lease: its 7-day session still restores on day two");
  assert.equal(restored.renewsUntil, null);
}
for (const manifest of [FOOD_MANIFEST, PAIN_MANIFEST]) {
  reset();
  await connectOpenKeyTinyCloud(manifest, { ...options, openkey: fakeOpenKey({ lease: "valid" }) });
  // The node's own renewal exchange is the SDK's business: stand in for its answer, and check the restore was
  // asked through the lease this sign-in kept. Food's session is past its end on day two, so only it needs the lease.
  const receipt = loadRenewalReceipt(manifest, address);
  const asked = { plain: 0, lease: [] };
  const restored = await dayTwo(() =>
    restoreNow(manifest, (client) => {
      client.space = () => ({ kv: { list: async () => ({ ok: true, data: { keys: [] } }) } });
      const plain = client.restoreSession.bind(client);
      client.restoreSession = async (...args) => (asked.plain += 1, plain(...args));
      client.restoreSessionWithRenewal = async (lease, who) => (asked.lease.push([lease, who]), { status: "restored", session: { address: who } });
      return client;
    }),
  );
  assert.equal(restored.kind, "restored", `${manifest.app_id}: restored on day two`);
  assert.equal(restored.address.toLowerCase(), address.toLowerCase());
  if (manifest === FOOD_MANIFEST) {
    assert.equal(asked.plain, 0);
    assert.equal(asked.lease.length, 1, "Food: restored through the lease");
    assert.equal(asked.lease[0][0], receipt.receipt.leaseAuthorization);
    assert.equal(String(asked.lease[0][1]).toLowerCase(), address.toLowerCase());
  } else {
    assert.equal(asked.lease.length, 0, "Pain: still inside its signed session, no lease needed");
  }
}

console.log("renewal sign-in tests passed");
process.exit(0);
