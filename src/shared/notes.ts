export type CheckItem = { text: string; done: boolean };

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';
/** Repeat every N units, ending at the `until` timestamp or never when null. */
export type Repeat = { every: number; unit: RepeatUnit; until: number | null };

export type Note = {
  id: string;
  title: string;
  /** Rich text body (sanitized subset of HTML). Empty when the note is a checklist. */
  html: string;
  /** Non-null turns the note into a checklist. */
  items: CheckItem[] | null;
  labels: string[];
  color: string;
  pinned: boolean;
  /** Reminder time in epoch ms, or null for no reminder. */
  remindAt: number | null;
  /** Ticked-off reminder: the note reads as done and no notification fires. */
  reminderDone: boolean;
  /** Repeating reminder, or null for a one-off. */
  repeat: Repeat | null;
  /** In the trash since this time; null for a live note. */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export const COLORS = [
  '#ffffff',
  '#f28b82',
  '#fbbc04',
  '#fff475',
  '#ccff90',
  '#a7ffeb',
  '#cbf0f8',
  '#aecbfa',
  '#d7aefb',
  '#fdcfe8',
];

const KEY = 'notes';

/** Trashed notes are dropped for good after this long. */
export const TRASH_DAYS = 30;

export function isExpiredTrash(note: Note, now = Date.now()): boolean {
  return note.deletedAt !== null && now - note.deletedAt > TRASH_DAYS * 86_400_000;
}

export async function loadNotes(): Promise<Note[]> {
  const got = await chrome.storage.local.get(KEY);
  if (!Array.isArray(got[KEY])) return [];
  // Fill in fields added after a note was first saved.
  return (got[KEY] as Note[]).map((n) => ({
    ...n,
    labels: n.labels ?? [],
    createdAt: n.createdAt ?? n.updatedAt,
    remindAt: n.remindAt ?? null,
    reminderDone: n.reminderDone ?? false,
    repeat: n.repeat ?? null,
    deletedAt: n.deletedAt ?? null,
  }));
}

export function saveNotes(notes: Note[]): Promise<void> {
  return chrome.storage.local.set({ [KEY]: notes });
}

export type View = 'list' | 'grid';
/** 'manual' keeps the drag-arranged order. */
export type Sort = 'manual' | 'created' | 'modified';
export type Theme = 'light' | 'dark';
export type Prefs = { view: View; sort: Sort; theme: Theme };

const DEFAULT_PREFS: Prefs = { view: 'list', sort: 'manual', theme: 'light' };

export async function loadPrefs(): Promise<Prefs> {
  const got = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...(got.prefs as Partial<Prefs> | undefined) };
}

/** Read-modify-write for contexts that hold one note, not the whole list. */
export async function patchNote(id: string, changes: Partial<Note>): Promise<void> {
  const notes = await loadNotes();
  await saveNotes(
    notes.map((n) => (n.id === id ? { ...n, ...changes, updatedAt: Date.now() } : n)),
  );
}

export async function removeNote(id: string): Promise<void> {
  const notes = await loadNotes();
  await saveNotes(notes.filter((n) => n.id !== id));
}

export function savePrefs(prefs: Prefs): Promise<void> {
  return chrome.storage.local.set({ prefs });
}

export function newNote(): Note {
  return {
    id: crypto.randomUUID(),
    title: '',
    html: '',
    items: null,
    labels: [],
    color: COLORS[0]!,
    pinned: false,
    remindAt: null,
    reminderDone: false,
    repeat: null,
    deletedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Plain text of a note, safe in the service worker (no DOM there). */
export function previewText(note: Note, max = 120): string {
  const raw = note.items
    ? note.items.map((i) => `${i.done ? '✓' : '•'} ${i.text}`).join('  ')
    : note.html.replace(/<[^>]*>/g, ' ');
  const text = raw.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isEmpty(note: Note): boolean {
  if (note.html.includes('<img')) return false;
  if (note.remindAt !== null) return false;
  const body = note.items ? note.items.map((i) => i.text).join('') : stripHtml(note.html);
  return !note.title.trim() && !body.trim();
}

/** Every label in use, alphabetical. Dropping a label from the last note retires it. */
export function allLabels(notes: Note[]): string[] {
  return [...new Set(notes.flatMap((n) => n.labels))].sort((a, b) => a.localeCompare(b));
}

export function stripHtml(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el.textContent ?? '';
}

/** Pinned first, then newest by the chosen date — or the drag-arranged order. */
export function sortNotes(notes: Note[], sort: Sort = 'manual'): Note[] {
  const by = (n: Note) => (sort === 'created' ? n.createdAt : n.updatedAt);
  return [...notes].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (sort === 'manual' ? 0 : by(b) - by(a)),
  );
}

/** Move `dragId` to where `overId` currently sits. */
export function reorder(notes: Note[], dragId: string, overId: string): Note[] {
  const from = notes.findIndex((n) => n.id === dragId);
  const to = notes.findIndex((n) => n.id === overId);
  if (from < 0 || to < 0 || from === to) return notes;
  const next = [...notes];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export function matches(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const body = note.items ? note.items.map((i) => i.text).join(' ') : stripHtml(note.html);
  return [note.title, body, ...note.labels].join(' ').toLowerCase().includes(q);
}
