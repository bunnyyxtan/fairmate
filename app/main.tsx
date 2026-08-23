import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { GamePreview } from "./preview";
import "./base.css";
import "./challenge.css";
import "./game-overrides.css";
import "./production.css";

// Dev-only design harness; constant-folded away in production builds.
const previewPhase = import.meta.env.DEV
  ? new URLSearchParams(window.location.search).get("preview")
  : null;

createRoot(document.getElementById("root")!).render(
  <StrictMode>{previewPhase ? <GamePreview phase={previewPhase} /> : <App />}</StrictMode>,
);