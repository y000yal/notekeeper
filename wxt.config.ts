import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  modules: ['@wxt-dev/module-react'],
  outDir: '.output',
  manifest: {
    name: 'NoteKeeper - Notes, To-Do Lists & Reminders',
    short_name: 'NoteKeeper',
    description: 'Quick notes, voice notes, to-do checklists, reminders & pop-out floating notes in a side panel. 100% private & offline.',
    minimum_chrome_version: '116',
    // activeTab covers only the tab you are looking at, costs no install warning
    // and shows no prompt. Chrome will not give a side panel an always-on-top
    // window, so floating notes are opened from the current page — nothing is
    // injected unless you ask a note to float.
    // offscreen: the only way to play the reminder chime from a service worker.
    permissions: ['storage', 'sidePanel', 'scripting', 'activeTab', 'alarms', 'offscreen'],
    // Asked for the first time a reminder is set, not at install.
    optional_permissions: ['notifications'],
    // Fallback for tabs activeTab does not cover, asked for only on demand.
    optional_host_permissions: ['<all_urls>'],
    // The floating window is owned by the page, so it reaches the note page as a
    // cross-origin frame and has to be declared accessible.
    web_accessible_resources: [{ resources: ['note.html'], matches: ['<all_urls>'] }],
    action: { default_title: 'NoteKeeper (notes side panel)' },
  },
});
