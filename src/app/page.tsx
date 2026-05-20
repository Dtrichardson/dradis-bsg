"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ===========================================================================
//  TYPES
// ===========================================================================

type ContactType = "friendly" | "hostile" | "unknown" | "civilian";

type Contact = {
  id: number;
  type: ContactType;
  bearing: number;            // deg, 0 = up
  range: number;              // 0..1 of max range
  vBearing: number;           // deg/sec
  vRange: number;             // range/sec
  callsign: string;
  birth: number;
  pingPhase: number;          // 0..1 — set to 1 when sweep crosses
  flicker: number;            // per-contact flicker offset
};

type AlertCondition = 1 | 2 | 3;

// ===========================================================================
//  CONSTANTS
// ===========================================================================

const SWEEP_PERIOD_S = 10;     // 10s/rotation — slow naval pace
const SWEEP_DEG_PER_S = 360 / SWEEP_PERIOD_S;
const MAX_RANGE_KM = 100000;

const FRIENDLY_CALLSIGNS = [
  "STARBUCK", "APOLLO", "HELO", "ATHENA", "HOTDOG", "KAT",
  "RAPTOR-1", "RAPTOR-2", "VIPER-7", "VIPER-9", "RACETRACK", "REDWING",
  "DUCK", "CRASHDOWN", "HARDBALL",
];
const HOSTILE_CALLSIGNS = [
  "BASESTAR-A", "BASESTAR-B", "RAIDER FLT", "HEAVY RAIDER",
  "RAIDER WING-1", "RAIDER WING-2", "CYLON FLT", "RES SHIP",
];
const CIVILIAN_CALLSIGNS = [
  "COLONIAL ONE", "CLOUD 9", "RISING STAR", "DEMETRIUS",
  "PROMETHEUS", "ZEPHYR", "OLYMPIC CARRIER", "GIDEON",
];

const COMMS_LINES = [
  "ACTUAL THIS IS GALACTICA, FLEET STATION KEEPING NOMINAL",
  "CAG TO ALL VIPERS — MAINTAIN CAP, KEEP IT TIGHT",
  "DAMAGE CONTROL TEAM 3 TO HANGAR DECK",
  "FTL SPOOL AT 47 PERCENT, STANDING BY",
  "DRADIS SCAN ACTIVE, BEARING SWEEP NOMINAL",
  "TYLIUM RESERVES 78 PERCENT, NOMINAL BURN",
  "TIGH ON THE COMM — XO REPORTS GALLEY 2 SECURED",
  "RAPTOR FOXTROT-9 ON STATION, MARK 23 / CARROM 154",
  "WEAPONS HOT, BATTERIES STAGED FOR ENGAGEMENT",
  "SO SAY WE ALL",
  "ALL HANDS, THIS IS THE COMMANDER — STEADY ON",
  "CIC — TURN COMPLETE, COMING TO NEW HEADING",
];

let nextId = 1;

// ===========================================================================
//  HELPERS
// ===========================================================================

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const degToRad = (d: number) => (d * Math.PI) / 180;

// detect if sweep angle crossed a target this frame (handles 360 wrap)
function angleCrossed(prev: number, curr: number, target: number): boolean {
  prev = ((prev % 360) + 360) % 360;
  curr = ((curr % 360) + 360) % 360;
  target = ((target % 360) + 360) % 360;
  if (prev <= curr) return target > prev && target <= curr;
  return target > prev || target <= curr;
}

function makeContact(type: ContactType, bearing?: number, range?: number): Contact {
  const cs =
    type === "friendly" ? pick(FRIENDLY_CALLSIGNS) :
    type === "hostile"  ? pick(HOSTILE_CALLSIGNS)  :
    type === "civilian" ? pick(CIVILIAN_CALLSIGNS) : "UNKNOWN";
  return {
    id: nextId++,
    type,
    bearing: bearing ?? rand(0, 360),
    range: range ?? rand(0.18, 0.95),
    vBearing: rand(-3, 3),         // slower, deliberate drift
    vRange: rand(-0.005, 0.005),
    callsign: cs,
    birth: performance.now(),
    pingPhase: 1,
    flicker: Math.random() * Math.PI * 2,
  };
}

