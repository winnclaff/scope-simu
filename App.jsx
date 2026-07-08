import React, { useRef, useEffect, useState, useSyncExternalStore } from "react";
import { createClient } from "@supabase/supabase-js";

/* ============================================================================
 * CONFIG SUPABASE
 * La clé anon est publique par design (protégée par les Row Level Security).
 * Renseigne ces deux valeurs → l'appli se connecte avec le seul code de session.
 * ==========================================================================*/
const SUPABASE_URL = "https://uxtohamzbdcdvtwtdhnx.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV4dG9oYW16YmRjZHZ0d3RkaG54Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwMTUzOTIsImV4cCI6MjA5ODU5MTM5Mn0.nnVyLNNPt2qiMp-DXFQCLTKl7f3o7GtE_XPLo_BBsOc";
const SUPABASE_READY = SUPABASE_URL && SUPABASE_ANON;

/* ============================================================================
 * STORE DE SESSION — sync/store.js
 * Deux modes transparents pour le reste de l'app :
 *   - local    : état en mémoire (démo, aperçu artifact).
 *   - supabase : état synchronisé via Realtime (vraie sync 2 tablettes).
 * Interface identique : getState / setState / subscribe.
 * ==========================================================================*/

// Clés qui restent PROPRES à chaque appareil (jamais synchronisées) :
// - soundOn : chaque tablette active son propre audio (contrainte Safari).
// - connected/connError : état de connexion local.
const LOCAL_KEYS = ["soundOn", "connected", "connError"];

const DEFAULTS = {
  rhythmKey: "sinus",
  fc: 80,
  spo2: 98,
  artOn: false,        // courbe PA invasive (KTa)
  showEcg: false,      // courbe ECG
  showPleth: false,    // courbe pléth SpO2
  co2On: false,        // EtCO2 (courbe + valeur)
  paSys: 120, paDia: 70,
  etco2: 38,
  rr: 14,
  nibpSys: 120, nibpDia: 72,
  nibpRequestedAt: null,
  noiseOn: true,
  soundOn: false,
  silencedUntil: null,
  clockOn: false,          // horloge (heure réelle) visible sur le scope
  chronoOn: false,         // chrono rendu disponible par la régie
  chronoRunning: false,
  chronoStartedAt: null,
  chronoBase: 0,           // temps accumulé (ms) hors périodes de marche
  limits: { hrLow: 50, hrHigh: 120, spo2Low: 92, sysLow: 90, sysHigh: 160, mapLow: 65, etco2Low: 30, etco2High: 45 },
  connected: false,
  connError: null,
};

