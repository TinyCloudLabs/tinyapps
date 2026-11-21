import { OpenKey } from "@openkey/sdk";
import { TinyCloudWeb } from "@tinycloud/web-sdk";

import { manifestForOwner } from "./manifests.js";
import {
  appSessionStorage,
  clearRenewalReceipt,
  keptLeaseEnd,
  renewalRestoreFor,
  sessionExpirationMsFor,
} from "./renewal.js";
import { applicationsKV, attachRestoredSecretsSigner, tinycloudSettings } from "./tinycloud.js";

// Restoring a saved sign-in on load, for the renewing apps. Restoring sends nothing to the owner's space (no
// manifest publish) and never touches the secrets path. A restored session has no secrets signer until secrets
// are first used: then OpenKey is asked to confirm, see `attachRestoredSecretsSigner`.

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
    sessionExpirationMs: sessionExpirationMsFor(manifest),
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

// What a failed fetch looks like per engine: Chromium, Firefox, Safari, undici (Node).
const NETWORK_FAILURE = /failed to fetch|networkerror|load failed|network request failed|fetch failed|timed? ?out/i;

/** The node's own codes for a lease it will not renew (sdk-core's renewal refusals): never transient. */
const REFUSAL_CODES = new Set(["RENEWAL_AUTHORITY_INACTIVE", "RENEWAL_LEASE_EXPIRED", "RENEWAL_LEASE_ORIGINAL_EXPIRED"]);

/**
 * Does this error mean "couldn't reach the server" rather than "the server (or the saved session) said no"?
 * Network failures, aborts and timeouts, and 408/429/5xx responses (also "HTTP 5xx" in a message) qualify.
 * Follows `cause` a few links, because SDK layers wrap the underlying fetch error. A renewal refusal code is
 * an answer, whatever else the error carries.
 */
export function isTransientRestoreError(error) {
  let current = error;
  for (let depth = 0; depth < 4 && current != null; depth++) {
    if (typeof current !== "object") return typeof current === "string" && NETWORK_FAILURE.test(current);
    if (REFUSAL_CODES.has(current.code)) return false;
    if (current.name === "AbortError" || current.name === "TimeoutError") return true;
    const status = refusalStatus(current);
    if (typeof status === "number" && (status >= 500 || status === 408 || status === 429)) return true;
    if (typeof current.message === "string") {
      if (NETWORK_FAILURE.test(current.message)) return true;
      if (/\bHTTP (5\d\d|408|429)\b/.test(current.message)) return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Restore the saved sign-in of a renewing app. Resolves
 * - `{ kind: "restored", tcw, session, address, renewsUntil }`;
 * - `{ kind: "signedOut" }`: nothing saved, or the saved session ended (a non-restored status, a refusal that is
 *   not a transient failure, a lapsed lease): the saved session and its renewal receipt are cleared;
 * - `{ kind: "unavailable", message }`: the restore failed only because something couldn't be reached (network,
 *   timeout, 408/429/5xx, offline). Nothing is cleared; reload retries.
 * A saved session past its signed end is restored through its own verified renewal receipt, else not at all.
 */
export async function restoreSavedSession(manifest, deps = {}) {
  const {
    storage = appSessionStorage(manifest),
    createClient = (address) => createRestoreClient(manifest, address),
    isOffline = browserIsOffline,
    createOpenKey = () => new OpenKey(openKeySettings(manifest)),
  } = deps;
  const unavailable = () => ({
    kind: "unavailable",
    message: isOffline() ? RESTORE_OFFLINE_MESSAGE : RESTORE_UNAVAILABLE_MESSAGE,
  });
  const clearSaved = async (address) => {
    clearRenewalReceipt(manifest, address);
    await storage.clear(address).catch(() => undefined);
  };

  // `activeAddress()` discards the pointer to a session past its signed end, which is the very session a lease
  // renews; `activeAddressForRenewal()` keeps it.
  const address = storage.activeAddressForRenewal();
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
        // Only a failure to reach the node keeps the session; any refusal (401/403 or otherwise) ends it.
        if (!isOffline() && !isTransientRestoreError(error)) {
          await clearSaved(address);
          await Promise.resolve(tcw.signOut()).catch(() => undefined);
          return { kind: "signedOut" };
        }
        tcw.cleanup();
        return unavailable();
      }
    }
    const renewsUntil = renewal?.leaseExpiresAt ?? (await keptLeaseEnd(manifest, address, storage));
    attachRestoredSecretsSigner(tcw, address, createOpenKey);
    return { kind: "restored", tcw, session: result.session, address, renewsUntil };
  }

  tcw.cleanup();
  // Every status but `restore-failed` is a verdict the SDK reached by reading the saved session itself (expired,
  // corrupt, stale, missing, storage unavailable, disabled). `restore-failed` wraps what threw while rebuilding
  // the session or asking the node: only a failure to reach something (network, timeout, 408/429/5xx, offline)
  // keeps the saved session and its receipt for a reload to retry. Any other refusal, or an error nobody
  // recognises, ends the session.
  if (result.status === "restore-failed" && (isOffline() || isTransientRestoreError(result.error))) return unavailable();
  await clearSaved(address);
  return { kind: "signedOut" };
}

