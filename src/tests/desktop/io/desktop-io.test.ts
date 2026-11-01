import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initDesktopIO,
  _resetForTests,
  sanitizeFileName,
  parseDeskError,
  saveBlob,
  consumeHandoff,
  getDesk,
  sanitizeMime,
  isValidDeskId,
  deliverFiles,
  MAX_FILES,
} from '../../../js/utils/desktop-io';
import { FLOWS } from '../../../desktop/flows/registry';
import { existsSync } from 'fs';
import { resolve } from 'path';

const stashed = new Map<string, File>();
vi.mock('../../../desktop/stash', () => ({
  isStashId: (id: string) => id.startsWith('stash:'),
  takeStashed: vi.fn(async (id: string) => {
    const f = stashed.get(id) ?? null;
    stashed.delete(id);
    return f;
  }),
}));

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const FAST = { graceMs: 0, timeoutMs: 200 };
const tick = () => new Promise((r) => setTimeout(r, 0));

function mockDesk(over: Record<string, unknown> = {}) {
  const desk = {
    readFile: vi.fn(async () => new Uint8Array([37, 80, 68, 70]).buffer),
    saveAs: vi.fn(async () => ({ id: 'out1' })),
    write: vi.fn(async () => ({ ok: true })),
    revealInFolder: vi.fn(async () => ({})),
    ...over,
  };
  (window as any).desk = desk;
  return desk;
}

// jsdom has no DataTransfer and rejects non-FileList assignments to input.files.
class FakeDT {
  private list: File[] = [];
  items = { add: (f: File): void => void this.list.push(f) };
  get files(): FileList {
    return this.list as unknown as FileList;
  }
}
(globalThis as any).DataTransfer = FakeDT;
Object.defineProperty(HTMLInputElement.prototype, 'files', {
  configurable: true,
  get(): unknown {
    return (this as any).__files ?? [];
  },
  set(v) {
    (this as any).__files = v;
  },
});

beforeEach(() => {
  _resetForTests();
  delete (window as any).desk;
  document.body.innerHTML =
    '<div id="drop-zone"></div><input id="file-input" type="file" multiple>';
  history.replaceState(null, '', '/merge-pdf.html');
});

describe('helpers', () => {
  it('sanitizes names', () => {
    expect(sanitizeFileName('a/b\\c.pdf')).toBe('a_b_c.pdf');
    expect(sanitizeFileName('CON.pdf')).toBe('document.pdf');
    expect(sanitizeFileName('x\u0001y.pdf')).toBe('xy.pdf');
    expect(sanitizeFileName('..hidden.pdf')).toBe('hidden.pdf');
    expect(sanitizeFileName('')).toBe('document');
  });
  it('parses error prefix', () => {
    expect(parseDeskError(new Error('[too_large] nope'))).toEqual({
      code: 'too_large',
      text: 'nope',
    });
    expect(parseDeskError(new Error('plain')).code).toBe('internal');
  });
});

describe('sanitize hardening', () => {
  it('handles traversal, reserved, trailing, length, NFC', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeFileName('..')).toBe('document');
    expect(sanitizeFileName('a.pdf. . ')).toBe('a.pdf');
    expect(sanitizeFileName('nul')).toBe('document');
    expect(sanitizeFileName('COM1.tar.gz')).toBe('document.tar.gz');
    expect(sanitizeFileName('lpt9 .pdf')).toBe('document.pdf');
    expect(sanitizeFileName('e' + String.fromCharCode(0x301) + '.pdf')).toBe(
      String.fromCharCode(0xe9) + '.pdf'
    );
    expect(
      sanitizeFileName('x' + String.fromCharCode(0x202e) + 'exe.pdf')
    ).toBe('xexe.pdf');
    const long = sanitizeFileName('a'.repeat(500) + '.pdf');
    expect(long.length).toBe(200);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(sanitizeFileName(String.raw`C:\Windows\x.pdf`)).toBe(
      'C_Windows_x.pdf'
    );
  });
  it('validates mime and ids', () => {
    expect(sanitizeMime('application/pdf; charset=x')).toBe('application/pdf');
    expect(sanitizeMime('text/html\r\nX: y')).toBe('application/octet-stream');
    expect(sanitizeMime('application/x-msdownload')).toBe(
      'application/octet-stream'
    );
    expect(sanitizeMime('')).toBe('application/octet-stream');
    expect(isValidDeskId(U1)).toBe(true);
    expect(isValidDeskId('../../x')).toBe(false);
    expect(isValidDeskId('__proto__')).toBe(false);
  });
});

