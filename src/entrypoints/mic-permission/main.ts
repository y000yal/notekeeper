const output = document.getElementById('status')!;

navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    output.textContent = 'Microphone allowed. You can close this tab and hit the mic again.';
  })
  .catch((err: DOMException) => {
    output.textContent = `Microphone blocked (${err.name}). Allow it from the padlock icon in the address bar, then reload this page.`;
  });
