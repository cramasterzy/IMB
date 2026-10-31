const viewport = document.querySelector('#viewport');
const world = document.querySelector('#world');
const grid = document.querySelector('#grid');
const snapGuides = document.querySelector('#snap-guides');
const selectionOutline = document.querySelector('#selection-outline');
const selectionMarquee = document.querySelector('#selection-marquee');
const zoomLabel = document.querySelector('#zoom-label');
const itemCount = document.querySelector('#item-count');
const statusText = document.querySelector('#status-text');
const toastNode = document.querySelector('#toast');
const tabsNode = document.querySelector('#tabs');
const newTabButton = document.querySelector('#new-tab');

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);
const SNAP_DISTANCE_PX = 8;
const ZOOM_STEP = 0.05;

const state = {
  camera: { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 },
  items: [],
  selectedId: null,
  selectedIds: [],
  projectPath: null,
  storageId: crypto.randomUUID(),
  dirty: false,
  revision: 0,
  allPaused: false,
  audioMuted: false,
  snappingEnabled: true,
  clipboard: null,
  history: [],
  redoHistory: [],
  nextZ: 1
};

let interaction = null;
let dragDepth = 0;
let toastTimer;
let hoveredVideo = null;
const tabs = [];
let activeTabId = null;
let untitledCounter = 1;
const autosaveTimers = new Map();
const saveQueues = new Map();

function id() {
  return crypto.randomUUID();
}

function ext(path) {
  return path.split('.').pop().toLowerCase();
}

function mediaType(path) {
  const suffix = ext(path);
  if (VIDEO_EXTENSIONS.has(suffix)) return 'video';
  if (IMAGE_EXTENSIONS.has(suffix)) return suffix === 'gif' ? 'gif' : 'image';
  return null;
}

function normalizedFrameDuration(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 1 / 30;
  const measuredRate = 1 / duration;
  const commonRates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 120];
  const nearest = commonRates.reduce((best, rate) => Math.abs(rate - measuredRate) < Math.abs(best - measuredRate) ? rate : best);
  return Math.abs(nearest - measuredRate) / nearest < .04 ? 1 / nearest : duration;
}

function trackVideoFrameRate(video) {
  video._frameDuration = 1 / 30;
  if (typeof video.requestVideoFrameCallback !== 'function') return;
  let previousMediaTime = null;
  const samples = [];
  const observe = (_now, metadata) => {
    if (previousMediaTime !== null) {
      const delta = metadata.mediaTime - previousMediaTime;
      if (delta > 1 / 240 && delta < .2) {
        samples.push(delta);
        if (samples.length > 24) samples.shift();
        const sorted = [...samples].sort((first, second) => first - second);
        video._frameDuration = normalizedFrameDuration(sorted[Math.floor(sorted.length / 2)]);
      }
    }
    previousMediaTime = metadata.mediaTime;
    video.requestVideoFrameCallback(observe);
  };
  video.requestVideoFrameCallback(observe);
}

function stepHoveredVideo(direction) {
  if (!hoveredVideo?.video || !hoveredVideo.video.isConnected) {
    hoveredVideo = null;
    return false;
  }
  const { video, node } = hoveredVideo;
  const frameDuration = video._frameDuration || 1 / 30;
  const wasPaused = video.paused || Boolean(node._hoverStartedPlayback) || Boolean(node._frameStepPauseLock);
  node._hoverStartedPlayback = false;
  node._frameStepPauseLock = wasPaused;
  const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - frameDuration / 2) : Number.MAX_SAFE_INTEGER;
  video.currentTime = Math.max(0, Math.min(maximum, video.currentTime + direction * frameDuration));
  if (wasPaused) {
    video.pause();
    node.classList.add('playback-paused');
  } else {
    node.classList.remove('playback-paused');
    video.play().catch(() => {});
  }
  const frameRate = Math.round((1 / frameDuration) * 100) / 100;
  updateStatus(`${direction < 0 ? '上一帧' : '下一帧'} · ${video.currentTime.toFixed(3)} 秒 · ${frameRate} fps · ${wasPaused ? '暂停' : '播放中'}`);
  return true;
}

function screenToWorld(clientX, clientY) {
  return {
    x: (clientX - state.camera.x) / state.camera.zoom,
    y: (clientY - state.camera.y) / state.camera.zoom
  };
}

function quantizeZoom(value) {
  return Math.min(8, Math.max(.05, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
}

function clampZoom(value) {
  return Math.min(8, Math.max(.01, value));
}

function formatZoomPercent(zoom) {
  return Number((zoom * 100).toFixed(2));
}

function setZoomAround(nextZoom, clientX = innerWidth / 2, clientY = innerHeight / 2) {
  const before = screenToWorld(clientX, clientY);
  state.camera.zoom = clampZoom(nextZoom);
  state.camera.x = clientX - before.x * state.camera.zoom;
  state.camera.y = clientY - before.y * state.camera.zoom;
  updateCamera();
  setDirty();
}

function updateCamera() {
  state.camera.zoom = clampZoom(state.camera.zoom);
  const { x, y, zoom } = state.camera;
  world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
  grid.style.backgroundPosition = `${x % (32 * zoom)}px ${y % (32 * zoom)}px`;
  grid.style.backgroundSize = `${32 * zoom}px ${32 * zoom}px`;
  zoomLabel.textContent = `${formatZoomPercent(zoom)}%`;
  updateSelectionOutline();
}

let zoomEditCancelled = false;
function beginZoomEdit(event) {
  event.preventDefault();
  event.stopPropagation();
  zoomEditCancelled = false;
  zoomLabel.setAttribute('contenteditable', 'plaintext-only');
  zoomLabel.textContent = String(formatZoomPercent(state.camera.zoom));
  zoomLabel.focus();
  const range = document.createRange();
  range.selectNodeContents(zoomLabel);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function finishZoomEdit() {
  if (!zoomLabel.isContentEditable) return;
  const input = zoomLabel.textContent.replace('%', '').trim();
  zoomLabel.removeAttribute('contenteditable');
  if (zoomEditCancelled) {
    updateCamera();
    return;
  }
  const percent = Number(input.replace(',', '.'));
  if (!Number.isFinite(percent)) {
    updateCamera();
    toast('请输入有效的缩放百分比');
    return;
  }
  setZoomAround(percent / 100);
}

zoomLabel.addEventListener('dblclick', beginZoomEdit);
zoomLabel.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.key === 'Enter') { event.preventDefault(); zoomLabel.blur(); }
  if (event.key === 'Escape') { event.preventDefault(); zoomEditCancelled = true; zoomLabel.blur(); }
});
zoomLabel.addEventListener('blur', finishZoomEdit);

function boardSessionSnapshot() {
  return {
    camera: state.camera,
    items: state.items,
    selectedIds: state.selectedIds,
    projectPath: state.projectPath,
    storageId: state.storageId,
    dirty: state.dirty,
    revision: state.revision,
    allPaused: state.allPaused,
    audioMuted: state.audioMuted,
    history: state.history,
    redoHistory: state.redoHistory,
    nextZ: state.nextZ
  };
}

function activeTab() {
  return tabs.find((tab) => tab.id === activeTabId) || null;
}

function tabTitle(tab) {
  if (tab.session.projectPath) return window.boardAPI.basename(tab.session.projectPath).replace(/\.imb$/i, '');
  return tab.untitledName;
}

function sameProjectPath(firstPath, secondPath) {
  if (!firstPath || !secondPath) return false;
  return firstPath.replaceAll('/', '\\').toLowerCase() === secondPath.replaceAll('/', '\\').toLowerCase();
}

function captureActiveTab() {
  const tab = activeTab();
  if (tab) tab.session = boardSessionSnapshot();
}

function renderTabs() {
  tabsNode.replaceChildren();
  tabs.forEach((tab) => {
    const node = document.createElement('div');
    node.className = `board-tab${tab.id === activeTabId ? ' active' : ''}`;
    node.dataset.tabId = tab.id;
    node.draggable = true;
    node.title = tabTitle(tab);

    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.textContent = '◇';
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tabTitle(tab);
    const dirty = document.createElement('span');
    dirty.className = `tab-dirty${tab.session.dirty ? '' : ' clean'}`;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.title = '关闭标签页 (Ctrl+W)';
    close.textContent = '×';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    node.append(icon, label, dirty, close);
    node.addEventListener('click', () => switchTab(tab.id));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) closeTab(tab.id);
    });
    node.addEventListener('dragstart', (event) => {
      node.classList.add('dragging');
      event.dataTransfer.setData('text/x-board-tab', tab.id);
      event.dataTransfer.effectAllowed = 'move';
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    node.addEventListener('dragover', (event) => {
      if (event.dataTransfer.types.includes('text/x-board-tab')) event.preventDefault();
    });
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData('text/x-board-tab');
      const fromIndex = tabs.findIndex((entry) => entry.id === draggedId);
      const toIndex = tabs.findIndex((entry) => entry.id === tab.id);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
      const [moved] = tabs.splice(fromIndex, 1);
      tabs.splice(toIndex, 0, moved);
      renderTabs();
    });
    tabsNode.append(node);
  });
  tabsNode.querySelector('.board-tab.active')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function applyBoardSession(session) {
  hoveredVideo = null;
  muteAllVideos();
  document.querySelectorAll('video').forEach((video) => video.pause());
  world.replaceChildren();
  state.camera = session.camera || { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 };
  state.items = session.items || [];
  state.selectedIds = session.selectedIds || [];
  state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null;
  state.projectPath = session.projectPath || null;
  state.storageId = session.storageId || crypto.randomUUID();
  state.dirty = Boolean(session.dirty);
  state.revision = session.revision || 0;
  state.allPaused = Boolean(session.allPaused);
  state.audioMuted = Boolean(session.audioMuted);
  state.history = session.history || [];
  state.redoHistory = session.redoHistory || [];
  state.nextZ = session.nextZ || 1;
  state.items.forEach(createMediaNode);
  setSelection(state.selectedIds);
  if (!state.history.length) resetHistory();
  updateCamera();
  document.querySelector('#play-all').textContent = '暂停全部';
  updateAudioMuteButton();
  updateStatus();
  document.title = '\u200B';
}

