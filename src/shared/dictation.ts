import { useCallback, useEffect, useRef, useState } from 'react';

// ponytail: no wrapper class, no polyfill. Chrome's webkitSpeechRecognition is
// the only engine an MV3 side panel gets for free.
const Recognition: any =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export const dictationSupported = Boolean(Recognition);

/**
 * Push-to-dictate. `onText` receives finalized phrases only; interim results go
 * to `interim` so the UI can show them without committing them to the note.
 */
export function useDictation(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<any>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    recRef.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!Recognition || recRef.current) return;
    setError(null);
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = chrome.i18n?.getUILanguage?.() ?? 'en-US';

    rec.onresult = (event: any) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) onTextRef.current(result[0].transcript.trim());
        else pending += result[0].transcript;
      }
      setInterim(pending);
    };
    rec.onerror = (event: any) => {
      if (event.error === 'not-allowed') {
        // The mic prompt cannot be shown inside a side panel, so grant it once
        // in a tab; Chrome then remembers it for this extension's origin.
        setError('Microphone access needed. Opening the permission page...');
        chrome.tabs.create({ url: chrome.runtime.getURL('/mic-permission.html') });
      } else if (event.error === 'service-not-allowed' || event.error === 'network') {
        // Speech recognition is done by Google's service, which Brave and some
        // other Chromium builds switch off. Nothing the extension can restore.
        setError(
          'This browser blocks the speech recognition service, so voice notes are unavailable here. They work in Chrome.',
        );
      } else if (event.error !== 'aborted' && event.error !== 'no-speech') {
        setError(`Voice input failed: ${event.error}`);
      }
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim('');
    };

    recRef.current = rec;
    rec.start();
    setListening(true);
  }, []);

  useEffect(() => () => recRef.current?.abort(), []);

  return {
    listening,
    interim,
    error,
    toggle: () => (recRef.current ? stop() : start()),
    stop,
  };
}
