import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Camera, Home, History, Settings, Trash2 } from "lucide-react";

import {
  APP_IDS,
  AppShell,
  EmptyState,
  FOOD_MANIFEST,
  Pill,
  SignInScreen,
  deleteRecord,
  fileToDataUrl,
  fmtDay,
  fmtTime,
  getAnthropicApiKey,
  listRecords,
  makeId,
  normalizeMealDraft,
  putPhoto,
  putRecord,
  recordsPrefix,
  setAnthropicApiKey,
  todayLabel,
  useTinyCloudApp,
} from "@tinyapps/appkit";
import "@tinyapps/appkit/styles.css";

const MEALS_PREFIX = recordsPrefix(APP_IDS.food, "meal");

function FoodApp() {
  const auth = useTinyCloudApp(FOOD_MANIFEST);
  const [meals, setMeals] = useState([]);
  const [view, setView] = useState("home");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    if (!auth.tcw || !auth.session) return;
    setLoading(true);
    setError("");
    try {
      setMeals(await listRecords(auth.tcw, MEALS_PREFIX));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [auth.tcw, auth.session]);

  if (!auth.session) {
    return (
      <AppShell app="food">
        <SignInScreen
          appName="Food Tracker"
          appId={FOOD_MANIFEST.id}
          onSignIn={auth.signIn}
          signingIn={auth.signingIn}
          error={auth.error}
        >
          What did you <em>eat</em>, and when.
        </SignInScreen>
      </AppShell>
    );
  }

  return (
    <AppShell app="food">
      <header className="topbar">
        <div>
          <h1>Food <em>Tracker</em></h1>
          <div className="date-line">{todayLabel()}</div>
        </div>
        <button className="icon-btn" onClick={() => setView("settings")} aria-label="Settings"><Settings size={17} /></button>
      </header>

      {error && <div className="error" style={{ margin: "0 22px 12px" }}>{error}</div>}
      {view === "home" && <FoodHome meals={meals} loading={loading} />}
      {view === "capture" && <CaptureMeal tcw={auth.tcw} onSaved={() => { setView("home"); refresh(); }} />}
      {view === "history" && <FoodHistory meals={meals} tcw={auth.tcw} onChanged={refresh} />}
      {view === "settings" && <FoodSettings tcw={auth.tcw} />}

      {(view === "home" || view === "history") && (
        <>
          <button className="fab" onClick={() => setView("capture")} aria-label="Log meal"><Camera size={24} /></button>
          <nav className="bottom-nav">
            <button className={view === "home" ? "active" : ""} onClick={() => setView("home")}><Home size={16} />Today</button>
            <button className={view === "history" ? "active" : ""} onClick={() => setView("history")}><History size={16} />History</button>
          </nav>
        </>
      )}
    </AppShell>
  );
}

function FoodHome({ meals, loading }) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const today = meals.filter((meal) => meal.ts >= start.getTime());
  return (
    <main className="scroll-body">
      <div className="card row">
        <div>
          <div className="eyebrow">Today</div>
          <div style={{ fontSize: 42, fontFamily: "var(--display)" }}>{today.length}<span style={{ fontSize: 21, color: "var(--ink-mute)" }}> meals</span></div>
        </div>
        <div style={{ textAlign: "right", color: "var(--ink-mute)" }}>{loading ? "Loading" : "Apps space"}</div>
      </div>
      <div className="section-label">Recent</div>
      {meals.length === 0 ? (
        <EmptyState title="No meals yet." body="Take a photo or enter a meal manually. The record will be written to your TinyCloud applications space." />
      ) : (
        <MealList meals={meals.slice(0, 5)} />
      )}
    </main>
  );
}

function FoodHistory({ meals, tcw, onChanged }) {
  const remove = async (id) => {
    await deleteRecord(tcw, MEALS_PREFIX, id);
    await onChanged();
  };
  return (
    <main className="scroll-body">
      <div className="section-label">All Meals</div>
      {meals.length === 0 ? <EmptyState title="No history." body="Meal records appear here after they are saved." /> : (
        <div className="stack">
          {meals.map((meal, index) => <MealCard key={recordKey(meal, index)} meal={meal} onDelete={() => remove(meal.id)} />)}
        </div>
      )}
    </main>
  );
}

function MealList({ meals }) {
  return <div className="stack">{meals.map((meal, index) => <MealCard key={recordKey(meal, index)} meal={meal} />)}</div>;
}

function MealCard({ meal, onDelete }) {
  return (
    <article className="card row">
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: "var(--display)", fontSize: 21 }}>{meal.emoji || "🍽"} {meal.title}</div>
        <div style={{ color: "var(--ink-mute)", fontSize: 13 }}>{fmtDay(meal.ts)} at {fmtTime(meal.ts)} · {(meal.ingredients || []).length} ingredients</div>
        <div className="wrap" style={{ marginTop: 8 }}>{(meal.ingredients || []).slice(0, 5).map((item, index) => <span className="pill" key={`${item}-${index}`}>{item}</span>)}</div>
      </div>
      {onDelete && <button className="icon-btn" onClick={onDelete} aria-label="Delete meal"><Trash2 size={16} /></button>}
    </article>
  );
}