// ===========================================================================
//  AUDIO — continuous low hum + per-contact pings
// ===========================================================================

type AudioRefs = {
  ctx: AudioContext | null;
  hum: { osc: OscillatorNode; gain: GainNode } | null;
  on: boolean;
};

function startHum(ctx: AudioContext): { osc: OscillatorNode; gain: GainNode } {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.value = 60;
  gain.gain.value = 0.012;       // very low — bed tone
  // soft second hum layer
  const osc2 = ctx.createOscillator();
  osc2.type = "sine";
  osc2.frequency.value = 90;
  const gain2 = ctx.createGain();
  gain2.gain.value = 0.006;
  osc.connect(gain).connect(ctx.destination);
  osc2.connect(gain2).connect(ctx.destination);
  osc.start();
  osc2.start();
  return { osc, gain };
}

function ping(ctx: AudioContext | null, type: ContactType) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  const freq =
    type === "hostile"  ? 180 :
    type === "friendly" ? 720 :
    type === "civilian" ? 540 : 440;
  o.frequency.value = freq;
  g.gain.value = 0;
  o.connect(g).connect(ctx.destination);
  const now = ctx.currentTime;
  g.gain.linearRampToValueAtTime(type === "hostile" ? 0.18 : 0.08, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + (type === "hostile" ? 0.32 : 0.18));
  o.start(now);
  o.stop(now + 0.35);
}

function clickTick(ctx: AudioContext | null) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "square";
  o.frequency.value = 1800;
  o.connect(g).connect(ctx.destination);
  const now = ctx.currentTime;
  g.gain.value = 0;
  g.gain.linearRampToValueAtTime(0.018, now + 0.001);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
  o.start(now);
  o.stop(now + 0.04);
}

function alarmTone(ctx: AudioContext | null) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(180, ctx.currentTime);
  o.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.6);
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.62);
}

// ===========================================================================
//  COMPONENT
// ===========================================================================

