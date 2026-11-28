import { memo } from "react";
import type { RecycleBinInfo } from "../../lib/types";

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Wallsong's own bin, drawn with paper in it when it holds anything. */
export const RecycleTile = memo(function RecycleTile({ bin }: { bin: RecycleBinInfo | null }) {
  const full = (bin?.items ?? 0) > 0;
  const title = bin ? (full ? `Recycle Bin: ${bin.items} item${bin.items === 1 ? "" : "s"} (${sizeLabel(bin.bytes)})` : "Recycle Bin: empty") : "Recycle Bin";
  return (
    <div className={`dk-bin${full ? " full" : ""}`} title={title}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {full && (
          <g className="paper">
            <path d="M8.2 6.8 9.6 3.6l3.1 1.6-1.2 2.4z" />
            <path d="M12.4 6.9l1.9-3.4 2.6 1.9-1.6 2z" />
            <circle cx="11.6" cy="5.6" r="1.3" />
          </g>
        )}
        <path className="lid" d="M4.5 7.2h15v1.7h-15z" />
        <path className="body" d="M6 9.6h12l-1.1 10.6a1.6 1.6 0 0 1-1.6 1.4H8.7a1.6 1.6 0 0 1-1.6-1.4zM9.3 11.6v7.6h1.3v-7.6zm4.1 0v7.6h1.3v-7.6z" fillRule="evenodd" />
      </svg>
    </div>
  );
});
