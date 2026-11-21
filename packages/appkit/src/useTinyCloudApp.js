import { useCallback, useEffect, useRef, useState } from "react";

import { restoreSavedSession, signOutLocally, signOutOfTinyCloud } from "./restore.js";
import { connectOpenKeyTinyCloud, isSessionEndedError } from "./tinycloud.js";

const messageOf = (err) => (err instanceof Error ? err.message : String(err));

export function useTinyCloudApp(manifest) {
  const [tcw, setTcw] = useState(null);
  const [session, setSession] = useState(null);
  const [openKeyAddress, setOpenKeyAddress] = useState("");
  const [renewsUntil, setRenewsUntil] = useState(null);
  const [error, setError] = useState("");
  // Not ready until the saved sign-in has been tried: no sign-in screen flashes before it.
  const [ready, setReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signOutNotice, setSignOutNotice] = useState(null);
  const [signingOut, setSigningOut] = useState(false);
  // The session ended while the person was in the app: the screen stays, and signing in again happens in place.
  const [expired, setExpired] = useState(false);
  const clientRef = useRef(null);
  // The OpenKey client this tab signed in with; a tab restored from the saved session has none.
  const openkeyRef = useRef(null);
  const signingOutRef = useRef(false);
  // The action that failed because the session ended, run once more after the person signs in again.
  const retryRef = useRef(null);
  const reauthorizingRef = useRef(false);
  // Counts sign-ins, so a late answer to an earlier sign-out is not shown over a newer sign-in.
  const epochRef = useRef(0);
  // Counts sign-outs. An in-place sign-in or lease restore that was started before a sign-out must not outlive it.
  const signOutGenRef = useRef(0);

  useEffect(() => {
    setTcw(null);
    setSession(null);
    setOpenKeyAddress("");
    setRenewsUntil(null);
    setError("");
    setSignOutNotice(null);
    setExpired(false);
    retryRef.current = null;
    openkeyRef.current = null;
    setReady(false);
    let cancelled = false;
    restoreSavedSession(manifest)
      .then((outcome) => {
        if (cancelled) {
          if (outcome.kind === "restored") outcome.tcw.cleanup();
          return;
        }
        if (outcome.kind === "restored") {
          clientRef.current = outcome.tcw;
          setTcw(outcome.tcw);
          setSession(outcome.session);
          setOpenKeyAddress(outcome.address);
          setRenewsUntil(outcome.renewsUntil);
        } else if (outcome.kind === "unavailable") {
          setError(outcome.message);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  const adopt = useCallback((next) => {
    clientRef.current = next.tcw;
    openkeyRef.current = next.openkey ?? null;
    setTcw(next.tcw);
    setSession(next.session);
    setOpenKeyAddress(next.openKeyAddress);
    setRenewsUntil(next.renewsUntil);
  }, []);

  // A sign-in or lease restore that finishes after the person signed out: nothing is adopted, and the client it
  // made is signed out with its saved session and receipt cleared, so a reload does not sign the person in again.
  const discardLate = useCallback(
    async (client, address) => {
      try {
        await signOutLocally(manifest, client, address);
      } catch {
        // Nothing is adopted either way.
      }
    },
    [manifest],
  );

  const signIn = useCallback(async () => {
    epochRef.current += 1;
    const signedOutAt = signOutGenRef.current;
    setSigningIn(true);
    setError("");
    setSignOutNotice(null);
    try {
      const next = await connectOpenKeyTinyCloud(manifest);
      if (signOutGenRef.current !== signedOutAt) {
        await discardLate(next.tcw, next.openKeyAddress);
        return null;
      }
      adopt(next);
      return next.session;
    } catch (err) {
      setError(messageOf(err));
      return null;
    } finally {
      setSigningIn(false);
    }
  }, [manifest, adopt, discardLate]);

  // Runs `action(tcw)` against the current session. Resolves `{ done: true, value }`. When the failure is the
  // session having ended (see `isSessionEndedError`) it keeps the action, sets `expired` and resolves
  // `{ done: false }`: nothing is cleared, the caller's screen and entry stay as they are. Any other failure
  // throws, for the caller's usual error display.
  const runWithSession = useCallback(async (action) => {
    try {
      return { done: true, value: await action(clientRef.current) };
    } catch (err) {
      if (!isSessionEndedError(err)) throw err;
      retryRef.current = action;
      setExpired(true);
      return { done: false };
    }
  }, []);

  // Signs in again in place, no route change: through the saved renewal lease when there is one, else through
  // OpenKey's sign-in window. The new client and session replace the old ones. Resolves true on success; a
  // refusal or a cancelled window leaves `expired` set with the reason in `error`.
  const reauthorize = useCallback(async () => {
    if (reauthorizingRef.current) return false;
    reauthorizingRef.current = true;
    epochRef.current += 1;
    const signedOutAt = signOutGenRef.current;
    const late = () => signOutGenRef.current !== signedOutAt;
    setSigningIn(true);
    setError("");
    try {
      let next = null;
      const outcome = await restoreSavedSession(manifest).catch(() => null);
      if (late()) {
        if (outcome?.kind === "restored") await discardLate(outcome.tcw, outcome.address);
        return false;
      }
      if (outcome?.kind === "restored" && outcome.renewsUntil) {
        next = { tcw: outcome.tcw, session: outcome.session, openKeyAddress: outcome.address, renewsUntil: outcome.renewsUntil, openkey: null };
      } else {
        if (outcome?.kind === "restored") outcome.tcw.cleanup();
        next = await connectOpenKeyTinyCloud(manifest);
        if (late()) {
          await discardLate(next.tcw, next.openKeyAddress);
          return false;
        }
      }
      adopt(next);
      setExpired(false);
      return true;
    } catch (err) {
      setError(messageOf(err));
      return false;
    } finally {
      reauthorizingRef.current = false;
      setSigningIn(false);
    }
  }, [manifest, adopt, discardLate]);

  // The prompt's button: sign in again, then run the kept action exactly once on the new session. A failure of
  // that one run is shown (in `error`); the entry is still kept.
  const resume = useCallback(async () => {
    const action = retryRef.current;
    if (!(await reauthorize())) return { done: false };
    retryRef.current = null;
    if (!action) return { done: true };
    try {
      return { done: true, value: await action(clientRef.current) };
    } catch (err) {
      setError(messageOf(err));
      return { done: false };
    }
  }, [reauthorize]);

  // Signs out: the session, the saved session and the renewal receipt are cleared and the signed-out screen shows
  // at once, without waiting for OpenKey. OpenKey's answer (it is asked to end its session and leases, and can wait
  // for the person) then arrives as the notice, also kept as `signOutNotice`: that access won't renew when OpenKey
  // confirmed the end, else that OpenKey may still be renewing it. The screen clears even if a local step throws,
  // and a notice that arrives after a newer sign-in or sign-out is dropped.
  const signOut = useCallback(async () => {
    const client = clientRef.current;
    if (!client || signingOutRef.current) return null;
    signingOutRef.current = true;
    setSigningOut(true);
    // A new sign-in or sign-out while OpenKey is still being awaited makes this one's notice stale.
    const generation = (epochRef.current += 1);
    signOutGenRef.current += 1;
    let cleared = false;
    const clearScreen = () => {
      // Once only: a later call (the `finally`) must not wipe a sign-in that started while OpenKey was awaited.
      if (cleared) return;
      cleared = true;
      signingOutRef.current = false;
      clientRef.current = null;
      openkeyRef.current = null;
      retryRef.current = null;
      setTcw(null);
      setSession(null);
      setOpenKeyAddress("");
      setRenewsUntil(null);
      setExpired(false);
      setSignOutNotice(null);
      setSigningOut(false);
    };
    try {
      const { notice } = await signOutOfTinyCloud(manifest, client, openKeyAddress, { openkey: openkeyRef.current, onSignedOut: clearScreen });
      if (epochRef.current !== generation) return null;
      setSignOutNotice(notice);
      return notice;
    } finally {
      clearScreen();
    }
  }, [manifest, openKeyAddress]);

  return {
    tcw,
    session,
    ready,
    signingIn,
    error,
    signIn,
    signOut,
    signingOut,
    openKeyAddress,
    renewsUntil,
    signOutNotice,
    expired,
    runWithSession,
    reauthorize,
    resume,
  };
}
