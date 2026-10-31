import archiver from 'archiver';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deliverables = path.join(root, 'deliverables');
const staging = path.join(deliverables, '.staging');
const portableRoot = path.join(staging, 'IMB Portable');
const portableFiles = path.join(portableRoot, 'IMB Files');

await mkdir(deliverables, { recursive: true });
await rm(staging, { recursive: true, force: true });
await mkdir(portableFiles, { recursive: true });

const releaseFiles = await readdir(path.join(root, 'release'));
const installerName = releaseFiles.find((name) => /^IMB-Setup-.*\.exe$/i.test(name));
if (!installerName) throw new Error('IMB installer was not found. Run npm run dist first.');
await cp(path.join(root, 'release', installerName), path.join(deliverables, 'IMB Setup.exe'));

const unpacked = path.join(root, 'release', 'win-unpacked');
if (!(await stat(unpacked)).isDirectory()) throw new Error('release/win-unpacked was not found.');
await cp(unpacked, portableFiles, { recursive: true });

const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const launcher = spawnSync(csc, [
  '/nologo',
  '/target:winexe',
  `/win32icon:${path.join(root, 'build', 'icon.ico')}`,
  `/out:${path.join(portableRoot, 'IMB.exe')}`,
  '/reference:System.Windows.Forms.dll',
  path.join(root, 'tools', 'portable-launcher.cs')
], { encoding: 'utf8' });
if (launcher.status !== 0) throw new Error(`Portable launcher build failed:\n${launcher.stdout}\n${launcher.stderr}`);

const zipPath = path.join(deliverables, 'IMB Portable.zip');
await rm(zipPath, { force: true });
await new Promise((resolve, reject) => {
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.pipe(output);
  archive.directory(portableRoot, 'IMB Portable');
  archive.finalize();
});

await rm(staging, { recursive: true, force: true });
console.log('Prepared the three-file IMB delivery folder.');