export default function Dradis() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const trailRef = useRef<HTMLCanvasElement | null>(null);   // offscreen phosphor
  const noiseRef = useRef<HTMLCanvasElement>(null);

  const contactsRef = useRef<Contact[]>([]);
  const sweepRef = useRef(0);
  const lastTickRef = useRef<number>(0);

  const audioRef = useRef<AudioRefs>({ ctx: null, hum: null, on: true });

  const [hud, setHud] = useState({
    sweepBearing: 0,
    selectedId: null as number | null,
    contactCount: 0,
    hostiles: 0,
    friendlies: 0,
    civilians: 0,
    unknowns: 0,
  });
  const [contactList, setContactList] = useState<Contact[]>([]);
  const [alertCond, setAlertCond] = useState<AlertCondition>(3);
  const [soundOn, setSoundOn] = useState(true);
  const [stardate] = useState(() => 49872 + Math.floor(Math.random() * 900));

  // Ship status (slowly drifts to feel alive)
  const [ship, setShip] = useState({
    ftlSpool: 47,
    fuel: 78,
    ammo: 92,
    dc: 100,
    hangar: 16,
  });

  // ---- seed ----
  useEffect(() => {
    contactsRef.current = [
      makeContact("friendly"),
      makeContact("friendly"),
      makeContact("friendly"),
      makeContact("civilian"),
      makeContact("civilian"),
      makeContact("unknown"),
    ];
  }, []);

  // ---- audio init ----
  const ensureAudio = useCallback(() => {
    const r = audioRef.current;
    if (!r.ctx) {
      try {
        const Ctx =
          (typeof window !== "undefined" &&
            (window.AudioContext ||
              (window as unknown as { webkitAudioContext: typeof AudioContext })
                .webkitAudioContext)) || null;
        if (Ctx) r.ctx = new Ctx();
      } catch { r.ctx = null; }
    }
    if (r.ctx?.state === "suspended") r.ctx.resume();
    if (r.ctx && !r.hum && r.on) r.hum = startHum(r.ctx);
  }, []);

  // ---- main render loop ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // offscreen phosphor trail buffer
    let trail = document.createElement("canvas");
    trailRef.current = trail;
    let trailCtx = trail.getContext("2d");

    let raf = 0;

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // resize trail buffer to match (in CSS px, 1:1)
      trail.width = Math.floor(rect.width);
      trail.height = Math.floor(rect.height);
      trailCtx = trail.getContext("2d");
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (t: number) => {
      const dt = lastTickRef.current ? Math.min(0.05, (t - lastTickRef.current) / 1000) : 0;
      lastTickRef.current = t;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 18;

      // sweep
      const prevSweep = sweepRef.current;
      sweepRef.current = (sweepRef.current + SWEEP_DEG_PER_S * dt) % 360;
      const sweep = sweepRef.current;

      // update contacts
      const contacts = contactsRef.current;
      for (const c of contacts) {
        c.bearing = (c.bearing + c.vBearing * dt + 360) % 360;
        c.range = Math.min(0.99, Math.max(0.05, c.range + c.vRange * dt));
        if (angleCrossed(prevSweep, sweep, c.bearing)) {
          c.pingPhase = 1;
          if (audioRef.current.on) ping(audioRef.current.ctx, c.type);
        } else {
          // exponential phosphor decay — slow tail
          c.pingPhase = Math.max(0, c.pingPhase - dt * 0.32);
        }
      }

      // ============ PHOSPHOR TRAIL BUFFER ============
      if (trailCtx) {
        // fade existing trail
        trailCtx.globalCompositeOperation = "destination-out";
        trailCtx.fillStyle = "rgba(0,0,0,0.06)";
        trailCtx.fillRect(0, 0, w, h);
        trailCtx.globalCompositeOperation = "source-over";

        // paint sweep cone wedge into trail
        const sweepRad = degToRad(sweep - 90);
        const coneWidth = degToRad(2.2);
        const grad = trailCtx.createRadialGradient(cx, cy, 0, cx, cy, R);
        grad.addColorStop(0, "rgba(60,255,140,0.0)");
        grad.addColorStop(0.7, "rgba(80,255,150,0.18)");
        grad.addColorStop(1, "rgba(120,255,180,0.55)");
        trailCtx.beginPath();
        trailCtx.moveTo(cx, cy);
        trailCtx.arc(cx, cy, R, sweepRad - coneWidth, sweepRad);
        trailCtx.closePath();
        trailCtx.fillStyle = grad;
        trailCtx.fill();
      }

      // ============ MAIN DRAW ============
      ctx.clearRect(0, 0, w, h);

      // bg
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.1);
      bg.addColorStop(0, "#062414");
      bg.addColorStop(0.7, "#021008");
      bg.addColorStop(1, "#000604");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // outer scope ring (slightly imperfect — wobble)
      drawWobblyCircle(ctx, cx, cy, R, "#1c7a40", 2, t * 0.001);

      // range rings (4)
      for (let i = 1; i <= 4; i++) {
        drawWobblyCircle(ctx, cx, cy, (R * i) / 4, "#0c4a24", 1, t * 0.0008 + i);
      }

      // crosshair
      ctx.strokeStyle = "#0c4a24";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();

      // bearing ticks every 5°, labels every 30°
      ctx.fillStyle = "#5cc080";
      ctx.font = "10px var(--font-mono), monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let deg = 0; deg < 360; deg += 5) {
        const a = degToRad(deg - 90);
        const major = deg % 30 === 0;
        const inner = major ? R - 14 : deg % 10 === 0 ? R - 8 : R - 4;
        ctx.strokeStyle = major ? "#1c7a40" : "#0c4a24";
        ctx.lineWidth = major ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
        if (major) {
          const tx = cx + Math.cos(a) * (R - 26);
          const ty = cy + Math.sin(a) * (R - 26);
          ctx.fillText(String(deg).padStart(3, "0"), tx, ty);
        }
      }

      // range labels
      ctx.fillStyle = "#3a8d52";
      ctx.font = "9px var(--font-mono), monospace";
      ctx.textAlign = "left";
      for (let i = 1; i <= 4; i++) {
        const km = ((MAX_RANGE_KM * i) / 4) | 0;
        ctx.fillText(`${(km / 1000).toFixed(0)}K`, cx + 4, cy - (R * i) / 4 + 1);
      }

      // ============ COMPOSITE PHOSPHOR TRAIL ============
      if (trailRef.current) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(trailRef.current, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.restore();
      }

      // sweep leading line
      const sweepRad = degToRad(sweep - 90);
      ctx.strokeStyle = "rgba(180, 255, 200, 0.95)";
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 8;
      ctx.shadowColor = "rgba(80, 255, 150, 0.8)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweepRad) * R, cy + Math.sin(sweepRad) * R);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // center ship marker (Galactica)
      ctx.fillStyle = "#9effc4";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#5cffaa";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(80,255,150,0.3)";
      ctx.stroke();
      // BSG label
      ctx.fillStyle = "#5cc080";
      ctx.font = "8px var(--font-mono), monospace";
      ctx.textAlign = "center";
      ctx.fillText("BS-75", cx, cy + 22);

      // contacts
      ctx.shadowBlur = 0;
      for (const c of contacts) {
        const a = degToRad(c.bearing - 90);
        const x = cx + Math.cos(a) * (c.range * R);
        const y = cy + Math.sin(a) * (c.range * R);
        // per-contact slight flicker
        const flick = 0.85 + 0.15 * Math.sin(t * 0.012 + c.flicker);
        drawContact(ctx, x, y, c, flick);
      }

      // contact list outside scope: nope (kept on side panel for cleanliness)

      // brief horizontal rolling scan distortion (occasional)
      if (Math.random() < 0.005) {
        const yOff = Math.random() * h;
        ctx.fillStyle = "rgba(80,255,150,0.06)";
        ctx.fillRect(0, yOff, w, 2);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ---- noise overlay ----
  useEffect(() => {
    const c = noiseRef.current;
    if (!c) return;
    const cx = c.getContext("2d");
    if (!cx) return;
    let raf = 0;
    const resize = () => {
      c.width = Math.floor(window.innerWidth / 2);
      c.height = Math.floor(window.innerHeight / 2);
    };
    resize();
    window.addEventListener("resize", resize);

    const tick = () => {
      const w = c.width, h = c.height;
      const img = cx.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 255);
        d[i] = 0; d[i + 1] = v; d[i + 2] = (v / 3) | 0; d[i + 3] = v;
      }
      cx.putImageData(img, 0, 0);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  // ---- HUD updater ----
  useEffect(() => {
    const id = setInterval(() => {
      const cs = contactsRef.current;
      const hostiles = cs.filter((c) => c.type === "hostile").length;
      const friendlies = cs.filter((c) => c.type === "friendly").length;
      const civilians = cs.filter((c) => c.type === "civilian").length;
      const unknowns = cs.filter((c) => c.type === "unknown").length;
      setHud((p) => ({
        ...p,
        sweepBearing: Math.round(sweepRef.current),
        contactCount: cs.length,
        hostiles, friendlies, civilians, unknowns,
      }));
      setContactList([...cs].sort((a, b) => a.range - b.range));
      // auto-elevate alert if hostiles present
      setAlertCond((cur) => {
        if (hostiles > 0 && cur > 1) return 1;
        return cur;
      });
      // ship status drift
      setShip((s) => ({
        ftlSpool: Math.min(100, Math.max(0, s.ftlSpool + (Math.random() - 0.45) * 0.6)),
        fuel: Math.max(0, s.fuel - Math.random() * 0.02),
        ammo: s.ammo - (Math.random() < 0.05 ? Math.random() * 0.3 : 0),
        dc: Math.min(100, s.dc + (Math.random() - 0.5) * 0.1),
        hangar: s.hangar,
      }));
    }, 200);
    return () => clearInterval(id);
  }, []);

  // ---- subtle click ticks while idle (military hardware feel) ----
  useEffect(() => {
    const id = setInterval(() => {
      if (Math.random() < 0.45) clickTick(audioRef.current.on ? audioRef.current.ctx : null);
    }, 1700);
    return () => clearInterval(id);
  }, []);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    ensureAudio();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const cx = rect.width / 2, cy = rect.height / 2;
    const R = Math.min(rect.width, rect.height) / 2 - 18;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist > R) return;

    let hit: Contact | null = null;
    let hd = Infinity;
    for (const c of contactsRef.current) {
      const a = degToRad(c.bearing - 90);
      const x = cx + Math.cos(a) * (c.range * R);
      const y = cy + Math.sin(a) * (c.range * R);
      const d = Math.hypot(x - px, y - py);
      if (d < 14 && d < hd) { hit = c; hd = d; }
    }
    setHud((h) => ({ ...h, selectedId: hit ? hit.id : null }));
    clickTick(audioRef.current.on ? audioRef.current.ctx : null);
  };

  const spawn = (type: ContactType) => {
    ensureAudio();
    contactsRef.current = [...contactsRef.current, makeContact(type)];
    if (type === "hostile") setAlertCond(1);
    clickTick(audioRef.current.on ? audioRef.current.ctx : null);
  };

  const jump = () => {
    ensureAudio();
    if (audioRef.current.on) alarmTone(audioRef.current.ctx);
    contactsRef.current = [
      makeContact("friendly"),
      makeContact("friendly"),
      makeContact("civilian"),
      makeContact("civilian"),
      ...Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => makeContact("hostile")),
    ];
    setHud((h) => ({ ...h, selectedId: null }));
    setShip((s) => ({ ...s, ftlSpool: 0 }));
  };

  const clearAll = () => {
    contactsRef.current = [];
    setHud((h) => ({ ...h, selectedId: null }));
    setAlertCond(3);
  };

  const toggleSound = () => {
    ensureAudio();
    audioRef.current.on = !audioRef.current.on;
    setSoundOn(audioRef.current.on);
    if (!audioRef.current.on && audioRef.current.hum) {
      audioRef.current.hum.gain.gain.value = 0;
    } else if (audioRef.current.on && audioRef.current.hum) {
      audioRef.current.hum.gain.gain.value = 0.012;
    }
  };

  const selected =
    hud.selectedId !== null ? contactsRef.current.find((c) => c.id === hud.selectedId) ?? null : null;

  // ---- render ----
  return (
    <div className="crt phosphor min-h-screen w-full flex flex-col">
      <canvas ref={noiseRef} className="noise" />

      {/* ============ TOP BAR ============ */}
      <header className="border-b border-green-900/70 bg-black/70 px-3 py-1.5 flex items-center justify-between text-[10px] tracking-[0.22em]">
        <div className="flex items-center gap-4">
          <span className="glow-text font-bold tracking-[0.4em] text-sm">D R A D I S</span>
          <span className="dim hidden md:inline">DIRECTION RANGING DETECTION & IDENTIFICATION SCANNER</span>
        </div>
        <div className="flex items-center gap-3">
          <ConditionBadge cond={alertCond} />
          <span className="dim hidden md:inline">|</span>
          <span className="dim">NAV: AHEAD STD</span>
          <span className="dim hidden md:inline">|</span>
          <span className="dim">{`STARDATE ${stardate}.${Math.floor((Date.now() / 1000) % 1000)}`}</span>
        </div>
      </header>

      {/* ============ BODY ============ */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[260px_1fr_300px] gap-2 p-2">
        {/* LEFT: ship status + controls */}
        <aside className="flex flex-col gap-2 text-[11px]">
          <Panel title="GALACTICA // BS-75">
            <Stat label="FTL SPOOL" value={ship.ftlSpool} unit="%" warn={ship.ftlSpool < 30} />
            <Stat label="TYLIUM" value={ship.fuel} unit="%" warn={ship.fuel < 20} />
            <Stat label="ORDNANCE" value={ship.ammo} unit="%" warn={ship.ammo < 25} />
            <Stat label="DAMAGE CTRL" value={ship.dc} unit="%" warn={ship.dc < 60} />
            <div className="flex justify-between mt-1 dim">
              <span>HANGAR</span>
              <span className="tick">{ship.hangar} VIPERS RDY</span>
            </div>
          </Panel>

          <Panel title="WEAPONS">
            <KV k="MAIN BTRY" v="STAGED" />
            <KV k="FLAK BTRY" v="AUTO-CIWS" />
            <KV k="FORWARD" v="LOCKED" />
            <KV k="DC TEAMS" v="3 / 3 RDY" />
          </Panel>

          <Panel title="TACTICAL CONTROLS">
            <div className="grid grid-cols-2 gap-1.5 mt-1">
              <Btn onClick={() => spawn("friendly")} tone="green">+ FRIENDLY</Btn>
              <Btn onClick={() => spawn("hostile")} tone="red">+ HOSTILE</Btn>
              <Btn onClick={() => spawn("civilian")} tone="amber">+ CIVILIAN</Btn>
              <Btn onClick={() => spawn("unknown")} tone="dim">+ UNKNOWN</Btn>
              <Btn onClick={jump} tone="amber">⚡ FTL JUMP</Btn>
              <Btn onClick={clearAll} tone="dim">CLEAR</Btn>
            </div>
            <div className="grid grid-cols-3 gap-1.5 mt-1.5">
              <Btn onClick={() => setAlertCond(1)} tone={alertCond === 1 ? "red" : "dim"}>C-1</Btn>
              <Btn onClick={() => setAlertCond(2)} tone={alertCond === 2 ? "amber" : "dim"}>C-2</Btn>
              <Btn onClick={() => setAlertCond(3)} tone={alertCond === 3 ? "green" : "dim"}>C-3</Btn>
            </div>
            <button
              onClick={toggleSound}
              className="mt-1.5 w-full border border-green-900/70 hover:border-green-600 px-2 py-1 text-[10px] tracking-wider"
            >
              SOUND :: {soundOn ? "ON" : "OFF"}
            </button>
          </Panel>
        </aside>

        {/* CENTER: scope */}
        <section className="panel relative overflow-hidden min-h-[60vh]">
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            className="block w-full h-full"
          />
          {/* Corner labels — feel like a real instrument */}
          <div className="pointer-events-none absolute top-2 left-2 text-[10px] dim tracking-widest">
            DRADIS.SCAN.ACTIVE
          </div>
          <div className="pointer-events-none absolute top-2 right-2 text-[10px] dim tracking-widest text-right">
            BRG {String(hud.sweepBearing).padStart(3, "0")}°<br/>
            RNG 100,000 KM
          </div>
          <div className="pointer-events-none absolute bottom-2 left-2 text-[10px] tracking-widest">
            <span className="dim">CONTACTS </span>
            <span className="tick">{hud.contactCount}</span>
            <span className="dim"> // FRD </span>
            <span className="tick">{hud.friendlies}</span>
            <span className="dim"> CIV </span>
            <span className="glow-amber">{hud.civilians}</span>
            <span className="dim"> UNK </span>
            <span className="tick">{hud.unknowns}</span>
            <span className="dim"> HST </span>
            <span className={hud.hostiles > 0 ? "glow-red" : "dim"}>{hud.hostiles}</span>
          </div>
          <div className="pointer-events-none absolute bottom-2 right-2 text-[10px] dim tracking-widest blink">
            ● REC
          </div>
          {hud.hostiles > 0 && (
            <div className="absolute top-1/2 -translate-y-1/2 left-2 alarm border border-red-700/80 bg-black/70 px-2 py-1 text-[10px] glow-red tracking-widest">
              ⚠ HOSTILE
            </div>
          )}
        </section>

        {/* RIGHT: contact list + selected readout */}
        <aside className="flex flex-col gap-2 text-[11px]">
          <Panel title="CONTACT LIST">
            <div className="text-[10px] dim grid grid-cols-[14px_1fr_38px_38px] gap-x-1 mb-1 px-1">
              <span></span><span>CALLSIGN</span><span className="text-right">BRG</span><span className="text-right">RNG</span>
            </div>
            <div className="max-h-[220px] overflow-y-auto pr-1">
              {contactList.length === 0 && (
                <p className="dim p-1">— NO CONTACTS —</p>
              )}
              {contactList.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setHud((h) => ({ ...h, selectedId: c.id }))}
                  className={`w-full grid grid-cols-[14px_1fr_38px_38px] gap-x-1 px-1 py-0.5 text-left text-[10px] hover:bg-green-900/30 ${
                    hud.selectedId === c.id ? "bg-green-900/40 border-l border-green-400" : ""
                  }`}
                >
                  <span className={typeColorClass(c.type)}>{typeGlyph(c.type)}</span>
                  <span className={typeColorClass(c.type)}>{c.callsign}</span>
                  <span className="text-right tick">{Math.round(c.bearing).toString().padStart(3, "0")}</span>
                  <span className="text-right tick">{(c.range * 100).toFixed(0)}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="SELECTED">
            {selected ? <ContactReadout c={selected} /> : <p className="dim">— NO SELECTION —</p>}
          </Panel>

          <Panel title="LEGEND">
            <LegendRow color="text-green-300 glow-text" glyph="▲" label="FRIENDLY" />
            <LegendRow color="text-red-400 glow-red" glyph="◆" label="HOSTILE" />
            <LegendRow color="text-amber-300 glow-amber" glyph="■" label="CIVILIAN" />
            <LegendRow color="text-green-200/80" glyph="○" label="UNKNOWN" />
          </Panel>
        </aside>
      </main>

      {/* ============ BOTTOM TICKER ============ */}
      <footer className="border-t border-green-900/70 bg-black/80 overflow-hidden">
        <div className="marquee text-[10px] py-1 dim tracking-widest">
          {[...COMMS_LINES, ...COMMS_LINES].map((line, i) => (
            <span key={i} className="px-6">
              <span className="tick">▶</span>{" "}
              {line}{" "}
              <span className="dim">···</span>
            </span>
          ))}
        </div>
      </footer>
    </div>
  );
}

