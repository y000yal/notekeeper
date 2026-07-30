export type CheckItem = { text: string; done: boolean };

export type RepeatUnit = 'day' | 'week' | 'month' | 'year';
/** Repeat every N units, ending at the `until` timestamp or never when null. */
export type Repeat = { every: number; unit: RepeatUnit; until: number | null };

export type Note = {
  id: string;
  title: string;
  /** Rich text body (sanitized subset of HTML). May accompany a checklist when only a selection was converted. */
  html: string;
  /** Non-null turns the note into a checklist (or checklist + leftover html). */
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
  '#ffd300',
  '#fff475',
  '#f28b82',
  '#fbbc04',
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

const DEFAULT_PREFS: Prefs = { view: 'grid', sort: 'manual', theme: 'light' };

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
  const raw = [
    note.html.replace(/<[^>]*>/g, ' '),
    ...(note.items?.map((i) => `${i.done ? '✓' : '•'} ${i.text.replace(/<[^>]*>/g, ' ')}`) ?? []),
  ].join('  ');
  const text = raw.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function isEmpty(note: Note): boolean {
  if (note.html.includes('<img')) return false;
  if (note.remindAt !== null) return false;
  const body =
    stripHtml(note.html) + (note.items?.map((i) => stripHtml(i.text)).join('') ?? '');
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

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'LI',
  'BLOCKQUOTE',
  'PRE',
]);

/** Split rich HTML into one snippet per block/line, keeping inline formatting. */
export function blocksFromHtml(html: string): string[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  const out: string[] = [];

  function pushHtml(snippet: string) {
    const cleaned = snippet.replace(/^(<br\s*\/?>)+|(<br\s*\/?>)+$/gi, '').trim();
    if (cleaned) out.push(cleaned);
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.trim()) pushHtml(text.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'BR') {
      out.push('');
      return;
    }
    if (tag === 'UL' || tag === 'OL') {
      [...el.children].forEach((li) => pushHtml((li as HTMLElement).innerHTML));
      return;
    }
    if (tag === 'PRE') {
      pushHtml(el.outerHTML);
      return;
    }
    if (tag === 'DIV' && el.classList.contains('notice')) {
      pushHtml(el.outerHTML);
      return;
    }
    if (BLOCK_TAGS.has(tag)) {
      // Nested blocks (e.g. div>div) — prefer direct children if they are blocks.
      const kids = [...el.childNodes];
      const hasBlockKid = kids.some(
        (n) => n.nodeType === Node.ELEMENT_NODE && BLOCK_TAGS.has((n as HTMLElement).tagName),
      );
      if (hasBlockKid) kids.forEach(walk);
      else pushHtml(el.innerHTML);
      return;
    }
    // Inline wrapper at the top level — treat as one line.
    pushHtml(el.outerHTML);
  }

  const children = [...root.childNodes];
  if (!children.length) return [];
  const onlyInline = children.every(
    (n) =>
      n.nodeType === Node.TEXT_NODE ||
      (n.nodeType === Node.ELEMENT_NODE &&
        !BLOCK_TAGS.has((n as HTMLElement).tagName) &&
        (n as HTMLElement).tagName !== 'BR' &&
        (n as HTMLElement).tagName !== 'UL' &&
        (n as HTMLElement).tagName !== 'OL'),
  );
  if (onlyInline) {
    // Split a flat run on <br>.
    const parts = root.innerHTML.split(/<br\s*\/?>/i);
    parts.forEach((p) => pushHtml(p));
  } else {
    children.forEach(walk);
  }

  return out.filter((b, i, arr) => b !== '' || (i > 0 && i < arr.length - 1));
}

/** Reassemble checklist rows into a rich-text body. */
export function htmlFromBlocks(blocks: string[]): string {
  return blocks.map((b) => `<div>${b || '<br>'}</div>`).join('');
}

/** HTML of the current selection inside `root`, or null if nothing useful is selected. */
export function selectedHtmlIn(root: HTMLElement): string | null {
  const sel = root.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const frag = range.cloneContents();
  const hold = root.ownerDocument.createElement('div');
  hold.append(frag);
  const html = hold.innerHTML.trim();
  return html || null;
}

const PASTE_TAGS = new Set([
  'B',
  'STRONG',
  'I',
  'EM',
  'U',
  'S',
  'STRIKE',
  'BR',
  'DIV',
  'P',
  'H1',
  'H2',
  'H3',
  'UL',
  'OL',
  'LI',
  'SPAN',
  'SUB',
  'SUP',
  'PRE',
  'CODE',
]);

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap plain / fenced text as a code block for the editor. */
export function wrapAsCodeBlock(text: string): string {
  let body = text.replace(/\r\n/g, '\n');
  // Strip markdown fences if the user copied a fenced snippet.
  const fenced = body.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) body = fenced[1] ?? body;
  return `<pre class="code-block"><code>${escapeText(body)}</code></pre>`;
}

/** Rough check for pasted source code (IDE / multi-line indented text). */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return false;
  if (/^```[\s\S]*```$/.test(trimmed)) return true;
  const lines = trimmed.split('\n');
  if (lines.length < 2) return false;
  const codey = lines.filter(
    (l) =>
      /^\s+/.test(l) ||
      /[{};]$/.test(l.trim()) ||
      /^\s*(function|const|let|var|import|export|class|def|return|if|for|while|public|private|#include|<\?php)\b/.test(
        l,
      ),
  ).length;
  return codey >= Math.max(2, Math.ceil(lines.length / 3));
}