function recordKey(record, index) {
  return record.id || `${record.ts || "record"}-${index}`;
}

function CaptureMeal({ tcw, onSaved }) {
  const [photo, setPhoto] = useState("");
  const [draft, setDraft] = useState({ title: "", emoji: "🍽", ingredients: [], portion: "medium", tags: [], notes: "" });
  const [ingredient, setIngredient] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const titleRef = useRef(null);
  const ingredientRef = useRef(null);

  const analyze = async () => {
    setBusy(true);
    setError("");
    try {
      const apiKey = await getAnthropicApiKey(tcw);
      const response = await fetch("/api/analyze-food", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: photo, apiKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Food analysis failed");
      setDraft(normalizeMealDraft(payload.meal));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const id = makeId("meal");
      const createdAt = new Date().toISOString();
      const title = titleRef.current?.value ?? draft.title;
      const pendingIngredient = ingredientRef.current?.value ?? ingredient;
      const normalized = normalizeMealDraft({
        ...draft,
        title,
        ingredients: mergeIngredients(draft.ingredients, parseIngredients(pendingIngredient)),
      });
      const photoPath = photo ? await putPhoto(tcw, APP_IDS.food, id, { id, dataUrl: photo, createdAt }) : "";
      await putRecord(tcw, MEALS_PREFIX, { ...normalized, id, ts: Date.now(), createdAt, photoPath, source: photo ? "photo" : "manual" });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addIngredient = () => {
    const values = parseIngredients(ingredient);
    if (values.length === 0) return;
    setDraft((current) => ({ ...current, ingredients: mergeIngredients(current.ingredients, values) }));
    setIngredient("");
  };

  return (
    <main className="scroll-body">
      <div className="section-label">New meal</div>
      <div className="stack">
        <input className="input" type="file" accept="image/*" onChange={async (event) => {
          const file = event.target.files?.[0];
          if (file) setPhoto(await fileToDataUrl(file));
        }} />
        {photo && <img src={photo} alt="Selected meal" className="card" style={{ width: "100%", padding: 0, maxHeight: 260, objectFit: "cover" }} />}
        <button className="ghost-btn" onClick={analyze} disabled={!photo || busy}>Interpret photo with Sonnet</button>
        {error && <div className="error">{error}</div>}
        <input ref={titleRef} className="input" placeholder="Meal title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <div className="wrap">
          {["breakfast", "lunch", "dinner", "snack"].map((tag) => (
            <Pill key={tag} active={draft.tags.includes(tag)} onClick={() => setDraft((current) => ({
              ...current,
              tags: current.tags.includes(tag) ? current.tags.filter((item) => item !== tag) : [...current.tags, tag],
            }))}>{tag}</Pill>
          ))}
        </div>
        <div className="row">
          <input ref={ingredientRef} className="input" placeholder="Add ingredient" value={ingredient} onChange={(e) => setIngredient(e.target.value)} />
          <button className="ghost-btn" onClick={addIngredient}>Add</button>
        </div>
        <div className="wrap">{draft.ingredients.map((item, index) => <span className="pill active" key={`${item}-${index}`}>{item}</span>)}</div>
        <div className="wrap">{["small", "medium", "large"].map((portion) => <Pill key={portion} active={draft.portion === portion} onClick={() => setDraft({ ...draft, portion })}>{portion}</Pill>)}</div>
        <textarea rows={3} placeholder="Notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
        <button className="primary-btn" onClick={save} disabled={busy || !draft.title.trim()}>Save meal</button>
      </div>
    </main>
  );
}

function parseIngredients(value) {
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function mergeIngredients(current, additions) {
  return [...new Set([...(current || []), ...additions])];
}

function FoodSettings({ tcw }) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    getAnthropicApiKey(tcw).then(setValue).catch(() => setValue(""));
  }, [tcw]);
  return (
    <main className="scroll-body">
      <div className="section-label">Settings</div>
      <div className="card stack">
        <div>
          <strong>Anthropic API key</strong>
          <p style={{ color: "var(--ink-mute)", marginBottom: 0 }}>Stored in your TinyCloud `secrets` space at `secrets/anthropic-api-key`.</p>
        </div>
        <input className="input" type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="sk-ant-..." />
        <button className="primary-btn" onClick={async () => { await setAnthropicApiKey(tcw, value); setStatus("Saved"); }}>Save key</button>
        {status && <div className="notice">{status}</div>}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<FoodApp />);
