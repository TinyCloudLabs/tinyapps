import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { History, Home, Plus, Trash2 } from "lucide-react";

import {
  APP_IDS,
  AppShell,
  EmptyState,
  PAIN_MANIFEST,
  Pill,
  SignInScreen,
  deleteRecord,
  fmtDay,
  fmtTime,
  listRecords,
  makeId,
  putRecord,
  recordsPrefix,
  todayLabel,
  useTinyCloudApp,
} from "@tinyapps/appkit";
import "@tinyapps/appkit/styles.css";

const EVENTS_PREFIX = recordsPrefix(APP_IDS.pain, "pain");
const QUALITIES = ["sharp", "dull", "cramping", "burning", "pressure", "throbbing", "tingling"];
const LOCATIONS = ["head", "chest", "abdomen-upper", "abdomen-lower", "back-upper", "back-mid", "back-lower", "left-leg", "right-leg"];

function PainApp() {
  const auth = useTinyCloudApp(PAIN_MANIFEST);
  const [events, setEvents] = useState([]);
  const [view, setView] = useState("home");
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!auth.tcw || !auth.session) return;
    setError("");
    try {
      setEvents(await listRecords(auth.tcw, EVENTS_PREFIX));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    refresh();
  }, [auth.tcw, auth.session]);

  if (!auth.session) {
    return (
      <AppShell app="pain">
        <SignInScreen
          appName="Pain Tracker"
          appId={PAIN_MANIFEST.app_id}
          onSignIn={auth.signIn}
          signingIn={auth.signingIn}
          error={auth.error}
        >
          Where it <em>hurts</em>, when, how much.
        </SignInScreen>
      </AppShell>
    );
  }

  return (
    <AppShell app="pain">
      <header className="topbar">
        <div>
          <h1>Pain <em>Tracker</em></h1>
          <div className="date-line">{todayLabel()}</div>
        </div>
      </header>
      {error && <div className="error" style={{ margin: "0 22px 12px" }}>{error}</div>}
      {view === "home" && <PainHome events={events} setView={setView} />}
      {view === "log" && <PainLog tcw={auth.tcw} onSaved={() => { setView("home"); refresh(); }} />}
      {view === "history" && <PainHistory events={events} tcw={auth.tcw} onChanged={refresh} />}
      {(view === "home" || view === "history") && (
        <>
          <button className="fab" onClick={() => setView("log")} aria-label="Log pain"><Plus size={24} /></button>
          <nav className="bottom-nav">
            <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}><Home size={16} />Today</button>
            <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={16} />History</button>
          </nav>
        </>
      )}
    </AppShell>
  );
}

function PainHome({ events, setView }) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = events.filter((event) => event.ts >= start.getTime());
  const last7 = events.filter((event) => event.ts > Date.now() - 7 * 24 * 60 * 60 * 1000);
  const avg = last7.length ? (last7.reduce((sum, event) => sum + event.severity, 0) / last7.length).toFixed(1) : "—";
  return (
    <main className="scroll-body">
      <button className="card" style={{ width: "100%", textAlign: "left", border: "none", background: "linear-gradient(135deg, var(--accent-soft), var(--accent))" }} onClick={() => setView("log")}>
        <div className="eyebrow" style={{ color: "var(--accent-deep)" }}>Feeling something?</div>
        <div style={{ fontFamily: "var(--display)", fontSize: 30, color: "var(--accent-deep)" }}>Tap to log it now.</div>
      </button>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="card" style={{ flex: 1 }}><div className="eyebrow">Today</div><div style={{ fontSize: 34, fontFamily: "var(--display)" }}>{today.length}</div></div>
        <div className="card" style={{ flex: 1 }}><div className="eyebrow">7-day avg</div><div style={{ fontSize: 34, fontFamily: "var(--display)" }}>{avg}</div></div>
      </div>
      <div className="section-label">Recent</div>
      {events.length === 0 ? <EmptyState title="No pain events yet." body="Log an event when something happens. Records are written to your TinyCloud applications space." /> : <PainList events={events.slice(0, 4)} />}
    </main>
  );
}

