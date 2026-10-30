// Minimal ustar writer for the Docker archive API: flat regular files with a fixed owner,
// which is all a candidate workspace ever receives.

export interface TarEntry {
  name: string;
  data: string | Buffer;
  mode?: number;
}

function octal(h: Buffer, off: number, len: number, n: number): void {
  h.write(n.toString(8).padStart(len - 1, "0") + "\0", off, len, "ascii");
}

export function tar(entries: readonly TarEntry[], owner: { uid: number; gid: number }, mtime = Math.floor(Date.now() / 1000)): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(e.name) || e.name.startsWith(".")) throw new Error(`tar: bad file name ${JSON.stringify(e.name)}`);
    const data = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, "ascii");
    octal(h, 100, 8, e.mode ?? 0o644);
    octal(h, 108, 8, owner.uid);
    octal(h, 116, 8, owner.gid);
    octal(h, 124, 12, data.length);
    octal(h, 136, 12, mtime);
    h.fill(0x20, 148, 156); // the checksum is computed with its own field as spaces
    h.write("0", 156, "ascii"); // regular file
    h.write("ustar\0" + "00", 257, "ascii");
    let sum = 0;
    for (const b of h) sum += b;
    octal(h, 148, 7, sum);
    h[155] = 0x20;
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
