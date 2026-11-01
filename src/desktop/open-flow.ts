/** Open a PDF from the shell (dialog, menu, open-with, recent) and hand it to a tool. */
import { DeskFile, deskErrorMessage, getDesk } from './desk';
import { DEFAULT_TOOL, openWithTool } from './handoff';
import { noteOpened } from './recent';
import { stashFiles } from './stash';
import { toast } from './toast';

/** One PDF goes to the editor; several go to Merge (the only multi-file default). */
export function defaultToolFor(count: number): string {
  return count > 1 ? 'merge-pdf' : DEFAULT_TOOL;
}

export function openGranted(files: DeskFile[], tool?: string): void {
  if (!files.length) return;
  noteOpened(files);
  openWithTool(
    tool ?? defaultToolFor(files.length),
    files.map((f) => f.id),
    undefined,
    files.map((f) => f.name)
  );
}

/** Native open dialog -> tool. Returns false when cancelled/unavailable. */
export async function openFromDialog(tool?: string): Promise<boolean> {
  const desk = getDesk();
  if (!desk) {
    toast('Opening files needs the Inkleaf desktop app.', 'info');
    return false;
  }
  try {
    const files = await desk.openFiles('pdf');
    if (!files.length) return false;
    openGranted(files, tool);
    return true;
  } catch (e) {
    toast(deskErrorMessage(e, 'Could not open that file'), 'error');
    return false;
  }
}

/** Dropped File objects (no path access) -> stash -> tool. */
export async function openDropped(
  files: File[],
  tool?: string
): Promise<boolean> {
  const pdfs = files.filter(
    (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)
  );
  if (!pdfs.length) {
    toast('That is not a PDF. Drop a .pdf file to get started.', 'info');
    return false;
  }
  try {
    const ids = await stashFiles(pdfs);
    openWithTool(tool ?? defaultToolFor(pdfs.length), ids);
    return true;
  } catch {
    toast('Could not read the dropped file.', 'error');
    return false;
  }
}
