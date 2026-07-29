import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { matchEmojis } from './emojis';
import { COLORS, blocksFromHtml, htmlFromBlocks, looksLikeCode, sanitizePastedHtml, selectedHtmlIn, stripHtml, wrapAsCodeBlock, type Note, type Repeat, type RepeatUnit } from './notes';
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
  const [inkPick, setInkPick] = useState<'' | 'fore' | 'mark'>('');
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [emojiPos, setEmojiPos] = useState<{ top: number; left: number } | null>(null);
  const [reminderError, setReminderError] = useState('');
  // Default suggestion: next whole hour.
  const [when, setWhen] = useState(() => toInputValue(note.remindAt ?? nextHour()));
  const items = note.items;

  // Row to focus after the next render (Enter splits a row, Backspace merges up).
  const itemEls = useRef<(HTMLDivElement | null)[]>([]);
  const focusRow = useRef<number | null>(null);
  useEffect(() => {
    if (focusRow.current !== null) {
      itemEls.current[focusRow.current]?.focus();
      focusRow.current = null;
    }
  });

  // Keep checklist row HTML in sync when rows are added/removed or updated elsewhere.
  useEffect(() => {
    items?.forEach((item, i) => {
      const el = itemEls.current[i];
      if (!el) return;
      if (el.ownerDocument.activeElement === el) return;
      if (el.innerHTML !== item.text) el.innerHTML = item.text;
    });
  }, [items]);

  // The contenteditable is uncontrolled, so React never writes to it: seed it on
  // mount, and re-seed when the note changed elsewhere (the other window editing
  // the same note). Never while it has the caret, or typing would fight the sync.
  const showBody = !items || !!note.html;
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !showBody) return;
    if (el.innerHTML !== note.html && el.ownerDocument.activeElement !== el) {
      el.innerHTML = note.html;
    }
  }, [showBody, note.html]);

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

  /** Text colour or highlight — keep the caret in the body so the command lands on the selection. */
  function paint(kind: 'foreColor' | 'hiliteColor', color: string) {
    bodyRef.current?.focus();
    const doc = bodyRef.current?.ownerDocument;
    if (!doc) return;
    // styleWithCSS makes Chrome wrap with <span style="..."> instead of <font>.
    doc.execCommand('styleWithCSS', false, 'true');
    doc.execCommand(kind, false, color);
    onChange({ html: bodyRef.current?.innerHTML ?? '' });
  }

  async function insertImages(files: FileList | File[]) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const src = await shrinkToDataUrl(file);
      exec('insertHTML', `<img src="${src}">`);
    }
  }

  /** Prefer formatted clipboard HTML; fall back to plain text. Images still go through re-encode. */
  function pasteInto(e: ClipboardEvent, onHtml: (html: string) => void) {
    e.preventDefault();
    const files = [...e.clipboardData.files];
    if (files.some((f) => f.type.startsWith('image/'))) {
      void insertImages(files);
      return;
    }
    const rich = e.clipboardData.getData('text/html');
    const plain = e.clipboardData.getData('text/plain');
    if (rich) {
      const clean = sanitizePastedHtml(rich);
      if (clean) {
        // IDE paste sometimes arrives as HTML without <pre>; promote plain code.
        if (!/<pre[\s>]/i.test(clean) && looksLikeCode(plain)) onHtml(wrapAsCodeBlock(plain));
        else onHtml(clean);
        return;
      }
    }
    if (plain) {
      if (looksLikeCode(plain)) onHtml(wrapAsCodeBlock(plain));
      else exec('insertText', plain);
    }
  }

  /** Wrap the selection (or insert an empty block) as a code snippet. */
  function insertCodeBlock() {
    const body = bodyRef.current;
    if (!body) return;
    body.focus();
    const sel = body.ownerDocument.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : '';
    exec('insertHTML', `${wrapAsCodeBlock(text || '')}<div><br></div>`);
  }

  function noticeAtCaret(root: HTMLElement): HTMLElement | null {
    const sel = root.ownerDocument.getSelection();
    let node: Node | null = sel?.anchorNode ?? null;
    while (node && node !== root) {
      if (node instanceof HTMLElement && node.classList.contains('notice')) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** Nearest bullet/numbered list around the caret. */
  function listAtCaret(root: HTMLElement): HTMLElement | null {
    const sel = root.ownerDocument.getSelection();
    let node: Node | null = sel?.anchorNode ?? null;
    while (node && node !== root) {
      if (node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL')) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  function isExitBlock(el: HTMLElement): boolean {
    return (
      el.classList.contains('notice') ||
      el.tagName === 'UL' ||
      el.tagName === 'OL' ||
      el.tagName === 'PRE' ||
      (el.tagName === 'CODE' && el.parentElement?.tagName !== 'PRE')
    );
  }

  /** Closest exit-able block to the caret (list inside notice → list first). */
  function innermostExitBlock(root: HTMLElement): HTMLElement | null {
    const sel = root.ownerDocument.getSelection();
    let node: Node | null = sel?.anchorNode ?? null;
    while (node && node !== root) {
      if (node instanceof HTMLElement && isExitBlock(node)) return node;
      node = node.parentNode;
    }
    return null;
  }

  function noticeIsEmpty(el: HTMLElement): boolean {
    const text = (el.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    return !text;
  }

  function placeCaretAfter(el: HTMLElement, root: HTMLElement) {
    const doc = root.ownerDocument;
    const sel = doc.getSelection();
    if (!sel) return;
    const parent = (el.parentNode as HTMLElement | null) ?? root;
    let target: Node | null = el.nextSibling;
    if (!target) {
      const blank = doc.createElement('div');
      blank.innerHTML = '<br>';
      parent.append(blank);
      target = blank;
    }
    const range = doc.createRange();
    range.selectNodeContents(target);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    root.focus();
  }

  /**
   * Leave only the immediate block (list / code / notice). Nested case:
   * list inside notice → first Shift+Enter stays in the notice after the list.
   */
  function exitBlock(el: HTMLElement, root: HTMLElement) {
    const doc = root.ownerDocument;
    const parent = (el.parentNode as HTMLElement | null) ?? root;
    const blank = doc.createElement('div');
    blank.innerHTML = '<br>';
    if (el.nextSibling) parent.insertBefore(blank, el.nextSibling);
    else parent.append(blank);
    const sel = doc.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(blank);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    root.focus();
    onChange({ html: root.innerHTML });
  }

  function onBodyKeyDown(e: KeyboardEvent) {
    onEmojiKeyDown(e, bodyRef.current);
    if (e.defaultPrevented) return;
    const body = bodyRef.current;
    if (!body) return;
    const notice = noticeAtCaret(body);
    const list = listAtCaret(body);
    const exitTarget = innermostExitBlock(body);

    // Shift+Enter: peel off one nesting level (list → notice → body, etc.).
    if (e.key === 'Enter' && e.shiftKey && exitTarget) {
      e.preventDefault();
      exitBlock(exitTarget, body);
      return;
    }

    // Enter inside a bullet/numbered list → always add another item (exit is Shift+Enter).
    if (e.key === 'Enter' && !e.shiftKey && list) {
      e.preventDefault();
      const sel = body.ownerDocument.getSelection();
      let li: HTMLElement | null = null;
      let node: Node | null = sel?.anchorNode ?? null;
      while (node && node !== list) {
        if (node instanceof HTMLElement && node.tagName === 'LI') {
          li = node;
          break;
        }
        node = node.parentNode;
      }
      const doc = body.ownerDocument;
      const next = doc.createElement('li');
      next.innerHTML = '<br>';
      if (li?.parentNode === list) li.after(next);
      else list.append(next);
      const range = doc.createRange();
      range.selectNodeContents(next);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      body.focus();
      onChange({ html: body.innerHTML });
      return;
    }

    // Enter inside a code block → line break inside the block.
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      exitTarget &&
      (exitTarget.tagName === 'PRE' || exitTarget.tagName === 'CODE')
    ) {
      e.preventDefault();
      body.ownerDocument.execCommand('insertLineBreak');
      onChange({ html: body.innerHTML });
      return;
    }

    if (!notice) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      // Stay inside the notice — a normal Enter would split it into another notice.
      e.preventDefault();
      body.ownerDocument.execCommand('insertLineBreak');
      onChange({ html: body.innerHTML });
      return;
    }

    if (e.key === 'Backspace' && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const sel = body.ownerDocument.getSelection();
      if (!sel?.isCollapsed || !sel.rangeCount) return;

      // Empty notice: delete the whole bar (including when it's the last block).
      if (noticeIsEmpty(notice)) {
        e.preventDefault();
        placeCaretAfter(notice, body);
        notice.remove();
        // Body must not be left completely empty — contenteditable collapses oddly.
        if (!body.innerHTML.trim()) body.innerHTML = '<div><br></div>';
        onChange({ html: body.innerHTML });
        return;
      }

      // Caret at the very start of a non-empty notice + backspace → remove the notice wrapper,
      // keeping its text as a normal block (so the "last notice" can still be cleared).
      const probe = sel.getRangeAt(0).cloneRange();
      probe.selectNodeContents(notice);
      probe.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      if ((probe.toString() || '').length === 0) {
        e.preventDefault();
        const html = notice.innerHTML || '<br>';
        const wrap = body.ownerDocument.createElement('div');
        wrap.innerHTML = html;
        notice.replaceWith(wrap);
        const range = body.ownerDocument.createRange();
        range.selectNodeContents(wrap);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        onChange({ html: body.innerHTML });
      }
    }
  }

  /** Info / warning / danger callout. Re-applies type if the caret is already in one. */
  function insertNotice(kind: 'info' | 'warning' | 'danger') {
    const body = bodyRef.current;
    if (!body) return;
    body.focus();
    const sel = body.ownerDocument.getSelection();
    let node: Node | null = sel?.anchorNode ?? null;
    while (node && node !== body) {
      if (node instanceof HTMLElement && node.classList.contains('notice')) {
        node.className = `notice ${kind}`;
        node.dataset.notice = kind;
        onChange({ html: body.innerHTML });
        return;
      }
      node = node.parentNode;
    }
    const picked = selectedHtmlIn(body);
    const content = picked || '<br>';
    const marker = `notice-${Date.now()}`;
    body.ownerDocument.execCommand(
      'insertHTML',
      false,
      `<div class="notice ${kind}" data-notice="${kind}" data-caret="${marker}">${content}</div>`,
    );
    const notice = body.querySelector(`[data-caret="${marker}"]`) as HTMLElement | null;
    if (notice) {
      notice.removeAttribute('data-caret');
      const range = body.ownerDocument.createRange();
      const pick = body.ownerDocument.getSelection();
      range.selectNodeContents(notice);
      range.collapse(true);
      pick?.removeAllRanges();
      pick?.addRange(range);
      body.focus();
    }
    onChange({ html: body.innerHTML });
  }

  const emojiMatches = emojiQuery !== null ? matchEmojis(emojiQuery) : [];

  function textBeforeCaret(root: HTMLElement): string {
    const sel = root.ownerDocument.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return '';
    const end = sel.getRangeAt(0);
    const range = end.cloneRange();
    range.selectNodeContents(root);
    range.setEnd(end.startContainer, end.startOffset);
    return range.toString();
  }

  function syncEmojiPicker(root: HTMLElement | null) {
    if (!root) {
      setEmojiQuery(null);
      return;
    }
    const before = textBeforeCaret(root);
    const m = before.match(/(?:^|[\s\n\u00a0]):([a-z0-9_+-]{0,30})$/i);
    if (!m) {
      setEmojiQuery(null);
      setEmojiPos(null);
      return;
    }
    setEmojiQuery(m[1] ?? '');
    setEmojiIndex(0);
    const sel = root.ownerDocument.getSelection();
    const rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (rect && (rect.height || rect.width)) {
      setEmojiPos({ top: rect.bottom + 6, left: Math.min(rect.left, window.innerWidth - 220) });
    } else {
      const host = root.getBoundingClientRect();
      setEmojiPos({ top: host.bottom, left: host.left });
    }
  }

  function insertEmoji(char: string, root: HTMLElement | null) {
    if (!root || emojiQuery === null) return;
    root.focus();
    const sel = root.ownerDocument.getSelection();
    if (!sel) return;
    const token = `:${emojiQuery}`;
    // Walk the caret back over the typed `:query` token, then replace with the emoji.
    for (let i = 0; i < token.length; i++) sel.modify('extend', 'backward', 'character');
    sel.deleteFromDocument();
    root.ownerDocument.execCommand('insertText', false, char);
    setEmojiQuery(null);
    setEmojiPos(null);
    if (root === bodyRef.current) onChange({ html: root.innerHTML });
  }

  function onEmojiKeyDown(e: KeyboardEvent, root: HTMLElement | null) {
    if (emojiQuery === null || !emojiMatches.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setEmojiIndex((i) => (i + 1) % emojiMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setEmojiIndex((i) => (i - 1 + emojiMatches.length) % emojiMatches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertEmoji(emojiMatches[emojiIndex]?.char ?? emojiMatches[0]!.char, root);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEmojiQuery(null);
      setEmojiPos(null);
    } else if (e.key === ':' && emojiQuery) {
      // `:smile:` — exact shortcode closed with a second colon.
      const exact = emojiMatches.find((m) => m.name === emojiQuery.toLowerCase());
      if (exact) {
        e.preventDefault();
        insertEmoji(exact.char, root);
      }
    }
  }

  function setItem(index: number, changes: Partial<{ text: string; done: boolean }>) {
    onChange({ items: items!.map((it, i) => (i === index ? { ...it, ...changes } : it)) });
  }

  /** Checklist ↔ text: keep inline HTML, and only turn the selection into rows when there is one. */
  function toggleList() {
    if (items) {
      const fromItems = htmlFromBlocks(items.map((i) => i.text));
      onChange({ items: null, html: note.html ? note.html + fromItems : fromItems });
      return;
    }

    const body = bodyRef.current;
    const liveHtml = body?.innerHTML ?? note.html;
    const picked = body ? selectedHtmlIn(body) : null;

    if (picked && body) {
      const sel = body.ownerDocument.getSelection();
      const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (range) {
        range.deleteContents();
        // Chrome can leave an empty husk; normalise so leftover text stays readable.
        const remaining = body.innerHTML.replace(/^(<br\s*\/?>)+|(<br\s*\/?>)+$/gi, '').trim();
        const rows = blocksFromHtml(picked);
        onChange({
          html: remaining,
          items: (rows.length ? rows : ['']).map((text) => ({ text, done: false })),
        });
        return;
      }
    }

    const rows = blocksFromHtml(liveHtml);
    onChange({
      html: '',
      items: (rows.length ? rows : ['']).map((text) => ({ text, done: false })),
    });
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
    setInkPick('');
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

      {showBody && (
        <div
          ref={bodyRef}
          className="body"
          contentEditable
          suppressContentEditableWarning
          data-placeholder="Take a note..."
          onInput={() => {
            onChange({ html: bodyRef.current?.innerHTML ?? '' });
            syncEmojiPicker(bodyRef.current);
          }}
          onKeyDown={onBodyKeyDown}
          onBlur={() => {
            setTimeout(() => setEmojiQuery(null), 150);
          }}
          onPaste={(e) =>
            pasteInto(e, (html) => {
              exec('insertHTML', html);
            })
          }
        />
      )}

      {emojiQuery !== null && emojiPos && emojiMatches.length > 0 && (
        <div
          className="emoji-picker"
          style={{ top: emojiPos.top, left: emojiPos.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {emojiMatches.map((e, i) => (
            <button
              key={e.name}
              type="button"
              className={i === emojiIndex ? 'on' : ''}
              onMouseEnter={() => setEmojiIndex(i)}
              onClick={() => {
                const active =
                  bodyRef.current?.ownerDocument.activeElement instanceof HTMLElement
                    ? bodyRef.current.ownerDocument.activeElement
                    : bodyRef.current;
                insertEmoji(e.char, active);
              }}
            >
              <span className="emoji-char">{e.char}</span>
              <span className="emoji-name">:{e.name}:</span>
            </button>
          ))}
        </div>
      )}

      {items ? (
        <ul className="checks edit">
          {items.map((item, i) => (
            <li key={i} className={item.done ? 'done' : ''}>
              <input
                type="checkbox"
                checked={item.done}
                onChange={() => setItem(i, { done: !item.done })}
              />
              <div
                ref={(el) => {
                  itemEls.current[i] = el;
                }}
                className="check-text"
                contentEditable
                suppressContentEditableWarning
                data-placeholder="List item"
                onInput={(e) => {
                  const el = e.target as HTMLDivElement;
                  setItem(i, { text: el.innerHTML });
                  syncEmojiPicker(el);
                }}
                onKeyDown={(e) => {
                  onEmojiKeyDown(e, itemEls.current[i] ?? null);
                  if (e.defaultPrevented) return;
                  if (e.key === 'Enter' && e.shiftKey) {
                    // Leave the checklist and continue typing in the note body below.
                    e.preventDefault();
                    const blank = note.html?.trim() ? note.html : '';
                    onChange({ html: blank + '<div><br></div>' });
                    requestAnimationFrame(() => {
                      const body = bodyRef.current;
                      if (!body) return;
                      body.focus();
                      const sel = body.ownerDocument.getSelection();
                      const range = body.ownerDocument.createRange();
                      range.selectNodeContents(body);
                      range.collapse(false);
                      sel?.removeAllRanges();
                      sel?.addRange(range);
                    });
                    return;
                  }
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
                  } else if (
                    e.key === 'Backspace' &&
                    !stripHtml(item.text).trim() &&
                    items.length > 1
                  ) {
                    e.preventDefault();
                    focusRow.current = Math.max(0, i - 1);
                    onChange({ items: items.filter((_, j) => j !== i) });
                  }
                }}
                onPaste={(e) =>
                  pasteInto(e, (html) => {
                    const el = itemEls.current[i];
                    el?.focus();
                    el?.ownerDocument.execCommand('insertHTML', false, html);
                    setItem(i, { text: el?.innerHTML ?? html });
                  })
                }
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
      ) : null}

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

      {panel === 'format' && showBody && (
        <>
          <div className="toolbar format">
            <button onClick={() => exec('formatBlock', 'h1')} data-tip="Heading 1">H1</button>
            <button onClick={() => exec('formatBlock', 'h2')} data-tip="Heading 2">H2</button>
            <button onClick={() => exec('formatBlock', 'p')} data-tip="Normal text">Aa</button>
            <i className="sep" />
            <button onClick={() => exec('bold')} data-tip="Bold"><b>B</b></button>
            <button onClick={() => exec('italic')} data-tip="Italic"><i>I</i></button>
            <button onClick={() => exec('underline')} data-tip="Underline"><u>U</u></button>
            <i className="sep" />
            <button onClick={() => exec('insertUnorderedList')} data-tip="Bullet list">
              <Icon name="bullets" />
            </button>
            <button onClick={() => exec('insertOrderedList')} data-tip="Numbered list">
              <Icon name="numbers" />
            </button>
            <button onClick={insertCodeBlock} data-tip="Code snippet">
              <Icon name="code" />
            </button>
            <i className="sep" />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertNotice('info')}
              data-tip="Info notice"
            >
              <Icon name="noticeInfo" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertNotice('warning')}
              data-tip="Warning notice"
            >
              <Icon name="noticeWarning" />
            </button>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertNotice('danger')}
              data-tip="Danger notice"
            >
              <Icon name="noticeDanger" />
            </button>
            <i className="sep" />
            <button
              className={inkPick === 'fore' ? 'active' : ''}
              data-tip="Text colour"
              onClick={() => setInkPick(inkPick === 'fore' ? '' : 'fore')}
            >
              <Icon name="textColor" />
            </button>
            <button
              className={inkPick === 'mark' ? 'active' : ''}
              data-tip="Highlight"
              onClick={() => setInkPick(inkPick === 'mark' ? '' : 'mark')}
            >
              <Icon name="highlight" />
            </button>
            <button onClick={() => exec('removeFormat')} data-tip="Clear formatting">
              T&#8203;<sub>x</sub>
            </button>
          </div>
          {inkPick === 'fore' && (
            <div className="palette ink">
              {TEXT_COLORS.map((color) => (
                <button
                  key={color}
                  style={{ background: color }}
                  data-tip={color === '#202124' ? 'Default' : color}
                  className={color === '#202124' ? 'ink-default' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => paint('foreColor', color)}
                />
              ))}
            </div>
          )}
          {inkPick === 'mark' && (
            <div className="palette ink">
              {HIGHLIGHT_COLORS.map((color) => (
                <button
                  key={color}
                  style={{ background: color === 'transparent' ? '#fff' : color }}
                  data-tip={color === 'transparent' ? 'No highlight' : color}
                  className={color === 'transparent' ? 'ink-clear' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => paint('hiliteColor', color)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="toolbar bottom">
        {showBody && (
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
        {showBody && (
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
          onClick={toggleList}
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

const TEXT_COLORS = [
  '#202124',
  '#d93025',
  '#e37400',
  '#f9ab00',
  '#188038',
  '#1a73e8',
  '#a142f4',
  '#e52592',
];

const HIGHLIGHT_COLORS = [
  'transparent',
  '#f28b82',
  '#fbbc04',
  '#fff475',
  '#ccff90',
  '#a7ffeb',
  '#aecbfa',
  '#d7aefb',
  '#fdcfe8',
];

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
  bullets:
    'M4 10.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0 6a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm0-12a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM8 5h12v2H8zm0 6h12v2H8zm0 6h12v2H8z',
  numbers:
    'M2 17h2v.5H3v1h1v.5H2v1h3v-4H2zm1-9h1V4H2v1h1zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2zm5-6h14v2H7zm0 6h14v2H7zm0 6h14v2H7z',
  code: 'M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6z',
  noticeInfo:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 15h-2v-6h2zm0-8h-2V7h2z',
  noticeWarning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2zm0-4h-2v-4h2z',
  noticeDanger:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 15h-2v-2h2zm0-4h-2V7h2z',
  palette:
    'M12 3a9 9 0 0 0 0 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1-.24-.27-.39-.62-.39-1 0-.83.67-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4.5 4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
  'delete-forever':
    'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM8.46 11.88l1.41-1.41L12 12.59l2.12-2.12 1.41 1.41L13.41 14l2.12 2.12-1.41 1.41L12 15.41l-2.12 2.12-1.41-1.41L10.59 14zM15.5 4l-1-1h-5l-1 1H5v2h14V4z',
  // "A" with an underline — the formatting toggle.
  format: 'M5 19h14v2H5zm4.2-4h1.9l1-2.6h3.8l1 2.6h1.9L15 3h-2zm2.4-4.1 1.4-3.9 1.4 3.9z',
  textColor:
    'M5 19h14v2H5zm4.2-4h1.9l1-2.6h3.8l1 2.6h1.9L15 3h-2zm2.4-4.1 1.4-3.9 1.4 3.9zM3 21h18v2H3z',
  highlight:
    'M15.16 2.76a1 1 0 0 1 1.41 0l4.67 4.67a1 1 0 0 1 0 1.41l-8.5 8.5-1.06.35-3.18 3.18a1 1 0 0 1-1.41 0l-.71-.71a1 1 0 0 1 0-1.41l3.18-3.18.35-1.06zM3 19.5 4.5 21H3z',
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