/**
 * How long the notice waits for OpenKey's answer to the sign-out. OpenKey's sign-out widget waits for the person to
 * press "Sign out" in it and the SDK reports no progress, so the wait is long. The local sign-out never waits.
 */
export const OPENKEY_SIGN_OUT_TIMEOUT_MS = 120_000;

// Draft copy, the copy owner words it.
export function signedOutNoticeFor(appName) {
  return `Signed out of ${appName} in this browser. ${appName}'s access won't renew.`;
}

// Draft copy, the copy owner words it.
export function renewalMayContinueNoticeFor(appName) {
  return `You're signed out of ${appName} in this browser, but OpenKey may still be renewing its access. To stop that, choose Stop renewal under Renewing permissions in OpenKey settings.`;
}

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
    const acknowledgement = await Promise.race([client().signOut(), deadline]);
    return acknowledgement?.revoked === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign out of the session of `address`. OpenKey is asked first and left pending (its window needs the click that
 * started this), but nothing waits on it: the session is signed out locally and the saved session and its renewal
 * receipt are cleared, then `onSignedOut` runs (the app shows its signed-out screen), and only then does this wait
 * for OpenKey's answer, up to `timeoutMs`.
 * `openkey` is the client this tab signed in with; a tab restored through the saved session has none, so it
 * builds one with `createOpenKey`. It always asks, so a lost receipt cannot leave a lease behind. Resolves
 * `{ notice }`: when OpenKey confirmed, the notice that access won't renew; on anything else (declined, cancelled,
 * no answer in time) the notice that OpenKey may still be renewing it. Both name `appName`.
 * The signed-out screen is cleared (`onSignedOut`) after the local steps even when one of them throws; such an
 * error is then thrown. OpenKey's side never throws.
 */
export async function signOutOfTinyCloud(
  manifest,
  tcw,
  address,
  {
    openkey = null,
    createOpenKey = () => new OpenKey(openKeySettings(manifest)),
    timeoutMs = OPENKEY_SIGN_OUT_TIMEOUT_MS,
    appName = manifest.name,
    onSignedOut = () => undefined,
  } = {},
) {
  const ending = endOpenKeySession(() => openkey ?? createOpenKey(), timeoutMs);
  try {
    clearRenewalReceipt(manifest, address);
    try {
      await tcw.signOut();
    } catch {
      // The saved session is cleared below whatever the client says.
    }
    await appSessionStorage(manifest)
      .clear(address)
      .catch(() => undefined);
  } finally {
    // In every branch, a failing step included, the screen clears before OpenKey is awaited.
    onSignedOut();
  }
  const ended = await ending;
  return { notice: ended ? signedOutNoticeFor(appName) : renewalMayContinueNoticeFor(appName) };
}

function openKeySettings(manifest) {
  return { host: tinycloudSettings().openKeyHost, appName: manifest.name };
}