function createSessionStore() {
  let state = { ...DEFAULTS };
  const listeners = new Set();
  let sb = null, channel = null, code = null, mode = "local", pushTimer = null;

  const notify = () => listeners.forEach((l) => l());

  // Applique un état distant en préservant les clés locales à l'appareil.
  function applyRemote(remote) {
    if (!remote) return;
    const keep = {};
    for (const k of LOCAL_KEYS) keep[k] = state[k];
    state = { ...state, ...remote, ...keep };
    notify();
  }

  async function pull() {
    if (!sb) return;
    try {
      const { data } = await sb.from("sessions").select("state").eq("code", code).maybeSingle();
      if (data?.state) applyRemote(data.state);
    } catch (e) { /* session pas encore créée : on garde l'état par défaut */ }
  }

  async function push() {
    if (mode !== "supabase" || !sb) return;
    const sync = { ...state };
    for (const k of LOCAL_KEYS) delete sync[k];
    try {
      await sb.from("sessions").upsert({ code, state: sync, updated_at: new Date().toISOString() });
    } catch (e) { /* réseau : le prochain push resynchronisera */ }
  }

  async function connect(url, key, sessionCode, role) {
    code = sessionCode;
    sb = createClient(url, key, { realtime: { params: { eventsPerSecond: 20 } } });
    mode = "supabase";

    if (role === "pilote") {
      await push(); // la régie initialise / écrase l'état de la session
    } else {
      await pull(); // le scope lit l'état courant
    }

    channel = sb
      .channel(`session:${code}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "sessions", filter: `code=eq.${code}` },
        (payload) => applyRemote(payload.new?.state))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") { state = { ...state, connected: true, connError: null }; notify(); pull(); }
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          state = { ...state, connected: false }; notify();
        }
      });
  }

  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      notify();
      const keys = Object.keys(patch);
      if (mode === "supabase" && keys.some((k) => !LOCAL_KEYS.includes(k))) {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(push, 60); // léger debounce anti-rafale
      }
    },
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    connect,
    getMode: () => mode,
  };
}
const store = createSessionStore();
function useSession() { return [useSyncExternalStore(store.subscribe, store.getState), store.setState]; }

const NIBP_DURATION = 8000; // durée mesure PNI (ms)

/* ============================================================================
 * MOTEUR ECG / courbes — engine/ (futur)
 * ==========================================================================*/

const g = (t, mu, sig) => Math.exp(-((t - mu) ** 2) / (2 * sig * sig));

const SINUS = [
  { mu: 0.160, sig: 0.022, a: 0.13 }, { mu: 0.250, sig: 0.008, a: -0.10 },
  { mu: 0.265, sig: 0.007, a: 1.15 }, { mu: 0.285, sig: 0.011, a: -0.30 },
  { mu: 0.420, sig: 0.038, a: 0.32 },
];
const COMPLEX_BASE = 0.5;

function ecgSinus(phase, hr) {
  const cycle = 60 / hr;
  const k = cycle < COMPLEX_BASE ? cycle / COMPLEX_BASE : 1;
  let v = 0;
  for (const w of SINUS) v += w.a * g(phase, w.mu * k, w.sig * k);
  return v + (Math.random() - 0.5) * 0.012;
}
function ecgTV(phase, hr) {
  const t = phase / (60 / hr);
  return 0.85 * Math.sin(2 * Math.PI * t) * Math.exp(-2.2 * t) + 0.45 * Math.sin(2 * Math.PI * t) + (Math.random() - 0.5) * 0.02;
}
function ecgFV(phase, hr, tSec) {
  const v = 0.42 * Math.sin(2 * Math.PI * 5.5 * tSec) + 0.28 * Math.sin(2 * Math.PI * 8.3 * tSec + 1.3) + 0.24 * Math.sin(2 * Math.PI * 3.1 * tSec + 0.7);
  return v * (0.7 + 0.3 * Math.sin(tSec * 1.7)) + (Math.random() - 0.5) * 0.07;
}
function ecgAsystole(phase, hr, tSec) { return 0.02 * Math.sin(tSec * 0.6) + (Math.random() - 0.5) * 0.015; }

// Complexe QRS-T sans onde P (pour FA, flutter, BAV).
const QRST = [
  { mu: 0.090, sig: 0.008, a: -0.10 }, // Q
  { mu: 0.105, sig: 0.007, a: 1.10 },  // R
  { mu: 0.125, sig: 0.011, a: -0.28 }, // S
  { mu: 0.260, sig: 0.038, a: 0.30 },  // T
];
const qrst = (phase) => { let v = 0; for (const w of QRST) v += w.a * g(phase, w.mu, w.sig); return v; };

// FA : pas d'onde P, ligne de base ondulante (ondes f), RR irrégulier
// (l'irrégularité est produite par le cycle variable, cf. flag `irregular`).
function ecgFA(phase, hr, tSec) {
  return qrst(phase) + 0.06 * Math.sin(2 * Math.PI * 6 * tSec) + (Math.random() - 0.5) * 0.01;
}
// Flutter : ondes F en dents de scie ~300/min + QRS (conduction 2:1 par défaut).
function ecgFlutter(phase, hr, tSec) {
  const saw = ((tSec * 5) % 1) - 0.5; // 5 Hz = 300/min
  return qrst(phase) + 0.24 * saw + (Math.random() - 0.5) * 0.01;
}
// BAV complet (3e degré) : dissociation totale. Oreillettes (P) régulières et
// indépendantes ~78/min ; ventricules en échappement LARGE ~40/min. Le PR varie
// en permanence (les P défilent à travers le tracé), certaines P noyées dans le QRS.
function ecgBAV3(phase, hr, tSec) {
  const pT = 60 / 78;   // P indépendantes
  const qT = 60 / 40;   // QRS d'échappement (= FC affichée)
  const pu = tSec % pT;
  const qu = tSec % qT;
  const P = 0.14 * g(pu, 0.10, 0.024);
  // QRS large (échappement ventriculaire) + onde T ample opposée.
  const QRS = 1.05 * g(qu, 0.10, 0.032) - 0.42 * g(qu, 0.175, 0.030);
  const T = 0.34 * g(qu, 0.44, 0.075);
  return P + QRS + T + (Math.random() - 0.5) * 0.01;
}

// perfusing = génère un pouls ; defFc = FC par défaut à la sélection.
const RHYTHMS = {
  sinus:    { fn: ecgSinus, defFc: 80,  label: "Sinusal", perfusing: true, fixedHr: null },
  tachy:    { fn: ecgSinus, defFc: 140, label: "Tachycardie", perfusing: true, fixedHr: null },
  brady:    { fn: ecgSinus, defFc: 42,  label: "Bradycardie", perfusing: true, fixedHr: null },
  fa:       { fn: ecgFA,    defFc: 110, label: "Fibrillation atriale", perfusing: true, fixedHr: null, irregular: true },
  flutter:  { fn: ecgFlutter, defFc: 150, label: "Flutter atrial", perfusing: true, fixedHr: null },
  bav3:     { fn: ecgBAV3,  defFc: 40,  label: "BAV 3e degré", perfusing: true, fixedHr: 40 },
  tv_pouls: { fn: ecgTV,    defFc: 180, label: "TV (pouls +)", perfusing: true, fixedHr: null },
  tv_sans:  { fn: ecgTV,    defFc: 200, label: "TV (pouls −)", perfusing: false, fixedHr: null },
  fv:       { fn: ecgFV,    defFc: 300, label: "FV", perfusing: false, fixedHr: 300 },
  asystole: { fn: ecgAsystole, defFc: 0, label: "Asystolie", perfusing: false, fixedHr: 0 },
};
const hrOf = (R, fc) => (R.fixedHr !== null ? R.fixedHr : fc);

/* ============================================================================
 * PRESETS DE SCÉNARIOS
 * Champs pilotables capturés dans un preset. Scénarios cliniques prédéfinis +
 * presets perso stockés en localStorage (propre à la tablette régie).
 * ==========================================================================*/
const SNAP_KEYS = ["rhythmKey", "fc", "spo2", "artOn", "showEcg", "showPleth", "co2On", "paSys", "paDia", "etco2", "rr", "nibpSys", "nibpDia", "limits"];
const snapshot = (s) => { const o = {}; for (const k of SNAP_KEYS) o[k] = s[k]; return o; };

const BUILTIN_PRESETS = [
  { name: "Patient stable", state: { rhythmKey: "sinus", fc: 75, spo2: 98, showEcg: true, showPleth: true, co2On: false, artOn: false, paSys: 120, paDia: 70, etco2: 38, rr: 14, nibpSys: 120, nibpDia: 72 } },
  { name: "Choc septique", state: { rhythmKey: "tachy", fc: 125, spo2: 92, showEcg: true, showPleth: true, co2On: false, artOn: true, paSys: 82, paDia: 44, etco2: 30, rr: 26, nibpSys: 84, nibpDia: 46 } },
  { name: "Détresse respiratoire", state: { rhythmKey: "tachy", fc: 118, spo2: 84, showEcg: true, showPleth: true, co2On: true, artOn: false, paSys: 138, paDia: 82, etco2: 52, rr: 32, nibpSys: 140, nibpDia: 84 } },
  { name: "OAP", state: { rhythmKey: "tachy", fc: 120, spo2: 88, showEcg: true, showPleth: true, co2On: false, artOn: false, paSys: 182, paDia: 104, etco2: 34, rr: 28, nibpSys: 184, nibpDia: 106 } },
  { name: "Bradycardie / BAV", state: { rhythmKey: "bav3", fc: 40, spo2: 95, showEcg: true, showPleth: true, co2On: false, artOn: false, paSys: 98, paDia: 58, etco2: 36, rr: 16, nibpSys: 100, nibpDia: 60 } },
  { name: "ACR — FV", state: { rhythmKey: "fv", fc: 300, spo2: 98, showEcg: true, showPleth: true, co2On: true, artOn: false, paSys: 120, paDia: 70, etco2: 12, rr: 10, nibpSys: 120, nibpDia: 72 } },
  { name: "ACR — Asystolie", state: { rhythmKey: "asystole", fc: 0, spo2: 98, showEcg: true, showPleth: true, co2On: true, artOn: false, paSys: 120, paDia: 70, etco2: 8, rr: 8, nibpSys: 120, nibpDia: 72 } },
];

const PRESET_KEY = "scope_presets";
const loadPresets = () => { try { return JSON.parse(localStorage.getItem(PRESET_KEY)) || []; } catch { return []; } };
const savePresets = (arr) => { try { localStorage.setItem(PRESET_KEY, JSON.stringify(arr)); } catch {} };

// Pléthysmographie : montée systolique rapide + onde dicrote nette.
function plethAmplitude(phase, hr) {
  const cycle = 60 / hr;
  const t = ((phase + cycle * 0.22) % cycle) / cycle; // retard de transit après QRS
  // Pic systolique asymétrique (montée plus raide que la descente).
  const rise = t < 0.16 ? g(t, 0.16, 0.052) : g(t, 0.16, 0.085);
  const dicrote = 0.42 * g(t, 0.40, 0.055); // onde dicrote
  return Math.max(0, rise + dicrote);
}
// PA invasive : anacrotie raide, pic systolique, incisure + onde dicrote, run-off diastolique.
function arterialAmplitude(phase, hr, resp) {
  const cycle = 60 / hr;
  const t = ((phase + cycle * 0.2) % cycle) / cycle;
  const dia = 0.18; // niveau diastolique (le tracé ne retombe pas à zéro)
  const sys = t < 0.15 ? g(t, 0.15, 0.05) : g(t, 0.15, 0.075); // pic systolique asymétrique
  const notch = 0.13 * g(t, 0.27, 0.022); // incisure dicrote (creux)
  const dicrote = 0.20 * g(t, 0.34, 0.045); // rebond dicrote
  const v = dia + (1 - dia) * sys - notch + dicrote;
  return Math.max(0, v * (1 + resp * 0.05)); // léger swing respiratoire
}
// Capnogramme réaliste (phases I→III + 0) sur un cycle respiratoire.
function capnoAmplitude(tSec, rr) {
  const cycle = 60 / rr;
  const t = (tSec % cycle) / cycle;
  if (t < 0.08) return 0;                                   // Phase I : ligne de base (espace mort)
  if (t < 0.18) return 0.9 * ((t - 0.08) / 0.10);           // Phase II : montée expiratoire raide → 0.9
  if (t < 0.50) return 0.9 + 0.1 * ((t - 0.18) / 0.32);     // Phase III : plateau alvéolaire montant → 1.0 (EtCO2)
  if (t < 0.57) return Math.max(0, 1 - (t - 0.50) / 0.07);  // Phase 0 : chute inspiratoire raide
  return 0;                                                 // Inspiration : retour à la base
}

// Bruit déterministe (même valeur des deux côtés à partir d'une graine).
function seeded(seed) { const x = Math.sin(seed * 12.9898) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; }

/* ============================================================================
 * AUDIO — Web Audio, sans fichier externe
 * ==========================================================================*/

class MonitorAudio {
  constructor() { this.ctx = null; this.alarmTimer = null; this.alarmPriority = null; }
  enable() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  // Bip QRS : tonalité qui baisse avec la SpO2, comme un vrai moniteur.
  beep(spo2) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
    osc.frequency.value = 660 + (spo2 - 90) * 22; osc.type = "sine";
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.28, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(now); osc.stop(now + 0.1);
  }
  // Une note de moniteur : fondamentale + harmoniques discrètes, enveloppe douce.
  _pulse(t0, freq, dur, vol) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.setValueAtTime(vol, t0 + dur - 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    gain.connect(ctx.destination);
    [[1, 1], [2, 0.35], [3, 0.15]].forEach(([mult, amp]) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq * mult;
      const g2 = ctx.createGain();
      g2.gain.value = amp;
      osc.connect(g2).connect(gain);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    });
  }
  // Motif IEC 60601-1-8 : haute = 2 salves de 5 bips ; moyenne = 3 bips.
  startAlarm(priority) {
    if (!this.ctx || this.alarmPriority === priority) return;
    this.stopAlarm(); this.alarmPriority = priority;
    const high = priority === "high";
    const freq = high ? 988 : 660;      // si (haute) / mi (moyenne)
    const dur = 0.16, vol = high ? 0.3 : 0.22;
    const period = high ? 2500 : 5000;  // répétition de la salve (ms)
    const burst = () => {
      const now = this.ctx.currentTime + 0.02;
      if (high) {
        // salve de 5, pause, salve de 5
        const offs = [0, 0.22, 0.44, 0.66, 0.88, 1.35, 1.57, 1.79, 2.01, 2.23];
        offs.forEach((o) => this._pulse(now + o, freq, dur, vol));
      } else {
        [0, 0.22, 0.44].forEach((o) => this._pulse(now + o, freq, dur, vol));
      }
    };
    burst(); this.alarmTimer = setInterval(burst, period);
  }
  stopAlarm() { if (this.alarmTimer) clearInterval(this.alarmTimer); this.alarmTimer = null; this.alarmPriority = null; }
}
const audio = new MonitorAudio();

/* ============================================================================
 * TRACÉ à balayage
 * ==========================================================================*/

const PX_PER_SEC = 60, ERASE_GAP = 10;

/* Horloge cardiaque PARTAGÉE : toutes les courbes lisent la même phase, le même
 * curseur et le même compteur de battements → pleth/PA calées sur le QRS.
 * CARD est mis à jour par ScopeView à chaque rendu (rythme courant). */
const CARD = { hrFn: () => 80, irregular: false };
const WCLK = { x: 0, phase: 0, beat: 0, tSec: 0, cycle: 0.75, frameTime: 0, last: 0, points: [] };

function cycleForBeat(hr, beat) {
  const base = hr ? 60 / hr : 0.2;
  return CARD.irregular ? base * (1 + 0.4 * seeded(beat)) : base;
}
// Avance l'horloge une seule fois par frame (le 1er canvas avance, les autres relisent).
function advanceWaveClock(now, W) {
  if (WCLK.frameTime === now) return WCLK.points;
  WCLK.frameTime = now;
  if (!WCLK.last) { WCLK.last = now; WCLK.points = []; return WCLK.points; }
  let dt = (now - WCLK.last) / 1000; WCLK.last = now;
  if (dt > 0.05) dt = 0.05;
  WCLK.tSec += dt;
  const step = 1 / PX_PER_SEC;
  const cols = Math.floor(WCLK.x + PX_PER_SEC * dt) - Math.floor(WCLK.x);
  WCLK.x += PX_PER_SEC * dt;
  const pts = [];
  for (let i = 0; i < cols; i++) {
    let cx = Math.floor(WCLK.x) - (cols - 1 - i);
    let wrap = false;
    if (cx >= W) { WCLK.x -= W; cx -= W; wrap = true; }
    WCLK.phase += step;
    if (WCLK.phase >= WCLK.cycle) { WCLK.phase -= WCLK.cycle; WCLK.beat++; WCLK.cycle = cycleForBeat(CARD.hrFn(), WCLK.beat); }
    pts.push({ cx, phase: WCLK.phase, tSec: WCLK.tSec + i * step, beat: WCLK.beat, wrap });
  }
  WCLK.points = pts;
  return pts;
}

function Trace({ color, sample, pxPerUnit, baselineRatio, lineWidth = 1.6 }) {
  const canvasRef = useRef(null);
  const sampleRef = useRef(sample); sampleRef.current = sample;

  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas.getContext("2d");
    let raf, W = 0, H = 0, baseline = 0;
    const r = { prevX: 0, prevY: 0 };
    function resize() {
      const dpr = window.devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
      W = Math.floor(rect.width); H = Math.floor(rect.height);
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      baseline = H * baselineRatio;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
      r.prevX = 0; r.prevY = baseline;
    }
    resize();
    const ro = new ResizeObserver(resize); ro.observe(canvas);
    function frame(now) {
      const pts = advanceWaveClock(now, W);
      ctx.lineWidth = lineWidth; ctx.strokeStyle = color; ctx.lineCap = "round";
      for (const p of pts) {
        if (p.wrap) { r.prevX = p.cx; r.prevY = baseline; }
        const val = sampleRef.current(p.phase, p.tSec, p.beat);
        let y = baseline - val.amp * pxPerUnit;
        y = Math.max(2, Math.min(H - 2, y));
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#000"; ctx.fillRect(p.cx, 0, 1, H); ctx.fillRect(p.cx + 1, 0, ERASE_GAP, H);
        if (p.cx >= r.prevX) { ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.beginPath(); ctx.moveTo(r.prevX, r.prevY); ctx.lineTo(p.cx, y); ctx.stroke(); }
        r.prevX = p.cx; r.prevY = y;
      }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}

/* ============================================================================
 * VUE SCOPE
 * ==========================================================================*/

const COLORS = { ecg: "#00e34a", pleth: "#00d4d4", art: "#ff3b30", co2: "#ffd60a" };

function ScopeView({ compact = false }) {
  const [s, set] = useSession();
  const R = RHYTHMS[s.rhythmKey];
  const perfusing = R.perfusing;
  const hr = hrOf(R, s.fc);

  // Transition crossfade entre rythmes : on mémorise l'ancien rythme et on
  // fond l'ancien tracé vers le nouveau sur TRANS_MS (évite la bascule sèche).
  const TRANS_MS = 700;
  const prevKeyRef = useRef(s.rhythmKey);
  const transRef = useRef({ oldKey: s.rhythmKey, startedAt: 0 });
  useEffect(() => {
    if (prevKeyRef.current !== s.rhythmKey) {
      transRef.current = { oldKey: prevKeyRef.current, startedAt: Date.now() };
      prevKeyRef.current = s.rhythmKey;
    }
  }, [s.rhythmKey]);
  // Fond une amplitude "nouvelle" avec celle qu'aurait produit l'ancien rythme.
  const blend = (newAmp, oldAmpFn) => {
    const el = Date.now() - transRef.current.startedAt;
    if (el >= TRANS_MS || transRef.current.oldKey === s.rhythmKey) return newAmp;
    const k = el / TRANS_MS;
    return oldAmpFn() * (1 - k) + newAmp * k;
  };

  // FC instantanée : consigne + arythmie sinusale respiratoire (déterministe).
  // Le CHIFFRE et le TRACÉ lisent cette même fonction → toujours cohérents.
  const instHr = () => {
    if (R.fixedHr !== null) return R.fixedHr;
    const st = store.getState();
    const resp = Math.sin(Date.now() / 1000 * (2 * Math.PI * st.rr / 60));
    return st.fc + (st.noiseOn ? resp * 1.4 : 0);
  };
  // Alimente l'horloge cardiaque partagée avec le rythme courant.
  CARD.hrFn = instHr;
  CARD.irregular = !!R.irregular;

  // SpO2 réelle : décroît vers 0 (→ ---) en 2-3 s si non perfusant.
  const [spo2Live, setSpo2Live] = useState(98);
  const perfRef = useRef(perfusing); perfRef.current = perfusing;
  const spo2TargetRef = useRef(s.spo2); spo2TargetRef.current = s.spo2;
  useEffect(() => {
    let t;
    const tick = () => {
      setSpo2Live((p) => perfRef.current ? (p < spo2TargetRef.current ? Math.min(spo2TargetRef.current, p + 0.6) : spo2TargetRef.current) : Math.max(0, p - 15));
      t = setTimeout(tick, 60);
    };
    tick(); return () => clearTimeout(t);
  }, []);

  // Valeurs affichées + bruit temporel (respiration).
  const [disp, setDisp] = useState({ fc: s.fc, spo2: 98, paSys: s.paSys, paDia: s.paDia, etco2: s.etco2 });
  useEffect(() => {
    let t;
    const tick = () => {
      const st = store.getState();
      const resp = Math.sin(Date.now() / 1000 * (2 * Math.PI * st.rr / 60)); // phase respi
      const n = st.noiseOn ? 1 : 0;
      setDisp({
        fc: Math.round(instHr()),
        spo2: Math.round(spo2Live + n * (Math.random() - 0.5) * 0.8),
        paSys: Math.round(st.paSys + n * resp * 3),
        paDia: Math.round(st.paDia + n * resp * 2),
        etco2: Math.round(st.etco2 + n * (Math.random() - 0.5)),
      });
      t = setTimeout(tick, 2000);
    };
    tick(); return () => clearTimeout(t);
  }, [spo2Live]);

  const spo2Show = perfusing || spo2Live > 5 ? disp.spo2 : "---";
  const pam = Math.round((disp.paSys + 2 * disp.paDia) / 3);

  // PNI : dérivée de nibpRequestedAt (pas de valeur stockée → Supabase-friendly).
  const [nowTs, setNowTs] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNowTs(Date.now()), 300); return () => clearInterval(i); }, []);
  let nibpDisplay = "—/—", nibpMap = "", nibpMeasuring = false, nibpFail = false;
  if (s.nibpRequestedAt) {
    const el = nowTs - s.nibpRequestedAt;
    if (!perfusing) { nibpFail = true; nibpDisplay = "échec"; nibpMap = "pas de pouls"; }
    else if (el < NIBP_DURATION) { nibpMeasuring = true; nibpDisplay = "…"; nibpMap = "mesure"; }
    else {
      const sys = Math.round(s.nibpSys + (s.noiseOn ? seeded(s.nibpRequestedAt) * 3 : 0));
      const dia = Math.round(s.nibpDia + (s.noiseOn ? seeded(s.nibpRequestedAt + 1) * 2 : 0));
      nibpDisplay = `${sys}/${dia}`; nibpMap = `(${Math.round((sys + 2 * dia) / 3)})`;
    }
  }

  // Silence + alarmes.
  const silenced = s.silencedUntil && nowTs < s.silencedUntil;
  const L = s.limits;
  const alarms = {
    fc: perfusing && (disp.fc < L.hrLow || disp.fc > L.hrHigh),
    spo2: perfusing && spo2Show !== "---" && spo2Show < L.spo2Low,
    pa: s.artOn && perfusing && (disp.paSys < L.sysLow || disp.paSys > L.sysHigh || pam < L.mapLow),
    etco2: perfusing && (disp.etco2 < L.etco2Low || disp.etco2 > L.etco2High),
  };
  const anyThreshold = Object.values(alarms).some(Boolean);
  const priority = !perfusing ? "high" : anyThreshold ? "medium" : null;

  // Clignotement.
  const [blink, setBlink] = useState(true);
  useEffect(() => { const i = setInterval(() => setBlink((b) => !b), 400); return () => clearInterval(i); }, []);

  // Son : alarmes uniquement (plus de bip QRS).
  useEffect(() => {
    if (!s.soundOn || silenced) { audio.stopAlarm(); return; }
    if (priority) audio.startAlarm(priority); else audio.stopAlarm();
    return () => audio.stopAlarm();
  }, [s.soundOn, priority, silenced]);

  // Bip QRS (asservi à la SpO2), indépendant de l'affichage de la courbe ECG.
  const spo2Ref = useRef(spo2Live); spo2Ref.current = spo2Live;
  useEffect(() => {
    let timer;
    const tick = () => {
      const st = store.getState();
      const Rr = RHYTHMS[st.rhythmKey];
      const perf = Rr.perfusing;
      const h = Rr.fixedHr !== null ? Rr.fixedHr : st.fc;
      const muted = st.silencedUntil && Date.now() < st.silencedUntil;
      let next = 300;
      if (st.soundOn && !muted && perf && h) { audio.beep(spo2Ref.current); next = 60000 / h; }
      timer = setTimeout(tick, next);
    };
    timer = setTimeout(tick, 400);
    return () => clearTimeout(timer);
  }, []);

  // Cycle : régulier, ou irrégulier (arythmie complète) pour la FA.
  const cycleFor = (h, beat) => {
    const base = h ? 60 / h : 0.2;
    return R.irregular ? base * (1 + 0.4 * seeded(beat)) : base;
  };
  const ecgSample = (phase, tSec, beat) => {
    const h = instHr();
    const newAmp = R.fn(phase, h || 300, tSec, beat);
    const amp = blend(newAmp, () => {
      const Ro = RHYTHMS[transRef.current.oldKey];
      const ho = hrOf(Ro, s.fc);
      return Ro.fn(phase, ho || 300, tSec, beat);
    });
    return { amp, cycle: cycleFor(h, beat) };
  };
  const plethSample = (phase, tSec, beat) => {
    const h = instHr();
    const newAmp = perfusing ? plethAmplitude(phase, h) * (spo2Live / 98) : 0;
    const amp = blend(newAmp, () => {
      const Ro = RHYTHMS[transRef.current.oldKey];
      return Ro.perfusing ? plethAmplitude(phase, hrOf(Ro, s.fc) || 60) * (spo2Live / 98) : 0;
    });
    return { amp, cycle: cycleFor(h, beat) };
  };
  const respNow = () => Math.sin(Date.now() / 1000 * (2 * Math.PI * store.getState().rr / 60));
  const artSample = (phase, tSec, beat) => {
    const h = instHr();
    const newAmp = perfusing ? arterialAmplitude(phase, h, respNow()) : 0.02;
    const amp = blend(newAmp, () => {
      const Ro = RHYTHMS[transRef.current.oldKey];
      return Ro.perfusing ? arterialAmplitude(phase, hrOf(Ro, s.fc) || 60, respNow()) : 0.02;
    });
    return { amp, cycle: cycleFor(h, beat) };
  };
  const co2Sample = (phase, tSec) => ({ amp: perfusing ? capnoAmplitude(tSec, s.rr) : 0.02, cycle: 999 });

  const numSize = compact ? 30 : 54;
  const blinkStyle = (blinkOn, color) => ({ color, fontSize: numSize, fontWeight: 700, lineHeight: 1, fontVariantNumeric: "tabular-nums", opacity: blinkOn && !blink ? 0.15 : 1 });

  // COURBES : une ligne par courbe activée en régie.
  const waveRows = [
    s.showEcg && { key: "ecg", color: COLORS.ecg, sample: ecgSample, px: compact ? 34 : 52, base: 0.55, label: "II", value: perfusing ? disp.fc : (hr || "---"), unit: "bpm", sub: R.label, alarm: alarms.fc },
    s.showPleth && { key: "pleth", color: COLORS.pleth, sample: plethSample, px: compact ? 34 : 50, base: 0.9, label: "Pléth", value: spo2Show, unit: "%", sub: "SpO₂", alarm: alarms.spo2 },
    s.artOn && { key: "art", color: COLORS.art, sample: artSample, px: compact ? 34 : 50, base: 0.9, label: "PA", value: perfusing ? `${disp.paSys}/${disp.paDia}` : "---", unit: "mmHg", sub: perfusing ? `(${pam})` : "", alarm: alarms.pa },
    s.co2On && { key: "co2", color: COLORS.co2, sample: co2Sample, px: compact ? 30 : 45, base: 0.85, label: "CO₂", value: perfusing ? disp.etco2 : 0, unit: "mmHg", sub: `FR ${s.rr}`, alarm: alarms.etco2 },
  ].filter(Boolean);

  // CASES chiffres : FC et SpO2 en case si leur courbe est OFF ; PNI + contrôles toujours.
  const tiles = [];
  if (!s.showEcg) tiles.push({ key: "fc", color: COLORS.ecg, label: "FC", value: perfusing ? disp.fc : (hr || "---"), unit: "bpm", alarm: alarms.fc });
  if (!s.showPleth) tiles.push({ key: "spo2", color: COLORS.pleth, label: "SpO₂", value: spo2Show, unit: "%", alarm: alarms.spo2 });
  tiles.push({ key: "pni", type: "pni" });
  tiles.push({ key: "ctrl", type: "ctrl" });

  const fs = (base) => (compact ? base * 0.6 : base);

  // Chrono (dérivé de l'état synchronisé) + horloge.
  const chronoMs = s.chronoBase + (s.chronoRunning && s.chronoStartedAt ? nowTs - s.chronoStartedAt : 0);
  const fmtChrono = (ms) => {
    const t = Math.floor(ms / 1000), m = Math.floor(t / 60), sec = t % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  const clockStr = new Date(nowTs).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const renderTile = (t) => {
    const cardBase = (accent) => ({ background: "linear-gradient(160deg,#0e0f13,#080809)", border: `1px solid ${accent}55`, borderRadius: 12, boxShadow: `inset 0 0 0 1px #ffffff08`, display: "flex", flexDirection: "column", justifyContent: "center", padding: 10 });
    if (t.type === "pni") {
      const col = nibpFail ? COLORS.art : nibpMeasuring ? "#ffd60a" : "#fff";
      return (
        <div key={t.key} style={{ ...cardBase("#888"), alignItems: "center" }}>
          <span style={{ color: "#fff", fontSize: fs(14), opacity: 0.7, alignSelf: "flex-start" }}>PNI</span>
          <span style={{ color: col, fontSize: nibpMeasuring || nibpFail ? fs(20) : fs(46), fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
            {nibpMeasuring ? "mesure…" : nibpDisplay}
          </span>
          <span style={{ color: "#fff", fontSize: fs(13), opacity: 0.6 }}>{nibpMap}{nibpFail ? "" : " mmHg"}</span>
        </div>
      );
    }
    if (t.type === "ctrl") {
      const sq = (color, disabled) => ({ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: compact ? 44 : 74, fontSize: fs(12), fontWeight: 700, borderRadius: 16, cursor: disabled ? "default" : "pointer", border: "1px solid " + color + "88", background: "linear-gradient(160deg,#17181c,#101013)", color, padding: 6, boxSizing: "border-box" });
      const pniDis = nibpMeasuring || !perfusing;
      return (
        <div key={t.key} style={{ ...cardBase("#333"), display: "grid", gridTemplateColumns: "1fr 1fr", gap: compact ? 6 : 10 }}>
          <button onClick={() => set({ nibpRequestedAt: Date.now() })} disabled={pniDis} style={sq(pniDis ? "#555" : "#fff", pniDis)}>
            <span style={{ fontSize: fs(28) }}>🩺</span>
            <span>{!perfusing ? "indispo." : nibpMeasuring ? "en cours…" : "PNI"}</span>
          </button>
          <button onClick={() => set({ silencedUntil: silenced ? null : Date.now() + 120000 })} style={sq(silenced ? "#ffb300" : "#ffd60a")}>
            <span style={{ fontSize: fs(28) }}>{silenced ? "🔔" : "🔕"}</span>
            <span>{silenced ? "Réactiver" : "Alarme"}</span>
          </button>
        </div>
      );
    }
    return (
      <div key={t.key} style={{ ...cardBase(t.color), alignItems: "center" }}>
        <span style={{ color: t.color, fontSize: fs(15), opacity: 0.9, alignSelf: "flex-start" }}>{t.label}</span>
        <span style={{ ...blinkStyle(t.alarm, t.color), fontSize: fs(compact ? 44 : 92), textShadow: `0 0 14px ${t.color}66` }}>{t.value}</span>
        <span style={{ color: t.color, fontSize: fs(13), opacity: 0.6 }}>{t.unit}</span>
      </div>
    );
  };

  return (
    <div style={{ height: "100%", boxSizing: "border-box", padding: compact ? 4 : 10, background: "linear-gradient(150deg,#1c1f26,#0d0e12)", borderRadius: compact ? 10 : 18 }}>
      <div style={{ background: "radial-gradient(circle at 50% -10%, #0c0d12, #000 65%)", height: "100%", display: "flex", flexDirection: "column", position: "relative", border: "1px solid #2c2f37", borderRadius: compact ? 6 : 12, overflow: "hidden", boxSizing: "border-box", boxShadow: "inset 0 0 22px #000" }}>
      {/* Barre d'en-tête moniteur */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: compact ? "2px 8px" : "4px 14px", background: "linear-gradient(#141821,#0a0c11)", borderBottom: "1px solid #23262e", fontSize: fs(12) }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, color: "#8fa3b0" }}>
          <span style={{ width: fs(8), height: fs(8), borderRadius: "50%", background: "#00e34a", boxShadow: "0 0 6px #00e34a" }} />
          MONITEUR · Adulte
        </span>
        <span style={{ color: "#cfd6dd", letterSpacing: 1, fontWeight: 600 }}>{R.label}</span>
      </div>
      {(s.clockOn || s.chronoOn) && (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: compact ? 16 : 32, padding: compact ? "2px 8px" : "4px 16px", borderBottom: "1px solid #111", fontVariantNumeric: "tabular-nums" }}>
          {s.chronoOn && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button onClick={() => s.chronoRunning
                ? set({ chronoRunning: false, chronoBase: s.chronoBase + (Date.now() - s.chronoStartedAt), chronoStartedAt: null })
                : set({ chronoRunning: true, chronoStartedAt: Date.now() })}
                style={{ background: "#151515", border: "1px solid #9ad", color: "#9ad", borderRadius: 10, padding: compact ? "2px 8px" : "4px 12px", cursor: "pointer", fontSize: fs(16), fontWeight: 700 }}>
                {s.chronoRunning ? "⏸" : "▶"}
              </button>
              <span style={{ color: s.chronoRunning ? "#00e34a" : "#9ad", fontSize: fs(28), fontWeight: 700 }}>{fmtChrono(chronoMs)}</span>
            </div>
          )}
          {s.clockOn && <span style={{ color: "#aaa", fontSize: fs(22) }}>{clockStr}</span>}
        </div>
      )}
      {silenced && (
        <div style={{ position: "absolute", top: 6, right: 8, zIndex: 5, color: "#ffd60a", fontSize: compact ? 11 : 14, border: "1px solid #ffd60a", borderRadius: 4, padding: "2px 8px" }}>🔕 Silence</div>
      )}

      {/* Zone courbes (seulement si au moins une courbe activée) */}
      {waveRows.length > 0 && (
        <div style={{ flex: waveRows.length, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {waveRows.map((row) => (
            <div key={row.key} style={{ flex: 1, display: "flex", borderBottom: "1px solid #16181d", borderLeft: `3px solid ${row.color}66`, minHeight: 0 }}>
              <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
                <span style={{ position: "absolute", top: 3, left: 8, color: row.color, fontSize: compact ? 10 : 13, letterSpacing: 1 }}>{row.label}</span>
                <Trace color={row.color} sample={row.sample} pxPerUnit={row.px} baselineRatio={row.base} />
              </div>
              <div style={{ width: compact ? 92 : 175, borderLeft: "1px solid #111", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "flex-end", padding: compact ? "0 8px" : "0 16px" }}>
                <span style={{ color: row.color, fontSize: compact ? 10 : 13, alignSelf: "flex-start", opacity: 0.85 }}>{row.sub}</span>
                <span style={blinkStyle(row.alarm, row.color)}>{row.value}</span>
                <span style={{ color: row.color, fontSize: compact ? 9 : 12, opacity: 0.6 }}>{row.unit}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Zone cases : grille 2 colonnes */}
      <div style={{ flex: waveRows.length > 0 ? 1 : 2, display: "grid", gridTemplateColumns: "1fr 1fr", gap: compact ? 6 : 12, padding: compact ? 6 : 12, minHeight: 0 }}>
        {tiles.map(renderTile)}
      </div>
      <div style={{ position: "absolute", bottom: 3, left: 0, right: 0, textAlign: "center", color: "#e8e8e8", fontSize: compact ? 9 : 13, fontWeight: 600, letterSpacing: 0.3, pointerEvents: "none", textShadow: "0 0 4px #000" }}>
        application créée par @un_homme_en_blanc
      </div>
      </div>
    </div>
  );
}

/* ============================================================================
 * RÉGIE
 * ==========================================================================*/

function Slider({ label, value, min, max, onChange, color, disabled }) {
  return (
    <div style={{ opacity: disabled ? 0.4 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#bbb", marginBottom: 2 }}>
        <span>{label}</span><span style={{ color }}>{value}</span>
      </div>
      <input type="range" min={min} max={max} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: color }} />
    </div>
  );
}

function RegiePanel() {
  const [s, set] = useSession();
  const R = RHYTHMS[s.rhythmKey];
  const btn = (active, color) => ({ padding: "9px 8px", fontSize: 13, borderRadius: 6, cursor: "pointer", textAlign: "left", border: "1px solid " + (active ? color : "#333"), background: active ? "#12261a" : "#151515", color: active ? color : "#bbb" });
  const silenced = s.silencedUntil && Date.now() < s.silencedUntil;
  const head = { color: "#888", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, marginTop: 6 };

  const nibpBusy = s.nibpRequestedAt && Date.now() - s.nibpRequestedAt < NIBP_DURATION;
  const nibpBlocked = nibpBusy || !R.perfusing;

  const [custom, setCustom] = useState(loadPresets());
  const applyPreset = (p) => set(p.state);
  const saveCurrent = () => {
    const name = (typeof prompt === "function" ? prompt("Nom du scénario ?") : "") || "";
    if (!name.trim()) return;
    const next = [...custom.filter((c) => c.name !== name.trim()), { name: name.trim(), state: snapshot(store.getState()) }];
    setCustom(next); savePresets(next);
  };
  const delPreset = (name) => { const next = custom.filter((c) => c.name !== name); setCustom(next); savePresets(next); };
  const pBtn = { padding: "9px 8px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid #2a3f66", background: "#141c2b", color: "#cdd", textAlign: "left" };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" }}>
      {/* Barre fixe : action PNI toujours accessible, hors zone scrollable */}
      <div style={{ padding: 12, borderBottom: "1px solid #222", background: "#0d0d0d" }}>
        <button onClick={() => set({ nibpRequestedAt: Date.now() })} disabled={nibpBlocked}
          style={{ width: "100%", padding: "14px", fontSize: 15, fontWeight: 700, borderRadius: 8, cursor: nibpBlocked ? "default" : "pointer",
            border: "1px solid " + (nibpBlocked ? "#555" : "#fff"), background: nibpBlocked ? "#222" : "#1a1a1a", color: nibpBlocked ? "#888" : "#fff" }}>
          {!R.perfusing ? "PNI indisponible (pas de pouls)" : nibpBusy ? "PNI — mesure en cours…" : "▶ Déclencher mesure PNI"}
        </button>
      </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, overflowY: "auto", flex: 1, boxSizing: "border-box" }}>
      <div style={head}>Scénarios</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {BUILTIN_PRESETS.map((p) => (
          <button key={p.name} onClick={() => applyPreset(p)} style={pBtn}>{p.name}</button>
        ))}
      </div>
      {custom.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          {custom.map((p) => (
            <div key={p.name} style={{ display: "flex", gap: 3 }}>
              <button onClick={() => applyPreset(p)} style={{ ...pBtn, flex: 1 }}>{p.name}</button>
              <button onClick={() => delPreset(p.name)} style={{ ...pBtn, padding: "9px 8px", color: "#c66", borderColor: "#633" }}>✕</button>
            </div>
          ))}
        </div>
      )}
      <button onClick={saveCurrent} style={{ ...pBtn, textAlign: "center", borderColor: "#3a5", color: "#8e8" }}>💾 Sauver l'état actuel</button>

      <div style={head}>Rythme</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {Object.entries(RHYTHMS).map(([k, v]) => (
          <button key={k} onClick={() => set({ rhythmKey: k })} style={btn(s.rhythmKey === k, COLORS.ecg)}>{v.label}</button>
        ))}
      </div>

      <div style={head}>Constantes</div>
      <Slider label="FC" value={hrOf(R, s.fc)} min={20} max={220} color={COLORS.ecg} disabled={R.fixedHr !== null} onChange={(fc) => set({ fc })} />
      <Slider label="SpO₂ cible" value={s.spo2} min={70} max={100} color={COLORS.pleth} onChange={(spo2) => set({ spo2 })} />
      <Slider label="EtCO₂" value={s.etco2} min={0} max={80} color={COLORS.co2} onChange={(etco2) => set({ etco2 })} />
      <Slider label="FR" value={s.rr} min={5} max={40} color={COLORS.co2} onChange={(rr) => set({ rr })} />

      <div style={head}>Courbes affichées</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button onClick={() => set({ showEcg: !s.showEcg })} style={btn(s.showEcg, COLORS.ecg)}>Courbe ECG {s.showEcg ? "ON" : "OFF"}</button>
        <button onClick={() => set({ showPleth: !s.showPleth })} style={btn(s.showPleth, COLORS.pleth)}>Courbe Pléth {s.showPleth ? "ON" : "OFF"}</button>
        <button onClick={() => set({ artOn: !s.artOn })} style={btn(s.artOn, COLORS.art)}>PA invasive (KTa) {s.artOn ? "ON" : "OFF"}</button>
        <button onClick={() => set({ co2On: !s.co2On })} style={btn(s.co2On, COLORS.co2)}>EtCO₂ {s.co2On ? "ON" : "OFF"}</button>
      </div>
      {s.artOn && <>
        <Slider label="PA syst." value={s.paSys} min={40} max={220} color={COLORS.art} onChange={(paSys) => set({ paSys })} />
        <Slider label="PA diast." value={s.paDia} min={20} max={140} color={COLORS.art} onChange={(paDia) => set({ paDia })} />
      </>}

      <div style={head}>PNI (cibles)</div>
      <Slider label="PNI syst. cible" value={s.nibpSys} min={40} max={220} color="#fff" onChange={(nibpSys) => set({ nibpSys })} />
      <Slider label="PNI diast. cible" value={s.nibpDia} min={20} max={140} color="#fff" onChange={(nibpDia) => set({ nibpDia })} />

      <div style={head}>Seuils d'alarme</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <Slider label="FC bas" value={s.limits.hrLow} min={20} max={100} color="#ff8" onChange={(v) => set({ limits: { ...s.limits, hrLow: v } })} />
        <Slider label="FC haut" value={s.limits.hrHigh} min={80} max={200} color="#ff8" onChange={(v) => set({ limits: { ...s.limits, hrHigh: v } })} />
        <Slider label="SpO₂ bas" value={s.limits.spo2Low} min={80} max={99} color="#ff8" onChange={(v) => set({ limits: { ...s.limits, spo2Low: v } })} />
        <Slider label="PAM bas" value={s.limits.mapLow} min={40} max={90} color="#ff8" onChange={(v) => set({ limits: { ...s.limits, mapLow: v } })} />
      </div>

      <div style={head}>Chrono / Horloge</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <button onClick={() => set({ clockOn: !s.clockOn })} style={btn(s.clockOn, "#9ad")}>Horloge {s.clockOn ? "ON" : "OFF"}</button>
        <button onClick={() => set({ chronoOn: !s.chronoOn })} style={btn(s.chronoOn, "#9ad")}>Chrono {s.chronoOn ? "ON" : "OFF"}</button>
      </div>
      {s.chronoOn && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <button
            onClick={() => s.chronoRunning
              ? set({ chronoRunning: false, chronoBase: s.chronoBase + (Date.now() - s.chronoStartedAt), chronoStartedAt: null })
              : set({ chronoRunning: true, chronoStartedAt: Date.now() })}
            style={btn(s.chronoRunning, "#9ad")}>
            {s.chronoRunning ? "⏸ Pause" : "▶ Démarrer"}
          </button>
          <button onClick={() => set({ chronoBase: 0, chronoRunning: false, chronoStartedAt: null })} style={btn(false, "#9ad")}>↺ Reset</button>
        </div>
      )}

      <div style={head}>Réglages</div>
      <button onClick={() => set({ noiseOn: !s.noiseOn })} style={btn(s.noiseOn, "#9c9")}>Bruit temporel {s.noiseOn ? "ON" : "OFF"}</button>
      {!s.soundOn ? (
        <button onClick={() => { audio.enable(); set({ soundOn: true }); }} style={btn(false, "#4fc3f7")}>🔊 Activer le son</button>
      ) : (
        <button onClick={() => { audio.stopAlarm(); set({ soundOn: false }); }} style={btn(true, "#4fc3f7")}>Son activé — couper</button>
      )}
      {!silenced ? (
        <button onClick={() => set({ silencedUntil: Date.now() + 120000 })} style={btn(false, "#ffd60a")}>🔕 Silence alarme (2 min)</button>
      ) : (
        <button onClick={() => set({ silencedUntil: null })} style={btn(true, "#ffd60a")}>Silence actif — réactiver</button>
      )}
    </div>
    </div>
  );
}

