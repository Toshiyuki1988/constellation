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
//   写真   : { kind: 'photo', blob }
//   テクスト: { kind: 'text', text }  ※読み取りに使った写真自体は保持しない
//   動画   : { kind: 'video', blob, durationSec }
//   音声   : { kind: 'audio', blob, durationSec }
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
    ocrProgress: document.getElementById('ocr-progress'),
    capBtn: document.getElementById('camera-cap-btn'),
    freezeWrap: document.getElementById('caption-freeze-wrap'),
    selectLayer: document.getElementById('caption-select-layer'),
    selectRect: document.getElementById('caption-select-rect'),
    selectActions: document.getElementById('caption-select-actions'),
    selectRetakeBtn: document.getElementById('caption-select-retake'),
    selectRunBtn: document.getElementById('caption-select-run'),

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

  camEls.shutterPhoto.addEventListener('click', capturePhoto);
  camEls.capBtn.addEventListener('click', captureForSelection);
  camEls.selectRetakeBtn.addEventListener('click', resetCaptionState);
  camEls.selectRunBtn.addEventListener('click', handleSelectionRun);
  wireSelectionLayer();

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
      camEls.shutterPhoto.disabled = false; // 前回の撮影で無効化されたままにならないよう、モード開始時に必ずリセットする
      camEls.videoPhoto.srcObject = camStream;
      camEls.videoPhoto.play().catch(() => {});
      enableTiltGuide(camEls.tiltLayerPhoto, camEls.alignPulsePhoto);
    } else if (mode === 'caption') {
      camEls.videoCaption.srcObject = camStream;
      camEls.videoCaption.play().catch(() => {});
      resetCaptionState();
      enableTiltGuide(camEls.tiltLayerCaption, camEls.alignPulseCaption);
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

// width/height は「これくらい欲しい」という ideal 指定。端末が対応していなければ
// 自動的に近い値に調整される(失敗はしない)。指定しないとブラウザ既定の低解像度
// (端末によっては 640x480 程度)になり、特にテクストモードのOCR精度に響くため必須。
const CAM_VIDEO_CONSTRAINTS = { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1440 } };

async function acquireStreamForMode(mode) {
  stopCameraStream();
  if (mode === 'photo' || mode === 'caption') {
    camStream = await navigator.mediaDevices.getUserMedia({ video: CAM_VIDEO_CONSTRAINTS, audio: false });
  } else if (mode === 'video') {
    camStream = await navigator.mediaDevices.getUserMedia({ video: CAM_VIDEO_CONSTRAINTS, audio: true });
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
    // 選択モード中(静止フレームを見ている間)はタップフォーカスの対象外
    if (e.target.closest('button, .cam-select-layer')) return;
    const rect = screenEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    placeFocus(focusLayerEl, x, y);
    tryApplyFocusPoint(x, y, rect.width, rect.height);
    void getVideoEl;
  });
}

/* ---------------- 撮影(canvasへフレーム描画してBlob化) ---------------- */

function captureFrameToCanvas(videoEl, maxEdge) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error('カメラ映像の準備ができていません');
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
  return canvas;
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画像の生成に失敗しました'))), 'image/jpeg', quality);
  });
}

async function captureFrameBlob(videoEl, maxEdge, quality) {
  const canvas = captureFrameToCanvas(videoEl, maxEdge);
  return canvasToBlob(canvas, quality);
}

async function capturePhoto() {
  if (!camStream) return;
  camEls.shutterPhoto.disabled = true;
  try {
    const blob = await captureFrameBlob(camEls.videoPhoto, 1600, 0.88);
    playShutter();
    finishCamera({ kind: 'photo', blob });
  } catch (err) {
    console.error(err);
    showCameraError('撮影に失敗しました');
    camEls.shutterPhoto.disabled = false;
  }
}

/* ---------------- テクストモード(キャプションだけをその場で読み取る) ----------------
   読み取りに使った写真そのものはカードに残さない(OCR用の使い捨て)。
   読み取れたテキストだけをテクストカードとして返す。
   撮影すると即OCRするのではなく、一度静止フレームを見せて「読み取りたい範囲」を
   指でなぞって選べるようにする(2026年9月追加)。選ばなければ全体を送る、従来通りの挙動。
   これは長いキャプション文の中から一部だけ拾いたい/余計な文字を除きたい場合のため。 */

