import { mount, StartClient } from "@solidjs/start/client";

mount(() => <StartClient />, document.getElementById("app")!);

// After the first online load the service worker serves the cached app
// shell, so re-entering the editor in the basement (no network) still
// opens the full workspace instead of a white screen.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline-first is an enhancement; a blocked registration must not
      // stop the editor from booting.
    });
  });
}
