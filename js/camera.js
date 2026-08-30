// CONSTELLATION — アプリ内蔵カメラ(写真・テクストOCR・動画・音声)。
//
// getUserMedia でカメラ映像を画面内に表示し、シャッター操作は canvas への
// フレーム描画で行う(OSのカメラアプリを起動しない)。これにより、
// 日本向けiPhoneで消せない「カメラのシャッター音」を回避できる。
// 撮影・録音の効果音は全て Web Audio API でその場合成しており、
// 音声ファイルは一切使用しない。
//
// 呼び出し側(app.js)は openCamera(mode) を呼ぶだけでよい。
// 戻り値は Promise<CaptureResult|null>(null はキャンセル)。
//   写真          : { kind: 'photo', blob, caption: null }
//   テクスト→写真 : { kind: 'photo', blob, caption: string }
//   動画          : { kind: 'video', blob, durationSec }
//   音声          : { kind: 'audio', blob, durationSec }
//
// interact.js との関係: このオーバーレイは position:fixed; inset:0 で
// キャンバスの上に独立して被さるだけなので、ポインタ操作はオーバーレイ側で
// 完結し、下のキャンバス(interact.js が監視している要素)には一切届かない。

const CAM_VIDEO_MIME_CANDIDATES = [
  'video/mp4;codecs=h264,aac',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const CAM_AUDIO_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

let camEls = null;
let camStream = null;
let camMode = 'photo';
let camSwitching = false;
let resolveCamera = null;

let currentTiltLayer = null;
let currentTiltPulse = null;
let orientationEnabled = false;

let camMediaRecorder = null;
let camRecordedChunks = [];
let camRecordTimerId = null;
let camRecordSeconds = 0;

let camWaveCtx = null;
let camWaveAnalyser = null;
let camWaveSource = null;
let camWaveRAF = null;

let heldCaption = null;

/** @param {'photo'|'caption'|'video'|'audio'} initialMode */
function openCamera(initialMode) {
  ensureCameraDom();
  return new Promise((resolve) => {
    resolveCamera = resolve;
    camEls.overlay.classList.add('open');
    switchCameraMode(initialMode || 'photo');
  });
}

function ensureCameraDom() {
  if (camEls) return;
  camEls = {
    overlay: document.getElementById('camera-overlay'),
    closeBtn: document.getElementById('camera-close'),
    modeButtons: Array.from(document.querySelectorAll('#camera-mode-switch button')),
    screens: Array.from(document.querySelectorAll('.cam-screen')),
    error: document.getElementById('camera-error'),

    photoScreen: document.getElementById('camera-screen-photo'),
    videoPhoto: document.getElementById('camera-video-photo'),
    tiltLayerPhoto: document.getElementById('tilt-layer-photo'),
    alignPulsePhoto: document.getElementById('align-pulse-photo'),
    focusLayerPhoto: document.getElementById('focus-layer-photo'),
    shutterPhoto: document.getElementById('camera-shutter-photo'),

    captionScreen: document.getElementById('camera-screen-caption'),
    videoCaption: document.getElementById('camera-video-caption'),
    captionHint: document.getElementById('caption-hint'),
    tiltLayerCaption: document.getElementById('tilt-layer-caption'),
    alignPulseCaption: document.getElementById('align-pulse-caption'),
    focusLayerCaption: document.getElementById('focus-layer-caption'),
    holdChip: document.getElementById('hold-chip'),
    holdChipText: document.getElementById('hold-chip-text'),
    capBtn: document.getElementById('camera-cap-btn'),
    shutterCaption: document.getElementById('camera-shutter-caption'),

    videoScreen: document.getElementById('camera-screen-video'),
    videoVideo: document.getElementById('camera-video-video'),
    videoDot: document.getElementById('video-rec-dot'),
    videoTime: document.getElementById('video-time'),
    videoRecBtn: document.getElementById('camera-video-rec-btn'),

    audioWavePath: document.getElementById('audio-wave-path'),
    audioTimer: document.getElementById('audio-timer'),
    audioBtn: document.getElementById('camera-audio-btn'),
    audioLabel: document.getElementById('audio-label'),
  };
  wireCameraEvents();
}

function wireCameraEvents() {
  camEls.closeBtn.addEventListener('click', closeCamera);

  camEls.modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isRecording()) return;
      switchCameraMode(btn.dataset.mode);
    });
  });

  camEls.shutterPhoto.addEventListener('click', () => capturePhoto(camEls.videoPhoto, null));
  camEls.capBtn.addEventListener('click', handleCaptionRead);
  camEls.shutterCaption.addEventListener('click', () => capturePhoto(camEls.videoCaption, heldCaption));

  camEls.videoRecBtn.addEventListener('click', () => {
    if (isRecording()) {
      camMediaRecorder.stop();
    } else {
      startVideoRecording();
    }
  });
  camEls.audioBtn.addEventListener('click', () => {
    if (isRecording()) {
      camMediaRecorder.stop();
    } else {
      startAudioRecording();
    }
  });

  wireTapFocus(camEls.photoScreen, camEls.focusLayerPhoto, () => camEls.videoPhoto);
  wireTapFocus(camEls.captionScreen, camEls.focusLayerCaption, () => camEls.videoCaption);
}