/* ============================================================================
 * PAGES
 * ==========================================================================*/

function Home({ onEnter }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const enter = async (role) => {
    const c = code || "000000";
    setErr(null);
    if (!SUPABASE_READY) { onEnter(role, c); return; }
    setBusy(true);
    try {
      await store.connect(SUPABASE_URL, SUPABASE_ANON, c, role === "pilote" ? "pilote" : "scope");
      onEnter(role, c);
    } catch (e) {
      setErr("Connexion impossible : " + (e?.message || "vérifie ta connexion internet."));
    } finally { setBusy(false); }
  };
  // Génère un code à 6 chiffres pour ouvrir une nouvelle session.
  const genCode = () => setCode(String(Math.floor(100000 + Math.random() * 900000)));

  const bigBtn = (bg) => ({ padding: "20px 30px", fontSize: 19, borderRadius: 12, border: "none", cursor: busy ? "wait" : "pointer", background: bg, color: "#000", fontWeight: 700, minWidth: 210, opacity: busy ? 0.6 : 1 });
  const field = { padding: "11px 14px", fontSize: 14, borderRadius: 8, border: "1px solid #333", background: "#111", color: "#fff", boxSizing: "border-box" };
  const step = (n, txt) => (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: COLORS.ecg, fontWeight: 700, minWidth: 16 }}>{n}</span>
      <span>{txt}</span>
    </div>
  );

  return (
    <div style={{ background: "#0a0a0a", minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, fontFamily: "'Helvetica Neue', Arial, sans-serif", color: "#eee", padding: 20 }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: COLORS.ecg, letterSpacing: 2 }}>SCOPE SIMU</div>
        <div style={{ color: "#666", fontSize: 14, marginTop: 4 }}>Simulateur de monitorage — formation</div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
        <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="Code (6 chiffres)" inputMode="numeric"
          style={{ ...field, fontSize: 24, letterSpacing: 8, textAlign: "center", width: 300 }} />
        <button onClick={genCode} style={{ ...field, cursor: "pointer", fontSize: 13, color: "#9ad", borderColor: "#9ad" }}>🎲 Générer</button>
      </div>

      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", justifyContent: "center" }}>
        <button style={bigBtn(COLORS.ecg)} disabled={busy} onClick={() => enter("pilote")}>RÉGIE (pilote)</button>
        <button style={bigBtn(COLORS.pleth)} disabled={busy} onClick={() => enter("scope")}>SCOPE (apprenant)</button>
      </div>

      {busy && <div style={{ color: "#4fc3f7", fontSize: 13 }}>Connexion…</div>}
      {err && <div style={{ color: "#ff8", fontSize: 12, maxWidth: 440, textAlign: "center" }}>{err}</div>}

      <div style={{ maxWidth: 460, fontSize: 13, color: "#aaa", lineHeight: 1.7, background: "#101216", border: "1px solid #23262e", borderRadius: 10, padding: "14px 18px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ color: "#eee", fontWeight: 700, marginBottom: 2 }}>Mode d'emploi</div>
        {step("1", <>Sur la tablette formateur : génère ou saisis un code, puis <b style={{ color: COLORS.ecg }}>RÉGIE</b>.</>)}
        {step("2", <>Sur la/les tablette(s) apprenant : saisis <b>le même code</b>, puis <b style={{ color: COLORS.pleth }}>SCOPE</b>.</>)}
        {step("3", "La régie pilote tout en direct ; le scope affiche le moniteur.")}
      </div>

      <div style={{ color: "#e8e8e8", fontSize: 13, fontWeight: 600, textShadow: "0 0 4px #000" }}>
        application créée par @un_homme_en_blanc
      </div>
    </div>
  );
}

