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

// ピンチズーム(2026年9月追加)。track.getCapabilities().zoomが公開されている端末では
// 実際のセンサー/光学ズームをapplyConstraints()で制御し(camZoomNative=true)、非対応の
// 端末(iOS Safari等、実機ではほぼこちら)ではCSSのtransform:scaleでプレビューを拡大し、
// 撮影時のクロップ範囲も同じ倍率だけ狭める「デジタルズーム」にフォールバックする。
let camZoomScale = 1;
let camZoomNative = false;
let camZoomCaps = null; // {min, max, step} | null
const CAM_ZOOM_DIGITAL_MAX = 4;

// 露出補正・ホワイトバランス(2026年9月追加)。いずれも画像処理ではなく実機の
// MediaStreamTrack Capabilities(Image Capture拡張)を直接操作する、いわゆるハードウェア制御。
// ズームと同様、対応状況は端末・ブラウザ次第(特にiOS Safariは対応が薄いと見られる)。
// スライダーではなく「タップのたびにプリセットを1つずつ巡回する」ボタン方式にしている。
// **トーチも同時期に一度実装したが、「誤って点灯させたままの意図しないフラッシュ撮影を
// 避けたい」というユーザー判断により同月中に撤去した。**
let camExposurePresets = null; // [{value,label}, ...] | null(非対応)
let camExposureIndex = 0;
let camWbPresets = null; // [{mode,temp?,label}, ...] | null(非対応)
let camWbIndex = 0;

// 手ブレ検知オートシャッター(2026年9月追加、トーチ撤去の代わり)。DeviceMotionで
// 「構えて静止した瞬間」を検知して自動シャッターを切る。センサー非対応・権限拒否・
// 一定時間イベントが来ない端末では自動的にタイマー撮影へフォールバックする。
let camAutoShutterArmed = false;
let camAutoShutterMode = null; // 'motion' | 'timer' | null
let camAutoShutterLastVec = null;
let camAutoShutterSteadySince = null;
let camAutoShutterTimerId = null;
let camAutoShutterWatchdogId = null;
let camAutoShutterMotionGotEvent = false;
const AUTO_SHUTTER_STEADY_MS = 550; // これだけの時間、揺れが閾値を下回り続けたら撮影する
const AUTO_SHUTTER_JERK_THRESHOLD = 0.5; // m/s^2、前フレームとの加速度差(経験的な閾値)
const AUTO_SHUTTER_TIMER_MS = 3000; // センサー非対応時のフォールバック: 単純な3秒タイマー
const AUTO_SHUTTER_MOTION_WATCHDOG_MS = 1200; // この間に1件もdevicemotionが届かなければタイマーへ切り替える

// Eclipse(比率プリセット、2026年9月追加)。F/P/M/Sは油彩キャンバスの号数で使われる
// 「人物型・風景型・海景型・正方形」の4形状にちなむ近似比率(号数によって微妙に違うため、
// 構図の目安として代表的な値に丸めている)。ratioはすべて「長辺/短辺」。
const CAM_ECLIPSE_RATIO_PRESETS = [
  { key: 'F', ratio: 1.29, shape: 'rect' },
  { key: 'P', ratio: 1.50, shape: 'rect' },
  { key: 'M', ratio: 1.68, shape: 'rect' },
  { key: 'S', ratio: 1.00, shape: 'rect' },
  { key: 'C', ratio: 1.00, shape: 'circle' },
];

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
  return new Promise((resolve) => {
    resolveCamera = resolve;
    camEls.overlay.classList.add('open');
    switchCameraMode(initialMode || 'photo');
  });
}

/* ---------------- 画面回転時のプレビュー凍結対策(2026年9月) ----------------
 * 経緯: 「回転すると一瞬正しい画角になるがすぐ拡大される」不具合の調査のため、一時期
 * #camera-overlayの実サイズをJSからwindow.visualViewportの値で直接上書きする実装を
 * 入れていた(当初は「dvh/dvwだけではブラウザUI分の見切れが残る」問題への対応だった)。
 * 実機のデバッグログ(?debugパネル)で調べたところ、カメラ映像(getUserMedia)を表示中に
 * 端末を回転させると、orientationchangeイベント自体は発火するのに、
 * window.innerWidth/window.visualViewportの値がJSからは回転前のまま凍結して一切
 * 更新されないことが分かった(Safari・Chrome双方で再現、どちらもiOSではWebKitベースの
 * ため共通の癖とみられる)。このため、JSでvisualViewportの値を書き込む同期処理は
 * 「凍結した古い(回転前の)サイズ」を#camera-overlayへ書き込み続けるだけになり、
 * 回転後もプレビューが縦持ちサイズのまま画面の隅に取り残され、相対的に拡大して見える
 * 不具合の直接の原因になっていた。
 * 対応: #camera-overlayのサイズ指定はCSSのdvh/dvw(css/camera.css)にのみ委ね、
 * JSからのインラインサイズ上書きは廃止した。dvh/dvwはブラウザのレイアウトエンジンが
 * 直接計算するCSS単位であり、window.innerWidth等のJS APIの値が凍結していても
 * 正しく追従することを実機で確認済み。以前この上書きを追加した動機だった
 * 「dvh/dvwだけでは残っていたブラウザUI分の見切れ」が仮に再発しても、頻度・実害の
 * 大きい回転時のズーム不具合の解消を優先する。
 * 回転イベント自体(orientationchange/screen.orientationのchange)は、システムの
 * 回転アニメーション中の一瞬の描画の乱れを見せないための暗転(フェード)演出に使う。
 * **2026年9月追記**: 上記の対応後もなお画角が拡大されたまま戻らない実機報告が続いたため、
 * 疑いの先をコンテナのサイズ計算から映像ストリーム自体に切り替えた。getUserMediaで取得した
 * 映像トラックは、取得した瞬間の物理的な向きの解像度・縦横比のままで、その後端末を回転させても
 * ブラウザが自動で再ネゴシエートしてくれるとは限らない(特にiOS Safari)。コンテナ側
 * (dvh/dvw)は正しく追従していても、映像トラック自体の縦横比が古いままだと
 * object-fit: coverの計算がずれてズームして見える。対策として、回転を検知したら
 * 暗転している間に`acquireStreamForMode()`でストリームを取り直す(=新しい物理的な向きで
 * 撮り直す)ようにした。録画中(video/audioモード)はストリームの差し替えがMediaRecorderを
 * 壊すため対象外。 */
let camViewportSyncBound = false;
let camOrientationFadeTimer = null;

function activeCamVideoEl() {
  const target = activeZoomEls(camMode);
  return target ? target.videoEl : null;
}

