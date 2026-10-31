const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

contextBridge.exposeInMainWorld('boardAPI', {
  filePath: (file) => webUtils.getPathForFile(file),
  fileURL: (nativePath) => pathToFileURL(nativePath).href,
  basename: (nativePath) => path.basename(nativePath),
  save: (payload) => ipcRenderer.invoke('board:save', payload),
  exportShare: (payload) => ipcRenderer.invoke('board:export-share', payload),
  open: () => ipcRenderer.invoke('board:open'),
  openPath: (filePath) => ipcRenderer.invoke('board:open-path-file', filePath),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  showMediaContextMenu: (selectedCount) => ipcRenderer.invoke('media:context-menu', selectedCount),
  exportSelectedMedia: (payload) => ipcRenderer.invoke('media:export-selected', payload),
  exportCompositeImage: (payload) => ipcRenderer.invoke('media:export-composite', payload),
  cacheMedia: (payload) => ipcRenderer.invoke('media:cache', payload),
  cleanupStorage: (storageId) => ipcRenderer.invoke('storage:cleanup', storageId),
  cleanupAllStorage: () => ipcRenderer.invoke('storage:cleanup-all'),
  writeClipboardItem: (item) => ipcRenderer.invoke('clipboard:write-board-item', item),
  readClipboardMedia: () => ipcRenderer.invoke('clipboard:read-media'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('window:toggle-always-on-top'),
  isAlwaysOnTop: () => ipcRenderer.invoke('window:is-always-on-top'),
  hideToTray: (snapshot) => ipcRenderer.invoke('window:hide-to-tray', snapshot),
  completeExit: () => ipcRenderer.invoke('window:complete-exit'),
  cancelExit: () => ipcRenderer.invoke('window:cancel-exit'),
  onOpenBoardPath: (callback) => ipcRenderer.on('board:open-path', (_event, result) => callback(result)),
  onPrepareExit: (callback) => ipcRenderer.on('window:prepare-exit', () => callback()),
  onPrepareHideToTray: (callback) => ipcRenderer.on('window:prepare-hide-to-tray', () => callback()),
  onRestoreTraySession: (callback) => ipcRenderer.on('window:restore-tray-session', (_event, content) => callback(content))
});