function isRecording() {
  return Boolean(camMediaRecorder && camMediaRecorder.state === 'recording');
}

/* ---------------- モード切り替え・ストリーム管理 ---------------- */

async function switchCameraMode(mode) {
  if (camSwitching) return;
  camSwitching = true;
  try {
    teardownModeExtras();
    camMode = mode;
    updateModeSwitchUI();
    updateScreenVisibility();
    clearCameraError();

    try {
      await acquireStreamForMode(mode);
    } catch (err) {
      console.error(err);
      showCameraError('カメラ/マイクを使用できませんでした。ブラウザの権限設定を確認してください');
      return;
    }

    if (mode === 'photo') {
      camEls.videoPhoto.srcObject = camStream;
      camEls.videoPhoto.play().catch(() => {});
      enableTiltGuide(camEls.tiltLayerPhoto, camEls.alignPulsePhoto);
    } else if (mode === 'caption') {
      camEls.videoCaption.srcObject = camStream;
      camEls.videoCaption.play().catch(() => {});
      resetCaptionState();
    } else if (mode === 'video') {
      camEls.videoVideo.srcObject = camStream;
      camEls.videoVideo.play().catch(() => {});
    } else if (mode === 'audio') {
      setupWaveform();
    }
  } finally {
    camSwitching = false;
  }
}

async function acquireStreamForMode(mode) {
  stopCameraStream();
  if (mode === 'photo' || mode === 'caption') {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } else if (mode === 'video') {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: true });
  } else if (mode === 'audio') {
    camStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  return camStream;
}

function stopCameraStream() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
}

function teardownModeExtras() {
  teardownWaveform();
  currentTiltLayer = null;
  currentTiltPulse = null;
  if (camEls) {
    camEls.tiltLayerPhoto.classList.remove('enabled', 'aligned');
    camEls.tiltLayerCaption.classList.remove('enabled', 'aligned');
  }
}

function updateModeSwitchUI() {
  camEls.modeButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === camMode));
}

function updateScreenVisibility() {
  camEls.screens.forEach((el) => el.classList.toggle('active', el.dataset.mode === camMode));
}

/* ---------------- 傾きガイド(実機のデバイス傾きセンサーを使用) ---------------- */

async function enableTiltGuide(layerEl, pulseEl) {
  currentTiltLayer = layerEl;
  currentTiltPulse = pulseEl;
  layerEl.classList.add('enabled');
  if (orientationEnabled) return;
  if (typeof DeviceOrientationEvent === 'undefined') return;
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') return;
    }
    window.addEventListener('deviceorientation', onDeviceOrientation);
    orientationEnabled = true;
  } catch (err) {
    // 非対応環境・権限拒否。傾きガイドなしで撮影自体は続行できる。
  }
}

