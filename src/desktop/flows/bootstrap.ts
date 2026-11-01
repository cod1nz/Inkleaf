import { initDesktopIO } from '../../js/utils/desktop-io';

/** Called by M4's chrome.ts on every desktop page (tool pages and launcher). */
export function bootstrapFlows(): void {
  initDesktopIO();
}