function PainHistory({ events, tcw, onChanged }) {
  const remove = async (id) => {
    await deleteRecord(tcw, EVENTS_PREFIX, id);
    onChanged();
  };
  return (
    <main className="scroll-body">
      <div className="section-label">All Events</div>
      {events.length === 0 ? <EmptyState title="No history." body="Pain records appear here after they are saved." /> : (
        <div className="stack">{events.map((event) => <PainCard key={event.id} event={event} onDelete={() => remove(event.id)} />)}</div>
      )}
    </main>
  );
}

function PainList({ events }) {
  return <div className="stack">{events.map((event) => <PainCard key={event.id} event={event} />)}</div>;
}

function PainCard({ event, onDelete }) {
  return (
    <article className="card row">
      <div className="row" style={{ justifyContent: "flex-start" }}>
        <div style={{ width: 52, height: 52, borderRadius: 12, background: severityColor(event.severity), display: "grid", placeItems: "center", fontFamily: "var(--display)", fontSize: 24 }}>{event.severity}</div>
        <div>
          <div style={{ fontFamily: "var(--display)", fontSize: 20 }}>{event.locations.map(label).join(" · ")}</div>
          <div style={{ color: "var(--ink-mute)", fontSize: 13 }}>{fmtDay(event.ts)} at {fmtTime(event.ts)} · {event.quality.join(", ")}</div>
        </div>
      </div>
      {onDelete && <button className="icon-btn" onClick={onDelete} aria-label="Delete event"><Trash2 size={16} /></button>}
    </article>
  );
}

function PainLog({ tcw, onSaved }) {
  const [severity, setSeverity] = useState(5);
  const [locations, setLocations] = useState([]);
  const [quality, setQuality] = useState([]);
  const [duration, setDuration] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");

  const toggle = (value, values, setter) => setter(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const save = async () => {
    setError("");
    try {
      await putRecord(tcw, EVENTS_PREFIX, {
        id: makeId("pain"),
        ts: Date.now(),
        severity,
        locations,
        quality,
        duration,
        notes,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <main className="scroll-body">
      <div className="section-label">New entry</div>
      <div className="stack">
        <div className="card">
          <div className="row">
            <div className="eyebrow">How bad?</div>
            <div style={{ fontFamily: "var(--display)", fontSize: 52, color: severityColor(severity) }}>{severity}<span style={{ fontSize: 22, color: "var(--ink-mute)" }}> / 10</span></div>
          </div>
          <input type="range" min="1" max="10" value={severity} onChange={(e) => setSeverity(Number(e.target.value))} style={{ width: "100%" }} />
        </div>
        <div>
          <div className="section-label">Where?</div>
          <div className="wrap">{LOCATIONS.map((item) => <Pill key={item} active={locations.includes(item)} onClick={() => toggle(item, locations, setLocations)}>{label(item)}</Pill>)}</div>
        </div>
        <div>
          <div className="section-label">Feels like</div>
          <div className="wrap">{QUALITIES.map((item) => <Pill key={item} active={quality.includes(item)} onClick={() => toggle(item, quality, setQuality)}>{item}</Pill>)}</div>
        </div>
        <div>
          <div className="section-label">Duration</div>
          <div className="wrap">{["just started", "~10 min", "~30 min", "~1 hour", "still ongoing"].map((item) => <Pill key={item} active={duration === item} onClick={() => setDuration(item)}>{item}</Pill>)}</div>
        </div>
        <textarea rows={3} placeholder="Anything to remember? Trigger? Time after eating?" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button className="primary-btn" onClick={save} disabled={locations.length === 0}>Save entry</button>
      </div>
    </main>
  );
}

function label(value) {
  return value.replaceAll("-", " ");
}

function severityColor(value) {
  if (value <= 2) return "#d4e8c8";
  if (value <= 4) return "#e8dba0";
  if (value <= 6) return "#e8c178";
  if (value <= 8) return "#d68850";
  return "#b85539";
}

createRoot(document.getElementById("root")).render(<PainApp />);
