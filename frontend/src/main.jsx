import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const basePath = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${basePath}service-worker.js`, { scope: basePath })
      .catch(() => {
        console.warn("RLEMS offline app-shell registration was unavailable.");
      });
  });
}
