import React, { useEffect, useId, useMemo, useRef, useState } from "react";

// Water Bottle Tracker — realistic onboarding + simple main UI (React + Tailwind)
// Workflow:
// 0) Welcome
// 1) Onboarding 1/4
// 2) Onboarding 2/4
// 3) Onboarding 3/4
// 4) Onboarding 4/4
// 5) Select bottle (simple)
// 6) Your bottle (setup)
// 7) Daily water target (calculator)
// 8) Summary
// Main screen: bottle shape, title question, scroll wheel (dial), progress bar

const STORAGE_KEY = "wbt_react_v3";

const FILL_ESTIMATE_URL =
  (import.meta.env.VITE_FILL_ESTIMATE_URL as string) ||
  "https://onebottle-ai-bridge.vercel.app/api/fill-estimate";

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

class RateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfterToMs(retryAfter: string | null) {
  if (!retryAfter) return null as number | null;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const asDate = Date.parse(retryAfter);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(t);
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        window.clearTimeout(t);
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function downscaleDataUrl(dataUrl: string, maxW = 1200, quality = 0.85) {
  return new Promise<string>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.width || 0;
      const h = img.height || 0;
      if (!w || !h) {
        resolve(dataUrl);
        return;
      }
      const scale = Math.min(1, maxW / w);
      const targetW = Math.max(1, Math.round(w * scale));
      const targetH = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("Failed to load image (unsupported format?)"));
    img.src = dataUrl;
  });
}

async function estimatePercentFull(imageDataUrl: string, signal?: AbortSignal) {
  const MAX_ATTEMPTS = 2;
  let lastWaitMs: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(FILL_ESTIMATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageDataUrl }),
      signal,
    });

    const raw = await res.text();
    let data: unknown = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // non-JSON response (still useful for debugging)
    }
    const obj = (typeof data === "object" && data !== null) ? (data as Record<string, unknown>) : null;

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterToMs(res.headers.get("retry-after"));
      const backoffMs = Math.min(20000, 1200 * Math.pow(2, attempt - 1));
      const jitterMs = Math.floor(Math.random() * 450);
      const waitMs = (retryAfterMs != null && retryAfterMs > 0) ? retryAfterMs : backoffMs + jitterMs;
      lastWaitMs = waitMs;

      // If we still have attempts left, wait and retry.
      if (attempt < MAX_ATTEMPTS) {
        await sleep(waitMs, signal);
        continue;
      }

      // Final attempt still rate-limited.
      throw new RateLimitError(
        `Scan failed (429) - Gemini API rate limit. Please try again in ${Math.max(1, Math.ceil(waitMs / 1000))}s.`,
        waitMs
      );
    }

    if (!res.ok) {
      const msgFromApi = obj?.error || obj?.message;
      const snippet = typeof raw === "string" ? raw.slice(0, 220) : "";
      throw new Error(
        `Scan failed (${res.status}) ${msgFromApi ? `- ${msgFromApi}` : snippet ? `- ${snippet}` : ""}`.trim()
      );
    }

    const percentFull = typeof obj?.percent_full === "number" ? obj.percent_full : null;
    const fillFrac = typeof obj?.fill_fraction === "number" ? obj.fill_fraction : null;
    if (percentFull != null) return clamp(percentFull, 0, 100);
    if (fillFrac != null) return clamp(fillFrac * 100, 0, 100);
    throw new Error("Scan returned an unexpected response shape");
  }

  // Should be unreachable, but keeps TS happy.
  throw new RateLimitError("Scan failed (rate limited). Please try again.", lastWaitMs);
}

function dayKey(d: Date = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}


function ceilDiv(a: number, b: number) {
  return b <= 0 ? 0 : Math.ceil(a / b);
}

function sleepBoundaryMins(sleepMins: number) {
  const m = Math.round(sleepMins);
  return ((m % 1440) + 1440) % 1440;
}

function dayKeyBySleep(d: Date = new Date(), sleepMins: number) {
  const boundary = sleepBoundaryMins(sleepMins);
  const shifted = new Date(d.getTime() - boundary * 60 * 1000);
  return dayKey(shifted);
}

function prevDayKeyBySleep(d: Date = new Date(), sleepMins: number) {
  const boundary = sleepBoundaryMins(sleepMins);
  const shifted = new Date(d.getTime() - boundary * 60 * 1000);
  shifted.setDate(shifted.getDate() - 1);
  return dayKey(shifted);
}

function msUntilNextSleep(d: Date = new Date(), sleepMins: number) {
  const boundary = sleepBoundaryMins(sleepMins);
  const next = new Date(d);
  next.setHours(0, 0, 0, 0);
  next.setMinutes(boundary, 0, 0);
  if (d.getTime() >= next.getTime()) next.setDate(next.getDate() + 1);
  return Math.max(0, next.getTime() - d.getTime());
}

function formatCountdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function recommendGoalML({ weightKg, activity, warm }: { weightKg: number; activity: "low" | "moderate" | "high"; warm: boolean }) {
  const base = weightKg * 33;
  let ml = Math.round(base);
  if (activity === "moderate") ml += 300;
  if (activity === "high") ml += 600;
  if (warm) ml += 300;
  const low = Math.round(ml * 0.9);
  const high = Math.round(ml * 1.1);
  return { ml, low, high };
}

function snapValue(v: number, snap: "quarters" | "tenths" | "free") {
  const clamped = clamp(v, 0, 1);
  if (snap === "free") return clamped;
  const step = snap === "tenths" ? 0.1 : 0.25;
  return Math.round(clamped / step) * step;
}

function minutesSinceMidnight(d: Date) {
  return d.getHours() * 60 + d.getMinutes();
}

function expectedPctAt(d: Date, wakeMins: number, sleepMins: number) {
  const start = clamp(Math.round(wakeMins), 0, 1439);
  let end = clamp(Math.round(sleepMins), 0, 2879);
  let now = minutesSinceMidnight(d);
  if (end <= start) end += 1440;
  if (now < start) now += 1440;
  if (now <= start) return 0;
  if (now >= end) return 1;

  const duration = clamp(end - start, 6 * 60, 20 * 60);
  const progress = duration > 0 ? (now - start) / duration : 1;
  const checkpoints: Array<[number, number]> = [
    [0.25, 0.3],
    [0.5, 0.55],
    [0.7, 0.75],
    [0.87, 0.9],
    [1, 1],
  ];
  let prev: [number, number] = [0, 0];
  for (const [t, pct] of checkpoints) {
    if (progress <= t) {
      const span = t - prev[0];
      const ratio = span ? (progress - prev[0]) / span : 0;
      return prev[1] + (pct - prev[1]) * ratio;
    }
    prev = [t, pct];
  }
  return 1;
}

function expectedMlAt(goalML: number, d: Date, wakeMins: number, sleepMins: number) {
  return Math.round(goalML * expectedPctAt(d, wakeMins, sleepMins));
}

function timeParts(mins: number): { h12: number; min: number; ampm: Meridiem; dayOffset: number } {
  const m = clamp(Math.round(mins), 0, 2879);
  const dayOffset = m >= 1440 ? 1 : 0;
  const local = m % 1440;
  const h24 = Math.floor(local / 60);
  const min = local % 60;
  const ampm: Meridiem = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return { h12, min, ampm, dayOffset };
}

function toMinutes(h12: number, min: number, ampm: Meridiem) {
  const h = clamp(Math.round(h12), 1, 12);
  const m = clamp(Math.round(min), 0, 59);
  const h24 = (h % 12) + (ampm === "PM" ? 12 : 0);
  return h24 * 60 + m;
}


