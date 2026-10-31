// The terminal bell: a short tone, in place of `QApplication::beep()`.
let ctx: AudioContext | null = null;

/** Plays a 120 ms tone. Does nothing where Web Audio is missing. */
export function beep(): void {
  try {
    const Ctor = globalThis.AudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    // A context made before any user gesture starts suspended under
    // Chromium's autoplay policy, and stays so until it is resumed.
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch {
    // No audio device; the bell stays silent.
  }
}
