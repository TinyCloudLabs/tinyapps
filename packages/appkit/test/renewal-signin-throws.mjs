import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import "./support/browser.mjs";

// The SDK signs in an owner the location registry doesn't know only from a first-party page (a third-party page
// needs an account that already exists, which would need a signed registry entry here). The apps themselves run
// as third-party pages; nothing in the code under test reads the origin.
globalThis.window.location = { host: "tinycloud.chat", hostname: "tinycloud.chat", origin: "https://tinycloud.chat" };

import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";

import { bundle } from "./support/bundle.mjs";
import { appkitSrc } from "./support/expiry.mjs";
import { mountHook } from "./support/host.mjs";
import { cacaoFromSiwe, fixture, generatePrivateKey, leaseReceipt, privateKeyToAccount } from "./support/renewal-fixture.mjs";

const { connectOpenKeyTinyCloud } = await import("../src/tinycloud.js");
const { loadRenewalReceipt } = await import("../src/renewal.js");
const { PAIN_MANIFEST, encryptionNetworkId } = await import("../src/manifests.js");

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
let failPut = false;
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
  if (url.pathname === "/invoke") {
    // With `failPut` on, a write (the manifest publish) is refused after the sign-in itself went through.
    const payload = JSON.parse(Buffer.from(authorization.replace(/^Bearer /i, "").split(".")[1], "base64url").toString());
    const writes = Object.values(payload.att ?? {}).some((granted) => Object.keys(granted).some((ability) => /\/put$/.test(ability)));
    if (failPut && writes) return json({ error: "node refused the write" }, { status: 500 });
    return json({ written: [], count: 0 });
  }
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
  failPut = false;
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

// connectOpenKeyTinyCloud saves the session (the SDK) and the renewal receipt, then publishes the manifest. When the
// publish throws, the sign-in fails; what it saved must not stay, or a reload would sign the person in from a
// sign-in that reported failure. Real crypto, the real SDK and the real connect, against the stand-in node.

const savedFor = () => ({ session: storedSession(PAIN_MANIFEST), receipt: loadRenewalReceipt(PAIN_MANIFEST, address) });

// (1) No sign-out: the publish fails, the sign-in rejects, nothing is left saved. The lease was admitted before it
// failed, so the receipt really had been saved.
{
  reset();
  failPut = true;
  await assert.rejects(connectOpenKeyTinyCloud(PAIN_MANIFEST, { ...options, openkey: fakeOpenKey({ lease: "valid" }) }), /write|publish|refused|500/i);
  assert.equal(leaseCalls().length, 1, "the lease had been admitted (a receipt had been saved)");
  assert.deepEqual(savedFor(), { session: null, receipt: null });
}

// (2) The person signs out while a sign-in is waiting for OpenKey; the sign-in then saves its session and receipt and
// throws at the publish. The hook stays signed out, with nothing saved.
{
  reset();
  const gate = { release: undefined };
  const held = new Promise((resolve) => (gate.release = resolve));
  let holdNext = false;
  const { connectOpenKeyTinyCloud: realConnect } = await import("../src/tinycloud.js");
  globalThis.__connectOpenKeyTinyCloud = async (manifest) => {
    const openkey = fakeOpenKey({ lease: "valid" });
    const authorize = openkey.authorizeTinyCloud.bind(openkey);
    openkey.authorizeTinyCloud = async (...args) => {
      if (holdNext) await held;
      return authorize(...args);
    };
    return realConnect(manifest, { ...options, openkey });
  };
  const { module: app, cleanup } = await bundle('export { useTinyCloudApp } from "./useTinyCloudApp.js";', appkitSrc);
  try {
    const hook = await mountHook(() => app.useTinyCloudApp(PAIN_MANIFEST));
    await hook.run(() => hook.value.signIn());
    assert.ok(hook.value.session, "signed in");
    assert.ok(savedFor().session && savedFor().receipt);
    // The saved session is gone (it ended and was cleared), so the in-place sign-in goes to OpenKey.
    globalThis.localStorage.removeItem(`tinyapps:${PAIN_MANIFEST.app_id}:session:${address.toLowerCase()}`);
    failPut = true;
    holdNext = true;
    let reauthorizing;
    await hook.run(async () => {
      reauthorizing = hook.value.reauthorize();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(hook.value.signingIn, true);
    await hook.run(() => hook.value.signOut());
    assert.equal(hook.value.session, null);
    assert.deepEqual(savedFor(), { session: null, receipt: null }, "sign-out cleared what was saved");
    let result;
    await hook.run(async () => {
      gate.release();
      result = await reauthorizing;
    });
    assert.equal(result, false);
    assert.equal(hook.value.session, null, "still signed out");
    assert.equal(hook.value.tcw, null);
    assert.match(hook.value.error, /write|publish|refused|500/i, "the sign-in's failure is reported");
    assert.deepEqual(savedFor(), { session: null, receipt: null }, "the failed sign-in left nothing saved");
    await hook.unmount();
  } finally {
    cleanup();
    delete globalThis.__connectOpenKeyTinyCloud;
  }
}

console.log("renewal failed sign-in tests passed");
process.exit(0);