function getNowMinutes(d: Date = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

function getTodayKey(d: Date = new Date()) {
  return dayKey(d);
}

function hydrationWindowFromInputs(
  wakeHour: number,
  wakeMinute: number,
  wakeMeridiem: Meridiem,
  sleepHour: number,
  sleepMinute: number,
  sleepMeridiem: Meridiem
) {
  const wakeH = normalizeHourInput(String(wakeHour));
  const wakeM = normalizeMinuteInput(String(wakeMinute));
  const sleepH = normalizeHourInput(String(sleepHour));
  const sleepM = normalizeMinuteInput(String(sleepMinute));
  const startMins = toMinutes(wakeH, wakeM, wakeMeridiem);
  let endMins = toMinutes(sleepH, sleepM, sleepMeridiem);
  if (endMins <= startMins) endMins += 1440;
  return { startMins, endMins };
}

function normalizeHourInput(rawValue: string) {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return 1;
  const h = Math.round(n);
  if (h <= 0) return 12;
  if (h > 12) return 1;
  return h;
}

function normalizeMinuteInput(rawValue: string) {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return 0;
  return clamp(Math.round(n), 0, 59);
}


function formatClock12h(d: Date) {
  const h24 = d.getHours();
  const min = d.getMinutes();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${ampm}`;
}

function shapeClasses(shape: string) {
  switch (shape) {
    case "tall":
      return "w-[120px]";
    case "wide":
      return "w-[140px]";
    case "tumbler":
      return "w-[140px]";
    default:
      return "w-[120px]";
  }
}

function bottlePath(shape: string) {
  switch (shape) {
    case "tall":
      return "M62 8 C56 10 54 18 54 26 L54 42 C43 48 38 61 38 75 L38 270 C38 286 49 294 70 294 C91 294 102 286 102 270 L102 75 C102 61 97 48 86 42 L86 26 C86 18 84 10 78 8 Z";
    case "wide":
      return "M55 8 C50 10 48 18 48 26 L48 46 C38 54 32 68 32 85 L32 268 C32 286 48 294 70 294 C92 294 108 286 108 268 L108 85 C108 68 102 54 92 46 L92 26 C92 18 90 10 85 8 Z";
    case "tumbler":
      return "M40 18 C40 12 45 8 52 8 L88 8 C95 8 100 12 100 18 L100 30 C100 36 95 40 88 40 L86 40 L98 276 C99 289 88 294 70 294 C52 294 41 289 42 276 L54 40 L52 40 C45 40 40 36 40 30 Z";
    default:
      return "M58 8 C53 10 51 18 51 26 L51 44 C41 52 36 65 36 80 L36 270 C36 286 49 294 70 294 C91 294 104 286 104 270 L104 80 C104 65 99 52 89 44 L89 26 C89 18 87 10 82 8 Z";
  }
}

function BottleVector({
  shape,
  level,
  className,
  style,
  targetLevel,
  targetStatus,
  fillColor = "rgba(10,132,255,0.35)",
  edgeColor = "rgba(10,132,255,0.65)",
}: {
  shape: string;
  level: number;
  className?: string;
  style?: React.CSSProperties;
  targetLevel?: number;
  targetStatus?: "behind" | "ahead";
  fillColor?: string;
  edgeColor?: string;
}) {
  const id = useId();
  const d = bottlePath(shape);
  const pct = clamp(level, 0, 1);
  const targetPct = clamp(targetLevel ?? pct, 0, 1);

  const H = 300;
  const W = 140;
  const y = H - pct * H;
  const yTarget = clamp(H - targetPct * H, 6, H - 6);
  const targetStroke = targetStatus === "behind" ? "rgba(255,69,58,0.45)" : "rgba(34,197,94,0.45)";

  return (
    <svg viewBox="0 0 140 300" className={`h-[300px] ${className || ""}`} style={style} aria-hidden="true">
      <defs>
        <clipPath id={`clip-${id}`}>
          <path d={d} />
        </clipPath>
        <style>{`
          @keyframes fadeOutLine { from { opacity: 1; } to { opacity: 0; } }
        `}</style>
      </defs>

      <g clipPath={`url(#clip-${id})`}>
        <rect x="0" y="0" width={W} height={H} fill="rgba(255,255,255,0.03)" />
        <rect x="0" y={y} width={W} height={pct * H} fill={fillColor} />
        <rect x="10" y={Math.max(0, y - 2)} width={W - 20} height="2" fill={edgeColor} />
        <line
          x1="10"
          x2={W - 10}
          y1={yTarget}
          y2={yTarget}
          stroke={targetStroke}
          strokeWidth="2.5"
          strokeDasharray="6 4"
          style={targetStatus === "ahead" ? { animation: "fadeOutLine 0.6s ease forwards" } : undefined}
        />
      </g>

      <path d={d} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="4" />
      <path d={d} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
    </svg>
  );
}

function formatBottlesDecimal(goalML: number, bottleML: number) {
  if (!bottleML) return "0";
  const v = goalML / bottleML;
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function format1(v: number) {
  const s = Number(v || 0).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

type AppState = ReturnType<typeof makeDefaultState>;
type Meridiem = "AM" | "PM";
const toMeridiem = (v: string): Meridiem => (v === "AM" ? "AM" : "PM");

function makeDefaultState() {
  return {
    hasOnboarded: false,
    step: 0 as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11,
    splashSeen: false,

    weightKg: 70,
    activity: "moderate" as "low" | "moderate" | "high",
    warm: false,

    goalML: 2000,
    bottleML: 500,
    shape: "standard" as "tall" | "standard" | "wide" | "tumbler",
    snap: "free" as "quarters" | "tenths" | "free",
    wakeMins: 480,
    sleepMins: 1320,
    wakeHour: 8,
    wakeMinute: 0,
    wakeMeridiem: "AM" as Meridiem,
    sleepHour: 10,
    sleepMinute: 0,
    sleepMeridiem: "PM" as Meridiem,


    dayKey: dayKeyBySleep(new Date(), 1320),
    completedBottles: 0,
    remaining: 1,

    carryML: 0,
    extraML: 0,
    onboardingScanPercent: null as null | number,
    onboardingScanFraction: null as null | number,
    dailyLog: {} as Record<string, { consumedML: number; goalML: number; bottleML: number; carryML: number; extraML: number; at: number }>, 

    history: [] as Array<{ t: number; prevRemaining: number; prevCompleted: number; prevCarry: number; prevExtra: number; action?: string; ml?: number }>,


    celebrate: null as null | { type: "bottle" | "goal"; pct: number; consumedML: number },
  };
}

function totalConsumedFromState(s: AppState) {
  const n = ceilDiv(s.goalML, s.bottleML);
  const completed = clamp(s.completedBottles, 0, n) * s.bottleML;
  const consumedCurrent = Math.round((1 - s.remaining) * s.bottleML);
  const carry = clamp(Math.round((s.carryML || 0) as number), 0, 100000);
  const extra = clamp(Math.round((s.extraML || 0) as number), 0, 100000);
  return Math.min(s.goalML, completed + consumedCurrent + carry + extra);
}

function DropletPlugIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        d="M12 2C9.5 5.8 6.2 9.3 6.2 13.2C6.2 17 8.9 20 12 20s5.8-3 5.8-6.8C17.8 9.3 14.5 5.8 12 2Z"
        fill="#0A84FF"
        opacity="0.95"
      />
      <path
        d="M9.3 10.3c.7-1.4 1.6-2.7 2.7-4.2"
        stroke="rgba(255,255,255,.55)"
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity="0.35"
      />
      <rect x="11" y="10" width="2" height="6" rx="1" fill="rgba(255,255,255,.92)" />
      <rect x="9" y="12" width="6" height="2" rx="1" fill="rgba(255,255,255,.92)" />
    </svg>
  );
}

function BottomNavBar({
  onOpenSettings,
  onOpenAnalytics,
  onTrack,
  isTrackDisabled,
  isRefill,
  onRefill,
  isAnalyticsEnabled = false,
}: {
  onOpenSettings: () => void;
  onOpenAnalytics: () => void;
  onTrack: () => void;
  isTrackDisabled: boolean;
  isRefill: boolean;
  onRefill: () => void;
  isAnalyticsEnabled?: boolean;
}) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0B0B0F]/80 backdrop-blur-md"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 18px)" }}
    >
      <style>{`
        @keyframes navPop { 0% { opacity: .6; transform: scale(.96); } 100% { opacity: 1; transform: scale(1); } }
      `}</style>
      <div className="mx-auto flex max-w-xl items-center justify-between px-8 pt-3">
        <button
          onClick={isAnalyticsEnabled ? onOpenAnalytics : undefined}
          disabled={!isAnalyticsEnabled}
          className={"flex w-20 flex-col items-center gap-1 text-xs font-semibold " + (isAnalyticsEnabled ? "text-white/80" : "text-white/40")}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <path d="M4 19V9M10 19V5M16 19V12M22 19V8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Analytics</span>
        </button>

        {isRefill ? (
          <button
            onClick={onRefill}
            className="flex h-12 w-24 items-center justify-center rounded-2xl bg-green-500 text-sm font-extrabold text-white transition animate-[navPop_.2s_ease-out]"
          >
            Refill
          </button>
        ) : (
          <button
            onClick={onTrack}
            disabled={isTrackDisabled}
            className={
              "flex h-12 w-24 items-center justify-center rounded-2xl text-sm font-extrabold transition animate-[navPop_.2s_ease-out] " +
              (isTrackDisabled ? "bg-white/10 text-white/40 border border-white/10" : "bg-[#0A84FF] text-white")
            }
          >
            Track
          </button>
        )}

        <button onClick={onOpenSettings} className="flex w-20 flex-col items-center gap-1 text-xs font-semibold text-white/80">
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
            <path
              d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M4.5 12a7.5 7.5 0 0 0 .08 1.1l-2 1.2 2 3.5 2.2-.7a7.6 7.6 0 0 0 1.9 1.1l.3 2.3h4l.3-2.3a7.6 7.6 0 0 0 1.9-1.1l2.2.7 2-3.5-2-1.2a7.5 7.5 0 0 0 0-2.2l2-1.2-2-3.5-2.2.7a7.6 7.6 0 0 0-1.9-1.1L13 3.5h-4l-.3 2.3a7.6 7.6 0 0 0-1.9 1.1l-2.2-.7-2 3.5 2 1.2A7.5 7.5 0 0 0 4.5 12Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.7"
            />
          </svg>
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}

function QuickAddSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (ml: number) => void }) {
  const items = [
    { label: "A glass", ml: 250 },
    { label: "A can", ml: 330 },
    { label: "A small bottle", ml: 500 },
    { label: "A large bottle", ml: 750 },
  ];

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="absolute inset-0 flex items-center justify-center px-5">
        <div className="mx-auto w-full max-w-md rounded-3xl border border-white/10 bg-[#121218]/95 shadow-[0_20px_60px_rgba(0,0,0,.55)]">
          <div className="px-5 pt-4 pb-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-extrabold">Add water</div>
                <div className="mt-1 text-xs font-extrabold text-[#0A84FF]">
                  Tip: use this when you drank water from somewhere else (café, glass, can, etc.).
                </div>
              </div>
              <button
                onClick={onClose}
                className="h-10 w-10 rounded-2xl border border-white/12 bg-white/8 active:bg-white/12 flex items-center justify-center"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="px-5 pb-5">
            <div className="grid gap-2">
              {items.map((it) => (
                <button
                  key={it.label}
                  onClick={() => {
                    onAdd(it.ml);
                    onClose();
                  }}
                  className="w-full rounded-2xl border border-white/12 bg-white/6 px-4 py-4 text-left active:scale-[0.99]"
                >
                  <div className="flex items-center justify-between">
                    <div className="font-extrabold">{it.label}</div>
                    <div className="font-extrabold tabular-nums text-[#0A84FF]">+{it.ml}ml</div>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-3 text-xs text-white/60">This won’t change your bottle level.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MorningResetModal({ onConfirm, isClosing }: { onConfirm: () => void; isClosing: boolean }) {
  return (
    <div className="fixed inset-0 z-[60]">
      <style>{`
        @keyframes resetFade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes resetLift { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes resetFadeOut { from { opacity: 1; } to { opacity: 0; } }
        @keyframes resetDrop { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(12px) scale(.98); } }
      `}</style>
      <div
        className={
          "absolute inset-0 bg-black/70 backdrop-blur-sm " +
          (isClosing ? "animate-[resetFadeOut_.22s_ease-in]" : "animate-[resetFade_.25s_ease-out]")
        }
      />
      <div className="absolute inset-0 flex items-center justify-center px-5">
        <div
          className={
            "w-full max-w-md rounded-3xl border border-white/10 bg-[#121218]/95 p-6 shadow-[0_20px_60px_rgba(0,0,0,.55)] " +
            (isClosing ? "animate-[resetDrop_.22s_ease-in]" : "animate-[resetLift_.28s_ease-out]")
          }
        >
          <div className="text-2xl font-extrabold">
            <span className="text-[#F6C945]">Morning reset</span> <span>🌞</span>
          </div>
          <div className="mt-2 text-white/75">
            Let’s start fresh — <span className="font-extrabold text-[#0A84FF]">refill your bottle</span> and we’ll track from here.
          </div>
          <button
            onClick={onConfirm}
            className="mt-6 w-full px-5 py-4 rounded-2xl bg-green-500 text-white font-extrabold active:scale-[0.99]"
          >
            I’ve refilled
          </button>
        </div>
      </div>
    </div>
  );
}

const SPLASH_FILL_MS = 1100;

function SplashBottle({ className, animate = true }: { className?: string; animate?: boolean }) {
  const id = useId();
  const d = bottlePath("standard");
  const H = 300;
  const W = 140;

  return (
    <svg viewBox="0 0 140 300" className={className || ""} aria-hidden="true">
      <defs>
        <clipPath id={`sclip-${id}`}>
          <path d={d} />
        </clipPath>
      </defs>

      <g clipPath={`url(#sclip-${id})`}>
        <rect x="0" y="0" width={W} height={H} fill="rgba(255,255,255,0.03)" />
        <rect x="0" y={animate ? H : 0} width={W} height={animate ? "0" : H} fill="rgba(34,197,94,0.38)">
          {animate && (
            <>
              <animate
                attributeName="y"
                from={H}
                to="0"
                dur="1.1s"
                begin="0s"
                fill="freeze"
                calcMode="spline"
                keySplines="0.2 0 0 1"
              />
              <animate
                attributeName="height"
                from="0"
                to={H}
                dur="1.1s"
                begin="0s"
                fill="freeze"
                calcMode="spline"
                keySplines="0.2 0 0 1"
              />
            </>
          )}
        </rect>

        {animate && (
          <rect x="-30" y="0" width="60" height={H} fill="rgba(255,255,255,0.14)" opacity="0.0" transform="skewX(-18)">
            <animate attributeName="opacity" values="0;0.35;0" dur="1.3s" begin="0.25s" fill="freeze" />
            <animate attributeName="x" from="-60" to="160" dur="1.3s" begin="0.25s" fill="freeze" />
          </rect>
        )}
      </g>

      <path d={d} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="4" />
      <path d={d} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />
    </svg>
  );
}

function ScanResultBottle({ fraction }: { fraction: number }) {
  const [level, setLevel] = useState(1);
  const [mix, setMix] = useState(0);

  useEffect(() => {
    const from = 1;
    const to = clamp(fraction, 0, 1);
    const duration = 1200;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setLevel(from + (to - from) * eased);
      setMix(eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [fraction]);

  const lerp = (a: number, b: number) => Math.round(a + (b - a) * mix);
  const r = lerp(34, 10);
  const g = lerp(197, 132);
  const b = lerp(94, 255);
  const fillColor = `rgba(${r},${g},${b},0.35)`;
  const edgeColor = `rgba(${r},${g},${b},0.65)`;
  const glowStrong = `radial-gradient(circle_at_50%_45%,rgba(${r},${g},${b},0.16),rgba(0,0,0,0)_68%)`;
  const glowSoft = `radial-gradient(circle_at_50%_60%,rgba(${r},${g},${b},0.08),rgba(0,0,0,0)_72%)`;

  return (
    <div className="relative">
      <div className="pointer-events-none absolute -inset-24 rounded-full blur-3xl opacity-60 mix-blend-screen" style={{ background: glowStrong }} />
      <div className="pointer-events-none absolute -inset-28 rounded-full blur-3xl opacity-55" style={{ background: glowSoft }} />

      <div style={{ animation: "floaty 2.8s ease-in-out infinite" }} className="w-[160px]">
        <BottleVector
          shape="standard"
          level={level}
          fillColor={fillColor}
          edgeColor={edgeColor}
          className="h-[320px] w-[160px]"
          style={{ filter: `drop-shadow(0 22px 55px rgba(${r},${g},${b},0.16))` }}
        />
      </div>
    </div>
  );
}

function WelcomeSplash({ onContinue, instant = false }: { onContinue: () => void; instant?: boolean }) {
  const [showContinue, setShowContinue] = useState(instant);

  useEffect(() => {
    if (instant) return;
    const t = window.setTimeout(() => setShowContinue(true), SPLASH_FILL_MS + 2000);
    return () => window.clearTimeout(t);
  }, [instant]);

  return (
    <div className="min-h-screen bg-[#0B0B0F] text-white flex items-center justify-center select-none">
      <style>{`@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div className="w-full max-w-md px-5 text-center">
        <div className="mx-auto mb-6 flex h-[360px] items-center justify-center">
          <div className="relative">
            <div className="pointer-events-none absolute -inset-24 rounded-full bg-[radial-gradient(circle_at_50%_45%,rgba(34,197,94,0.16),rgba(0,0,0,0)_68%)] blur-3xl opacity-60 mix-blend-screen" />
            <div className="pointer-events-none absolute -inset-28 rounded-full bg-[radial-gradient(circle_at_50%_60%,rgba(34,197,94,0.08),rgba(0,0,0,0)_72%)] blur-3xl opacity-55" />

            <div style={{ animation: "floaty 2.8s ease-in-out infinite" }} className="w-[160px]">
              <SplashBottle
                animate={!instant}
                className="h-[320px] w-[160px] [filter:drop-shadow(0_22px_55px_rgba(34,197,94,0.16))]"
              />
            </div>
          </div>
        </div>

        <div style={{ animation: "fadeUp .65s ease-out both" }} className="text-4xl md:text-5xl font-extrabold leading-tight">
          Welcome to <span className="text-green-500">1Bottle</span>
        </div>

        <div className={"mt-10 transition-opacity duration-500 " + (showContinue ? "opacity-100" : "opacity-0 pointer-events-none")}>
          <button onClick={onContinue} className="w-full px-4 py-4 rounded-2xl bg-green-500 text-black font-extrabold active:scale-[0.99]">
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

type IntroProps = { onContinue: () => void; onSkip: () => void; onStartOver?: () => void };

function OnboardingFrame({
  stepText,
  title,
  body,
  activeDot,
  buttonLabel,
  buttonTheme,
  onContinue,
  onSkip,
  leftLabel,
  onLeft,
  bottomTight = false,
}: {
  stepText: string;
  title: React.ReactNode;
  body: React.ReactNode;
  activeDot: number;
  buttonLabel: string;
  buttonTheme: "blue" | "green";
  onContinue: () => void;
  onSkip: () => void;
  leftLabel?: string;
  onLeft?: () => void;
  bottomTight?: boolean;
}) {
  const FILL_MS = 1200;
  const [btnReady, setBtnReady] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setBtnReady(true), FILL_MS);
    return () => window.clearTimeout(t);
  }, []);

  const fillClass = buttonTheme === "green" ? "bg-[#22C55E]/55" : "bg-[#0A84FF]/65";
  const bgClass =
    buttonTheme === "green"
      ? "bg-gradient-to-b from-[#0F2416] to-[#0A160F]"
      : "bg-gradient-to-b from-[#111F2E] to-[#0E1621]";
  const labelClass = buttonTheme === "green" ? "text-[#86EFAC]" : "text-[#6EABD4]";

  return (
    <div className="min-h-screen bg-[#0B0B0F] text-white select-none">
      <style>{`
        @keyframes introIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes softFloat { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
        @keyframes dotPulse { 0%,100% { transform: scale(1); opacity: .65; } 50% { transform: scale(1.25); opacity: .9; } }
        @keyframes fillBar { from { transform: scaleY(0); } to { transform: scaleY(1); } }
        @keyframes labelIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      <div className="mx-auto max-w-xl min-h-screen px-5 pt-10 pb-10 md:pt-12 flex flex-col relative">
        <div style={{ animation: "introIn .55s ease-out both" }} className="relative flex items-center justify-center">
          <div className="text-[18px] font-medium text-[#4D5564] tracking-wide">—&nbsp; {stepText} &nbsp;—</div>

          {onLeft && leftLabel && (
            <button onClick={onLeft} className="absolute left-0 text-[20px] font-medium text-[#FF453A]">
              {leftLabel}
            </button>
          )}

          <button onClick={onSkip} className="absolute right-0 text-[20px] font-medium text-[#85C0E7]">
            Skip
          </button>
        </div>

        <div className="mt-20 md:mt-28 text-center" style={{ animation: "introIn .65s ease-out .08s both" }}>
          <div className="text-[46px] leading-[1.06] font-semibold">{title}</div>
        </div>

        <div className="mt-8 md:mt-10 flex items-center justify-center" style={{ animation: "introIn .65s ease-out .18s both" }}>
          <div className="max-w-[78%] text-center text-[21px] leading-relaxed text-[#757B8A]" style={{ animation: "softFloat 5.5s ease-in-out .8s infinite" }}>
            {body}
          </div>
        </div>

        <div className={bottomTight ? "mt-4" : "mt-14"} />

        <div
          className={(bottomTight ? "mt-3" : "mt-8") + " flex items-center justify-center gap-4"}
          style={{ animation: "introIn .6s ease-out .28s both" }}
        >
          {Array.from({ length: 4 }).map((_, i) => {
            const active = i === activeDot;
            return (
              <span
                key={i}
                className={"h-[9px] w-[9px] rounded-full " + (active ? "bg-white/65" : "bg-white/20")}
                style={active ? { animation: "dotPulse 1.8s ease-in-out .6s infinite" } : undefined}
              />
            );
          })}
        </div>

        <div
          className={(bottomTight ? "mt-3" : "mt-6") + " flex items-center justify-center"}
          style={{ animation: "introIn .6s ease-out .34s both" }}
        >
          <button
            onClick={onContinue}
            disabled={!btnReady}
            aria-disabled={!btnReady}
            className={
              `relative w-full max-w-md px-4 py-4 rounded-2xl overflow-hidden ${bgClass} shadow-[0_18px_55px_rgba(0,0,0,0.55)] transition active:scale-[0.99] ` +
              (!btnReady ? "opacity-80 cursor-not-allowed" : "")
            }
          >
            {!btnReady && (
              <div className="absolute inset-0">
                <div
                  className={`absolute inset-0 origin-bottom ${fillClass}`}
                  style={{ animation: `fillBar ${FILL_MS}ms cubic-bezier(0.2, 0, 0, 1) both` }}
                />
                <div className="absolute inset-0 bg-[#0B0B0F]/10" />
              </div>
            )}

            <span className="relative" style={btnReady ? { animation: "labelIn .35s ease-out both" } : { opacity: 0 }}>
              <span className={`text-[23px] font-medium ${labelClass}`}>{buttonLabel}</span>
            </span>
          </button>
        </div>

        <div
          className="mt-3 w-full text-center text-[12px] italic text-white/30"
          style={{ animation: "introIn .6s ease-out .42s both" }}
        >
          Artwork will be added here in the next build.
        </div>
      </div>
    </div>
  );
}

function OnboardingIntro1({ onContinue, onSkip }: IntroProps) {
  return (
    <OnboardingFrame
      stepText="1/4"
      activeDot={0}
      buttonTheme="blue"
      buttonLabel="Continue"
      title={
        <>
          <div className="text-white">Hydration shouldn’t</div>
          <div className="mt-3 text-[#78ACD0]">feel like math.</div>
        </>
      }
      body={
        <p>
          Most <span className="text-[#78ACD0]">water tracking apps</span> make you count glasses, track sips, and guess amounts.
        </p>
      }
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}

function OnboardingIntro2({ onContinue, onSkip }: IntroProps) {
  return (
    <OnboardingFrame
      stepText="2/4"
      activeDot={1}
      buttonTheme="blue"
      buttonLabel="Continue"
      title={
        <>
          <span className="text-white">One bottle. </span>
          <span className="text-[#78ACD0]">One habit.</span>
        </>
      }
      body={
        <>
          <p>
            As you drink, lower the <span className="text-[#78ACD0]">water level</span> in the app. When it&apos;s empty,
            refill and repeat.
          </p>
          <p className="mt-6">No sip logging. No math.</p>
        </>
      }
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}

function OnboardingIntro3({ onContinue, onSkip }: IntroProps) {
  return (
    <OnboardingFrame
      stepText="3/4"
      activeDot={2}
      buttonTheme="blue"
      buttonLabel="Continue"
      title={
        <>
          <span className="text-white">Track what’s </span>
          <span className="text-[#78ACD0]">left</span>
          <span className="text-white"> — not what you drink.</span>
        </>
      }
      body={<p>Your bottle becomes the only thing you need to think about.</p>}
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}

function OnboardingIntro4({ onContinue, onSkip, onStartOver }: IntroProps) {
  return (
    <OnboardingFrame
      bottomTight
      leftLabel="Start over"
      onLeft={onStartOver}
      stepText="4/4"
      activeDot={3}
      buttonTheme="green"
      buttonLabel="Start with my bottle"
      title={
        <>
          <span className="text-green-500">Sustainable</span>
          <span className="text-white">, by design.</span>
        </>
      }
      body={
        <>
          <div>Refill the same bottle again and again.</div>
          <div className="mt-2">Less waste. Less effort.</div>
          <div className="mt-6">
            You drink more consistently, reuse one bottle, and build a habit that’s better for you and{" "}
            <span className="text-green-500">the planet</span>.
          </div>
        </>
      }
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}

// --- Optional self-tests (won't run unless you opt in) ---
function runSelfTests() {
  // Enable by setting window.__WBT_TESTS__ = true in the console.
  if (typeof window === "undefined") return;
  const win = window as unknown as Record<string, unknown>;
  if (win.__WBT_TESTS__ !== true) return;

  console.assert(dayKey(new Date("2025-01-02T10:00:00Z")) === "2025-01-02", "dayKey should format YYYY-MM-DD");
  console.assert(formatBottlesDecimal(2000, 500) === "4", "2000/500 should format to 4");
  console.assert(formatBottlesDecimal(2900, 500) === "5.8", "2900/500 should format to 5.8");
  console.assert(snapValue(0.26, "quarters") === 0.25, "quarters snap");
  console.assert(snapValue(0.24, "tenths") === 0.2, "tenths snap");
  console.assert(recommendGoalML({ weightKg: 60, activity: "low", warm: false }).ml === 1980, "recommendGoalML base calc");
  console.assert(formatCountdown(0) === "00:00:00", "formatCountdown zero");
}

export default function WaterBottleTracker() {
  const [state, setState] = useState<AppState>(() => {
    const defaults = makeDefaultState();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  });

  // Enable optional self-tests
  useEffect(() => {
    runSelfTests();
  }, []);

  // FID_VERIFY_START
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const H = 300;
    const case1Expected = 0.9;
    const case1Actual = 0.0;
    const case1Fill = computeExpectedFillFrac(case1Expected, case1Actual);
    const case1Y = clamp(Math.round(H - case1Fill * H), 6, H - 6);
    console.log(`FID verify case1 expectedFillFrac=${case1Fill}, yTarget=${case1Y}`);

    const case2Expected = 1.5;
    const case2Actual = 0.0;
    const case2Fill = computeExpectedFillFrac(case2Expected, case2Actual);
    const case2Y = clamp(Math.round(H - case2Fill * H), 6, H - 6);
    console.log(`FID verify case2 expectedFillFrac=${case2Fill}, yTarget=${case2Y}`);
  }, []);
  // FID_VERIFY_END

  const [nowTick, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick((t) => t + 1), 10000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!state.hasOnboarded) return;
    if ([1, 2, 3, 4, 9, 10, 11].includes(state.step)) {
      setState((s) => ({ ...s, step: 0 }));
    }
  }, [state.hasOnboarded, state.step]);

  useEffect(() => {
    const p = timeParts(state.wakeMins);
    setWakeHourInput(String(p.h12));
    setWakeMinInput(String(p.min).padStart(2, "0"));
  }, [state.wakeMins]);

  useEffect(() => {
    const p = timeParts(state.sleepMins);
    setSleepHourInput(String(p.h12));
    setSleepMinInput(String(p.min).padStart(2, "0"));
  }, [state.sleepMins]);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function persistNow(next: AppState) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const resetToTodayIfNeeded = () => {
      const today = dayKeyBySleep(new Date(), stateRef.current.sleepMins);
      setState((s) => {
        if (s.dayKey === today) return s;

        const prevKey = s.dayKey;
        const consumed = totalConsumedFromState(s);
        const nextLog = {
          ...(s.dailyLog || {}),
          [prevKey]: {
            consumedML: consumed,
            goalML: s.goalML,
            bottleML: s.bottleML,
            carryML: Math.round((s.carryML || 0) as number),
            extraML: Math.round((s.extraML || 0) as number),
            at: Date.now(),
          },
        };

        const keys = Object.keys(nextLog).sort();
        const keep = keys.slice(-14);
        const pruned: AppState["dailyLog"] = {};
        for (const k of keep) pruned[k] = nextLog[k];

        const next = {
          ...s,
          dailyLog: pruned,
          dayKey: today,
          completedBottles: 0,
          remaining: 1,
          carryML: 0,
          extraML: 0,
          history: [],
          celebrate: null,
        };
        persistNow(next);
        return next;
      });
    };

    resetToTodayIfNeeded();

    let timeoutId: number | undefined;
    const scheduleNext = () => {
      const ms = msUntilNextSleep(new Date(), stateRef.current.sleepMins);
      timeoutId = window.setTimeout(() => {
        resetToTodayIfNeeded();
        scheduleNext();
      }, ms + 50);
    };
    scheduleNext();

    const onVisibility = () => {
      if (document.visibilityState === "visible") resetToTodayIfNeeded();
      if (document.visibilityState === "hidden") {
        persistNow(stateRef.current);
      }
    };

    const onPageHide = () => {
      persistNow(stateRef.current);
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      if (timeoutId) window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [state.sleepMins]);

  useEffect(() => {
    persistNow(state);
  }, [state]);

  const [resetMs, setResetMs] = useState(() => msUntilNextSleep(new Date(), state.sleepMins));
  useEffect(() => {
    const tick = () => setResetMs(msUntilNextSleep(new Date(), state.sleepMins));
    tick();
    const id = window.setInterval(tick, 1000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [state.sleepMins]);

  const bottlesPerDayText = useMemo(() => formatBottlesDecimal(state.goalML, state.bottleML), [state.goalML, state.bottleML]);

  const totalConsumed = useMemo(() => totalConsumedFromState(state), [state.completedBottles, state.remaining, state.bottleML, state.goalML, state.carryML, state.extraML]);

  const progressFrac = useMemo(() => (state.goalML > 0 ? Math.min(1, totalConsumed / state.goalML) : 0), [totalConsumed, state.goalML]);

  const bottlesLeftText = useMemo(() => {
    if (!state.bottleML) return "0";
    const goalBottles = state.goalML / state.bottleML;
    const consumedBottles = totalConsumed / state.bottleML;
    const left = Math.max(0, goalBottles - consumedBottles);
    return format1(left);
  }, [state.goalML, state.bottleML, totalConsumed]);
  const bottlesLeftValue = Number(bottlesLeftText);
  const bottleWord = bottlesLeftValue > 1 ? "bottles" : "bottle";
  const expectedNowMl = useMemo(
    () => expectedMlAt(state.goalML, new Date(), state.wakeMins, state.sleepMins),
    [state.goalML, state.wakeMins, state.sleepMins, nowTick]
  );
  const expectedBottlesNow = useMemo(
    () => (state.bottleML > 0 ? expectedNowMl / state.bottleML : 0),
    [expectedNowMl, state.bottleML]
  );
  const diffMl = useMemo(() => totalConsumed - expectedNowMl, [totalConsumed, expectedNowMl]);
  const pacingToleranceMl = useMemo(() => Math.max(state.goalML * 0.05, 150), [state.goalML]);
  const pacingStatus = useMemo(() => {
    if (diffMl > pacingToleranceMl) return "ahead" as const;
    if (diffMl < -pacingToleranceMl) return "behind" as const;
    return diffMl >= 0 ? "ahead" : "behind";
  }, [diffMl, pacingToleranceMl]);
  const computeExpectedFillFrac = (expectedBottles: number, actualConsumedBottles: number) => {
    const behindBottles = expectedBottles - actualConsumedBottles;
    if (behindBottles >= 1) return 0.03;
    return 1 - (expectedBottles % 1);
  };
  const FLAG_OFFSET_POINTS = [
    { b: 0.0, px: 0 },
    { b: 0.4, px: -10 },
    { b: 0.5, px: -15 },
    { b: 1.0, px: -22 },
    { b: 1.5, px: -28 },
    { b: 2.0, px: -34 },
  ];
  const flagOffsetForExpectedBottles = (expectedBottles: number) => {
    const b = Math.max(0, expectedBottles);
    if (b <= FLAG_OFFSET_POINTS[0].b) return FLAG_OFFSET_POINTS[0].px;
    const last = FLAG_OFFSET_POINTS[FLAG_OFFSET_POINTS.length - 1];
    if (b >= last.b) return last.px;
    for (let i = 0; i < FLAG_OFFSET_POINTS.length - 1; i += 1) {
      const a = FLAG_OFFSET_POINTS[i];
      const c = FLAG_OFFSET_POINTS[i + 1];
      if (b >= a.b && b <= c.b) {
        const t = (b - a.b) / (c.b - a.b);
        return a.px + t * (c.px - a.px);
      }
    }
    return 0;
  };
  const targetLineRemainingFraction = useMemo(() => {
    if (state.bottleML <= 0) return state.remaining;
    const actualConsumedBottles = totalConsumed / state.bottleML;
    const expectedFillFrac = computeExpectedFillFrac(expectedBottlesNow, actualConsumedBottles);
    return clamp(expectedFillFrac, 0, 1);
  }, [expectedBottlesNow, totalConsumed, state.bottleML, state.remaining]);
  const targetLineY = Math.round(300 - targetLineRemainingFraction * 300);
  const expectedBottlesForFlag = state.completedBottles > 0 ? expectedBottlesNow % 1 : expectedBottlesNow;
  const flagOffsetPx = flagOffsetForExpectedBottles(expectedBottlesForFlag);
  const flagTop = targetLineY + flagOffsetPx;
  const showFlag = expectedBottlesNow >= 0.05;

  function advanceBottle(s: AppState) {
    const n = ceilDiv(s.goalML, s.bottleML);
    if (n <= 0) return s;

    let completed = s.completedBottles;
    if (completed < n) completed += 1;

    return { ...s, completedBottles: completed, remaining: 1 };
  }

  function setRemaining(nextRemaining: number, meta: { action?: string } = {}) {
    setState((s) => {
      const today = dayKeyBySleep(new Date(), s.sleepMins);
      let ss = s;
      if (ss.dayKey !== today) {
        ss = { ...ss, dayKey: today, completedBottles: 0, remaining: 1, carryML: 0, extraML: 0, history: [], celebrate: null };
      }

      const prev = ss.remaining;
      const prevCompleted = ss.completedBottles;
      const prevCarry = (ss.carryML || 0) as number;
      const prevExtra = (ss.extraML || 0) as number;
      const r = clamp(nextRemaining, 0, 1);
      const entry = { t: Date.now(), prevRemaining: prev, prevCompleted, prevCarry, prevExtra, ...meta };
      const history = [...(ss.history || []), entry].slice(-50);

      const didEmptyBottle = meta.action === "track" && prev > 0.0001 && r <= 0.0001;

      let nextState: AppState = { ...ss, remaining: r, history };
      if (r <= 0.0001) nextState = { ...advanceBottle(nextState), history };

      const afterConsumed = totalConsumedFromState(nextState);
      const pct = nextState.goalML > 0 ? Math.round((afterConsumed / nextState.goalML) * 100) : 0;
      const hitGoal = meta.action === "track" && nextState.goalML > 0 && afterConsumed >= nextState.goalML;

      if (meta.action === "track" && (hitGoal || didEmptyBottle)) {
        nextState = {
          ...nextState,
          celebrate: {
            type: hitGoal ? "goal" : "bottle",
            pct: clamp(pct, 0, 100),
            consumedML: afterConsumed,
          },
        };
      }

      return nextState;
    });
  }

  function addExtra(ml: number) {
    setState((s) => {
      const today = dayKeyBySleep(new Date(), s.sleepMins);
      let ss = s;
      if (ss.dayKey !== today) {
        ss = { ...ss, dayKey: today, completedBottles: 0, remaining: 1, carryML: 0, extraML: 0, history: [], celebrate: null };
      }

      const prev = ss.remaining;
      const prevCompleted = ss.completedBottles;
      const prevCarry = (ss.carryML || 0) as number;
      const prevExtra = (ss.extraML || 0) as number;

      const nextExtra = clamp((ss.extraML || 0) + ml, 0, 100000);
      const entry = { t: Date.now(), prevRemaining: prev, prevCompleted, prevCarry, prevExtra, action: "extra", ml };
      const history = [...(ss.history || []), entry].slice(-50);

      return { ...ss, extraML: nextExtra, history };
    });
  }

  function undo() {
    setState((s) => {
      const h = s.history || [];
      if (h.length === 0) return s;
      const last = h[h.length - 1];
      return {
        ...s,
        remaining: last.prevRemaining,
        completedBottles: last.prevCompleted,
        carryML: typeof last.prevCarry === "number" ? last.prevCarry : (s.carryML || 0),
        extraML: typeof last.prevExtra === "number" ? last.prevExtra : s.extraML,
        history: h.slice(0, -1),
      };
    });
    setLowLevelTracked(false);
  }

  const dialRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const [pendingRemaining, setPendingRemaining] = useState(state.remaining);
  useEffect(() => {
    if (state.hasOnboarded) setPendingRemaining(state.remaining);
  }, [state.remaining, state.hasOnboarded]);

  const [displayRemaining, setDisplayRemaining] = useState(pendingRemaining);
  const [scanAnimTarget, setScanAnimTarget] = useState<number | null>(null);
  const scanAnimRafRef = useRef<number | null>(null);
  const [showLevelUpdated, setShowLevelUpdated] = useState(false);
  const levelUpdatedTimeoutRef = useRef<number | null>(null);
  const [lowLevelTracked, setLowLevelTracked] = useState(false);
  const [lastMorningResetToken, setLastMorningResetToken] = useState<string | null>(() => {
    try {
      return localStorage.getItem("v3_lastMorningResetToken");
    } catch {
      return null;
    }
  });
  const [showMorningReset, setShowMorningReset] = useState(false);
  const [morningResetClosing, setMorningResetClosing] = useState(false);

  const onboardingFileRef = useRef<HTMLInputElement | null>(null);
  const onboardingAbortRef = useRef<AbortController | null>(null);
  const [onboardingScanState, setOnboardingScanState] = useState<"idle" | "scanning" | "error">("idle");
  const [onboardingScanError, setOnboardingScanError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (onboardingAbortRef.current) onboardingAbortRef.current.abort();
    };
  }, []);


  const checkMorningReset = () => {
    if (!state.hasOnboarded) {
      setShowMorningReset(false);
      setMorningResetClosing(false);
      return;
    }
    const nowMins = getNowMinutes();
    const wakeMins = clamp(Math.round(state.wakeMins), 0, 1439);
    const todayKey = getTodayKey();
    const token = `${todayKey}-${wakeMins}`;
    if (nowMins >= wakeMins && lastMorningResetToken !== token) {
      setShowMorningReset(true);
      setMorningResetClosing(false);
    } else {
      setShowMorningReset(false);
      setMorningResetClosing(false);
    }
  };

  useEffect(() => {
    checkMorningReset();
  }, [state.wakeMins, lastMorningResetToken]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") checkMorningReset();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [state.wakeMins, lastMorningResetToken]);

  useEffect(() => {
    try {
      if (lastMorningResetToken) {
        localStorage.setItem("v3_lastMorningResetToken", lastMorningResetToken);
      }
    } catch {
      // ignore
    }
  }, [lastMorningResetToken]);

  function onOnboardingPick() {
    setOnboardingScanError(null);
    onboardingFileRef.current?.click();
  }

  function onOnboardingFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const controller = new AbortController();
    onboardingAbortRef.current = controller;
    setOnboardingScanState("scanning");
    setOnboardingScanError(null);
    (async () => {
      try {
        const dataUrl = await fileToDataUrl(file);
        const downscaled = await downscaleDataUrl(dataUrl, 1200, 0.85);
        const percent = await estimatePercentFull(downscaled, controller.signal);
        const fraction = clamp(percent / 100, 0, 1);
        setState((s) => ({ ...s, onboardingScanPercent: Math.round(percent), onboardingScanFraction: fraction }));
        setOnboardingScanState("idle");
        setStep(10);
      } catch (err) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Couldn’t scan the bottle. Try again.";
        setOnboardingScanState("error");
        setOnboardingScanError(msg);
      } finally {
        onboardingAbortRef.current = null;
      }
    })();
  }

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);
  const [scanState, setScanState] = useState<"idle" | "picking" | "scanning" | "done" | "error">("idle");
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanCooldownUntil, setScanCooldownUntil] = useState<number>(0);
  const [scanCooldownLeftMs, setScanCooldownLeftMs] = useState<number>(0);

  useEffect(() => {
    return () => {
      if (scanAbortRef.current) scanAbortRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, scanCooldownUntil - Date.now());
      setScanCooldownLeftMs(left);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [scanCooldownUntil]);

  function startScanPick() {
    const left = Math.max(0, scanCooldownUntil - Date.now());
    if (left > 0) {
      setScanError(`Rate limited. Try again in ${Math.max(1, Math.ceil(left / 1000))}s.`);
      setScanMessage(null);
      setScanState("idle");
      return;
    }

    setScanError(null);
    setScanMessage(null);
    setScanState("picking");
    fileInputRef.current?.click();
  }

  function cancelScan() {
    if (scanAbortRef.current) scanAbortRef.current.abort();
    scanAbortRef.current = null;
    setScanState("idle");
    setScanMessage(null);
    setScanError(null);
  }

  function commitScanToDailyProgress(scannedFraction: number) {
    const wasEmpty = scannedFraction <= 0.0001;
    setRemaining(scannedFraction, { action: "track" });
    if (wasEmpty) setPendingRemaining(1);
  }

  function onScanFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) {
      setScanState("idle");
      return;
    }
    const controller = new AbortController();
    scanAbortRef.current = controller;
    setScanState("scanning");
    setScanMessage("Scanning...");
    setScanError(null);
    (async () => {
      try {
        const dataUrl = await fileToDataUrl(file);
        const downscaled = await downscaleDataUrl(dataUrl, 1200, 0.85);
        const percent = await estimatePercentFull(downscaled, controller.signal);
        const fraction = clamp(percent / 100, 0, 1);
        setPendingRemaining(fraction);
        setScanAnimTarget(fraction);
        setLowLevelTracked(false);
        setScanState("done");
        setScanMessage(`Scan complete: ${Math.round(percent)}% full`);
        setScanError(null);
      } catch (err) {
        if (controller.signal.aborted) {
          setScanState("idle");
          setScanMessage(null);
          setScanError(null);
          return;
        }
        const msg = err instanceof Error ? err.message : "Couldn’t read the bottle. Try again.";
        setScanState("error");
        setScanMessage(null);

        if (err instanceof RateLimitError) {
          const ms = typeof err.retryAfterMs === "number" && err.retryAfterMs > 0 ? err.retryAfterMs : 15000;
          setScanCooldownUntil(Date.now() + ms);
        }

        setScanError(msg);
      } finally {
        scanAbortRef.current = null;
      }
    })();
  }

  function dialValueFromClientY(clientY: number) {
    const el = dialRef.current;
    if (!el) return state.remaining;
    const rect = el.getBoundingClientRect();
    const padTop = 10;
    const padBot = 10;
    const y = clamp(clientY, rect.top + padTop, rect.bottom - padBot);
    const usable = rect.height - padTop - padBot;
    const ratio = 1 - (y - (rect.top + padTop)) / usable;

    const v = snapValue(ratio, state.snap);
    return Math.min(v, state.remaining);
  }

  function onDialPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    setDragging(true);
    setLowLevelTracked(false);
    setPendingRemaining(dialValueFromClientY(e.clientY));
  }

  function onDialPointerMove(e: PointerEvent) {
    if (!dragging) return;
    setLowLevelTracked(false);
    setPendingRemaining(dialValueFromClientY(e.clientY));
  }

  function onDialPointerUp() {
    setDragging(false);
  }

  useEffect(() => {
    window.addEventListener("pointermove", onDialPointerMove);
    window.addEventListener("pointerup", onDialPointerUp);
    return () => {
      window.removeEventListener("pointermove", onDialPointerMove);
      window.removeEventListener("pointerup", onDialPointerUp);
    };
  }, [dragging, state.remaining, state.snap]);

  useEffect(() => {
    return () => {
      if (levelUpdatedTimeoutRef.current) window.clearTimeout(levelUpdatedTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (scanAnimTarget === null) {
      setDisplayRemaining(pendingRemaining);
      return;
    }

    if (scanAnimRafRef.current) {
      cancelAnimationFrame(scanAnimRafRef.current);
      scanAnimRafRef.current = null;
    }

    const start = clamp(displayRemaining, 0, 1);
    const end = clamp(scanAnimTarget, 0, 1);
    const startTime = performance.now();
    const durationMs = 550;
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = (now: number) => {
      const t = clamp((now - startTime) / durationMs, 0, 1);
      const eased = easeOutCubic(t);
      setDisplayRemaining(start + (end - start) * eased);
      if (t < 1) {
        scanAnimRafRef.current = requestAnimationFrame(step);
      } else {
        scanAnimRafRef.current = null;
        setScanAnimTarget(null);
      }
    };

    scanAnimRafRef.current = requestAnimationFrame(step);
    return () => {
      if (scanAnimRafRef.current) cancelAnimationFrame(scanAnimRafRef.current);
      scanAnimRafRef.current = null;
    };
  }, [scanAnimTarget, pendingRemaining, displayRemaining]);

  const remainingPct = Math.round(pendingRemaining * 100);
  const isLowWater = pendingRemaining <= 0.1;

  const dialThumbTop = useMemo(() => {
    const H = 260;
    const padTop = 10;
    const padBot = 10;
    const usable = H - padTop - padBot;
    return padTop + (1 - pendingRemaining) * usable;
  }, [pendingRemaining]);

  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [wakeHourInput, setWakeHourInput] = useState(() => String(timeParts(state.wakeMins).h12));
  const [wakeMinInput, setWakeMinInput] = useState(() => String(timeParts(state.wakeMins).min).padStart(2, "0"));
  const [sleepHourInput, setSleepHourInput] = useState(() => String(timeParts(state.sleepMins).h12));
  const [sleepMinInput, setSleepMinInput] = useState(() => String(timeParts(state.sleepMins).min).padStart(2, "0"));
  const [bottleSizeFlowSource, setBottleSizeFlowSource] = useState<"onboarding" | "settings">("onboarding");

  function switchBottleKeepingConsumed(patch: Partial<AppState>) {
    setState((s) => {
      const consumed = totalConsumedFromState(s);
      return {
        ...s,
        ...patch,
        completedBottles: 0,
        remaining: 1,
        carryML: consumed,
        extraML: 0,
        history: [],
        celebrate: null,
      } as AppState;
    });
  }
  function setStep(step: AppState["step"]) {
    setState((s) => ({ ...s, step }));
  }

  function resetAll() {
    setState(() => makeDefaultState());
    setBottleSizeFlowSource("onboarding");
  }

  function handleRefill() {
    commitScanToDailyProgress(pendingRemaining);
    setState((s) => {
      const consumed = totalConsumedFromState(s);
      const pct = s.goalML > 0 ? Math.round((consumed / s.goalML) * 100) : 0;
      const completed = clamp(s.completedBottles, 0, ceilDiv(s.goalML, s.bottleML));
      const extra = clamp(s.extraML || 0, 0, 100000);
      const newCarry = clamp(Math.round(consumed - completed * s.bottleML - extra), 0, 100000);
      return {
        ...s,
        celebrate: { type: "bottle", pct: clamp(pct, 0, 100), consumedML: consumed },
        carryML: newCarry,
        remaining: 1,
      };
    });
    setPendingRemaining(1);
    setDisplayRemaining(1);
    setScanAnimTarget(1);
    setLowLevelTracked(false);
  }

  function handleMorningRefill() {
    setMorningResetClosing(true);
    window.setTimeout(() => {
      const todayKey = getTodayKey();
      const wakeMins = clamp(Math.round(state.wakeMins), 0, 1439);
      setState((s) => ({
        ...s,
        dayKey: dayKeyBySleep(new Date(), s.sleepMins),
        completedBottles: 0,
        remaining: 1,
        carryML: 0,
        extraML: 0,
        history: [],
        celebrate: null,
      }));
      setPendingRemaining(1);
      setDisplayRemaining(1);
      setScanAnimTarget(1);
      setLastMorningResetToken(`${todayKey}-${wakeMins}`);
      setShowMorningReset(false);
      setMorningResetClosing(false);
    }, 220);
  }

  function applyRecommendation() {
    const rec = recommendGoalML({ weightKg: Number(state.weightKg), activity: state.activity, warm: state.warm });
    setState((s) => ({ ...s, goalML: rec.ml }));
  }

  const rec = useMemo(() => {
    if (!state.weightKg || state.weightKg < 30) return null;
    return recommendGoalML({ weightKg: Number(state.weightKg), activity: state.activity, warm: state.warm });
  }, [state.weightKg, state.activity, state.warm]);

  if (!state.hasOnboarded && state.step === 0) {
    return (
      <>
        <WelcomeSplash instant={!!state.splashSeen} onContinue={() => setState((s) => ({ ...s, splashSeen: true, step: 1 }))} />
        {showMorningReset && <MorningResetModal onConfirm={handleMorningRefill} isClosing={morningResetClosing} />}
      </>
    );
  }

  if (state.hasOnboarded && state.step === 0) {
    return (
      <div className="min-h-screen bg-[#0B0B0F] pb-[110px] text-white select-none">
        <style>{`
          @keyframes fadeOutLineUi { from { opacity: 1; } to { opacity: 0; } }
        `}</style>
        {showQuickAdd && <QuickAddSheet onClose={() => setShowQuickAdd(false)} onAdd={addExtra} />}

        {state.celebrate && (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/70 backdrop-blur" />
            <div className="absolute inset-0 flex items-center justify-center px-5">
              <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#121218]/95 p-6 shadow-[0_20px_60px_rgba(0,0,0,.55)]">
                <div className="text-2xl font-extrabold">{state.celebrate.type === "goal" ? "Well done" : "Good job"}</div>

                <div className="mt-2 text-white/75">
                  {state.celebrate.type === "goal" ? "You hit your water intake for the day." : `You’ve drunk ${state.celebrate.pct}% of your water intake today.`}
                </div>

                <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs text-white/60">Today</div>
                  <div className="mt-1 text-xl font-extrabold tabular-nums">
                    {state.celebrate.consumedML} / {state.goalML} ml
                  </div>
                  <div className="mt-1 text-sm text-white/70">{state.celebrate.type === "goal" ? "100% complete ✅" : `${state.celebrate.pct}% complete`}</div>
                </div>

                <button
                  onClick={() => {
                    setState((s) => ({ ...s, celebrate: null }));
                    if (state.celebrate?.type === "bottle") {
                      setLowLevelTracked(false);
                    }
                  }}
                  className={
                    "mt-6 w-full px-5 py-4 rounded-2xl font-extrabold active:scale-[0.99] " +
                    (state.celebrate.type === "goal" ? "bg-green-500 text-black" : "bg-green-500 text-white")
                  }
                >
                  {state.celebrate.type === "goal" ? "Done" : "Refill my bottle"}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="px-5 pt-7 pb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 text-center">
              <div className="text-5xl font-extrabold leading-tight">
                <span className="text-[#0A84FF]">{bottlesLeftText}</span> {bottleWord} till goal
              </div>
              <div className="relative mt-3 text-2xl font-extrabold leading-tight">
                <span
                  className={
                    "block transition-all duration-300 ease-out " +
                    (showLevelUpdated ? "opacity-0 translate-y-1 scale-[0.99]" : "opacity-100 translate-y-0 scale-100 text-white")
                  }
                >
                  How much water is in your bottle?
                </span>
                <span
                  className={
                    "absolute inset-0 block transition-all duration-300 ease-out text-green-500 " +
                    (showLevelUpdated ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-1 scale-[0.99]")
                  }
                >
                  Water level updated
                </span>
              </div>
              <div className="mt-2 text-xs text-white/45">
                {(() => {
                  const now = new Date();
                  const timeStr = formatClock12h(now);
                  const goalBottles = state.bottleML > 0 ? state.goalML / state.bottleML : 0;
                  const expectedMl = expectedMlAt(state.goalML, now, state.wakeMins, state.sleepMins);
                  const expectedBottles = state.bottleML > 0 ? expectedMl / state.bottleML : 0;
                  return `By ${timeStr}, the app expects you to have drunk: ~${format1(expectedBottles)} bottles, out of your ${format1(goalBottles)} bottles/day goal.`;
                })()}
              </div>
            </div>

          </div>
        </div>

        <div className="px-5">
          <div className="flex items-center justify-center gap-6">
            <div className="relative h-[300px]" style={{ marginLeft: "-3px" }}>
              {showFlag && (
                <div
                  className={
                  "absolute left-[3px] text-2xl font-extrabold leading-none " +
                    (pacingStatus === "behind" ? "text-[#FF453A]" : "text-green-400")
                  }
                style={{
                  top: `${flagTop}px`,
                  animation: pacingStatus === "ahead" ? "fadeOutLineUi 0.6s ease forwards" : undefined,
                }}
              >
                  🏁
                </div>
              )}
              <BottleVector
                shape={state.shape}
                level={displayRemaining}
                className={shapeClasses(state.shape)}
                targetLevel={targetLineRemainingFraction}
                targetStatus={pacingStatus}
              />
            </div>

            <div className="flex flex-col items-center gap-3">
              <div className="flex flex-col items-start gap-3">
                <div className="w-16 text-center text-lg font-extrabold tabular-nums">{remainingPct}%</div>

                <div className="grid grid-cols-[4rem,3rem] gap-3 items-start">
                  <div
                    ref={dialRef}
                    onPointerDown={onDialPointerDown}
                    className="relative h-[260px] w-16 rounded-2xl border border-white/15 bg-white/6 overflow-hidden select-none touch-none"
                    role="slider"
                    aria-label="Bottle level"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={remainingPct}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      const step = state.snap === "tenths" ? 0.1 : state.snap === "free" ? 0.01 : 0.25;
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setPendingRemaining((p) => Math.min(snapValue(p + step, state.snap), state.remaining));
                      }
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setPendingRemaining((p) => snapValue(p - step, state.snap));
                      }
                    }}
                  >
                    <div className="absolute inset-y-2 left-[18px] right-[18px] rounded-xl bg-white/8" />
                    <div className="absolute inset-y-2 left-0 right-0 flex flex-col justify-between pointer-events-none">
                      {Array.from({ length: 21 }).map((_, i) => {
                        const major = i % 5 === 0;
                        return (
                          <div key={i} className="flex justify-center">
                            <span className={`block h-px ${major ? "w-8 bg-white/45" : "w-[22px] bg-white/25"}`} />
                          </div>
                        );
                      })}
                    </div>
                    <div
                      className="absolute left-1/2 h-[6px] w-[38px] -translate-x-1/2 rounded-full bg-white/90"
                      style={{ top: `${dialThumbTop}px` }}
                    />
                  </div>

                  <button
                    onClick={() => setShowQuickAdd(true)}
                    className="col-start-2 self-center h-12 w-12 rounded-2xl border border-white/10 bg-white/6 active:scale-[0.99] flex items-center justify-center"
                    aria-label="Add water"
                    title="Add water"
                  >
                    <DropletPlugIcon className="h-8 w-8" />
                  </button>

                  <button
                    onClick={undo}
                    disabled={!state.history || state.history.length === 0}
                    className="col-start-1 w-16 px-0 py-2 rounded-2xl border border-white/15 bg-white/8 font-extrabold text-center disabled:opacity-40"
                  >
                    Undo
                  </button>

                  {state.extraML > 0 && (
                    <div className="col-start-1 col-span-2 justify-self-start text-left text-[12px] font-extrabold tabular-nums text-white/55 whitespace-nowrap">
                      Extra today: <span className="text-[#0A84FF]">+{Math.round(state.extraML)}ml</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex flex-col items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onScanFileChange}
            />
            <button
              onClick={startScanPick}
              disabled={scanState === "scanning" || scanCooldownLeftMs > 0}
              className={
                "w-full max-w-md px-5 py-3 rounded-2xl font-extrabold active:scale-[0.99] transition " +
                (scanState === "scanning" ? "bg-green-500/50 text-black/70" : "bg-green-500 text-black")
              }
            >
              {scanState === "scanning"
                ? "Scanning..."
                : scanCooldownLeftMs > 0
                  ? `Try again in ${Math.max(1, Math.ceil(scanCooldownLeftMs / 1000))}s`
                  : "Scan Bottle"}
            </button>
            {scanState === "scanning" && (
              <button onClick={cancelScan} className="text-xs font-semibold text-white/70 hover:text-white">
                Cancel
              </button>
            )}
            {scanMessage && scanState !== "scanning" && <div className="text-xs text-white/70">{scanMessage}</div>}
            {scanError && <div className="text-xs text-[#FF453A]">{scanError}</div>}
          </div>

          <div className="mt-8">
            <div className="flex items-end justify-between">
              <div className="text-sm text-white/70">Daily progress • Bottle {state.bottleML} ml</div>
              <div className="text-sm font-extrabold tabular-nums">
                {totalConsumed} / {state.goalML} ml
              </div>
            </div>
            <div className="mt-2 h-3 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full rounded-full bg-[#0A84FF]" style={{ width: `${Math.round(progressFrac * 100)}%`, transition: "width .15s ease" }} />
            </div>
            <div className="mt-2 text-xs text-white/55">Tip: scroll down to 0% when you finish the bottle — it will auto-start the next one.</div>
            <div className="mt-1 text-xs italic text-[#FF453A]/70">Artwork will be updated in the next build.</div>
            <div className="mt-2 text-xs text-white/50">
              Resets in <span className="font-extrabold tabular-nums text-white/70">{formatCountdown(resetMs)}</span>
            </div>
            <div className="mt-1 text-xs text-white/50">
              Yesterday:{" "}
                {(() => {
                  const y = (state.dailyLog || {})[prevDayKeyBySleep(new Date(), state.sleepMins)];
                  if (!y) return <span className="text-white/40">—</span>;
                  const pct = y.goalML > 0 ? Math.round((y.consumedML / y.goalML) * 100) : 0;
                  return (
                  <span className="font-extrabold tabular-nums text-white/70">
                    {y.consumedML} / {y.goalML} ml ({pct}%)
                  </span>
                );
              })()}
            </div>
          </div>
        </div>
        <BottomNavBar
          onOpenSettings={() => setState((s) => ({ ...s, step: 6 }))}
          onOpenAnalytics={() => {}}
          onTrack={() => {
            commitScanToDailyProgress(pendingRemaining);
            if (isLowWater) setLowLevelTracked(true);
            if (levelUpdatedTimeoutRef.current) window.clearTimeout(levelUpdatedTimeoutRef.current);
            setShowLevelUpdated(true);
            levelUpdatedTimeoutRef.current = window.setTimeout(() => {
              setShowLevelUpdated(false);
              levelUpdatedTimeoutRef.current = null;
            }, 5000);
          }}
          isTrackDisabled={Math.abs(pendingRemaining - state.remaining) < 1e-6}
          isRefill={isLowWater && lowLevelTracked}
          onRefill={handleRefill}
        />
        {showMorningReset && <MorningResetModal onConfirm={handleMorningRefill} isClosing={morningResetClosing} />}
      </div>
    );
  }

  // Onboarding container
  return (
    <div className="min-h-screen bg-[#0B0B0F] text-white select-none">
      <div className="max-w-xl mx-auto min-h-screen px-5 pt-6 pb-10 flex flex-col justify-center">
        {state.step === 1 && (
          <OnboardingIntro1
            onContinue={() => setStep(2)}
            onSkip={() => {
              setBottleSizeFlowSource("onboarding");
              setStep(5);
            }}
          />
        )}
        {state.step === 2 && (
          <OnboardingIntro2
            onContinue={() => setStep(3)}
            onSkip={() => {
              setBottleSizeFlowSource("onboarding");
              setStep(5);
            }}
          />
        )}
        {state.step === 3 && (
          <OnboardingIntro3
            onContinue={() => setStep(4)}
            onSkip={() => {
              setBottleSizeFlowSource("onboarding");
              setStep(5);
            }}
          />
        )}
        {state.step === 4 && (
          <OnboardingIntro4
            onContinue={() => {
              setBottleSizeFlowSource("onboarding");
              setState((s) => ({
                ...s,
                hasOnboarded: false,
                step: 5,
              }));
            }}
            onSkip={() => {
              setBottleSizeFlowSource("onboarding");
              setState((s) => ({
                ...s,
                hasOnboarded: false,
                step: 5,
              }));
            }}
            onStartOver={resetAll}
          />
        )}
        {state.step === 5 && (
          <div>
            <style>{`
              @keyframes selIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
              @keyframes selInSoft { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }
              @keyframes floatSel { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
              @keyframes capIn { from { opacity: 0; transform: translateY(10px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
            `}</style>

            <div className="flex items-start justify-between gap-3" style={{ animation: "selIn .55s ease-out .04s both" }}>
              <div className="text-2xl font-extrabold">Get started</div>
              <button onClick={resetAll} className="text-[16px] font-medium text-[#FF453A]">
                Start over
              </button>
            </div>

            <div className="mt-2 text-white/70" style={{ animation: "selIn .55s ease-out .10s both" }}>
              Set your bottle size to begin tracking.
            </div>

            <div className="mt-6 rounded-3xl border border-white/10 bg-white/6 p-5" style={{ animation: "selInSoft .6s cubic-bezier(0.2,0,0,1) .18s both" }}>
              <div className="flex flex-col items-center">
                <div style={{ animation: "floatSel 3.2s ease-in-out .6s infinite" }} className="mt-2">
                  <BottleVector shape="standard" level={1} className="w-[180px] [filter:drop-shadow(0_22px_55px_rgba(0,0,0,0.55))]" />
                </div>

              </div>
            </div>

            <div className="mt-5 rounded-3xl border border-white/10 bg-white/6 p-5" style={{ animation: "capIn .5s cubic-bezier(0.2,0,0,1) both" }}>
              <div className="text-xs text-white/65">How much can the bottle hold? (ml)</div>
              <input
                className="mt-1 w-full px-4 py-3 rounded-2xl border border-white/15 bg-white/5 font-extrabold outline-none"
                type="number"
                min={100}
                max={2000}
                step={50}
                value={state.bottleML || ""}
                onChange={(e) => {
                  const raw = (e.target as HTMLInputElement).value;
                  setState((s) => ({ ...s, bottleML: raw === "" ? 0 : Number(raw) }));
                }}
              />
              <div className="mt-2 text-xs text-white/55">Common sizes: 500, 750, 1000 ml</div>
            </div>

            <div className="mt-6 flex gap-2" style={{ animation: "selIn .55s ease-out .32s both" }}>
              <button
                onClick={() => setStep(4)}
                className="flex-1 px-4 py-4 rounded-2xl border border-white/15 bg-white/8 font-extrabold"
              >
                Back
              </button>

              <button
                onClick={() => {
                  switchBottleKeepingConsumed({ shape: "standard" });
                  setStep(bottleSizeFlowSource === "settings" ? 6 : 9);
                }}
                className="flex-1 px-4 py-4 rounded-2xl bg-[#0A84FF] font-extrabold"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {state.step === 9 && (
          <div className="text-center">
            <style>{`
              @keyframes floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
              @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
            `}</style>

            <div className="mx-auto mb-6 flex h-[360px] items-center justify-center">
              <div className="relative">
                <div className="pointer-events-none absolute -inset-24 rounded-full bg-[radial-gradient(circle_at_50%_45%,rgba(34,197,94,0.16),rgba(0,0,0,0)_68%)] blur-3xl opacity-60 mix-blend-screen" />
                <div className="pointer-events-none absolute -inset-28 rounded-full bg-[radial-gradient(circle_at_50%_60%,rgba(34,197,94,0.08),rgba(0,0,0,0)_72%)] blur-3xl opacity-55" />

                <div style={{ animation: "floaty 2.8s ease-in-out infinite" }} className="w-[160px]">
                  <SplashBottle
                    animate
                    className="h-[320px] w-[160px] [filter:drop-shadow(0_22px_55px_rgba(34,197,94,0.16))]"
                  />
                </div>
              </div>
            </div>

            <div style={{ animation: "fadeUp .65s ease-out both" }} className="text-3xl font-extrabold">
              Take a photo of your bottle
            </div>
            <div className="mt-3 text-white/70">
              We’ll automatically track{" "}
              <span className="text-[#0A84FF]">how much water you have left</span>
            </div>

            <input
              ref={onboardingFileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onOnboardingFileChange}
            />

            <button
              onClick={onOnboardingPick}
              disabled={onboardingScanState === "scanning"}
              className={
                "mt-8 w-full max-w-md px-5 py-4 rounded-2xl font-extrabold active:scale-[0.99] transition " +
                (onboardingScanState === "scanning" ? "bg-green-500/60 text-white/80" : "bg-green-500 text-white")
              }
            >
              {onboardingScanState === "scanning" ? "Scanning..." : "Scan my bottle"}
            </button>

            {onboardingScanError && <div className="mt-3 text-xs text-[#FF453A]">{onboardingScanError}</div>}
          </div>
        )}

        {state.step === 10 && (() => {
          const scanFraction = clamp(
            state.onboardingScanFraction ?? (state.onboardingScanPercent ?? 0) / 100,
            0,
            1
          );
          const scanPercent = Math.round(state.onboardingScanPercent ?? scanFraction * 100);
          const drankMl = Math.round((1 - scanFraction) * state.bottleML);

          return (
            <div className="text-center">
              <style>{`
                @keyframes floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
                @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
              `}</style>

              <div className="mx-auto mb-6 flex h-[360px] items-center justify-center">
                <ScanResultBottle fraction={scanFraction} />
              </div>

              <div style={{ animation: "fadeUp .65s ease-out both" }} className="text-3xl font-extrabold">
                Scan complete
              </div>
              <div className="mt-2 text-white/70">Your bottle is {scanPercent}% full</div>

              <div className="mt-4 h-3 rounded-full bg-white/10 overflow-hidden max-w-md mx-auto">
                <div className="h-full rounded-full bg-[#0A84FF]" style={{ width: `${Math.round(scanFraction * 100)}%` }} />
              </div>
              <div className="mt-2 text-sm font-extrabold text-[#0A84FF]">+{drankMl} ml drank</div>

              <button
                onClick={() => setStep(11)}
                className="mt-8 w-full max-w-md px-5 py-4 rounded-2xl bg-[#0A84FF] font-extrabold active:scale-[0.99]"
              >
                Continue
              </button>
            </div>
          );
        })()}

        {state.step === 11 && (
          <div>
            <style>{`
              @keyframes setupIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
              @keyframes setupInSoft { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
            `}</style>

            <div className="text-2xl font-extrabold" style={{ animation: "setupIn .55s ease-out .04s both" }}>
              Set your hydration window
            </div>
            <div className="mt-2 text-white/70" style={{ animation: "setupIn .55s ease-out .10s both" }}>
              Rough estimate is fine — we’ll pace your goal between wake and sleep.
            </div>

            <div
              className="mt-6 rounded-3xl border border-white/10 bg-white/6 p-5"
              style={{ animation: "setupInSoft .6s cubic-bezier(0.2,0,0,1) .18s both" }}
            >
              <div className="text-xs text-white/65">When do you usually wake up?</div>
              <div className="mt-2 flex items-center gap-3">
                <input
                  className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                  type="text"
                  inputMode="numeric"
                  pattern="\\d*"
                  value={state.wakeHour || ""}
                  onChange={(e) => {
                    const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                    if (raw.length > 2) return;
                    setState((s) => ({ ...s, wakeHour: raw === "" ? 0 : Number(raw) }));
                  }}
                  onBlur={() => {
                    const h = normalizeHourInput(String(state.wakeHour || 0));
                    setState((s) => ({ ...s, wakeHour: h }));
                  }}
                />
                <span className="text-white/40">:</span>
                <input
                  className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                  type="text"
                  inputMode="numeric"
                  pattern="\\d*"
                  value={state.wakeMinute || state.wakeMinute === 0 ? String(state.wakeMinute).padStart(2, "0") : ""}
                  onChange={(e) => {
                    const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                    if (raw.length > 2) return;
                    setState((s) => ({ ...s, wakeMinute: raw === "" ? 0 : Number(raw) }));
                  }}
                  onBlur={() => {
                    const m = normalizeMinuteInput(String(state.wakeMinute || 0));
                    setState((s) => ({ ...s, wakeMinute: m }));
                  }}
                />
                <div className="ml-2 flex gap-2">
                  {(["AM", "PM"] as const).map((p) => {
                    const active = state.wakeMeridiem === p;
                    return (
                      <button
                        key={p}
                        onClick={() => setState((s) => ({ ...s, wakeMeridiem: toMeridiem(p) }))}
                        className={
                          "px-3 py-2 rounded-xl border text-xs font-extrabold " +
                          (active ? "border-[#0A84FF]/60 bg-[#0A84FF]/20 text-white" : "border-white/15 bg-white/5 text-white/70")
                        }
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-1 text-[11px] text-white/45">Doesn’t have to be exact.</div>

              <div className="mt-5 text-xs text-white/65">When do you usually go to sleep?</div>
              <div className="mt-2 flex items-center gap-3">
                <input
                  className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                  type="text"
                  inputMode="numeric"
                  pattern="\\d*"
                  value={state.sleepHour || ""}
                  onChange={(e) => {
                    const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                    if (raw.length > 2) return;
                    setState((s) => ({ ...s, sleepHour: raw === "" ? 0 : Number(raw) }));
                  }}
                  onBlur={() => {
                    const h = normalizeHourInput(String(state.sleepHour || 0));
                    setState((s) => ({ ...s, sleepHour: h }));
                  }}
                />
                <span className="text-white/40">:</span>
                <input
                  className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                  type="text"
                  inputMode="numeric"
                  pattern="\\d*"
                  value={state.sleepMinute || state.sleepMinute === 0 ? String(state.sleepMinute).padStart(2, "0") : ""}
                  onChange={(e) => {
                    const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                    if (raw.length > 2) return;
                    setState((s) => ({ ...s, sleepMinute: raw === "" ? 0 : Number(raw) }));
                  }}
                  onBlur={() => {
                    const m = normalizeMinuteInput(String(state.sleepMinute || 0));
                    setState((s) => ({ ...s, sleepMinute: m }));
                  }}
                />
                <div className="ml-2 flex gap-2">
                  {(["AM", "PM"] as const).map((p) => {
                    const active = state.sleepMeridiem === p;
                    return (
                      <button
                        key={p}
                        onClick={() => setState((s) => ({ ...s, sleepMeridiem: toMeridiem(p) }))}
                        className={
                          "px-3 py-2 rounded-xl border text-xs font-extrabold " +
                          (active ? "border-[#0A84FF]/60 bg-[#0A84FF]/20 text-white" : "border-white/15 bg-white/5 text-white/70")
                        }
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="mt-1 text-[11px] text-white/45">Doesn’t have to be exact.</div>
            </div>

            <button
              onClick={() => {
                const { startMins, endMins } = hydrationWindowFromInputs(
                  state.wakeHour,
                  state.wakeMinute,
                  state.wakeMeridiem,
                  state.sleepHour,
                  state.sleepMinute,
                  state.sleepMeridiem
                );
                setState((s) => ({
                  ...s,
                  wakeMins: startMins,
                  sleepMins: endMins,
                }));
                setStep(7);
              }}
              className="mt-6 w-full px-4 py-4 rounded-2xl bg-[#0A84FF] text-white font-extrabold active:scale-[0.99]"
            >
              Continue
            </button>
          </div>
        )}

        {state.step === 6 && (
          <div>
            <style>{`
              @keyframes setupIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
              @keyframes setupInSoft { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
            `}</style>

            <div className="flex items-start justify-between gap-3" style={{ animation: "setupIn .55s ease-out .04s both" }}>
              <div className="text-2xl font-extrabold">Your bottle</div>
              <button
                onClick={() =>
                  setState((s) => ({
                    ...s,
                    hasOnboarded: true,
                    step: 0,
                  }))
                }
                className="h-10 w-10 rounded-2xl border border-white/12 bg-white/8 active:bg-white/12 flex items-center justify-center"
                aria-label="Close"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-2 text-white/70" style={{ animation: "setupIn .55s ease-out .10s both" }}>
              So you can log with one quick scroll.
            </div>

            <div
              className="mt-6 rounded-3xl border border-white/10 bg-white/6 p-5"
              style={{ animation: "setupInSoft .6s cubic-bezier(0.2,0,0,1) .18s both" }}
            >
              <div className="text-xs text-white/65">Bottle</div>

              <div className="mt-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-4 flex items-center justify-between">
                <div>
                  <div className="font-extrabold">Tall / Slim</div>
                  <div className="mt-1 text-xs text-white/60">
                    {state.bottleML} ml • {state.shape === "tumbler" ? "Tumbler" : "Standard"}
                  </div>
                </div>
                <div className="text-xs font-extrabold text-white/45">Selected</div>
              </div>

              <button
                onClick={() => {
                  setBottleSizeFlowSource("settings");
                  setStep(5);
                }}
                className="mt-4 w-full px-4 py-4 rounded-2xl bg-[#FFD60A] text-black font-extrabold active:scale-[0.99]"
              >
                Change water bottle
              </button>
            </div>

            <div
              className="mt-5 rounded-3xl border border-white/10 bg-white/6 p-5"
              style={{ animation: "setupInSoft .6s cubic-bezier(0.2,0,0,1) .22s both" }}
            >
              <div className="text-lg font-extrabold">Hydration window</div>
              <div className="mt-1 text-xs text-white/60">Provide a rough estimate — this helps pace your goal through the day.</div>

              <div className="mt-4">
                <div className="text-xs text-white/65">What time do you usually wake up?</div>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                    type="text"
                    inputMode="numeric"
                    pattern="\\d*"
                    value={wakeHourInput}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                      if (raw.length > 2) return;
                      setWakeHourInput(raw);
                    }}
                    onBlur={() => {
                      const h = normalizeHourInput(wakeHourInput);
                      const m = normalizeMinuteInput(wakeMinInput);
                      setState((s) => ({
                        ...s,
                        wakeMins: toMinutes(h, m, timeParts(s.wakeMins).ampm),
                      }));
                      setWakeHourInput(String(h));
                      setWakeMinInput(String(m).padStart(2, "0"));
                    }}
                  />
                  <span className="text-white/40">:</span>
                  <input
                    className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                    type="text"
                    inputMode="numeric"
                    pattern="\\d*"
                    value={wakeMinInput}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                      if (raw.length > 2) return;
                      setWakeMinInput(raw);
                    }}
                    onBlur={() => {
                      const h = normalizeHourInput(wakeHourInput);
                      const m = normalizeMinuteInput(wakeMinInput);
                      setState((s) => ({
                        ...s,
                        wakeMins: toMinutes(h, m, timeParts(s.wakeMins).ampm),
                      }));
                      setWakeHourInput(String(h));
                      setWakeMinInput(String(m).padStart(2, "0"));
                    }}
                  />
                  <div className="ml-2 flex gap-2">
                    {(["AM", "PM"] as const).map((p) => {
                      const active = timeParts(state.wakeMins).ampm === p;
                      return (
                        <button
                          key={p}
                          onClick={() =>
                            setState((s) => ({
                              ...s,
                              wakeMins: toMinutes(timeParts(s.wakeMins).h12, timeParts(s.wakeMins).min, toMeridiem(p)),
                            }))
                          }
                          className={
                            "px-3 py-2 rounded-xl border text-xs font-extrabold " +
                            (active ? "border-[#0A84FF]/60 bg-[#0A84FF]/20 text-white" : "border-white/15 bg-white/5 text-white/70")
                          }
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-white/45">Doesn’t have to be exact.</div>
              </div>

              <div className="mt-4">
                <div className="text-xs text-white/65">What time do you usually sleep?</div>
                <div className="mt-2 flex items-center gap-3">
                  <input
                    className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                    type="text"
                    inputMode="numeric"
                    pattern="\\d*"
                    value={sleepHourInput}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                      if (raw.length > 2) return;
                      setSleepHourInput(raw);
                    }}
                    onBlur={() => {
                      const h = normalizeHourInput(sleepHourInput);
                      const m = normalizeMinuteInput(sleepMinInput);
                      setState((s) => {
                        const base = toMinutes(h, m, timeParts(s.sleepMins).ampm);
                        return { ...s, sleepMins: base <= s.wakeMins ? base + 1440 : base };
                      });
                      setSleepHourInput(String(h));
                      setSleepMinInput(String(m).padStart(2, "0"));
                    }}
                  />
                  <span className="text-white/40">:</span>
                  <input
                    className="w-16 rounded-xl border border-white/15 bg-white/5 px-2 py-2 text-center font-extrabold outline-none"
                    type="text"
                    inputMode="numeric"
                    pattern="\\d*"
                    value={sleepMinInput}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value.replace(/\\D/g, "");
                      if (raw.length > 2) return;
                      setSleepMinInput(raw);
                    }}
                    onBlur={() => {
                      const h = normalizeHourInput(sleepHourInput);
                      const m = normalizeMinuteInput(sleepMinInput);
                      setState((s) => {
                        const base = toMinutes(h, m, timeParts(s.sleepMins).ampm);
                        return { ...s, sleepMins: base <= s.wakeMins ? base + 1440 : base };
                      });
                      setSleepHourInput(String(h));
                      setSleepMinInput(String(m).padStart(2, "0"));
                    }}
                  />
                  <div className="ml-2 flex gap-2">
                    {(["AM", "PM"] as const).map((p) => {
                      const active = timeParts(state.sleepMins).ampm === p;
                      return (
                        <button
                          key={p}
                          onClick={() =>
                            setState((s) => {
                              const base = toMinutes(timeParts(s.sleepMins).h12, timeParts(s.sleepMins).min, toMeridiem(p));
                              return { ...s, sleepMins: base <= s.wakeMins ? base + 1440 : base };
                            })
                          }
                          className={
                            "px-3 py-2 rounded-xl border text-xs font-extrabold " +
                            (active ? "border-[#0A84FF]/60 bg-[#0A84FF]/20 text-white" : "border-white/15 bg-white/5 text-white/70")
                          }
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                  {timeParts(state.sleepMins).dayOffset === 1 && <div className="text-[11px] text-white/45">(+1)</div>}
                </div>
                <div className="mt-1 text-[11px] text-white/45">Doesn’t have to be exact.</div>
              </div>
            </div>

            <div className="mt-4" style={{ animation: "setupIn .55s ease-out .26s both" }}>
              <button
                onClick={() => setStep(7)}
                className="w-full px-4 py-3 rounded-2xl border border-[#0A84FF]/35 bg-[#0A84FF]/10 text-[#85C0E7] font-extrabold active:scale-[0.99]"
              >
                Change water target
              </button>
            </div>
          </div>
        )}

        {state.step === 7 && (
          <div className="pt-6">
            <style>{`
              @keyframes setupIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
              @keyframes setupInSoft { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
            `}</style>

            <div className="text-2xl font-extrabold" style={{ animation: "setupIn .55s ease-out .04s both" }}>
              Your daily water target
            </div>
            <div className="mt-2 text-white/70" style={{ animation: "setupIn .55s ease-out .10s both" }}>
              Answer a few questions — you can edit later.
            </div>

            <div
              className="mt-6 rounded-3xl border border-white/10 bg-white/6 p-5"
              style={{ animation: "setupInSoft .6s cubic-bezier(0.2,0,0,1) .18s both" }}
            >
              <label className="block">
                <div className="text-xs text-white/65">Weight (kg)</div>
                <input
                  className="mt-1 w-full px-4 py-3 rounded-2xl border border-white/15 bg-white/5 font-extrabold outline-none"
                  type="number"
                  min={30}
                  max={200}
                  step={0.5}
                  value={state.weightKg || ""}
                  onChange={(e) => {
                    const raw = (e.target as HTMLInputElement).value;
                    setState((s) => ({ ...s, weightKg: raw === "" ? 0 : Number(raw) }));
                  }}
                />
              </label>

              <div className="mt-4">
                <div className="text-xs text-white/65">Activity</div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {([
                    { k: "low" as const, t: "Low" },
                    { k: "moderate" as const, t: "Moderate" },
                    { k: "high" as const, t: "High" },
                  ] as const).map((x) => (
                    <button
                      key={x.k}
                      onClick={() => setState((s) => ({ ...s, activity: x.k }))}
                      className={
                        "px-3 py-3 rounded-2xl border font-extrabold " +
                        (state.activity === x.k ? "border-[#0A84FF]/60 bg-[#0A84FF]/20" : "border-white/15 bg-white/5")
                      }
                    >
                      {x.t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                <div>
                  <div className="font-extrabold">Warm climate / sweaty day</div>
                  <div className="text-xs text-white/60">Adds a small buffer to the estimate</div>
                </div>
                <button
                  onClick={() => setState((s) => ({ ...s, warm: !s.warm }))}
                  className={"h-8 w-14 rounded-full p-1 transition " + (state.warm ? "bg-[#0A84FF]" : "bg-white/15")}
                  aria-label="Toggle warm climate"
                >
                  <div className={"h-6 w-6 rounded-full bg-white transition " + (state.warm ? "translate-x-6" : "translate-x-0")} />
                </button>
              </div>

              <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="text-xs text-white/65">Recommended</div>
                <div className="mt-1 text-xl font-extrabold tabular-nums">{rec ? `${rec.ml} ml` : "—"}</div>
                <div className="mt-1 text-sm text-white/70">{rec ? `Range: ${rec.low}–${rec.high} ml` : "Enter your weight to calculate."}</div>

                <button
                  onClick={applyRecommendation}
                  disabled={!rec}
                  className="mt-4 w-full px-4 py-3 rounded-2xl border border-white/15 bg-white/8 font-extrabold disabled:opacity-40"
                >
                  Use recommendation
                </button>

                <div className="mt-3">
                  <div className="text-xs text-white/65">Or set your own goal (ml)</div>
                  <input
                    className="mt-1 w-full px-4 py-3 rounded-2xl border border-white/15 bg-white/5 font-extrabold outline-none"
                    type="number"
                    min={500}
                    max={6000}
                    step={50}
                    value={state.goalML || ""}
                    onChange={(e) => {
                      const raw = (e.target as HTMLInputElement).value;
                      setState((s) => ({ ...s, goalML: raw === "" ? 0 : Number(raw) }));
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-2" style={{ animation: "setupIn .55s ease-out .30s both" }}>
              <button onClick={() => setStep(5)} className="flex-1 px-4 py-4 rounded-2xl border border-white/15 bg-white/8 font-extrabold">
                Back
              </button>
              <button onClick={() => setStep(8)} className="flex-1 px-4 py-4 rounded-2xl bg-[#0A84FF] font-extrabold">
                Next
              </button>
            </div>
          </div>
        )}

        {state.step === 8 && (
          <div>
            <div className="text-2xl font-extrabold">You’re set</div>
            <div className="mt-2 text-white/70">Here’s your daily target and bottle setup.</div>

            <div className="mt-6 rounded-3xl border border-white/10 bg-white/6 p-5">
              <div className="text-xs text-white/65">Daily goal</div>
              <div className="mt-1 text-3xl font-extrabold tabular-nums">{state.goalML} ml</div>

              <div className="mt-5 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs text-white/65">Bottle size</div>
                  <div className="mt-1 text-xl font-extrabold tabular-nums">{state.bottleML} ml</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <div className="text-xs text-white/65">Bottles / day</div>
                  <div className="mt-1 text-xl font-extrabold tabular-nums">{bottlesPerDayText}</div>
                </div>
              </div>

              <div className="mt-5 text-xs text-white/55">Tip: you won’t log sips. Just scroll the bottle level down as you drink, then tap Track.</div>
            </div>

            <div className="mt-6 flex gap-2">
              <button onClick={() => setStep(7)} className="flex-1 px-4 py-4 rounded-2xl border border-white/15 bg-white/8 font-extrabold">
                Back
              </button>
              <button
                onClick={() => {
                  setState((s) => ({
                    ...s,
                    hasOnboarded: true,
                    step: 0,
                    dayKey: dayKeyBySleep(new Date(), s.sleepMins),
                    completedBottles: 0,
                    remaining: 1,
                    carryML: 0,
                    extraML: 0,
                    history: [],
                    celebrate: null,
                  }));
                }}
                className="flex-1 px-4 py-4 rounded-2xl bg-[#0A84FF] font-extrabold"
              >
                Start tracking
              </button>
            </div>
          </div>
        )}
      </div>
      {showMorningReset && <MorningResetModal onConfirm={handleMorningRefill} isClosing={morningResetClosing} />}
    </div>
  );
}
