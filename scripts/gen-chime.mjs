// Writes src/public/sound/chime.wav: two soft bell tones with a decay tail.
// Hand-rolled PCM so the repo needs no audio dependency or licensed sample.
import { mkdirSync, writeFileSync } from 'node:fs';

const RATE = 44100;
const SECONDS = 1.0;
// Warm mid-low pair: audible on laptop speakers without the boom of a bass thud.
const TONES = [
  { hz: 220, start: 0, gain: 0.4 }, // A3
  { hz: 329.6, start: 0.13, gain: 0.26 }, // E4
];

const frames = Math.floor(RATE * SECONDS);
const pcm = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  const t = i / RATE;
  let sample = 0;
  for (const { hz, start, gain } of TONES) {
    if (t < start) continue;
    const age = t - start;
    // Slow attack so there is no click, long decay so it fades rather than pings.
    const envelope = Math.exp(-3.2 * age) * Math.min(1, age * 90);
    // Pure sine plus a whisper of octave: bassy, no bell-like upper harmonics.
    sample +=
      gain *
      envelope *
      (Math.sin(2 * Math.PI * hz * age) + 0.12 * Math.sin(4 * Math.PI * hz * age));
  }
  pcm.writeInt16LE(Math.max(-1, Math.min(1, sample)) * 32000, i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);

mkdirSync('src/public/sound', { recursive: true });
writeFileSync('src/public/sound/chime.wav', Buffer.concat([header, pcm]));
console.log(`src/public/sound/chime.wav ${(44 + pcm.length) / 1024 | 0}KB`);