describe('hand-off', () => {
  it('injects files into the input and strips params', async () => {
    const desk = mockDesk();
    history.replaceState(
      null,
      '',
      `/merge-pdf.html?desk-file=${U1}&desk-file=${U2}&desk-name=x.pdf&desk-name=y.pdf&k=1`
    );
    const input = document.getElementById('file-input') as HTMLInputElement;
    const onChange = vi.fn();
    input.addEventListener('change', onChange);
    await consumeHandoff(FAST);
    expect(desk.readFile).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.files!.length).toBe(2);
    expect(input.files![0].name).toBe('x.pdf');
    expect(location.search).toBe('?k=1');
  });

  it('accepts stash:<uuid> ids (dropped files) without touching desk.readFile', async () => {
    const desk = mockDesk();
    const sid = `stash:${U1}`;
    stashed.set(
      sid,
      new File([new Uint8Array([37, 80, 68, 70])], 'dropped.pdf', {
        type: 'application/pdf',
      })
    );
    history.replaceState(
      null,
      '',
      `/merge-pdf.html?desk-file=${encodeURIComponent(sid)}&desk-file=${U2}&desk-name=ignored.pdf&desk-name=y.pdf`
    );
    const input = document.getElementById('file-input') as HTMLInputElement;
    await consumeHandoff(FAST);
    expect(desk.readFile).toHaveBeenCalledTimes(1);
    expect(desk.readFile).toHaveBeenCalledWith(U2);
    expect(input.files!.length).toBe(2);
    expect(input.files![0].name).toBe('dropped.pdf');
    expect(stashed.has(sid)).toBe(false);
  });

  it('stash ids work without window.desk and a missing stash entry is reported, not thrown', async () => {
    history.replaceState(
      null,
      '',
      `/merge-pdf.html?desk-file=${encodeURIComponent('stash:gone')}`
    );
    await expect(consumeHandoff(FAST)).resolves.toBeUndefined();
    expect(location.search).toBe('');
  });

  it('falls back to drop zone when no input', async () => {
    mockDesk();
    document.body.innerHTML = '<div id="drop-zone"></div>';
    const drop = vi.fn();
    document.getElementById('drop-zone')!.addEventListener('drop', drop);
    history.replaceState(null, '', `/x.html?desk-file=${U1}`);
    await consumeHandoff(FAST);
    expect(drop).toHaveBeenCalledTimes(1);
    expect((drop.mock.calls[0][0] as any).dataTransfer.files[0].name).toBe(
      'document.pdf'
    );
  });

  it('rejects non-uuid ids without calling desk.readFile', async () => {
    const desk = mockDesk();
    history.replaceState(
      null,
      '',
      '/x.html?desk-file=../../etc&desk-file=__proto__'
    );
    await consumeHandoff(FAST);
    expect(desk.readFile).not.toHaveBeenCalled();
    expect(location.search).toBe('');
  });

  it('caps the number of files', async () => {
    const desk = mockDesk();
    const q = Array.from(
      { length: MAX_FILES + 10 },
      () => `desk-file=${U1}`
    ).join('&');
    history.replaceState(null, '', `/x.html?${q}`);
    await consumeHandoff(FAST);
    expect(desk.readFile).toHaveBeenCalledTimes(MAX_FILES);
  });

  it('spreads files over two single inputs (compare/overlay)', async () => {
    mockDesk();
    document.body.innerHTML =
      '<input id="file-input-1" type="file" accept="application/pdf"><input id="file-input-2" type="file" accept="application/pdf"><input id="cert-input" type="file" accept=".pfx">';
    history.replaceState(
      null,
      '',
      `/compare-pdfs.html?desk-file=${U1}&desk-file=${U2}&desk-name=a.pdf&desk-name=b.pdf`
    );
    await consumeHandoff(FAST);
    const f1 = (document.getElementById('file-input-1') as any).files;
    const f2 = (document.getElementById('file-input-2') as any).files;
    expect(f1[0].name).toBe('a.pdf');
    expect(f2[0].name).toBe('b.pdf');
    expect((document.getElementById('cert-input') as any).files.length).toBe(0);
  });

  it('picks the pdf input over other inputs and waits for a late input', async () => {
    mockDesk();
    document.body.innerHTML =
      '<input id="cert-input" type="file" accept=".pfx">';
    history.replaceState(null, '', `/x.html?desk-file=${U1}`);
    setTimeout(() => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<input id="file-input" type="file" accept="application/pdf">'
      );
    }, 120);
    await consumeHandoff({ graceMs: 0, timeoutMs: 2000 });
    expect((document.getElementById('file-input') as any).files[0].name).toBe(
      'document.pdf'
    );
    expect(deliverFiles([])).toBe(false);
  });

  it('toasts a friendly message on failure', async () => {
    mockDesk({
      readFile: vi.fn(async () => {
        throw new Error('[too_large] big');
      }),
    });
    history.replaceState(null, '', `/x.html?desk-file=${U1}`);
    await consumeHandoff(FAST);
    expect(document.body.textContent).toContain('too large');
  });
});

