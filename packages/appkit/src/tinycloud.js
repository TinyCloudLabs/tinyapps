import { OpenKey, OpenKeyProvider } from "@openkey/sdk";
import { AutoApproveSpaceCreationHandler, TinyCloudWeb } from "@tinycloud/web-sdk";

import { refuseNarrowedApproval } from "./approval.js";
import { normalizeStoredRecord } from "./analysis.js";
import { ANTHROPIC_SECRET_NAME, SPACE_APPLICATIONS, manifestForOwner, registryPathFor } from "./manifests.js";
import { admitSignInRenewal, appSessionStorage, openKeyRenewalClient, renewalAskFor, sessionExpirationMsFor } from "./renewal.js";

const DEFAULT_HOST = "https://node.tinycloud.xyz";
const DEFAULT_OPENKEY_HOST = "https://openkey.so";
const secretsSigners = new WeakMap();
// Draft copy, the copy owner words it.
export const REENTER_API_KEY_MESSAGE =
  "Your saved Anthropic API key can't be read after the TinyCloud update. Please enter your Anthropic API key again in Settings.";

/** Where the apps reach TinyCloud and the OpenKey sign-in, and the SIWE domain they sign in under. */
export function tinycloudSettings(options = {}) {
  return {
    host: options.host || import.meta.env?.VITE_TINYCLOUD_HOST || DEFAULT_HOST,
    openKeyHost: options.openKeyHost || import.meta.env?.VITE_OPENKEY_HOST || DEFAULT_OPENKEY_HOST,
    domain: globalThis.window?.location?.hostname || "tinyapps.local",
  };
}

/**
 * Sign in through OpenKey. It always asks OpenKey for a renewal lease (`renewalAskFor`) and keeps the session
 * saved so a reload restores it; whether to renew is the owner's choice in OpenKey's own box. The result's
 * `renewsUntil` is the end of the lease the node admitted, or null: without a lease (unticked at OpenKey, an
 * OpenKey without renewal, a lease that fails its checks or the node's refusal) the sign-in is finite and
 * nothing is kept for renewal.
 */
export async function connectOpenKeyTinyCloud(manifest, options = {}) {
  const { host, openKeyHost, domain } = tinycloudSettings(options);
  const sessionExpirationMs = sessionExpirationMsFor(manifest);

  const openkey = refuseNarrowedApproval(
    options.openkey ?? new OpenKey({ host: openKeyHost, appName: manifest.name }),
    manifest,
  );
  const authResult = await openkey.connect();

  // What OpenKey said about renewal, and when it arrived on this device's monotonic clock: the lease is sent
  // to the node only within a minute of it.
  let renewalOutcome = {};
  let renewalArrivedAt;
  // Renewal needs a sign-in window OpenKey can return a lease through (not redirect) and a session end the
  // owner may change, within the session length of the app's tier (`maxExpiresAt` limits a changed end only).
  const openkeySignIn = {
    client: openKeyRenewalClient(openkey, renewalAskFor(manifest), (outcome) => {
      renewalOutcome = outcome;
      renewalArrivedAt = performance.now();
    }),
    mode: "iframe",
    expiryChangeable: true,
    maxExpiresAt: () => Date.now() + sessionExpirationMs,
  };

  // Sign-in goes through OpenKey's versioned `authorizeTinyCloud` (config.openkey):
  // OpenKey reviews and signs the session grant. The provider below only answers
  // account and chain lookups; sign-in never calls its `personal_sign`.
  const tcw = await TinyCloudWeb.create({
    manifest: manifestForOwner(manifest, authResult.address),
    tinycloudHosts: [host],
    domain,
    provider: new OpenKeyProvider(openkey, authResult),
    openkey: openkeySignIn,
    sessionExpirationMs,
    persistSession: true,
    sessionStorageKeyPrefix: appSessionStorage(manifest).keyPrefix,
    autoCreateSpace: true,
    spacePrefix: SPACE_APPLICATIONS,
    spaceCreationHandler: new AutoApproveSpaceCreationHandler(),
    siweConfig: {
      domain,
      statement: `Sign in to ${manifest.name}.`,
    },
  });
  const session = await tcw.signIn();
  // OpenKey records the lease but does not send it to the node: the session's node admits it here, else this
  // sign-in runs to its signed end.
  const renewsUntil = await admitSignInRenewal({
    tcw,
    manifest,
    address: authResult.address,
    renewal: renewalOutcome.renewal,
    arrivedAt: renewalArrivedAt,
  });
  // Secrets unlock derives its key from a byte-exact signature, a separate use from sign-in.
  secretsSigners.set(tcw, {
    signMessage: async (message) => (await openkey.signMessage({ message, keyId: authResult.keyId })).signature,
  });
  await publishManifest(tcw, manifest);
  return {
    tcw,
    session,
    openkey,
    openKeyAddress: authResult.address,
    openKeyKeyId: authResult.keyId,
    renewsUntil,
  };
}

// Draft copy, the copy owner words it.
export const SECRETS_ACCOUNT_MESSAGE =
  "Your saved Anthropic API key can only be unlocked with the OpenKey account you signed in with. Sign out and sign in again with that account.";
// Draft copy, the copy owner words it.
export const SECRETS_UNLOCK_MESSAGE = "Couldn't unlock your saved Anthropic API key. Approve the OpenKey prompt and try again.";

/**
 * A restored session has no OpenKey client, so no secrets signer. Unlocking secrets needs a byte-exact signature
 * from OpenKey: this gives the restored client a signer that asks for one only when secrets are first used,
 * connecting a fresh OpenKey client (the person approves in its window, as at sign-in) and checking it is the
 * saved account. A refusal or a different account fails with a plain message; nothing resolves to an empty key.
 */
