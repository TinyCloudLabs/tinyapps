// Browser globals the web SDK touches at load time. Import this before any source module.
Object.assign(globalThis, { HTMLElement: class {}, customElements: { define() {}, get() {} } });
const storage = new Map();
const localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  key: (index) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
};
globalThis.localStorage = localStorage;
globalThis.window = Object.assign(globalThis.window ?? {}, {
  location: { host: "tinyapps.test", hostname: "tinyapps.test", origin: "https://tinyapps.test" },
  addEventListener() {},
  removeEventListener() {},
  open: () => ({}),
  crypto: globalThis.crypto,
  localStorage,
});