function switchTab(tabId) {
  if (tabId === activeTabId) return;
  const target = tabs.find((tab) => tab.id === tabId);
  if (!target) return;
  captureActiveTab();
  activeTabId = tabId;
  applyBoardSession(target.session);
  renderTabs();
}

function createNewTab() {
  captureActiveTab();
  const tab = {
    id: id(),
    untitledName: `未命名 ${untitledCounter++}`,
    session: {
      camera: { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 },
      items: [], selectedIds: [], projectPath: null, dirty: false,
      storageId: crypto.randomUUID(), revision: 0,
      allPaused: false, audioMuted: false, history: [], redoHistory: [], nextZ: 1
    }
  };
  tabs.push(tab);
  activeTabId = tab.id;
  applyBoardSession(tab.session);
  renderTabs();
}

async function closeTab(tabId) {
  captureActiveTab();
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  const closingTab = tabs[index];
  clearTimeout(autosaveTimers.get(tabId));
  autosaveTimers.delete(tabId);
  if (closingTab.session.projectPath && closingTab.session.dirty) {
    try { await persistTab(closingTab, 'auto'); } catch {}
  }
  await window.boardAPI.cleanupStorage(closingTab.session.storageId).catch(() => {});
  const wasActive = tabId === activeTabId;
  tabs.splice(index, 1);
  if (!tabs.length) {
    activeTabId = null;
    createNewTab();
    return;
  }
  if (wasActive) {
    const next = tabs[Math.min(index, tabs.length - 1)];
    activeTabId = next.id;
    applyBoardSession(next.session);
  }
  renderTabs();
}

function cycleTab(direction) {
  if (tabs.length < 2) return;
  captureActiveTab();
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
  activeTabId = tabs[nextIndex].id;
  applyBoardSession(tabs[nextIndex].session);
  renderTabs();
}

function setDirty(value = true) {
  const wasDirty = state.dirty;
  state.dirty = value;
  if (value) state.revision += 1;
  const tab = activeTab();
  if (tab) {
    tab.session.dirty = value;
    tab.session.revision = state.revision;
  }
  if (!wasDirty || !value) renderTabs();
  document.title = '\u200B';
  if (value && state.projectPath) scheduleAutoSave(activeTabId);
}

function toast(message) {
  clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.classList.add('show');
  toastTimer = setTimeout(() => toastNode.classList.remove('show'), 1800);
}

function updateStatus(message = '就绪') {
  itemCount.textContent = `${state.items.length} 个项目`;
  statusText.textContent = message;
}

function getItem(itemId) {
  return state.items.find((item) => item.id === itemId);
}

function getSelectedItems() {
  const selectedSet = new Set(state.selectedIds);
  return state.items.filter((item) => selectedSet.has(item.id));
}

