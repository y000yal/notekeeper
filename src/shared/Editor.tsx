import { useEffect, useRef, useState } from 'react';
import { COLORS, stripHtml, type Note, type Repeat, type RepeatUnit } from './notes';
import {
  askNotificationPermission,
  describeRepeat,
  formatReminder,
  nextHour,
  scheduleReminder,
  toInputValue,
} from './reminders';
import { dictationSupported, useDictation } from './dictation';

export function Editor({
  note,
  knownLabels,
  onChange,
  onClose,
  onDelete,
  onPopOut,
  startVoice = false,
  startPanel = '',
}: {
  note: Note;
  knownLabels: string[];
  onChange: (changes: Partial<Note>) => void;
  onClose: () => void;
  onDelete: () => void;
  /** Omitted inside the popped-out window itself — nothing left to pop out of. */
  onPopOut?: () => void;
  startVoice?: boolean;
  /** Opens with this panel already showing (the card's bell opens 'remind'). */
  startPanel?: '' | 'format' | 'color' | 'label' | 'remind';
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState<'' | 'format' | 'color' | 'label' | 'remind'>(startPanel);
  const [labelQuery, setLabelQuery] = useState('');
  const [reminderError, setReminderError] = useState('');
  // Default suggestion: next whole hour.
  const [when, setWhen] = useState(() => toInputValue(note.remindAt ?? nextHour()));
  const items = note.items;

  // Row to focus after the next render (Enter splits a row, Backspace merges up).
  const itemEls = useRef<(HTMLInputElement | null)[]>([]);
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    if (focusRow.current !== null) {
      itemEls.current[focusRow.current]?.focus();
      focusRow.current = null;
    }
  });

  // The contenteditable is uncontrolled, so React never writes to it: seed it on
  // mount, and re-seed when the note changed elsewhere (the other window editing
  // the same note). Never while it has the caret, or typing would fight the sync.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || items) return;
    if (el.innerHTML !== note.html && el.ownerDocument.activeElement !== el) {
      el.innerHTML = note.html;
    }
  }, [items, note.html]);

  const dictation = useDictation((text) => {
    if (items) {
      const next = [...items];
      const last = next[next.length - 1];
      if (last && !last.text) next[next.length - 1] = { ...last, text };
      else next.push({ text, done: false });
      onChange({ items: next });
    } else {
      bodyRef.current?.focus();
      // ownerDocument, not document: this editor also renders in a popped-out window.
      bodyRef.current?.ownerDocument.execCommand('insertText', false, (note.html ? ' ' : '') + text);
      onChange({ html: bodyRef.current?.innerHTML ?? '' });
    }
  });

  const startedRef = useRef(false);
  useEffect(() => {
    if (startVoice && !startedRef.current) {
      startedRef.current = true;
      dictation.toggle();
    }
  }, [startVoice]);

  function exec(command: string, value?: string) {
    bodyRef.current?.focus();
    bodyRef.current?.ownerDocument.execCommand(command, false, value);
    onChange({ html: bodyRef.current?.innerHTML ?? '' });
  }

  async function insertImages(files: FileList | File[]) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const src = await shrinkToDataUrl(file);
      exec('insertHTML', `<img src="${src}">`);
    }
  }

  function setItem(index: number, changes: Partial<{ text: string; done: boolean }>) {
    onChange({ items: items!.map((it, i) => (i === index ? { ...it, ...changes } : it)) });
  }

  function toggleLabel(label: string) {
    onChange({
      labels: note.labels.includes(label)
        ? note.labels.filter((l) => l !== label)
        : [...note.labels, label],
    });
  }

  /** Save or clear the reminder, keeping the alarm in step with the note. */
  async function setReminder(at: number | null, close = true) {
    if (at !== null && !(await askNotificationPermission())) {
      setReminderError('Notifications are off, so the reminder can only show on the note.');
    } else {
      setReminderError('');
    }
    onChange({ remindAt: at, reminderDone: false });
    void scheduleReminder(note.id, at);
    if (close) setPanel('');
  }

  /** Auto-save: every edit of the date is kept, no Save button to forget. */
  function pickWhen(value: string) {
    setWhen(value);
    const ms = new Date(value).getTime();
    if (Number.isFinite(ms) && ms !== note.remindAt) void setReminder(ms, false);
  }

  /** Keep whatever is showing when the panel or the note is closed. */
  function flushReminder() {
    if (panel !== 'remind') return;
    const ms = new Date(when).getTime();
    if (Number.isFinite(ms) && ms !== note.remindAt) void setReminder(ms, false);
  }

  /** 'none' | 'day' | 'week' | 'month' | 'year' | 'custom' from the stored repeat. */
  const repeatKind = !note.repeat ? 'none' : note.repeat.every === 1 ? note.repeat.unit : 'custom';

  /** A month out, so switching to "On date" starts somewhere sensible. */
  function defaultUntil() {
    const d = new Date(note.remindAt ?? Date.now());
    d.setMonth(d.getMonth() + 1);
    d.setHours(23, 59, 0, 0);
    return d.getTime();
  }

  function saveRepeat(repeat: Repeat | null) {
    onChange({ repeat });
    // A repeat is meaningless without a first occurrence, so seed one.
    if (repeat && note.remindAt === null) void setReminder(new Date(when).getTime(), false);
  }

  function pickRepeat(kind: string) {
    if (kind === 'none') return saveRepeat(null);
    if (kind === 'custom') {
      return saveRepeat({ every: Math.max(2, note.repeat?.every ?? 2), unit: note.repeat?.unit ?? 'day', until: note.repeat?.until ?? null });
    }
    saveRepeat({ every: 1, unit: kind as RepeatUnit, until: note.repeat?.until ?? null });
  }

  function completeReminder() {
    onChange({ reminderDone: true });
    void scheduleReminder(note.id, null); // done reminders must not fire
    setPanel('');
  }

  const typed = labelQuery.trim();
  const labelOptions = knownLabels.filter((l) => l.toLowerCase().includes(typed.toLowerCase()));
  const show = (name: typeof panel) => {
    flushReminder();
    setPanel(panel === name ? '' : name);
  };

  return (
    <section className="card editor" style={{ '--card': note.color } as React.CSSProperties}>
      <div className="card-head">
        <input
          className="title"
          value={note.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Title"
          autoFocus={!startVoice}
        />
        {onPopOut && (
          <button className="icon-btn" data-tip="Pop out into its own window" onClick={onPopOut}>
            <Icon name="popout" />
          </button>
        )}
        <button
          className={'icon-btn' + (note.pinned ? ' on' : '')}
          onClick={() => onChange({ pinned: !note.pinned })}
          data-tip={note.pinned ? 'Unpin' : 'Pin'}
        >
          <Icon name="pin" />
        </button>
      </div>

      {items ? (
        <ul className="checks edit">
          {items.map((item, i) => (
            <li key={i} className={item.done ? 'done' : ''}>
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => setItem(i, { done: !item.done })}
              />
              <input
                ref={(el) => {
                  itemEls.current[i] = el;
                }}
                value={item.text}
                placeholder="List item"
                onChange={(e) => setItem(i, { text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    focusRow.current = i + 1;
                    onChange({
                      items: [
                        ...items.slice(0, i + 1),
                        { text: '', done: false },
                        ...items.slice(i + 1),
                      ],
                    });
                  } else if (e.key === 'Backspace' && !item.text && items.length > 1) {
                    e.preventDefault();
                    focusRow.current = Math.max(0, i - 1);
                    onChange({ items: items.filter((_, j) => j !== i) });
                  }
                }}
              />
              <button
                className="icon-btn"
                data-tip="Remove item"
                onClick={() => onChange({ items: items.filter((_, j) => j !== i) })}
              >
                <Icon name="close" />
              </button>
            </li>
          ))}
          <li>
            <button
              className="add-item"
              onClick={() => {
                focusRow.current = items.length;
                onChange({ items: [...items, { text: '', done: false }] });
              }}
            >
              + List item
            </button>
          </li>
        </ul>
      ) : (
        <div
          ref={bodyRef}
          className="body"
          contentEditable
          suppressContentEditableWarning
          data-placeholder="Take a note..."
          onInput={() => onChange({ html: bodyRef.current?.innerHTML ?? '' })}
          onPaste={(e) => {
            // Trust boundary: pasted markup never enters stored HTML. Images are
            // taken from the clipboard as files and re-encoded by us instead.
            e.preventDefault();
            const files = [...e.clipboardData.files];
            if (files.length) void insertImages(files);
            else exec('insertText', e.clipboardData.getData('text/plain'));
          }}
        />
      )}

      {note.remindAt !== null && (
        <div className="chips">
          <span className={'chip reminder' + (note.reminderDone ? ' done' : '')}>
            <Icon name="bell" />
            {formatReminder(note.remindAt)}
            {note.repeat && <em>{describeRepeat(note.repeat)}</em>}
            <button data-tip="Remove reminder" onClick={() => setReminder(null)}>
              <Icon name="close" />
            </button>
          </span>
        </div>
      )}

      {!!note.labels.length && (
        <div className="chips">
          {note.labels.map((label) => (
            <span key={label} className="chip">
              {label}
              <button data-tip="Remove label" onClick={() => toggleLabel(label)}>
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      )}

      {dictation.listening && (
        <p className="interim">
          <span className="rec" /> Listening... {dictation.interim}
        </p>
      )}
      {dictation.error && <p className="error">{dictation.error}</p>}

      {panel === 'format' && !items && (
        <div className="toolbar format">
          <button onClick={() => exec('formatBlock', 'h1')} data-tip="Heading 1">H1</button>
          <button onClick={() => exec('formatBlock', 'h2')} data-tip="Heading 2">H2</button>
          <button onClick={() => exec('formatBlock', 'p')} data-tip="Normal text">Aa</button>
          <i className="sep" />
          <button onClick={() => exec('bold')} data-tip="Bold"><b>B</b></button>
          <button onClick={() => exec('italic')} data-tip="Italic"><i>I</i></button>
          <button onClick={() => exec('underline')} data-tip="Underline"><u>U</u></button>
          <button onClick={() => exec('removeFormat')} data-tip="Clear formatting">
            T&#8203;<sub>x</sub>
          </button>
        </div>
      )}

      <div className="toolbar bottom">
        {!items && (
          <button
            className={'icon-btn' + (panel === 'format' ? ' active' : '')}
            data-tip="Formatting options"
            onClick={() => show('format')}
          >
            <Icon name="format" />
          </button>
        )}
        <button
          className={'icon-btn' + (panel === 'color' ? ' active' : '')}
          data-tip="Background colour"
          onClick={() => show('color')}
        >
          <Icon name="palette" />
        </button>
        <div className="menu-anchor">
          <button
            className={
              'icon-btn' + (panel === 'remind' ? ' active' : '') + (note.remindAt ? ' on' : '')
            }
            data-tip={note.remindAt ? 'Change reminder' : 'Remind me'}
            onClick={() => show('remind')}
          >
            <Icon name="bell" />
          </button>
          {panel === 'remind' && (
            <div className="popover dropdown">
              <p className="popover-title">Remind me</p>
              <input
                className="when"
                type="datetime-local"
                value={when}
                onChange={(e) => pickWhen(e.target.value)}
              />
              {new Date(when).getTime() < Date.now() && (
                <p className="hint">That time has passed, so it will notify immediately.</p>
              )}
              <label className="field">
                <span>Repeat</span>
                <select value={repeatKind} onChange={(e) => pickRepeat(e.target.value)}>
                  <option value="none">Does not repeat</option>
                  <option value="day">Daily</option>
                  <option value="week">Weekly</option>
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                  <option value="custom">Custom...</option>
                </select>
              </label>

              {note.repeat && repeatKind === 'custom' && (
                <label className="field">
                  <span>Every</span>
                  <input
                    className="every"
                    type="number"
                    min={1}
                    max={365}
                    value={note.repeat.every}
                    onChange={(e) =>
                      saveRepeat({ ...note.repeat!, every: Math.max(1, +e.target.value || 1) })
                    }
                  />
                  <select
                    value={note.repeat.unit}
                    onChange={(e) => saveRepeat({ ...note.repeat!, unit: e.target.value as RepeatUnit })}
                  >
                    <option value="day">days</option>
                    <option value="week">weeks</option>
                    <option value="month">months</option>
                    <option value="year">years</option>
                  </select>
                </label>
              )}

              {note.repeat && (
                <label className="field">
                  <span>Ends</span>
                  <select
                    value={note.repeat.until === null ? 'never' : 'on'}
                    onChange={(e) =>
                      saveRepeat({
                        ...note.repeat!,
                        until: e.target.value === 'never' ? null : defaultUntil(),
                      })
                    }
                  >
                    <option value="never">Never</option>
                    <option value="on">On date</option>
                  </select>
                </label>
              )}

              {note.repeat?.until != null && (
                <input
                  className="when"
                  type="date"
                  value={toInputValue(note.repeat.until).slice(0, 10)}
                  onChange={(e) => {
                    const ms = new Date(`${e.target.value}T23:59`).getTime();
                    if (Number.isFinite(ms)) saveRepeat({ ...note.repeat!, until: ms });
                  }}
                />
              )}

              {note.remindAt !== null && !note.reminderDone && (
                <div className="popover-actions">
                  <button className="close" onClick={completeReminder}>
                    Complete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          className={'icon-btn' + (panel === 'label' ? ' active' : '')}
          data-tip="Label note"
          onClick={() => show('label')}
        >
          <Icon name="label" />
        </button>
        {!items && (
          <>
            <button className="icon-btn" data-tip="Add image" onClick={() => fileRef.current?.click()}>
              <Icon name="image" />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void insertImages(e.target.files);
                e.target.value = '';
              }}
            />
          </>
        )}
        {dictationSupported && (
          <button
            className={'icon-btn' + (dictation.listening ? ' rec-on' : '')}
            data-tip={dictation.listening ? 'Stop dictation' : 'Dictate'}
            onClick={dictation.toggle}
          >
            <Icon name="mic" />
          </button>
        )}
        <button
          className="icon-btn"
          data-tip={items ? 'Convert to text' : 'Convert to list'}
          onClick={() =>
            items
              ? onChange({ items: null, html: items.map((i) => i.text).join('<br>') })
              : onChange({
                  items: (stripHtml(note.html).split('\n').filter(Boolean).length
                    ? stripHtml(note.html).split('\n').filter(Boolean)
                    : ['']
                  ).map((text) => ({ text, done: false })),
                  html: '',
                })
          }
        >
          <Icon name="list" />
        </button>
        <button className="icon-btn" data-tip="Delete note" onClick={onDelete}>
          <Icon name="trash" />
        </button>
        <button
          className="close"
          onClick={() => {
            dictation.stop();
            flushReminder();
            onClose();
          }}
        >
          Close
        </button>
      </div>

      {panel === 'color' && (
        <div className="palette">
          {COLORS.map((color) => (
            <button
              key={color}
              style={{ background: color }}
              className={color === note.color ? 'on' : ''}
              data-tip={color}
              onClick={() => {
                onChange({ color });
                setPanel('');
              }}
            />
          ))}
        </div>
      )}


      {reminderError && <p className="hint">{reminderError}</p>}

      {panel === 'label' && (
        <div className="popover">
          <p className="popover-title">Label note</p>
          <div className="popover-search">
            <input
              value={labelQuery}
              placeholder="Enter label name"
              autoFocus
              onChange={(e) => setLabelQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !typed) return;
                if (!note.labels.includes(typed)) toggleLabel(typed);
                setLabelQuery('');
              }}
            />
            <Icon name="search" />
          </div>
          <ul>
            {labelOptions.map((label) => (
              <li key={label}>
                <label>
                  <input
                    type="checkbox"
                    checked={note.labels.includes(label)}
                    onChange={() => toggleLabel(label)}
                  />
                  {label}
                </label>
              </li>
            ))}
          </ul>
          {typed && !knownLabels.includes(typed) && (
            <button
              className="create-label"
              onClick={() => {
                toggleLabel(typed);
                setLabelQuery('');
              }}
            >
              <Icon name="plus" /> Create "{typed}"
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Clipboard screenshots and phone photos are far too big for the 10 MB
 * chrome.storage.local quota, so re-encode to a bounded JPEG.
 * ponytail: fixed 1200px cap; make it a setting only if someone complains.
 */
async function shrinkToDataUrl(file: File, max = 1200): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // JPEG has no alpha; transparency would go black.
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

const PATHS: Record<string, string> = {
  search:
    'M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  pin: 'M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1a1 1 0 0 0 0-2z',
  mic: 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72z',
  list: 'M3 5h2v2H3zm0 6h2v2H3zm0 6h2v2H3zM7 5h14v2H7zm0 6h14v2H7zm0 6h14v2H7z',
  palette:
    'M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1-.24-.27-.39-.62-.39-1 0-.83.67-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4.5 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
  'delete-forever':
    'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8.46 11.88l1.41-1.41L12 12.59l2.12-2.12 1.41 1.41L13.41 14l2.12 2.12-1.41 1.41L12 15.41l-2.12 2.12-1.41-1.41L10.59 14zM15.5 4l-1-1h-5l-1 1H5v2h14V4z',
  // "A" with an underline — the formatting toggle.
  format: 'M5 19h14v2H5zm4.2-4h1.9l1-2.6h3.8l1 2.6h1.9L15 3h-2zm2.4-4.1 1.4-3.9 1.4 3.9z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5z',
  label:
    'M17.63 5.84A2 2 0 0 0 16 5H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 1.63-.84L22 12z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  bell: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6v-5a6 6 0 0 0-4.5-5.8V4a1.5 1.5 0 0 0-3 0v1.2A6 6 0 0 0 6 11v5l-1.7 1.7V19h15.4v-1.3z',
  circle: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z',
  restore: 'M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 7 7 6.9 6.9 0 0 1-4.9-2l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2V8z',
  filter: 'M4 6h16v2H4zm3 5h10v2H7zm3 5h4v2h-4z',
  filterOn: 'M4 6h16v2H4zm3 5h10v2H7zm3 5h4v2h-4zM17 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  popout:
    'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z',
  moon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-9.54-4.32A5.4 5.4 0 0 1 13.36 3.1c-.44-.06-.9-.1-1.36-.1z',
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm-1-5h2v3h-2zm0 17h2v3h-2zM2 11h3v2H2zm17 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM5.6 19.8l-1.4-1.4 2.1-2.1 1.4 1.4zM17.7 7.7l-1.4-1.4 2.1-2.1 1.4 1.4z',
  grid: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z',
  sort: 'M3 18h6v-2H3zM3 6v2h18V6zm0 7h12v-2H3z',
  settings:
    'M19.14 12.94a7.1 7.1 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.1 7.1 0 0 0 0 1.88L2.77 14.5a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.58-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z',
  listView: 'M3 4h18v3H3zm0 6.5h18v3H3zM3 17h18v3H3z',
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d={PATHS[name] ?? ''} fill="currentColor" />
    </svg>
  );
}
