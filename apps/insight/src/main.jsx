import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RefreshCw, Sparkles } from "lucide-react";

import {
  AppShell,
  EmptyState,
  INSIGHT_MANIFEST,
  RenewalNote,
  RestoringScreen,
  SessionEndedPrompt,
  SignOutButton,
  SignInScreen,
  analyzeCorrelations,
  fmtDay,
  fmtTime,
  useTinyCloudApp,
} from "@tinyapps/appkit";
import "@tinyapps/appkit/styles.css";

import { loadInsightData } from "./actions.js";

// Draft copy, the copy owner words it.
const SESSION_ENDED_READ_MESSAGE = "Your sign-in ended. Sign in again to load your data.";

function InsightApp() {
  const auth = useTinyCloudApp(INSIGHT_MANIFEST);
  const [manifests, setManifests] = useState([]);
  const [meals, setMeals] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    if (!auth.tcw || !auth.session) return;
    setLoading(true);
    setError("");
    try {
      // If the session ended, the prompt signs in again and reads once more.
      await auth.runWithSession(async (tcw) => {
        const next = await loadInsightData(tcw);
        setManifests(next.manifests);
        setMeals(next.meals);
        setEvents(next.events);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [auth.tcw, auth.session]);

  if (!auth.ready) {
    return (
      <AppShell app="insight">
        <RestoringScreen />
      </AppShell>
    );
  }

  if (!auth.session) {
    return (
      <AppShell app="insight">
        <SignInScreen
          appName="Insight"
          appId={INSIGHT_MANIFEST.app_id}
          onSignIn={auth.signIn}
          signingIn={auth.signingIn}
          error={auth.error}
          notice={auth.signOutNotice}
        >
          Food <em>×</em> Pain.
        </SignInScreen>
      </AppShell>
    );
  }

  const { correlations, suspiciousIngredients } = analyzeCorrelations(meals, events);

  return (
    <AppShell app="insight">
      <header className="topbar">
        <div>
          <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 6 }}><Sparkles size={13} /> Agent-style reader</div>
          <h1>Food <em>×</em> Pain</h1>
          <div className="date-line">{meals.length} meals · {events.length} events</div>
          <RenewalNote renewsUntil={auth.renewsUntil} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="icon-btn" onClick={refresh} aria-label="Refresh"><RefreshCw size={17} className={loading ? "spin" : ""} /></button>
          <SignOutButton onSignOut={auth.signOut} signingOut={auth.signingOut} />
        </div>
      </header>
      {error && <div className="error" style={{ margin: "0 22px 12px" }}>{error}</div>}
      <SessionEndedPrompt auth={auth}>{SESSION_ENDED_READ_MESSAGE}</SessionEndedPrompt>
      <main className="scroll-body">
        <div className="section-label">Reading</div>
        <div className="card">
          <div style={{ fontFamily: "var(--display)", fontSize: 24, lineHeight: 1.18 }}>
            {suspiciousIngredients.length > 0 ? (
              <>Pain shows up most often after meals with <em style={{ color: "var(--accent)" }}>{suspiciousIngredients.slice(0, 3).map((item) => item.name).join(", ")}</em>.</>
            ) : (
              <>Not enough overlapping data yet.</>
            )}
          </div>
          <p style={{ color: "var(--ink-mute)", marginBottom: 0 }}>Looking at meals followed within 4 hours by pain severity 5 or higher. This is a pattern, not a diagnosis.</p>
        </div>

        <div className="section-label">Discovered manifests</div>
        {manifests.length === 0 ? (
          <EmptyState title="No manifests found." body="Use Food Tracker and Pain Tracker first. Each app publishes its manifest into the TinyCloud applications space." />
        ) : (
          <div className="stack">
            {manifests.map((manifest) => (
              <article className="card" key={manifest.app_id}>
                <div className="row">
                  <strong>{manifest.name}</strong>
                  <code style={{ color: "var(--ink-mute)", fontSize: 11 }}>{manifest["x-tinyapp"]?.registry?.space}</code>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-mute)", overflowWrap: "anywhere" }}>{manifest.app_id}/manifest.json</div>
              </article>
            ))}
          </div>
        )}

        <div className="section-label">Common after high-pain meals</div>
        {suspiciousIngredients.length === 0 ? (
          <EmptyState title="No ingredient pattern yet." body="More food and pain records are needed before this app can rank ingredients." />
        ) : (
          <div className="stack">
            {suspiciousIngredients.map((item) => (
              <div className="card row" key={item.name}>
                <span>{item.name}</span>
                <span className="pill active">{item.weighted}</span>
              </div>
            ))}
          </div>
        )}

        <div className="section-label">Recent links</div>
        {correlations.filter((item) => item.peak > 0).length === 0 ? (
          <EmptyState title="No linked events." body="The app found no pain events within four hours after a logged meal." />
        ) : (
          <div className="stack">
            {correlations.filter((item) => item.peak > 0).slice(0, 6).map(({ meal, peak, followedBy }) => (
              <article className="card" key={meal.id}>
                <div style={{ fontFamily: "var(--display)", fontSize: 19 }}>{meal.emoji || "🍽"} {meal.title}</div>
                <div style={{ color: "var(--ink-mute)", fontSize: 13 }}>{fmtDay(meal.ts)} at {fmtTime(meal.ts)} · peak pain {peak}/10 · {followedBy.length} event(s)</div>
              </article>
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}

createRoot(document.getElementById("root")).render(<InsightApp />);
