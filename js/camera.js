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

// ピンチズーム(2026年9月追加)。track.getCapabilities().zoomが公開されている端末では
// 実際のセンサー/光学ズームをapplyConstraints()で制御し(camZoomNative=true)、非対応の
// 端末(iOS Safari等、実機ではほぼこちら)ではCSSのtransform:scaleでプレビューを拡大し、
// 撮影時のクロップ範囲も同じ倍率だけ狭める「デジタルズーム」にフォールバックする。
let camZoomScale = 1;
let camZoomNative = false;
let camZoomCaps = null; // {min, max, step} | null
const CAM_ZOOM_DIGITAL_MAX = 4;

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
  bindCameraViewportSync();
  syncCameraOverlayToVisualViewport();
  return new Promise((resolve) => {
    resolveCamera = resolve;
    camEls.overlay.classList.add('open');
    switchCameraMode(initialMode || 'photo');
  });
}

/* ---------------- visualViewportに基づく実サイズ同期(2026年9月追加) ----------------
 * CSSのdvh/dvwだけ(#camera-overlay、css/camera.css)による対応では、実機で「ブラウザの
 * ヘッダー・ボトムバー分、プレビューで見えている範囲より実際の写真の方が上下に広く写る」
 * 不具合が解消しなかった。position:fixed要素に対してdvh/dvwがアドレスバー・ボトムバーの
 * 表示状態をどこまで正確に反映するかはブラウザの実装に委ねられる部分が残るため、より確実な
 * 手段として、ブラウザが「今まさに実際に見えている範囲」を直接教えてくれるwindow.visualViewport
 * (Safari/Chrome双方で対応)を使い、#camera-overlayの実サイズ・位置をJSから直接同値に
 * 同期する。これにより、js/camera.jsのcomputeCoverCropRect()が読むgetBoundingClientRect()の
 * 値も、常に「ユーザーが実際に見ている範囲」と一致するようになる(CSSのdvh/dvwは
 * visualViewport非対応の環境向けのフォールバックとして残す)。 */
let camViewportSyncBound = false;

/**
 * 2026年9月、回転時の「一瞬正しい画角になるがすぐ拡大される」不具合が
 * orientationchange対応後も直らなかったため、原因切り分け用のログを追加した
 * (?debug付きURLの🐞パネルで確認する)。カメラが開いている間だけ記録する。
 */
function camDebugLogViewportState(label) {
  if (!camEls || !camEls.overlay.classList.contains('open') || !window.visualViewport) return;
  const vv = window.visualViewport;
  const activeVideoEl = activeZoomEls(camMode) && activeZoomEls(camMode).videoEl;
  const screenEl = activeVideoEl && activeVideoEl.parentElement;
  const rect = screenEl ? screenEl.getBoundingClientRect() : null;
  camDebugLog(
    `[cam-orient] ${label} t=${Math.round(performance.now())} `
    + `vv=${vv.width.toFixed(0)}x${vv.height.toFixed(0)}@${vv.offsetLeft.toFixed(0)},${vv.offsetTop.toFixed(0)} `
    + `innerWH=${window.innerWidth}x${window.innerHeight} `
    + `overlayStyleWH=${camEls.overlay.style.width}x${camEls.overlay.style.height} `
    + `screenRectWH=${rect ? `${rect.width.toFixed(0)}x${rect.height.toFixed(0)}` : '(なし)'} `
    + `videoWH=${activeVideoEl ? `${activeVideoEl.videoWidth}x${activeVideoEl.videoHeight}` : '(なし)'} `
    + `orientation=${window.screen && window.screen.orientation ? `${window.screen.orientation.type}/${window.screen.orientation.angle}` : '(不明)'}`
  );
}

function syncCameraOverlayToVisualViewport(evt) {
  if (!camEls || !window.visualViewport) return;
  camDebugLogViewportState(`sync前(${evt ? evt.type : '手動'})`);
  const vv = window.visualViewport;
  camEls.overlay.style.width = `${vv.width}px`;
  camEls.overlay.style.height = `${vv.height}px`;
  camEls.overlay.style.left = `${vv.offsetLeft}px`;
  camEls.overlay.style.top = `${vv.offsetTop}px`;
  camDebugLogViewportState(`sync後(${evt ? evt.type : '手動'})`);
}