function selectionBounds(items = getSelectedItems()) {
  if (!items.length) return null;
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function updateSelectionOutline() {
  const bounds = state.selectedIds.length > 1 ? selectionBounds() : null;
  document.body.classList.toggle('multi-select', Boolean(bounds));
  if (!bounds) {
    selectionOutline.style.display = 'none';
    return;
  }
  selectionOutline.style.display = 'block';
  selectionOutline.style.left = `${state.camera.x + bounds.x * state.camera.zoom}px`;
  selectionOutline.style.top = `${state.camera.y + bounds.y * state.camera.zoom}px`;
  selectionOutline.style.width = `${bounds.width * state.camera.zoom}px`;
  selectionOutline.style.height = `${bounds.height * state.camera.zoom}px`;
}

function setSelection(itemIds) {
  const nextIds = [...new Set(itemIds)].filter((itemId) => Boolean(getItem(itemId)));
  const changed = nextIds.join('|') !== state.selectedIds.join('|');
  state.selectedIds = nextIds;
  state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null;
  const selectedSet = new Set(state.selectedIds);
  document.querySelectorAll('.media-item').forEach((node) => {
    node.classList.toggle('selected', selectedSet.has(node.dataset.id));
  });
  updateSelectionOutline();
  return changed;
}

function select(itemId, mode = 'replace') {
  let nextSelection = [...state.selectedIds];
  if (!itemId) nextSelection = [];
  else if (mode === 'toggle') {
    nextSelection = nextSelection.includes(itemId)
      ? nextSelection.filter((id) => id !== itemId)
      : [...nextSelection, itemId];
  } else if (mode === 'add') {
    if (!nextSelection.includes(itemId)) nextSelection.push(itemId);
  } else {
    nextSelection = [itemId];
  }
  return setSelection(nextSelection);
}

function applyItem(node, item) {
  node.style.left = `${item.x}px`;
  node.style.top = `${item.y}px`;
  node.style.width = `${item.width}px`;
  node.style.height = `${item.height}px`;
  node.style.zIndex = item.z;
}

function historySnapshot() {
  return JSON.stringify({
    items: state.items,
    selectedId: state.selectedId,
    selectedIds: state.selectedIds,
    nextZ: state.nextZ
  });
}

function resetHistory() {
  state.history = [historySnapshot()];
  state.redoHistory = [];
}

function commitHistory() {
  const snapshot = historySnapshot();
  if (state.history[state.history.length - 1] === snapshot) return;
  state.history.push(snapshot);
  state.redoHistory = [];
}

function restoreHistorySnapshot(snapshot) {
  hoveredVideo = null;
  const data = JSON.parse(snapshot);
  world.replaceChildren();
  state.items = data.items;
  state.nextZ = data.nextZ;
  state.selectedIds = data.selectedIds || (data.selectedId ? [data.selectedId] : []);
  state.selectedId = state.selectedIds[state.selectedIds.length - 1] || null;
  state.items.forEach(createMediaNode);
  const restoredSelection = [...state.selectedIds];
  select(null);
  restoredSelection.forEach((itemId) => select(itemId, 'add'));
  clearSnapGuides();
  updateStatus('历史记录已恢复');
  setDirty();
}

function undo() {
  if (state.history.length <= 1) {
    toast('没有可撤销的操作');
    return;
  }
  state.redoHistory.push(state.history.pop());
  restoreHistorySnapshot(state.history[state.history.length - 1]);
  toast('已撤销');
}

function redo() {
  const snapshot = state.redoHistory.pop();
  if (!snapshot) {
    toast('没有可重做的操作');
    return;
  }
  state.history.push(snapshot);
  restoreHistorySnapshot(snapshot);
  toast('已重做');
}

function clearSnapGuides() {
  snapGuides.replaceChildren();
}

function showSnapGuides(guides, spacingMeasures = []) {
  clearSnapGuides();
  guides.forEach((guide) => {
    const line = document.createElement('div');
    line.className = `snap-guide ${guide.axis === 'x' ? 'vertical' : 'horizontal'}`;
    if (guide.axis === 'x') {
      line.style.left = `${state.camera.x + guide.value * state.camera.zoom}px`;
    } else {
      line.style.top = `${state.camera.y + guide.value * state.camera.zoom}px`;
    }
    snapGuides.append(line);
  });
  spacingMeasures.forEach((measure) => {
    const node = document.createElement('div');
    node.className = `spacing-measure ${measure.axis === 'x' ? 'horizontal' : 'vertical'}`;
    if (measure.axis === 'x') {
      node.style.left = `${state.camera.x + measure.start * state.camera.zoom}px`;
      node.style.top = `${state.camera.y + measure.cross * state.camera.zoom}px`;
      node.style.width = `${Math.max(1, (measure.end - measure.start) * state.camera.zoom)}px`;
    } else {
      node.style.left = `${state.camera.x + measure.cross * state.camera.zoom}px`;
      node.style.top = `${state.camera.y + measure.start * state.camera.zoom}px`;
      node.style.height = `${Math.max(1, (measure.end - measure.start) * state.camera.zoom)}px`;
    }
    const label = document.createElement('span');
    label.className = 'spacing-label';
    label.textContent = `${Math.round(measure.end - measure.start)}`;
    node.append(label);
    snapGuides.append(node);
  });
}

function getSnapTargets(skipIds) {
  const skipped = new Set(Array.isArray(skipIds) ? skipIds : [skipIds]);
  const x = [];
  const y = [];
  state.items.forEach((item) => {
    if (skipped.has(item.id)) return;
    x.push(item.x, item.x + item.width / 2, item.x + item.width);
    y.push(item.y, item.y + item.height / 2, item.y + item.height);
  });
  return { x, y };
}

function closestSnap(points, targets, threshold) {
  let best = null;
  points.forEach((point) => {
    targets.forEach((target) => {
      const distance = Math.abs(point.value - target);
      if (distance <= threshold && (!best || distance < best.distance)) {
        best = { target, offset: point.offset, distance };
      }
    });
  });
  return best;
}

function rangesOverlap(startA, endA, startB, endB) {
  return Math.min(endA, endB) > Math.max(startA, startB);
}

function bestSpacingCandidate(item, rawX, rawY, axis, threshold, skipIds = [item.id]) {
  const skipped = new Set(skipIds);
  const isX = axis === 'x';
  const size = isX ? item.width : item.height;
  const crossStart = isX ? rawY : rawX;
  const crossEnd = crossStart + (isX ? item.height : item.width);
  const candidates = state.items
    .filter((other) => !skipped.has(other.id))
    .filter((other) => rangesOverlap(
      crossStart,
      crossEnd,
      isX ? other.y : other.x,
      (isX ? other.y + other.height : other.x + other.width)
    ))
    .sort((a, b) => (isX ? a.x - b.x : a.y - b.y));

  if (candidates.length < 2) return null;
  const rawPosition = isX ? rawX : rawY;
  const cross = crossStart + (crossEnd - crossStart) / 2;
  let best = null;

  function bounds(target) {
    const start = isX ? target.x : target.y;
    return { start, end: start + (isX ? target.width : target.height) };
  }

  function isPositionFree(position, first, second) {
    const end = position + size;
    return !candidates.some((target) => {
      if (target === first || target === second) return false;
      const targetBounds = bounds(target);
      return position < targetBounds.end && end > targetBounds.start;
    });
  }

  function consider(position, gap, measures, first, second) {
    const distance = Math.abs(position - rawPosition);
    if (gap < 0 || distance > threshold || !isPositionFree(position, first, second)) return;
    if (!best || distance < best.distance) best = { position, distance, measures };
  }

  for (let index = 0; index < candidates.length - 1; index += 1) {
    const first = candidates[index];
    const second = candidates[index + 1];
    const a = bounds(first);
    const b = bounds(second);
    const existingGap = b.start - a.end;
    if (existingGap < 0) continue;

    const after = b.end + existingGap;
    consider(after, existingGap, [
      { axis, start: a.end, end: b.start, cross },
      { axis, start: b.end, end: after, cross }
    ], first, second);

    const before = a.start - existingGap - size;
    consider(before, existingGap, [
      { axis, start: before + size, end: a.start, cross },
      { axis, start: a.end, end: b.start, cross }
    ], first, second);

    const available = b.start - a.end - size;
    if (available >= 0) {
      const equalGap = available / 2;
      const between = a.end + equalGap;
      consider(between, equalGap, [
        { axis, start: a.end, end: between, cross },
        { axis, start: between + size, end: b.start, cross }
      ], first, second);
    }
  }
  return best;
}

function snapMove(item, rawX, rawY, skipIds = [item.id]) {
  if (!state.snappingEnabled || state.items.length < 2) {
    clearSnapGuides();
    return { x: rawX, y: rawY };
  }
  const targets = getSnapTargets(skipIds);
  const threshold = SNAP_DISTANCE_PX / state.camera.zoom;
  const xSnap = closestSnap([
    { value: rawX, offset: 0 },
    { value: rawX + item.width / 2, offset: item.width / 2 },
    { value: rawX + item.width, offset: item.width }
  ], targets.x, threshold);
  const ySnap = closestSnap([
    { value: rawY, offset: 0 },
    { value: rawY + item.height / 2, offset: item.height / 2 },
    { value: rawY + item.height, offset: item.height }
  ], targets.y, threshold);

  const xSpacing = bestSpacingCandidate(item, rawX, rawY, 'x', threshold, skipIds);
  const ySpacing = bestSpacingCandidate(item, rawX, rawY, 'y', threshold, skipIds);
  const useXSpacing = xSpacing && (!xSnap || xSpacing.distance <= xSnap.distance);
  const useYSpacing = ySpacing && (!ySnap || ySpacing.distance <= ySnap.distance);

  const guides = [];
  const spacingMeasures = [];
  if (useXSpacing) spacingMeasures.push(...xSpacing.measures);
  else if (xSnap) guides.push({ axis: 'x', value: xSnap.target });
  if (useYSpacing) spacingMeasures.push(...ySpacing.measures);
  else if (ySnap) guides.push({ axis: 'y', value: ySnap.target });
  showSnapGuides(guides, spacingMeasures);
  return {
    x: useXSpacing ? xSpacing.position : xSnap ? xSnap.target - xSnap.offset : rawX,
    y: useYSpacing ? ySpacing.position : ySnap ? ySnap.target - ySnap.offset : rawY
  };
}

function rectFromSize(resize, width, height, fromCenter = false) {
  const { direction, originX, originY, width: originWidth, height: originHeight } = resize;
  return {
    x: fromCenter ? originX + (originWidth - width) / 2
      : direction.includes('w') ? originX + originWidth - width
      : direction.includes('e') ? originX
      : originX + (originWidth - width) / 2,
    y: fromCenter ? originY + (originHeight - height) / 2
      : direction.includes('n') ? originY + originHeight - height
      : direction.includes('s') ? originY
      : originY + (originHeight - height) / 2,
    width,
    height
  };
}

function rawResizeRect(resize, point, lockRatio, fromCenter = false) {
  const deltaX = point.x - resize.start.x;
  const deltaY = point.y - resize.start.y;
  let left = resize.originX;
  let top = resize.originY;
  let right = resize.originX + resize.width;
  let bottom = resize.originY + resize.height;

  if (resize.direction.includes('w')) {
    left += deltaX;
    if (fromCenter) right -= deltaX;
  }
  if (resize.direction.includes('e')) {
    right += deltaX;
    if (fromCenter) left -= deltaX;
  }
  if (resize.direction.includes('n')) {
    top += deltaY;
    if (fromCenter) bottom -= deltaY;
  }
  if (resize.direction.includes('s')) {
    bottom += deltaY;
    if (fromCenter) top -= deltaY;
  }

  let width = Math.max(80, right - left);
  let height = Math.max(60, bottom - top);
  if (lockRatio) {
    const widthFromHeight = height * resize.ratio;
    if (Math.abs(width - resize.width) >= Math.abs(widthFromHeight - resize.width)) {
      height = width / resize.ratio;
    } else {
      width = widthFromHeight;
    }
    return rectFromSize(resize, width, height, fromCenter);
  }

  if (fromCenter) return rectFromSize(resize, width, height, true);

  if (resize.direction.includes('w')) left = right - width;
  else right = left + width;
  if (resize.direction.includes('n')) top = bottom - height;
  else bottom = top + height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function snapResize(resize, rawRect, lockRatio, skipIds = [resize.item.id], fromCenter = false) {
  const { item, direction } = resize;
  if (!state.snappingEnabled || state.items.length < 2) {
    clearSnapGuides();
    return rawRect;
  }

  const targets = getSnapTargets(skipIds);
  const threshold = SNAP_DISTANCE_PX / state.camera.zoom;
  const movingX = direction.includes('w') ? rawRect.x
    : direction.includes('e') ? rawRect.x + rawRect.width : null;
  const movingY = direction.includes('n') ? rawRect.y
    : direction.includes('s') ? rawRect.y + rawRect.height : null;
  const xSnap = movingX === null ? null : closestSnap([{ value: movingX, offset: 0 }], targets.x, threshold);
  const ySnap = movingY === null ? null : closestSnap([{ value: movingY, offset: 0 }], targets.y, threshold);

  if (lockRatio) {
    const candidates = [];
    if (xSnap) {
      const centerX = resize.originX + resize.width / 2;
      const oppositeX = direction.includes('w') ? rawRect.x + rawRect.width : rawRect.x;
      const width = fromCenter ? Math.abs(centerX - xSnap.target) * 2 : Math.abs(oppositeX - xSnap.target);
      if (width >= 80) candidates.push({ axis: 'x', value: xSnap.target, distance: xSnap.distance, width, height: width / resize.ratio });
    }
    if (ySnap) {
      const centerY = resize.originY + resize.height / 2;
      const oppositeY = direction.includes('n') ? rawRect.y + rawRect.height : rawRect.y;
      const height = fromCenter ? Math.abs(centerY - ySnap.target) * 2 : Math.abs(oppositeY - ySnap.target);
      const width = height * resize.ratio;
      if (height >= 60 && width >= 80) candidates.push({ axis: 'y', value: ySnap.target, distance: ySnap.distance, width, height });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const chosen = candidates[0];
    if (!chosen) {
      clearSnapGuides();
      return rawRect;
    }
    showSnapGuides([{ axis: chosen.axis, value: chosen.value }]);
    return rectFromSize(resize, chosen.width, chosen.height, fromCenter);
  }

  let left = rawRect.x;
  let top = rawRect.y;
  let right = rawRect.x + rawRect.width;
  let bottom = rawRect.y + rawRect.height;
  const guides = [];
  if (xSnap) {
    if (fromCenter) {
      const centerX = resize.originX + resize.width / 2;
      const width = Math.abs(centerX - xSnap.target) * 2;
      left = centerX - width / 2;
      right = centerX + width / 2;
    } else if (direction.includes('w')) left = xSnap.target;
    else right = xSnap.target;
    if (right - left >= 80) guides.push({ axis: 'x', value: xSnap.target });
    else { left = rawRect.x; right = rawRect.x + rawRect.width; }
  }
  if (ySnap) {
    if (fromCenter) {
      const centerY = resize.originY + resize.height / 2;
      const height = Math.abs(centerY - ySnap.target) * 2;
      top = centerY - height / 2;
      bottom = centerY + height / 2;
    } else if (direction.includes('n')) top = ySnap.target;
    else bottom = ySnap.target;
    if (bottom - top >= 60) guides.push({ axis: 'y', value: ySnap.target });
    else { top = rawRect.y; bottom = rawRect.y + rawRect.height; }
  }
  showSnapGuides(guides);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function beginTextEditing(item, node, textNode, selectAll = false) {
  if (node.classList.contains('editing')) return;
  const originalText = item.text || '';
  node.classList.add('editing');
  textNode.setAttribute('contenteditable', 'plaintext-only');
  textNode.focus({ preventScroll: true });
  if (selectAll) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textNode);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  const finish = () => {
    item.text = textNode.innerText.replace(/\r\n/g, '\n');
    textNode.textContent = item.text;
    textNode.removeAttribute('contenteditable');
    node.classList.remove('editing');
    if (item.text !== originalText) {
      setDirty();
      commitHistory();
    }
  };
  textNode.addEventListener('blur', finish, { once: true });
}

function createMediaNode(item) {
  const node = document.createElement('article');
  node.className = `media-item${item.type === 'text' ? ' text-item' : ''}`;
  node.dataset.id = item.id;
  let media;

  if (item.type === 'text') {
    media = document.createElement('div');
    media.className = 'text-content';
    media.textContent = item.text || '';
    media.style.fontSize = `${item.fontSize || 32}px`;
    media.style.color = item.color || '#f4f5f7';
  } else {
    media = document.createElement(item.type === 'video' ? 'video' : 'img');
    media.src = window.boardAPI.fileURL(item.path);
    media.draggable = false;

    if (item.type === 'video') {
      media.loop = true;
      media.muted = item.muted ?? true;
      media.autoplay = true;
      media.playsInline = true;
      media.preload = 'auto';
      media.addEventListener('canplay', () => {
        if (!state.allPaused && !node._frameStepPauseLock) media.play().catch(() => {});
      });
      trackVideoFrameRate(media);
      media.addEventListener('play', () => node.classList.remove('playback-paused'));
      media.addEventListener('pause', () => node.classList.add('playback-paused'));
    }

    media.addEventListener('error', () => {
      node.classList.add('missing');
      updateStatus(`无法读取：${item.name}`);
    });
  }

  const label = document.createElement('div');
  label.className = 'media-label';
  label.textContent = item.name || '文本';

  const badge = document.createElement('div');
  badge.className = 'type-badge';
  badge.textContent = item.type.toUpperCase();

  if (item.type === 'video') {
    node.addEventListener('pointerenter', () => {
      hoveredVideo = { video: media, node, item };
      document.querySelectorAll('.media-item.audio-active').forEach((activeNode) => {
        activeNode.classList.remove('audio-active');
      });
      document.querySelectorAll('video').forEach((video) => { video.muted = true; });
      node._hoverStartedPlayback = state.allPaused && media.paused && !node._frameStepPauseLock;
      if (node._hoverStartedPlayback) media.play().catch(() => {});
      if (state.audioMuted) return;
      media.muted = false;
      node.classList.add('audio-active');
      badge.textContent = 'VIDEO · 声音';
    });
    node.addEventListener('pointerleave', () => {
      if (hoveredVideo?.video === media) hoveredVideo = null;
      media.muted = true;
      if (state.allPaused) media.pause();
      node._hoverStartedPlayback = false;
      node.classList.remove('audio-active');
      badge.textContent = 'VIDEO';
    });
  }

  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((direction) => {
    const handle = document.createElement('div');
    handle.className = `resize-handle ${direction}`;
    handle.dataset.direction = direction;
    handle.addEventListener('pointerdown', (event) => startResize(event, item, node, direction));
    return handle;
  });

  node.append(media, label, badge, ...handles);
  applyItem(node, item);
  node.addEventListener('pointerdown', (event) => startMove(event, item, node));
  node.addEventListener('dblclick', (event) => {
    if (item.type === 'text') {
      event.stopPropagation();
      beginTextEditing(item, node, media);
    } else if (media instanceof HTMLVideoElement) {
      if (media.paused) {
        node._frameStepPauseLock = false;
        node._hoverStartedPlayback = false;
        media.play().catch(() => {});
      } else {
        node._frameStepPauseLock = true;
        node._hoverStartedPlayback = false;
        media.pause();
      }
    }
  });
  world.append(node);
  return { node, media };
}

function addTextBox(initialText = '输入文本') {
  const anchor = screenToWorld(innerWidth / 2, innerHeight / 2);
  const item = {
    id: id(), type: 'text', text: String(initialText || '输入文本'), name: '文本',
    x: anchor.x - 180, y: anchor.y - 70,
    width: 360, height: 140,
    fontSize: 32, color: '#f4f5f7',
    z: state.nextZ++
  };
  state.items.push(item);
  const { node, media } = createMediaNode(item);
  select(item.id);
  setDirty();
  commitHistory();
  beginTextEditing(item, node, media, true);
  updateStatus('已创建 MiSans 文本框');
}

function naturalSize(path, type) {
  return new Promise((resolve) => {
    const media = document.createElement(type === 'video' ? 'video' : 'img');
    const done = () => {
      const width = type === 'video' ? media.videoWidth : media.naturalWidth;
      const height = type === 'video' ? media.videoHeight : media.naturalHeight;
      const scale = Math.min(1, 520 / Math.max(width || 400, height || 300));
      resolve({ width: Math.max(120, (width || 400) * scale), height: Math.max(80, (height || 300) * scale) });
      media.src = '';
    };
    media.addEventListener(type === 'video' ? 'loadedmetadata' : 'load', done, { once: true });
    media.addEventListener('error', () => resolve({ width: 400, height: 260 }), { once: true });
    media.src = window.boardAPI.fileURL(path);
  });
}

async function addPaths(paths, anchor) {
  const accepted = paths.filter((path) => mediaType(path));
  if (!accepted.length) {
    toast('没有可识别的图片、GIF 或视频');
    return;
  }

  let cached;
  try {
    cached = await window.boardAPI.cacheMedia({ storageId: state.storageId, paths: accepted });
  } catch (error) {
    toast(`复制素材失败：${error.message}`);
    return;
  }

  let offsetX = 0;
  let offsetY = 0;
  for (const cachedMedia of cached) {
    const type = mediaType(cachedMedia.name || cachedMedia.path);
    const size = await naturalSize(cachedMedia.path, type);
    const item = {
      id: id(), type, path: cachedMedia.path, assetId: cachedMedia.assetId, name: cachedMedia.name,
      x: anchor.x + offsetX, y: anchor.y + offsetY,
      width: size.width, height: size.height,
      z: state.nextZ++, muted: true
    };
    state.items.push(item);
    createMediaNode(item);
    select(item.id);
    offsetX += 34;
    offsetY += 34;
  }
  setDirty();
  commitHistory();
  updateStatus(`已添加 ${accepted.length} 个媒体`);
}

function startMove(event, item, node) {
  if (event.button !== 0 || event.target.classList.contains('resize-handle') || node.classList.contains('editing')) return;
  event.stopPropagation();
  const duplicateOnDrag = event.altKey;
  if (duplicateOnDrag) {
    const start = screenToWorld(event.clientX, event.clientY);
    const clickedWasSelected = state.selectedIds.includes(item.id);
    const sourceItems = clickedWasSelected ? getSelectedItems() : [item];
    interaction = {
      type: 'move', item, node, start, changed: false,
      pendingDuplicate: true, clickedWasSelected,
      selectionBefore: [...state.selectedIds],
      sourceItems,
      startClientX: event.clientX, startClientY: event.clientY,
      bounds: selectionBounds(sourceItems), items: sourceItems,
      origins: new Map(sourceItems.map((entry) => [entry.id, { x: entry.x, y: entry.y }]))
    };
    node.setPointerCapture(event.pointerId);
    return;
  }
  const additive = event.shiftKey || event.ctrlKey || event.metaKey;
  let selectionChanged = false;
  if (additive) {
    const wasSelected = state.selectedIds.includes(item.id);
    selectionChanged = select(item.id, 'toggle');
    if (wasSelected) {
      if (selectionChanged) commitHistory();
      return;
    }
  } else if (!state.selectedIds.includes(item.id)) {
    selectionChanged = select(item.id);
  }
  if (selectionChanged) commitHistory();
  const selectedItems = getSelectedItems();
  const bounds = selectionBounds(selectedItems);
  const start = screenToWorld(event.clientX, event.clientY);
  interaction = {
    type: 'move', item, node, start, bounds, changed: false,
    items: selectedItems,
    origins: new Map(selectedItems.map((entry) => [entry.id, { x: entry.x, y: entry.y }]))
  };
  selectedItems.forEach((entry) => document.querySelector(`[data-id="${entry.id}"]`)?.classList.add('dragging'));
  node.setPointerCapture(event.pointerId);
}

function materializeDragCopies(activeInteraction) {
  const clickedIndex = Math.max(0, activeInteraction.sourceItems.findIndex((source) => source.id === activeInteraction.item.id));
  const copies = activeInteraction.sourceItems.map((source) => ({
    ...structuredClone(source), id: id(), z: state.nextZ++
  }));
  copies.forEach((copy) => {
    state.items.push(copy);
    createMediaNode(copy);
  });
  setSelection(copies.map((copy) => copy.id));
  activeInteraction.items = copies;
  activeInteraction.item = copies[clickedIndex] || copies[0];
  activeInteraction.node = document.querySelector(`[data-id="${activeInteraction.item.id}"]`);
  activeInteraction.bounds = selectionBounds(copies);
  activeInteraction.origins = new Map(copies.map((copy) => [copy.id, { x: copy.x, y: copy.y }]));
  activeInteraction.pendingDuplicate = false;
  activeInteraction.duplicated = true;
  copies.forEach((copy) => document.querySelector(`[data-id="${copy.id}"]`)?.classList.add('dragging'));
}

function startResize(event, item, node, direction) {
  event.stopPropagation();
  select(item.id);
  const start = screenToWorld(event.clientX, event.clientY);
  interaction = {
    type: 'resize', item, node, direction, start,
    originX: item.x, originY: item.y,
    width: item.width, height: item.height,
    ratio: item.width / item.height
  };
  node.setPointerCapture(event.pointerId);
}

function startGroupResize(event, direction, handle) {
  if (event.button !== 0 || state.selectedIds.length < 2) return;
  event.stopPropagation();
  const items = getSelectedItems();
  const bounds = selectionBounds(items);
  const start = screenToWorld(event.clientX, event.clientY);
  interaction = {
    type: 'group-resize', direction, start, changed: false,
    item: { id: '__group__', ...bounds },
    originX: bounds.x, originY: bounds.y,
    width: bounds.width, height: bounds.height,
    ratio: bounds.width / bounds.height,
    bounds, items,
    originals: new Map(items.map((item) => [item.id, {
      x: item.x, y: item.y, width: item.width, height: item.height, fontSize: item.fontSize
    }]))
  };
  handle.setPointerCapture(event.pointerId);
}

document.querySelectorAll('.group-resize-handle').forEach((handle) => {
  handle.addEventListener('pointerdown', (event) => startGroupResize(event, handle.dataset.direction, handle));
});

viewport.addEventListener('pointerdown', (event) => {
  if (event.target.closest('#toolbar') || event.target.closest('.group-resize-handle')) return;
  if (event.button === 1 || event.button === 2) {
    interaction = { type: 'pan', startX: event.clientX, startY: event.clientY, cameraX: state.camera.x, cameraY: state.camera.y };
    viewport.classList.add('panning');
    viewport.setPointerCapture(event.pointerId);
    return;
  }
  const blankCanvas = event.target === viewport || event.target === grid || event.target === world;
  if (event.button === 0 && blankCanvas) {
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const selectionBefore = state.selectedIds.join('|');
    const baseSelection = additive ? [...state.selectedIds] : [];
    if (!additive) select(null);
    interaction = {
      type: 'marquee', startX: event.clientX, startY: event.clientY,
      baseSelection, selectionBefore, changed: false
    };
    selectionMarquee.style.display = 'block';
    selectionMarquee.style.left = `${event.clientX}px`;
    selectionMarquee.style.top = `${event.clientY}px`;
    selectionMarquee.style.width = '0px';
    selectionMarquee.style.height = '0px';
    viewport.setPointerCapture(event.pointerId);
  }
});

viewport.addEventListener('pointermove', (event) => {
  if (!interaction) return;
  if (interaction.type === 'pan') {
    state.camera.x = interaction.cameraX + event.clientX - interaction.startX;
    state.camera.y = interaction.cameraY + event.clientY - interaction.startY;
    interaction.changed = true;
    updateCamera();
    return;
  }
  if (interaction.type === 'marquee') {
    const left = Math.min(interaction.startX, event.clientX);
    const top = Math.min(interaction.startY, event.clientY);
    const right = Math.max(interaction.startX, event.clientX);
    const bottom = Math.max(interaction.startY, event.clientY);
    selectionMarquee.style.left = `${left}px`;
    selectionMarquee.style.top = `${top}px`;
    selectionMarquee.style.width = `${right - left}px`;
    selectionMarquee.style.height = `${bottom - top}px`;
    interaction.changed = right - left > 2 || bottom - top > 2;
    const worldStart = screenToWorld(left, top);
    const worldEnd = screenToWorld(right, bottom);
    const boxed = state.items
      .filter((item) =>
        item.x < worldEnd.x && item.x + item.width > worldStart.x &&
        item.y < worldEnd.y && item.y + item.height > worldStart.y
      )
      .map((item) => item.id);
    setSelection([...interaction.baseSelection, ...boxed]);
    return;
  }
  const point = screenToWorld(event.clientX, event.clientY);
  if (interaction.type === 'move') {
    if (interaction.pendingDuplicate) {
      const distance = Math.hypot(event.clientX - interaction.startClientX, event.clientY - interaction.startClientY);
      if (distance < 4) return;
      materializeDragCopies(interaction);
    }
    const deltaX = point.x - interaction.start.x;
    const deltaY = point.y - interaction.start.y;
    const groupItem = { id: '__selection__', width: interaction.bounds.width, height: interaction.bounds.height };
    const snapped = snapMove(
      groupItem,
      interaction.bounds.x + deltaX,
      interaction.bounds.y + deltaY,
      interaction.items.map((entry) => entry.id)
    );
    const appliedDeltaX = snapped.x - interaction.bounds.x;
    const appliedDeltaY = snapped.y - interaction.bounds.y;
    interaction.items.forEach((entry) => {
      const origin = interaction.origins.get(entry.id);
      entry.x = origin.x + appliedDeltaX;
      entry.y = origin.y + appliedDeltaY;
      const entryNode = document.querySelector(`[data-id="${entry.id}"]`);
      if (entryNode) applyItem(entryNode, entry);
    });
    interaction.changed = true;
  } else if (interaction.type === 'resize') {
    const lockRatio = event.shiftKey;
    const fromCenter = event.altKey || (event.shiftKey && event.ctrlKey);
    const rawRect = rawResizeRect(interaction, point, lockRatio, fromCenter);
    const snapped = snapResize(interaction, rawRect, lockRatio, [interaction.item.id], fromCenter);
    interaction.item.x = snapped.x;
    interaction.item.y = snapped.y;
    interaction.item.width = snapped.width;
    interaction.item.height = snapped.height;
    interaction.changed = true;
    applyItem(interaction.node, interaction.item);
  } else if (interaction.type === 'group-resize') {
    const lockRatio = event.shiftKey;
    const fromCenter = event.altKey || (event.shiftKey && event.ctrlKey);
    const rawRect = rawResizeRect(interaction, point, lockRatio, fromCenter);
    const snapped = snapResize(interaction, rawRect, lockRatio, interaction.items.map((entry) => entry.id), fromCenter);
    const scaleX = snapped.width / interaction.bounds.width;
    const scaleY = snapped.height / interaction.bounds.height;
    interaction.items.forEach((entry) => {
      const original = interaction.originals.get(entry.id);
      entry.x = snapped.x + (original.x - interaction.bounds.x) * scaleX;
      entry.y = snapped.y + (original.y - interaction.bounds.y) * scaleY;
      entry.width = Math.max(1, original.width * scaleX);
      entry.height = Math.max(1, original.height * scaleY);
      if (entry.type === 'text' && original.fontSize) entry.fontSize = Math.max(8, original.fontSize * Math.min(scaleX, scaleY));
      const entryNode = document.querySelector(`[data-id="${entry.id}"]`);
      if (entryNode) {
        applyItem(entryNode, entry);
        const textNode = entryNode.querySelector('.text-content');
        if (textNode) textNode.style.fontSize = `${entry.fontSize}px`;
      }
    });
    interaction.changed = true;
  }
  updateSelectionOutline();
});

viewport.addEventListener('pointerup', () => {
  if (!interaction) return;
  if (interaction.type === 'move' && interaction.pendingDuplicate) {
    if (!interaction.clickedWasSelected && select(interaction.item.id)) commitHistory();
    interaction = null;
    clearSnapGuides();
    return;
  }
  if (interaction.type === 'move' || interaction.type === 'resize' || interaction.type === 'group-resize') {
    interaction.items?.forEach((entry) => document.querySelector(`[data-id="${entry.id}"]`)?.classList.remove('dragging'));
    interaction.node?.classList.remove('dragging');
    if (interaction.changed) {
      setDirty();
      commitHistory();
      if (interaction.duplicated) toast(`已复制并移动 ${interaction.items.length} 个素材`);
    }
  }
  if (interaction.type === 'marquee') {
    selectionMarquee.style.display = 'none';
    if (interaction.selectionBefore !== state.selectedIds.join('|')) commitHistory();
  }
  if (interaction.changed && interaction.type !== 'marquee') {
    setDirty();
  }
  interaction = null;
  viewport.classList.remove('panning');
  clearSnapGuides();
});

viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  const steppedZoom = quantizeZoom(state.camera.zoom + (event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP));
  setZoomAround(steppedZoom, event.clientX, event.clientY);
}, { passive: false });

viewport.addEventListener('contextmenu', async (event) => {
  event.preventDefault();
  const mediaNode = event.target.closest('.media-item');
  if (!mediaNode) return;
  if (!state.selectedIds.includes(mediaNode.dataset.id)) {
    if (select(mediaNode.dataset.id)) commitHistory();
  }
  const sources = getSelectedItems();
  const action = await window.boardAPI.showMediaContextMenu({
    selectedCount: sources.length,
    x: event.clientX,
    y: event.clientY
  });
  if (action === 'copy') copySelected();
  if (action === 'save') saveSelectedMedia(sources);
  if (action === 'export-image') exportSelectedAsImage(sources);
});

function deleteSelected() {
  if (!state.selectedIds.length) return;
  const selectedSet = new Set(state.selectedIds);
  if (hoveredVideo?.item && selectedSet.has(hoveredVideo.item.id)) hoveredVideo = null;
  state.selectedIds.forEach((itemId) => document.querySelector(`[data-id="${itemId}"]`)?.remove());
  state.items = state.items.filter((item) => !selectedSet.has(item.id));
  const deletedCount = selectedSet.size;
  select(null);
  setDirty();
  commitHistory();
  updateStatus(`已删除 ${deletedCount} 个素材`);
}

async function copySelected() {
  const sources = getSelectedItems();
  if (!sources.length) {
    toast('请先选择素材');
    return;
  }
  const payload = { items: structuredClone(sources) };
  state.clipboard = { items: payload.items, key: sources.map((item) => item.id).join('|'), pasteCount: 0 };
  await window.boardAPI.writeClipboardItem(payload);
  toast(`已复制 ${sources.length} 个素材，可在其他软件中粘贴`);
}

async function saveSelectedMedia(sources = getSelectedItems()) {
  if (!sources.length) return;
  try {
    const result = await window.boardAPI.exportSelectedMedia({
      items: sources.map((item) => ({ type: item.type, path: item.path, name: item.name, text: item.text }))
    });
    if (!result) return;
    const failedText = result.failed.length ? `，${result.failed.length} 个失败` : '';
    toast(`已保存 ${result.exported.length} 个素材${failedText}`);
  } catch (error) {
    toast(`保存素材失败：${error.message}`);
  }
}

function waitForDrawable(media) {
  if (media instanceof HTMLImageElement && media.complete && media.naturalWidth) return Promise.resolve();
  if (media instanceof HTMLVideoElement && media.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const readyEvent = media instanceof HTMLVideoElement ? 'loadeddata' : 'load';
    const timer = setTimeout(() => finish(new Error('素材加载超时')), 10000);
    const finish = (error) => {
      clearTimeout(timer);
      media.removeEventListener(readyEvent, onReady);
      media.removeEventListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error('素材无法读取'));
    media.addEventListener(readyEvent, onReady, { once: true });
    media.addEventListener('error', onError, { once: true });
  });
}

