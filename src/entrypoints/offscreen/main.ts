// Service workers have no audio API, so the reminder chime plays here. The
// worker creates this document, sends 'play-chime', then closes it again.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'play-chime') return;
  const audio = new Audio(chrome.runtime.getURL('sound/chime.wav'));
  audio.volume = 0.6;
  void audio.play().catch(() => {});
});