export function attachRestoredSecretsSigner(tcw, address, createOpenKey) {
  let connected = null;
  secretsSigners.set(tcw, {
    signMessage: async (message) => {
      try {
        connected ??= (async () => {
          const openkey = createOpenKey();
          return { openkey, authResult: await openkey.connect() };
        })();
        const { openkey, authResult } = await connected;
        if (String(authResult.address).toLowerCase() !== String(address).toLowerCase()) throw new Error(SECRETS_ACCOUNT_MESSAGE);
        return (await openkey.signMessage({ message, keyId: authResult.keyId })).signature;
      } catch (error) {
        connected = null;
        throw error instanceof Error && error.message === SECRETS_ACCOUNT_MESSAGE ? error : new Error(SECRETS_UNLOCK_MESSAGE);
      }
    },
  });
}

export async function publishManifest(tcw, manifest) {
  const result = await applicationsKV(tcw).put(registryPathFor(manifest), {
    ...manifest,
    publishedAt: new Date().toISOString(),
  });
  return unwrap(result, `publish ${manifest.app_id} manifest`);
}

export async function listPublishedManifests(tcw) {
  const list = unwrap(await applicationsKV(tcw).list({ prefix: "", path: "", removePrefix: false }), "list app manifests");
  const keys = uniqueKeys(list.keys || []).filter((key) => key.endsWith("/manifest.json"));
  const manifests = new Map();
  for (const key of keys) {
    const entry = unwrap(await applicationsKV(tcw).get(key), `read ${key}`);
    const manifest = kvValue(entry);
    if (manifest?.app_id) manifests.set(manifest.app_id, manifest);
  }
  return [...manifests.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function putRecord(tcw, prefix, record) {
  const result = await applicationsKV(tcw).put(`${prefix}${record.id}.json`, record);
  unwrap(result, `write record ${record.id}`);
  return record;
}

export async function listRecords(tcw, prefix) {
  const list = unwrap(await applicationsKV(tcw).list({ prefix, removePrefix: false }), `list ${prefix}`);
  const keys = uniqueKeys(list.keys || []).filter((key) => key.endsWith(".json"));
  const records = [];
  for (const key of keys) {
    const entry = unwrap(await applicationsKV(tcw).get(key), `read ${key}`);
    records.push(normalizeStoredRecord(kvValue(entry), key));
  }
  return records.sort((a, b) => b.ts - a.ts);
}

function uniqueKeys(keys) {
  return [...new Set(keys)];
}

export async function deleteRecord(tcw, prefix, id) {
  const result = await applicationsKV(tcw).delete(`${prefix}${id}.json`);
  return unwrap(result, `delete record ${id}`);
}

export async function putPhoto(tcw, appId, id, photo) {
  const path = `${appId}/photos/${id}.json`;
  unwrap(await applicationsKV(tcw).put(path, photo), `write photo ${id}`);
  return path;
}

export async function getAnthropicApiKey(tcw) {
  await unlockSecrets(tcw);
  const result = await tcw.secrets.get(ANTHROPIC_SECRET_NAME);
  if (!result.ok) {
    // A key saved by the older appkit sits in the previous vault format and can't be decrypted.
    if (result.error?.code === "DECRYPTION_FAILED") throw new Error(REENTER_API_KEY_MESSAGE);
    // An ended session is no missing key: say so, never an empty key.
    if (isSessionEndedError(result.error)) throw new Error("read Anthropic API key failed: session ended", { cause: result.error });
    return "";
  }
  const value = kvValue(result.data);
  return typeof value === "string" ? value : "";
}

export async function setAnthropicApiKey(tcw, apiKey) {
  const trimmed = apiKey.trim();
  await unlockSecrets(tcw);
  if (!trimmed) {
    return unwrap(await tcw.secrets.delete(ANTHROPIC_SECRET_NAME), "delete Anthropic API key");
  }
  return unwrap(await tcw.secrets.put(ANTHROPIC_SECRET_NAME, trimmed), "store Anthropic API key");
}

export function applicationsKV(tcw) {
  return tcw.space(SPACE_APPLICATIONS).kv;
}

export function unwrap(result, label) {
  if (result?.ok) return result.data;
  const message = result?.error?.message || result?.error?.code || "unknown TinyCloud error";
  // The SDK's own error rides along as the cause, so a caller can tell a session that ended from any other failure.
  throw new Error(`${label} failed: ${message}`, { cause: result?.error });
}

/**
 * Did this failure come from the session having ended? The SDK reports a node 401/403 as `AUTH_UNAUTHORIZED`
 * (a session past its signed end is refused that way) and its own expiry as `AUTH_EXPIRED`; the HTTP status
 * rides in `meta.status`. Nothing else counts: any other error keeps the app's usual display. Follows `cause`.
 */
export function isSessionEndedError(error) {
  for (let depth = 0; depth < 4 && error != null && typeof error === "object"; depth++) {
    if (error.code === "AUTH_UNAUTHORIZED" || error.code === "AUTH_EXPIRED") return true;
    const status = error.meta?.status ?? error.status;
    if (status === 401 || status === 403) return true;
    error = error.cause;
  }
  return false;
}

async function unlockSecrets(tcw) {
  if (!tcw.secrets) {
    throw new Error("TinyCloud secrets wrapper is unavailable in this SDK build");
  }
  return unwrap(await tcw.secrets.unlock(secretsSigners.get(tcw)), "unlock secrets");
}

function kvValue(entry) {
  const value = entry && typeof entry === "object" && "data" in entry ? entry.data : entry;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