/** 実機での動作確認用ログ(?debugパネル)。今はサイズ上書きをしていないので、
 *  ここで見るのは「CSSのdvh/dvwが実際にどの値へ落ち着いたか」の観測用途のみ。 */
function camDebugLogViewportState(label) {
  if (!camEls || !camEls.overlay.classList.contains('open')) return;
  const vv = window.visualViewport;
  const activeVideoEl = activeCamVideoEl();
  const screenEl = activeVideoEl && activeVideoEl.parentElement;
  const rect = screenEl ? screenEl.getBoundingClientRect() : null;
  const overlayRect = camEls.overlay.getBoundingClientRect();
  camDebugLog(
    `[cam-orient] ${label} t=${Math.round(performance.now())} `
    + `vv=${vv ? `${vv.width.toFixed(0)}x${vv.height.toFixed(0)}` : '(非対応)'} `
    + `innerWH=${window.innerWidth}x${window.innerHeight} `
    + `overlayRectWH=${overlayRect.width.toFixed(0)}x${overlayRect.height.toFixed(0)} `
    + `screenRectWH=${rect ? `${rect.width.toFixed(0)}x${rect.height.toFixed(0)}` : '(なし)'} `
    + `videoWH=${activeVideoEl ? `${activeVideoEl.videoWidth}x${activeVideoEl.videoHeight}` : '(なし)'} `
    + `orientation=${window.screen && window.screen.orientation ? `${window.screen.orientation.type}/${window.screen.orientation.angle}` : '(不明)'}`
  );
}

function handleCameraOrientationSettle(evt) {
  camDebugLogViewportState(`orientationイベント発火(${evt ? evt.type : '不明'})`);
  const videoEl = activeCamVideoEl();
  if (videoEl) videoEl.style.opacity = '0'; // 回転アニメーション中の乱れた描画を隠す(見た目のみ、撮影処理には影響しない)
  clearTimeout(camOrientationFadeTimer);
  camOrientationFadeTimer = setTimeout(async () => {
    await restartStreamForOrientation();
    camDebugLogViewportState('フェードイン');
    const currentVideoEl = activeCamVideoEl(); // restartStreamForOrientation()中にモードが変わっている可能性があるため取り直す
    if (currentVideoEl) currentVideoEl.style.opacity = '';
  }, 500);
}

/** 回転後、映像トラックを新しい物理的な向きで取り直す(handleCameraOrientationSettle()参照)。
 *  モード切替中・録画中・カメラを閉じた後に遅れて発火した場合は何もしない。 */
async function restartStreamForOrientation() {
  if (camSwitching) return; // モード切替と競合すると camStream の取り違えが起きるため譲る
  if (isRecording()) return; // 録画中にストリームを差し替えるとMediaRecorderが壊れる
  const mode = camMode;
  if (mode !== 'photo' && mode !== 'caption' && mode !== 'video') return; // 音声モードは映像トラックを持たない
  if (!camEls || !camEls.overlay.classList.contains('open')) return;
  camSwitching = true; // switchCameraMode()と同じフラグを共有し、この間のモード切替を防ぐ
  try {
    await acquireStreamForMode(mode);
    if (!camEls.overlay.classList.contains('open')) {
      stopCameraStream(); // 取得中にカメラが閉じられていた場合、取り直したストリームを宙に浮かせない
      return;
    }
    if (camMode !== mode) return; // camSwitchingで排他しているため通常は起きないが、念のための保険
    const videoEl = activeCamVideoEl();
    if (videoEl) {
      videoEl.srcObject = camStream;
      videoEl.play().catch(() => {});
    }
    resetCamZoom(activeZoomEls(mode)); // 新しいトラックはズーム状態を引き継がないため表示側も1倍に揃える
    resetCamControls();
    camDebugLog('回転検知によりカメラストリームを再取得しました');
  } catch (err) {
    camDebugLog(`回転時のストリーム再取得に失敗: ${err && err.message ? err.message : err}`);
  } finally {
    camSwitching = false;
  }
}

