const { app, BrowserWindow, ClipboardItem, clipboard, dialog, ipcMain, Menu, Tray } = require('electron');
const { createWriteStream, rmSync } = require('node:fs');
const { copyFile, mkdir, open: openFile, readFile, rename, rm, stat, writeFile } = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const archiver = require('archiver');
const execFileAsync = promisify(execFile);

const BOARD_ITEM_CLIPBOARD_TYPE = 'web application/x-infinite-media-board-item';
const DATABASE_MAGIC = Buffer.from('SQLite format 3\0');
const ASSET_CHUNK_SIZE = 4 * 1024 * 1024;
const STORAGE_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

let mainWindow;
let tray;
let quitting = false;
let hideRequestPending = false;
let traySessionAvailable = false;
let exitRequestPending = false;
let pendingBoardPath = process.argv.find((argument) => path.extname(argument).toLowerCase() === '.imb') || null;
const testHiddenMode = process.argv.includes('--test-hidden');
const hasSingleInstanceLock = testHiddenMode || app.requestSingleInstanceLock();

function traySessionPath() {
  return path.join(app.getPath('temp'), 'InfiniteMediaBoard-tray-session.json');
}

function workingStorageRoot() {
  return path.join(app.getPath('userData'), 'working-media');
}

function storageDirectory(storageId) {
  if (!STORAGE_ID_PATTERN.test(storageId || '')) throw new Error('无效的画板存储标识');
  return path.join(workingStorageRoot(), storageId);
}

function mediaMimeType(filePath) {
  return {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.ogv': 'video/ogg'
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function cleanupStorage(storageId) {
  await rm(storageDirectory(storageId), { recursive: true, force: true });
}

async function cleanupAllStorage() {
  await rm(workingStorageRoot(), { recursive: true, force: true });
  await rm(path.join(app.getPath('userData'), 'clipboard-media'), { recursive: true, force: true });
}

function cleanupAllStorageSync() {
  rmSync(workingStorageRoot(), { recursive: true, force: true });
  rmSync(path.join(app.getPath('userData'), 'clipboard-media'), { recursive: true, force: true });
}

async function cacheMediaPaths(storageId, sourcePaths) {
  const directory = storageDirectory(storageId);
  await mkdir(directory, { recursive: true });
  const cached = [];
  for (const sourcePath of sourcePaths) {
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) continue;
    const resolvedSource = path.resolve(sourcePath);
    if (path.dirname(resolvedSource).toLowerCase() === path.resolve(directory).toLowerCase()) {
      cached.push({ path: resolvedSource, assetId: path.parse(resolvedSource).name, name: path.basename(resolvedSource) });
      continue;
    }
    const assetId = randomUUID();
    const extension = path.extname(sourcePath).toLowerCase();
    const targetPath = path.join(directory, `${assetId}${extension}`);
    await copyFile(sourcePath, targetPath);
    cached.push({ path: targetPath, assetId, name: path.basename(sourcePath) });
  }
  return cached;
}

async function writeWindowsFileClipboard(filePaths) {
  const encodedPaths = Buffer.from(JSON.stringify(filePaths), 'utf8').toString('base64');
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:IMB_CLIPBOARD_PATHS_BASE64))
$parsedPaths = ConvertFrom-Json -InputObject $json
$paths = @($parsedPaths | ForEach-Object { [string]$_ })
$files = New-Object System.Collections.Specialized.StringCollection
foreach ($filePath in $paths) { [void]$files.Add([string]$filePath) }
$data = New-Object System.Windows.Forms.DataObject
$data.SetFileDropList($files)
$data.SetText([string]::Join([Environment]::NewLine, [string[]]$paths))
$image = $null
if ($paths.Count -eq 1 -and [IO.Path]::GetExtension($paths[0]) -match '^\\.(png|jpe?g|bmp)$') {
  $image = [Drawing.Image]::FromFile($paths[0])
  $data.SetImage($image)
}
try { [Windows.Forms.Clipboard]::SetDataObject($data, $true) } finally { if ($null -ne $image) { $image.Dispose() } }
`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    env: { ...process.env, IMB_CLIPBOARD_PATHS_BASE64: encodedPaths },
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

async function uniqueExportPath(directory, preferredName) {
  const parsed = path.parse(preferredName || '素材');
  const safeBase = (parsed.name || '素材').replace(/[\\/:*?"<>|]/g, '_');
  const safeExtension = parsed.ext.replace(/[\\/:*?"<>|]/g, '');
  let candidate = path.join(directory, `${safeBase}${safeExtension}`);
  let suffix = 2;
  while (true) {
    try { await stat(candidate); }
    catch { return candidate; }
    candidate = path.join(directory, `${safeBase} (${suffix++})${safeExtension}`);
  }
}

function initializeProjectDatabase(database) {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (
      asset_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      extension TEXT NOT NULL,
      size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS asset_chunks (
      asset_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (asset_id, chunk_index),
      FOREIGN KEY (asset_id) REFERENCES assets(asset_id) ON DELETE CASCADE
    );
  `);
}