describe('save interception', () => {
  it('routes blob download clicks through saveAs + write', async () => {
    (URL as any).createObjectURL = () => 'blob:http://localhost/abc';
    (URL as any).revokeObjectURL = () => {};
    const desk = mockDesk();
    initDesktopIO();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['hi'], { type: 'application/pdf' }));
    a.download = 'out/merged.pdf';
    document.body.appendChild(a);
    a.click();
    for (let i = 0; i < 6; i++) await tick();
    expect(desk.saveAs).toHaveBeenCalledWith({
      suggestedName: 'out_merged.pdf',
      mime: 'application/pdf',
    });
    expect(desk.write).toHaveBeenCalledWith('out1', expect.anything());
    expect(document.body.textContent).toContain('Saved out_merged.pdf');
  });

  it('intercepts detached anchors and data: urls', async () => {
    const desk = mockDesk();
    initDesktopIO();
    const a = document.createElement('a');
    a.href = 'data:text/plain;base64,aGk=';
    a.download = 'CON.txt';
    a.click(); // never attached to the DOM
    for (let i = 0; i < 8; i++) await tick();
    expect(desk.saveAs).toHaveBeenCalledWith({
      suggestedName: 'output.txt',
      mime: 'text/plain',
    });
    expect(desk.write).toHaveBeenCalled();
    expect((window as any).showSaveFilePicker).toBeUndefined();
  });

  it('is silent when user cancels', async () => {
    const desk = mockDesk({ saveAs: vi.fn(async () => null) });
    await saveBlob(new Blob(['x']), 'a.pdf');
    expect(desk.write).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Could not');
  });

  it('shows plain message on save error', async () => {
    mockDesk({
      write: vi.fn(async () => {
        throw new Error('[too_large] cap');
      }),
    });
    await saveBlob(new Blob(['x']), 'a.pdf');
    expect(document.body.textContent).toContain('too large');
  });
});

describe('iframe fallback', () => {
  it('uses parent.desk when window.desk is missing', () => {
    const desk = { marker: 1 };
    const topSpy = vi.spyOn(window, 'top', 'get').mockReturnValue({} as any);
    const parentSpy = vi
      .spyOn(window, 'parent', 'get')
      .mockReturnValue({ desk } as any);
    expect(getDesk()).toBe(desk);
    topSpy.mockRestore();
    parentSpy.mockRestore();
  });
});

describe('flows registry', () => {
  it('maps to real pages', () => {
    for (const f of FLOWS)
      expect(
        existsSync(resolve(__dirname, '../../../pages', f.toolPath + '.html'))
      ).toBe(true);
  });
});

describe('pdf.js viewer hardening', () => {
  it('forces scripting off and links to _blank when a viewer announces itself', () => {
    initDesktopIO();
    const set = new Map<string, unknown>();
    const viewerWin = {
      PDFViewerApplicationOptions: {
        set: (k: string, v: unknown): void => void set.set(k, v),
      },
    };
    document.dispatchEvent(
      new CustomEvent('webviewerloaded', {
        bubbles: true,
        cancelable: true,
        detail: { source: viewerWin },
      })
    );
    expect(set.get('enableScripting')).toBe(false);
    expect(set.get('isEvalSupported')).toBe(false);
    expect(set.get('disablePreferences')).toBe(true);
    expect(set.get('externalLinkTarget')).toBe(2);
  });

  it('ignores events without a viewer and options that throw', () => {
    initDesktopIO();
    expect(() =>
      document.dispatchEvent(new CustomEvent('webviewerloaded', { detail: {} }))
    ).not.toThrow();
    const viewerWin = {
      PDFViewerApplicationOptions: {
        set: () => {
          throw new Error('unknown');
        },
      },
    };
    expect(() =>
      document.dispatchEvent(
        new CustomEvent('webviewerloaded', { detail: { source: viewerWin } })
      )
    ).not.toThrow();
  });
});