function drawWrappedText(context, item, originX, originY) {
  const fontSize = item.fontSize || 32;
  const paddingX = 12;
  const paddingY = 10;
  const maxWidth = Math.max(1, item.width - paddingX * 2);
  const lineHeight = fontSize * 1.35;
  context.save();
  context.beginPath();
  context.rect(item.x - originX, item.y - originY, item.width, item.height);
  context.clip();
  context.fillStyle = item.color || '#f4f5f7';
  context.font = `600 ${fontSize}px MiSans, "Microsoft YaHei", sans-serif`;
  context.textBaseline = 'top';
  let y = item.y - originY + paddingY;
  for (const paragraph of String(item.text || '').split('\n')) {
    let line = '';
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        context.fillText(line, item.x - originX + paddingX, y);
        y += lineHeight;
        line = character;
      } else {
        line = candidate;
      }
    }
    context.fillText(line, item.x - originX + paddingX, y);
    y += lineHeight;
  }
  context.restore();
}

async function renderSelectedComposite(sources) {
  const left = Math.floor(Math.min(...sources.map((item) => item.x)));
  const top = Math.floor(Math.min(...sources.map((item) => item.y)));
  const right = Math.ceil(Math.max(...sources.map((item) => item.x + item.width)));
  const bottom = Math.ceil(Math.max(...sources.map((item) => item.y + item.height)));
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  if (width > 20000 || height > 20000 || width * height > 100000000) {
    throw new Error(`合并区域过大（${width} × ${height}），请缩小素材或分批导出`);
  }
  await document.fonts.load('600 32px MiSans').catch(() => {});
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#151619';
  context.fillRect(0, 0, width, height);
  let skipped = 0;
  for (const item of [...sources].sort((first, second) => (first.z || 0) - (second.z || 0))) {
    if (item.type === 'text') {
      drawWrappedText(context, item, left, top);
      continue;
    }
    const node = world.querySelector(`.media-item[data-id="${CSS.escape(item.id)}"]`);
    const media = node?.querySelector('img, video');
    if (!media) { skipped += 1; continue; }
    try {
      await waitForDrawable(media);
      context.fillStyle = '#090a0b';
      context.fillRect(item.x - left, item.y - top, item.width, item.height);
      context.drawImage(media, item.x - left, item.y - top, item.width, item.height);
    } catch { skipped += 1; }
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('无法生成 PNG 图片');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height, skipped };
}

