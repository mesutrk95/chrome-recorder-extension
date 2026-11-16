// Use semantic controls and Material icon names, never Meet's generated class names.
// Meet can change its markup; see README for the manual-start fallback.
export function detectJoined(root: ParentNode): boolean {
  return [...root.querySelectorAll('button, [role="button"]')].some(button => {
    if (button.getAttribute('aria-hidden') === 'true' || button.hasAttribute('disabled')) return false;
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('data-tooltip') ?? ''}`;
    if (/leave (the )?call|leave (the )?meeting|hang up|quitter l[’']appel|quitter la réunion|anruf verlassen|salir de (la )?llamada|abandonar (la )?llamada|покинуть звонок|покинуть встречу/i.test(label)) return true;
    return [...button.querySelectorAll('i, span')].some(icon => icon.textContent?.trim() === 'call_end');
  });
}

export class MeetingDebouncer {
  private matches = 0;
  private misses = 0;
  joined = false;
  update(detected: boolean): boolean {
    this.matches = detected ? this.matches + 1 : 0;
    this.misses = detected ? 0 : this.misses + 1;
    if (this.matches >= 2) this.joined = true;
    if (this.misses >= 5) this.joined = false;
    return this.joined;
  }
}
