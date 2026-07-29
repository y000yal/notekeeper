import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { loadPrefs } from '../../shared/notes';
import { PoppedNote } from '../../shared/PoppedNote';
import '../../shared/style.css';

// Standalone page for the popped-out note, used when Chrome will not give us a
// Document Picture-in-Picture window (opened as a normal popup window instead).
function Page() {
  const id = new URLSearchParams(location.search).get('id');
  useEffect(() => {
    loadPrefs().then((p) => (document.documentElement.dataset.theme = p.theme));
  }, []);
  return (
    <div className="app popout">
      <PoppedNote id={id} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
