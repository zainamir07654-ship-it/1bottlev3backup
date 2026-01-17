import { useId } from "react";

type TierInfo = { label: string; fillFraction: number; fillColor: string };

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function getTierInfo(debloatElo: number): TierInfo {
  const safe = Number.isFinite(debloatElo) ? debloatElo : 0;
  const fillFraction = clamp(safe / 100, 0, 1);
  let label = "Bronze — Settling in";
  let fillColor = "#0A84FF";
  if (safe >= 80) {
    label = "Emerald — Second Nature";
    fillColor = "#22C55E";
  }
  else if (safe >= 60) label = "Platinum — Locked In";
  else if (safe >= 40) label = "Gold — In Rhythm";
  else if (safe >= 20) label = "Silver — Finding Flow";
  return { label, fillFraction, fillColor };
}

export default function DebloatTierDrop({ debloatElo }: { debloatElo: number }) {
  const id = useId();
  const { label, fillFraction, fillColor } = getTierInfo(debloatElo);
  const H = 120;
  const W = 90;
  const fillH = Math.round(H * fillFraction);
  const y = H - fillH;
  const path =
    "M45 2 C34 18 22 34 22 52 C22 80 33 104 45 118 C57 104 68 80 68 52 C68 34 56 18 45 2 Z";

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 90 120" className="h-[110px] w-[90px]" aria-hidden="true">
        <defs>
          <clipPath id={`drop-${id}`}>
            <path d={path} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={W} height={H} fill="none" />
        <g clipPath={`url(#drop-${id})`}>
          <rect x="0" y={y} width={W} height={fillH} fill={fillColor} opacity="0.9" />
        </g>
        <path d={path} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2.2" />
      </svg>
      <div className="mt-2 text-xs font-semibold text-white/70 text-center">{label}</div>
    </div>
  );
}