async function exportSelectedAsImage(sources = getSelectedItems()) {
  if (!sources.length) {
    toast('请先选择要合并导出的素材');
    return;
  }
  toast('正在合并导出图片…');
  try {
    const rendered = await renderSelectedComposite(sources);
    const tab = activeTab();
    const safeName = `${tab ? tabTitle(tab) : '选中素材'}-合并.png`.replace(/[\\/:*?"<>|]/g, '_');
    const result = await window.boardAPI.exportCompositeImage({ ...rendered, defaultName: safeName });
    if (!result) return;
    const skippedText = rendered.skipped ? `，跳过 ${rendered.skipped} 个无法读取的素材` : '';
    toast(`已导出 ${rendered.width} × ${rendered.height} PNG${skippedText}`);
  } catch (error) {
    toast(`导出图片失败：${error.message}`);
  }
}

async function pasteClipboard() {
  let content;
  try {
    content = await window.boardAPI.readClipboardMedia();
  } catch (error) {
    toast(`读取剪贴板失败：${error.message}`);
    return;
  }

  if (content.kind === 'paths') {
    const copiedPaths = state.clipboard?.items?.filter((item) => item.path).map((item) => item.path) || [];
    if (copiedPaths.length === content.paths.length && copiedPaths.every((itemPath, index) => itemPath === content.paths[index])) {
      pasteInternalClipboard();
      return;
    }
    await addPaths(content.paths, screenToWorld(innerWidth / 2, innerHeight / 2));
    return;
  }

  if (content.kind === 'text') {
    addTextBox(content.text);
    return;
  }

  if (content.kind !== 'board-item') {
    toast('剪贴板中没有可粘贴的图片、GIF 或视频');
    return;
  }

  const clipboardItems = content.item.items || [content.item];
  const clipboardKey = clipboardItems.map((item) => item.id).join('|');
  if (!state.clipboard || state.clipboard.key !== clipboardKey) {
    const mediaEntries = clipboardItems.map((item, index) => ({ item, index })).filter(({ item }) => item.path);
    let cached = [];
    try {
      if (mediaEntries.length) cached = await window.boardAPI.cacheMedia({
        storageId: state.storageId, paths: mediaEntries.map(({ item }) => item.path)
      });
    } catch (error) {
      toast(`粘贴素材失败：${error.message}`);
      return;
    }
    const cachedByIndex = new Map(mediaEntries.map((entry, index) => [entry.index, cached[index]]));
    const internalItems = clipboardItems.map((item, index) => {
      const cachedMedia = cachedByIndex.get(index);
      return cachedMedia ? { ...structuredClone(item), path: cachedMedia.path, assetId: cachedMedia.assetId } : structuredClone(item);
    });
    state.clipboard = { items: internalItems, key: clipboardKey, pasteCount: 0 };
  }
  pasteInternalClipboard();
}

function pasteInternalClipboard() {
  if (!state.clipboard?.items?.length) return;
  state.clipboard.pasteCount += 1;
  const offset = 28 * state.clipboard.pasteCount;
  const pastedIds = [];
  state.clipboard.items.forEach((source) => {
    const copy = {
      ...structuredClone(source),
      id: id(),
      x: source.x + offset,
      y: source.y + offset,
      z: state.nextZ++
    };
    state.items.push(copy);
    createMediaNode(copy);
    pastedIds.push(copy.id);
  });
  setSelection(pastedIds);
  setDirty();
  commitHistory();
  updateStatus(`已粘贴 ${pastedIds.length} 个素材`);
}

function changeLayer(action) {
  if (!state.selectedIds.length) return;
  const selectedSet = new Set(state.selectedIds);
  let ordered = [...state.items].sort((a, b) => a.z - b.z);
  const beforeOrder = ordered.map((item) => item.id).join('|');
  if (action === 'back') {
    ordered = [...ordered.filter((item) => selectedSet.has(item.id)), ...ordered.filter((item) => !selectedSet.has(item.id))];
  } else if (action === 'front') {
    ordered = [...ordered.filter((item) => !selectedSet.has(item.id)), ...ordered.filter((item) => selectedSet.has(item.id))];
  } else if (action === 'backward') {
    for (let index = 1; index < ordered.length; index += 1) {
      if (selectedSet.has(ordered[index].id) && !selectedSet.has(ordered[index - 1].id)) {
        [ordered[index - 1], ordered[index]] = [ordered[index], ordered[index - 1]];
      }
    }
  } else if (action === 'forward') {
    for (let index = ordered.length - 2; index >= 0; index -= 1) {
      if (selectedSet.has(ordered[index].id) && !selectedSet.has(ordered[index + 1].id)) {
        [ordered[index], ordered[index + 1]] = [ordered[index + 1], ordered[index]];
      }
    }
  }
  if (ordered.map((item) => item.id).join('|') === beforeOrder) return;

  ordered.forEach((entry, index) => {
    entry.z = index + 1;
    const node = document.querySelector(`[data-id="${entry.id}"]`);
    if (node) node.style.zIndex = entry.z;
  });
  state.nextZ = ordered.length + 1;
  setDirty();
  commitHistory();
  const messages = {
    backward: '已向后一层', forward: '已向前一层',
    back: '已移到底层', front: '已移到顶层'
  };
  toast(messages[action]);
}

function fitItems(targetItems) {
  if (!targetItems.length) {
    state.camera = { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 };
    updateCamera();
    return;
  }
  const left = Math.min(...targetItems.map((i) => i.x));
  const top = Math.min(...targetItems.map((i) => i.y));
  const right = Math.max(...targetItems.map((i) => i.x + i.width));
  const bottom = Math.max(...targetItems.map((i) => i.y + i.height));
  const padding = 110;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const zoom = quantizeZoom(Math.min(2, Math.max(.05, Math.min((innerWidth - padding * 2) / width, (innerHeight - padding * 2) / height))));
  state.camera.zoom = zoom;
  state.camera.x = innerWidth / 2 - (left + width / 2) * zoom;
  state.camera.y = innerHeight / 2 - (top + height / 2) * zoom;
  updateCamera();
}

function fitAll() {
  fitItems(state.items);
}

function layoutCompact(items, left, top, gap = 24) {
  const ordered = [...items].sort((a, b) => a.z - b.z);
  const totalArea = ordered.reduce((sum, item) => sum + (item.width + gap) * (item.height + gap), 0);
  const viewportRatio = Math.max(1, innerWidth / Math.max(1, innerHeight));
  const widestItem = Math.max(...ordered.map((item) => item.width));
  const targetRowWidth = Math.max(widestItem, Math.sqrt(totalArea * viewportRatio) + gap);

  const placed = [];
  const layoutRight = left + targetRowWidth;
  ordered.forEach((item) => {
    const xCandidates = [...new Set([
      left,
      ...placed.flatMap((rect) => [rect.x, rect.x + rect.width + gap])
    ])]
      .filter((x) => x + item.width <= layoutRight + 0.001)
      .sort((a, b) => a - b);
    if (!xCandidates.length) xCandidates.push(left);

    let bestPosition = null;
    xCandidates.forEach((x) => {
      let y = top;
      let searching = true;
      while (searching) {
        const collisions = placed.filter((rect) =>
          x < rect.x + rect.width + gap &&
          x + item.width + gap > rect.x &&
          y < rect.y + rect.height + gap &&
          y + item.height + gap > rect.y
        );
        if (!collisions.length) searching = false;
        else y = Math.max(...collisions.map((rect) => rect.y + rect.height + gap));
      }
      if (!bestPosition || y < bestPosition.y || (y === bestPosition.y && x < bestPosition.x)) {
        bestPosition = { x, y };
      }
    });

    item.x = bestPosition.x;
    item.y = bestPosition.y;
    placed.push({ x: item.x, y: item.y, width: item.width, height: item.height });
    const node = document.querySelector(`[data-id="${item.id}"]`);
    if (node) applyItem(node, item);
  });

  const right = Math.max(...placed.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...placed.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top, items: ordered };
}

function arrangeAll() {
  const selectedItems = getSelectedItems();
  const selectedMedia = selectedItems.filter((item) => item.type !== 'text');
  const allMedia = state.items.filter((item) => item.type !== 'text');
  const targets = selectedItems.length >= 2 ? selectedMedia : allMedia;
  if (targets.length < 2) {
    toast('至少需要两个素材才能排版');
    return;
  }

  const ordered = [...targets].sort((a, b) => a.z - b.z);
  const gap = 24;
  const left = Math.min(...ordered.map((item) => item.x));
  const top = Math.min(...ordered.map((item) => item.y));
  layoutCompact(ordered, left, top, gap);

  setDirty();
  commitHistory();
  fitItems(ordered);
  updateSelectionOutline();
  updateStatus(`已排版 ${ordered.length} 个${selectedItems.length >= 2 ? '选中' : ''}素材`);
  toast(`已按 ${gap}px 间距完成排版`);
}

function arrangeByType() {
  const selectedItems = getSelectedItems();
  const selectedMedia = selectedItems.filter((item) => item.type !== 'text');
  const allMedia = state.items.filter((item) => item.type !== 'text');
  const targets = selectedItems.length >= 2 ? selectedMedia : allMedia;
  if (targets.length < 2) {
    toast('至少需要两个素材才能分类排版');
    return;
  }

  const typeOrder = ['image', 'gif', 'video'];
  const groups = new Map();
  targets.forEach((item) => {
    const type = typeOrder.includes(item.type) ? item.type : 'other';
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(item);
  });

  const orderedTypes = [...typeOrder, 'other'].filter((type) => groups.has(type));
  const left = Math.min(...targets.map((item) => item.x));
  const top = Math.min(...targets.map((item) => item.y));
  const categoryGap = 96;
  let cursorX = left;
  orderedTypes.forEach((type) => {
    const bounds = layoutCompact(groups.get(type), cursorX, top, 24);
    cursorX += bounds.width + categoryGap;
  });

  setDirty();
  commitHistory();
  fitItems(targets);
  updateSelectionOutline();
  const labels = { image: '图片', gif: 'GIF', video: '视频', text: '文本', other: '其他' };
  const summary = orderedTypes.map((type) => `${labels[type]} ${groups.get(type).length}`).join(' · ');
  updateStatus(`已分类排版 ${targets.length} 个${selectedItems.length >= 2 ? '选中' : ''}素材`);
  toast(`分类排版完成：${summary}`);
}

function serializeBoardSession(session) {
  return JSON.stringify({
    format: 'infinite-media-board', version: 1,
    camera: session.camera,
    items: session.items,
    audioMuted: session.audioMuted,
    allPaused: session.allPaused
  }, null, 2);
}

async function performPersist(tab, mode, targetPath) {
  if (tab.id === activeTabId) captureActiveTab();
  const savedRevision = tab.session.revision || 0;
  const result = await window.boardAPI.save({
    path: targetPath,
    content: serializeBoardSession(tab.session),
    storageId: tab.session.storageId,
    mode
  });
  if (!result) return null;
  tab.session.projectPath = result.path;
  if ((tab.session.revision || 0) === savedRevision) tab.session.dirty = false;
  if (tab.id === activeTabId) {
    state.projectPath = tab.session.projectPath;
    state.dirty = tab.session.dirty;
  }
  renderTabs();
  return result;
}

function persistTab(tab, mode, targetPath = tab.session.projectPath) {
  const previous = saveQueues.get(tab.id) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => performPersist(tab, mode, targetPath));
  saveQueues.set(tab.id, operation);
  operation.finally(() => {
    if (saveQueues.get(tab.id) === operation) saveQueues.delete(tab.id);
  });
  return operation;
}

function scheduleAutoSave(tabId) {
  clearTimeout(autosaveTimers.get(tabId));
  autosaveTimers.set(tabId, setTimeout(async () => {
    autosaveTimers.delete(tabId);
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab || !tab.session.projectPath || !tab.session.dirty) return;
    try {
      await persistTab(tab, 'auto');
      if (tab.session.dirty) scheduleAutoSave(tabId);
    } catch (error) {
      toast(`自动保存失败：${error.message}`);
    }
  }, 1200));
}

