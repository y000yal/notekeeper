import { isExpiredTrash, loadNotes, patchNote, previewText, saveNotes } from '../shared/notes';
import { ALARM_PREFIX, upcomingOccurrence } from '../shared/reminders';

/** noteId -> windowId, in session storage so it survives the worker unloading. */
const OPEN_KEY = 'noteWindows';

async function openNoteWindow(id: string) {
  const stored = await chrome.storage.session.get(OPEN_KEY);
  const open = (stored[OPEN_KEY] ?? {}) as Record<string, number>;

  // Already popped out? Bring that window forward instead of making a second one.
  const existing = open[id];
  if (existing !== undefined) {
    try {
      await chrome.windows.update(existing, { focused: true, drawAttention: true });
      return { ok: true, windowId: existing, reused: true };
    } catch {
      delete open[id]; // window is gone
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`note.html?id=${id}`),
    type: 'popup',
    width: 400,
    height: 520,
    focused: true,
  });
  if (win?.id !== undefined) {
    open[id] = win.id;
    await chrome.storage.session.set({ [OPEN_KEY]: open });
  }
  return { ok: true, windowId: win?.id };
}

/**
 * Chrome's own notification sound cannot be changed, so notifications are silent
 * and the chime plays here. Audio needs a document: the worker has none.
 */
async function playChime() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play the reminder chime.',
      });
    }
    await chrome.runtime.sendMessage({ type: 'play-chime' });
    // Let it finish, then release the document.
    setTimeout(() => void chrome.offscreen.closeDocument().catch(() => {}), 3000);
  } catch (e) {
    console.warn('[NoteKeeper] chime failed', e);
  }
}

/**
 * Store a pending reminder so the side panel can show an in-app banner when
 * native notifications are unavailable (e.g. Brave blocks them).
 */
async function storePendingReminder(id: string, title: string, body: string) {
  const stored = await chrome.storage.session.get('pendingReminders');
  const pending: Array<{ id: string; title: string; body: string; ts: number }> =
    stored.pendingReminders ?? [];
  pending.push({ id, title, body, ts: Date.now() });
  await chrome.storage.session.set({ pendingReminders: pending });
  // Badge tells the user something needs attention.
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#FBBC04' });
}

/** Fires on the alarm: notify unless the note is gone or already ticked off. */
async function notifyReminder(id: string) {
  const note = (await loadNotes()).find((n) => n.id === id);
  if (!note || note.reminderDone || note.remindAt === null) return;
  const body = previewText(note);
  const title = note.title || 'NoteKeeper reminder';
  const message = body || 'Reminder';

  try {
    await new Promise<string>((resolve, reject) => {
      chrome.notifications.create(
        ALARM_PREFIX + id,
        {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon/128.png'),
          title,
          message,
          requireInteraction: true,
          silent: true,
        },
        (notifId) => {
          if (chrome.runtime.lastError || !notifId) reject(chrome.runtime.lastError);
          else resolve(notifId);
        },
      );
    });
  } catch {
    // Brave (and others) may block chrome.notifications — fall back to badge + in-app banner.
    await storePendingReminder(id, title, message);
  }

  void playChime();

  // Repeating reminder: move it to its next slot, or end the series.
  if (!note.repeat) return;
  const next = upcomingOccurrence(note.remindAt, note.repeat);
  if (note.repeat.until !== null && next > note.repeat.until) {
    await patchNote(id, { remindAt: null, repeat: null });
    return;
  }
  await patchNote(id, { remindAt: next });
  chrome.alarms.create(ALARM_PREFIX + id, { when: next });
}

const PURGE_ALARM = 'purge-trash';

/** Drop trashed notes past their retention. Also done when the panel opens. */
async function purgeTrash() {
  const notes = await loadNotes();
  const kept = notes.filter((n) => !isExpiredTrash(n));
  if (kept.length !== notes.length) await saveNotes(kept);
}

export default defineBackground(() => {
  chrome.alarms.create(PURGE_ALARM, { periodInMinutes: 720, when: Date.now() + 60_000 });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PURGE_ALARM) return void purgeTrash();
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    void notifyReminder(alarm.name.slice(ALARM_PREFIX.length));
  });

  // Clicking the notification opens that note in its own window.
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (!notificationId.startsWith(ALARM_PREFIX)) return;
    chrome.notifications.clear(notificationId);
    void openNoteWindow(notificationId.slice(ALARM_PREFIX.length));
  });

  // The side panel asks the worker to open note windows: this context always has
  // chrome.windows, and its failures come back as a reply instead of vanishing.
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === 'schedule-reminder') {
      chrome.alarms.create(ALARM_PREFIX + message.id, { when: message.when });
      respond({ ok: true });
      return;
    }
    if (message?.type === 'clear-reminder') {
      void chrome.alarms.clear(ALARM_PREFIX + message.id);
      void chrome.notifications.clear(ALARM_PREFIX + message.id);
      respond({ ok: true });
      return;
    }
    if (message?.type === 'get-pending-reminders') {
      chrome.storage.session.get('pendingReminders').then((s) => {
        respond(s.pendingReminders ?? []);
        chrome.storage.session.remove('pendingReminders');
        chrome.action.setBadgeText({ text: '' });
      });
      return true;
    }
    if (message?.type !== 'open-note-window') return;
    openNoteWindow(message.id).then(respond, (error: Error) =>
      respond({ ok: false, error: String(error?.message ?? error) }),
    );
    return true; // keep the channel open for the async reply
  });

  chrome.windows.onRemoved.addListener(async (windowId) => {
    const stored = await chrome.storage.session.get(OPEN_KEY);
    const open = (stored[OPEN_KEY] ?? {}) as Record<string, number>;
    const gone = Object.keys(open).find((id) => open[id] === windowId);
    if (!gone) return;
    delete open[gone];
    await chrome.storage.session.set({ [OPEN_KEY]: open });
  });
});
