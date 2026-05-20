"use client";

import { useEffect, useRef, useState, useCallback } from "react";

type ContactType = "friendly" | "hostile" | "unknown" | "civilian";

type Contact = {
  id: number;
  type: ContactType;
  // Polar coordinates relative to center
  bearing: number; // degrees, 0 = up (north)
  range: number; // 0..1 (fraction of max range)
  // Drift
  vBearing: number; // deg/sec
  vRange: number; // range/sec
  // Identifier
  callsign: string;
  // Lifecycle
  birth: number; // ms
  pingPhase: number; // 0..1 set when sweep hits, decays
};

const FRIENDLY_CALLSIGNS = [
  "STARBUCK", "APOLLO", "HELO", "ATHENA", "HOTDOG", "KAT",
  "RAPTOR-1", "RAPTOR-2", "VIPER-7", "VIPER-9", "RACETRACK", "SHARPSHOOTER",
];
const HOSTILE_CALLSIGNS = [
  "BASESTAR", "RAIDER FLT", "HEAVY RAIDER", "RESURRECTION", "BASESTAR-2",
  "RAIDER WING", "CYLON FLT",
];
const CIVILIAN_CALLSIGNS = [
  "COLONIAL ONE", "CLOUD 9", "RISING STAR", "DEMETRIUS", "PROMETHEUS",
];

let nextId = 1;

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeContact(type: ContactType, bearing?: number, range?: number): Contact {
  const callsign =
    type === "friendly"
      ? pick(FRIENDLY_CALLSIGNS)
      : type === "hostile"
        ? pick(HOSTILE_CALLSIGNS)
        : type === "civilian"
          ? pick(CIVILIAN_CALLSIGNS)
          : "UNKNOWN";
  return {
    id: nextId++,
    type,
    bearing: bearing ?? rand(0, 360),
    range: range ?? rand(0.2, 0.95),
    vBearing: rand(-6, 6),
    vRange: rand(-0.01, 0.01),
    callsign,
    birth: performance.now(),
    pingPhase: 1,
  };
}

// Brief "boop" tone via WebAudio. Different pitch for hostile vs friendly.
function ping(audioCtx: AudioContext | null, type: ContactType) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  const freq = type === "hostile" ? 220 : type === "friendly" ? 660 : 440;
  o.frequency.value = freq;
  g.gain.value = 0;
  o.connect(g).connect(audioCtx.destination);
  const now = audioCtx.currentTime;
  g.gain.linearRampToValueAtTime(0.12, now + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  o.start(now);
  o.stop(now + 0.2);
}