function bindCameraViewportSync() {
  if (camViewportSyncBound) return;
  camViewportSyncBound = true;
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
    focusLayerPhoto: document.getElementById('focus-layer-photo'),
    zoomBadgePhoto: document.getElementById('zoom-badge-photo'),
    shutterPhoto: document.getElementById('camera-shutter-photo'),
    eclipseGuidePhoto: document.getElementById('eclipse-guide-photo'),
    eclipseGuideTogglePhoto: document.getElementById('eclipse-guide-toggle-photo'),
    eclipseRatioRowPhoto: document.getElementById('eclipse-ratio-row-photo'),
    eclipseSizeSliderPhoto: document.getElementById('eclipse-size-slider-photo'),
    eclipseSymmetryTogglePhoto: document.getElementById('eclipse-symmetry-toggle-photo'),
    zoomSliderPhoto: document.getElementById('zoom-slider-photo'), // Eclipseから分離した常時表示のズームスライダー
    exposureBtn: document.getElementById('cam-exposure-btn'),
    exposureLabel: document.getElementById('cam-exposure-label'),
    wbBtn: document.getElementById('cam-wb-btn'),
    wbLabel: document.getElementById('cam-wb-label'),
    autoShutterBtn: document.getElementById('cam-auto-shutter-btn'),
    autoShutterLabel: document.getElementById('cam-auto-shutter-label'),

    captionScreen: document.getElementById('camera-screen-caption'),
    videoCaption: document.getElementById('camera-video-caption'),
    captionHint: document.getElementById('caption-hint'),
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

  wireEclipseGuide(camEls.photoScreen, camEls.eclipseGuidePhoto, camEls.eclipseGuideTogglePhoto, camEls.videoPhoto, camEls.zoomBadgePhoto);
  wireCamZoomSlider(camEls.photoScreen, camEls.videoPhoto, camEls.zoomBadgePhoto);
  wireCameraControls();
  wireAutoShutterButton();

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
    resetCamControls();

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
  updateCamControlAvailability(caps); // 露出補正・ホワイトバランス・トーチの対応状況をボタンへ反映
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

/* ---------------- 露出補正・ホワイトバランス・トーチ(2026年9月追加) ----------------
 * いずれも画像処理ではなく、getUserMediaで取得したMediaStreamTrackのapplyConstraints()で
 * カメラハードウェア自体の設定を変える(js/drive.js等とは無関係の、この端末のカメラの
 * 実際の露出・色温度・ライトを操作する)。スライダーは持たず、ボタンをタップするたびに
 * あらかじめ計算しておいたプリセットを1つずつ巡回する方式にした。 */

const CAM_WB_PRESET_KELVIN = [
  { temp: 3200, label: '白熱灯' },
  { temp: 4000, label: '蛍光灯' },
  { temp: 5500, label: '昼光' },
  { temp: 6500, label: '曇天' },
];

function roundToStep(value, step) {
  if (!step) return value;
  return Math.round(value / step) * step;
}

function formatEv(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

/** exposureCompensationのmin/maxから「標準・明るめ・暗め」の3プリセットを作る(非対応ならnull) */
function computeExposurePresets(caps) {
  const ec = caps.exposureCompensation;
  if (!ec || typeof ec.min !== 'number' || typeof ec.max !== 'number' || ec.min === ec.max) return null;
  const step = ec.step || 0.1;
  const zero = Math.max(ec.min, Math.min(ec.max, 0));
  const bright = roundToStep(Math.min(ec.max, ec.max * 0.6), step);
  const dim = roundToStep(Math.max(ec.min, ec.min * 0.6), step);
  return [
    { value: zero, label: '標準' },
    { value: bright, label: `明るめ ${formatEv(bright)}` },
    { value: dim, label: `暗め ${formatEv(dim)}` },
  ];
}

/** whiteBalanceModeに'manual'とcolorTemperatureが両方揃っている端末だけプリセットを作る */
function computeWbPresets(caps) {
  const wm = caps.whiteBalanceMode;
  const ct = caps.colorTemperature;
  if (!Array.isArray(wm) || !wm.includes('manual')) return null;
  if (!ct || typeof ct.min !== 'number' || typeof ct.max !== 'number') return null;
  const clamp = (k) => Math.max(ct.min, Math.min(ct.max, k));
  const presets = [{ mode: 'continuous', label: 'オート' }];
  CAM_WB_PRESET_KELVIN.forEach((p) => presets.push({ mode: 'manual', temp: clamp(p.temp), label: p.label }));
  return presets;
}

/** 新しいストリームを取得するたび、前のトラック宛ての状態を引きずらないよう呼ぶ(resetCamZoom()と対) */
function resetCamControls() {
  camExposurePresets = null;
  camExposureIndex = 0;
  camWbPresets = null;
  camWbIndex = 0;
  if (!camEls) return;
  [camEls.exposureBtn, camEls.wbBtn].forEach((btn) => {
    if (btn) { btn.hidden = true; btn.classList.remove('active'); }
  });
  [camEls.exposureLabel, camEls.wbLabel].forEach((label) => { if (label) label.hidden = true; });
}

/** 実機のCapabilitiesを見て、対応しているボタンだけ表示する(js/camera.jsのmaximizeVideoTrackResolution()から呼ぶ) */
function updateCamControlAvailability(caps) {
  if (!camEls) return;
  camExposurePresets = computeExposurePresets(caps);
  camExposureIndex = 0;
  if (camEls.exposureBtn) camEls.exposureBtn.hidden = !camExposurePresets;
  if (camEls.exposureLabel) {
    camEls.exposureLabel.hidden = !camExposurePresets;
    if (camExposurePresets) camEls.exposureLabel.textContent = camExposurePresets[0].label;
  }

  camWbPresets = computeWbPresets(caps);
  camWbIndex = 0;
  if (camEls.wbBtn) camEls.wbBtn.hidden = !camWbPresets;
  if (camEls.wbLabel) {
    camEls.wbLabel.hidden = !camWbPresets;
    if (camWbPresets) camEls.wbLabel.textContent = camWbPresets[0].label;
  }

  camDebugLog(`カメラ制御ボタン: 露出=${camExposurePresets ? 'あり' : 'なし'} / WB=${camWbPresets ? 'あり' : 'なし'}`);
}

function currentVideoTrack() {
  return camStream && camStream.getVideoTracks()[0];
}

async function cycleExposure() {
  if (!camExposurePresets) return;
  const track = currentVideoTrack();
  if (!track) return;
  camExposureIndex = (camExposureIndex + 1) % camExposurePresets.length;
  const preset = camExposurePresets[camExposureIndex];
  camEls.exposureLabel.textContent = preset.label;
  camEls.exposureBtn.classList.toggle('active', preset.value !== 0);
  try {
    await track.applyConstraints({ advanced: [{ exposureCompensation: preset.value }] });
  } catch (err) {
    camDebugLog(`露出補正applyConstraints失敗: ${err && err.message ? err.message : err}`);
  }
}

async function cycleWhiteBalance() {
  if (!camWbPresets) return;
  const track = currentVideoTrack();
  if (!track) return;
  camWbIndex = (camWbIndex + 1) % camWbPresets.length;
  const preset = camWbPresets[camWbIndex];
  camEls.wbLabel.textContent = preset.label;
  camEls.wbBtn.classList.toggle('active', preset.mode !== 'continuous');
  try {
    if (preset.mode === 'continuous') {
      await track.applyConstraints({ advanced: [{ whiteBalanceMode: 'continuous' }] });
    } else {
      await track.applyConstraints({ advanced: [{ whiteBalanceMode: 'manual', colorTemperature: preset.temp }] });
    }
  } catch (err) {
    camDebugLog(`ホワイトバランスapplyConstraints失敗: ${err && err.message ? err.message : err}`);
  }
}

function wireCameraControls() {
  [camEls.exposureBtn, camEls.wbBtn].forEach((btn) => {
    if (btn) btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  });
  if (camEls.exposureBtn) camEls.exposureBtn.addEventListener('click', (e) => { e.stopPropagation(); cycleExposure(); });
  if (camEls.wbBtn) camEls.wbBtn.addEventListener('click', (e) => { e.stopPropagation(); cycleWhiteBalance(); });
}

/* ---------------- 手ブレ検知オートシャッター(2026年9月追加) ----------------
 * トーチ(誤って点灯させたままの意図しないフラッシュ撮影が心配、というユーザー判断で撤去)の
 * 代わりに、暗い展示室でのシャッターブレ対策として追加した。DeviceMotionの加速度から
 * 「前フレームとの差(ジャーク)」を計算し、これが閾値を下回る状態がAUTO_SHUTTER_STEADY_MS
 * だけ続いたら自動でシャッターを切る。iOSは権限確認が必要(旧・傾きガイドと同じAPI)。
 * 権限拒否・API非対応・権限は通ったが実際にはイベントが来ない(センサー無し等)場合は、
 * AUTO_SHUTTER_MOTION_WATCHDOG_MS以内に1件もイベントが来なければ単純な3秒タイマーに
 * 切り替える「保険」を必ず用意し、どんな端末でも最終的には必ず撮影されるようにしている。 */

function wireAutoShutterButton() {
  if (!camEls.autoShutterBtn) return;
  camEls.autoShutterBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  camEls.autoShutterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (camAutoShutterArmed) disarmAutoShutter(); else armAutoShutter();
  });
}