/** Keep paste formatting (bold/colour/lists/code) but drop scripts, remote images, and odd attributes. */
export function sanitizePastedHtml(html: string): string {
  const root = document.createElement('div');
  root.innerHTML = html;

  function clean(node: Node, inCode = false): Node | null {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const el = node as HTMLElement;
    const tag = el.tagName;

    // Images are inserted via the file path (re-encoded); skip markup imgs.
    if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'META' || tag === 'LINK') {
      return null;
    }

    // Anchors → keep the visible text only.
    if (tag === 'A') {
      const frag = document.createDocumentFragment();
      [...el.childNodes].forEach((child) => {
        const c = clean(child, inCode);
        if (c) frag.append(c);
      });
      return frag;
    }

    // Code blocks: keep structure; allow coloured spans from IDE paste.
    if (tag === 'PRE' || tag === 'CODE') {
      const next = document.createElement(tag.toLowerCase());
      if (tag === 'PRE') next.className = 'code-block';
      [...el.childNodes].forEach((child) => {
        const c = clean(child, true);
        if (c) next.append(c);
      });
      // Bare <code> at top level becomes a block.
      if (tag === 'CODE' && !inCode && el.parentElement?.tagName !== 'PRE') {
        const pre = document.createElement('pre');
        pre.className = 'code-block';
        pre.append(next);
        return pre;
      }
      return next;
    }

    // Monospace paste from VS Code / terminals → treat as a code block.
    const font = (el.style.fontFamily || '').toLowerCase();
    if (
      !inCode &&
      (tag === 'DIV' || tag === 'SPAN') &&
      /mono|consolas|courier|menlo|monaco|fira code|source code/.test(font) &&
      (el.textContent?.includes('\n') || el.querySelector('div,br'))
    ) {
      return (() => {
        const hold = document.createElement('div');
        hold.innerHTML = wrapAsCodeBlock(el.innerText || el.textContent || '');
        return hold.firstChild;
      })();
    }

    // Unknown tags: unwrap children.
    if (!PASTE_TAGS.has(tag)) {
      const frag = document.createDocumentFragment();
      [...el.childNodes].forEach((child) => {
        const c = clean(child, inCode);
        if (c) frag.append(c);
      });
      return frag;
    }

    const next = document.createElement(tag.toLowerCase());
    // Keep notice callouts (info / warning / danger).
    if (tag === 'DIV') {
      const notice = el.dataset.notice || [...el.classList].find((c) => c === 'info' || c === 'warning' || c === 'danger');
      if (el.classList.contains('notice') && notice) {
        next.className = `notice ${notice}`;
        next.dataset.notice = notice;
      }
    }
    // Preserve colour / highlight from Word, Docs, web pages.
    if (tag === 'SPAN' || tag === 'FONT' || PASTE_TAGS.has(tag)) {
      const color = el.style.color || el.getAttribute('color');
      const bg =
        el.style.backgroundColor ||
        el.style.background ||
        el.getAttribute('bgcolor');
      if (color) next.style.color = color;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        next.style.backgroundColor = bg;
      }
    }
    if (tag === 'SPAN' && el.style.fontWeight === 'bold') next.style.fontWeight = 'bold';
    if (tag === 'SPAN' && (el.style.fontStyle === 'italic' || el.style.fontStyle === 'oblique')) {
      next.style.fontStyle = 'italic';
    }
    if (tag === 'SPAN' && /underline/.test(el.style.textDecoration)) {
      next.style.textDecoration = 'underline';
    }

    [...el.childNodes].forEach((child) => {
      const c = clean(child, inCode);
      if (c) next.append(c);
    });
    return next;
  }

  const out = document.createElement('div');
  [...root.childNodes].forEach((child) => {
    const c = clean(child);
    if (c) out.append(c);
  });
  return out.innerHTML;
}

/** Pinned first, then newest by the chosen date — or the drag-arranged order. */
export function sortNotes(notes: Note[], sort: Sort = 'manual'): Note[] {
  const by = (n: Note) => (sort === 'created' ? n.createdAt : n.updatedAt);
  return [...notes].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (sort === 'manual' ? 0 : by(b) - by(a)),
  );
}

/** Move `dragId` before or after `overId`. */
export function reorder(
  notes: Note[],
  dragId: string,
  overId: string,
  place: 'before' | 'after' = 'before',
): Note[] {
  const from = notes.findIndex((n) => n.id === dragId);
  const over = notes.findIndex((n) => n.id === overId);
  if (from < 0 || over < 0 || from === over) return notes;
  const next = [...notes];
  const [item] = next.splice(from, 1);
  let insertAt = over;
  if (from < over) insertAt -= 1; // indices after the removal
  if (place === 'after') insertAt += 1;
  next.splice(insertAt, 0, item!);
  return next;
}

export function matches(note: Note, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const body =
    stripHtml(note.html) + ' ' + (note.items?.map((i) => stripHtml(i.text)).join(' ') ?? '');
  return [note.title, body, ...note.labels].join(' ').toLowerCase().includes(q);
}
