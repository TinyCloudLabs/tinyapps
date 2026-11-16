import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import "./support/browser.mjs";

import { extractRecapAttenuations, parseCanonicalRecapResource } from "@tinycloud/sdk-core";
import { privateKeyToAccount } from "viem/accounts";

const { connectOpenKeyTinyCloud, getAnthropicApiKey } = await import("../src/tinycloud.js");
const { ANTHROPIC_SECRET_NAME, FOOD_MANIFEST, PAIN_MANIFEST, encryptionNetworkId } = await import("../src/manifests.js");

// Behaviour guard for Food Tracker's saved-key read: every capability the 3.x secret read invokes must be
// covered by the sign-in grant OpenKey signs for the Food manifest. The node here is a stub that records
// what the client sends (a real node refuses an invocation its grant does not cover).
const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const owner = account.address;
const networkId = encryptionNetworkId(owner);
const ownerDid = networkId.slice("urn:tinycloud:encryption:".length, -":default".length);
const vaultKey = `vault/secrets/${ANTHROPIC_SECRET_NAME}`;

let signedRecap = {};
const openkey = {
  async connect() {
    return { address: owner, keyId: "key_test", keyType: "MANAGED" };
  },
  // The owner approves everything that was asked.
  async authorizeTinyCloud(request) {
    signedRecap = extractRecapAttenuations(request.siwe);
    const selectedActionKeys = [];
    const permissions = [];
    for (const [resource, actions] of Object.entries(signedRecap)) {
      const { space, path } = parseCanonicalRecapResource(resource);
      const byService = new Map();
      for (const ability of Object.keys(actions)) {
        const service = ability.split("/")[0];
        if (ability !== "tinycloud.capabilities/read") selectedActionKeys.push(`${service}\0${space}\0${path}\0${ability}`);
        byService.set(service, [...(byService.get(service) ?? []), ability]);
      }
      for (const [service, abilities] of byService) permissions.push({ service, space, path, actions: abilities });
    }
    return {
      protocolVersion: 1,
      address: owner,
      signature: await account.signMessage({ message: request.siwe }),
      signedMessage: request.siwe,
      selectedActionKeys,
      permissions,
    };
  },
  async signMessage({ message }) {
    return { signature: await account.signMessage({ message }), address: owner };
  },
};

const networkKey = generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x;
const descriptor = {
  networkId,
  ownerDid,
  name: "default",
  members: [{ nodeId: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK", role: "primary" }],
  threshold: { n: 1, t: 1 },
  state: "active",
  publicEncryptionKey: Buffer.from(networkKey, "base64url").toString("base64"),
  alg: "x25519-aes256gcm/v1",
  keyVersion: 1,
  keyBackend: "local-one-of-one",
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

const invoked = [];
let storedEnvelope;
const json = (body, init) => new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (url.pathname === "/info") return json({ protocol: 1, version: "1.26.7", features: [] });
  if (url.pathname === "/delegate") return json({ activated: ["stub"], skipped: [] });
  if (url.pathname.startsWith("/encryption/networks/") && !url.pathname.endsWith("/decrypt")) return json(descriptor);
  if (url.pathname === "/invoke" || url.pathname.endsWith("/decrypt")) {
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /i, "");
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    for (const [resource, actions] of Object.entries(payload.att ?? {})) {
      for (const action of Object.keys(actions)) invoked.push({ resource, action });
    }
    const readsVault = Object.keys(payload.att ?? {}).some((resource) => resource.endsWith(`/kv/${vaultKey}`));
    if (url.pathname === "/invoke" && readsVault && storedEnvelope) {
      return new Response(JSON.stringify(storedEnvelope), { headers: { "content-type": "application/json" } });
    }
    const writes = Object.values(payload.att ?? {}).some((actions) => actions["tinycloud.kv/put"] !== undefined);
    if (url.pathname === "/invoke" && writes) return json({ written: [], count: 0 });
    return new Response("stub node", { status: url.pathname === "/invoke" ? 404 : 403 });
  }
  return new Response("stub node", { status: 404 });
};

const covers = (resource, action) =>
  Object.entries(signedRecap).some(
    ([granted, actions]) =>
      actions[action] !== undefined && (resource === granted || resource.startsWith(granted.endsWith("/") ? granted : `${granted}/`)),
  );

const options = { host: "https://node.example.test", openKeyHost: "https://openkey.example.test", openkey };
const { tcw } = await connectOpenKeyTinyCloud(FOOD_MANIFEST, options);

// A value stored as the 3.x secrets service stores it: sealed to the owner's encryption network.
const sealed = await tcw.encryption.encryptToNetwork(
  networkId,
  new TextEncoder().encode(JSON.stringify({ value: "sk-ant-test" })),
);
assert.equal(sealed.ok, true);
storedEnvelope = sealed.data;

invoked.length = 0;
await getAnthropicApiKey(tcw).catch(() => undefined); // the stub node does not answer the decrypt
const secretCalls = invoked.filter(({ resource }) => /secrets|encryption/.test(resource));
assert.ok(
  secretCalls.some(({ resource, action }) => action === "tinycloud.kv/get" && resource.endsWith(`/kv/${vaultKey}`)),
  "the read fetches the stored secret",
);
assert.ok(
  secretCalls.some(({ resource, action }) => action === "tinycloud.encryption/decrypt" && resource === networkId),
  "the read decrypts through the owner's default encryption network",
);
for (const { resource, action } of secretCalls) {
  assert.equal(covers(resource, action), true, `sign-in grant covers ${action} on ${resource}`);
}

// Pain Tracker never reads a secret, so its sign-in must not ask for decrypt.
const pain = await connectOpenKeyTinyCloud(PAIN_MANIFEST, options);
assert.ok(pain.tcw);
assert.equal(JSON.stringify(signedRecap).includes("encryption"), false);

console.log("secret read tests passed");
process.exit(0);