/**
 * 画面回転時、「一瞬正しい画角になるがすぐ拡大される」不具合の対応(2026年9月)。
 * 上記syncCameraOverlayToVisualViewport()はvisualViewportの'resize'/'scroll'イベント任せ
 * だが、実機の回転直後はこのイベントの発火が数百ms遅れることがあり、その間
 * #camera-overlayのインラインサイズ(px固定値)は回転前の値のまま取り残される。
 * 以前(このJS同期を入れる前)はCSSのdvh/dvwがブラウザ側で回転と同時に即座に再計算されて
 * いたため、この「古いサイズが一瞬残る」ラグ自体が無かった。回転イベント
 * (orientationchange/screen.orientationのchange)を追加のトリガーとして拾い、
 * 複数回(0ms・150ms・400ms)遅延させて再同期することで、visualViewport側のイベントが
 * 遅れて発火する端末でも早期に正しいサイズへ収束させ、古いサイズのまま表示され続ける
 * 時間を最小化する。
 */
let camOrientationSettleTimers = [];

function handleCameraOrientationSettle(evt) {
  camDebugLogViewportState(`orientationイベント発火(${evt ? evt.type : '不明'})`);
  camOrientationSettleTimers.forEach((id) => clearTimeout(id));
  camOrientationSettleTimers = [0, 150, 400].map((delay) => setTimeout(() => {
    camDebugLogViewportState(`遅延同期タイマー(${delay}ms)`);
    syncCameraOverlayToVisualViewport();
  }, delay));
}

function bindCameraViewportSync() {
  if (camViewportSyncBound || !window.visualViewport) return;
  camViewportSyncBound = true;
  window.visualViewport.addEventListener('resize', syncCameraOverlayToVisualViewport);
  window.visualViewport.addEventListener('scroll', syncCameraOverlayToVisualViewport);
  window.addEventListener('orientationchange', handleCameraOrientationSettle);
  if (window.screen && window.screen.orientation) {
    window.screen.orientation.addEventListener('change', handleCameraOrientationSettle);
  }
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
    zoomBadgePhoto: document.getElementById('zoom-badge-photo'),
    shutterPhoto: document.getElementById('camera-shutter-photo'),

    captionScreen: document.getElementById('camera-screen-caption'),
    videoCaption: document.getElementById('camera-video-caption'),
    captionHint: document.getElementById('caption-hint'),
    tiltLayerCaption: document.getElementById('tilt-layer-caption'),
    alignPulseCaption: document.getElementById('align-pulse-caption'),
    focusLayerCaption: document.getElementById('focus-layer-caption'),
    zoomBadgeCaption: document.getElementById('zoom-badge-caption'),
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
    zoomBadgeVideo: document.getElementById('zoom-badge-video'),
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
  wireDesktopTrackpadZoomGuard();

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

  wirePinchZoom(camEls.photoScreen, camEls.videoPhoto, camEls.zoomBadgePhoto);
  wirePinchZoom(camEls.captionScreen, camEls.videoCaption, camEls.zoomBadgeCaption);
  wirePinchZoom(camEls.videoScreen, camEls.videoVideo, camEls.zoomBadgeVideo);

  // 回転時に映像ストリーム自体のネイティブ解像度(videoWidth/videoHeight)が変化していないか
  // 確認するためのデバッグログ(2026年9月追加)。<video>は内部解像度が変わると'resize'を発火する。
  [camEls.videoPhoto, camEls.videoCaption, camEls.videoVideo].forEach((v) => {
    v.addEventListener('resize', () => camDebugLogViewportState(`video resize(${v.id})`));
  });
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
    resetCamZoom(activeZoomEls(mode));

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
const CAM_VIDEO_CONSTRAINTS = { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } };

async function acquireStreamForMode(mode) {
  stopCameraStream();
  if (mode === 'photo' || mode === 'caption') {
    camStream = await navigator.mediaDevices.getUserMedia({ video: CAM_VIDEO_CONSTRAINTS, audio: false });
  } else if (mode === 'video') {
    camStream = await navigator.mediaDevices.getUserMedia({ video: CAM_VIDEO_CONSTRAINTS, audio: true });
  } else if (mode === 'audio') {
    camStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  if (mode === 'photo' || mode === 'caption' || mode === 'video') {
    await maximizeVideoTrackResolution(camStream);
  }
  return camStream;
}

/**
 * getUserMediaのideal指定はブラウザ側の裁量が大きく、端末が対応できても
 * それより低い解像度が選ばれることがある(2026年9月、実機でCAM_VIDEO_CONSTRAINTSを
 * 3840x2160にしても実際の撮影結果が900x1600止まりだった不具合の調査用に追加)。
 * 取得できたトラックの実際の対応幅(getCapabilities())を見て、端末が出せる最大解像度へ
 * 明示的に引き上げを試みる。getCapabilities/applyConstraints非対応のブラウザや失敗時は
 * 何もせず、既に取得できているストリームをそのまま使う(安全なベストエフォート、失敗しても
 * 撮影自体は継続できる)。結果は?debugパネルのdebugLog経由で確認できる。
 */
async function maximizeVideoTrackResolution(stream) {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return;
  const before = typeof track.getSettings === 'function' ? track.getSettings() : null;
  camDebugLog(`カメラ映像 取得直後: ${before ? `${before.width}x${before.height}` : '不明'}`);
  if (typeof track.getCapabilities !== 'function') {
    camDebugLog('getCapabilities非対応のためこれ以上の引き上げは試みません');
    return;
  }
  let caps;
  try {
    caps = track.getCapabilities();
  } catch (err) {
    camDebugLog(`getCapabilities失敗: ${err && err.message ? err.message : err}`);
    return;
  }
  camDebugLog(`カメラ対応幅: width.max=${caps.width && caps.width.max} height.max=${caps.height && caps.height.max}`);
  logCameraControlCapabilities(caps);
  camZoomCaps = caps.zoom || null; // ピンチズームで実際のセンサー/光学ズームを使えるかどうか(js/camera.jsのsetCamZoom()参照)
  if (!caps.width || !caps.width.max || !caps.height || !caps.height.max) return;
  if (before && caps.width.max <= before.width && caps.height.max <= before.height) return; // 既に上限に達している
  try {
    await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } });
    const after = typeof track.getSettings === 'function' ? track.getSettings() : null;
    camDebugLog(`applyConstraints後: ${after ? `${after.width}x${after.height}` : '不明'}`);
  } catch (err) {
    camDebugLog(`applyConstraints失敗: ${err && err.message ? err.message : err}`);
  }
}

/**
 * 段階ズーム・手動フォーカス・ホワイトバランスをどこまで作り込めるかは、この端末・ブラウザの
 * MediaStreamTrack Capabilities(Image Capture拡張)が何を公開しているか次第で、対応状況が
 * 機種ごとに大きく異なる(特にこのプロジェクトの主要環境であるiOS Safariは対応が薄いと
 * 見られる)。実装に着手する前に、まず実機で何が実際に使えるかをここでログに残す
 * (2026年9月追加)。?debug付きURLの🐞パネルで確認する。
 */
