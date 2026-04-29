import { useCallback, useEffect, useState } from "react";

import { connectOpenKeyTinyCloud } from "./tinycloud.js";

export function useTinyCloudApp(manifest) {
  const [tcw, setTcw] = useState(null);
  const [session, setSession] = useState(null);
  const [openKeyAddress, setOpenKeyAddress] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(true);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    setTcw(null);
    setSession(null);
    setOpenKeyAddress("");
    setError("");
    setReady(true);
  }, [manifest]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setError("");
    try {
      const next = await connectOpenKeyTinyCloud(manifest);
      setTcw(next.tcw);
      setSession(next.session);
      setOpenKeyAddress(next.openKeyAddress);
      return next.session;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSigningIn(false);
    }
  }, [manifest, tcw]);

  return {
    tcw,
    session,
    ready,
    signingIn,
    error,
    signIn,
    openKeyAddress,
  };
}
