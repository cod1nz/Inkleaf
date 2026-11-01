import { h } from './dom';

let host: HTMLElement | null = null;

function getHost(): HTMLElement {
  if (host && host.isConnected) return host;
  host = h('div', {
    class: 'dk-toasts',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
  });
  document.body.append(host);
  return host;
}

export type ToastKind = 'info' | 'success' | 'error';

/** Bottom-center toast. Calm, no exclamation marks. */
export function toast(
  message: string,
  kind: ToastKind = 'info',
  ms = 3600
): void {
  const el = h('div', { class: `dk-toast dk-toast-${kind}`, text: message });
  getHost().append(el);
  const close = () => {
    el.classList.add('dk-leave');
    window.setTimeout(() => el.remove(), 180);
  };
  window.setTimeout(close, kind === 'error' ? Math.max(ms, 5200) : ms);
}