// Petit badge d'état de connexion (mode Supabase).
function ConnBadge() {
  const [s] = useSession();
  if (store.getMode() !== "supabase") return null;
  return (
    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid " + (s.connected ? "#00e34a" : "#ff8"), color: s.connected ? "#00e34a" : "#ff8" }}>
      {s.connected ? "● connecté" : "○ reconnexion…"}
    </span>
  );
}

function PiloteScreen({ code, onExit }) {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#000", fontFamily: "'Helvetica Neue', Arial, sans-serif" }}>
      <div style={{ height: 44, background: "#0a0a0a", borderBottom: "1px solid #222", display: "flex", alignItems: "center", padding: "0 14px", gap: 12, color: "#aaa", fontSize: 13 }}>
        <button onClick={onExit} style={{ background: "none", border: "1px solid #333", color: "#aaa", borderRadius: 6, padding: "5px 10px", cursor: "pointer" }}>← Accueil</button>
        <span style={{ color: COLORS.ecg, fontWeight: 700 }}>RÉGIE</span>
        <ConnBadge />
        <span style={{ marginLeft: "auto", color: "#444", fontSize: 11 }}>créée par @un_homme_en_blanc</span>
        <span style={{ letterSpacing: 3 }}>Session {code}</span>
      </div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ width: 340, borderRight: "1px solid #222", background: "#0a0a0a" }}><RegiePanel /></div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ color: "#666", fontSize: 11, padding: "4px 10px", borderBottom: "1px solid #111" }}>APERÇU SCOPE</div>
          <div style={{ flex: 1, minHeight: 0 }}><ScopeView compact /></div>
        </div>
      </div>
    </div>
  );
}

