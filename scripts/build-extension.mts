/**
 * Builds the CareerFlow Chrome extension: copies extension/src, generates extract.js from the same
 * form reader the server uses, and writes apps/web/public/careerflow-chrome.zip for download.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { EXTRACT } from "../apps/worker/src/apply/page-scripts";

const root = new URL("..", import.meta.url).pathname;
const src = join(root, "extension/src");
const out = join(root, "extension/dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)) writeFileSync(join(out, f), readFileSync(join(src, f)));
writeFileSync(join(out, "extract.js"), `// Generated from apps/worker/src/apply/page-scripts.ts — the form reader CareerFlow's server uses.\nwindow.__cfExtract = () => ${EXTRACT.trim()};\n`);

// Minimal ZIP writer (deflate), so no zip tool is needed in the build image.
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const parts: Buffer[] = [];
const central: Buffer[] = [];
let offset = 0;
for (const name of readdirSync(out).sort()) {
  const data = readFileSync(join(out, name));
  const comp = deflateRawSync(data);
  const fname = Buffer.from(`careerflow-chrome/${name}`);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26); local.writeUInt16LE(0, 28);
  parts.push(local, fname, comp);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(fname.length, 28); cen.writeUInt32LE(offset, 42);
  central.push(cen, fname);
  offset += 30 + fname.length + comp.length;
}
const cdir = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
mkdirSync(join(root, "apps/web/public"), { recursive: true });
writeFileSync(join(root, "apps/web/public/careerflow-chrome.zip"), Buffer.concat([...parts, cdir, end]));
console.log(`extension built: ${readdirSync(out).length} files → apps/web/public/careerflow-chrome.zip`);
