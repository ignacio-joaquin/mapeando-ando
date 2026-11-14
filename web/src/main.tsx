import { createRoot } from "react-dom/client";
import "maplibre-gl/dist/maplibre-gl.css";
import "./index.css";
import { App } from "./App";

const el = document.getElementById("root");
if (!el) throw new Error("falta #root en index.html");
createRoot(el).render(<App />);
