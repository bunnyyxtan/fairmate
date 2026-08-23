import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./base.css";
import "./challenge.css";
import "./game-overrides.css";
import "./production.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);