// ===========================================================================
//  SUBCOMPONENTS
// ===========================================================================

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-title">{title}</h2>
      <div className="p-2">{children}</div>
    </section>
  );
}

function Btn({
  children, onClick, tone = "green",
}: { children: React.ReactNode; onClick: () => void; tone?: "green" | "red" | "amber" | "dim" }) {
  const tones: Record<string, string> = {
    green: "border-green-700 text-green-300 hover:bg-green-900/40 hover:border-green-400",
    red:   "border-red-700 text-red-300 hover:bg-red-900/40 hover:border-red-400",
    amber: "border-amber-700 text-amber-300 hover:bg-amber-900/40 hover:border-amber-400",
    dim:   "border-green-900/80 text-green-400/80 hover:bg-green-900/30 hover:border-green-700",
  };
  return (
    <button
      onClick={onClick}
      className={`border px-2 py-1.5 text-[10px] tracking-[0.18em] transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function Stat({
  label, value, unit, warn,
}: { label: string; value: number; unit: string; warn?: boolean }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="mb-1.5">
      <div className="flex justify-between text-[10px] mb-0.5">
        <span className="dim">{label}</span>
        <span className={warn ? "glow-amber" : "tick"}>
          {v.toFixed(0)}{unit}
        </span>
      </div>
      <div className="h-1.5 border border-green-900/80 bg-black relative">
        <div
          className={`h-full ${warn ? "bg-amber-500/80" : "bg-green-500/70"}`}
          style={{ width: `${v}%` }}
        />
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-[10px] py-0.5">
      <span className="dim">{k}</span>
      <span className="tick">{v}</span>
    </div>
  );
}

function ConditionBadge({ cond }: { cond: AlertCondition }) {
  const map: Record<AlertCondition, { color: string; label: string; classes: string }> = {
    1: { color: "red",   label: "CONDITION ONE",   classes: "border-red-700 glow-red alarm" },
    2: { color: "amber", label: "CONDITION TWO",   classes: "border-amber-700 glow-amber" },
    3: { color: "green", label: "CONDITION THREE", classes: "border-green-700 glow-text" },
  };
  const c = map[cond];
  return (
    <span className={`border px-2 py-0.5 text-[10px] tracking-[0.3em] ${c.classes}`}>
      {c.label}
    </span>
  );
}

function ContactReadout({ c }: { c: Contact }) {
  const cls = typeColorClass(c.type);
  return (
    <div className="leading-relaxed text-[10px]">
      <div className={`text-xs font-bold tracking-[0.2em] ${cls}`}>
        {typeGlyph(c.type)} {c.callsign}
      </div>
      <div className="opacity-90 mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5">
        <span className="dim">ID</span>
        <span className="tick">#{String(c.id).padStart(4, "0")}</span>
        <span className="dim">CLASS</span>
        <span className={cls}>{c.type.toUpperCase()}</span>
        <span className="dim">BEARING</span>
        <span className="tick">{Math.round(c.bearing).toString().padStart(3, "0")}°</span>
        <span className="dim">RANGE</span>
        <span className="tick">{(c.range * MAX_RANGE_KM).toFixed(0)} KM</span>
        <span className="dim">VEL.BRG</span>
        <span className="tick">{c.vBearing.toFixed(2)}°/s</span>
        <span className="dim">VEL.RNG</span>
        <span className="tick">{(c.vRange * MAX_RANGE_KM).toFixed(0)} KM/s</span>
      </div>
    </div>
  );
}

function LegendRow({ color, glyph, label }: { color: string; glyph: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[10px] py-0.5">
      <span className={`${color} text-sm`}>{glyph}</span>
      <span className="dim tracking-widest">{label}</span>
    </div>
  );
}

// ===========================================================================
//  CANVAS HELPERS
// ===========================================================================

function drawWobblyCircle(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number,
  color: string, lw: number, t: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.shadowBlur = lw > 1 ? 4 : 0;
  ctx.shadowColor = color;
  ctx.beginPath();
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = Math.sin(a * 7 + t) * 0.35 + Math.sin(a * 13 + t * 1.3) * 0.2;
    const rr = r + wobble;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function typeColorClass(t: ContactType) {
  return t === "hostile"  ? "text-red-400 glow-red"
       : t === "friendly" ? "text-green-300 glow-text"
       : t === "civilian" ? "text-amber-300 glow-amber"
       : "text-green-200/80";
}
function typeGlyph(t: ContactType) {
  return t === "hostile" ? "◆" : t === "friendly" ? "▲" : t === "civilian" ? "■" : "○";
}

function drawContact(
  ctx: CanvasRenderingContext2D, x: number, y: number, c: Contact, flick: number,
) {
  const ping = c.pingPhase;
  const base =
    c.type === "hostile"  ? "#ff3030" :
    c.type === "friendly" ? "#5cffaa" :
    c.type === "civilian" ? "#ffae00" : "#9effc4";

  // ping ring
  if (ping > 0.02) {
    ctx.strokeStyle = base;
    ctx.globalAlpha = ping * 0.9;
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 10;
    ctx.shadowColor = base;
    ctx.beginPath();
    ctx.arc(x, y, 6 + (1 - ping) * 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // glow base
  ctx.shadowBlur = 6;
  ctx.shadowColor = base;
  ctx.fillStyle = base;
  ctx.strokeStyle = base;
  ctx.globalAlpha = 0.4 + 0.6 * Math.max(flick, ping);
  ctx.lineWidth = 1.5;

  if (c.type === "hostile") {
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.fill();
  } else if (c.type === "friendly") {
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 5, y + 4);
    ctx.lineTo(x - 5, y + 4);
    ctx.closePath();
    ctx.fill();
  } else if (c.type === "civilian") {
    ctx.beginPath();
    ctx.rect(x - 4, y - 4, 8, 8);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // callsign label (only when ping is fresh — phosphor persistence)
  if (ping > 0.15) {
    ctx.globalAlpha = Math.min(1, ping * 1.5);
    ctx.fillStyle = base;
    ctx.font = "9px var(--font-mono), monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.shadowBlur = 4;
    ctx.shadowColor = base;
    ctx.fillText(c.callsign, x + 9, y - 1);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
}