function onDeviceOrientation(e) {
  if (!currentTiltLayer) return;
  const gamma = e.gamma == null ? 0 : e.gamma; // 左右の傾き
  const betaDev = e.beta == null ? 0 : e.beta - 90; // 縦持ち基準からの前後の傾き
  const wobbleX = Math.max(-20, Math.min(20, gamma));
  const wobbleY = Math.max(-20, Math.min(20, betaDev));
  currentTiltLayer.querySelectorAll('.cam-tick').forEach((tick, i) => {
    const dir = i % 2 === 0 ? 1 : -1;
    tick.style.transform = `translate(${wobbleX * dir * 0.4}px, ${wobbleY * 0.5}px)`;
  });
  const aligned = Math.abs(gamma) < 4 && Math.abs(betaDev) < 6;
  currentTiltLayer.classList.toggle('aligned', aligned);
  if (currentTiltPulse) currentTiltPulse.classList.toggle('show', aligned);
}

/* ---------------- 手描きフォーカス(タップでピント) ---------------- */

function wobblePath(points, jitter) {
  return points.map(([x, y]) => {
    const jx = (Math.random() - 0.5) * jitter;
    const jy = (Math.random() - 0.5) * jitter;
    return `${x + jx},${y + jy}`;
  });
}

function drawFocusRing(jitter) {
  const corners = [
    [[8, 32], [8, 8], [32, 8]],
    [[64, 8], [88, 8], [88, 32]],
    [[88, 64], [88, 88], [64, 88]],
    [[32, 88], [8, 88], [8, 64]],
  ];
  let d = '';
  corners.forEach((seg) => {
    const p = wobblePath(seg, 6);
    d += `M${p[0]} Q${p[1]} ${p[2]} `;
  });
  return d;
}

function placeFocus(container, x, y) {
  const old = container.querySelector('.cam-focus-group');
  if (old) old.remove();
  const group = document.createElement('div');
  group.className = 'cam-focus-group';
  group.style.left = `${x}px`;
  group.style.top = `${y}px`;
  group.innerHTML = `
    <div class="cam-focus-rect"><svg viewBox="0 0 96 96"><path d="${drawFocusRing()}"/></svg></div>
    <div class="cam-sun"><svg viewBox="0 0 26 26">
      <circle cx="13" cy="13" r="5"/>
      <line x1="13" y1="1" x2="13" y2="4"/><line x1="13" y1="22" x2="13" y2="25"/>
      <line x1="1" y1="13" x2="4" y2="13"/><line x1="22" y1="13" x2="25" y2="13"/>
      <line x1="4.5" y1="4.5" x2="6.5" y2="6.5"/><line x1="19.5" y1="19.5" x2="21.5" y2="21.5"/>
      <line x1="21.5" y1="4.5" x2="19.5" y2="6.5"/><line x1="6.5" y1="19.5" x2="4.5" y2="21.5"/>
    </svg></div>`;
  container.appendChild(group);
  setTimeout(() => { if (group.parentNode) group.remove(); }, 1500);
}

/** 対応機種であれば実際のフォーカス位置も指定する(非対応なら黙って無視) */
function tryApplyFocusPoint(x, y, width, height) {
  if (!camStream) return;
  const track = camStream.getVideoTracks()[0];
  if (!track || !track.getCapabilities) return;
  try {
    const caps = track.getCapabilities();
    if (caps.focusMode && caps.focusMode.includes('single-shot')) {
      track.applyConstraints({
        advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x: x / width, y: y / height }] }],
      }).catch(() => {});
    }
  } catch (err) {
    // 非対応環境では無視(装飾的なフォーカスリング表示のみ行う)
  }
}

function wireTapFocus(screenEl, focusLayerEl, getVideoEl) {
  screenEl.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const rect = screenEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    placeFocus(focusLayerEl, x, y);
    tryApplyFocusPoint(x, y, rect.width, rect.height);
    void getVideoEl;
  });
}

/* ---------------- 撮影(canvasへフレーム描画してBlob化) ---------------- */

function captureFrameBlob(videoEl, maxEdge, quality) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return Promise.reject(new Error('カメラ映像の準備ができていません'));
  let w = vw;
  let h = vh;
  const longest = Math.max(w, h);
  if (longest > maxEdge) {
    const s = maxEdge / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像の生成に失敗しました'))), 'image/jpeg', quality);
  });
}

