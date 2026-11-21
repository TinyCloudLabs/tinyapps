import { useCallback, useEffect, useRef, useState } from "react";

import { renewsAtSignIn } from "./manifests.js";
import { restoreSavedSession, signOutOfTinyCloud } from "./restore.js";
import { connectOpenKeyTinyCloud } from "./tinycloud.js";

export function useTinyCloudApp(manifest) {
  const [tcw, setTcw] = useState(null);
  const [session, setSession] = useState(null);
  const [openKeyAddress, setOpenKeyAddress] = useState("");
  const [renewsUntil, setRenewsUntil] = useState(null);
  const [error, setError] = useState("");
  // A renewing app is not ready until the saved sign-in has been tried: no sign-in screen flashes before it.
  const [ready, setReady] = useState(() => !renewsAtSignIn(manifest));
  const [signingIn, setSigningIn] = useState(false);
  const [signOutNotice, setSignOutNotice] = useState(null);
  const clientRef = useRef(null);
  // The OpenKey client this tab signed in with; a tab restored from the saved session has none.
  const openkeyRef = useRef(null);

  useEffect(() => {
    setTcw(null);
    setSession(null);
    setOpenKeyAddress("");
    setRenewsUntil(null);
    setError("");
    setSignOutNotice(null);
    openkeyRef.current = null;
    if (!renewsAtSignIn(manifest)) {
      setReady(true);
      return undefined;
    }
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

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setError("");
    setSignOutNotice(null);
    try {
      const next = await connectOpenKeyTinyCloud(manifest);
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
  // starts signed out. Never throws; `signOutNotice` says when OpenKey did not confirm the end.
  const signOut = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const { notice } = await signOutOfTinyCloud(manifest, client, openKeyAddress, { openkey: openkeyRef.current });
    clientRef.current = null;
    openkeyRef.current = null;
    setTcw(null);
    setSession(null);
    setOpenKeyAddress("");
    setRenewsUntil(null);
    setSignOutNotice(notice);
  }, [manifest, openKeyAddress]);

  return {
    tcw,
    session,
    ready,
    signingIn,
    error,
    signIn,
    signOut,
    openKeyAddress,
    renewsUntil,
    signOutNotice,
  };
}
