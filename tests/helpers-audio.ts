/** Something that is not silence: a 220 Hz tone at 16 kHz, 16-bit mono. */
export function tone(seconds: number): Uint8Array {
  const samples = Math.round(seconds * 16000);
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(Math.sin((i / 16000) * 2 * Math.PI * 220) * 9000), true);
  return out;
}