let captionFreezeCanvas = null; // 撮影直後の静止フレーム(選択モード中だけ保持)
let captionSelection = null; // 選択レイヤー内のCSSピクセル座標 {x, y, w, h}。null = 未選択(全体)
let selectPointerActive = false;
let selectPointerId = null;
let selectStartX = 0;
let selectStartY = 0;

function resetCaptionState() {
  camEls.holdChip.classList.remove('show');
  camEls.ocrProgress.hidden = true;
  camEls.capBtn.hidden = false;
  camEls.capBtn.disabled = false;
  camEls.captionHint.textContent = '画面にキャプションを収めてタップ';
  captionFreezeCanvas = null;
  captionSelection = null;
  camEls.freezeWrap.classList.remove('show');
  camEls.freezeWrap.innerHTML = '';
  camEls.selectLayer.classList.remove('show');
  camEls.selectRect.hidden = true;
  camEls.selectActions.classList.remove('show');
  camEls.selectRunBtn.disabled = false;
  camEls.selectRetakeBtn.disabled = false;
  camEls.tiltLayerCaption.style.visibility = '';
  camEls.alignPulseCaption.style.visibility = '';
}

function camDebugLog(msg) {
  if (typeof debugLog === 'function') debugLog(msg);
}

/** 「タップして読み取る」: 撮影してすぐOCRはせず、選択モードへ移る */
async function captureForSelection() {
  if (!camStream) return;
  camEls.capBtn.disabled = true;
  try {
    const canvas = captureFrameToCanvas(camEls.videoCaption, 2400);
    playShutter();
    enterSelectionMode(canvas);
  } catch (err) {
    console.error(err);
    showCameraError('撮影に失敗しました');
    camEls.capBtn.disabled = false;
  }
}

function enterSelectionMode(canvas) {
  captionFreezeCanvas = canvas;
  captionSelection = null;
  camEls.freezeWrap.innerHTML = '';
  camEls.freezeWrap.appendChild(canvas);
  camEls.freezeWrap.classList.add('show');
  camEls.selectLayer.classList.add('show');
  camEls.selectRect.hidden = true;
  camEls.selectActions.classList.add('show');
  camEls.capBtn.hidden = true;
  camEls.tiltLayerCaption.style.visibility = 'hidden'; // 静止画には傾きガイド/正対インジケーターの意味が無い
  camEls.alignPulseCaption.style.visibility = 'hidden';
  camEls.captionHint.textContent = '文字の範囲を指でなぞって選択(そのままなら全体を読み取ります)';
  updateSelectRunLabel();
}

function updateSelectRunLabel() {
  camEls.selectRunBtn.textContent = captionSelection ? 'この範囲を読み取る' : '全体を読み取る';
}

/** 選択レイヤー上のドラッグで矩形を描く。指を離すまで始点を固定し、終点だけ動かす。 */
function wireSelectionLayer() {
  const layer = camEls.selectLayer;
  layer.addEventListener('pointerdown', (e) => {
    const rect = layer.getBoundingClientRect();
    selectStartX = e.clientX - rect.left;
    selectStartY = e.clientY - rect.top;
    selectPointerActive = true;
    selectPointerId = e.pointerId;
    try { layer.setPointerCapture(e.pointerId); } catch (err) { /* 無効なpointerIdは無視 */ }
    updateSelectRectFromPoints(selectStartX, selectStartY, selectStartX, selectStartY);
  });
  layer.addEventListener('pointermove', (e) => {
    if (!selectPointerActive || e.pointerId !== selectPointerId) return;
    const rect = layer.getBoundingClientRect();
    updateSelectRectFromPoints(selectStartX, selectStartY, e.clientX - rect.left, e.clientY - rect.top);
  });
  const endSelect = (e) => {
    if (e.pointerId !== selectPointerId) return;
    selectPointerActive = false;
    selectPointerId = null;
  };
  layer.addEventListener('pointerup', endSelect);
  layer.addEventListener('pointercancel', endSelect);
}

function updateSelectRectFromPoints(x0, y0, x1, y1) {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  // 誤タップ対策: 小さすぎる矩形は「選択なし」(=全体を読み取る)として扱う
  if (w < 8 || h < 8) {
    captionSelection = null;
    camEls.selectRect.hidden = true;
  } else {
    captionSelection = { x, y, w, h };
    camEls.selectRect.hidden = false;
    camEls.selectRect.style.left = `${x}px`;
    camEls.selectRect.style.top = `${y}px`;
    camEls.selectRect.style.width = `${w}px`;
    camEls.selectRect.style.height = `${h}px`;
  }
  updateSelectRunLabel();
}