export default function Dradis() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const contactsRef = useRef<Contact[]>([]);
  const sweepRef = useRef(0); // current sweep angle in degrees
  const lastTickRef = useRef<number>(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const soundOnRef = useRef(true);

  const [hud, setHud] = useState({
    contactCount: 0,
    hostiles: 0,
    friendlies: 0,
    sweepBearing: 0,
    selected: null as Contact | null,
    alarm: false,
  });
  const [soundOn, setSoundOn] = useState(true);

  // Seed contacts
  useEffect(() => {
    contactsRef.current = [
      makeContact("friendly"),
      makeContact("friendly"),
      makeContact("civilian"),
      makeContact("hostile"),
    ];
  }, []);

  // Init audio on first interaction
  const ensureAudio = useCallback(() => {
    if (!audioCtxRef.current) {
      try {
        const Ctx =
          typeof window !== "undefined"
            ? (window.AudioContext ||
                (window as unknown as { webkitAudioContext: typeof AudioContext })
                  .webkitAudioContext)
            : null;
        if (Ctx) audioCtxRef.current = new Ctx();
      } catch {
        audioCtxRef.current = null;
      }
    }
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume();
    }
  }, []);

  // Main render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;

    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const SWEEP_SPEED = 60; // deg/sec → 6 sec/rotation

    const draw = (t: number) => {
      const dt = lastTickRef.current ? (t - lastTickRef.current) / 1000 : 0;
      lastTickRef.current = t;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2 - 14;

      // Update sweep
      const prevSweep = sweepRef.current;
      sweepRef.current = (sweepRef.current + SWEEP_SPEED * dt) % 360;
      const sweep = sweepRef.current;

      // Update contacts (drift)
      let hostiles = 0,
        friendlies = 0;
      const contacts = contactsRef.current;
      for (const c of contacts) {
        c.bearing = (c.bearing + c.vBearing * dt + 360) % 360;
        c.range = Math.min(0.99, Math.max(0.05, c.range + c.vRange * dt));
        // Detect sweep crossing
        const crossed = angleCrossed(prevSweep, sweep, c.bearing);
        if (crossed) {
          c.pingPhase = 1;
          if (soundOnRef.current) ping(audioCtxRef.current, c.type);
        } else {
          c.pingPhase = Math.max(0, c.pingPhase - dt * 0.45);
        }
        if (c.type === "hostile") hostiles++;
        if (c.type === "friendly") friendlies++;
      }

      // ===== Draw =====
      ctx.clearRect(0, 0, w, h);

      // Background radial gradient
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      bg.addColorStop(0, "#031a0d");
      bg.addColorStop(1, "#000604");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // Outer ring
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#1c5a32";
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.stroke();

      // Range rings
      ctx.strokeStyle = "#0e3a1f";
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Crosshairs / cardinal lines
      ctx.strokeStyle = "#0e3a1f";
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();

      // Bearing ticks every 10°
      ctx.strokeStyle = "#1c5a32";
      ctx.fillStyle = "#3a8d52";
      ctx.font = "10px var(--font-mono), monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (let deg = 0; deg < 360; deg += 10) {
        const a = degToRad(deg - 90); // 0 = up
        const inner = deg % 30 === 0 ? R - 12 : R - 6;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
        if (deg % 30 === 0) {
          const tx = cx + Math.cos(a) * (R - 22);
          const ty = cy + Math.sin(a) * (R - 22);
          ctx.fillText(String(deg).padStart(3, "0"), tx, ty);
        }
      }

      // Sweep cone (the "arm")
      const sweepRad = degToRad(sweep - 90);
      const coneWidth = degToRad(35);
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
      grad.addColorStop(0, "rgba(43, 255, 136, 0.0)");
      grad.addColorStop(0.6, "rgba(43, 255, 136, 0.10)");
      grad.addColorStop(1, "rgba(43, 255, 136, 0.28)");
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, sweepRad - coneWidth, sweepRad);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Sweep leading line
      ctx.strokeStyle = "rgba(120, 255, 180, 0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweepRad) * R, cy + Math.sin(sweepRad) * R);
      ctx.stroke();

      // Center dot (battlestar = us)
      ctx.fillStyle = "#2bff88";
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#2bff88";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.stroke();

      // Contacts
      for (const c of contacts) {
        const a = degToRad(c.bearing - 90);
        const x = cx + Math.cos(a) * (c.range * R);
        const y = cy + Math.sin(a) * (c.range * R);
        drawContact(ctx, x, y, c);
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // HUD updater (cheap, decoupled from RAF)
  useEffect(() => {
    const id = setInterval(() => {
      const cs = contactsRef.current;
      const hostiles = cs.filter((c) => c.type === "hostile").length;
      const friendlies = cs.filter((c) => c.type === "friendly").length;
      setHud((prev) => ({
        ...prev,
        contactCount: cs.length,
        hostiles,
        friendlies,
        sweepBearing: Math.round(sweepRef.current),
        alarm: hostiles > 0,
        selected: prev.selected
          ? cs.find((c) => c.id === prev.selected!.id) ?? null
          : null,
      }));
    }, 120);
    return () => clearInterval(id);
  }, []);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    ensureAudio();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const R = Math.min(rect.width, rect.height) / 2 - 14;
    const dx = px - cx;
    const dy = py - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > R) return;

    // First check: did we click an existing contact?
    let hit: Contact | null = null;
    let hitDist = Infinity;
    for (const c of contactsRef.current) {
      const a = degToRad(c.bearing - 90);
      const cxp = cx + Math.cos(a) * (c.range * R);
      const cyp = cy + Math.sin(a) * (c.range * R);
      const d = Math.hypot(cxp - px, cyp - py);
      if (d < 14 && d < hitDist) {
        hit = c;
        hitDist = d;
      }
    }
    if (hit) {
      setHud((h) => ({ ...h, selected: hit }));
      return;
    }
    setHud((h) => ({ ...h, selected: null }));
  };

  const spawn = (type: ContactType) => {
    ensureAudio();
    contactsRef.current = [...contactsRef.current, makeContact(type)];
  };

  const jump = () => {
    ensureAudio();
    // Big alarm-style ping
    if (soundOnRef.current && audioCtxRef.current) {
      const ac = audioCtxRef.current;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(180, ac.currentTime);
      o.frequency.exponentialRampToValueAtTime(60, ac.currentTime + 0.6);
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.6);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.62);
    }
    contactsRef.current = [
      makeContact("friendly"),
      makeContact("friendly"),
      makeContact("civilian"),
      ...Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () =>
        makeContact("hostile"),
      ),
    ];
    setHud((h) => ({ ...h, selected: null }));
  };

  const clear = () => {
    contactsRef.current = [];
    setHud((h) => ({ ...h, selected: null }));
  };

  const toggleSound = () => {
    soundOnRef.current = !soundOnRef.current;
    setSoundOn(soundOnRef.current);
  };

  return (
    <div className="crt min-h-screen w-full flex flex-col">
      {/* Top bar */}
      <header className="border-b border-green-900/60 px-4 py-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-4">
          <span className="glow-text font-bold tracking-[0.3em]">DRADIS</span>
          <span className="opacity-60">COLONIAL FLEET // BS-75 GALACTICA</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="opacity-70">SCAN MODE: ACTIVE</span>
          <span className="opacity-70">|</span>
          <span className="opacity-70">
            STARDATE {Math.floor(performance.now() / 1000) + 49872}
          </span>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 p-4">
        {/* Scope */}
        <div className="relative rounded-md border border-green-900/60 bg-black/40 overflow-hidden">
          <canvas
            ref={canvasRef}
            onClick={handleCanvasClick}
            className="block w-full h-full min-h-[60vh]"
          />
          {hud.alarm && (
            <div className="absolute top-3 left-3 alarm border border-red-700 px-2 py-1 text-xs glow-red">
              ⚠ HOSTILE CONTACT DETECTED
            </div>
          )}
          <div className="absolute bottom-3 left-3 text-[10px] opacity-70 leading-tight">
            BEARING {String(hud.sweepBearing).padStart(3, "0")}°<br />
            RANGE: 100,000 KM<br />
            MODE: SCAN-ACTIVE
          </div>
          <div className="absolute bottom-3 right-3 text-[10px] opacity-70 text-right leading-tight">
            CONTACTS: {hud.contactCount}<br />
            <span className="text-green-300">FRIENDLY: {hud.friendlies}</span>
            <br />
            <span className={hud.hostiles > 0 ? "text-red-400 glow-red" : "opacity-60"}>
              HOSTILE: {hud.hostiles}
            </span>
          </div>
        </div>

        {/* Side panel */}
        <aside className="flex flex-col gap-3 text-xs">
          <Panel title="CONTROLS">
            <div className="grid grid-cols-2 gap-2">
              <Btn onClick={() => spawn("friendly")} tone="green">
                + FRIENDLY
              </Btn>
              <Btn onClick={() => spawn("hostile")} tone="red">
                + HOSTILE
              </Btn>
              <Btn onClick={() => spawn("civilian")} tone="amber">
                + CIVILIAN
              </Btn>
              <Btn onClick={() => spawn("unknown")} tone="dim">
                + UNKNOWN
              </Btn>
              <Btn onClick={jump} tone="amber">
                ⚡ FTL JUMP
              </Btn>
              <Btn onClick={clear} tone="dim">
                CLEAR
              </Btn>
            </div>
            <button
              onClick={toggleSound}
              className="mt-3 w-full border border-green-900/60 hover:border-green-600 px-2 py-1 text-[11px]"
            >
              SOUND: {soundOn ? "ON" : "OFF"}
            </button>
          </Panel>

          <Panel title="SELECTED CONTACT">
            {hud.selected ? (
              <ContactReadout c={hud.selected} />
            ) : (
              <p className="opacity-60">Click a contact on the scope.</p>
            )}
          </Panel>

          <Panel title="LOG">
            <p className="opacity-60 leading-relaxed">
              &gt; Active scan initiated.<br />
              &gt; Sweep rotation: 6.0s<br />
              &gt; FTL drives: STANDBY<br />
              &gt; Awaiting orders.<br />
            </p>
          </Panel>

          <p className="opacity-50 text-[10px] mt-auto">
            So say we all.
          </p>
        </aside>
      </main>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-green-900/60 bg-black/40 p-3">
      <h2 className="text-[11px] tracking-[0.25em] opacity-70 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Btn({
  children,
  onClick,
  tone = "green",
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "green" | "red" | "amber" | "dim";
}) {
  const tones: Record<string, string> = {
    green:
      "border-green-700 text-green-300 hover:bg-green-900/30 hover:border-green-500",
    red: "border-red-700 text-red-300 hover:bg-red-900/30 hover:border-red-500",
    amber:
      "border-amber-700 text-amber-300 hover:bg-amber-900/30 hover:border-amber-500",
    dim: "border-green-900/70 text-green-400/80 hover:bg-green-900/20 hover:border-green-700",
  };
  return (
    <button
      onClick={onClick}
      className={`border px-2 py-1.5 text-[11px] tracking-wider transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

function ContactReadout({ c }: { c: Contact }) {
  const toneClass =
    c.type === "hostile"
      ? "text-red-400 glow-red"
      : c.type === "friendly"
        ? "text-green-300 glow-text"
        : c.type === "civilian"
          ? "text-amber-300"
          : "text-green-200/70";
  return (
    <div className="leading-relaxed">
      <div className={`text-sm font-bold tracking-widest ${toneClass}`}>
        {c.callsign}
      </div>
      <div className="opacity-80 mt-1">
        ID: #{String(c.id).padStart(4, "0")}
        <br />
        TYPE: {c.type.toUpperCase()}
        <br />
        BEARING: {Math.round(c.bearing).toString().padStart(3, "0")}°<br />
        RANGE: {(c.range * 100000).toFixed(0)} KM<br />
        VEL.BRG: {c.vBearing.toFixed(1)}°/s<br />
        VEL.RNG: {(c.vRange * 100000).toFixed(0)} KM/s
      </div>
    </div>
  );
}

function drawContact(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  c: Contact,
) {
  const ping = c.pingPhase;
  const baseColor =
    c.type === "hostile"
      ? "#ff2a2a"
      : c.type === "friendly"
        ? "#2bff88"
        : c.type === "civilian"
          ? "#ffae00"
          : "#9effc4";

  // Ping ring
  if (ping > 0) {
    ctx.strokeStyle = `${baseColor}`;
    ctx.globalAlpha = ping;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6 + (1 - ping) * 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Base symbol
  ctx.fillStyle = baseColor;
  ctx.strokeStyle = baseColor;
  ctx.lineWidth = 1.5;

  if (c.type === "hostile") {
    // Diamond (basestar-y)
    ctx.beginPath();
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 6, y);
    ctx.lineTo(x, y + 6);
    ctx.lineTo(x - 6, y);
    ctx.closePath();
    ctx.fill();
    // Inner ring
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.stroke();
  } else if (c.type === "friendly") {
    // Triangle pointing along its bearing motion (just up for simplicity)
    ctx.beginPath();
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 5, y + 4);
    ctx.lineTo(x - 5, y + 4);
    ctx.closePath();
    ctx.fill();
  } else if (c.type === "civilian") {
    // Square
    ctx.beginPath();
    ctx.rect(x - 4, y - 4, 8, 8);
    ctx.fill();
  } else {
    // Question-mark style: hollow circle
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Callsign label
  ctx.fillStyle = `${baseColor}`;
  ctx.font = "9px var(--font-mono), monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(c.callsign, x + 9, y - 1);
}

// Helpers
function degToRad(d: number) {
  return (d * Math.PI) / 180;
}

// Did the sweep cross a target bearing this frame? Handles 360 wrap.
function angleCrossed(prev: number, curr: number, target: number): boolean {
  prev = ((prev % 360) + 360) % 360;
  curr = ((curr % 360) + 360) % 360;
  target = ((target % 360) + 360) % 360;
  if (prev <= curr) {
    return target > prev && target <= curr;
  } else {
    // wrapped
    return target > prev || target <= curr;
  }
}
