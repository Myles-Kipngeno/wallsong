import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { inTauri } from "./lib/native";
import { Mirror, Wallpaper } from "./wallpaper/Wallpaper";
import Overlay from "./overlay/Overlay";
import { MiniPlayer } from "./overlay/PlayerCard";
import "./lib/fonts";
import "./styles.css";

// One page, four kinds of window:
// - "wallpaper": behind the icons on the main screen, hosts the player
// - "wall-1", "wall-2"...: behind the icons on other screens (?view=mirror&display=...)
// - "overlay": the clickable control layer (the Dock, cards, the player card)
// - "mini": the player card in its own always-on-top window (?view=mini)
// In a browser, open /?view=overlay in a second tab to get the controls.
const params = new URLSearchParams(location.search);
const label = inTauri ? getCurrentWindow().label : "";
const view = label === "overlay" ? "overlay" : (params.get("view") ?? "wallpaper");
document.documentElement.dataset.view = view;

const root =
  view === "overlay" ? (
    <Overlay />
  ) : view === "mini" ? (
    <MiniPlayer />
  ) : view === "mirror" ? (
    <Mirror displayKey={params.get("display") ?? ""} />
  ) : (
    <Wallpaper />
  );

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode>{root}</React.StrictMode>);