function ScopeScreen({ code, onExit }) {
  const [s] = useSession();
  const rootRef = useRef(null);
  const [isFull, setIsFull] = useState(false);
  // Safari interdit l'audio sans geste : au 1er contact n'importe où, on l'active.
  const enableSound = () => { if (!store.getState().soundOn) { audio.enable(); store.setState({ soundOn: true }); } };
  const toggleFull = () => {
    const el = rootRef.current;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
      setIsFull(true);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      setIsFull(false);
    }
  };
  useEffect(() => {
    const onChange = () => setIsFull(!!(document.fullscreenElement || document.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => { document.removeEventListener("fullscreenchange", onChange); document.removeEventListener("webkitfullscreenchange", onChange); };
  }, []);
  // Bandeau perte de liaison : seulement après une connexion déjà établie.
  const wasConn = useRef(false);
  if (s.connected) wasConn.current = true;
  const showLost = store.getMode() === "supabase" && !s.connected && wasConn.current;
  return (
    <div ref={rootRef} onPointerDown={enableSound} style={{ height: "100vh", background: "#000", position: "relative" }}>
      {showLost && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 20, background: "#c0202a", color: "#fff", textAlign: "center", padding: "10px", fontWeight: 700, fontSize: 16, letterSpacing: 0.5 }}>
          ⚠ PERTE DE LIAISON — reconnexion en cours…
        </div>
      )}
      <div style={{ position: "absolute", top: 4, left: 8, zIndex: 10, display: "flex", gap: 8, alignItems: "center" }}>
        {!isFull && <button onClick={onExit} style={{ background: "rgba(0,0,0,0.5)", border: "1px solid #222", color: "#555", borderRadius: 6, padding: "4px 8px", cursor: "pointer", fontSize: 12 }}>←</button>}
        {!s.soundOn && (
          <span style={{ background: "#123", border: "1px solid #4fc3f7", color: "#4fc3f7", borderRadius: 6, padding: "4px 10px", fontSize: 12 }}>🔊 Touchez l'écran pour le son</span>
        )}
        <ConnBadge />
      </div>
      <button onClick={toggleFull} style={{ position: "absolute", top: 4, right: 8, zIndex: 10, background: "rgba(0,0,0,0.5)", border: "1px solid #333", color: "#888", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12 }}>
        {isFull ? "⤢ Quitter plein écran" : "⤢ Plein écran"}
      </button>
      <ScopeView />
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState({ screen: "home", code: "0000" });
  if (route.screen === "home") return <Home onEnter={(screen, code) => setRoute({ screen, code })} />;
  if (route.screen === "pilote") return <PiloteScreen code={route.code} onExit={() => setRoute({ screen: "home", code: route.code })} />;
  return <ScopeScreen code={route.code} onExit={() => setRoute({ screen: "home", code: route.code })} />;
}
