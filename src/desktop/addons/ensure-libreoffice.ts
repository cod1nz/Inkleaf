/**
 * Gate for the Office converter add-on (PLAN D9). `ensureLibreOffice()` resolves the base path
 * (e.g. /addons/libreoffice/1.0.0/) once the add-on is installed, asking the user to install it if needed.
 */
import { h, trapFocus } from '../dom';
import { toast } from '../toast';
import {
  getAddonsApi,
  parseAddonError,
  formatMb,
  type AddonStatus,
  type AddonProgressEvent,
} from './api';

const NAME = 'libreoffice';
let inflight: Promise<string> | null = null;

const STYLE_ID = 'dk-addon-style';
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.dk-addon h2{margin:0 0 8px;font-size:var(--dk-fs-xl,18px);font-weight:600;letter-spacing:-0.01em}
.dk-addon p{margin:0 0 6px;font-size:var(--dk-fs-sm,13px);color:var(--dk-text-2,#666);line-height:1.5}
.dk-addon-bar{height:6px;border-radius:3px;background:var(--dk-hairline,#ddd);overflow:hidden;margin:16px 0 6px}
.dk-addon-fill{height:100%;width:0;background:var(--dk-accent,#2563eb);transition:width .2s ease}
.dk-addon-fill.is-busy{width:100%;opacity:.5;animation:dk-addon-pulse 1.2s ease-in-out infinite}
@keyframes dk-addon-pulse{50%{opacity:.9}}
.dk-addon-err{color:var(--dk-danger,#c0392b)!important}
.dk-addon .dk-dialog-actions{gap:8px;flex-wrap:wrap}
`;
  document.head.append(s);
}

function friendlyError(code: string, message: string): string {
  switch (code) {
    case 'network':
      return 'Could not download the add-on. Check your internet connection, or choose the add-on file instead.';
    case 'hash_mismatch':
      return 'That file is not the expected add-on pack, so it was not installed.';
    case 'bad_archive':
      return 'The add-on file is damaged or not a valid add-on pack.';
    case 'no_space':
      return 'There is not enough disk space to install the add-on.';
    case 'unavailable':
      return 'The add-on is not available for download yet in this version.';
    default:
      return message || 'The add-on could not be installed.';
  }
}

function runDialog(initial: AddonStatus): Promise<string> {
  ensureStyle();
  const api = getAddonsApi()!;
  return new Promise((resolve, reject) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const title = h('h2', {
      text: 'Office converter needed',
      attrs: { id: 'dk-addon-title' },
    });
    const lead = h('p', {
      text: `This tool needs the Office converter add-on (~${formatMb(initial.sizeBytes)}). Download it once, then it works offline.`,
      attrs: { id: 'dk-addon-desc' },
    });
    const note = h('p', {
      text: `It is downloaded from ${initial.host}. Nothing else is sent.`,
    });
    const fill = h('div', { class: 'dk-addon-fill' });
    const bar = h(
      'div',
      {
        class: 'dk-addon-bar',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': 0,
          'aria-valuemax': 100,
        },
      },
      fill
    );
    bar.hidden = true;
    const status = h('p', { attrs: { 'aria-live': 'polite' } });
    const errLine = h('p', { class: 'dk-addon-err', attrs: { role: 'alert' } });
    errLine.hidden = true;
    const btnDownload = h('button', {
      class: 'dk-btn dk-btn-primary',
      text: 'Download',
      attrs: { type: 'button' },
    });
    const btnFile = h('button', {
      class: 'dk-btn',
      text: 'Choose file...',
      attrs: { type: 'button' },
    });
    const btnCancel = h('button', {
      class: 'dk-btn dk-btn-quiet',
      text: 'Cancel',
      attrs: { type: 'button' },
    });
    if (!initial.available) btnDownload.disabled = true;
    const actions = h(
      'div',
      { class: 'dk-dialog-actions' },
      btnDownload,
      btnFile,
      btnCancel
    );
    const dialog = h(
      'div',
      {
        class: 'dk-dialog dk-addon',
        attrs: {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dk-addon-title',
          'aria-describedby': 'dk-addon-desc',
          tabindex: -1,
        },
      },
      title,
      lead,
      note,
      bar,
      status,
      errLine,
      actions
    );
    const scrim = h('div', { class: 'dk-scrim' }, dialog);
    const release = trapFocus(dialog);
    let busy = false;
    let done = false;

    const setBusy = (b: boolean) => {
      busy = b;
      btnDownload.disabled = b || !initial.available;
      btnFile.disabled = b;
      btnCancel.textContent = b ? 'Stop' : 'Cancel';
    };
    const close = () => {
      if (done) return;
      done = true;
      off();
      release();
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.add('is-closing');
      window.setTimeout(() => scrim.remove(), 120);
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
    };
    const showError = (code: string, message: string) => {
      errLine.textContent = friendlyError(code, message);
      errLine.hidden = false;
    };
    const onProgress = (ev: AddonProgressEvent) => {
      if (ev.name !== NAME || done) return;
      if (ev.state === 'downloading') {
        bar.hidden = false;
        fill.classList.remove('is-busy');
        const pct = ev.progress ? ev.progress.percent : 0;
        fill.style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
        status.textContent = ev.progress
          ? `Downloading... ${formatMb(ev.progress.received)} of ${formatMb(ev.progress.total)}`
          : 'Downloading...';
      } else if (ev.state === 'verifying') {
        bar.hidden = false;
        fill.style.width = '100%';
        fill.classList.add('is-busy');
        status.textContent = 'Checking and installing...';
      }
    };
    const off = api.onProgress(onProgress);

    const finish = (st: AddonStatus) => {
      if (st.state === 'installed' && st.basePath) {
        close();
        toast('Office converter installed', 'success');
        resolve(st.basePath);
      } else {
        throw new Error('not installed');
      }
    };
    const attempt = async (fn: () => Promise<AddonStatus>) => {
      if (busy) return;
      errLine.hidden = true;
      status.textContent = '';
      setBusy(true);
      try {
        finish(await fn());
      } catch (e) {
        const { code, message } = parseAddonError(e);
        setBusy(false);
        bar.hidden = true;
        status.textContent = '';
        if (code !== 'cancelled') showError(code, message);
      }
    };
    btnDownload.addEventListener(
      'click',
      () => void attempt(() => api.install(NAME))
    );
    btnFile.addEventListener(
      'click',
      () => void attempt(() => api.installFromFile(NAME))
    );
    const cancel = () => {
      if (busy) {
        void api.cancel(NAME).catch(() => {});
        return;
      }
      close();
      reject(
        new Error('The Office converter add-on is required for this tool.')
      );
    };
    btnCancel.addEventListener('click', cancel);
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    (initial.available ? btnDownload : btnFile).focus();
    if (!initial.available) {
      errLine.textContent =
        friendlyError('unavailable', '') +
        ' You can still choose an add-on file.';
      errLine.hidden = false;
    }
  });
}

/** Resolves the add-on base path (with trailing slash). Rejects if the user declines. */
export function ensureLibreOffice(): Promise<string> {
  if (inflight) return inflight;
  inflight = (async () => {
    const api = getAddonsApi();
    if (!api)
      throw new Error(
        'The Office converter add-on is not available in this build.'
      );
    const st = await api.status(NAME);
    if (st.state === 'installed' && st.basePath) return st.basePath;
    return runDialog(st);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
