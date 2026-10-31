const board = window.SHARED_BOARD || { title: '共享画板', items: [] };
const viewport = document.querySelector('#viewport');
const world = document.querySelector('#world');
const grid = document.querySelector('#grid');
const zoomLabel = document.querySelector('#zoom');
const playButton = document.querySelector('#play');
const resumeButton = document.querySelector('#resume');
const muteButton = document.querySelector('#mute');
const ZOOM_STEP = 0.05;
const camera = { x: innerWidth / 2, y: innerHeight / 2, zoom: 1 };
const pointers = new Map();
let gesture = null;
let paused = false;
let forcedMute = Boolean(board.audioMuted);
let suppressClickUntil = 0;
let lastMediaTap = null;
let manualDoubleTapUntil = 0;
let hoveredVideo = null;

document.title = `${board.title} · 共享画板`;
document.querySelector('#title').textContent = board.title;

function quantizeZoom(value) {
  return Math.max(.05, Math.min(8, Math.round(value / ZOOM_STEP) * ZOOM_STEP));
}

function clampZoom(value) {
  return Math.max(.01, Math.min(8, value));
}

function formatZoomPercent(zoom) {
  return Number((zoom * 100).toFixed(2));
}

function setZoomAround(nextZoom, clientX = innerWidth / 2, clientY = innerHeight / 2) {
  const worldX = (clientX - camera.x) / camera.zoom;
  const worldY = (clientY - camera.y) / camera.zoom;
  camera.zoom = clampZoom(nextZoom);
  camera.x = clientX - worldX * camera.zoom;
  camera.y = clientY - worldY * camera.zoom;
  updateCamera();
}

function updateCamera() {
  camera.zoom = clampZoom(camera.zoom);
  world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
  grid.style.backgroundPosition = `${camera.x % (32 * camera.zoom)}px ${camera.y % (32 * camera.zoom)}px`;
  grid.style.backgroundSize = `${32 * camera.zoom}px ${32 * camera.zoom}px`;
  zoomLabel.textContent = `${formatZoomPercent(camera.zoom)}%`;
}

let zoomEditCancelled = false;
zoomLabel.addEventListener('dblclick', (event) => {
  event.preventDefault(); event.stopPropagation(); zoomEditCancelled = false;
  zoomLabel.setAttribute('contenteditable', 'plaintext-only');
  zoomLabel.textContent = String(formatZoomPercent(camera.zoom));
  zoomLabel.focus();
  const range = document.createRange(); range.selectNodeContents(zoomLabel);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
});
zoomLabel.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.key === 'Enter') { event.preventDefault(); zoomLabel.blur(); }
  if (event.key === 'Escape') { event.preventDefault(); zoomEditCancelled = true; zoomLabel.blur(); }
});
zoomLabel.addEventListener('blur', () => {
  if (!zoomLabel.isContentEditable) return;
  const percent = Number(zoomLabel.textContent.replace('%', '').trim().replace(',', '.'));
  zoomLabel.removeAttribute('contenteditable');
  if (!zoomEditCancelled && Number.isFinite(percent)) setZoomAround(percent / 100);
  else updateCamera();
});

function videos() {
  return [...world.querySelectorAll('video')];
}

function muteVideo(video, node = video.closest('.media-item')) {
  video.muted = true;
  node?.classList.remove('audio-active');
}

function activateAudio(video, node) {
  if (forcedMute) {
    videos().forEach((entry) => muteVideo(entry));
    video.play().catch(() => {});
    return;
  }
  const shouldEnable = video.muted || !node.classList.contains('audio-active');
  videos().forEach((entry) => muteVideo(entry));
  if (shouldEnable) {
    video.muted = false;
    node.classList.add('audio-active');
    video.play().catch(() => {});
  }
}

function setVideoPlayback(video, node, shouldPause) {
  node.classList.toggle('playback-paused', shouldPause);
  const badge = node.querySelector('.type-badge');
  if (badge) badge.textContent = shouldPause ? 'PAUSED' : 'VIDEO';
  if (shouldPause) video.pause();
  else video.play().catch(() => {});
}