async function saveBoard(saveAs = false) {
  captureActiveTab();
  const tab = activeTab();
  const result = await persistTab(tab, 'manual', saveAs ? null : tab.session.projectPath);
  if (!result) return false;
  toast('画板已保存');
  return true;
}

async function shareBoard(mode) {
  if (!state.items.length) {
    toast('当前画板没有可分享的素材');
    return;
  }
  captureActiveTab();
  const button = document.querySelector('#share');
  button.disabled = true;
  button.textContent = '导出中…';
  try {
    const tab = activeTab();
    const result = await window.boardAPI.exportShare({
      mode,
      title: tab ? tabTitle(tab) : '共享画板',
      items: state.items,
      camera: state.camera,
      audioMuted: state.audioMuted,
      allPaused: state.allPaused
    });
    if (!result) return;
    const missingText = result.missingCount ? `，跳过 ${result.missingCount} 个丢失素材` : '';
    toast(`${result.mode === 'editable' ? '可编辑' : '只读'}分享包已导出：${result.itemCount} 个素材${missingText}`);
  } catch (error) {
    toast(`分享失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = '分享';
  }
}

async function loadBoardResult(result) {
  if (!result) return;
  try {
    const data = JSON.parse(result.content);
    if (data.format !== 'infinite-media-board' || !Array.isArray(data.items)) throw new Error('格式错误');
    captureActiveTab();
    const existingTab = tabs.find((tab) => sameProjectPath(tab.session.projectPath, result.path));
    if (existingTab) {
      if (result.storageId) await window.boardAPI.cleanupStorage(result.storageId).catch(() => {});
      switchTab(existingTab.id);
      renderTabs();
      updateStatus(`已切换到 ${window.boardAPI.basename(result.path)}`);
      toast('该画板已经打开');
      return;
    }

    const session = {
      items: data.items,
      camera: data.camera || { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 },
      selectedIds: [], projectPath: result.path, dirty: false,
      storageId: result.storageId || crypto.randomUUID(), revision: 0,
      allPaused: Boolean(data.allPaused), audioMuted: Boolean(data.audioMuted),
      history: [], redoHistory: [],
      nextZ: Math.max(1, ...data.items.map((item) => item.z || 1)) + 1
    };

    const currentTab = activeTab();
    const replaceInitialBlank = tabs.length === 1 && currentTab &&
      !currentTab.session.projectPath && !currentTab.session.dirty && currentTab.session.items.length === 0;
    const tab = replaceInitialBlank ? currentTab : {
      id: id(),
      untitledName: `未命名 ${untitledCounter++}`,
      session
    };
    if (replaceInitialBlank) tab.session = session;
    else tabs.push(tab);
    activeTabId = tab.id;
    applyBoardSession(tab.session);
    resetHistory();
    captureActiveTab();
    renderTabs();
    if (result.needsMigration) setDirty();
    updateStatus(`已打开 ${window.boardAPI.basename(result.path)}`);
  } catch (error) {
    toast(`打开失败：${error.message}`);
  }
}

async function openBoard() {
  await loadBoardResult(await window.boardAPI.open());
}

function pauseAllPlayback() {
  state.allPaused = true;
  document.querySelectorAll('video').forEach((video) => {
    video.pause();
  });
  setDirty();
  toast('已暂停所有视频');
}

function resumeAllPlayback() {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) {
    toast('画板中没有视频');
    return;
  }
  state.allPaused = false;
  videos.forEach((video) => {
    const node = video.closest('.media-item');
    node._frameStepPauseLock = false;
    node._hoverStartedPlayback = false;
    video.play().catch(() => {});
  });
  setDirty();
  toast(`已从当前位置继续播放 ${videos.length} 个视频`);
}

function muteAllVideos() {
  document.querySelectorAll('video').forEach((video) => { video.muted = true; });
  document.querySelectorAll('.media-item.audio-active').forEach((node) => {
    node.classList.remove('audio-active');
    const badge = node.querySelector('.type-badge');
    if (badge) badge.textContent = 'VIDEO';
  });
}

function updateAudioMuteButton() {
  const button = document.querySelector('#mute');
  button.classList.toggle('active', state.audioMuted);
  button.setAttribute('aria-pressed', String(state.audioMuted));
}

function toggleAudioMute() {
  state.audioMuted = !state.audioMuted;
  if (state.audioMuted) muteAllVideos();
  updateAudioMuteButton();
  setDirty();
  toast(state.audioMuted ? '已强制静音' : '已恢复悬停声音');
}

function restartAllPlayback() {
  const videos = [...document.querySelectorAll('video')];
  if (!videos.length) {
    toast('画板中没有视频');
    return;
  }
  state.allPaused = false;
  videos.forEach((video) => {
    const node = video.closest('.media-item');
    node._frameStepPauseLock = false;
    node._hoverStartedPlayback = false;
    video.currentTime = 0;
    video.play().catch(() => {});
  });
  document.querySelector('#play-all').textContent = '暂停全部';
  toast(`已从头播放 ${videos.length} 个视频`);
}

async function pickMedia() {
  const paths = await window.boardAPI.pickMedia();
  if (paths.length) addPaths(paths, screenToWorld(innerWidth / 2, innerHeight / 2));
}

document.querySelector('#save').addEventListener('click', () => saveBoard());
const shareButton = document.querySelector('#share');
const shareMenu = document.querySelector('#share-menu');
shareButton.addEventListener('click', (event) => {
  event.stopPropagation();
  const opening = shareMenu.hidden;
  shareMenu.hidden = !opening;
  shareButton.setAttribute('aria-expanded', String(opening));
});
shareMenu.addEventListener('click', (event) => {
  const option = event.target.closest('[data-share-mode]');
  if (!option) return;
  shareMenu.hidden = true;
  shareButton.setAttribute('aria-expanded', 'false');
  shareBoard(option.dataset.shareMode);
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.share-control')) {
    shareMenu.hidden = true;
    shareButton.setAttribute('aria-expanded', 'false');
  }
});
document.querySelector('#text').addEventListener('click', () => addTextBox());
document.querySelector('#open').addEventListener('click', openBoard);
newTabButton.addEventListener('click', createNewTab);
document.querySelector('#fit').addEventListener('click', fitAll);
document.querySelector('#arrange-all').addEventListener('click', arrangeAll);
document.querySelector('#arrange-by-type').addEventListener('click', arrangeByType);
document.querySelector('#restart-all').addEventListener('click', restartAllPlayback);
document.querySelector('#play-all').addEventListener('click', pauseAllPlayback);
document.querySelector('#resume-all').addEventListener('click', resumeAllPlayback);
document.querySelector('#mute').addEventListener('click', toggleAudioMute);
const pinButton = document.querySelector('#pin');
pinButton.addEventListener('click', async () => {
  const pinned = await window.boardAPI.toggleAlwaysOnTop();
  pinButton.classList.toggle('active', pinned);
  pinButton.setAttribute('aria-pressed', String(pinned));
  toast(pinned ? '窗口已置顶' : '已取消置顶');
});

window.boardAPI.isAlwaysOnTop().then((pinned) => {
  pinButton.classList.toggle('active', pinned);
  pinButton.setAttribute('aria-pressed', String(pinned));
}).catch(() => {});

window.boardAPI.onOpenBoardPath((result) => {
  loadBoardResult(result);
});

let trayHideInProgress = false;

async function createTraySessionSnapshot() {
  captureActiveTab();
  for (const tab of tabs) {
    clearTimeout(autosaveTimers.get(tab.id));
    autosaveTimers.delete(tab.id);
    if (tab.session.projectPath && tab.session.dirty) await persistTab(tab, 'auto');
  }
  return JSON.stringify({
    format: 'infinite-media-board-tray-full',
    tabs,
    activeTabId,
    untitledCounter,
    clipboard: state.clipboard
  });
}

async function flushSavedTabs() {
  captureActiveTab();
  for (const tab of tabs) {
    clearTimeout(autosaveTimers.get(tab.id));
    autosaveTimers.delete(tab.id);
    if (tab.session.projectPath && tab.session.dirty) await persistTab(tab, 'auto');
  }
}

async function restoreTraySession(content) {
  const restored = JSON.parse(content);
  if (restored.format === 'infinite-media-board-tray-paths') {
    for (const projectPath of restored.projectPaths || []) {
      try { await loadBoardResult(await window.boardAPI.openPath(projectPath)); }
      catch (error) { toast(`恢复失败：${error.message}`); }
    }
    const targetTab = tabs.find((tab) => sameProjectPath(tab.session.projectPath, restored.activeProjectPath));
    if (targetTab) switchTab(targetTab.id);
    updateStatus(restored.projectPaths?.length ? '已恢复保存过的画板' : '未保存画板已清理');
    return;
  }
  if (Array.isArray(restored.tabs) && restored.tabs.length) {
    tabs.splice(0, tabs.length, ...restored.tabs);
    activeTabId = tabs.some((tab) => tab.id === restored.activeTabId) ? restored.activeTabId : tabs[0].id;
    untitledCounter = restored.untitledCounter || tabs.length + 1;
    state.clipboard = restored.clipboard || null;
    applyBoardSession(activeTab().session);
    renderTabs();
  } else {
    state.camera = restored.camera || state.camera;
    state.items = restored.items || [];
    state.selectedIds = restored.selectedIds || [];
    state.projectPath = restored.projectPath || null;
    state.dirty = Boolean(restored.dirty);
    state.allPaused = Boolean(restored.allPaused);
    state.audioMuted = Boolean(restored.audioMuted);
    state.clipboard = restored.clipboard || null;
    state.nextZ = restored.nextZ || 1;
    state.history = restored.history || [];
    state.redoHistory = restored.redoHistory || [];
    captureActiveTab();
    applyBoardSession(activeTab().session);
  }
  updateStatus('已从托盘恢复画板');
}

window.boardAPI.onPrepareHideToTray(async () => {
  if (trayHideInProgress) return;
  trayHideInProgress = true;
  try {
    muteAllVideos();
    document.querySelectorAll('video').forEach((video) => video.pause());
    await window.boardAPI.hideToTray(await createTraySessionSnapshot());
  } catch (error) {
    trayHideInProgress = false;
    toast(`无法缩到托盘：${error.message}`);
  }
});

window.boardAPI.onPrepareExit(async () => {
  try {
    muteAllVideos();
    document.querySelectorAll('video').forEach((video) => video.pause());
    await flushSavedTabs();
    await window.boardAPI.cleanupAllStorage();
    await window.boardAPI.completeExit();
  } catch (error) {
    await window.boardAPI.cancelExit().catch(() => {});
    toast(`退出前自动保存失败：${error.message}`);
  }
});

window.boardAPI.onRestoreTraySession(async (content) => {
  try {
    await restoreTraySession(content);
  } catch (error) {
    toast(`恢复画板失败：${error.message}`);
  }
});

window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  document.body.classList.add('drag-over');
});

window.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth -= 1;
  if (dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag-over');
  }
});

window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-over');
  const paths = [...event.dataTransfer.files].map((file) => window.boardAPI.filePath(file)).filter(Boolean);
  const boardPaths = paths.filter((filePath) => /\.imb$/i.test(filePath));
  const mediaPaths = paths.filter((filePath) => !/\.imb$/i.test(filePath));
  for (const boardPath of boardPaths) {
    try {
      await loadBoardResult(await window.boardAPI.openPath(boardPath));
    } catch (error) {
      toast(`打开失败：${error.message}`);
    }
  }
  if (mediaPaths.length) addPaths(mediaPaths, screenToWorld(event.clientX, event.clientY));
});

window.addEventListener('keydown', (event) => {
  if (event.target.closest?.('.text-content[contenteditable="plaintext-only"]')) {
    if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) {
      event.preventDefault();
      event.target.blur();
    }
    return;
  }
  if (!event.target.isContentEditable && !event.ctrlKey && !event.metaKey && !event.altKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && stepHoveredVideo(event.key === 'ArrowLeft' ? -1 : 1)) {
    event.preventDefault();
    return;
  }
  const ctrl = event.ctrlKey || event.metaKey;
  const bracketLeft = event.code === 'BracketLeft' || event.key === '[' || event.key === '{';
  const bracketRight = event.code === 'BracketRight' || event.key === ']' || event.key === '}';
  if (ctrl && event.key === 'Tab') { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); }
  else if (ctrl && !event.altKey && event.key.toLowerCase() === 't') { event.preventDefault(); createNewTab(); }
  else if (ctrl && event.key.toLowerCase() === 'w') { event.preventDefault(); closeTab(activeTabId); }
  else if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); saveBoard(event.shiftKey); }
  else if (ctrl && event.key.toLowerCase() === 'o') { event.preventDefault(); openBoard(); }
  else if (ctrl && event.key.toLowerCase() === 'i') { event.preventDefault(); pickMedia(); }
  else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'e') { event.preventDefault(); exportSelectedAsImage(); }
  else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); redo(); }
  else if (ctrl && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
  else if (ctrl && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelected(); }
  else if (ctrl && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteClipboard(); }
  else if (ctrl && event.altKey && event.key.toLowerCase() === 't') { event.preventDefault(); arrangeAll(); }
  else if (ctrl && event.altKey && event.key.toLowerCase() === 'g') { event.preventDefault(); arrangeByType(); }
  else if (ctrl && event.shiftKey && bracketLeft) { event.preventDefault(); changeLayer('back'); }
  else if (ctrl && event.shiftKey && bracketRight) { event.preventDefault(); changeLayer('front'); }
  else if (ctrl && bracketLeft) { event.preventDefault(); changeLayer('backward'); }
  else if (ctrl && bracketRight) { event.preventDefault(); changeLayer('forward'); }
  else if (event.key === 'Delete' || event.key === 'Backspace') deleteSelected();
  else if (event.key.toLowerCase() === 'f') fitAll();
  else if (event.key === 'Escape') {
    if (select(null)) commitHistory();
  }
});

window.addEventListener('resize', updateCamera);
window.addEventListener('blur', muteAllVideos);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) muteAllVideos();
});
updateCamera();
updateStatus();
setDirty(false);
resetHistory();
tabs.push({ id: id(), untitledName: `未命名 ${untitledCounter++}`, session: boardSessionSnapshot() });
activeTabId = tabs[0].id;
renderTabs();
