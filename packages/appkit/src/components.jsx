import React from "react";
import { KeyRound, Loader2, LogOut } from "lucide-react";

export function StatusBar() {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return (
    <div className="status-bar">
      <span>{time}</span>
      <span className="status-dots">TinyCloud</span>
    </div>
  );
}

export function SignInScreen({ appName, appId, children, onSignIn, signingIn, error, notice }) {
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
      <button className="primary-btn" onClick={onSignIn} disabled={signingIn}>
        {signingIn ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
        {signingIn ? "Signing in…" : "Sign in with OpenKey"}
      </button>
    </main>
  );
}

// Draft copy, the copy owner words it.
export function SignOutButton({ onSignOut, signingOut }) {
  return (
    <button className="ghost-btn" type="button" onClick={onSignOut} disabled={signingOut}>
      {signingOut ? <Loader2 size={14} className="spin" /> : <LogOut size={14} />}
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
}

// Draft copy, the copy owner words it.
export const SESSION_ENDED_MESSAGE = "Your sign-in ended. Sign in again to save this entry.";

/**
 * Shown over an entry screen when the session ended under it (`auth.expired`), or when the one retry after
 * signing in again failed (`auth.error`). The entry stays as it is; the button signs in again in place and
 * runs the kept action once. `children` replaces the message where nothing is being saved.
 */
export function SessionEndedPrompt({ auth, children = SESSION_ENDED_MESSAGE }) {
  if (!auth.expired && !auth.error) return null;
  return (
    <div className="card stack" role="alert" style={{ margin: "0 22px 12px" }}>
      {auth.expired && <div>{children}</div>}
      {auth.error && <div className="error">{auth.error}</div>}
      {auth.expired && (
        <button className="primary-btn" type="button" onClick={auth.resume} disabled={auth.signingIn}>
          {auth.signingIn ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
          {auth.signingIn ? "Signing in…" : "Sign in again"}
        </button>
      )}
    </div>
  );
}

// Draft copy, the copy owner words it.
export function RestoringScreen() {
  return (
    <main className="signin-screen">
      <div className="signin-copy">
        <div className="eyebrow">Tinyapps</div>
        <p>
          <Loader2 size={16} className="spin" /> Restoring your sign-in…
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
