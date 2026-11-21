import { useCallback, useEffect, useRef, useState } from "react";

import { restoreSavedSession, signOutOfTinyCloud } from "./restore.js";
import { connectOpenKeyTinyCloud } from "./tinycloud.js";

// `appName` is the name the app shows in its header; the sign-out notice names it.
export function useTinyCloudApp(manifest, { appName = manifest.name } = {}) {
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
  const clientRef = useRef(null);
  // The OpenKey client this tab signed in with; a tab restored from the saved session has none.
  const openkeyRef = useRef(null);
  const signingOutRef = useRef(false);

  useEffect(() => {
    setTcw(null);
    setSession(null);
    setOpenKeyAddress("");
    setRenewsUntil(null);
    setError("");
    setSignOutNotice(null);
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

  // `keepSignedIn` is the person's tick on the sign-in screen: only then is a renewal lease asked for.
  const signIn = useCallback(async ({ keepSignedIn } = {}) => {
    setSigningIn(true);
    setError("");
    setSignOutNotice(null);
    try {
      const next = await connectOpenKeyTinyCloud(manifest, { keepSignedIn: keepSignedIn === true });
      clientRef.current = next.tcw;
      openkeyRef.current = next.openkey;
      setTcw(next.tcw);
      setSession(next.session);
      setOpenKeyAddress(next.openKeyAddress);
      setRenewsUntil(next.renewsUntil);
      return next.session;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSigningIn(false);
    }
  }, [manifest]);

  // Ends the OpenKey session and its leases, then clears the saved session and renewal receipt, so the next load
  // starts signed out. Never throws. Resolves the notice (also kept as `signOutNotice`): that access won't
  // renew when OpenKey confirmed the end, else that OpenKey may still be renewing it.
  const signOut = useCallback(async () => {
    const client = clientRef.current;
    if (!client || signingOutRef.current) return null;
    signingOutRef.current = true;
    setSigningOut(true);
    try {
      const { notice } = await signOutOfTinyCloud(manifest, client, openKeyAddress, { openkey: openkeyRef.current, appName });
      clientRef.current = null;
      openkeyRef.current = null;
      setTcw(null);
      setSession(null);
      setOpenKeyAddress("");
      setRenewsUntil(null);
      setSignOutNotice(notice);
      return notice;
    } finally {
      signingOutRef.current = false;
      setSigningOut(false);
    }
  }, [manifest, openKeyAddress, appName]);

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
  };
}