function logCameraControlCapabilities(caps) {
  const fields = [
    'zoom', 'focusMode', 'focusDistance', 'whiteBalanceMode', 'colorTemperature',
    'torch', 'exposureMode', 'exposureCompensation', 'exposureTime', 'iso', 'brightness', 'contrast',
  ];
  const summary = fields
    .map((f) => `${f}=${caps[f] !== undefined ? JSON.stringify(caps[f]) : '(非対応)'}`)
    .join(' / ');
  camDebugLog(`カメラ機能調査: ${summary}`);
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

/* ---------------- ピンチズーム(2026年9月追加) ----------------
 * 2本指のピンチ距離の変化率をcamZoomScaleへ反映する。#camera-overlay/.cam-screenに
 * touch-action:noneを付けてあるため(css/camera.css)、ブラウザ標準のページ全体の
 * ピンチズームとは競合しない(以前はこれが無く、ピンチすると画面ごとズームされ
 * シャッターボタンが見切れる不具合があった)。 */

function maxZoomForCurrentTrack() {
  return (camZoomCaps && camZoomCaps.max) ? camZoomCaps.max : CAM_ZOOM_DIGITAL_MAX;
}

/** 現在のモードのvideo要素・ズーム倍率表示バッジを返す(resetCamZoom()から使う) */
function activeZoomEls(mode) {
  if (mode === 'photo') return { videoEl: camEls.videoPhoto, badgeEl: camEls.zoomBadgePhoto };
  if (mode === 'caption') return { videoEl: camEls.videoCaption, badgeEl: camEls.zoomBadgeCaption };
  if (mode === 'video') return { videoEl: camEls.videoVideo, badgeEl: camEls.zoomBadgeVideo };
  return null;
}

/** モード切り替えのたびにズーム状態を1倍へ戻す(新しいストリームごとに仕切り直す) */
function resetCamZoom(target) {
  camZoomScale = 1;
  camZoomNative = false;
  camZoomCaps = null;
  camZoomApplyLatestValue = null; // 前のトラック宛ての送信中リクエストがあっても、これ以上追従させない
  if (target && target.videoEl) target.videoEl.style.transform = '';
  if (target && target.badgeEl) target.badgeEl.hidden = true;
}

function updateZoomBadge(badgeEl) {
  if (!badgeEl) return;
  if (camZoomScale <= 1.02) {
    badgeEl.hidden = true;
    return;
  }
  badgeEl.hidden = false;
  badgeEl.textContent = `${camZoomScale.toFixed(1)}x${camZoomNative ? '' : ' (デジタル)'}`;
}

// ネイティブズーム(track.applyConstraints)の連投を防ぐ状態(setCamZoom()参照)。
// ピンチ中はpointermoveが1秒間に何十回も発火するが、applyConstraints()はカメラハードウェアの
// 再設定を伴う重い処理で、実機では1回あたり数百ms〜かかることがある。愚直に毎回呼ぶと、
// 指を動かし終えてからもキューに溜まった大量のリクエストを律儀に順番にさばき続け、
// 「バッジの数字はすぐ動くのに、実際のズームは十数秒遅れてついてくる」不具合になっていた
// (2026年9月、実機報告)。常に「今送信中の1件」だけを許し、その間に来た新しい値は
// 送信中のリクエストが終わった時点でまとめて最新値だけを送る(古い値は送らない)ことで、
// ハードウェアの処理速度に自然に追従させる。
let camZoomApplyPending = false;
let camZoomApplyLatestValue = null;

function applyNativeZoomThrottled(track, value) {
  camZoomApplyLatestValue = value;
  if (camZoomApplyPending) return; // 既に1件送信中。完了時に最新値を見て続ける
  camZoomApplyPending = true;
  const sendNext = () => {
    const v = camZoomApplyLatestValue;
    track.applyConstraints({ advanced: [{ zoom: v }] })
      .catch((err) => {
        camDebugLog(`ズームapplyConstraints失敗: ${err && err.message ? err.message : err}`);
      })
      .finally(() => {
        if (camZoomApplyLatestValue !== v) {
          sendNext(); // 送信中にさらに新しい値が来ていたら、続けて最新値だけを送る
        } else {
          camZoomApplyPending = false;
        }
      });
  };
  sendNext();
}

function setCamZoom(scale, videoEl, badgeEl) {
  const max = maxZoomForCurrentTrack();
  camZoomScale = Math.max(1, Math.min(max, scale));
  if (camZoomCaps && camZoomCaps.max) {
    // ネイティブ制御が使える端末では実際のセンサー/光学ズームを動かす。videoWidth/videoHeightは
    // ブラウザ側が既にズーム後のフレームを返すため、captureFrameToCanvas側の追加クロップは不要。
    camZoomNative = true;
    videoEl.style.transform = '';
    const track = camStream && camStream.getVideoTracks()[0];
    if (track) applyNativeZoomThrottled(track, camZoomScale);
  } else {
    // 非対応端末向けのフォールバック: プレビューをCSSで拡大して見せ、実際の撮影時にも
    // captureFrameToCanvas()で同じ倍率だけクロップ範囲を狭める(WYSIWYGを保つ)。
    camZoomNative = false;
    videoEl.style.transform = `scale(${camZoomScale})`;
  }
  updateZoomBadge(badgeEl); // バッジは常に即座に最新の指の位置を反映する(ハードウェア追従待ちはしない)
}

/** 現在の撮影に使うべきデジタルズーム倍率(ネイティブズーム中は1、それ以外はcamZoomScale) */
function currentDigitalZoomForCapture() {
  return camZoomNative ? 1 : camZoomScale;
}

function wirePinchZoom(screenEl, videoEl, badgeEl) {
  const pointers = new Map();
  let pinchStartDist = null;
  let pinchStartScale = 1;

  function pinchDistance() {
    const pts = Array.from(pointers.values());
    if (pts.length < 2) return null;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  screenEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, .cam-select-layer')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      pinchStartDist = pinchDistance();
      pinchStartScale = camZoomScale;
    }
  });
  screenEl.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStartDist) {
      const d = pinchDistance();
      if (d) setCamZoom(pinchStartScale * (d / pinchStartDist), videoEl, badgeEl);
    }
  });
  const releasePointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStartDist = null;
  };
  screenEl.addEventListener('pointerup', releasePointer);
  screenEl.addEventListener('pointercancel', releasePointer);
}

