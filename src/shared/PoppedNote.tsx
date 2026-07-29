import { useEffect, useState } from 'react';
import { allLabels, loadNotes, patchNote, removeNote, type Note } from './notes';
import { Editor } from './Editor';

/**
 * In the floating window this page is a frame inside a window the page owns, and
 * a frame cannot close its own window — so ask the opener to do it.
 */
function closeWindow() {
  if (window.parent !== window) window.parent.postMessage('notekeeper:close', '*');
  else window.close();
}

/** One note on its own: the popped-out window's whole contents. */
export function PoppedNote({ id }: { id: string | null }) {
  const [note, setNote] = useState<Note | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    loadNotes().then((notes) => {
      const found = notes.find((n) => n.id === id);
      if (found) setNote(found);
      else setMissing(true);
      setLabels(allLabels(notes));
    });
  }, [id]);

  // Pick up edits made in the side panel. Our own writes land while this window
  // has focus, so skipping those keeps typing here from being overwritten.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (!changes.notes || document.hasFocus()) return;
      void loadNotes().then((notes) => {
        const found = notes.find((n) => n.id === id);
        if (found) setNote(found);
        setLabels(allLabels(notes));
      });
    };
    chrome.storage.local.onChanged.addListener(onChanged);
    return () => chrome.storage.local.onChanged.removeListener(onChanged);
  }, [id]);

  if (missing) return <p className="empty">This note no longer exists.</p>;
  if (!note) return null;

  return (
    <Editor
      note={note}
      knownLabels={labels}
      onChange={(changes) => {
        setNote({ ...note, ...changes });
        void patchNote(note.id, changes);
      }}
      onClose={closeWindow}
      onDelete={() => void removeNote(note.id).then(closeWindow)}
    />
  );
}
