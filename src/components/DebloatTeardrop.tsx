import { useEffect, useId, useState } from "react";
import teardropSvg from "../assets/debloat-teardrop.svg?raw";

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function extractViewBox(svgText: string) {
  const match = svgText.match(/viewBox=["']([^"']+)["']/i);
  return match ? match[1] : "0 0 356 527";
}

function extractFirstPathD(svgText: string) {
  const match = svgText.match(/<path[^>]*d=["']([^"']+)["'][^>]*>/i);
  return match ? match[1] : "";
}

export default function DebloatTeardrop({
  debloatElo,
  fillColor = "#0A84FF",
  animateKey = 0,
}: {
  debloatElo: number;
  fillColor?: string;
  animateKey?: number;
}) {
  const id = useId();
  const safe = Number.isFinite(debloatElo) ? debloatElo : 0;
  const fillFraction = clamp(safe / 100, 0, 1);
  const [displayFraction, setDisplayFraction] = useState(0);
  const viewBox = extractViewBox(teardropSvg);
  const d = extractFirstPathD(teardropSvg);
  const parts = viewBox.split(" ").map((v) => Number(v || 0));
  const vbW = parts[2] || 356;
  const vbH = parts[3] || 527;
  const fillH = Math.round(vbH * displayFraction);
  const y = vbH - fillH;

  useEffect(() => {
    setDisplayFraction(0);
    const id = requestAnimationFrame(() => setDisplayFraction(fillFraction));
    return () => cancelAnimationFrame(id);
  }, [fillFraction, animateKey]);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={viewBox} className="h-[210px] w-[160px] drop-shadow-[0_20px_40px_rgba(0,0,0,0.55)]" aria-hidden="true">
        <defs>
          <filter id={`glow-${id}`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id={`drop-${id}`}>
            <path d={d} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={vbW} height={vbH} fill="none" />
        <g filter={`url(#glow-${id})`}>
          <path d={d} fill="none" stroke={fillColor} strokeWidth="10" opacity="0.25">
            <animate attributeName="opacity" values="0.25;0.65;0.25" dur="3s" repeatCount="indefinite" />
          </path>
        </g>
        <g clipPath={`url(#drop-${id})`}>
          <rect
            x="0"
            y={y}
            width={vbW}
            height={fillH}
            fill={fillColor}
            opacity="0.9"
            style={{ transition: "y 600ms ease-out, height 600ms ease-out" }}
          />
        </g>
        <path d={d} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="8" />
      </svg>
    </div>
  );
}
