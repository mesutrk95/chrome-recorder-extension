// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { detectJoined, MeetingDebouncer } from '../src/detection';

describe('meeting detection', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  it('does not record the lobby or a Spanish join button', () => {
    document.body.innerHTML = '<button aria-label="Join now">Join now</button><button aria-label="Unirse a la llamada">Unirse</button>';
    expect(detectJoined(document)).toBe(false);
  });
  it('detects the leave control and ignores disabled / hidden controls', () => {
    document.body.innerHTML = '<button aria-label="Leave call" disabled></button><button aria-label="Leave call" aria-hidden="true"></button>';
    expect(detectJoined(document)).toBe(false);
    document.body.innerHTML += '<button aria-label="Leave call"></button>';
    expect(detectJoined(document)).toBe(true);
  });
  it('uses the language-independent hang-up icon', () => {
    document.body.innerHTML = '<div role="button"><i>call_end</i></div>';
    expect(detectJoined(document)).toBe(true);
  });
  it('requires two join samples and tolerates brief UI rerenders', () => {
    const state = new MeetingDebouncer();
    expect(state.update(true)).toBe(false);
    expect(state.update(true)).toBe(true);
    for (let i = 0; i < 4; i++) expect(state.update(false)).toBe(true);
    expect(state.update(true)).toBe(true);
    for (let i = 0; i < 4; i++) state.update(false);
    expect(state.update(false)).toBe(false);
  });
});
