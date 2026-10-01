/** ZIP packaging for split / extracted parts (jszip). */
import JSZip from 'jszip';

/** Make every name unique inside the archive ("a.pdf", "a (2).pdf"). */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let name = n;
    let k = 2;
    const dot = n.lastIndexOf('.');
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    while (used.has(name.toLowerCase())) name = `${stem} (${k++})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export async function zipFiles(files: { name: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  const names = uniqueNames(files.map((f) => f.name));
  files.forEach((f, i) => zip.file(names[i], f.bytes, { binary: true }));
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE', mimeType: 'application/zip' });
}
