// Dev-only: copies the built pages with a chrome.* stub so they can be opened in
// a plain browser tab. localStorage-backed, so the popped-out note window shares
// storage with the panel. Not shipped — writes into .output only.
import { readFileSync, writeFileSync } from 'node:fs';

const stub = `<script>
const read = () => JSON.parse(localStorage.getItem('stub') || '{}');
const listeners = [];
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ [k]: read()[k] }),
      set: async (o) => {
        const all = { ...read(), ...o };
        localStorage.setItem('stub', JSON.stringify(all));
        listeners.forEach((fn) => fn(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: all[k] }]))));
      },
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener: () => {} },
      // localStorage 'storage' events fire in the OTHER documents of this origin,
      // which is how chrome.storage.onChanged behaves across extension contexts.
      _cross: addEventListener('storage', (e) => {
        if (e.key === 'stub') listeners.forEach((fn) => fn({ notes: { newValue: read().notes } }));
      }),
    },
  },
  tabs: { create: () => {}, query: async () => [{ id: 1 }] },
  permissions: {
    request: async (what) => {
      if (what?.permissions?.includes('notifications')) {
        return localStorage.getItem('denyNotifications') !== '1';
      }
      return localStorage.getItem('grantPerm') === '1';
    },
  },
  alarms: { create: () => {}, clear: async () => true },
  notifications: { create: () => {}, clear: async () => true },
  scripting: {
    // Runs the injected function right here, like the page would.
    executeScript: async ({ func, args }) => {
      const forced = localStorage.getItem('forceInjectError');
      if (forced) throw new Error(forced);
      return [{ result: await func(...args) }];
    },
  },
  windows: { create: (o) => { localStorage.setItem('lastWindow', JSON.stringify(o)); } },
  runtime: {
    getURL: (p) => p.replace('/note.html', '/preview-note.html'),
    getManifest: () => ({ version: '0.0.0-preview' }),
    // Stands in for the background worker: records the request, reports success.
    sendMessage: async (msg) => {
      localStorage.setItem('lastMessage', JSON.stringify(msg));
      if (msg.type === 'schedule-reminder' || msg.type === 'clear-reminder') {
        const log = JSON.parse(localStorage.getItem('alarmLog') || '[]');
        log.push(msg);
        localStorage.setItem('alarmLog', JSON.stringify(log));
        return { ok: true };
      }
      if (localStorage.getItem('failWorker')) return { ok: false, error: 'simulated worker failure' };
      return { ok: true, windowId: 42 };
    },
  },
  i18n: { getUILanguage: () => 'en-US' },
};
</script>`;

for (const [from, to] of [
  ['sidepanel.html', 'preview.html'],
  ['note.html', 'preview-note.html'],
]) {
  const html = readFileSync(`.output/chrome-mv3/${from}`, 'utf8');
  writeFileSync(
    `.output/chrome-mv3/${to}`,
    html.replace('<script type="module"', `${stub}<script type="module"`),
  );
}
console.log('preview harness written');
