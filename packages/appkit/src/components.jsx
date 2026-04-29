import React from "react";
import { KeyRound, Loader2 } from "lucide-react";

export function StatusBar() {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  return (
    <div className="status-bar">
      <span>{time}</span>
      <span className="status-dots">TinyCloud</span>
    </div>
  );
}

export function SignInScreen({ appName, appId, children, onSignIn, signingIn, error }) {
  return (
    <main className="signin-screen">
      <div className="signin-copy">
        <div className="eyebrow">Tinyapps</div>
        <h1>{children}</h1>
        <p>Data is written to your TinyCloud applications space under this app's manifest.</p>
        <code>{appId}</code>
      </div>
      {error && <div className="error">{error}</div>}
      <button className="primary-btn" onClick={onSignIn} disabled={signingIn}>
        {signingIn ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
        {signingIn ? "Signing in" : "Sign in with OpenKey"}
      </button>
    </main>
  );
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