/**
 * object-fit:containで表示された画像の、コンテナ内での実際の描画矩形(レターボックス分の
 * オフセットを含む)を求める。選択レイヤー上のCSSピクセル座標を、元画像のピクセル座標へ
 * 変換するために使う。
 */
function computeContainRect(containerW, containerH, imgW, imgH) {
  const containerRatio = containerW / containerH;
  const imgRatio = imgW / imgH;
  let renderW;
  let renderH;
  if (imgRatio > containerRatio) {
    renderW = containerW;
    renderH = containerW / imgRatio;
  } else {
    renderH = containerH;
    renderW = containerH * imgRatio;
  }
  return { offsetX: (containerW - renderW) / 2, offsetY: (containerH - renderH) / 2, renderW, renderH };
}

/** 静止フレーム(sourceCanvas)から、選択レイヤー上の矩形(CSSピクセル座標)が指す部分だけを切り出す */
function cropCanvasToBlob(sourceCanvas, containerEl, selRect, quality) {
  const containerRect = containerEl.getBoundingClientRect();
  const { offsetX, offsetY, renderW, renderH } = computeContainRect(
    containerRect.width, containerRect.height, sourceCanvas.width, sourceCanvas.height
  );
  const scale = sourceCanvas.width / renderW;
  // レターボックス部分(画像が実際には描かれていない余白)にはみ出た選択は、画像の範囲にクランプする
  const selX0 = Math.max(selRect.x, offsetX);
  const selY0 = Math.max(selRect.y, offsetY);
  const selX1 = Math.min(selRect.x + selRect.w, offsetX + renderW);
  const selY1 = Math.min(selRect.y + selRect.h, offsetY + renderH);

  const cropX = Math.max(0, (selX0 - offsetX) * scale);
  const cropY = Math.max(0, (selY0 - offsetY) * scale);
  const cropW = Math.max(1, (selX1 - selX0) * scale);
  const cropH = Math.max(1, (selY1 - selY0) * scale);

  const out = document.createElement('canvas');
  out.width = Math.round(cropW);
  out.height = Math.round(cropH);
  out.getContext('2d').drawImage(sourceCanvas, cropX, cropY, cropW, cropH, 0, 0, out.width, out.height);
  return canvasToBlob(out, quality);
}

/** 「この範囲を読み取る」/「全体を読み取る」ボタン */
async function handleSelectionRun() {
  if (!captionFreezeCanvas) return;
  camEls.selectRunBtn.disabled = true;
  camEls.selectRetakeBtn.disabled = true;
  camEls.captionHint.textContent = '読み取り中…';
  // Gemini応答は所要時間が読めないため、進捗率ではなく「動いている」ことだけを示す
  // 不定進捗のスライドバーで表現する。
  camEls.ocrProgress.hidden = false;
  try {
    // OCR用は取り込み後の作品写真(1600px)より高い解像度・画質で送る。
    // 文字の視認性が最優先なので、ダウンスケールで潰れないようにする。
    // (このBlobはOCRにのみ使い、成功しても保存・アップロードはしない)
    const blob = captionSelection
      ? await cropCanvasToBlob(captionFreezeCanvas, camEls.freezeWrap, captionSelection, 0.92)
      : await canvasToBlob(captionFreezeCanvas, 0.92);
    camDebugLog(`OCR送信(選択=${captionSelection ? 'あり' : 'なし(全体)'}) size=${blob.size}B type=${blob.type}`);
    const text = await ocrImage(blob);
    camDebugLog(`OCR結果: ${JSON.stringify(text)}`);
    if (!text || text.includes('(テキストなし)')) {
      camEls.captionHint.textContent = '文字を検出できませんでした。選択し直すか撮り直してください';
      camEls.selectRunBtn.disabled = false;
      camEls.selectRetakeBtn.disabled = false;
      return;
    }
    camEls.holdChipText.textContent = text.split('\n')[0].slice(0, 60);
    camEls.holdChip.classList.add('show');
    camEls.captionHint.textContent = '読み取りました';
    setTimeout(() => finishCamera({ kind: 'text', text }), 650);
  } catch (err) {
    console.error(err);
    camDebugLog('OCRエラー: ' + err.message);
    camEls.captionHint.textContent = '読み取りに失敗しました(' + err.message + ')';
    camEls.selectRunBtn.disabled = false;
    camEls.selectRetakeBtn.disabled = false;
  } finally {
    camEls.ocrProgress.hidden = true;
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