/**
 * トラックパッドでのピンチ(PCでの動作確認時)は指でのタッチではなくホイールイベント
 * (Chrome/Edge: ctrlKey付きのwheel)またはWebKit独自のgestureイベント(Safari)として
 * 発火するため、touch-action: none(タッチ操作のみが対象)では防げず、ブラウザ標準の
 * ページ全体の拡大(Ctrl+スクロールズームと同じ仕組み)がそのまま起きてしまう
 * (2026年9月、PCでの実機確認時に再発報告)。カメラオーバーレイを開いている間だけ、
 * これらのイベントを止める。
 */
function wireDesktopTrackpadZoomGuard() {
  const stopIfZoomGesture = (e) => {
    if (e.ctrlKey) e.preventDefault();
  };
  camEls.overlay.addEventListener('wheel', stopIfZoomGesture, { passive: false });
  camEls.overlay.addEventListener('gesturestart', (e) => e.preventDefault());
  camEls.overlay.addEventListener('gesturechange', (e) => e.preventDefault());
}

/* ---------------- 撮影(canvasへフレーム描画してBlob化) ---------------- */

/**
 * プレビューの<video>はCSSで object-fit: cover になっており(css/camera.css)、
 * 画面のアスペクト比とカメラの生センサー比が違う端末では、はみ出た部分が
 * 画面上では見えないよう自動的に切り取られて表示されている。以前はここで
 * videoEl.videoWidth/videoHeightの生フレーム全体をそのまま撮影していたため、
 * 「画面で見ていた構図より実際の写真の方が一回り大きく写り込む」(2026年9月、
 * 実機報告)という、プレビューと撮影結果が一致しない不具合があった。
 * 画面上の実際の表示矩形を基準に、CSSのcover同様の中央クロップをここでも行うことで、
 * プレビューで見た構図と撮影結果を一致させる。
 */
function computeCoverCropRect(containerW, containerH, srcW, srcH) {
  const containerRatio = containerW / containerH;
  const srcRatio = srcW / srcH;
  let cropW = srcW;
  let cropH = srcH;
  if (srcRatio > containerRatio) {
    cropW = srcH * containerRatio; // 横方向が余るので左右を切り詰める
  } else {
    cropH = srcW / containerRatio; // 縦方向が余るので上下を切り詰める
  }
  return { sx: (srcW - cropW) / 2, sy: (srcH - cropH) / 2, sw: cropW, sh: cropH };
}

