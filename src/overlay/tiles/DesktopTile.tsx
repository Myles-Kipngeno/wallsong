import { memo } from "react";
import type { ShelfItem } from "../../lib/types";

/** A 3x3 peek at the first nine things on your desktop. Opens the Desktop panel. */
export const DesktopTile = memo(function DesktopTile({ items }: { items: ShelfItem[] | null }) {
  const first = (items ?? []).slice(0, 9);
  return (
    <div className="dk-desk" title={items ? `Desktop: ${items.length} items` : "Desktop"}>
      {Array.from({ length: 9 }, (_, i) => {
        const item = first[i];
        return item?.icon ? <img key={i} src={item.icon} alt="" draggable={false} /> : <i key={i} className={item ? "blank" : "empty"} />;
      })}
    </div>
  );
});
