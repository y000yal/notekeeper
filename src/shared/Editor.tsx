import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
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
import { dictationSupported, formatElapsed, useDictation, useVoiceLevels } from './dictation';

export function Editor({
  note,
  knownLabels,
  onChange,
  onClose,
  onDelete,
  onPopOut,
  startVoice = false,
  startImage = false,
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
  /** Open the image picker once on mount (new-note FAB → Image). */
  startImage?: boolean;
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
  const voiceLevels = useVoiceLevels(dictation.listening);

  const startedRef = useRef(false);
  useEffect(() => {
    if (startVoice && !startedRef.current) {
      startedRef.current = true;
      dictation.toggle();
    }
  }, [startVoice]);

  const startedImageRef = useRef(false);
  useEffect(() => {
    if (startImage && !startedImageRef.current) {
      startedImageRef.current = true;
      // Let the modal paint first so the picker isn't blocked.
      const id = requestAnimationFrame(() => fileRef.current?.click());
      return () => cancelAnimationFrame(id);
    }
  }, [startImage]);

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
    <section
      className={'card editor' + (dictation.listening ? ' recording' : '')}
      style={{ '--card': note.color } as React.CSSProperties}
    >
      <div className="card-head">
        <input
          className="title"
          value={note.title}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder="Title"
          autoFocus={!startVoice}
        />
        {dictation.listening && (
          <span className="rec-timer" aria-live="polite">
            <span className="rec" />
            {formatElapsed(dictation.elapsed)}
          </span>
        )}
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
        <div className="voice-stage">
          {dictation.interim ? (
            <p className="interim-text">
              {dictation.interim}
              <span className="voice-caret" />
            </p>
          ) : null}
          <div className="voice-wave" aria-hidden="true">
            {voiceLevels.map((level, i) => (
              <span
                key={i}
                className={level > 0.22 ? 'on' : ''}
                style={{ height: `${Math.round(8 + level * 28)}px` }}
              />
            ))}
          </div>
        </div>
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
                  data-tip={color === '#202020' ? 'Default' : color}
                  className={color === '#202020' ? 'ink-default' : ''}
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

      {dictation.listening && (
        <div className="mic-row">
          <button
            className="mic-fab pulsing"
            data-tip="Stop dictation"
            onClick={dictation.toggle}
          >
            <Icon name="mic" />
          </button>
        </div>
      )}

      <div className={'toolbar bottom' + (dictation.listening ? ' recording-bar' : '')}>
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
                  <button className="close primary" onClick={completeReminder}>
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
        {dictationSupported && !dictation.listening && (
          <button
            className="icon-btn"
            data-tip="Dictate"
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
          <Icon name={items ? 'text' : 'list'} />
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

      {dictation.listening && (
        <p className="rec-status">
          Listening... <strong>tap the mic to stop</strong>
          <span>
            {' '}
            · {dictation.lang.includes('-') ? dictation.lang.replace('-', ' (') + ')' : dictation.lang}
          </span>
        </p>
      )}

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
  '#202020',
  '#d93025',
  '#e37400',
  '#c9a400',
  '#188038',
  '#5c5c5c',
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

/** Line (stroke) icons — lighter visual weight than filled Material glyphs. */
const ICONS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16h14v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
  mic: (
    <>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
      <path d="M8 22h8" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h12" />
      <path d="M9 12h12" />
      <path d="M9 18h12" />
      <rect x="3" y="4.5" width="3" height="3" rx="0.5" />
      <rect x="3" y="10.5" width="3" height="3" rx="0.5" />
      <rect x="3" y="16.5" width="3" height="3" rx="0.5" />
    </>
  ),
  text: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h12" />
      <path d="M4 18h16" />
    </>
  ),
  bullets: (
    <>
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <circle cx="3.5" cy="6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  numbers: (
    <>
      <path d="M10 6h11" />
      <path d="M10 12h11" />
      <path d="M10 18h11" />
      <path d="M4 6h1v4" />
      <path d="M4 10h2" />
      <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
    </>
  ),
  code: (
    <>
      <path d="m16 18 6-6-6-6" />
      <path d="m8 6-6 6 6 6" />
    </>
  ),
  noticeInfo: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  noticeWarning: (
    <>
      <path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  noticeDanger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </>
  ),
  palette: (
    <>
      <circle cx="13.5" cy="6.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="17.5" cy="10.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="7.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="12" r=".8" fill="currentColor" stroke="none" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.7-.7 1.7-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c3.3 0 6-2.7 6-6 0-5.5-4.5-10-10-10z" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  'delete-forever': (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="m10 11 4 4" />
      <path d="m14 11-4 4" />
    </>
  ),
  format: (
    <>
      <path d="M4 20h16" />
      <path d="m6 16 6-12 6 12" />
      <path d="M8.5 11h7" />
    </>
  ),
  textColor: (
    <>
      <path d="m6 16 6-12 6 12" />
      <path d="M8.5 11h7" />
      <path d="M4 20h16" />
    </>
  ),
  highlight: (
    <>
      <path d="m9 11-6 6v3h3l6-6" />
      <path d="m15 5 4 4" />
      <path d="M14.5 5.5 18 9l-7.5 7.5H7v-3.5z" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </>
  ),
  label: (
    <>
      <path d="M12.6 3.1a2 2 0 0 0-1.4-.6H4a1 1 0 0 0-1 1v7.2a2 2 0 0 0 .6 1.4l8.4 8.4a2 2 0 0 0 2.8 0l6.2-6.2a2 2 0 0 0 0-2.8z" />
      <circle cx="7.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  circle: <circle cx="12" cy="12" r="8" />,
  restore: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  filter: (
    <>
      <path d="M4 5h16" />
      <path d="M7 12h10" />
      <path d="M10 19h4" />
    </>
  ),
  filterOn: (
    <>
      <path d="M4 5h16" />
      <path d="M7 12h10" />
      <path d="M10 19h4" />
      <circle cx="17" cy="6" r="2.5" />
    </>
  ),
  popout: (
    <>
      <path d="M14 3h7v7" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </>
  ),
  moon: <path d="M21 14.3A9 9 0 1 1 9.7 3a7 7 0 0 0 11.3 11.3z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.3 17.7-1.4 1.4" />
      <path d="m19.1 4.9-1.4 1.4" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  sort: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h6" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  listView: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </>
  ),
};

export function Icon({ name }: { name: string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[name]}
    </svg>
  );
}
