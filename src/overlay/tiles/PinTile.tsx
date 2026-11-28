import { memo, useEffect, useState } from "react";
import { call } from "../../lib/bus";
import { inTauri } from "../../lib/native";

/** A pinned app, folder or file, with its real Windows icon. */
export const PinTile = memo(function PinTile({ path, name }: { path: string; name: string }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri) return;
    let live = true;
    void call<string | null>("shelf_app_icon", { path })
      .then((i) => live && setIcon(i))
      .catch(() => live && setIcon(null));
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <div className="dk-pin" title={name}>
      {icon ? (
        <img src={icon} alt="" draggable={false} />
      ) : (
        <span className="dk-pin-letter" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </div>
  );
});
