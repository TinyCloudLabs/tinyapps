import { OpenKey } from "@openkey/sdk";
import { TinyCloudWeb } from "@tinycloud/web-sdk";

import { manifestForOwner } from "./manifests.js";
import {
  SESSION_EXPIRATION_MS,
  appSessionStorage,
  clearRenewalReceipt,
  keptLeaseEnd,
  renewalRestoreFor,
} from "./renewal.js";
import { applicationsKV, tinycloudSettings } from "./tinycloud.js";

// Restoring a saved sign-in on load, for the renewing apps. Restoring sends nothing to the owner's space (no
// manifest publish) and never touches the secrets path: a restored session has no secrets signer.

// Draft copy, the copy owner words it.
export const RESTORE_UNAVAILABLE_MESSAGE = "Can't reach TinyCloud right now. You're still signed in; reload to try again.";
export const RESTORE_OFFLINE_MESSAGE = "You're offline. You're still signed in; reload when you're back online.";

function browserIsOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/** Answers account and chain lookups for a restored client; a restore never signs. */
function readOnlyAccountProvider(address) {
  return {
    request: async ({ method }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_accounts") return [address];
      throw new Error(`${method} is not available on a restored session`);
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
}

/** A client set up only to restore the saved session of `address`: it never signs in or sets up an account. */
export function createRestoreClient(manifest, address, options = {}) {
  const { host, domain } = tinycloudSettings(options);
  return TinyCloudWeb.create({
    manifest: manifestForOwner(manifest, address),
    tinycloudHosts: [host],
    domain,
    provider: readOnlyAccountProvider(address),
    persistSession: true,
    sessionExpirationMs: SESSION_EXPIRATION_MS,
    sessionStorageKeyPrefix: appSessionStorage(manifest).keyPrefix,
    autoCreateSpace: false,
    autoBootstrapAccount: false,
  });
}

/** One live read at the node: a lease-restored session is shown only once the node has accepted it. */
async function liveRead(manifest, tcw) {
  const listed = await applicationsKV(tcw).list({ prefix: `${manifest.app_id}/`, removePrefix: false });
  if (!listed.ok) throw listed.error;
}

function refusalStatus(error) {
  return error?.meta?.status ?? error?.status;
}

/** Restore statuses the SDK reaches by reading the saved session itself: no network, so a retry changes nothing. */
const AUTHORITATIVE_STATUSES = new Set(["expired", "corrupt", "stale", "missing"]);

/** The node's own codes for a lease it will not renew (sdk-core's renewal refusals). */
const REFUSAL_CODES = new Set(["RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_EXPIRED", "RENEWAL_LEASE_ORIGINAL_EXPIRED"]);

/** A node or registry refusal that says the lease or session is revoked or expired: 401/403 or a renewal refusal code. */
function isAuthoritativeRefusal(error) {
  for (let depth = 0; depth < 4 && error != null && typeof error === "object"; depth++) {
    if (REFUSAL_CODES.has(error.code)) return true;
    const status = refusalStatus(error);
    if (status === 401 || status === 403) return true;
    error = error.cause;
  }
  return false;
}

/**
 * Restore the saved sign-in of a renewing app. Resolves
 * - `{ kind: "restored", tcw, session, address, renewsUntil }`;
 * - `{ kind: "signedOut" }`: nothing saved, or an authoritative answer ended the saved session (expired, corrupt,
 *   stale or missing, or the node refusing it as revoked or expired): the saved session and its renewal receipt
 *   are cleared;
 * - `{ kind: "unavailable", message }`: the restore failed without an authoritative answer (the node couldn't be
 *   reached, a timeout, a 5xx, unavailable storage or an error nobody recognises). Nothing is cleared; reload
 *   retries.
 * A saved session past its signed end is restored through its own verified renewal receipt, else not at all.
 */
export async function restoreSavedSession(manifest, deps = {}) {
  const {
    storage = appSessionStorage(manifest),
    createClient = (address) => createRestoreClient(manifest, address),
    isOffline = browserIsOffline,
  } = deps;
  const unavailable = () => ({
    kind: "unavailable",
    message: isOffline() ? RESTORE_OFFLINE_MESSAGE : RESTORE_UNAVAILABLE_MESSAGE,
  });
  const clearSaved = async (address) => {
    clearRenewalReceipt(manifest, address);
    await storage.clear(address).catch(() => undefined);
  };

  const address = storage.activeAddress() ?? storage.activeAddressForRenewal();
  if (!address) return { kind: "signedOut" };

  let renewal = null;
  let tcw;
  try {
    renewal = await renewalRestoreFor(manifest, address, storage);
    tcw = await createClient(address);
  } catch {
    // Failing to read the saved session or set up the client says nothing about the session itself: keep it.
    return unavailable();
  }

  let result;
  try {
    result = renewal ? await tcw.restoreSessionWithRenewal(renewal.leaseAuthorization, address) : await tcw.restoreSession(address);
  } catch (error) {
    result = { status: "restore-failed", error };
  }

  if (result.status === "restored" && result.session) {
    if (renewal) {
      try {
        await liveRead(manifest, tcw);
      } catch (error) {
        if (isAuthoritativeRefusal(error)) {
          await clearSaved(address);
          await Promise.resolve(tcw.signOut()).catch(() => undefined);
          return { kind: "signedOut" };
        }
        tcw.cleanup();
        return unavailable();
      }
    }
    const renewsUntil = renewal?.leaseExpiresAt ?? (await keptLeaseEnd(manifest, address, storage));
    return { kind: "restored", tcw, session: result.session, address, renewsUntil };
  }

  tcw.cleanup();
  // Only an answer from the saved session itself or from the node ends it: a session the SDK found expired,
  // corrupt, stale or missing, or a refusal that says the lease or session is revoked or expired. A failure to
  // reach anything (network, timeout, 5xx, storage unavailable) and any error that is not recognisably one of
  // those answers leave the saved session and its receipt in place; a reload retries.
  if (AUTHORITATIVE_STATUSES.has(result.status) || isAuthoritativeRefusal(result.error)) {
    await clearSaved(address);
    return { kind: "signedOut" };
  }
  return unavailable();
}

/** How long sign-out waits for OpenKey before it goes on with the local sign-out. */
export const OPENKEY_SIGN_OUT_TIMEOUT_MS = 5_000;

// Draft copy, the copy owner words it.
export const SIGN_OUT_NOTICE =
  "You're signed out here, but renewal may still be on. You can stop it under Renewing permissions in OpenKey settings.";

/**
 * Ends the OpenKey session and its leases. The web SDK's `signOut` is local only and never calls OpenKey, so a
 * lease would outlive it unless the app asks OpenKey itself. Only `revoked === true` counts as ended. Never throws.
 * Resolves true when OpenKey confirmed the end.
 */
async function endOpenKeySession(client, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("OpenKey sign-out timed out")), timeoutMs);
  });
  try {
    const acknowledgement = await Promise.race([Promise.resolve().then(() => client().signOut()), deadline]);
    return acknowledgement?.revoked === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign out of the session of `address`: ends the OpenKey session and its leases first (it can open OpenKey's
 * window, which needs the click), then signs out locally and clears the saved session and its renewal receipt.
 * `openkey` is the client this tab signed in with; a tab restored through the saved session has none, so it
 * builds one with `createOpenKey`. It always asks, so a lost receipt cannot leave a lease behind. Resolves `{ notice }`: null when OpenKey confirmed, else a short notice that renewal may still be on. Never
 * throws: the local sign-out and the clearing always happen.
 */
export async function signOutOfTinyCloud(
  manifest,
  tcw,
  address,
  { openkey = null, createOpenKey = () => new OpenKey(openKeySettings(manifest)), timeoutMs = OPENKEY_SIGN_OUT_TIMEOUT_MS } = {},
) {
  let notice = null;
  try {
    const ended = await endOpenKeySession(() => openkey ?? createOpenKey(), timeoutMs);
    if (!ended) notice = SIGN_OUT_NOTICE;
  } catch {
    notice = SIGN_OUT_NOTICE;
  }
  clearRenewalReceipt(manifest, address);
  try {
    await tcw.signOut();
  } catch {
    // The saved session is cleared below whatever the client says.
  }
  await appSessionStorage(manifest)
    .clear(address)
    .catch(() => undefined);
  return { notice };
}

function openKeySettings(manifest) {
  return { host: tinycloudSettings().openKeyHost, appName: manifest.name };
}