function toggleVideoPlayback(video, node) {
  const shouldPause = !video.paused;
  node._frameStepPauseLock = shouldPause;
  node._hoverStartedPlayback = false;
  setVideoPlayback(video, node, shouldPause);
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
  if (!hoveredVideo?.video) return false;
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
  return true;
}

for (const item of board.items || []) {
  const node = document.createElement('div');
  node.className = `media-item${item.type === 'text' ? ' text-item' : ''}`;
  node.dataset.type = item.type;
  Object.assign(node.style, {
    left: `${item.x}px`, top: `${item.y}px`, width: `${item.width}px`, height: `${item.height}px`, zIndex: item.z || 1
  });
  let media;
  if (item.type === 'text') {
    media = document.createElement('div');
    media.className = 'shared-text';
    media.textContent = item.text || '';
    media.style.fontSize = `${item.fontSize || 32}px`;
    media.style.color = item.color || '#f4f5f7';
  } else {
    media = document.createElement(item.type === 'video' ? 'video' : 'img');
    media.src = item.path;
    media.draggable = false;
  }
  if (item.type === 'video') {
    media.loop = true;
    media.muted = true;
    media.autoplay = true;
    media.playsInline = true;
    media.preload = 'metadata';
    trackVideoFrameRate(media);
    media.addEventListener('canplay', () => { if (!paused && !node._frameStepPauseLock) media.play().catch(() => {}); });
    node.addEventListener('mouseenter', (event) => {
      if (event.pointerType === 'touch') return;
      hoveredVideo = { video: media, node };
      videos().forEach((entry) => muteVideo(entry));
      node._hoverStartedPlayback = paused && media.paused && !node._frameStepPauseLock;
      if (node._hoverStartedPlayback) media.play().catch(() => {});
      if (!forcedMute) {
        media.muted = false;
        node.classList.add('audio-active');
      }
    });
    node.addEventListener('mouseleave', (event) => {
      if (event.pointerType === 'touch') return;
      if (hoveredVideo?.video === media) hoveredVideo = null;
      muteVideo(media, node);
      if (paused) media.pause();
      node._hoverStartedPlayback = false;
    });
    node.addEventListener('dblclick', () => {
      if (Date.now() < suppressClickUntil || Date.now() < manualDoubleTapUntil) return;
      toggleVideoPlayback(media, node);
    });
  }
  const badge = document.createElement('span');
  badge.className = 'type-badge';
  badge.textContent = item.type === 'video' ? 'VIDEO' : item.type === 'gif' ? 'GIF' : item.type === 'text' ? 'TEXT' : 'IMAGE';
  node.append(media, badge);
  world.append(node);
}

function fitAll() {
  const items = board.items || [];
  if (!items.length) {
    camera.x = innerWidth / 2;
    camera.y = innerHeight / 2;
    camera.zoom = 1;
    updateCamera();
    return;
  }
  const left = Math.min(...items.map((item) => item.x));
  const top = Math.min(...items.map((item) => item.y));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const bottom = Math.max(...items.map((item) => item.y + item.height));
  const padding = innerWidth <= 700 ? 36 : 100;
  camera.zoom = quantizeZoom(Math.max(.05, Math.min(4,
    (innerWidth - padding * 2) / Math.max(1, right - left),
    (innerHeight - padding * 2) / Math.max(1, bottom - top)
  )));
  camera.x = innerWidth / 2 - ((left + right) / 2) * camera.zoom;
  camera.y = innerHeight / 2 - ((top + bottom) / 2) * camera.zoom;
  updateCamera();
}

function pointerDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointerMidpoint(first, second) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function beginSingleGesture(pointer) {
  gesture = {
    type: 'pan', pointerId: pointer.id,
    startX: pointer.x, startY: pointer.y,
    cameraX: camera.x, cameraY: camera.y
  };
}

function beginPinchGesture() {
  const [first, second] = [...pointers.values()].slice(0, 2);
  const midpoint = pointerMidpoint(first, second);
  gesture = {
    type: 'pinch',
    distance: Math.max(1, pointerDistance(first, second)),
    zoom: camera.zoom,
    worldX: (midpoint.x - camera.x) / camera.zoom,
    worldY: (midpoint.y - camera.y) / camera.zoom
  };
}