async function ensureMotionPermission() {
  if (typeof DeviceMotionEvent === 'undefined') return false;
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const perm = await DeviceMotionEvent.requestPermission();
      return perm === 'granted';
    }
    return true; // 権限確認が不要な環境(iOS以外の大半)
  } catch (err) {
    camDebugLog(`devicemotion権限取得失敗: ${err && err.message ? err.message : err}`);
    return false;
  }
}

async function armAutoShutter() {
  if (camAutoShutterArmed) return;
  camAutoShutterArmed = true;
  camAutoShutterMode = null;
  camAutoShutterLastVec = null;
  camAutoShutterSteadySince = null;
  camAutoShutterMotionGotEvent = false;
  camEls.autoShutterBtn.classList.add('active');
  camEls.autoShutterLabel.hidden = false;
  camEls.autoShutterLabel.textContent = '判定中…';

  const granted = await ensureMotionPermission();
  if (!camAutoShutterArmed) return; // 権限確認中にキャンセルされた
  if (!granted) {
    startAutoShutterTimerFallback();
    return;
  }
  window.addEventListener('devicemotion', handleAutoShutterMotion);
  camDebugLog('オートシャッター: devicemotion監視を開始しました');
  // 権限は通ったが実機にセンサーが無い等でイベントが一切来ないケースの保険。
  camAutoShutterWatchdogId = setTimeout(() => {
    if (camAutoShutterArmed && !camAutoShutterMotionGotEvent) {
      camDebugLog('オートシャッター: devicemotionイベントが届かないためタイマーへ切り替えます');
      window.removeEventListener('devicemotion', handleAutoShutterMotion);
      startAutoShutterTimerFallback();
    }
  }, AUTO_SHUTTER_MOTION_WATCHDOG_MS);
}

function startAutoShutterTimerFallback() {
  camAutoShutterMode = 'timer';
  camEls.autoShutterLabel.textContent = `${Math.round(AUTO_SHUTTER_TIMER_MS / 1000)}秒後に撮影`;
  camAutoShutterTimerId = setTimeout(() => { fireAutoShutter(); }, AUTO_SHUTTER_TIMER_MS);
}

function handleAutoShutterMotion(e) {
  if (!camAutoShutterArmed) return;
  camAutoShutterMotionGotEvent = true;
  if (camAutoShutterMode == null) {
    camAutoShutterMode = 'motion';
    camEls.autoShutterLabel.textContent = '構えて待機…';
  }
  if (camAutoShutterMode !== 'motion') return; // 既にタイマーへフォールバック済みなら無視
  const a = e.acceleration && e.acceleration.x != null ? e.acceleration : e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  if (camAutoShutterLastVec) {
    const dx = a.x - camAutoShutterLastVec.x;
    const dy = a.y - camAutoShutterLastVec.y;
    const dz = a.z - camAutoShutterLastVec.z;
    const jerk = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const now = performance.now();
    if (jerk < AUTO_SHUTTER_JERK_THRESHOLD) {
      if (camAutoShutterSteadySince == null) camAutoShutterSteadySince = now;
      if (now - camAutoShutterSteadySince >= AUTO_SHUTTER_STEADY_MS) {
        fireAutoShutter();
        return;
      }
    } else {
      camAutoShutterSteadySince = null;
    }
  }
  camAutoShutterLastVec = { x: a.x, y: a.y, z: a.z };
}

function fireAutoShutter() {
  camDebugLog(`オートシャッター: 撮影(mode=${camAutoShutterMode})`);
  disarmAutoShutter();
  if (camEls && camEls.shutterPhoto && !camEls.shutterPhoto.disabled) capturePhoto();
}

function disarmAutoShutter() {
  camAutoShutterArmed = false;
  camAutoShutterMode = null;
  camAutoShutterLastVec = null;
  camAutoShutterSteadySince = null;
  window.removeEventListener('devicemotion', handleAutoShutterMotion);
  clearTimeout(camAutoShutterTimerId);
  camAutoShutterTimerId = null;
  clearTimeout(camAutoShutterWatchdogId);
  camAutoShutterWatchdogId = null;
  if (!camEls) return;
  if (camEls.autoShutterBtn) camEls.autoShutterBtn.classList.remove('active');
  if (camEls.autoShutterLabel) { camEls.autoShutterLabel.hidden = true; camEls.autoShutterLabel.textContent = 'OFF'; }
}

function stopCameraStream() {
  if (camStream) {
    camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
  }
}

function teardownModeExtras() {
  teardownWaveform();
  disarmAutoShutter(); // モードを抜けたら監視・タイマーを必ず止める(devicemotionリスナーの残留防止)
}

