// Wick PWA support: registers the service worker (offline use) and keeps the browser's install prompt, so the Studio
// can offer File > Install as App.

let deferred = null;
let installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

// The browser fires this once the page can be installed. Keeping the event lets the Studio show the prompt on demand.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
window.addEventListener('appinstalled', () => { deferred = null; installed = true; notify(); });

export const pwa = {
  get installed() { return installed; },
  get canPrompt() { return !!deferred; },
  onChange(fn) { listeners.add(fn); },

  /** Shows the browser's install prompt. Resolves 'accepted', 'dismissed' or 'unavailable' (no prompt to show). */
  async install() {
    if (!deferred) return 'unavailable';
    const prompt = deferred;
    deferred = null;
    notify();
    await prompt.prompt();
    return (await prompt.userChoice).outcome;
  },

  /** What to tell the person when the browser has no install prompt to show. */
  hint() {
    if (installed) return 'Wick Engine is already running as an installed app.';
    const ua = navigator.userAgent;
    if (/iPad|iPhone|iPod/.test(ua)) return 'In Safari, tap the Share button, then "Add to Home Screen".';
    if (/Firefox\//.test(ua) && !/Android/.test(ua)) return 'Firefox on desktop cannot install web apps. Use Chrome or Edge, or keep using Wick Engine in a tab: it works offline after the first load.';
    if (!window.isSecureContext) return 'Apps can only be installed from a secure address (https, or localhost).';
    return 'Look for the install icon at the right end of the address bar (Chrome and Edge), or open the browser menu and choose "Install Wick Engine". If it is missing, reload the page once so the offline files finish loading, then check again.';
  },
};

/** Registers sw.js so everything the site needs is cached after the first load. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const register = () => navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { scope: './' })
    .catch((err) => console.warn('Offline support is unavailable:', err));
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
}
