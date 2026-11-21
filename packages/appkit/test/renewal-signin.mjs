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
const { RENEWAL_LEASE_SECONDS, loadRenewalReceipt } = await import("../src/renewal.js");
const { createRestoreClient, restoreSavedSession, signOutOfTinyCloud } = await import("../src/restore.js");
const { FOOD_MANIFEST, INSIGHT_MANIFEST, PAIN_MANIFEST, encryptionNetworkId } = await import("../src/manifests.js");

// Sign-in with a fake OpenKey that forges owner-signed renewal leases (real crypto) for the very session
// grant it signs, against a stand-in node that records what is sent to it.
const owner = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const address = owner.address;
const host = "https://node.example.test";
// `keepSignedIn: true` is the person ticking the in-app choice before connecting.
const options = { host, openKeyHost: "https://openkey.example.test", keepSignedIn: true };

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
        const made = await leaseReceipt(cid, owner, lease === "valid" ? {} : lease);
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

// Ticked, every app (Food Tracker's grant carries secrets decrypt) asks for exactly the 7-day lease, with no
// purpose so OpenKey leaves its own box unticked, in a window OpenKey can return it through, and keeps the lease
// the node admitted beside the saved session.
for (const manifest of [INSIGHT_MANIFEST, FOOD_MANIFEST]) {
  reset();
  const openkey = fakeOpenKey({ lease: "valid" });
  const signedIn = await connectOpenKeyTinyCloud(manifest, { ...options, openkey });
  assert.deepEqual(openkey.calls.authorize[0].request.renewal, { version: 1, leaseLifetimeSeconds: 604800 });
  assert.equal("purpose" in openkey.calls.authorize[0].request.renewal, false);
  assert.equal(leaseCalls().length, 1, `${manifest.app_id}: the node was sent the lease`);
  assert.ok(loadRenewalReceipt(manifest, address), `${manifest.app_id}: the receipt is kept`);
  assert.equal(signedIn.renewsUntil, loadRenewalReceipt(manifest, address).receipt.leaseExpiresAt);
}
assert.equal(RENEWAL_LEASE_SECONDS, 604800);
{
  reset();
  const openkey = fakeOpenKey({ lease: "valid" });
  const signedIn = await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey });
  const [{ request, opts }] = openkey.calls.authorize;
  assert.deepEqual(request.renewal, { version: 1, leaseLifetimeSeconds: 604800 });
  assert.equal("purpose" in request.renewal, false);
  assert.equal(opts.mode, "iframe");
  assert.equal(request.expiryChangeable ?? opts.expiryChangeable, true);
  assert.equal(openkey.calls.signMessage, 0);
  assert.equal(leaseCalls().length, 1, "the node was sent the lease once");
  const receipt = loadRenewalReceipt(PAIN_MANIFEST, address);
  assert.equal(receipt.receipt.leaseAuthorization, leaseCalls()[0].authorization.replace(/^Bearer /i, ""));
  assert.equal(signedIn.renewsUntil, receipt.receipt.leaseExpiresAt);
  assert.ok(storedSession(PAIN_MANIFEST), "the session is kept for a reload to restore");
  // The session lasts the seven days asked for.
  const expiresAt = Date.parse(JSON.parse(storedSession(PAIN_MANIFEST)).expiresAt);
  assert.ok(Math.abs(expiresAt - (Date.now() + 7 * 24 * 60 * 60 * 1000)) < 5 * 60 * 1000);
  // The receipt is kept outside the SDK's own session prefix, and per app.
  assert.ok(savedSessionKeys().every((key) => !key.startsWith("tinycloud:session:")));
  assert.equal(loadRenewalReceipt(INSIGHT_MANIFEST, address), null);
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

// Unticked (the default), for every app: no renewal ask at all, whatever OpenKey would return; a finite sign-in
// with nothing saved, nothing admitted and nothing kept.
for (const manifest of [PAIN_MANIFEST, INSIGHT_MANIFEST, FOOD_MANIFEST]) {
  for (const unticked of [{ keepSignedIn: false }, { keepSignedIn: undefined }, { keepSignedIn: "yes" }, { keepSignedIn: undefined, omitted: true }]) {
    reset();
    const openkey = fakeOpenKey({ lease: "valid" });
    const { omitted, ...choice } = unticked;
    const given = { ...options, ...choice, openkey };
    if (omitted) delete given.keepSignedIn;
    const signedIn = await connectOpenKeyTinyCloud(manifest, given);
    assert.equal("renewal" in openkey.calls.authorize[0].request, false, `${manifest.app_id}: no renewal ask`);
    assert.notEqual(openkey.calls.authorize[0].request.expiryChangeable, true);
    assert.equal(signedIn.renewsUntil, null);
    assert.equal(nodeKeyCalls().length, 0);
    assert.equal(leaseCalls().length, 0);
    assert.equal(storedSession(manifest), null);
    assert.equal(loadRenewalReceipt(manifest, address), null);
    assert.deepEqual(savedSessionKeys(), []);
  }
}

// A lease longer than the 7 days asked for is refused (the lease checks out otherwise): not sent, not kept.
{
  reset();
  const signedIn = await connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: { leaseSeconds: 8 * 86_400 } }) });
  assert.equal(signedIn.renewsUntil, null);
  assert.equal(leaseCalls().length, 0);
  assert.equal(loadRenewalReceipt(PAIN_MANIFEST, address), null);
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
  await assert.rejects(connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey }), /Pain Tracker needs access to .* to work\. Sign in again and keep all permissions\./);
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

console.log("renewal sign-in tests passed");
process.exit(0);