async function capturePhoto(videoEl, caption) {
  if (!camStream) return;
  const btn = videoEl === camEls.videoCaption ? camEls.shutterCaption : camEls.shutterPhoto;
  btn.disabled = true;
  try {
    const blob = await captureFrameBlob(videoEl, 1600, 0.88);
    playShutter();
    finishCamera({ kind: 'photo', blob, caption: caption || null });
  } catch (err) {
    console.error(err);
    showCameraError('撮影に失敗しました');
    btn.disabled = false;
  }
}

/* ---------------- テクストモード(キャプション読み取り→保持→写真) ---------------- */

function resetCaptionState() {
  heldCaption = null;
  camEls.holdChip.classList.remove('show');
  camEls.capBtn.hidden = false;
  camEls.capBtn.disabled = false;
  camEls.captionHint.textContent = '画面にキャプションを収めてタップ';
  camEls.shutterCaption.hidden = true;
  camEls.tiltLayerCaption.classList.remove('enabled', 'aligned');
}

async function handleCaptionRead() {
  if (!camStream) return;
  camEls.capBtn.disabled = true;
  camEls.captionHint.textContent = '読み取り中…';
  try {
    const blob = await captureFrameBlob(camEls.videoCaption, 1400, 0.85);
    playShutter();
    const text = await ocrImage(blob);
    if (!text || text.includes('(テキストなし)')) {
      camEls.captionHint.textContent = '文字を検出できませんでした。もう一度お試しください';
      camEls.capBtn.disabled = false;
      return;
    }
    heldCaption = text.split('\n')[0].slice(0, 60);
    camEls.holdChipText.textContent = heldCaption;
    camEls.holdChip.classList.add('show');
    camEls.capBtn.hidden = true;
    camEls.shutterCaption.hidden = false;
    camEls.shutterCaption.disabled = false;
    camEls.captionHint.textContent = 'キャプションを保持中・作品にカメラを向けてください';
    enableTiltGuide(camEls.tiltLayerCaption, camEls.alignPulseCaption);
  } catch (err) {
    console.error(err);
    camEls.captionHint.textContent = '読み取りに失敗しました。もう一度お試しください';
    camEls.capBtn.disabled = false;
  }
}

/* ---------------- 動画モード ---------------- */

function startVideoRecording() {
  camRecordedChunks = [];
  const mimeType = pickSupportedMimeType(CAM_VIDEO_MIME_CANDIDATES);
  try {
    camMediaRecorder = new MediaRecorder(camStream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    console.error(err);
    showCameraError('この端末では動画の録画に対応していません');
    return;
  }
  camMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) camRecordedChunks.push(e.data);
  };
  camMediaRecorder.onstop = () => {
    const blob = new Blob(camRecordedChunks, { type: camMediaRecorder.mimeType || 'video/webm' });
    const durationSec = camRecordSeconds;
    stopRecordTimer();
    playRecStop();
    camEls.videoRecBtn.classList.remove('recording');
    camEls.videoDot.hidden = true;
    camMediaRecorder = null;
    finishCamera({ kind: 'video', blob, durationSec });
  };
  camMediaRecorder.start();
  playRecStart();
  camEls.videoRecBtn.classList.add('recording');
  camEls.videoDot.hidden = false;
  startRecordTimer(camEls.videoTime);
}

/* ---------------- 音声モード ---------------- */

function startAudioRecording() {
  camRecordedChunks = [];
  const mimeType = pickSupportedMimeType(CAM_AUDIO_MIME_CANDIDATES);
  try {
    camMediaRecorder = new MediaRecorder(camStream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    console.error(err);
    showCameraError('この端末では録音に対応していません');
    return;
  }
  camMediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) camRecordedChunks.push(e.data);
  };
  camMediaRecorder.onstop = () => {
    const blob = new Blob(camRecordedChunks, { type: camMediaRecorder.mimeType || 'audio/webm' });
    const durationSec = camRecordSeconds;
    stopRecordTimer();
    playRecStop();
    camEls.audioLabel.textContent = 'タップで録音開始';
    camMediaRecorder = null;
    finishCamera({ kind: 'audio', blob, durationSec });
  };
  camMediaRecorder.start();
  playRecStart();
  camEls.audioLabel.textContent = 'タップで停止';
  startRecordTimer(camEls.audioTimer);
}

