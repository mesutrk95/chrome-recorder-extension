import { afterEach, expect, it, vi } from 'vitest';
import { englishAvailability, installEnglish } from '../src/speech';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function speechModel(status: string) {
  class Speech {
    get processLocally() { return true; }
    static available = vi.fn(async () => status);
    static install = vi.fn(() => new Promise<boolean>(() => {}));
  }
  vi.stubGlobal('window', { SpeechRecognition: Speech });
  return Speech;
}
it('never falls back to the older microphone/cloud recognition API', async () => {
  vi.stubGlobal('window', { webkitSpeechRecognition: class {} });
  expect(await englishAvailability()).toBe('unavailable');
  await expect(installEnglish()).rejects.toThrow('Update desktop Google Chrome');
});
it('detects a ready model even when Chrome misses the install-completion callback', async () => {
  vi.useFakeTimers();
  const Speech = speechModel('available');
  const installation = installEnglish();
  expect(Speech.install).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
  await vi.advanceTimersByTimeAsync(2000);
  expect(await installation).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('explains a stalled model download instead of keeping the button busy forever', async () => {
  vi.useFakeTimers();
  speechModel('downloading');
  const failure = expect(installEnglish()).rejects.toThrow('English pack download');
  await vi.advanceTimersByTimeAsync(120_000);
  await failure;
  expect(vi.getTimerCount()).toBe(0);
});