async function isProjectDatabase(filePath) {
  try {
    const handle = await openFile(filePath, 'r');
    try {
      const header = Buffer.alloc(DATABASE_MAGIC.length);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.equals(DATABASE_MAGIC);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function insertAsset(database, item) {
  const fileStat = await stat(item.path);
  const insertAssetRow = database.prepare('INSERT INTO assets(asset_id, name, extension, size) VALUES (?, ?, ?, ?)');
  const insertChunk = database.prepare('INSERT INTO asset_chunks(asset_id, chunk_index, data) VALUES (?, ?, ?)');
  insertAssetRow.run(item.assetId, item.name || path.basename(item.path), path.extname(item.path).toLowerCase(), fileStat.size);
  const handle = await openFile(item.path, 'r');
  const buffer = Buffer.allocUnsafe(ASSET_CHUNK_SIZE);
  let chunkIndex = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      insertChunk.run(item.assetId, chunkIndex++, buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function writeProjectDatabase(targetPath, payload) {
  const data = JSON.parse(payload.content);
  const compact = payload.mode === 'manual' || !(await isProjectDatabase(targetPath));
  const temporaryPath = compact ? `${targetPath}.writing-${randomUUID()}` : targetPath;
  const database = new DatabaseSync(temporaryPath);
  try {
    database.exec('PRAGMA foreign_keys = ON;');
    initializeProjectDatabase(database);
    const existingAssets = new Set(database.prepare('SELECT asset_id FROM assets').all().map((row) => row.asset_id));
    const referencedAssets = new Map();
    for (const item of data.items || []) {
      if (item.type === 'text') continue;
      if (!item.assetId || !item.path) throw new Error(`素材缺少内部副本：${item.name || '未知素材'}`);
      if (!referencedAssets.has(item.assetId)) referencedAssets.set(item.assetId, item);
    }

    database.exec('BEGIN IMMEDIATE;');
    try {
      for (const item of referencedAssets.values()) {
        if (!existingAssets.has(item.assetId)) await insertAsset(database, item);
      }
      const referencedIds = new Set(referencedAssets.keys());
      for (const row of database.prepare('SELECT asset_id FROM assets').all()) {
        if (!referencedIds.has(row.asset_id)) database.prepare('DELETE FROM assets WHERE asset_id = ?').run(row.asset_id);
      }
      const packagedData = {
        ...data,
        format: 'infinite-media-board-package',
        version: 2,
        items: data.items.map((item) => ({ ...item, path: null }))
      };
      database.prepare(`INSERT INTO metadata(key, value) VALUES ('manifest', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(packagedData));
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    if (compact) database.exec('VACUUM;');
  } finally {
    database.close();
  }
  if (compact) {
    await rm(targetPath, { force: true });
    await rename(temporaryPath, targetPath);
  }
}

async function extractProjectDatabase(filePath) {
  const storageId = randomUUID();
  const directory = storageDirectory(storageId);
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const manifestRow = database.prepare(`SELECT value FROM metadata WHERE key = 'manifest'`).get();
    if (!manifestRow) throw new Error('画板项目缺少清单');
    const data = JSON.parse(manifestRow.value);
    const assetRows = database.prepare('SELECT asset_id, name, extension FROM assets').all();
    const chunkStatement = database.prepare('SELECT data FROM asset_chunks WHERE asset_id = ? ORDER BY chunk_index');
    const extractedPaths = new Map();
    for (const asset of assetRows) {
      const targetPath = path.join(directory, `${asset.asset_id}${asset.extension}`);
      const handle = await openFile(targetPath, 'w');
      try {
        for (const chunk of chunkStatement.iterate(asset.asset_id)) await handle.write(Buffer.from(chunk.data));
      } finally {
        await handle.close();
      }
      extractedPaths.set(asset.asset_id, targetPath);
    }
    data.format = 'infinite-media-board';
    data.items = (data.items || []).map((item) => ({ ...item, path: extractedPaths.get(item.assetId) || '' }));
    return { path: filePath, content: JSON.stringify(data), storageId };
  } catch (error) {
    await cleanupStorage(storageId);
    throw error;
  } finally {
    database.close();
  }
}

async function openLegacyBoard(filePath) {
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  if (data.format !== 'infinite-media-board' || !Array.isArray(data.items)) throw new Error('格式错误');
  const storageId = randomUUID();
  const cachedByPath = new Map();
  for (const item of data.items) {
    if (!item.path) continue;
    try {
      let cached = cachedByPath.get(item.path);
      if (!cached) {
        [cached] = await cacheMediaPaths(storageId, [item.path]);
        cachedByPath.set(item.path, cached);
      }
      item.path = cached.path;
      item.assetId = cached.assetId;
    } catch {}
  }
  return { path: filePath, content: JSON.stringify(data), storageId, needsMigration: true };
}

async function openBoardFile(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.imb') throw new Error('不是 .imb 画板文件');
  return (await isProjectDatabase(filePath)) ? extractProjectDatabase(filePath) : openLegacyBoard(filePath);
}

async function sendBoardPathToRenderer(filePath) {
  if (!filePath || !mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('board:open-path', await openBoardFile(filePath));
  } catch (error) {
    dialog.showErrorBox('打开画板失败', error.message);
  }
}

function openBoardPath(filePath) {
  if (!filePath) return;
  pendingBoardPath = filePath;
  showMainWindow();
  if (!mainWindow.webContents.isLoadingMainFrame()) {
    const targetPath = pendingBoardPath;
    pendingBoardPath = null;
    sendBoardPathToRenderer(targetPath);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!testHiddenMode) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function requestExit() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (exitRequestPending) return;
    exitRequestPending = true;
    mainWindow.webContents.send('window:prepare-exit');
    return;
  }
  quitting = true;
  app.quit();
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'tray.ico'));
  tray.setToolTip('Infinite Media Board');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示画板', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: requestExit }
  ]));
  tray.on('double-click', showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 520,
    backgroundColor: '#151619',
    title: '\u200B',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#202226',
      symbolColor: '#f4f5f7',
      height: 46
    },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  mainWindow.webContents.once('did-finish-load', async () => {
    if (mainWindow.isDestroyed()) return;
    if (traySessionAvailable) {
      try {
        const content = await readFile(traySessionPath(), 'utf8');
        mainWindow.webContents.send('window:restore-tray-session', content);
      } catch {}
    }
    if (pendingBoardPath) {
      const targetPath = pendingBoardPath;
      pendingBoardPath = null;
      await sendBoardPathToRenderer(targetPath);
    }
  });
  mainWindow.once('ready-to-show', () => {
    if (!testHiddenMode) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (hideRequestPending) return;
    hideRequestPending = true;
    mainWindow.webContents.send('window:prepare-hide-to-tray');
  });

  mainWindow.on('closed', () => {
    hideRequestPending = false;
    mainWindow = null;
  });
}

ipcMain.handle('window:hide-to-tray', async (_event, snapshot) => {
  try {
    await writeFile(traySessionPath(), snapshot, 'utf8');
    traySessionAvailable = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    return true;
  } finally {
    if (mainWindow && !mainWindow.isDestroyed()) hideRequestPending = false;
  }
});

ipcMain.handle('window:complete-exit', async () => {
  quitting = true;
  await cleanupAllStorage();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  app.quit();
  return true;
});

ipcMain.handle('window:cancel-exit', () => {
  exitRequestPending = false;
  return true;
});

ipcMain.handle('board:save', async (_event, payload) => {
  let targetPath = payload.path;
  if (!targetPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存画板',
      defaultPath: '未命名画板.imb',
      filters: [{ name: 'Infinite Media Board', extensions: ['imb'] }]
    });
    if (result.canceled) return null;
    targetPath = result.filePath;
  }
  await writeProjectDatabase(targetPath, payload);
  return { path: targetPath, storageId: payload.storageId };
});

ipcMain.handle('board:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开画板',
    properties: ['openFile'],
    filters: [{ name: 'Infinite Media Board', extensions: ['imb'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return openBoardFile(result.filePaths[0]);
});

ipcMain.handle('board:open-path-file', async (_event, filePath) => {
  return openBoardFile(filePath);
});

ipcMain.handle('board:export-share', async (_event, payload) => {
  const safeTitle = String(payload.title || '共享画板').replace(/[\\/:*?"<>|]/g, '_').trim() || '共享画板';
  let shareMode = payload.mode;
  if (!['editable', 'readonly'].includes(shareMode)) shareMode = 'readonly';
  let targetPath = testHiddenMode ? payload.targetPath : null;
  if (!targetPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: `导出${shareMode === 'editable' ? '可编辑' : '只读'}跨平台分享包`,
      defaultPath: `${safeTitle}-${shareMode === 'editable' ? '可编辑' : '只读'}分享包.zip`,
      filters: [{ name: '网页画板分享包', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return null;
    targetPath = result.filePath;
  }

  const sharedItems = [];
  const archivedAssets = new Map();
  let missingCount = 0;
  for (const item of payload.items || []) {
    if (item.type === 'text') {
      sharedItems.push({ ...item, path: null });
      continue;
    }
    const assetKey = item.assetId || item.path;
    let sharedPath = archivedAssets.get(assetKey)?.sharedPath;
    if (!sharedPath) {
      try {
        const mediaStat = await stat(item.path);
        if (!mediaStat.isFile()) throw new Error('not a file');
        const extension = path.extname(item.name || item.path).toLowerCase();
        const assetDirectory = shareMode === 'editable' ? 'embedded' : 'media';
        sharedPath = `${assetDirectory}/${String(archivedAssets.size + 1).padStart(4, '0')}${extension}`;
        archivedAssets.set(assetKey, { sourcePath: item.path, sharedPath });
      } catch {
        missingCount += 1;
        continue;
      }
    }
    sharedItems.push({ ...item, path: sharedPath });
  }

  const viewerCss = await readFile(path.join(__dirname, 'share', 'viewer.css'), 'utf8');
  const editorCss = shareMode === 'editable'
    ? (await readFile(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8')).replace(/^@font-face\s*\{[\s\S]*?\}\s*/, '')
    : '';
  const fontBase64 = (await readFile(path.join(__dirname, 'assets', 'MiSans-Demibold.ttf'))).toString('base64');
  const finalViewerCss = `@font-face{font-family:'MiSans';src:url(data:font/ttf;base64,${fontBase64}) format('truetype');font-weight:600;font-style:normal;font-display:swap;}\n${viewerCss}`;
  const finalEditorCss = shareMode === 'editable'
    ? `@font-face{font-family:'MiSans';src:url(data:font/ttf;base64,${fontBase64}) format('truetype');font-weight:600;font-style:normal;font-display:swap;}\n${editorCss}`
    : '';
  const editableTemplates = shareMode === 'editable' ? {
    editorHtml: await readFile(path.join(__dirname, 'share', 'editor.html'), 'utf8'),
    webApiJs: await readFile(path.join(__dirname, 'share', 'web-api.js'), 'utf8'),
    fflateJs: await readFile(path.join(__dirname, 'share', 'fflate.js'), 'utf8'),
    fflateLicense: await readFile(path.join(__dirname, 'share', 'fflate-LICENSE.txt'), 'utf8'),
    appJs: await readFile(path.join(__dirname, '..', 'src', 'app.js'), 'utf8'),
    stylesCss: finalEditorCss,
    viewerHtml: await readFile(path.join(__dirname, 'share', 'viewer.html'), 'utf8'),
    viewerCss: finalViewerCss,
    viewerJs: await readFile(path.join(__dirname, 'share', 'viewer.js'), 'utf8')
  } : null;
  const editableEmbeddedAssets = [];
  if (shareMode === 'editable') {
    for (const asset of archivedAssets.values()) {
      const scriptPath = `${asset.sharedPath}.js`;
      const base64 = (await readFile(asset.sourcePath)).toString('base64');
      editableEmbeddedAssets.push({
        scriptPath,
        source: `window.IMB_EMBEDDED_MEDIA[${JSON.stringify(asset.sharedPath)}]={name:${JSON.stringify(path.basename(asset.sourcePath))},mime:${JSON.stringify(mediaMimeType(asset.sourcePath))},base64:${JSON.stringify(base64)}};`
      });
    }
  }
  try {
    await new Promise((resolve, reject) => {
      const output = createWriteStream(targetPath);
      const archive = archiver('zip', { store: true });
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      if (shareMode === 'editable') {
        archive.append(editableTemplates.editorHtml, { name: '打开可编辑画板.html' });
        archive.append(editableTemplates.webApiJs, { name: 'web-api.js' });
        archive.append(editableTemplates.fflateJs, { name: 'fflate.js' });
        archive.append(editableTemplates.fflateLicense, { name: 'fflate-LICENSE.txt' });
        archive.append(editableTemplates.appJs, { name: 'app.js' });
        archive.append(editableTemplates.stylesCss, { name: 'styles.css' });
        archive.append(editableTemplates.viewerHtml, { name: 'viewer.html' });
        archive.append(editableTemplates.viewerCss, { name: 'viewer.css' });
        archive.append(editableTemplates.viewerJs, { name: 'viewer.js' });
        archive.append(`window.IMB_SHARE_TEMPLATES = ${JSON.stringify(editableTemplates)};`, { name: 'template-data.js' });
        for (const asset of editableEmbeddedAssets) archive.append(asset.source, { name: asset.scriptPath });
        archive.append(`window.IMB_EMBEDDED_MEDIA={};document.write(${JSON.stringify(editableEmbeddedAssets.map((asset) => `<script src="${asset.scriptPath}"></script>`).join(''))});`, { name: 'media-loader.js' });
      } else {
        archive.file(path.join(__dirname, 'share', 'viewer.html'), { name: '打开画板.html' });
        archive.append(finalViewerCss, { name: 'viewer.css' });
        archive.file(path.join(__dirname, 'share', 'viewer.js'), { name: 'viewer.js' });
      }
      archive.append(`window.SHARED_BOARD = ${JSON.stringify({
        format: 'infinite-media-board-share',
        version: 1,
        shareId: randomUUID(),
        title: payload.title || '共享画板',
        mode: shareMode,
        camera: payload.camera,
        audioMuted: Boolean(payload.audioMuted),
        allPaused: Boolean(payload.allPaused),
        items: sharedItems
      })};`, { name: 'board-data.js' });
      archive.append(
        `${shareMode === 'editable' ? '编辑' : '查看'}方法 / How to ${shareMode === 'editable' ? 'edit' : 'view'}\r\n\r\n` +
        '1. 请先完整解压这个 ZIP。\r\n' +
        `2. 使用 Chrome、Edge、Safari 或 Firefox 打开“${shareMode === 'editable' ? '打开可编辑画板.html' : '打开画板.html'}”。\r\n` +
        (shareMode === 'editable' ? '3. 编辑结果会自动保存在当前浏览器；点击“保存”会立即写入当前浏览器项目。\r\n' : '3. 电脑：拖动平移，滚轮缩放；手机/平板：单指平移，双指缩放。\r\n') +
        '4. 视频默认静音；电脑悬停或手机轻点视频可开启对应声音。\r\n\r\n' +
        `Unzip the package, then open ${shareMode === 'editable' ? '打开可编辑画板.html' : '打开画板.html'} in a modern browser.\r\n` +
        'Video playback depends on codec support in the receiving device browser.\r\n',
        { name: '查看说明.txt' }
      );
      archive.append(
        '本分享画板使用小米 MiSans 字体。字体已嵌入查看器，仅用于呈现画板文本。\r\n' +
        'MiSans 官方许可：https://hyperos.mi.com/font/en/download/\r\n',
        { name: 'MiSans字体说明.txt' }
      );
      if (shareMode === 'readonly') {
        for (const asset of archivedAssets.values()) archive.file(asset.sourcePath, { name: asset.sharedPath, store: true });
      }
      archive.finalize();
    });
  } catch (error) {
    await rm(targetPath, { force: true });
    throw error;
  }

  return { path: targetPath, itemCount: sharedItems.length, missingCount, mode: shareMode };
});

ipcMain.handle('media:cache', async (_event, payload) => cacheMediaPaths(payload.storageId, payload.paths));
ipcMain.handle('storage:cleanup', async (_event, storageId) => cleanupStorage(storageId));
ipcMain.handle('storage:cleanup-all', async () => cleanupAllStorage());

ipcMain.handle('media:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '添加媒体',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '媒体文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'mp4', 'webm', 'mov', 'm4v', 'ogv'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('media:context-menu', async (_event, payload) => {
  const selectedCount = typeof payload === 'number' ? payload : payload?.selectedCount || 1;
  return new Promise((resolve) => {
    let chosen = null;
    const menu = Menu.buildFromTemplate([
      { label: `复制${selectedCount > 1 ? ` ${selectedCount} 个素材` : '素材'}  Ctrl+C`, click: () => { chosen = 'copy'; } },
      { type: 'separator' },
      { label: `保存${selectedCount > 1 ? ` ${selectedCount} 个素材` : '素材'}到…`, click: () => { chosen = 'save'; } },
      { label: `合并导出为图片…  Ctrl+Shift+E`, click: () => { chosen = 'export-image'; } }
    ]);
    menu.popup({ window: mainWindow, callback: () => resolve(chosen) });
  });
});

ipcMain.handle('media:export-selected', async (_event, payload) => {
  let targetDirectory = testHiddenMode ? payload.targetDirectory : null;
  if (!targetDirectory) {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `选择保存 ${payload.items?.length || 0} 个素材的位置`,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths[0]) return null;
    targetDirectory = result.filePaths[0];
  }
  await mkdir(targetDirectory, { recursive: true });
  const exported = [];
  const failed = [];
  for (const item of payload.items || []) {
    try {
      if (item.type === 'text') {
        const textName = path.extname(item.name || '') ? item.name : `${item.name || '文本'}.txt`;
        const targetPath = await uniqueExportPath(targetDirectory, textName);
        await writeFile(targetPath, item.text || '', 'utf8');
        exported.push(targetPath);
        continue;
      }
      const sourceStat = await stat(item.path);
      if (!sourceStat.isFile()) throw new Error('素材文件不存在');
      const targetPath = await uniqueExportPath(targetDirectory, item.name || path.basename(item.path));
      await copyFile(item.path, targetPath);
      exported.push(targetPath);
    } catch (error) {
      failed.push({ name: item.name || path.basename(item.path || ''), message: error.message });
    }
  }
  return { directory: targetDirectory, exported, failed };
});

ipcMain.handle('media:export-composite', async (_event, payload) => {
  let targetPath = testHiddenMode ? payload.targetPath : null;
  if (!targetPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '将选中素材合并导出为图片',
      defaultPath: payload.defaultName || '选中素材.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return null;
    targetPath = result.filePath;
  }
  if (!/\.png$/i.test(targetPath)) targetPath += '.png';
  await writeFile(targetPath, Buffer.from(payload.bytes));
  return { path: targetPath, width: payload.width, height: payload.height };
});

ipcMain.handle('window:toggle-always-on-top', () => {
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  return next;
});

ipcMain.handle('window:is-always-on-top', () => mainWindow.isAlwaysOnTop());

ipcMain.handle('clipboard:write-board-item', async (_event, item) => {
  const filePaths = (item.items || [item]).map((entry) => entry.path).filter(Boolean);
  if (process.platform === 'win32' && filePaths.length) {
    await writeWindowsFileClipboard(filePaths);
  } else {
    const payload = JSON.stringify(item);
    await clipboard.write([
      new ClipboardItem({
        [BOARD_ITEM_CLIPBOARD_TYPE]: new Blob([payload], { type: BOARD_ITEM_CLIPBOARD_TYPE }),
        'text/plain': filePaths.join('\n') || item.name || ''
      })
    ]);
  }
  return true;
});

ipcMain.handle('clipboard:read-media', async () => {
  const clipboardItems = await clipboard.read();

  for (const clipboardItem of clipboardItems) {
    if (clipboardItem.types.includes(BOARD_ITEM_CLIPBOARD_TYPE)) {
      const blob = await clipboardItem.getType(BOARD_ITEM_CLIPBOARD_TYPE);
      return { kind: 'board-item', item: JSON.parse(await blob.text()) };
    }
  }

  for (const clipboardItem of clipboardItems) {
    if (!clipboardItem.types.includes('text/uri-list')) continue;
    const blob = await clipboardItem.getType('text/uri-list');
    const uriList = await blob.text();
    const paths = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((uri) => {
        try { return uri.startsWith('file:') ? fileURLToPath(uri) : null; }
        catch { return null; }
      })
      .filter(Boolean);
    if (paths.length) return { kind: 'paths', paths };
  }

  const clipboardText = (await clipboard.readText()).trim();
  if (clipboardText) {
    const candidates = clipboardText.split(/\r?\n/).map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const paths = [];
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) paths.push(candidate);
      } catch {}
    }
    if (paths.length) return { kind: 'paths', paths };
  }

  for (const clipboardItem of clipboardItems) {
    const imageType = clipboardItem.types.find((type) => type.startsWith('image/'));
    if (!imageType) continue;
    const blob = await clipboardItem.getType(imageType);
    const extension = {
      'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp'
    }[imageType] || 'png';
    const cacheDirectory = path.join(app.getPath('userData'), 'clipboard-media');
    await mkdir(cacheDirectory, { recursive: true });
    const targetPath = path.join(cacheDirectory, `clipboard-${Date.now()}.${extension}`);
    await writeFile(targetPath, Buffer.from(await blob.arrayBuffer()));
    return { kind: 'paths', paths: [targetPath] };
  }

  if (clipboardText) {
    const candidates = clipboardText.split(/\r?\n/).map((line) => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const paths = [];
    for (const candidate of candidates) {
      try {
        if ((await stat(candidate)).isFile()) paths.push(candidate);
      } catch {}
    }
    if (paths.length) return { kind: 'paths', paths };
  }

  if (clipboardText) return { kind: 'text', text: clipboardText };
  return { kind: 'unsupported' };
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (!app.isReady()) return;
    const boardPath = commandLine.find((argument) => path.extname(argument).toLowerCase() === '.imb');
    if (boardPath) openBoardPath(boardPath);
    else showMainWindow();
  });

  app.whenReady().then(async () => {
    await cleanupAllStorage();
    createWindow();
    createTray();
    app.on('activate', () => {
      showMainWindow();
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
  cleanupAllStorageSync();
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});
