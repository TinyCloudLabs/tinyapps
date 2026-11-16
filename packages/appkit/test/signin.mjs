import assert from "node:assert/strict";

// Browser globals the web SDK touches at load time.
Object.assign(globalThis, { HTMLElement: class {}, customElements: { define() {}, get() {} } });
const storage = new Map();
globalThis.window = Object.assign(globalThis.window ?? {}, {
  location: { host: "tinyapps.test", hostname: "tinyapps.test", origin: "https://tinyapps.test" },
  addEventListener() {},
  removeEventListener() {},
  open: () => ({}),
  crypto: globalThis.crypto,
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  },
});
globalThis.localStorage = window.localStorage;

const { connectOpenKeyTinyCloud } = await import("../src/tinycloud.js");
const { FOOD_MANIFEST } = await import("../src/manifests.js");

const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

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
  assert.equal("renewal" in request, false);
}

// A declined approval reaches the caller as the error useTinyCloudApp shows, and signs nothing.
{
  const openkey = fakeOpenKey(async () => {
    throw { code: "USER_CANCELLED", message: "User cancelled" };
  });
  await assert.rejects(connectOpenKeyTinyCloud(FOOD_MANIFEST, { ...options, openkey }));
  assert.equal(openkey.calls.signMessage, 0);
}

console.log("sign-in tests passed");
process.exit(0);
