/**
 * Runs in the page, where Document Picture-in-Picture is allowed — a side panel
 * only gets a window Chrome tears down again immediately. Must be a standalone
 * function: executeScript serialises it, so it can close over nothing.
 */
function openFloatingNote(url: string, width: number, height: number) {
  const dpip = (
    window as typeof window & {
      documentPictureInPicture?: { requestWindow: (o: object) => Promise<Window> };
    }
  ).documentPictureInPicture;
  if (!dpip) return Promise.resolve({ ok: false, error: 'no floating-window support' });
  return dpip.requestWindow({ width, height }).then(
    (win) => {
      // Chrome seeds the window title from the opener page and can overwrite ours
      // as the window settles, so keep setting it for the first moments.
      const name = () => {
        win.document.title = 'NoteKeeper';
      };
      name();
      win.document.documentElement.style.cssText = 'height:100%;overflow:hidden';
      win.document.body.style.cssText = 'margin:0;height:100%;overflow:hidden';
      const frame = win.document.createElement('iframe');
      frame.src = url;
      frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
      frame.addEventListener('load', name);
      win.document.body.append(frame);
      [0, 60, 250, 800].forEach((delay) => win.setTimeout(name, delay));
      // The note page is cross-origin in here, so Close asks us to shut the window.
      win.addEventListener('message', (event: MessageEvent) => {
        if (event.data === 'notekeeper:close') win.close();
      });
      return { ok: true };
    },
    (error: Error) => ({ ok: false, error: String(error?.message ?? error) }),
  );
}

/**
 * Open the note in an always-on-top window. Call straight from the click handler:
 * the injected requestWindow needs the caller's user activation.
 */
export async function floatNote(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // currentWindow, not lastFocusedWindow: with DevTools open that resolves to
    // the DevTools window, whose tab is a chrome:// page we can never script.
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab =
      tabs.find((t) => /^https?:/.test(t.url ?? '')) ??
      tabs.find((t) => t.url === undefined) ??
      tabs[0];
    if (tab?.id === undefined) return { ok: false, error: 'no active tab to attach to' };
    if (tab.url && !/^https?:|^file:/.test(tab.url)) {
      return { ok: false, error: `cannot be scripted: ${tab.url.split('/')[0]}` };
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: openFloatingNote,
      args: [chrome.runtime.getURL(`note.html?id=${id}`), 380, 460],
    });
    return (
      (injection?.result as { ok: boolean; error?: string }) ?? {
        ok: false,
        error: 'injection returned nothing',
      }
    );
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
