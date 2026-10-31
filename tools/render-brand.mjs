import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(path.join(root, 'build'), { recursive: true });

const source = path.join(root, 'assets', 'brand', 'IMB-icon.svg');
const svg = await readFile(source);
let icoPng;
for (const size of [192, 256, 512]) {
  const png = await sharp(svg, { density: 72, limitInputPixels: false })
    .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const name = size === 256 ? 'icon.png' : `icon-${size}.png`;
  await writeFile(path.join(root, 'build', name), png);
  if (size === 256) icoPng = png;
}

const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt8(0, 6);
icoHeader.writeUInt8(0, 7);
icoHeader.writeUInt8(0, 8);
icoHeader.writeUInt8(0, 9);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(icoPng.length, 14);
icoHeader.writeUInt32LE(22, 18);
await writeFile(path.join(root, 'build', 'icon.ico'), Buffer.concat([icoHeader, icoPng]));

console.log('Rendered the original IMB icon SVG, unchanged and proportionally centered.');