/**
 * @param {number} [digitalZoom] ネイティブズームが使えない端末でのピンチズーム倍率
 *   (js/camera.jsのsetCamZoom()参照)。1より大きい場合、cover相当のクロップ矩形を
 *   さらに中心から同じ倍率だけ狭め、プレビューで見た拡大結果と撮影結果を一致させる。
 */
function captureFrameToCanvas(videoEl, maxEdge, digitalZoom = 1) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error('カメラ映像の準備ができていません');

  // videoEl自体はピンチズーム中CSSのtransform:scaleが掛かっており、そのgetBoundingClientRect()は
  // 拡大後のサイズを返してしまう(cover計算が二重にズームされて狂う)ため、transformの影響を
  // 受けない親要素(.cam-screen、常に画面いっぱい)を基準にする。
  const containerEl = videoEl.parentElement || videoEl;
  const rect = containerEl.getBoundingClientRect();
  let { sx, sy, sw, sh } = (rect.width > 0 && rect.height > 0)
    ? computeCoverCropRect(rect.width, rect.height, vw, vh)
    : { sx: 0, sy: 0, sw: vw, sh: vh };

  if (digitalZoom > 1) {
    const zw = sw / digitalZoom;
    const zh = sh / digitalZoom;
    sx += (sw - zw) / 2;
    sy += (sh - zh) / 2;
    sw = zw;
    sh = zh;
  }

  let w = sw;
  let h = sh;
  const longest = Math.max(w, h);
  if (longest > maxEdge) {
    const s = maxEdge / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(videoEl, sx, sy, sw, sh, 0, 0, w, h);
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
    // フレームの描画(drawImage)は同期処理で、ここで実際に撮影される瞬間が確定する。
    // 2026年9月、解像度を長辺3840pxまで引き上げたことでJPEGエンコード(toBlob)に掛かる
    // 時間が体感できるほど増え、「ボタンを押してから音が鳴るまでの間」が開いて
    // 「つんのめる」ような体感になった(実機報告)。エンコード完了を待たず、フレームが
    // 確定した直後にシャッター音を鳴らすことで、実際の撮影タイミングと音を一致させる。
    const canvas = captureFrameToCanvas(camEls.videoPhoto, 3840, currentDigitalZoomForCapture());
    playShutter();
    const blob = await canvasToBlob(canvas, 0.88);
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
    const canvas = captureFrameToCanvas(camEls.videoCaption, 2400, currentDigitalZoomForCapture());
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

/**
 * 「この範囲を読み取る」/「全体を読み取る」ボタン。
 * **2026年9月変更**: 以前はここでGeminiの応答(所要時間が読めず、数秒かかることがある)を
 * オーバーレイを開いたまま待っていたため、その間ずっと次の写真が撮れなかった。実際に展覧会場で
 * 使ってみたユーザーから「OCRを待たされている間に次の写真を撮りたい」という要望があり、
 * 押した瞬間にカメラのオーバーレイ自体を閉じ、OCR(Gemini呼び出し)はrunOcrInBackground()で
 * バックグラウンドへ回すように変更した。進行中であることは画面右下の小さなPiP表示
 * (#ocr-pip、css/style.css)だけで示し、カメラは即座に次の撮影に使える状態へ戻る。
 */
async function handleSelectionRun() {
  if (!captionFreezeCanvas) return;
  let blob;
  try {
    // OCR用はダウンスケールを一切かけず、映像そのままの解像度・高画質で送る。
    // 文字の視認性が最優先なので、ダウンスケールで潰れないようにする。
    // (このBlobはOCRにのみ使い、成功しても保存・アップロードはしない)
    blob = captionSelection
      ? await cropCanvasToBlob(captionFreezeCanvas, camEls.freezeWrap, captionSelection, 0.92)
      : await canvasToBlob(captionFreezeCanvas, 0.92);
  } catch (err) {
    console.error(err);
    showCameraError('画像の切り出しに失敗しました');
    return;
  }
  camDebugLog(`OCR送信(選択=${captionSelection ? 'あり' : 'なし(全体)'}) size=${blob.size}B type=${blob.type}`);
  const resolve = detachCameraForBackgroundOcr();
  runOcrInBackground(blob, resolve);
}

/* ---------------- OCRのバックグラウンド実行・PiP表示(2026年9月追加) ----------------
 * openCamera('caption')の呼び出し元は元々このPromiseをawaitしているだけなので、resolveを
 * 呼ぶタイミングを後ろへずらすだけで、呼び出し元(app.js/crews.jsの各所)のルーティング
 * ロジック(新規テクストカードにする/カードのメモへ追記する/セッション名にする、等)は
 * 一切変更せずに済む。 */

let ocrPipJobCount = 0;
const ocrActiveControllers = new Set(); // 進行中のOCR呼び出しのAbortController(PiPの✕ボタンで全件キャンセルする)

function ocrPipEls() {
  return {
    pip: document.getElementById('ocr-pip'),
    text: document.getElementById('ocr-pip-text'),
    cancelBtn: document.getElementById('ocr-pip-cancel'),
  };
}

function updateOcrPip() {
  const { pip, text } = ocrPipEls();
  if (!pip || !text) return;
  pip.hidden = ocrPipJobCount <= 0;
  text.textContent = ocrPipJobCount > 1 ? `読み取り中…(${ocrPipJobCount}件)` : '読み取り中…';
}

/** 電波状況が悪い等でGeminiの応答がいつまでも返らない場合に、ユーザー自身が
 *  中止できるようにする(2026年9月追加。以前はタイムアウトも中止手段も無く、
 *  「読み取り中…」のまま永久に固まって見える不具合があった)。 */
function wireOcrPipCancelButton() {
  const { cancelBtn } = ocrPipEls();
  if (!cancelBtn) return;
  cancelBtn.addEventListener('click', () => {
    ocrActiveControllers.forEach((c) => c.abort());
  });
}
wireOcrPipCancelButton();

/** カメラのUIだけを片付け(ストリーム停止・オーバーレイを閉じる)、このcaption呼び出し専用の
 *  resolveを切り離して返す。切り離した後は次のopenCamera()呼び出しと完全に独立して扱える。 */
function detachCameraForBackgroundOcr() {
  const resolve = resolveCamera;
  resolveCamera = null;
  teardownCamera();
  return resolve;
}

/** blobをGeminiへ送り、結果が出た時点で(呼び出し元がawaitしたまま待っている)resolveを呼ぶ。
 *  文字が検出できなかった/エラーになった場合はresolve(null)し、setStatus()(js/app.js)で
 *  ステータス欄に理由を残す(呼び出し元は元々nullを「キャンセル」として無視するだけなので
 *  安全に合流する)。 */
function runOcrInBackground(blob, resolve) {
  ocrPipJobCount++;
  const controller = new AbortController();
  ocrActiveControllers.add(controller);
  updateOcrPip();
  ocrImage(blob, { signal: controller.signal })
    .then((text) => {
      camDebugLog(`OCR結果: ${JSON.stringify(text)}`);
      if (!text || text.includes('(テキストなし)')) {
        if (typeof setStatus === 'function') setStatus('文字を検出できませんでした');
        resolve(null);
        return;
      }
      if (typeof setStatus === 'function') setStatus('文字を読み取りました');
      resolve({ kind: 'text', text });
    })
    .catch((err) => {
      console.error(err);
      camDebugLog('OCRエラー: ' + err.message);
      if (err && err.cancelled) {
        if (typeof setStatus === 'function') setStatus('読み取りを中止しました');
      } else {
        if (typeof setStatus === 'function') setStatus(`読み取りに失敗しました: ${err.message}`, { important: true });
      }
      resolve(null);
    })
    .finally(() => {
      ocrActiveControllers.delete(controller);
      ocrPipJobCount--;
      updateOcrPip();
    });
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
  camOrientationSettleTimers.forEach((id) => clearTimeout(id));
  camOrientationSettleTimers = [];
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
