import assert from "node:assert/strict";

import "./support/browser.mjs";

import { privateKeyToAccount } from "viem/accounts";

const { REENTER_API_KEY_MESSAGE, connectOpenKeyTinyCloud, getAnthropicApiKey } = await import("../src/tinycloud.js");
const { FOOD_MANIFEST } = await import("../src/manifests.js");

const account = privateKeyToAccount(`0x${"1".padStart(64, "0")}`);
const address = account.address;

// 3.13 signs a non-first-party app in only for an owner with a registered account: the registry answers an owner-signed
// v2 location record that routes the owner's spaces to the stub node.
const stubNodeDid = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const locationFields = {
  version: 2,
  subject: `did:pkh:eip155:1:${address}`,
  nodes: [{ did: stubNodeDid, url: "https://node.example" }],
  spaces: ["applications", "default", "secrets"].map((name) => ({
    space: `tinycloud:pkh:eip155:1:${address}:${name}`,
    nodes: [{ did: stubNodeDid, mode: "read-write" }],
  })),
  encryptionNode: stubNodeDid,
  updated_at: "2026-07-14T00:00:00.000Z",
  sequence: 1,
};
const locationRecord = { ...locationFields, signature: await account.signMessage({ message: JSON.stringify(locationFields) }) };
// The registry cache the SDK keeps wants Web Locks, which Node lacks: a lock that is always granted.
Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: { request: async (_name, ...rest) => rest.at(-1)({}) },
});
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.startsWith("/v2/locations/")) return json({ record: locationRecord });
  if (url.pathname === "/info") return json({ protocol: 1, version: "1.26.7", features: [], nodeId: stubNodeDid });
  if (url.pathname === "/.well-known/tinycloud/node-keys") return json({ nodeDid: stubNodeDid });
  return new Response("stub node", { status: 404 });
};

function fakeOpenKey(authorize) {
  const calls = { connect: 0, authorize: [], signMessage: 0 };
  return {
    calls,
    async connect() {
      calls.connect += 1;
      return { address, keyId: "key_test", keyType: "MANAGED" };
    },
    async authorizeTinyCloud(request, opts) {
      calls.authorize.push({ request, opts });
      return authorize(request);
    },
    async signMessage() {
      calls.signMessage += 1;
      throw new Error("legacy signMessage must not be used for sign-in");
    },
  };
}

const options = { host: "https://node.example.test", openKeyHost: "https://openkey.example.test" };

// Sign-in asks OpenKey through the versioned authorizeTinyCloud request, never byte-exact signMessage.
{
  const openkey = fakeOpenKey(async () => {
    throw new Error("declined in test");
  });
  await assert.rejects(connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }), /declined in test/);
  assert.equal(openkey.calls.connect, 1);
  assert.equal(openkey.calls.authorize.length, 1);
  assert.equal(openkey.calls.signMessage, 0);
  const [{ request, opts }] = openkey.calls.authorize;
  assert.equal(request.protocolVersion, 1);
  assert.equal(opts.mode, "iframe");
  assert.match(request.siwe, new RegExp(`vault/secrets/${FOOD_MANIFEST.secrets && Object.keys(FOOD_MANIFEST.secrets)[0]}`));
  assert.deepEqual(request.renewal, { version: 1, leaseLifetimeSeconds: 604800 });
}

// A declined approval reaches the caller as the error useTinyCloudApp shows, and signs nothing.
{
  const openkey = fakeOpenKey(async () => {
    throw { code: "USER_CANCELLED", message: "User cancelled" };
  });
  await assert.rejects(connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }));
  assert.equal(openkey.calls.signMessage, 0);
}

// A narrowed approval (owner unticked a permission) is refused in plain words and leaves no session.
{
  const narrow = (siwe) => {
    const recap = /urn:recap:([A-Za-z0-9_-]+)/.exec(siwe)[1];
    const payload = JSON.parse(Buffer.from(recap, "base64url").toString());
    const dropped = Object.keys(payload.att).find((resource) => resource.includes(":secrets/kv/vault/secrets/"));
    assert.ok(dropped, "request asks for the secret read");
    delete payload.att[dropped];
    // 3.13 checks the statement line against the ReCap, so the dropped permission leaves the statement too.
    let count = 0;
    return siwe
      .replace(recap, Buffer.from(JSON.stringify(payload)).toString("base64url"))
      .replace(/ \(\d+\) '[^']+': [^.]*? for '([^']+)'\./g, (clause, resource) => (resource === dropped ? "" : clause))
      .replace(/ \(\d+\) /g, () => ` (${++count}) `);
  };
  const openkey = fakeOpenKey(async (request) => ({
    protocolVersion: 1,
    address,
    signature: "0x",
    signedMessage: narrow(request.siwe),
    selectedActionKeys: [],
    permissions: [],
  }));
  await assert.rejects(
    connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }),
    (error) => {
      assert.equal(
        error.message,
        "Food Tracker needs access to your saved Anthropic API key to work. Sign in again and keep all permissions.",
      );
      return true;
    },
  );
  assert.equal(openkey.calls.authorize.length, 1);
}

// A key saved in the previous vault format asks the user to re-enter it; it is not a silent empty key.
{
  const fakeTcw = (error) => ({ secrets: { unlock: async () => ({ ok: true }), get: async () => ({ ok: false, error }) } });
  await assert.rejects(
    getAnthropicApiKey(fakeTcw({ code: "DECRYPTION_FAILED", service: "vault", message: "envelope.v must be 1 (got undefined)" })),
    { message: REENTER_API_KEY_MESSAGE },
  );
  // A key that was never saved stays an empty key.
  assert.equal(await getAnthropicApiKey(fakeTcw({ code: "KEY_NOT_FOUND", service: "vault" })), "");
}

console.log("sign-in tests passed");
process.exit(0);
