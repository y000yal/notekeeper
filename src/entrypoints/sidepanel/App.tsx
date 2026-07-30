import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { flushSync } from 'react-dom';
import {
  allLabels,
  COLORS,
  isEmpty,
  isExpiredTrash,
  loadNotes,
  loadPrefs,
  matches,
  newNote,
  reorder,
  saveNotes,
  savePrefs,
  sortNotes,
  stripHtml,
  type Note,
  type Prefs,
  type Sort,
  TRASH_DAYS,
  type View,
} from '../../shared/notes';
import { Editor, Icon } from '../../shared/Editor';
import { dictationSupported } from '../../shared/dictation';
import { floatNote } from '../../shared/float';
import { describeRepeat, formatReminder, scheduleReminder } from '../../shared/reminders';

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [draft, setDraft] = useState<Note | null>(null);
  const [draftVoice, setDraftVoice] = useState(false);
  const [draftPanel, setDraftPanel] = useState<'' | 'remind'>('');
  const [fabOpen, setFabOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTop, setEditingTop] = useState(0);
  const [editingPanel, setEditingPanel] = useState<'' | 'remind'>('');
  const [filter, setFilter] = useState<Filter>('all');
  const [confirming, setConfirming] = useState<Note | null>(null);
  const [confirmingTop, setConfirmingTop] = useState(0);
  const dragId = useRef<string | null>(null);

  const [prefs, setPrefs] = useState<Prefs>({ view: 'grid', sort: 'manual', theme: 'light' });
  const [menu, setMenu] = useState<MenuName>(null);

  useEffect(() => {
    loadNotes().then((stored) => {
      // Trash empties itself; do it on open so it happens even if the worker slept.
      const kept = stored.filter((n) => !isExpiredTrash(n));
      setNotes(kept);
      setLoaded(true);
      if (kept.length !== stored.length) void saveNotes(kept);
    });
    loadPrefs().then(setPrefs);
    // Show any reminders that fired while native notifications were blocked (e.g. Brave).
    chrome.runtime.sendMessage({ type: 'get-pending-reminders' }).then(
      (pending: Array<{ id: string; title: string; body: string }>) => {
        const first = pending?.[0];
        if (first) setNotice(`Reminder: ${first.title} — ${first.body}`);
      },
      () => {},
    );
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme;
  }, [prefs.theme]);

  // A popped-out note writes straight to storage; mirror those edits here, even
  // with the editor open — it re-seeds only the fields the caret is not in. An
  // unsaved draft is not in storage at all, so leave that one alone.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!changes.notes || draft) return;
      void loadNotes().then(setNotes);
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => chrome.storage.local.onChanged.removeListener(onChanged);
  }, [draft]);

  function updatePrefs(changes: Partial<Prefs>) {
    const next = { ...prefs, ...changes };
    setPrefs(next);
    void savePrefs(next);
  }

  /**
   * Cards move between one and two columns, which no CSS transition can animate.
   * Chrome's view transitions morph them from the old positions to the new ones.
   */
  function switchView(next: View) {
    setMenu(null);
    const apply = () => flushSync(() => updatePrefs({ view: next }));
    const start = (
      document as Document & { startViewTransition?: (cb: () => void) => unknown }
    ).startViewTransition;
    if (start) start.call(document, apply);
    else apply();
  }

  /**
   * Document Picture-in-Picture is the only window an extension can open that
   * floats above other apps and stays resizable. Chrome allows one at a time, so
   * popping out a second note replaces the first. If the API refuses (or is
   * missing) fall back to a normal popup window, which is resizable but not
   * always-on-top.
   */
  async function popOut(note: Note) {
    setEditingId(null);
    setNotice('Opening the note window...');
    try {
      // Injected from here, not from the worker: executeScript only carries a
      // user gesture into the page when the caller still holds one, and a
      // runtime message does not pass activation between contexts.
      let floated = await floatNote(note.id);
      // Chrome never scripts its own pages, so chrome://, the Web Store and
      // blank tabs can't host a floating window — no permission would help.
      const restricted =
        /chrome:\/\/|chrome-extension:\/\/|chromewebstore|cannot be scripted|blank/i.test(
          floated.error ?? '',
        );
      if (!floated.ok && !restricted && /access|permission|host/i.test(floated.error ?? '')) {
        // activeTab did not cover this tab; ask for the wider permission.
        const granted = await chrome.permissions
          .request({ origins: ['<all_urls>'] })
          .catch(() => false);
        if (granted) floated = await floatNote(note.id);
      }
      if (floated.ok) {
        setNotice('');
        return;
      }
      console.error('[NoteKeeper] Floating window failed:', floated.error);
      setNotice(
        restricted
          ? 'Floating notes need an ordinary web page in the current tab, not a Chrome page. Opened a window instead.'
          : `Cannot float here (${floated.error}). Opened a window instead.`,
      );
      const reply = (await chrome.runtime.sendMessage({
        type: 'open-note-window',
        id: note.id,
      })) as { ok: boolean; error?: string } | undefined;
      if (!reply?.ok) {
        setNotice(`Could not open the note window: ${reply?.error ?? 'no reply from NoteKeeper'}`);
      }
    } catch (e) {
      console.error('[NoteKeeper] Pop out failed:', e);
      setNotice(`Pop out failed: ${(e as Error).message}`);
    }
  }

  function commit(next: Note[]) {
    setNotes(next);
    setNotice('');
    // Images are the only realistic way to hit the 10 MB local quota.
    saveNotes(next).catch((e: Error) => setNotice(`Could not save: ${e.message}`));
  }

  function patch(id: string, changes: Partial<Note>) {
    commit(notes.map((n) => (n.id === id ? { ...n, ...changes, updatedAt: Date.now() } : n)));
  }

  /** Delete means trash: recoverable for  days, then dropped. */
  function trash(id: string) {
    patch(id, { deletedAt: Date.now() });
    void scheduleReminder(id, null); // a trashed note must not notify
    if (editingId === id) setEditingId(null);
    setConfirming(null);
  }

  function restore(id: string) {
    const note = notes.find((n) => n.id === id);
    patch(id, { deletedAt: null });
    // Re-arm a reminder that is still in the future.
    if (note?.remindAt && !note.reminderDone && note.remindAt > Date.now()) {
      void scheduleReminder(id, note.remindAt);
    }
  }

  function remove(id: string) {
    commit(notes.filter((n) => n.id !== id));
    void scheduleReminder(id, null);
    if (editingId === id) setEditingId(null);
    setConfirming(null);
  }

  function startDraft(
    changes: Partial<Note> = {},
    opts: { voice?: boolean; panel?: '' | 'remind' } = {},
  ) {
    setFabOpen(false);
    setDraft({ ...newNote(), ...changes });
    setDraftVoice(!!opts.voice);
    setDraftPanel(opts.panel ?? '');
  }

  function closeDraft() {
    if (draft && !isEmpty(draft)) commit([{ ...draft, updatedAt: Date.now() }, ...notes]);
    setDraft(null);
    setDraftVoice(false);
    setDraftPanel('');
  }

  function closeEditor() {
    const note = notes.find((n) => n.id === editingId);
    if (note && isEmpty(note)) remove(note.id);
    setEditingId(null);
    setEditingPanel('');
  }

  const labels = useMemo(() => allLabels(notes), [notes]);
  const suggestedLabels = labels.filter((l) =>
    l.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const visible = useMemo(
    () =>
      sortNotes(notes, prefs.sort)
        .filter((n) => (filter === 'trash' ? n.deletedAt !== null : n.deletedAt === null))
        .filter((n) => matches(n, query))
        .filter((n) =>
          filter === 'reminders'
            ? n.remindAt !== null
            : filter === 'notes'
              ? n.remindAt === null
              : true,
        ),
    [notes, query, prefs.sort, filter],
  );
  const editing = notes.find((n) => n.id === editingId && n.deletedAt === null) ?? null;
  const trashCount = notes.filter((n) => n.deletedAt !== null).length;

  // Clicking outside the open composer / FAB / header menu (or Escape) closes it.
  const composerRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (draft && !composerRef.current?.contains(target)) closeDraft();
      if (fabOpen && !fabRef.current?.contains(target)) setFabOpen(false);
      if (menu && !headerRef.current?.contains(target)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (fabOpen) setFabOpen(false);
      else if (menu) setMenu(null);
      else if (draft) closeDraft();
      else if (editingId) closeEditor();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  });

  return (
    <div className="app">
      <header className="topbar" ref={headerRef}>
        <div className="search">
          <Icon name="search" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSuggesting(true)}
            onBlur={() => setSuggesting(false)}
            placeholder="Search notes and labels"
            aria-label="Search notes and labels"
          />
          {query && (
            <button className="icon-btn" onClick={() => setQuery('')} data-tip="Clear search">
              <Icon name="close" />
            </button>
          )}
          {suggesting && !!suggestedLabels.length && (
            <div className="suggest">
              <p className="popover-title">Labels</p>
              <div className="chips">
                {suggestedLabels.map((label) => (
                  // mousedown, not click: the input's blur would unmount us first.
                  <button key={label} className="chip" onMouseDown={() => setQuery(label)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="tools">
          <Menu
            name="filter"
            tip="Filter"
            icon={filter === 'all' ? 'filter' : 'filterOn'}
            title="Show"
            open={menu === 'filter'}
            onToggle={setMenu}
          >
            {(
              [
                ['all', 'Everything'],
                ['reminders', 'Reminders only'],
                ['notes', 'Notes without reminders'],
              ] as [Filter, string][]
            ).map(([value, text]) => (
              <MenuItem
                key={value}
                text={text}
                active={filter === value}
                onPick={() => {
                  setFilter(value);
                  setMenu(null);
                }}
              />
            ))}
          </Menu>

          <Menu
            name="sort"
            tip="Sort notes"
            icon="sort"
            title="Sort by"
            open={menu === 'sort'}
            onToggle={setMenu}
          >
            {(
              [
                ['manual', 'My order (drag to arrange)'],
                ['created', 'Date created'],
                ['modified', 'Date modified'],
              ] as [Sort, string][]
            ).map(([value, text]) => (
              <MenuItem
                key={value}
                text={text}
                active={prefs.sort === value}
                onPick={() => {
                  updatePrefs({ sort: value });
                  setMenu(null);
                }}
              />
            ))}
          </Menu>

          <button
            className="icon-btn"
            data-tip={prefs.view === 'grid' ? 'List view' : 'Grid view'}
            onClick={() => switchView(prefs.view === 'grid' ? 'list' : 'grid')}
          >
            <Icon name={prefs.view === 'grid' ? 'listView' : 'grid'} />
          </button>

          <Menu
            name="settings"
            tip="Settings"
            icon="settings"
            title="Settings"
            open={menu === 'settings'}
            onToggle={setMenu}
          >
            <MenuItem
              text={prefs.theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              icon={prefs.theme === 'dark' ? 'sun' : 'moon'}
              onPick={() => {
                updatePrefs({ theme: prefs.theme === 'dark' ? 'light' : 'dark' });
                setMenu(null);
              }}
            />
            <MenuItem
              text={filter === 'trash' ? 'Back to notes' : `Trash (${trashCount})`}
              icon="trash"
              active={filter === 'trash'}
              onPick={() => {
                setFilter(filter === 'trash' ? 'all' : 'trash');
                setMenu(null);
              }}
            />
            <p className="menu-note">NoteKeeper {chrome.runtime.getManifest().version}</p>
          </Menu>
        </div>
      </header>

      {notice && <p className="error">{notice}</p>}

      <div className={'list ' + prefs.view}>
        {visible.map((note) => (
            <NoteCard
              key={note.id}
              note={note}
              onDragStart={() => (dragId.current = note.id)}
              onDropOn={(place) => {
                if (dragId.current) commit(reorder(notes, dragId.current, note.id, place));
                dragId.current = null;
                // A date sort would just override the drop, so honour the drag.
                if (prefs.sort !== 'manual') updatePrefs({ sort: 'manual' });
              }}
              onOpen={(top) => {
                setEditingTop(top);
                setEditingId(note.id);
              }}
              onTogglePin={() => patch(note.id, { pinned: !note.pinned })}
              onToggleItem={(index) =>
                patch(note.id, {
                  items: note.items!.map((it, i) => (i === index ? { ...it, done: !it.done } : it)),
                })
              }
              onLabelClick={setQuery}
              onPopOut={() => void popOut(note)}
              onRemind={(top) => {
                setEditingTop(top);
                setEditingPanel('remind');
                setEditingId(note.id);
              }}
              onToggleReminderDone={() => {
                const done = !note.reminderDone;
                patch(note.id, { reminderDone: done });
                // Completed reminders must not fire; un-completing re-arms it.
                void scheduleReminder(note.id, done ? null : note.remindAt);
              }}
              onRestore={() => restore(note.id)}
              onDeleteForever={(top) => {
                setConfirmingTop(top);
                setConfirming(note);
              }}
            />
        ))}
        {loaded && !visible.length && (
          <p className="empty">{query ? 'No matching notes.' : 'Notes you add show up here.'}</p>
        )}
      </div>

      {filter === 'trash' && (
        <p className="hint trash-banner">
          Notes in the trash are deleted for good after {TRASH_DAYS} days.
        </p>
      )}

      {filter !== 'trash' && !draft && (
        <div className={'fab-wrap' + (fabOpen ? ' open' : '')} ref={fabRef}>
          {fabOpen && (
            <div className="fab-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className="fab-action"
                onClick={() => startDraft({}, { panel: 'remind' })}
              >
                <Icon name="bell" />
                <span>Reminder</span>
              </button>
              {dictationSupported && (
                <button
                  type="button"
                  role="menuitem"
                  className="fab-action"
                  onClick={() => startDraft({}, { voice: true })}
                >
                  <Icon name="mic" />
                  <span>Audio</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                className="fab-action"
                onClick={() => startDraft()}
              >
                <Icon name="format" />
                <span>Text</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="fab-action"
                onClick={() => startDraft({ items: [{ text: '', done: false }] })}
              >
                <Icon name="list" />
                <span>List</span>
              </button>
            </div>
          )}
          <button
            type="button"
            className={'fab' + (fabOpen ? ' open' : '')}
            aria-label={fabOpen ? 'Close create menu' : 'Create note'}
            aria-expanded={fabOpen}
            onClick={() => setFabOpen((o) => !o)}
          >
            <Icon name={fabOpen ? 'close' : 'plus'} />
          </button>
        </div>
      )}

      {draft && (
        <div
          className="backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeDraft();
          }}
        >
          <div className="modal" ref={composerRef} style={{ marginTop: 48 }}>
            <Editor
              note={draft}
              knownLabels={labels}
              onChange={(changes) => setDraft({ ...draft, ...changes })}
              onClose={closeDraft}
              onDelete={() => {
                setDraft(null);
                setDraftVoice(false);
                setDraftPanel('');
              }}
              startVoice={draftVoice}
              startPanel={draftPanel}
            />
          </div>
        </div>
      )}

      {confirming && (
        <div
          className="backdrop dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConfirming(null);
          }}
        >
          <div className="modal dialog" style={{ marginTop: confirmingTop }}>
            <div className="card">
              <h2>{confirming.deletedAt === null ? 'Delete this note?' : 'Delete forever?'}</h2>
              <p>
                {confirming.deletedAt === null
                  ? `It can be restored from the trash for ${TRASH_DAYS} days.`
                  : 'This cannot be undone.'}
              </p>
              <div className="popover-actions">
                {confirming.deletedAt === null && (
                  <button className="close icon-btn" title="Move to trash" onClick={() => trash(confirming.id)}>
                    <Icon name="trash" />
                  </button>
                )}
                <button className="close icon-btn danger" title="Delete permanently" onClick={() => remove(confirming.id)}>
                  <Icon name="delete-forever" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div
          className="backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeEditor();
          }}
        >
          <div className="modal" style={{ marginTop: editingTop }}>
            <Editor
              note={editing}
              knownLabels={labels}
              onChange={(changes) => patch(editing.id, changes)}
              onClose={closeEditor}
              onDelete={() => {
                setConfirmingTop(editingTop);
                setConfirming(editing);
              }}
              onPopOut={() => void popOut(editing)}
              startPanel={editingPanel}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type MenuName = 'sort' | 'settings' | 'filter' | null;
export type Filter = 'all' | 'reminders' | 'notes' | 'trash';

/** Icon button with a menu that pops out of it, anchored to the button itself. */
function Menu({
  name,
  tip,
  icon,
  title,
  open,
  onToggle,
  children,
}: {
  name: Exclude<MenuName, null>;
  tip: string;
  icon: string;
  title: string;
  open: boolean;
  onToggle: (name: MenuName) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="menu-anchor">
      <button
        className={'icon-btn' + (open ? ' active' : '')}
        data-tip={tip}
        onClick={() => onToggle(open ? null : name)}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div className="menu">
          <p className="menu-title">{title}</p>
          {children}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  text,
  icon,
  active,
  onPick,
}: {
  text: string;
  icon?: string;
  active?: boolean;
  onPick: () => void;
}) {
  return (
    <button className={'menu-item' + (active ? ' on' : '')} onClick={onPick}>
      <span className="menu-mark">{active ? <Icon name="check" /> : icon && <Icon name={icon} />}</span>
      {text}
    </button>
  );
}

function NoteCard({
  note,
  onOpen,
  onTogglePin,
  onToggleItem,
  onDragStart,
  onDropOn,
  onLabelClick,
  onPopOut,
  onRemind,
  onToggleReminderDone,
  onRestore,
  onDeleteForever,
}: {
  note: Note;
  onOpen: (top: number) => void;
  onTogglePin: () => void;
  onToggleItem: (index: number) => void;
  onDragStart: () => void;
  onDropOn: (place: 'before' | 'after') => void;
  onLabelClick: (label: string) => void;
  onPopOut: () => void;
  onRemind: (top: number) => void;
  onToggleReminderDone: () => void;
  onRestore: () => void;
  onDeleteForever: (top: number) => void;
}) {
  const [over, setOver] = useState<'before' | 'after' | null>(null);
  const [dragging, setDragging] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const placeRef = useRef<'before' | 'after'>('before');
  const trashed = note.deletedAt !== null;

  /** Open the editor level with this card, pulled up if it would hang off-screen. */
  /** Where the editor should sit: level with this card, pulled up to stay on screen. */
  function anchorTop() {
    const top = cardRef.current?.getBoundingClientRect().top ?? 0;
    const room = window.innerHeight - (cardRef.current?.offsetHeight ?? 0) - 160;
    return Math.max(8, Math.min(top, room));
  }

  function open() {
    onOpen(anchorTop());
  }

  // Every path that opens the editor must report the position, or it lands at the top.
  function remind() {
    onRemind(anchorTop());
  }

  function dropPlace(e: DragEvent): 'before' | 'after' {
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return 'before';
    // Grid is 2-column: prefer the pointer's closer edge so cross-column drops feel right.
    const midY = rect.top + rect.height / 2;
    return e.clientY < midY ? 'before' : 'after';
  }

  return (
    <article
      ref={cardRef}
      className={
        'card' +
        (over ? ` drag-over drag-${over}` : '') +
        (dragging ? ' dragging' : '') +
        (note.reminderDone ? ' done' : '')
      }
      style={
        {
          '--card': note.color,
          // Per-card name so each one morphs to its own new slot, not a cross-fade.
          viewTransitionName: 'n' + note.id.replace(/-/g, ''),
        } as React.CSSProperties
      }
      draggable={!trashed}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', note.id);
        setDragging(true);
        onDragStart();
      }}
      onDragEnd={() => {
        setDragging(false);
        setOver(null);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const place = dropPlace(e);
        placeRef.current = place;
        setOver(place);
      }}
      onDragLeave={(e) => {
        // Ignore leave events that are just entering a child inside this card.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setOver(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(null);
        onDropOn(placeRef.current);
      }}
    >
      <div className="card-head">
        <h2 onClick={trashed ? undefined : open}>{note.title || 'Untitled note'}</h2>
        {trashed ? (
          <>
            <button className="icon-btn" onClick={onRestore} data-tip="Put back">
              <Icon name="restore" />
            </button>
            <button
              className="icon-btn"
              onClick={() => onDeleteForever(anchorTop())}
              data-tip="Delete forever"
            >
              <Icon name="trash" />
            </button>
          </>
        ) : (
          <>
        <button
          className={'icon-btn' + (note.remindAt !== null && !note.reminderDone ? ' on' : '')}
          onClick={remind}
          data-tip={note.remindAt === null ? 'Remind me' : 'Change reminder'}
        >
          <Icon name="bell" />
        </button>
        <button className="icon-btn" onClick={onPopOut} data-tip="Pop out into its own window">
          <Icon name="popout" />
        </button>
        <button
          className={'icon-btn' + (note.pinned ? ' on' : '')}
          onClick={onTogglePin}
          data-tip={note.pinned ? 'Unpin' : 'Pin'}
        >
          <Icon name="pin" />
        </button>
          </>
        )}
      </div>
      {(!!note.html || !note.items) && (
        // Safe: HTML is produced by our editor or sanitized on paste.
        <div
          className="card-body"
          onClick={trashed ? undefined : open}
          dangerouslySetInnerHTML={{ __html: note.html }}
        />
      )}
      {note.items && (
        <ul className="checks">
          {note.items.map((item, i) => (
            <li key={i} className={item.done ? 'done' : ''}>
              <input type="checkbox" checked={item.done} onChange={() => onToggleItem(i)} />
              <span onClick={open} dangerouslySetInnerHTML={{ __html: item.text }} />
            </li>
          ))}
        </ul>
      )}
      {(note.remindAt !== null || !!note.labels.length) && (
        <div className="chips">
          {note.remindAt !== null && (
            <span
              className={
                'chip reminder' +
                (note.reminderDone ? ' done' : note.remindAt < Date.now() ? ' overdue' : '')
              }
            >
              <button
                className="tick"
                data-tip={note.reminderDone ? 'Mark as not done' : 'Complete reminder'}
                onClick={onToggleReminderDone}
              >
                <Icon name={note.reminderDone ? 'check' : 'circle'} />
              </button>
              <span onClick={remind}>
                {formatReminder(note.remindAt)}
                {note.repeat && <em>{describeRepeat(note.repeat)}</em>}
              </span>
            </span>
          )}
          {note.labels.map((label) => (
            <button key={label} className="chip" onClick={() => onLabelClick(label)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
