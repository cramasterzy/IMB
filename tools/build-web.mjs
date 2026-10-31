import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'web');
const deliverables = path.join(root, 'deliverables');
const read = (relative) => readFile(path.join(root, relative), 'utf8');
const escapeInlineScript = (source) => source.replaceAll('</script', '<\\/script');
const dataUrl = (mime, data) => `data:${mime};base64,${data.toString('base64')}`;

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const file of ['index.html', 'board-data.js', 'media-loader.js', 'manifest.webmanifest', 'register.js', 'sw.js']) {
  await copyFile(path.join(root, 'web', file), path.join(out, file));
}

await copyFile(path.join(root, 'src', 'app.js'), path.join(out, 'app.js'));
await copyFile(path.join(root, 'electron', 'share', 'web-api.js'), path.join(out, 'web-api.js'));
await copyFile(path.join(root, 'electron', 'share', 'fflate.js'), path.join(out, 'fflate.js'));
await copyFile(path.join(root, 'electron', 'assets', 'MiSans-Demibold.ttf'), path.join(out, 'MiSans-Demibold.ttf'));
await copyFile(path.join(root, 'build', 'icon.png'), path.join(out, 'imb-icon.png'));
await copyFile(path.join(root, 'assets', 'brand', 'IMB-icon.svg'), path.join(out, 'imb-icon.svg'));
await copyFile(path.join(root, 'build', 'icon-192.png'), path.join(out, 'icon-192.png'));
await copyFile(path.join(root, 'build', 'icon-512.png'), path.join(out, 'icon-512.png'));

const styles = (await read('src/styles.css')).replace('../electron/assets/MiSans-Demibold.ttf', './MiSans-Demibold.ttf');
await writeFile(path.join(out, 'styles.css'), styles);

const templates = {
  editorHtml: await read('electron/share/editor.html'),
  stylesCss: styles,
  appJs: await read('src/app.js'),
  webApiJs: await read('electron/share/web-api.js'),
  fflateJs: await read('electron/share/fflate.js'),
  fflateLicense: await read('electron/share/fflate-LICENSE.txt'),
  viewerHtml: await read('electron/share/viewer.html'),
  viewerCss: await read('electron/share/viewer.css'),
  viewerJs: await read('electron/share/viewer.js')
};
await writeFile(path.join(out, 'template-data.js'), `window.IMB_SHARE_TEMPLATES=${JSON.stringify(templates)};`);
await writeFile(path.join(root, 'docs', '.nojekyll'), '');

// The downloadable web edition is intentionally a single file. Users should
// never need to manage the hosted PWA's scripts, styles, font, or manifest.
await mkdir(deliverables, { recursive: true });
const logo = await readFile(path.join(root, 'assets', 'brand', 'IMB-icon.svg'));
const font = await readFile(path.join(root, 'electron', 'assets', 'MiSans-Demibold.ttf'));
const standaloneStyles = styles.replace(
  /url\((?:'|\")?\.\/MiSans-Demibold\.ttf(?:'|\")?\)/g,
  `url("${dataUrl('font/ttf', font)}")`
);
const standaloneScripts = [
  await read('web/board-data.js'),
  `window.IMB_SHARE_TEMPLATES=${JSON.stringify(templates)};`,
  await read('web/media-loader.js'),
  await read('electron/share/fflate.js'),
  await read('electron/share/web-api.js'),
  await read('src/app.js')
].map(escapeInlineScript).join('\n');
const logoUrl = dataUrl('image/svg+xml', logo);
let standaloneHtml = await read('web/index.html');
standaloneHtml = standaloneHtml
  .replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
  .replace('<link rel="icon" type="image/svg+xml" href="imb-icon.svg" />', `<link rel="icon" type="image/svg+xml" href="${logoUrl}" />`)
  .replace(/\s*<link rel="manifest" href="manifest\.webmanifest" \/>/, '')
  .replace('<link rel="stylesheet" href="styles.css" />', `<style>${standaloneStyles}</style>`)
  .replaceAll('src="imb-icon.svg"', `src="${logoUrl}"`)
  .replace(/\s*<script src="board-data\.js"><\/script><script src="template-data\.js"><\/script><script src="media-loader\.js"><\/script><script src="fflate\.js"><\/script><script src="web-api\.js"><\/script><script src="app\.js"><\/script><script src="register\.js"><\/script>/,
    `\n    <script>${standaloneScripts}</script>`);
await writeFile(path.join(deliverables, 'IMB Web.html'), standaloneHtml);

console.log(`Built hosted IMB Web at ${out}`);
console.log(`Built single-file IMB Web at ${path.join(deliverables, 'IMB Web.html')}`);
