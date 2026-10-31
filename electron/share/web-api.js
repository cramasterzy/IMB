(() => {
  const shared = window.SHARED_BOARD || { title: '共享画板', items: [] };
  const mappedFiles = new Map();
  let clipboardItem = null;
  let openBoardCallback = null;
  let sequence = 0;
  const storageKey = `imb-editable-${shared.shareId || shared.title || 'board'}`;
  const databaseName = `InfiniteMediaBoard-${shared.shareId || 'shared'}`;

  function base64Blob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime || 'application/octet-stream' });
  }

  async function restoreEmbeddedMedia() {
    for (const [key, asset] of Object.entries(window.IMB_EMBEDDED_MEDIA || {})) {
      const blob = base64Blob(asset.base64, asset.mime);
      const file = new File([blob], asset.name || basename(key), { type: asset.mime || blob.type });
      mappedFiles.set(key, { file, url: URL.createObjectURL(file) });
      await storeMappedFile(key, file).catch(() => {});
      delete asset.base64;
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.addEventListener('upgradeneeded', () => request.result.createObjectStore('media'));
      request.addEventListener('success', () => resolve(request.result));
      request.addEventListener('error', () => reject(request.error));
    });
  }

  async function storeMappedFile(key, file) {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction('media', 'readwrite');
      transaction.objectStore('media').put(file, key);
      transaction.addEventListener('complete', resolve);
      transaction.addEventListener('error', () => reject(transaction.error));
    });
    database.close();
  }

  async function restoreMappedFiles(data) {
    const keys = [...new Set((data.items || []).map((item) => item.path).filter((path) => String(path || '').startsWith('browser-file-')))];
    if (!keys.length) return;
    const database = await openDatabase();
    await Promise.all(keys.map((key) => new Promise((resolve) => {
      const request = database.transaction('media').objectStore('media').get(key);
      request.addEventListener('success', () => {
        if (request.result) mappedFiles.set(key, { file: request.result, url: URL.createObjectURL(request.result) });
        resolve();
      });
      request.addEventListener('error', resolve);
    })));
    database.close();
  }

  function basename(value) {
    return String(value || '').split(/[\\/]/).pop() || '共享画板.imb';
  }

  function mappedPath(file) {
    const extension = (file.name.match(/\.[^.]+$/) || [''])[0];
    const key = `browser-file-${Date.now()}-${sequence++}${extension}`;
    mappedFiles.set(key, { file, url: URL.createObjectURL(file) });
    return key;
  }

  function clipboardExtension(mime) {
    const extensions = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/bmp': '.bmp',
      'image/gif': '.gif',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov'
    };
    return extensions[mime] || '';
  }

  async function readSystemClipboardMedia() {
    if (!navigator.clipboard?.read) return [];
    const clipboardItems = await navigator.clipboard.read();
    const paths = [];
    for (const clipboardEntry of clipboardItems) {
      const mime = clipboardEntry.types.find((type) => clipboardExtension(type));
      if (!mime) continue;
      const blob = await clipboardEntry.getType(mime);
      const extension = clipboardExtension(mime);
      const prefix = mime.startsWith('video/') ? '粘贴视频' : mime === 'image/gif' ? '粘贴GIF' : '粘贴截图';
      const file = new File([blob], `${prefix}-${Date.now()}-${paths.length + 1}${extension}`, { type: mime });
      paths.push(mappedPath(file));
    }
    return paths;
  }

  function fileURL(value) {
    const mapped = mappedFiles.get(value);
    return mapped ? mapped.url : new URL(String(value || ''), location.href).href;
  }

  function download(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
  }

  function chooseFiles(accept, multiple = false) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept; input.multiple = multiple;
      input.addEventListener('change', () => resolve([...input.files].map(mappedPath)), { once: true });
      input.click();
    });
  }

  async function readBoard(path) {
    const mapped = mappedFiles.get(path);
    if (!mapped) throw new Error('请选择浏览器可读取的 .imb 文件');
    const content = await mapped.file.text();
    const data = JSON.parse(content);
    if (data.format !== 'infinite-media-board' || !Array.isArray(data.items)) throw new Error('格式错误');
    return { path: mapped.file.name, content };
  }

  async function exportOne(item, index) {
    if (item.type === 'text') {
      download(new Blob([item.text || ''], { type: 'text/plain;charset=utf-8' }), `${item.name || `文本-${index + 1}`}.txt`);
      return true;
    }
    try {
      const response = await fetch(fileURL(item.path));
      if (!response.ok) throw new Error('读取失败');
      download(await response.blob(), item.name || `素材-${index + 1}`);
      return true;
    } catch { return false; }
  }

  function safeTitle(value) {
    return String(value || '共享画板').replace(/[\\/:*?"<>|]/g, '_').trim() || '共享画板';
  }

  function extensionFor(item) {
    return (String(item.name || item.path || '').match(/\.[^.?#]+$/) || [item.type === 'video' ? '.mp4' : '.png'])[0].toLowerCase();
  }

  function blobBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] || ''));
      reader.addEventListener('error', () => reject(reader.error));
      reader.readAsDataURL(blob);
    });
  }

  function showWebContextMenu(payload) {
    return new Promise((resolve) => {
      document.querySelector('.web-context-menu')?.remove();
      const menu = document.createElement('div');
      menu.className = 'web-context-menu';
      const count = payload?.selectedCount || 1;
      const finish = (action) => { menu.remove(); resolve(action); };
      for (const [action, label] of [['copy', `复制${count > 1 ? ` ${count} 个素材` : '素材'}`], ['save', `保存${count > 1 ? ` ${count} 个素材` : '素材'}到…`], ['export-image', '合并导出为图片…']]) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', (event) => { event.stopPropagation(); finish(action); });
        menu.append(button);
      }
      document.body.append(menu);
      menu.style.left = `${Math.min(payload?.x || 0, innerWidth - menu.offsetWidth - 8)}px`;
      menu.style.top = `${Math.min(payload?.y || 0, innerHeight - menu.offsetHeight - 8)}px`;
      const dismiss = (event) => { if (!menu.contains(event.target)) finish(null); };
      setTimeout(() => document.addEventListener('pointerdown', dismiss, { once: true }), 0);
    });
  }

  async function exportWebShare({ title, items, mode, camera, audioMuted, allPaused }) {
    if (!window.fflate || !window.IMB_SHARE_TEMPLATES) throw new Error('分享打包组件缺失');
    const templates = window.IMB_SHARE_TEMPLATES;
    const encode = window.fflate.strToU8;
    const files = {};
    const assetPaths = new Map();
    const sharedItems = [];
    const embeddedScripts = [];
    let missingCount = 0;

    for (const item of items || []) {
      if (item.type === 'text') {
        sharedItems.push({ ...item, path: null });
        continue;
      }
      const assetKey = item.assetId || item.path;
      let target = assetPaths.get(assetKey);
      if (!target) {
        const folder = mode === 'editable' ? 'embedded' : 'media';
        target = `${folder}/${String(assetPaths.size + 1).padStart(4, '0')}${extensionFor(item)}`;
        try {
          const response = await fetch(fileURL(item.path));
          if (!response.ok) throw new Error('素材读取失败');
          const blob = await response.blob();
          if (mode === 'editable') {
            const scriptPath = `${target}.js`;
            const script = `window.IMB_EMBEDDED_MEDIA[${JSON.stringify(target)}]={name:${JSON.stringify(item.name || basename(target))},mime:${JSON.stringify(blob.type || 'application/octet-stream')},base64:${JSON.stringify(await blobBase64(blob))}};`;
            files[scriptPath] = encode(script);
            embeddedScripts.push(scriptPath);
          } else {
            files[target] = new Uint8Array(await blob.arrayBuffer());
          }
          assetPaths.set(assetKey, target);
        } catch {
          missingCount += 1;
          continue;
        }
      }
      sharedItems.push({ ...item, path: target });
    }

    const boardData = {
      format: 'infinite-media-board-share', version: 1, shareId: crypto.randomUUID(),
      title: title || '共享画板', mode, camera, audioMuted: Boolean(audioMuted), allPaused: Boolean(allPaused), items: sharedItems
    };
    files['board-data.js'] = encode(`window.SHARED_BOARD=${JSON.stringify(boardData)};`);
    files['MiSans字体说明.txt'] = encode('本分享画板使用小米 MiSans 字体。字体已嵌入查看器，仅用于呈现画板文本。\r\nMiSans 官方许可：https://hyperos.mi.com/font/en/download/\r\n');

    if (mode === 'editable') {
      files['打开可编辑画板.html'] = encode(templates.editorHtml);
      files['styles.css'] = encode(templates.stylesCss);
      files['app.js'] = encode(templates.appJs);
      files['web-api.js'] = encode(templates.webApiJs);
      files['fflate.js'] = encode(templates.fflateJs);
      files['fflate-LICENSE.txt'] = encode(templates.fflateLicense);
      files['viewer.html'] = encode(templates.viewerHtml);
      files['viewer.css'] = encode(templates.viewerCss);
      files['viewer.js'] = encode(templates.viewerJs);
      files['template-data.js'] = encode(`window.IMB_SHARE_TEMPLATES=${JSON.stringify(templates)};`);
      files['media-loader.js'] = encode(`window.IMB_EMBEDDED_MEDIA={};document.write(${JSON.stringify(embeddedScripts.map((source) => `<script src="${source}"></script>`).join(''))});`);
    } else {
      files['打开画板.html'] = encode(templates.viewerHtml);
      files['viewer.css'] = encode(templates.viewerCss);
      files['viewer.js'] = encode(templates.viewerJs);
    }

    const zipBytes = window.fflate.zipSync(files, { level: 0 });
    const name = `${safeTitle(title)}-${mode === 'editable' ? '可编辑' : '只读'}分享包.zip`;
    download(new Blob([zipBytes], { type: 'application/zip' }), name);
    return { path: name, itemCount: sharedItems.length, missingCount, mode };
  }

  const initialData = {
    format: 'infinite-media-board', version: 1,
    camera: shared.camera || { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 },
    items: shared.items || [], audioMuted: Boolean(shared.audioMuted), allPaused: Boolean(shared.allPaused)
  };

  window.boardAPI = {
    filePath: mappedPath,
    fileURL,
    basename,
    cacheMedia: async ({ paths }) => {
      const cached = [];
      for (let index = 0; index < paths.length; index += 1) {
        const path = paths[index];
        const mapped = mappedFiles.get(path);
        if (mapped?.file) await storeMappedFile(path, mapped.file);
        cached.push({ path, assetId: `web-${Date.now()}-${index}-${sequence++}`, name: mapped?.file.name || basename(path) });
      }
      return cached;
    },
    cleanupStorage: async () => true,
    cleanupAllStorage: async () => true,
    pickMedia: () => chooseFiles('image/*,video/*,.gif', true),
    open: async () => {
      const [path] = await chooseFiles('.imb,application/json');
      return path ? readBoard(path) : null;
    },
    openPath: readBoard,
    save: async ({ path, content }) => {
      localStorage.setItem(storageKey, content);
      const target = path || `${shared.title || '共享画板'}.imb`;
      return { path: target, storageId: shared.shareId || 'browser' };
    },
    exportShare: exportWebShare,
    showMediaContextMenu: showWebContextMenu,
    exportSelectedMedia: async ({ items }) => {
      const exported = [], failed = [];
      for (let index = 0; index < items.length; index += 1) (await exportOne(items[index], index) ? exported : failed).push(items[index].name || `素材-${index + 1}`);
      return { exported, failed };
    },
    exportCompositeImage: async ({ bytes, defaultName, width, height }) => {
      download(new Blob([bytes], { type: 'image/png' }), defaultName || '选中素材.png');
      return { path: defaultName || '选中素材.png', width, height };
    },
    writeClipboardItem: async (item) => {
      clipboardItem = structuredClone(item);
      const text = (item.items || []).filter((entry) => entry.type === 'text').map((entry) => entry.text || '').join('\n');
      if (text && navigator.clipboard?.writeText) await navigator.clipboard.writeText(text).catch(() => {});
      return true;
    },
    readClipboardMedia: async () => {
      const paths = await readSystemClipboardMedia().catch(() => []);
      if (paths.length) return { kind: 'paths', paths };
      if (clipboardItem) return { kind: 'board-item', item: clipboardItem };
      const text = await navigator.clipboard?.readText?.().catch(() => '');
      return text ? { kind: 'text', text } : { kind: 'none' };
    },
    toggleAlwaysOnTop: async () => false,
    isAlwaysOnTop: async () => false,
    hideToTray: async () => true,
    completeExit: async () => true,
    cancelExit: async () => true,
    onOpenBoardPath: (callback) => { openBoardCallback = callback; },
    onPrepareExit: () => {}, onPrepareHideToTray: () => {}, onRestoreTraySession: () => {}
  };

  addEventListener('DOMContentLoaded', async () => {
    const saved = localStorage.getItem(storageKey);
    const content = saved || JSON.stringify(initialData);
    try {
      await restoreEmbeddedMedia();
      await restoreMappedFiles(JSON.parse(content));
    } catch {}
    setTimeout(() => openBoardCallback?.({ path: `${shared.title || '共享画板'}.imb`, content }), 0);
  });
})();
