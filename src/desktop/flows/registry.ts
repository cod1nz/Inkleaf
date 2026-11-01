export interface FlowDef {
  id: string;
  title: string;
  /** Page name without slash/extension, matching src/pages/<toolPath>.html */
  toolPath: string;
  accepts: 'pdf' | 'image' | 'any';
}

export const FLOWS: FlowDef[] = [
  { id: 'edit', title: 'Edit', toolPath: 'edit-pdf', accepts: 'pdf' },
  { id: 'sign', title: 'Sign', toolPath: 'sign-pdf', accepts: 'pdf' },
  { id: 'merge', title: 'Merge', toolPath: 'merge-pdf', accepts: 'pdf' },
  { id: 'split', title: 'Split', toolPath: 'split-pdf', accepts: 'pdf' },
  { id: 'reorder', title: 'Reorder', toolPath: 'organize-pdf', accepts: 'pdf' },
  {
    id: 'compress',
    title: 'Compress',
    toolPath: 'compress-pdf',
    accepts: 'pdf',
  },
  { id: 'ocr', title: 'OCR', toolPath: 'ocr-pdf', accepts: 'pdf' },
  { id: 'protect', title: 'Protect', toolPath: 'protect-pdf', accepts: 'pdf' },
  {
    id: 'convert',
    title: 'Convert to images',
    toolPath: 'pdf-to-jpg',
    accepts: 'pdf',
  },
];

/** Hand-off URL understood by desktop-io: /<tool>.html?desk-file=<id>&desk-name=<name> */
export function flowUrl(
  flow: FlowDef,
  files: { id: string; name: string }[]
): string {
  const p = new URLSearchParams();
  files.forEach((f) => {
    p.append('desk-file', f.id);
    p.append('desk-name', f.name);
  });
  return `/${flow.toolPath}.html?${p.toString()}`;
}
