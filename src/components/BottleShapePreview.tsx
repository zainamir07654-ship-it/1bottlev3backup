import { useId } from "react";

function extractFirstPathD(svgText: string): string | null {
  const match = svgText.match(/<path[^>]*\sd=(["'])([^"']+)\1/i);
  return match ? match[2] : null;
}

function extractViewBox(svgText: string): string {
  const match = svgText.match(/viewBox="([^"]+)"/);
  return match ? match[1] : "0 0 236 768";
}

function extractSvgInner(svgText: string): string {
  const start = svgText.indexOf(">");
  const end = svgText.lastIndexOf("</svg>");
  if (start === -1 || end === -1 || end <= start) return svgText;
  return svgText.slice(start + 1, end).trim();
}

export default function BottleShapePreview({
  outlineSvg,
  cavitySvg,
  waterPct = 70,
}: {
  outlineSvg: string;
  cavitySvg: string;
  waterPct?: number;
}) {
  const clipId = useId();
  const cavityD = extractFirstPathD(cavitySvg);
  const outlineViewBox = extractViewBox(outlineSvg);
  const [ovx, ovy, ovw, ovh] = outlineViewBox.split(/\s+/).map((n) => Number(n));
  const vbWidth = Number.isFinite(ovw) ? ovw : 236;
  const vbHeight = Number.isFinite(ovh) ? ovh : 768;
  const pct = Math.max(0, Math.min(100, waterPct));
  const waterHeight = (vbHeight * pct) / 100;
  const baseX = Number.isFinite(ovx) ? ovx : 0;
  const baseY = Number.isFinite(ovy) ? ovy : 0;
  const y = baseY + vbHeight - waterHeight;

  if (!cavityD) {
    return <div className="text-xs text-white/60">Invalid bottle SVG</div>;
  }

  const outlineInner = extractSvgInner(outlineSvg);
  return (
    <svg viewBox={outlineViewBox} preserveAspectRatio="xMidYMid meet" className="h-[260px] w-[120px]" aria-hidden="true">
      <defs>
        <clipPath id={`bottle-clip-${clipId}`}>
          <path d={cavityD} />
        </clipPath>
      </defs>
      <g clipPath={`url(#bottle-clip-${clipId})`}>
        <rect x={baseX} y={baseY} width={vbWidth} height={vbHeight} fill="rgba(255,255,255,0.04)" />
        <rect x={baseX} y={y} width={vbWidth} height={waterHeight} fill="rgba(10,132,255,0.65)" />
      </g>
      <g dangerouslySetInnerHTML={{ __html: outlineInner }} />
    </svg>
  );
}