function setupWaveform() {
  if (!camStream) return;
  camWaveCtx = new (window.AudioContext || window.webkitAudioContext)();
  camWaveSource = camWaveCtx.createMediaStreamSource(camStream);
  camWaveAnalyser = camWaveCtx.createAnalyser();
  camWaveAnalyser.fftSize = 256;
  camWaveSource.connect(camWaveAnalyser);
  const data = new Uint8Array(camWaveAnalyser.frequencyBinCount);
  const N = 26;
  const draw = () => {
    camWaveAnalyser.getByteTimeDomainData(data);
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const idx = Math.floor((i / N) * (data.length - 1));
      const v = (data[idx] - 128) / 128;
      pts.push([(220 / N) * i, 32 + v * 26]);
    }
    let d = `M${pts[0][0]},${pts[0][1]} `;
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1];
      const [x, y] = pts[i];
      d += `Q${px},${py} ${(px + x) / 2},${(py + y) / 2} `;
    }
    camEls.audioWavePath.setAttribute('d', d);
    camWaveRAF = requestAnimationFrame(draw);
  };
  draw();
}

function teardownWaveform() {
  if (camWaveRAF) cancelAnimationFrame(camWaveRAF);
  camWaveRAF = null;
  if (camWaveSource) {
    try { camWaveSource.disconnect(); } catch (err) { /* 既に切断済み */ }
    camWaveSource = null;
  }
  camWaveAnalyser = null;
  if (camWaveCtx) {
    camWaveCtx.close().catch(() => {});
    camWaveCtx = null;
  }
}

/* ---------------- 録画・録音タイマー共通処理 ---------------- */

function startRecordTimer(displayEl) {
  camRecordSeconds = 0;
  displayEl.textContent = '00:00';
  camRecordTimerId = setInterval(() => {
    camRecordSeconds++;
    displayEl.textContent = formatRecordTime(camRecordSeconds);
  }, 1000);
}

function stopRecordTimer() {
  clearInterval(camRecordTimerId);
  camRecordTimerId = null;
}

function formatRecordTime(totalSec) {
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function pickSupportedMimeType(candidates) {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
}

/* ---------------- オーバーレイの開閉 ---------------- */

function showCameraError(msg) {
  camEls.error.textContent = msg;
  camEls.error.hidden = false;
}

function clearCameraError() {
  camEls.error.hidden = true;
  camEls.error.textContent = '';
}

function finishCamera(result) {
  const resolve = resolveCamera;
  teardownCamera();
  if (resolve) resolve(result);
}

function closeCamera() {
  if (isRecording()) {
    camMediaRecorder.ondataavailable = null;
    camMediaRecorder.onstop = null;
    try { camMediaRecorder.stop(); } catch (err) { /* 既に停止済み */ }
  }
  camMediaRecorder = null;
  stopRecordTimer();
  const resolve = resolveCamera;
  teardownCamera();
  if (resolve) resolve(null);
}

function teardownCamera() {
  resolveCamera = null;
  stopCameraStream();
  teardownWaveform();
  currentTiltLayer = null;
  currentTiltPulse = null;
  heldCaption = null;
  camEls.overlay.classList.remove('open');
  clearCameraError();
}

/* ---------------- 効果音(Web Audio合成、音声ファイル不使用) ---------------- */

function camTone(ctx, freq, start, dur, type, peak) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function camClickBurst(ctx, start, dur, filterFreq, q, peak) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 1.6;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = filterFreq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.value = peak;
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(start);
}

function playShutter() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  camClickBurst(ctx, now, 0.028, 2200, 1.1, 0.9);
  camClickBurst(ctx, now + 0.024, 0.022, 1100, 1.0, 0.6);
}

function playRecStart() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  camTone(ctx, 440, now, 0.14, 'sine', 0.13);
  camTone(ctx, 660, now + 0.09, 0.18, 'sine', 0.13);
}

function playRecStop() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  camTone(ctx, 660, now, 0.14, 'sine', 0.13);
  camTone(ctx, 440, now + 0.09, 0.2, 'sine', 0.13);
}
