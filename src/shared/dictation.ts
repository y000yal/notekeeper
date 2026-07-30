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
  const [elapsed, setElapsed] = useState(0);
  const [lang, setLang] = useState('en-US');
  const recRef = useRef<any>(null);
  const onTextRef = useRef(onText);
  const startedAt = useRef(0);
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
    const uiLang = chrome.i18n?.getUILanguage?.() ?? 'en-US';
    rec.lang = uiLang;
    setLang(uiLang);

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
        setError('Voice input failed. Try again.');
      }
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim('');
      setElapsed(0);
    };

    recRef.current = rec;
    rec.start();
    startedAt.current = Date.now();
    setElapsed(0);
    setListening(true);
  }, []);

  useEffect(() => {
    if (!listening) return;
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, [listening]);

  useEffect(() => () => recRef.current?.abort(), []);

  return {
    listening,
    interim,
    error,
    elapsed,
    lang,
    toggle: () => (recRef.current ? stop() : start()),
    stop,
  };
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const BAR_COUNT = 28;

/** Live mic levels for the recording waveform. Falls back to a soft pulse if denied. */
export function useVoiceLevels(active: boolean): number[] {
  const [levels, setLevels] = useState(() => Array.from({ length: BAR_COUNT }, () => 0.12));
  const raf = useRef(0);

  useEffect(() => {
    if (!active) {
      setLevels(Array.from({ length: BAR_COUNT }, () => 0.12));
      return;
    }

    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let alive = true;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(data);
          const next = Array.from({ length: BAR_COUNT }, (_, i) => {
            const idx = Math.floor((i / BAR_COUNT) * (data.length - 1));
            return Math.max(0.08, (data[idx] ?? 0) / 255);
          });
          setLevels(next);
          raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
      } catch {
        // Permission already granted for speech usually; if not, animate softly.
        const tick = () => {
          const t = Date.now() / 220;
          setLevels(
            Array.from({ length: BAR_COUNT }, (_, i) => {
              const wave = 0.25 + 0.55 * Math.abs(Math.sin(t + i * 0.45));
              return wave * (0.4 + 0.6 * ((i % 5) / 5));
            }),
          );
          raf.current = requestAnimationFrame(tick);
        };
        raf.current = requestAnimationFrame(tick);
      }
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [active]);

  return levels;
}