viewport.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const pointer = {
    id: event.pointerId, x: event.clientX, y: event.clientY,
    startX: event.clientX, startY: event.clientY,
    pointerType: event.pointerType,
    mediaNode: event.target.closest('.media-item')
  };
  pointers.set(event.pointerId, pointer);
  viewport.setPointerCapture(event.pointerId);
  viewport.classList.add('panning');
  if (pointers.size === 1) beginSingleGesture(pointer);
  else beginPinchGesture();
});

viewport.addEventListener('pointermove', (event) => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  if (pointers.size >= 2) {
    if (gesture?.type !== 'pinch') beginPinchGesture();
    const [first, second] = [...pointers.values()].slice(0, 2);
    const midpoint = pointerMidpoint(first, second);
    const nextZoom = quantizeZoom(gesture.zoom * pointerDistance(first, second) / gesture.distance);
    camera.zoom = nextZoom;
    camera.x = midpoint.x - gesture.worldX * nextZoom;
    camera.y = midpoint.y - gesture.worldY * nextZoom;
    updateCamera();
    return;
  }
  if (gesture?.type === 'pan') {
    camera.x = gesture.cameraX + pointer.x - gesture.startX;
    camera.y = gesture.cameraY + pointer.y - gesture.startY;
    updateCamera();
  }
});

function endPointer(event) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer) return;
  const wasSingle = pointers.size === 1;
  const movement = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY);
  pointers.delete(event.pointerId);
  if (wasSingle && movement < 8 && pointer.mediaNode?.dataset.type === 'video') {
    const video = pointer.mediaNode.querySelector('video');
    const now = Date.now();
    const isDoubleTap = lastMediaTap?.node === pointer.mediaNode &&
      lastMediaTap.pointerType === pointer.pointerType && now - lastMediaTap.time < 340;
    if (isDoubleTap) {
      manualDoubleTapUntil = now + 450;
      toggleVideoPlayback(video, pointer.mediaNode);
      lastMediaTap = null;
    } else {
      if (pointer.pointerType === 'touch') activateAudio(video, pointer.mediaNode);
      lastMediaTap = { node: pointer.mediaNode, pointerType: pointer.pointerType, time: now };
    }
  }
  if (movement >= 8) suppressClickUntil = Date.now() + 250;
  if (pointers.size === 1) beginSingleGesture([...pointers.values()][0]);
  else if (pointers.size >= 2) beginPinchGesture();
  else {
    gesture = null;
    viewport.classList.remove('panning');
  }
}

viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);
viewport.addEventListener('wheel', (event) => {
  event.preventDefault();
  const steppedZoom = quantizeZoom(camera.zoom + (event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP));
  setZoomAround(steppedZoom, event.clientX, event.clientY);
}, { passive: false });

document.querySelector('#fit').addEventListener('click', fitAll);
document.querySelector('#restart').addEventListener('click', () => {
  paused = false;
  videos().forEach((video) => {
    const node = video.closest('.media-item');
    node._frameStepPauseLock = false;
    node._hoverStartedPlayback = false;
    video.currentTime = 0;
    setVideoPlayback(video, node, false);
  });
  playButton.textContent = '暂停全部';
});
playButton.addEventListener('click', () => {
  paused = true;
  videos().forEach((video) => {
    const node = video.closest('.media-item');
    setVideoPlayback(video, node, true);
  });
});
resumeButton.addEventListener('click', () => {
  paused = false;
  videos().forEach((video) => {
    const node = video.closest('.media-item');
    node._frameStepPauseLock = false;
    node._hoverStartedPlayback = false;
    setVideoPlayback(video, node, false);
  });
});
function updateMuteButton() {
  muteButton.classList.toggle('active', forcedMute);
  muteButton.setAttribute('aria-pressed', String(forcedMute));
}
muteButton.addEventListener('click', () => {
  forcedMute = !forcedMute;
  if (forcedMute) videos().forEach((video) => muteVideo(video));
  updateMuteButton();
});
addEventListener('keydown', (event) => {
  if (event.target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && stepHoveredVideo(event.key === 'ArrowLeft' ? -1 : 1)) {
    event.preventDefault();
  }
});
addEventListener('resize', fitAll);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) videos().forEach((video) => muteVideo(video));
});
updateMuteButton();
fitAll();