function updateScreenVisibility() {
  camEls.screens.forEach((el) => el.classList.toggle('active', el.dataset.mode === camMode));
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

/* ---------------- Eclipse: ダブルタップで出す位置合わせ用の矩形(2026年9月追加) ----------------
 * 絵画・写真の四隅に重ねて構図を整えるためだけのガイド。移動・リサイズできるが撮影結果には
 * 一切反映しない(capturePhoto()はこの矩形の状態を一切参照しない)。ダブルタップ検出は
 * js/canvas.jsの俯瞰ズーム判定(pointerdown/pointerupの間隔・距離を見るだけの自前実装)と
 * 同じ考え方。wireTapFocus()の既存のclick(シングルタップでピント)とは独立に動くため、
 * ダブルタップの1・2回目それぞれでピントも合わせにいくが実害はない(むしろ自然)。
 * **比率プリセット・スライダーリサイズ・対称/非対称トグルを追加(2026年9月)**:
 * F/P/M/S/○(油彩キャンバスの号数比率+円形、CAM_ECLIPSE_RATIO_PRESETS)の選択チップと、
 * 2本の縦スライダー(サイズ=選択中の比率を保ったままの拡縮、ズーム=既存のピンチズームと
 * 同じcamZoomScaleを動かす)を矩形に添えた。どちらも「ドラッグ量」ではなく「トラック上の
 * 絶対位置」で値を決める本物のスライダー。四隅ハンドルは引き続き比率を無視した自由リサイズ
 * 専用で、下辺の対称/非対称トグルがハンドル・サイズスライダー両方のリサイズの基準点
 * (中心固定 or 反対側固定)を切り替える。
 * **命名(2026年9月追記)**: この矩形ガイド+比率プリセット+スライダー一式のUI総称を
 * 「Eclipse」と名付けた(円形ガイドで暗い美術館を探る見た目が日食に近いことに由来)。
 * 関数名・CSSクラス(`cam-eclipse-*`)・CSS変数(`--eclipse-*`)・要素ID(`eclipse-*`)は
 * すべてこの名称に統一している。挙動自体はこの改名では変えていない。
 * **画面内クランプ・回転・中央リセットを追加(2026年9月)**: ガイドを画面端付近まで移動すると、
 * 右横のスライダー・上のチップ行・下のトグルなど、ガイド本体の外側に付く要素が画面外へ
 * 見切れることがあった。CSSレイアウト(margin/幅/高さ)から算出した固定オーバーハング量を元に、
 * これら付属要素を含めた全体が画面内に収まるようapplyRect()内で位置をクランプするようにした
 * (DOM計測は行わず、CSSの値と一致させた定数のみで判定する軽量な実装。CSSの値を変える場合は
 * 下記の定数も合わせて調整すること)。あわせて、ガイド左側に90度回転ボタンと画面中央への
 * リセットボタンを追加した(四隅ハンドルの当たり判定・右横のスライダーと重ならない位置)。
 * **サイズスライダーの拡縮基準点の修正(2026年9月)**: 以前は対称/非対称トグルの状態に
 * 応じてサイズスライダーの拡縮基準点も切り替わり、既定(非対称)では左上が固定点になっていた。
 * スライダーで縮小するたびガイドが左上へ寄っていく挙動が分かりにくいという指摘を受け、
 * サイズスライダーでの拡縮は常にガイドの中心を固定点にするよう変更した(対称/非対称トグルは
 * 四隅ハンドルでの自由リサイズにのみ効く)。
 * **ズームスライダーをEclipseから分離(2026年9月)**: 「ガイドを画面右へ寄せるとスライダー
 * 2本分の余白で窮屈になる」という指摘を受け、ズームスライダーをこのガイドの一部から
 * 切り出し、Eclipseの開閉に関わらず常時表示される独立コントロール(下記wireCamZoomSlider()、
 * css/camera.cssの`.cam-zoom-slider`)にした。ガイド表示中に見た目が重なることは意図的に
 * 許容している。見た目も宇宙船コックピットのスロットルレバー風に作り直した(ユーザー指定)。 */

/** トラック上のpointerY位置を0(下端)〜1(上端)の割合に変換する(位置マッピング式のスライダー
 *  共通処理)。wireEclipseGuide()のサイズスライダーとwireCamZoomSlider()の両方から使う。 */
function fracFromTrack(trackRect, clientY) {
  const frac = 1 - (clientY - trackRect.top) / trackRect.height;
  return Math.max(0, Math.min(1, frac));
}

function wireEclipseGuide(screenEl, eclipseEl, toggleBtn, videoEl, zoomBadgeEl) {
  // 実機で「ダブルタップしても反応しない」報告(2026年9月)を受け、指のブレ・タップ間隔の
  // バラつきに強くなるよう、js/canvas.jsの俯瞰ズーム判定(350ms/10px/40px)より緩めた値にした。
  const DOUBLE_TAP_MS = 500;
  const DOUBLE_TAP_MOVE_TOLERANCE_PX = 20;
  const DOUBLE_TAP_DISTANCE_TOLERANCE_PX = 70;
  const MIN_ECLIPSE_SIZE = 60;
  // 付属要素(比率チップ行・四隅ハンドル・サイズスライダー・対称トグル・回転/中央リセットボタン)が
  // ガイド本体の矩形からどれだけはみ出すかの固定量。css/camera.cssの対応する値と一致させること。
  // ズームスライダーは2026年9月にEclipseから分離し常時表示の独立コントロールにしたため、
  // ここでのクランプ計算からは除外している(画面右端に固定なので自分自身では動かない)。
  const RATIO_ROW_HALF_WIDTH = 77; // .cam-eclipse-ratio-row: 26px×5チップ+6px×4間隔=154の半分
  const HANDLE_OVERHANG = 22; // .cam-eclipse-handle: 44px角の当たり判定の半分
  const SIZE_SLIDER_RIGHT_OVERHANG = 42; // .cam-eclipse-slider: margin-left 16 + width 26
  const SLIDER_HALF_HEIGHT = 70; // .cam-eclipse-slider: height 140の半分(ガイドの縦中心基準)
  const RATIO_ROW_TOP_OVERHANG = 36; // チップ高さ26 + margin-bottom 10
  const SYM_TOGGLE_BOTTOM_OVERHANG = 32; // margin-top 10 + height 22
  const SYM_TOGGLE_HALF_WIDTH = 40; // 対称/非対称トグルの想定最大幅の半分(テキスト量に余裕を見た概算)
  const SIDE_BTNS_LEFT_OVERHANG = 38; // .cam-eclipse-side-btns: ボタン幅28 + margin-right 10
  let pressStart = null;
  let lastTapAt = 0;
  let lastTapPos = null;
  let visible = false;
  let ratioIndex = 0; // CAM_ECLIPSE_RATIO_PRESETSのどれを使っているか
  let symmetric = false; // 対称/非対称リサイズ(四隅ハンドルのみに効く。下辺トグル)

  const ratioRowEl = eclipseEl.querySelector('.cam-eclipse-ratio-row');
  const sizeSliderEl = eclipseEl.querySelector('.cam-eclipse-slider');
  const symmetryBtn = eclipseEl.querySelector('.cam-eclipse-symmetry-toggle');
  const sizeThumbEl = sizeSliderEl && sizeSliderEl.querySelector('.cam-eclipse-slider-thumb');
  const sizeTrackEl = sizeSliderEl && sizeSliderEl.querySelector('.cam-eclipse-slider-track');
  const rotateBtn = eclipseEl.querySelector('.cam-eclipse-rotate-btn');
  const recenterBtn = eclipseEl.querySelector('.cam-eclipse-recenter-btn');

  function currentRatio() { return CAM_ECLIPSE_RATIO_PRESETS[ratioIndex].ratio; }
  function currentShape() { return CAM_ECLIPSE_RATIO_PRESETS[ratioIndex].shape; }

  /** 今のガイドが縦長(portrait、90度回転後の状態)かどうか。回転後も専用のフラグを持たず、
   *  実際に描画中のwidth/heightから都度判定する(フリーハンドの四隅リサイズで向きが変わっても
   *  自動的に追従する)。 */
  function isPortrait() {
    const w = parseFloat(eclipseEl.style.width) || 0;
    const h = parseFloat(eclipseEl.style.height) || 0;
    return h > w;
  }

  /** その比率・向きで矩形の長辺が取りうる範囲。画面の94%以内に収まるよう都度計算する。
   *  portrait=trueの時は幅と高さの役割(どちらが「長辺」か)が入れ替わる。 */
  function sizeBoundsForRatio(ratio, portrait) {
    const rect = screenEl.getBoundingClientRect();
    const maxByWidth = portrait ? rect.width * 0.94 * ratio : rect.width * 0.94;
    const maxByHeight = portrait ? rect.height * 0.94 : rect.height * 0.94 * ratio;
    const max = Math.max(MIN_ECLIPSE_SIZE + 20, Math.min(maxByWidth, maxByHeight));
    return { min: MIN_ECLIPSE_SIZE, max };
  }

  /** 長辺の長さ(longSide)から、今の向き(isPortrait())に応じたw/hを組み立てる。 */
  function dimsFromLongSide(longSide) {
    const ratio = currentRatio();
    return isPortrait() ? { w: longSide / ratio, h: longSide } : { w: longSide, h: longSide / ratio };
  }

  function eclipsePadLeft(w) {
    return Math.max(HANDLE_OVERHANG, SIDE_BTNS_LEFT_OVERHANG, RATIO_ROW_HALF_WIDTH - w / 2, SYM_TOGGLE_HALF_WIDTH - w / 2);
  }
  function eclipsePadRight(w) {
    return Math.max(HANDLE_OVERHANG, SIZE_SLIDER_RIGHT_OVERHANG, RATIO_ROW_HALF_WIDTH - w / 2, SYM_TOGGLE_HALF_WIDTH - w / 2);
  }
  function eclipsePadTop(h) {
    return Math.max(RATIO_ROW_TOP_OVERHANG, SLIDER_HALF_HEIGHT - h / 2);
  }
  function eclipsePadBottom(h) {
    return Math.max(SYM_TOGGLE_BOTTOM_OVERHANG, SLIDER_HALF_HEIGHT - h / 2);
  }

  /** ガイド本体+付属要素(チップ行・ハンドル・スライダー・トグル・回転/中央リセットボタン)
   *  一式が画面(screenW×screenH)からはみ出さないよう、x/yをクランプしてからスタイルを適用する。
   *  screenW/screenHは呼び出し側で用意する(ドラッグ中の高頻度呼び出しでは、この関数自身が
   *  毎回getBoundingClientRect()し直さないようにするため。Asterism線のドラッグ最適化と同じ考え方、
   *  本ファイル上部CLAUDE.mdの既存の教訓を踏襲)。 */
  function applyRect(x, y, w, h, screenW, screenH) {
    const padL = eclipsePadLeft(w);
    const padR = eclipsePadRight(w);
    const padT = eclipsePadTop(h);
    const padB = eclipsePadBottom(h);
    const minX = padL;
    const maxX = Math.max(minX, screenW - w - padR);
    const minY = padT;
    const maxY = Math.max(minY, screenH - h - padB);
    x = Math.min(Math.max(x, minX), maxX);
    y = Math.min(Math.max(y, minY), maxY);
    eclipseEl.style.left = `${x}px`;
    eclipseEl.style.top = `${y}px`;
    eclipseEl.style.width = `${w}px`;
    eclipseEl.style.height = `${h}px`;
    if (rotateBtn) rotateBtn.classList.toggle('active', h > w);
  }

  function applyShapeAndChips() {
    eclipseEl.classList.toggle('shape-circle', currentShape() === 'circle');
    if (!ratioRowEl) return;
    ratioRowEl.querySelectorAll('.cam-eclipse-ratio-chip').forEach((chip, i) => {
      chip.classList.toggle('active', i === ratioIndex);
    });
  }

  /** サイズスライダーのつまみ位置を、今の矩形の長辺から逆算して合わせ直す(重い処理では
   *  ないが毎pointermoveでは呼ばない。プリセット切替・ハンドルドラッグ終了時などに使う)。 */
  function syncSizeSliderThumb() {
    if (!sizeThumbEl) return;
    const portrait = isPortrait();
    const bounds = sizeBoundsForRatio(currentRatio(), portrait);
    const curW = parseFloat(eclipseEl.style.width) || 0;
    const curH = parseFloat(eclipseEl.style.height) || 0;
    const longSide = Math.max(curW, curH) || bounds.min;
    const frac = bounds.max > bounds.min ? Math.max(0, Math.min(1, (longSide - bounds.min) / (bounds.max - bounds.min))) : 0;
    sizeThumbEl.style.top = `${(1 - frac) * 100}%`;
  }

  function showDefault() {
    ratioIndex = 0;
    symmetric = false;
    applyShapeAndChips();
    if (symmetryBtn) { symmetryBtn.classList.remove('active'); symmetryBtn.textContent = '非対称'; }
    const bounds = sizeBoundsForRatio(currentRatio(), false); // 毎回、横長(非回転)の既定姿勢に戻す
    const rect = screenEl.getBoundingClientRect();
    const w = Math.min(bounds.max, Math.max(bounds.min, rect.width * 0.62));
    const h = w / currentRatio();
    applyRect((rect.width - w) / 2, (rect.height - h) / 2, w, h, rect.width, rect.height);
    eclipseEl.classList.add('visible', 'appearing');
    setTimeout(() => eclipseEl.classList.remove('appearing'), 200);
    visible = true;
    if (toggleBtn) toggleBtn.classList.add('active');
    syncSizeSliderThumb();
  }
  function hide() {
    eclipseEl.classList.remove('visible');
    visible = false;
    if (toggleBtn) toggleBtn.classList.remove('active');
  }
  function toggle() {
    if (visible) hide(); else showDefault();
  }

  /** 比率プリセットを切り替える。今の中心・今の長辺の長さ・今の向き(縦長/横長)をできるだけ
   *  保ったまま、新しい比率に合わせて短辺だけ引き直す。 */
  function applyPreset(index) {
    ratioIndex = index;
    applyShapeAndChips();
    const rect = {
      x: parseFloat(eclipseEl.style.left) || 0, y: parseFloat(eclipseEl.style.top) || 0,
      w: parseFloat(eclipseEl.style.width) || 200, h: parseFloat(eclipseEl.style.height) || 200,
    };
    const portrait = isPortrait();
    const bounds = sizeBoundsForRatio(currentRatio(), portrait);
    const longSide = Math.max(rect.w, rect.h);
    const clampedLong = Math.max(bounds.min, Math.min(bounds.max, longSide));
    const dims = dimsFromLongSide(clampedLong);
    const centerX = rect.x + rect.w / 2;
    const centerY = rect.y + rect.h / 2;
    const screenRect = screenEl.getBoundingClientRect();
    applyRect(centerX - dims.w / 2, centerY - dims.h / 2, dims.w, dims.h, screenRect.width, screenRect.height);
    syncSizeSliderThumb();
  }

  /** ガイドを90度回転する(現在の中心を保ったままw/hを入れ替えるだけ)。四隅ハンドルの
   *  自由リサイズと同様、比率チェックはしない(スワップ後の値をそのまま使う)。 */
  function rotate90() {
    const x = parseFloat(eclipseEl.style.left) || 0;
    const y = parseFloat(eclipseEl.style.top) || 0;
    const w = parseFloat(eclipseEl.style.width) || 200;
    const h = parseFloat(eclipseEl.style.height) || 200;
    const cx = x + w / 2, cy = y + h / 2;
    const rect = screenEl.getBoundingClientRect();
    applyRect(cx - h / 2, cy - w / 2, h, w, rect.width, rect.height);
    syncSizeSliderThumb();
  }

  /** ガイドの中心を画面(screenEl)の中心へ戻す。サイズ・比率・向きは変えない、位置だけ戻す。 */
  function recenterToScreen() {
    const w = parseFloat(eclipseEl.style.width) || 200;
    const h = parseFloat(eclipseEl.style.height) || 200;
    const rect = screenEl.getBoundingClientRect();
    applyRect((rect.width - w) / 2, (rect.height - h) / 2, w, h, rect.width, rect.height);
  }

  if (ratioRowEl) {
    ratioRowEl.querySelectorAll('.cam-eclipse-ratio-chip').forEach((chip, i) => {
      chip.addEventListener('pointerdown', (e) => e.stopPropagation());
      chip.addEventListener('click', (e) => { e.stopPropagation(); applyPreset(i); });
    });
  }
  if (symmetryBtn) {
    symmetryBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    symmetryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      symmetric = !symmetric;
      symmetryBtn.classList.toggle('active', symmetric);
      symmetryBtn.textContent = symmetric ? '対称' : '非対称';
    });
  }
  if (rotateBtn) {
    rotateBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    rotateBtn.addEventListener('click', (e) => { e.stopPropagation(); rotate90(); });
  }
  if (recenterBtn) {
    recenterBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    recenterBtn.addEventListener('click', (e) => { e.stopPropagation(); recenterToScreen(); });
  }

  // ジェスチャー判定の不確実性に頼らない確実な入口(2026年9月追加)。実機で「素早く
  // ダブルタップしても反応しない」報告が続いたため、ボタンでも開閉できるようにした。
  if (toggleBtn) {
    toggleBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle();
    });
  }

  // 実機での原因切り分け用のデバッグログ(2026年9月、「ダブルタップしても反応しない」
  // 報告を受けて追加)。?debugパネルで、実際にpointerdown/upが届いているか、
  // どの条件で1回目・2回目の判定に落ちているかを確認できるようにしておく。
  screenEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cam-eclipse-guide, button')) {
      camDebugLog(`Eclipse: pointerdown ignored(target=${e.target.tagName}.${e.target.className || ''})`);
      return;
    }
    pressStart = { x: e.clientX, y: e.clientY };
    camDebugLog(`Eclipse: pointerdown(${Math.round(e.clientX)},${Math.round(e.clientY)}) type=${e.pointerType}`);
  });
  screenEl.addEventListener('pointerup', (e) => {
    if (!pressStart) {
      camDebugLog('Eclipse: pointerup with no pressStart(ignored)');
      return;
    }
    const moved = Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y);
    pressStart = null;
    if (moved > DOUBLE_TAP_MOVE_TOLERANCE_PX) {
      camDebugLog(`Eclipse: moved too much during tap(${moved.toFixed(1)}px > ${DOUBLE_TAP_MOVE_TOLERANCE_PX}px)`);
      return;
    }
    const now = Date.now();
    const pos = { x: e.clientX, y: e.clientY };
    if (
      lastTapPos &&
      now - lastTapAt < DOUBLE_TAP_MS &&
      Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) < DOUBLE_TAP_DISTANCE_TOLERANCE_PX
    ) {
      camDebugLog('Eclipse: double tap detected -> toggle()');
      lastTapAt = 0;
      lastTapPos = null;
      toggle();
    } else {
      const gapMs = lastTapPos ? now - lastTapAt : null;
      const distPx = lastTapPos ? Math.hypot(pos.x - lastTapPos.x, pos.y - lastTapPos.y) : null;
      camDebugLog(`Eclipse: recorded as 1st tap(prevGapMs=${gapMs}, prevDistPx=${distPx != null ? distPx.toFixed(1) : 'n/a'})`);
      lastTapAt = now;
      lastTapPos = pos;
    }
  });

  /* ---- 矩形の移動・リサイズ(四隅ハンドル) ---- */
  let dragMode = null; // 'move' | 'nw'|'ne'|'sw'|'se' | 'size-slider'
  let dragStart = null;

  function beginDrag(mode, e) {
    dragMode = mode;
    const r = eclipseEl.getBoundingClientRect();
    const parentRect = screenEl.getBoundingClientRect();
    dragStart = {
      x: e.clientX, y: e.clientY,
      rx: r.left - parentRect.left, ry: r.top - parentRect.top,
      rw: r.width, rh: r.height,
      screenW: parentRect.width, screenH: parentRect.height, // 画面内クランプ用(applyRect参照)。ドラッグ中は再計測しない
    };
    // スライダーのトラック位置・その比率での可動範囲は、ドラッグ中(pointermoveのたび)に
    // getBoundingClientRect()し直すと重いため、開始時に1回だけ計算して使い回す
    // (Asterism線のドラッグ最適化と同じ考え方、本ファイル上部CLAUDE.mdの既存の教訓)。
    if (mode === 'size-slider' && sizeTrackEl) {
      dragStart.trackRect = sizeTrackEl.getBoundingClientRect();
      dragStart.sizeBounds = sizeBoundsForRatio(currentRatio(), isPortrait());
    }
    e.stopPropagation();
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
  }

  eclipseEl.querySelector('.cam-eclipse-body').addEventListener('pointerdown', (e) => beginDrag('move', e));
  eclipseEl.querySelectorAll('.cam-eclipse-handle').forEach((h) => {
    const mode = h.classList.contains('nw') ? 'nw' : h.classList.contains('ne') ? 'ne' : h.classList.contains('sw') ? 'sw' : 'se';
    h.addEventListener('pointerdown', (e) => beginDrag(mode, e));
  });
  if (sizeSliderEl) sizeSliderEl.addEventListener('pointerdown', (e) => beginDrag('size-slider', e));

  document.addEventListener('pointermove', (e) => {
    if (!dragMode || !dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    const { rx, ry, rw, rh, screenW, screenH } = dragStart;

    if (dragMode === 'move') {
      applyRect(rx + dx, ry + dy, rw, rh, screenW, screenH);
      return;
    }

    if (dragMode === 'size-slider') {
      // 「スライダー」= ドラッグ量ではなくトラック上の絶対位置がそのまま値になる(2026年9月追加)。
      // 拡縮の基準点は対称/非対称トグルに関わらず常にガイドの中心(2026年9月修正、上記コメント参照)。
      const frac = fracFromTrack(dragStart.trackRect, e.clientY);
      const { min, max } = dragStart.sizeBounds;
      const longSide = min + frac * (max - min);
      const dims = dimsFromLongSide(longSide);
      const cx = rx + rw / 2, cy = ry + rh / 2;
      applyRect(cx - dims.w / 2, cy - dims.h / 2, dims.w, dims.h, screenW, screenH);
      if (sizeThumbEl) sizeThumbEl.style.top = `${(1 - frac) * 100}%`; // 自分のドラッグ中は逆算せず直接反映(軽量)
      return;
    }

    // 四隅ハンドル: 比率を無視した自由リサイズ。下辺トグルで対称(中心固定)/非対称(対角固定)を切り替える。
    let x, y, w, h;
    if (symmetric) {
      const signX = dragMode.includes('e') ? 1 : -1;
      const signY = dragMode.includes('s') ? 1 : -1;
      const extX = dx * signX, extY = dy * signY;
      const cx = rx + rw / 2, cy = ry + rh / 2;
      w = Math.max(MIN_ECLIPSE_SIZE, rw + 2 * extX);
      h = Math.max(MIN_ECLIPSE_SIZE, rh + 2 * extY);
      x = cx - w / 2;
      y = cy - h / 2;
    } else {
      x = rx; y = ry; w = rw; h = rh;
      if (dragMode.includes('e')) w = Math.max(MIN_ECLIPSE_SIZE, rw + dx);
      if (dragMode.includes('w')) { w = Math.max(MIN_ECLIPSE_SIZE, rw - dx); x = rx + (rw - w); }
      if (dragMode.includes('s')) h = Math.max(MIN_ECLIPSE_SIZE, rh + dy);
      if (dragMode.includes('n')) { h = Math.max(MIN_ECLIPSE_SIZE, rh - dy); y = ry + (rh - h); }
    }
    applyRect(x, y, w, h, screenW, screenH);
  });
  document.addEventListener('pointerup', () => {
    const wasHandleDrag = dragMode && dragMode !== 'move' && dragMode !== 'size-slider';
    dragMode = null;
    dragStart = null;
    if (wasHandleDrag) syncSizeSliderThumb(); // 四隅ハンドルでの自由リサイズ後、サイズスライダーのつまみを実際の大きさへ合わせ直す
  });
  document.addEventListener('pointercancel', () => { dragMode = null; dragStart = null; });

  // モードを抜けて戻ってきた時など、毎回ゼロから位置合わせできるよう非表示にリセットする。
  screenEl.__resetEclipseGuide = hide;
}

