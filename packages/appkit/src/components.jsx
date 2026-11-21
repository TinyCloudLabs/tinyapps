import React, { useState } from "react";
import { KeyRound, Loader2, LogOut } from "lucide-react";

import { KEEP_SIGNED_IN_LABEL, keepSignedInWarning } from "./renewal.js";

export function StatusBar() {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return (
    <div className="status-bar">
      <span>{time}</span>
      <span className="status-dots">TinyCloud</span>
    </div>
  );
}

/** The opt-in to a renewing sign-in, shown before connecting: unticked it asks OpenKey for nothing extra. */
export function KeepSignedInChoice({ appName, records, checked, onChange, disabled }) {
  return (
    <div className="keep-signed-in">
      <label>
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} />
        {KEEP_SIGNED_IN_LABEL}
      </label>
      {checked && <p>{keepSignedInWarning(appName, records)}</p>}
    </div>
  );
}

/** `records` names what the app reads in the warning ("health", "food"). */
export function SignInScreen({ appName, appId, children, onSignIn, signingIn, error, notice, records }) {
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  return (
    <main className="signin-screen">
      <div className="signin-copy">
        <div className="eyebrow">Tinyapps</div>
        <h1>{children}</h1>
        <p>Data is written to your TinyCloud applications space under this app's manifest.</p>
        <code>{appId}</code>
      </div>
      {notice && <div className="date-line">{notice}</div>}
      {error && <div className="error">{error}</div>}
      <KeepSignedInChoice appName={appName} records={records} checked={keepSignedIn} onChange={setKeepSignedIn} disabled={signingIn} />
      <button className="primary-btn" onClick={() => onSignIn({ keepSignedIn })} disabled={signingIn}>
        {signingIn ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
        {signingIn ? "Signing in" : "Sign in with OpenKey"}
      </button>
    </main>
  );
}

// Draft copy, the copy owner words it.
export function SignOutButton({ onSignOut, signingOut }) {
  return (
    <button className="ghost-btn" type="button" onClick={onSignOut} disabled={signingOut}>
      {signingOut ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}
      {signingOut ? "Signing out" : "Sign out"}
    </button>
  );
}

// Draft copy, the copy owner words it.
export function RestoringScreen() {
  return (
    <main className="signin-screen">
      <div className="signin-copy">
        <div className="eyebrow">Tinyapps</div>
        <p>
          <Loader2 size={16} className="spin" /> Restoring your sign-in
        </p>
      </div>
    </main>
  );
}

/** One line for the signed-in view: shown only while a verified renewal lease is kept (`renewsUntil`, an ISO time). */
export function RenewalNote({ renewsUntil }) {
  if (!renewsUntil) return null;
  const until = new Date(renewsUntil);
  if (Number.isNaN(until.getTime())) return null;
  // Draft copy, the copy owner words it.
  return <div className="date-line">Renews until {until.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}</div>;
}

export function AppShell({ app, children }) {
  return (
    <div className="app-shell" data-app={app}>
      <StatusBar />
      {children}
    </div>
  );
}

export function EmptyState({ title, body, action }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Pill({ active, children, onClick }) {
  return (
    <button className={`pill ${active ? "active" : ""}`} type="button" onClick={onClick}>
      {children}
    </button>
  );
}
