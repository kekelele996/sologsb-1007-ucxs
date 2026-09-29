import { mount, StartClient } from "@solidjs/start/client";

mount(() => <StartClient />, document.getElementById("app")!);

// Register the offline shell only for production builds. After the first
// successful online load, reloads work without any network connection.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support degrades silently if registration is unavailable.
    });
  });
}