/* ---------------- ズームスライダー(2026年9月、Eclipseから分離) ----------------
 * 以前はEclipseガイドの右横に添える2本目のスライダーとして実装していたが、「ガイドを
 * 画面右へ寄せるとスライダー2本分の余白で窮屈になる」という指摘を受け、Eclipseの開閉状態に
 * 関わらず常時表示される独立コントロールへ切り出した(ユーザー指定)。トラック上の絶対位置が
 * そのまま値になる「本物のスライダー」という設計はwireEclipseGuide()のサイズスライダーと共通
 * (fracFromTrack()を共有)。見た目は宇宙船コックピットのスロットルレバー風にした(ユーザー指定、
 * css/camera.cssの.cam-zoom-slider参照)。画面右端の固定位置に常にあるため、Eclipse側のような
 * 画面内クランプは不要(自分自身は動かない)。 */
function wireCamZoomSlider(screenEl, videoEl, zoomBadgeEl) {
  const sliderEl = screenEl.querySelector('.cam-zoom-slider');
  if (!sliderEl) return;
  const trackEl = sliderEl.querySelector('.cam-zoom-slider-track');
  const thumbEl = sliderEl.querySelector('.cam-zoom-slider-thumb');
  if (!trackEl || !thumbEl) return;

  /** つまみ位置を、現在のcamZoomScaleから合わせ直す。ピンチズーム側(setCamZoom())からも
   *  呼べるよう、screenEl.__syncCamZoomSliderとして橋渡しする。 */
  function syncThumb() {
    const max = maxZoomForCurrentTrack();
    const frac = max > 1 ? Math.max(0, Math.min(1, (camZoomScale - 1) / (max - 1))) : 0;
    thumbEl.style.top = `${(1 - frac) * 100}%`;
  }
  screenEl.__syncCamZoomSlider = syncThumb;

  let dragStart = null;
  sliderEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); // Eclipse側のダブルタップ判定・背景のタップフォーカスへ伝播させない
    dragStart = { trackRect: trackEl.getBoundingClientRect() };
    try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const frac = fracFromTrack(dragStart.trackRect, e.clientY);
    const max = maxZoomForCurrentTrack();
    setCamZoom(1 + frac * (max - 1), videoEl, zoomBadgeEl); // setCamZoom()自体がネイティブ/デジタルズームを仕切ってくれる
    thumbEl.style.top = `${(1 - frac) * 100}%`; // 自分のドラッグ中は逆算せず直接反映(軽量)
  });
  document.addEventListener('pointerup', () => { dragStart = null; });
  document.addEventListener('pointercancel', () => { dragStart = null; });
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
  // ズームスライダーのつまみも追従させる(ピンチズーム・スライダー操作のどちらで変えても、
  // もう片方の表示にすぐ反映される)。スライダーを持たない画面では単に無害に無視される。
  if (camEls && camEls.photoScreen && camEls.photoScreen.__syncCamZoomSlider) camEls.photoScreen.__syncCamZoomSlider();
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
  disarmAutoShutter();
  clearTimeout(camOrientationFadeTimer);
  camOrientationFadeTimer = null;
  [camEls.videoPhoto, camEls.videoCaption, camEls.videoVideo].forEach((v) => { v.style.opacity = ''; });
  camEls.overlay.classList.remove('open');
  clearCameraError();
  // Eclipseは毎回まっさらな状態から位置合わせできるよう、カメラを閉じるたびに隠す。
  if (camEls.photoScreen && camEls.photoScreen.__resetEclipseGuide) camEls.photoScreen.__resetEclipseGuide();
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
