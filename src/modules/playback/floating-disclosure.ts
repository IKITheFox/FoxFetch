/** One geometry for all expandable controls; only the middle point moves. */
export const DISCLOSURE_ICON =
  '<svg class="disclosure-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12 L12 18 L19 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Animate real block height, retaining native details semantics after settling. */
export class FloatingDisclosureAnimator {
  private readonly running = new Map<
    HTMLDetailsElement,
    { animation: Animation; finish: () => void }
  >();

  constructor(
    private readonly view: Window,
    private readonly onLayout: () => void,
  ) {}

  toggle(details: HTMLDetailsElement): void {
    const summary = details.querySelector<HTMLElement>(':scope > summary');
    const body = summary?.nextElementSibling as HTMLElement | null;
    if (!summary || !body) return;
    const opening = !(details.dataset.expanded == null
      ? details.open
      : details.dataset.expanded === 'true');
    const from = details.open ? body.getBoundingClientRect().height : 0;
    this.running.get(details)?.animation.cancel();
    this.running.delete(details);
    details.open = true;
    details.dataset.expanded = String(opening);
    summary.setAttribute('aria-expanded', String(opening));
    body.style.removeProperty('height');
    const to = opening ? body.getBoundingClientRect().height : 0;
    const settle = () => {
      details.open = opening;
      body.style.removeProperty('height');
      body.style.removeProperty('overflow');
      this.onLayout();
    };
    if (
      !body.animate ||
      this.view.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      Math.abs(to - from) < 1
    ) {
      settle();
      return;
    }
    body.style.height = `${from}px`;
    body.style.overflow = 'clip';
    const animation = body.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 320,
      easing: 'cubic-bezier(.22, 1.12, .36, 1)',
      fill: 'forwards',
    });
    const finish = () => {
      if (this.running.get(details)?.animation !== animation) return;
      this.running.delete(details);
      settle();
      animation.cancel();
    };
    this.running.set(details, { animation, finish });
    void animation.finished.then(finish, () => undefined);
    this.onLayout();
  }

  finish(): void {
    for (const { finish } of [...this.running.values()]) finish();
  }
}
