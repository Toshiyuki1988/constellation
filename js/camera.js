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
// 避けたい」というユーザー判断により同月中に撤去した。その後さらに同月、「誤操作の心配が
// 無いなら復活させたい」というユーザー要望を受け、常設ボタンではなく円形Eclipseガイドを
// 2本指で長押しした時だけ発動する隠しジェスチャーとして再実装した(下記wireEclipseGuide()
// 内のトーチ関連コード参照)。**
let camExposurePresets = null; // [{value,label}, ...] | null(非対応)
let camExposureIndex = 0;
let camWbPresets = null; // [{mode,temp?,label}, ...] | null(非対応)
let camWbIndex = 0;
let camTorchSupported = false; // caps.torch===trueの端末だけtrue(updateCamControlAvailability()参照)
let camTorchOn = false; // 現在トーチが点灯しているか(setTorch()参照)

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
  { key: 'F', ratio: 1.29, shape: 'rect', label: '人物型' },
  { key: 'P', ratio: 1.50, shape: 'rect', label: '風景型' },
  { key: 'M', ratio: 1.68, shape: 'rect', label: '海景型' },
  { key: 'S', ratio: 1.00, shape: 'rect', label: '正方形' },
  { key: 'C', ratio: 1.00, shape: 'circle', label: '円形' },
];

let camMediaRecorder = null;
let camRecordedChunks = [];
let camRecordTimerId = null;
let camRecordSeconds = 0;

let camWaveCtx = null;
let camWaveAnalyser = null;
let camWaveSource = null;
let camWaveRAF = null;

/**
 * @param {'photo'|'caption'|'video'|'audio'} initialMode
 * @param {{continuous?: boolean}} [opts] continuous: 'caption'モード限定。trueだと、範囲を
 *   選ばない1回目の読み取りも「続けて選択」の画面内フロー(サムネイル表示・カメラを閉じない)
 *   で扱う(2026年9月追加)。既定(false/省略)は従来通り、範囲を選ばなければ即座に閉じて
 *   画面右下のPiPで進捗を示す単発読み取りのまま。Almagestのように範囲選択OCRの繰り返しが
 *   前提のモジュールは、押した瞬間ごとに単発/連続の挙動が変わって分かりにくい(実機報告:
 *   「サムネに変化がない」→実際は範囲を選ばず単発扱いのPiP経路に入っていて、続けて選択の
 *   サムネ自体が生成されていなかった)ため、常にサムネイル付きの画面内フローへ固定する。
 */
function openCamera(initialMode, opts) {
  ensureCameraDom();
  bindCameraViewportSync();
  captionForceContinuous = Boolean(opts && opts.continuous);
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
    targetToggleBtnPhoto: document.getElementById('cam-target-toggle-btn-photo'),
    targetReticlePhoto: document.getElementById('cam-target-reticle-photo'),
    targetPanel: document.getElementById('cam-target-panel'),
    targetAvatar: document.getElementById('cam-target-avatar'),
    targetName: document.getElementById('cam-target-name'),
    targetText: document.getElementById('cam-target-text'),
    targetClose: document.getElementById('cam-target-close'),

    captionScreen: document.getElementById('camera-screen-caption'),
    videoCaption: document.getElementById('camera-video-caption'),
    captionHint: document.getElementById('caption-hint'),
    pageStrip: document.getElementById('caption-page-strip'),
    focusLayerCaption: document.getElementById('focus-layer-caption'),
    zoomBadgeCaption: document.getElementById('zoom-badge-caption'),
    capBtn: document.getElementById('camera-cap-btn'),
    uploadBtn: document.getElementById('caption-upload-btn'),
    uploadFile: document.getElementById('caption-upload-file'),
    freezeWrap: document.getElementById('caption-freeze-wrap'),
    selectLayer: document.getElementById('caption-select-layer'),
    selectRect: document.getElementById('caption-select-rect'),
    selectActions: document.getElementById('caption-select-actions'),
    selectRetakeBtn: document.getElementById('caption-select-retake'),
    selectRunBtn: document.getElementById('caption-select-run'),
    selectFinishBtn: document.getElementById('caption-select-finish'),
    selectCountEl: document.getElementById('caption-select-count'),
    selectProgressEl: document.getElementById('caption-select-progress'),
    selectProgressCancelBtn: document.getElementById('caption-select-progress-cancel'),
    selectThumbsEl: document.getElementById('caption-select-thumbs'),
    gridColsInput: document.getElementById('caption-grid-cols'),
    gridRowsInput: document.getElementById('caption-grid-rows'),
    selectAiBtn: document.getElementById('caption-select-ai'),
    aiRegionListEl: document.getElementById('caption-ai-region-list'),
    aiRunBtn: document.getElementById('caption-ai-run'),
    aiCancelBtn: document.getElementById('caption-ai-cancel'),

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
  camEls.uploadBtn.addEventListener('click', () => camEls.uploadFile.click());
  camEls.uploadFile.addEventListener('change', () => {
    // 複数選択(input[multiple]、2026年9月追加)にも対応。書籍の複数ページを一括で選べる。
    const files = Array.from(camEls.uploadFile.files || []);
    camEls.uploadFile.value = ''; // 同じファイルを続けて選び直せるようにする
    if (files.length) handleFilesForSelection(files);
  });
  wireCaptionDragDrop();
  wireScreenShareCapture();
  if (camEls.pageStrip) {
    camEls.pageStrip.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-page-index]');
      if (btn) switchCaptionPage(Number(btn.dataset.pageIndex));
    });
  }
  camEls.selectRetakeBtn.addEventListener('click', resetCaptionState);
  camEls.selectRunBtn.addEventListener('click', handleSelectionRun);
  camEls.selectFinishBtn.addEventListener('click', handleSelectionFinish);
  camEls.selectProgressCancelBtn.addEventListener('click', handleSelectionOcrCancel);
  wireSelectionLayer();
  // 「段組みで一括作成」モード(2026年9月、手動の範囲選択とは独立した並存機能。
  // 旧Gemini解析ボタンをローカル計算のgenerateGridRegions()へ全面置き換え済み)。
  camEls.selectAiBtn.addEventListener('click', handleCreateColumnGrid);
  camEls.aiRunBtn.addEventListener('click', handleAiRunAll);
  camEls.aiCancelBtn.addEventListener('click', exitAiMode);
  camEls.aiRegionListEl.addEventListener('click', (e) => {
    // 一覧先頭の「＋ 矩形を追加」行(2026年9月、旧#caption-ai-addボタンをここへ統合)。
    if (e.target.closest('[data-add-region]')) { addManualAiRegion(); return; }
    const row = e.target.closest('.cam-ai-region-row');
    if (!row) return;
    // 長押しドラッグで並べ替えた直後に発火するclickは、選択操作として扱わない。
    if (aiRegionDragSuppressClick) { aiRegionDragSuppressClick = false; return; }
    const id = row.dataset.regionId;
    const delBtn = e.target.closest('.cam-ai-region-row-del');
    if (delBtn) { removeAiRegion(id); return; }
    selectAiRegion(id);
  });
  wireAiRegionListDragReorder();

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
  wireTargetScope();

  // 写真モードのピンチズームは2026年9月に撤去した(誤タップ防止のユーザー方針)。円形Eclipse
  // ガイドの2本指長押しジェスチャー(トーチ点灯)と指の本数が競合するため、常時表示のズーム
  // スライダー(wireCamZoomSlider())が既にあることも踏まえて外した。キャプション/動画モードは
  // Eclipseを持たないため引き続きピンチズームを使える。
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
      // テクスト(OCR)画面はPCでの利用(カメラ非搭載)を主眼に、ドラッグ&ドロップ/
      // アップロードだけでも完結できるようにしてある(2026年9月、PC編集特化の要望)ため、
      // カメラ/マイクが無くても不安を煽る警告バーは出さない。前回セッションの残り
      // (続けて選択モードの状態)を初期化した上で、無カメラ向けの案内に上書きする。
      // それ以外のモード(写真・動画・音声、いずれも撮影自体にカメラ/マイクが必須)は
      // 従来通り警告バーで知らせる。
      if (mode === 'caption') {
        resetCaptionState();
        camEls.capBtn.hidden = true;
        camEls.captionHint.textContent = '画像をドラッグ&ドロップ、または📁アップロードで読み取れます';
      } else {
        showCameraError('カメラ/マイクを使用できませんでした。ブラウザの権限設定を確認してください');
      }
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
  camTorchSupported = false;
  camTorchOn = false; // 前のトラックが既に破棄されているはずなので、applyConstraints()は呼ばず状態だけ戻す
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

  camTorchSupported = caps.torch === true; // 常設ボタンは持たない(隠しジェスチャー専用)ため、ここでは対応可否を控えるだけ

  camDebugLog(`カメラ制御ボタン: 露出=${camExposurePresets ? 'あり' : 'なし'} / WB=${camWbPresets ? 'あり' : 'なし'} / トーチ=${camTorchSupported ? 'あり' : 'なし'}`);
}

function currentVideoTrack() {
  return camStream && camStream.getVideoTracks()[0];
}

/** トーチ(フラッシュ)を点灯/消灯する。円形Eclipseガイドの隠しジェスチャー専用
 *  (js/camera.jsのwireEclipseGuide()内トーチ関連コード参照)。非対応端末・トラック無しの
 *  場合はONにはできない(OFFは常に安全側として受け付ける)。 */
async function setTorch(on) {
  if (on && !camTorchSupported) return false;
  const track = currentVideoTrack();
  if (!track) { camTorchOn = false; return false; }
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    camTorchOn = on;
    return true;
  } catch (err) {
    camDebugLog(`トーチapplyConstraints失敗: ${err && err.message ? err.message : err}`);
    camTorchOn = false;
    return false;
  }
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
  // トーチを点けたままモードを切り替える/カメラを閉じる事故を防ぐ(誤って点灯させたままの
  // フラッシュ撮影を避けたいというユーザー方針、本ファイル上部の既存の注記を参照)。
  if (camTorchOn) setTorch(false);
  if (camEls && camEls.eclipseGuidePhoto) camEls.eclipseGuidePhoto.classList.remove('heating', 'torch-on');
  closeTargetScope(); // モードを抜ける/カメラを閉じるたび、照準・結果パネルも片付ける(2026年9月追加)
  stopScreenShare(); // 画面共有取り込み(テクストモード専用)も必ず止める
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
    // 選択モード中(静止フレームを見ている間)はタップフォーカスの対象外。
    // targetベースの判定(button/.cam-select-layerの子孫か)だけでは、選択レイヤーが
    // pointerdownでsetPointerCapture()している影響で、指がわずかにボタン外へずれた際に
    // ブラウザが合成するclickイベントのtargetがヒットテスト結果(下層のvideo等)にずれ、
    // 判定をすり抜けてピント合わせが誤発火する不具合があった(2026年9月、実機報告)。
    // 選択レイヤーが表示中かどうか自体で確実にガードする。
    if (camEls.selectLayer && camEls.selectLayer.classList.contains('show')) return;
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
  const RATIO_ROW_TOP_OVERHANG = 62; // プリセット名称ラベル(margin-bottom42+高さ約20)。チップ行自体(26+10)は内側に収まる
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
  const presetLabelEl = eclipseEl.querySelector('.cam-eclipse-preset-label');
  let presetLabelHideTimer = null;

  /** 比率プリセットの名称(人物型・風景型など)を一瞬だけガイド上部に出す(2026年9月追加)。 */
  function showPresetLabel(text) {
    if (!presetLabelEl) return;
    presetLabelEl.textContent = text;
    presetLabelEl.classList.add('visible');
    clearTimeout(presetLabelHideTimer);
    presetLabelHideTimer = setTimeout(() => presetLabelEl.classList.remove('visible'), 1400);
  }

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

  // sizeBoundsForRatio()が予約する左右・上下の余白(2026年9月追加)。ガイド本体がある程度
  // 大きい時、各付属要素のオーバーハング(eclipsePadLeft/Right/Top/Bottom参照)は
  // 「RATIO_ROW_HALF_WIDTH - w/2」等の項が負になって効かなくなり、実質この固定値だけに
  // 収束する。既定サイズ(画面いっぱいに近い大きめのサイズ)は必ずこの収束後の領域に入るため、
  // ここではその収束値をそのまま予約に使う(w/h依存の循環参照を避けるための単純化)。
  const SIZE_BOUNDS_PAD_LEFT = Math.max(HANDLE_OVERHANG, SIDE_BTNS_LEFT_OVERHANG);
  const SIZE_BOUNDS_PAD_RIGHT = Math.max(HANDLE_OVERHANG, SIZE_SLIDER_RIGHT_OVERHANG);
  const SIZE_BOUNDS_PAD_TOP = RATIO_ROW_TOP_OVERHANG;
  const SIZE_BOUNDS_PAD_BOTTOM = SYM_TOGGLE_BOTTOM_OVERHANG;

  /**
   * その比率・向きで矩形の長辺が取りうる範囲。**2026年9月修正**: 以前は画面の94%という
   * ガイド本体(w×h)だけの制約で計算しており、比率チップ行・サイズスライダー・回転/中央
   * リセットボタンなど本体からはみ出す付属要素の分を考慮していなかった。既定サイズを
   * 画面いっぱいに近い大きさに変更した際、この付属要素の見切れ(特に右横のサイズスライダー)
   * が実機で顕在化したため、付属要素の固定オーバーハング(SIZE_BOUNDS_PAD_*)をあらかじめ
   * 画面サイズから差し引いてから比率変換するようにした。
   */
  function sizeBoundsForRatio(ratio, portrait) {
    const rect = screenEl.getBoundingClientRect();
    // 2026年9月: 付属要素の余白を引いた直後の値ぴったりまで許すと、常時表示のズーム
    // スライダー(.cam-zoom-slider、画面右端固定)との近さも相まって窮屈に見える/わずかな
    // 誤差で見切れるとの実機報告があったため、0.97→0.88へ余裕を広げた。
    const availW = Math.max(MIN_ECLIPSE_SIZE, rect.width - SIZE_BOUNDS_PAD_LEFT - SIZE_BOUNDS_PAD_RIGHT) * 0.88;
    const availH = Math.max(MIN_ECLIPSE_SIZE, rect.height - SIZE_BOUNDS_PAD_TOP - SIZE_BOUNDS_PAD_BOTTOM) * 0.88;
    const maxByWidth = portrait ? availW * ratio : availW;
    const maxByHeight = portrait ? availH : availH * ratio;
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
    symmetric = true; // 2026年9月: 既定を対称リサイズに変更(ユーザー要望)
    turnOffTorchIfOn(); // 前回開いた時に点けっぱなしのままになっていないよう、毎回念のため
    applyShapeAndChips();
    if (symmetryBtn) { symmetryBtn.classList.add('active'); symmetryBtn.textContent = '対称'; }
    // 2026年9月: 既定の向きを横長→縦型に、既定サイズを大きめに変更(ユーザー要望)。
    // ただし上限(bounds.max)ぴったりまで広げると常時表示のズームスライダー(画面右端固定)に
    // 迫って窮屈に見える/わずかな計算誤差で見切れるとの実機報告があったため、上限の85%を
    // 既定値にして目に見える余白を残す(スライダーで100%まで広げるのはユーザーの任意)。
    const bounds = sizeBoundsForRatio(currentRatio(), true); // 毎回、縦型(portrait)の既定姿勢に戻す
    const rect = screenEl.getBoundingClientRect();
    const h = bounds.min + (bounds.max - bounds.min) * 0.85;
    const w = h / currentRatio();
    applyRect((rect.width - w) / 2, (rect.height - h) / 2, w, h, rect.width, rect.height);
    eclipseEl.classList.add('visible', 'appearing');
    setTimeout(() => eclipseEl.classList.remove('appearing'), 200);
    visible = true;
    if (toggleBtn) toggleBtn.classList.add('active');
    syncSizeSliderThumb();
    playEclipseOpen();
    // 2026年9月: 既定でカメラズームも最小(1倍、無ズーム)に戻す(ユーザー要望。
    // 一度「最大」で実装したが「最小の間違い」と訂正が入った)。
    setCamZoom(1, videoEl, zoomBadgeEl);
  }
  function hide() {
    eclipseEl.classList.remove('visible');
    visible = false;
    if (toggleBtn) toggleBtn.classList.remove('active');
    turnOffTorchIfOn(); // ガイドを閉じたまま点灯し続ける事故を防ぐ
  }
  function toggle() {
    if (visible) hide(); else showDefault();
  }

  /** 比率プリセットを切り替える。今の中心・今の長辺の長さ・今の向き(縦長/横長)をできるだけ
   *  保ったまま、新しい比率に合わせて短辺だけ引き直す。プリセットを変える操作そのものが
   *  トーチの安全弁を兼ねる(下記トーチ関連コードの説明を参照、ユーザー指定)。 */
  function applyPreset(index) {
    ratioIndex = index;
    turnOffTorchIfOn();
    applyShapeAndChips();
    showPresetLabel(CAM_ECLIPSE_RATIO_PRESETS[index].label);
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

  /* ---- 隠し機能: 円形ガイドを2本指で長押しするとトーチが点灯する(2026年9月追加、ユーザー指定) ----
   * 「誤って点けっぱなしにする心配」から一度撤去したトーチを、確実な誤操作防止つきで復活させた
   * もの。常設ボタンは持たず、**円形プリセット(currentShape()==='circle')を選んでいる間だけ**、
   * ガイドの円の内側を2本の指でTORCH_HOLD_MS(2秒)押さえ続けると発動する。長押し中はガイドが
   * じわじわオレンジに発光し(.heatingクラス、「熱する」演出)、しきい値に達するとトーチが
   * トグルし、点灯中は.torch-onクラスで発光が定常化する。指を離す/2本以外になる/長辺プリセット
   * を切り替えるといった操作でいつでも安全にキャンセル・消灯できる(applyPreset()内の
   * turnOffTorchIfOn()呼び出しを参照)。 */
  const TORCH_HOLD_MS = 2000;
  const torchPointerIds = new Set();
  let torchHoldTimer = null;

  function cancelTorchHold() {
    clearTimeout(torchHoldTimer);
    torchHoldTimer = null;
    eclipseEl.classList.remove('heating');
  }

  /** ガイド表示の切り替え・プリセット変更・カメラのモード切替など、安全のためトーチを
   *  必ず消すべきタイミングで呼ぶ(showDefault()/hide()/applyPreset()から呼ぶ)。 */
  function turnOffTorchIfOn() {
    torchPointerIds.clear();
    cancelTorchHold();
    eclipseEl.classList.remove('torch-on');
    if (camTorchOn) setTorch(false);
  }

  /** 指の座標(clientX/Y)がガイドの円の内側にあるか(矩形の内接円で判定)。 */
  function isPointInEclipseCircle(clientX, clientY) {
    const r = eclipseEl.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const radius = Math.min(r.width, r.height) / 2;
    const dx = clientX - cx, dy = clientY - cy;
    return dx * dx + dy * dy <= radius * radius;
  }

  // キャプチャフェーズで先取りする: ガイド本体(.cam-eclipse-body)の既存のドラッグ開始処理
  // より先に、2本目の指が乗った瞬間を検知して進行中の移動ドラッグを打ち切り、ガイドの位置を
  // その場に固定する(そうしないと2本目の指のpointerdownがbeginDrag('move')を再度呼び、
  // ドラッグが暴れてしまう)。
  eclipseEl.addEventListener('pointerdown', (e) => {
    if (!visible || currentShape() !== 'circle') return;
    if (!e.target.closest('.cam-eclipse-body')) return; // 回転/中央リセット等の他ボタンは対象外
    if (!isPointInEclipseCircle(e.clientX, e.clientY)) return;
    torchPointerIds.add(e.pointerId);
    if (torchPointerIds.size === 2) {
      dragMode = null; // 1本目の指で始まっていたかもしれない移動ドラッグをここで打ち切る
      dragStart = null;
      e.stopPropagation(); // 2本目の指ぶんのbeginDrag('move')が別途走らないようにする
      eclipseEl.classList.add('heating');
      torchHoldTimer = setTimeout(() => {
        torchHoldTimer = null;
        eclipseEl.classList.remove('heating');
        setTorch(!camTorchOn).then(() => {
          eclipseEl.classList.toggle('torch-on', camTorchOn);
        });
      }, TORCH_HOLD_MS);
    } else if (torchPointerIds.size > 2) {
      cancelTorchHold(); // 3本目以降が乗ったら誤操作とみなして取り消す
    }
  }, true);
  function onTorchPointerEnd(e) {
    torchPointerIds.delete(e.pointerId);
    if (torchPointerIds.size < 2) cancelTorchHold();
  }
  eclipseEl.addEventListener('pointerup', onTorchPointerEnd, true);
  eclipseEl.addEventListener('pointercancel', onTorchPointerEnd, true);

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

const CANVAS_TO_BLOB_TIMEOUT_MS = 10000;

/**
 * canvas.toBlob()には元々タイムアウトの保険が無かった(2026年9月、実機報告を受けて追加)。
 * 「範囲選択OCRを7〜8回連続で行うとスキャン確定ボタンが反応しなくなる」という報告を調査した
 * 結果、canvas.toBlob()のコールバックはブラウザ側のメモリ圧迫等で**永久に呼ばれないことが
 * ある**(エラーにもならず、Promiseが解決も拒否もされないまま止まる)ことが分かった。これに
 * よりhandleSelectionRun()のawaitが永遠に止まり、その間trueにしていたcaptionRunGuardActive/
 * captionOcrBusyが二度とfalseに戻らず、以降のタップが早期returnで無反応になっていたと考え
 * られる。タイムアウトで確実にreject()し、呼び出し元の既存のcatchへ必ず処理を戻すようにした。
 */
function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('画像の生成がタイムアウトしました(メモリ不足の可能性があります)'));
    }, CANVAS_TO_BLOB_TIMEOUT_MS);
    canvas.toBlob((blob) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      blob ? resolve(blob) : reject(new Error('画像の生成に失敗しました'));
    }, 'image/jpeg', quality);
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
    // 解説カラムが表示中(=Professorの鑑定結果が出ている)状態で撮影した場合、その解説文を
    // 写真カードのキャプションとして付属させる(2026年9月追加、ユーザー要望)。
    finishCamera({ kind: 'photo', blob, caption: targetCurrentResultText });
  } catch (err) {
    console.error(err);
    showCameraError('撮影に失敗しました');
    camEls.shutterPhoto.disabled = false;
  }
}

/* ---------------- ターゲッティングスコープ(2026年9月、ライブコメント機能を刷新) ----------------
 * 「美術版ジャーヴィスUI」というユーザー構想。十字の照準を指でドラッグして対象物の上へ載せ
 * (動かしている間は「ピッ」)、動かさずに再タップすると(「ピコッ」)、Professorが呼ばれ、
 * 照準を中心にクロップしたフレームを見て、建築様式・文様の意匠・衣服のスタイルなど対象の
 * 種類に応じた美術的要素を解説する。無料枠(1日250)を消費するため自動化はせず、必ず
 * 明示的な再タップでの手動トリガーのみ。ペルソナは常にProfessor固定(座談会のような
 * 参加者選択は行わない、js/app.jsのfetchArtTargetAnalysis()参照)。
 * 解説カラムは自動で消えず✕ボタンでのみ閉じる(2026年9月変更)。解説が表示されている間に
 * 撮影すると、その解説文が写真カードのキャプションとして付属する(2026年9月追加)。 */
const TARGET_TAP_MOVE_TOLERANCE_PX = 6; // Crews Constellationの写真カード(クリックorドラッグ判定)と同じ閾値
const TARGET_MOVE_TICK_DISTANCE_PX = 26; // 「ピッ」を間引く距離(Star Pencilの描画tickと同じ考え方)
const TARGET_RETICLE_HALF = 38; // .cam-target-reticleの半径(76pxの半分)、画面内クランプに使う

let targetScopeOpen = false;
let targetDrag = null; // {pointerId, startClientX, startClientY, startLeft, startTop, moved, lastTickX, lastTickY}
let targetResultHideTimer = null;
let targetRequestInFlight = false;
// 解説カラムが表示中(かつ有効な結果を持つ)場合だけ非nullになる。撮影(capturePhoto())の
// 瞬間にこれが立っていれば、その解説文を写真カードのキャプションとして付属させる
// (2026年9月追加、ユーザー要望: 「解説が出た状態で撮影すると写真にキャプション付属」)。
let targetCurrentResultText = null;

function openTargetScope() {
  if (!camEls.targetReticlePhoto || !camStream) return;
  const rect = camEls.photoScreen.getBoundingClientRect();
  camEls.targetReticlePhoto.style.left = `${rect.width / 2}px`;
  camEls.targetReticlePhoto.style.top = `${rect.height / 2}px`;
  camEls.targetReticlePhoto.classList.add('show');
  if (camEls.targetToggleBtnPhoto) camEls.targetToggleBtnPhoto.classList.add('active');
  targetScopeOpen = true;
}

function closeTargetScope() {
  targetScopeOpen = false;
  targetDrag = null;
  if (camEls && camEls.targetReticlePhoto) camEls.targetReticlePhoto.classList.remove('show', 'locking');
  if (camEls && camEls.targetToggleBtnPhoto) camEls.targetToggleBtnPhoto.classList.remove('active');
  hideTargetPanel();
}

function toggleTargetScope() {
  if (targetScopeOpen) closeTargetScope(); else openTargetScope();
}

function showTargetThinking() {
  if (!camEls.targetPanel) return;
  camEls.targetAvatar.textContent = '🎓';
  camEls.targetName.textContent = 'Professor';
  camEls.targetText.textContent = '鑑定中…';
  camEls.targetPanel.classList.add('show', 'thinking');
  targetCurrentResultText = null;
  clearTimeout(targetResultHideTimer);
}

// 2026年9月変更: 数秒での自動消滅をやめ、✕ボタン(hideTargetPanel)でのみ閉じるようにした
// (ユーザー要望: 読み切る前に消えてしまうため)。表示中はtargetCurrentResultTextを保持し、
// この間に撮影されれば写真カードのキャプションとして付属させる。
function showTargetResult(text) {
  if (!camEls.targetPanel) return;
  camEls.targetText.textContent = text;
  camEls.targetPanel.classList.remove('thinking');
  camEls.targetPanel.classList.add('show');
  if (typeof playChatReplySound === 'function') playChatReplySound(); // 座談会の自動返信と同じ「シュコッ」
  clearTimeout(targetResultHideTimer);
  targetCurrentResultText = (text || '').trim() || null;
}

function showTargetError(message) {
  if (!camEls.targetPanel) return;
  camEls.targetAvatar.textContent = '⚠';
  camEls.targetName.textContent = '';
  camEls.targetText.textContent = message;
  camEls.targetPanel.classList.remove('thinking');
  camEls.targetPanel.classList.add('show');
  targetCurrentResultText = null;
  clearTimeout(targetResultHideTimer);
  targetResultHideTimer = setTimeout(hideTargetPanel, 6000);
}

function hideTargetPanel() {
  clearTimeout(targetResultHideTimer);
  targetCurrentResultText = null;
  if (camEls && camEls.targetPanel) camEls.targetPanel.classList.remove('show', 'thinking');
}

/**
 * 照準の画面位置(cam-screen基準のCSSピクセル)を中心に、映像ソース側の一部だけを切り出した
 * canvasを作る。captureFrameToCanvas()と同じcover基準のクロップ(computeCoverCropRect())を
 * まず求め、そこからさらに照準位置を中心にした正方形の領域だけを狭めて取り出す(対象へ寄った
 * 構図にすることで、文様や建築の細部をGeminiが判別しやすくする)。
 */
function captureTargetedFrameToCanvas(videoEl, screenEl, targetX, targetY, maxEdge) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) throw new Error('カメラ映像の準備ができていません');
  const rect = screenEl.getBoundingClientRect();
  const cover = (rect.width > 0 && rect.height > 0)
    ? computeCoverCropRect(rect.width, rect.height, vw, vh)
    : { sx: 0, sy: 0, sw: vw, sh: vh };

  const fx = Math.max(0, Math.min(1, targetX / rect.width));
  const fy = Math.max(0, Math.min(1, targetY / rect.height));
  const centerX = cover.sx + fx * cover.sw;
  const centerY = cover.sy + fy * cover.sh;

  // 照準を中心に、ソース側の短辺の45%を一辺とする正方形を切り出す。
  const size = Math.min(cover.sw, cover.sh) * 0.45;
  let sx = centerX - size / 2;
  let sy = centerY - size / 2;
  sx = Math.max(cover.sx, Math.min(sx, cover.sx + cover.sw - size));
  sy = Math.max(cover.sy, Math.min(sy, cover.sy + cover.sh - size));

  let w = size;
  let h = size;
  if (w > maxEdge) { h *= maxEdge / w; w = maxEdge; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
  canvas.getContext('2d').drawImage(videoEl, sx, sy, size, size, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function handleTargetTrigger(targetX, targetY) {
  if (targetRequestInFlight) return;
  if (typeof window.fetchArtTargetAnalysis !== 'function') {
    showTargetError('鑑定機能の準備ができていません');
    return;
  }
  playTargetLock();
  const reticle = camEls.targetReticlePhoto;
  reticle.classList.remove('locking');
  void reticle.offsetWidth; // 毎回確実にアニメーションを再生させるための強制リフロー
  reticle.classList.add('locking');
  targetRequestInFlight = true;
  showTargetThinking();
  try {
    const canvas = captureTargetedFrameToCanvas(camEls.videoPhoto, camEls.photoScreen, targetX, targetY, 900);
    const blob = await canvasToBlob(canvas, 0.85);
    const base64 = await blobToBase64(blob);
    const text = await window.fetchArtTargetAnalysis(base64, 'image/jpeg');
    showTargetResult(text || '(判別できませんでした)');
  } catch (err) {
    console.error(err);
    camDebugLog(`ターゲッティングスコープ失敗: ${err && err.message ? err.message : err}`);
    showTargetError(`鑑定に失敗しました: ${err && err.message ? err.message : err}`);
  } finally {
    targetRequestInFlight = false;
  }
}

/** 十字照準のドラッグ(移動 or タップ判定)・トグルボタン・結果パネルの配線をまとめて行う。
 *  ドラッグ判定はEclipse同様、pointerdown起点からの移動距離で「動かした」か「タップだけ」かを
 *  判定する(TARGET_TAP_MOVE_TOLERANCE_PX)。動かしていなければ再タップとみなし鑑定を呼ぶ。 */
function wireTargetScope() {
  if (!camEls.targetToggleBtnPhoto || !camEls.targetReticlePhoto) return;
  camEls.targetToggleBtnPhoto.addEventListener('click', toggleTargetScope);
  if (camEls.targetClose) camEls.targetClose.addEventListener('click', hideTargetPanel);
  if (camEls.targetPanel) camEls.targetPanel.addEventListener('pointerdown', (e) => e.stopPropagation());

  const reticle = camEls.targetReticlePhoto;
  // click(pointerdown+pointerupから合成されるイベント)がphotoScreenまでバブリングすると
  // wireTapFocus()のタップフォーカスも同時に発火してしまうため、ここで止める。
  reticle.addEventListener('click', (e) => e.stopPropagation());
  reticle.addEventListener('pointerdown', (e) => {
    if (!targetScopeOpen) return;
    e.stopPropagation();
    const left = parseFloat(reticle.style.left) || 0;
    const top = parseFloat(reticle.style.top) || 0;
    targetDrag = {
      pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      startLeft: left, startTop: top,
      moved: false,
      lastTickX: left, lastTickY: top,
    };
    try { reticle.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
  });
  reticle.addEventListener('pointermove', (e) => {
    if (!targetDrag || e.pointerId !== targetDrag.pointerId) return;
    const dx = e.clientX - targetDrag.startClientX;
    const dy = e.clientY - targetDrag.startClientY;
    if (!targetDrag.moved && Math.hypot(dx, dy) > TARGET_TAP_MOVE_TOLERANCE_PX) targetDrag.moved = true;
    if (!targetDrag.moved) return;
    const rect = camEls.photoScreen.getBoundingClientRect();
    let left = targetDrag.startLeft + dx;
    let top = targetDrag.startTop + dy;
    left = Math.max(TARGET_RETICLE_HALF, Math.min(rect.width - TARGET_RETICLE_HALF, left));
    top = Math.max(TARGET_RETICLE_HALF, Math.min(rect.height - TARGET_RETICLE_HALF, top));
    reticle.style.left = `${left}px`;
    reticle.style.top = `${top}px`;
    if (Math.hypot(left - targetDrag.lastTickX, top - targetDrag.lastTickY) >= TARGET_MOVE_TICK_DISTANCE_PX) {
      targetDrag.lastTickX = left;
      targetDrag.lastTickY = top;
      playTargetMoveTick();
    }
  });
  const endDrag = (e) => {
    if (!targetDrag || e.pointerId !== targetDrag.pointerId) return;
    const wasMoved = targetDrag.moved;
    const left = parseFloat(reticle.style.left) || 0;
    const top = parseFloat(reticle.style.top) || 0;
    targetDrag = null;
    if (!wasMoved) handleTargetTrigger(left, top);
  };
  reticle.addEventListener('pointerup', endDrag);
  reticle.addEventListener('pointercancel', endDrag);
}

/* ---------------- テクストモード(キャプションだけをその場で読み取る) ----------------
   読み取りに使った写真そのものはカードに残さない(OCR用の使い捨て)。
   読み取れたテキストだけをテクストカードとして返す。
   撮影すると即OCRするのではなく、一度静止フレームを見せて「読み取りたい範囲」を
   指でなぞって選べるようにする(2026年9月追加)。選ばなければ全体を送る、従来通りの挙動。
   これは長いキャプション文の中から一部だけ拾いたい/余計な文字を除きたい場合のため。 */

let captionFreezeCanvas = null; // 撮影直後の静止フレーム(選択モード中だけ保持)
let captionSelection = null; // 選択レイヤー内のCSSピクセル座標 {x, y, w, h}。null = 未選択(全体)
// openCamera('caption', {continuous:true})で呼ばれた場合にtrue(2026年9月追加)。retake
// (resetCaptionState())を挟んでも同じopenCamera()セッション中は維持したいため、
// resetCaptionState()ではリセットしない(teardownCamera()でセッション終了時にのみ戻す)。
let captionForceContinuous = false;
let selectPointerActive = false;
let selectPointerId = null;
let selectStartX = 0;
let selectStartY = 0;
// 直前のジェスチャー終了時点で有効だった選択(浮動ボタン表示中)の退避先(2026年9月追加)。
// 「浮動ボタンへの精密なタップに頼らず、フリーズ画像上のどこでも軽くタップすれば直前の
// 選択を確定できる」というフォールバックのために使う(下記wireSelectionLayer()参照)。
// 判定は移動量のしきい値ではなく、「今回のジェスチャー自体が有効な矩形(8px角以上)を
// 作れたかどうか」(=既存のcaptionSelectionの真偽)で行う。当初は移動量20px以下を
// 「タップ」とみなす方式だったが、これだと新しく小さい範囲(1行だけ等)をドラッグで
// 選び直そうとした時に、対角線の移動量がしきい値を下回るケースで誤ってタップ扱いされ、
// 「特定の方向・大きさでしか新しい範囲を引けない」という実機報告に繋がったため撤回した。
let selectPendingConfirmSelection = null;
// 「続けて選択」モード(2026年9月追加、下記handleSelectionRun()参照): 書籍のような複数段組みの
// ページを段ごとに範囲選択→読み取りを繰り返すための、同じ静止フレーム上での連続OCR。
// 一度でも範囲選択でOCRを実行すると、このバッファへ結果を積みながらカメラを開いたままにし、
// 「✓ 読み取りを終える」を押すまで次々と範囲を選び直せる。
let captionOcrBuffer = [];
let captionOcrBusy = false;
// enterSelectionMode()が呼ばれるたびに増やす世代カウンタ。「続けて選択」モード中のOCR結果
// (非同期)が、撮り直し・カメラを閉じる等で既に無効になった古いセッションのものであれば
// captionOcrBufferへ書き戻さないようにするための踏み分け(2026年9月追加)。
let captionSelectionGen = 0;
// 続けて選択モードの範囲サムネイル一覧(2026年9月追加、下記renderCaptionThumbs()参照)。
// {url, status: 'pending'|'done'|'empty'|'failed'|'cancelled'}[]。captionOcrBufferとは別に
// 持つ(失敗・空振りもここには残して見た目で分かるようにするが、最終的なテキスト結合の対象には
// しないため)。
let captionThumbs = [];
// 複数ページ取り込み(2026年9月追加、PCでの編集作業向け): 書籍・雑誌の複数ページ画像を
// 一度にドラッグ&ドロップ/複数選択アップロードできるようにし、続けて選択モードを終えずに
// ページを切り替えながら範囲選択OCRを続けられるようにする。{canvas, thumbUrl}[]。
// captionThumbs(読み取った「範囲」の履歴)とは別の概念(こちらは「ページ」そのもの)。
let captionPages = [];
let captionPageIndex = -1;

/* ---------------- 「段組みで一括作成」モード(2026年9月、Gemini解析(旧AI解析)から全面置き換え) ----------------
 * 手動の範囲選択(captionSelection、上記)とは独立した並存機能。当初はGeminiに1回問い合わせて
 * 矩形+読み順を自動検出していたが、「無駄な解析が多すぎる」というユーザー判断により、
 * 列数×段数を指定してその場で格子状に均等割りするローカル計算(generateGridRegions())へ
 * 全面置き換えた。
 * 「現在の手動OCRを維持したまま」というユーザー指示により、上記の単一選択の状態
 * (captionSelection/camEls.selectRect)には一切触れない別の状態として持つ。
 * aiRegions各要素の x/y/w/h は captionSelection と同じ座標系(camEls.selectLayer/
 * camEls.freezeWrapのCSSピクセル、letterbox込み)で持つ。これによりcropCanvasToBlob()を
 * そのまま流用でき、新しい切り出しロジックを増やさずに済む。変数名(ai*)は当時の名残。 */
let aiMode = false; // このモードで矩形を表示・編集中か
let aiRegions = []; // [{id, x, y, w, h, order, status}]
let aiRegionSelectedId = null;
let aiRegionSeq = 0;

function resetCaptionState() {
  camEls.capBtn.hidden = false;
  camEls.capBtn.disabled = false;
  camEls.uploadBtn.hidden = false;
  camEls.uploadBtn.disabled = false;
  camEls.captionHint.textContent = '画面にキャプションを収めてタップ';
  captionFreezeCanvas = null;
  captionSelection = null;
  captionOcrBuffer = [];
  captionOcrBusy = false;
  captionInlineController = null;
  captionRunGuardActive = false;
  captionSelectionGen++;
  clearCaptionThumbs();
  captionPages = [];
  captionPageIndex = -1;
  renderCaptionPageStrip();
  camEls.freezeWrap.classList.remove('show');
  camEls.freezeWrap.innerHTML = '';
  camEls.selectLayer.classList.remove('show');
  camEls.selectRect.hidden = true;
  camEls.selectRect.classList.remove('scanning');
  camEls.selectActions.classList.remove('show');
  camEls.selectRunBtn.disabled = false;
  camEls.selectRetakeBtn.disabled = false;
  camEls.selectFinishBtn.hidden = true;
  camEls.selectCountEl.hidden = true;
  camEls.selectProgressEl.hidden = true;
  resetAiRegionState();
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

/**
 * 「📁 アップロード」(2026年9月追加): カメラで撮る代わりに、既に端末にある画像ファイルから
 * OCRしたい場合の入口。アプリ全体で使われるopenCamera('caption')の入り口はこの1画面
 * (#camera-screen-caption)だけなので、ここを拡張するだけで呼び出し元(テクストツール・
 * セッション名OCR・Crews・Almagest等)全てに自動的に行き渡る。選んだ画像は撮影時と全く同じ
 * enterSelectionMode()へ合流するため、自由範囲選択も同様に使える。
 * **2026年9月さらに拡張**: 複数ファイルを一度に選択/ドロップできるようにした(書籍・雑誌の
 * 複数ページを一括で取り込みたい、というPCでの編集作業向けの要望)。既に続けて選択セッション中
 * (freeze-wrapが表示中)なら追加ページとして末尾に積み増し、新規なら1ページ目として開始する。
 * どちらの場合も、新しく増えたページのうち最初の1枚へ即座に切り替える。
 */
async function handleFilesForSelection(files) {
  if (!files.length) return;
  camEls.uploadBtn.disabled = true;
  try {
    const canvases = [];
    for (const file of files) {
      try {
        // アップロードされたファイル(特にスクリーンショット)は、カメラのライブ映像と違って
        // 元々デジタルにシャープなことが多く、撮影時の2400pxという上限に縛られる理由が無い。
        // 書籍ページのような小さい密な文字を潰さないよう、写真撮影(capturePhoto())と同じ
        // 3840pxまで許容する。
        canvases.push(await loadImageFileToCanvas(file, 3840));
      } catch (err) {
        console.error(err);
      }
    }
    if (!canvases.length) {
      showCameraError('画像の読み込みに失敗しました');
      return;
    }
    addCanvasesAsCaptionPages(canvases);
  } finally {
    camEls.uploadBtn.disabled = false;
  }
}

/** canvas群を複数ページとして取り込む(ファイル取り込み・画面共有取り込みの共通処理)。
 *  既に続けて選択セッション中なら末尾に積み増し、新規なら1ページ目として開始する。 */
function addCanvasesAsCaptionPages(canvases) {
  const wasInSession = camEls.freezeWrap.classList.contains('show');
  const newFirstIndex = wasInSession ? captionPages.length : 0;
  if (!wasInSession) {
    captionPages = [];
    beginCaptionSelectionUi();
  }
  captionPages.push(...canvases.map((canvas) => ({ canvas, thumbUrl: canvasThumbDataUrl(canvas) })));
  switchCaptionPage(newFirstIndex);
  if (wasInSession && typeof setStatus === 'function') {
    setStatus(`${canvases.length}ページ追加しました(全${captionPages.length}ページ)`);
  }
}

/* ---------------- 画面共有からの取り込み(PC版Chrome向け、2026年9月・試験実装) ----------------
 * Kindle for PC等のウィンドウをgetDisplayMedia()で共有し、「📸 取り込む」を押した瞬間の
 * フレームを1ページとしてaddCanvasesAsCaptionPages()へ渡す。以降の範囲選択→OCRは
 * ファイル取り込みと全く同じ。取り込み自体は端末内の処理のみで、Geminiは呼ばない。
 * iOS Safari等getDisplayMedia非対応の環境ではボタン自体を出さない。
 * DRMでキャプチャが黒塗りになるアプリがあるか確かめるための試験実装で、うまくいかなければ
 * このブロックと index.html / css/camera.css の対応箇所ごと削除する。 */
let screenShareStream = null;
let screenShareEls = null;

function isScreenShareSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function wireScreenShareCapture() {
  const btn = document.getElementById('caption-screen-btn');
  const panel = document.getElementById('caption-screenshare-panel');
  if (!btn || !panel) return;
  screenShareEls = {
    btn,
    panel,
    video: document.getElementById('caption-screenshare-video'),
    grabBtn: document.getElementById('caption-screenshare-grab'),
    stopBtn: document.getElementById('caption-screenshare-stop'),
  };
  btn.hidden = !isScreenShareSupported();
  btn.addEventListener('click', startScreenShare);
  screenShareEls.grabBtn.addEventListener('click', grabScreenShareFrame);
  screenShareEls.stopBtn.addEventListener('click', stopScreenShare);
}

async function startScreenShare() {
  if (screenShareStream || !isScreenShareSupported()) return;
  try {
    screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    // ユーザーが共有ダイアログをキャンセルした場合もここに来る(NotAllowedError)。黙って戻る。
    console.warn('画面共有を開始できませんでした', err);
    screenShareStream = null;
    return;
  }
  const track = screenShareStream.getVideoTracks()[0];
  // Chrome側の「共有を停止」バーから止められた場合も片付ける
  if (track) track.addEventListener('ended', stopScreenShare);
  screenShareEls.video.srcObject = screenShareStream;
  screenShareEls.video.play().catch(() => {});
  screenShareEls.panel.hidden = false;
  screenShareEls.btn.hidden = true;
  camDebugLog(`screenshare start: ${track ? JSON.stringify(track.getSettings()) : 'no track'}`);
}

function stopScreenShare() {
  if (screenShareStream) {
    screenShareStream.getTracks().forEach((t) => t.stop());
    screenShareStream = null;
  }
  if (!screenShareEls) return;
  screenShareEls.video.srcObject = null;
  screenShareEls.panel.hidden = true;
  screenShareEls.btn.hidden = !isScreenShareSupported();
}

function grabScreenShareFrame() {
  const video = screenShareEls && screenShareEls.video;
  if (!screenShareStream || !video || !video.videoWidth) {
    if (typeof setStatus === 'function') setStatus('画面の映像がまだ届いていません。少し待ってからもう一度押してください');
    return;
  }
  // スクリーンショットと同じく元々シャープな画像のため、ファイル取り込みと同じ3840pxまで許容する
  const scale = Math.min(1, 3840 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  playShutter();
  const dark = isCanvasNearlyBlack(canvas);
  camDebugLog(`screenshare grab: ${canvas.width}x${canvas.height} nearlyBlack=${dark}`);
  addCanvasesAsCaptionPages([canvas]);
  if (dark && typeof setStatus === 'function') {
    setStatus('取り込んだ画面がほぼ真っ黒です。共有先のアプリが画面キャプチャを禁止している可能性があります');
  }
}

/** DRMによる黒塗りを検知するための簡易判定(32x32に縮小して平均輝度を見るだけ)。 */
function isCanvasNearlyBlack(canvas) {
  try {
    const s = document.createElement('canvas');
    s.width = 32; s.height = 32;
    const ctx = s.getContext('2d');
    ctx.drawImage(canvas, 0, 0, 32, 32);
    const d = ctx.getImageData(0, 0, 32, 32).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (32 * 32 * 3) < 8;
  } catch (err) {
    return false;
  }
}

/** 「📁 アップロード」ボタンの他に、画面へ直接ドラッグ&ドロップでも画像ファイルを渡せる
 *  ようにする(2026年9月追加、PCでの使い勝手向上)。複数ファイルを一度にドロップした場合は
 *  全て複数ページとして取り込む(2026年9月さらに拡張)。画像以外のドロップは無視する。 */
function wireCaptionDragDrop() {
  const screenEl = camEls.captionScreen;
  let dragDepth = 0; // dragenter/dragleaveは子要素の出入りでも発火するため、深さで数える
  screenEl.addEventListener('dragover', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  screenEl.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    screenEl.classList.add('cam-caption-dragover');
  });
  screenEl.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) screenEl.classList.remove('cam-caption-dragover');
  });
  screenEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    screenEl.classList.remove('cam-caption-dragover');
    const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
    if (files.length) handleFilesForSelection(files);
  });
}

/** 画像ファイルを、長辺maxEdge以下に縮小したcanvasへ読み込む(captureFrameToCanvas()の
 *  ファイル版。カメラ映像ではなくImage要素から描画する点だけが違う)。 */
function loadImageFileToCanvas(file, maxEdge) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = objectUrl;
  });
}

/** 静止フレーム1枚(カメラ撮影)で新規セッションを開始する、従来からの入口。
 *  複数ページ(handleFilesForSelection())と実装を共有するため、captionPagesへ
 *  1件だけ積んで同じ経路(switchCaptionPage())へ合流させる。 */
function enterSelectionMode(canvas) {
  captionPages = [{ canvas, thumbUrl: canvasThumbDataUrl(canvas) }];
  beginCaptionSelectionUi();
  switchCaptionPage(0);
}

/** 続けて選択モードのUI(選択レイヤー・アクションボタン等)を初回だけ整える。ページの
 *  表示自体はswitchCaptionPage()が担う(2026年9月、複数ページ対応で分離)。 */
function beginCaptionSelectionUi() {
  camEls.freezeWrap.classList.add('show');
  camEls.selectLayer.classList.add('show');
  camEls.selectActions.classList.add('show');
  camEls.capBtn.hidden = true;
  camEls.uploadBtn.hidden = true;
  camEls.captionHint.textContent = '文字の範囲を指でなぞって選択(そのままなら全体を読み取ります)';
}

/** ページを切り替える(ページストリップのタップ、または新規ページ追加時に呼ぶ、2026年9月追加)。
 *  選択矩形はページごとに独立させず単純化し、切り替えるたびにリセットする。読み取り済み
 *  バッファ(captionOcrBuffer)・サムネイル一覧・continuousセッション自体は維持する(=複数
 *  ページをまたいでも「1回の取り込み」として扱う、書籍の複数ページを段組みごと読み取っていく
 *  運用を想定)。 */
function switchCaptionPage(index) {
  if (index < 0 || index >= captionPages.length) return;
  captionPageIndex = index;
  captionFreezeCanvas = captionPages[index].canvas;
  camEls.freezeWrap.innerHTML = '';
  camEls.freezeWrap.appendChild(captionFreezeCanvas);
  captionSelection = null;
  camEls.selectRect.hidden = true;
  camEls.selectRect.classList.remove('scanning');
  updateSelectRunLabel();
  renderCaptionPageStrip();
  // captionSelectionGen(gen)は「撮り直し等でセッション自体が無効になった」ことを示す既存の
  // 仕組みで、ページ切り替えでは意図的にインクリメントしない(続けて選択モードは複数ページを
  // またいでcaptionOcrBuffer/captionThumbsを維持する設計のため、既存のコメント参照)。
  // AI解析結果(aiRegions)だけはページごとにレイアウトが異なるため、ここで個別に破棄する。
  exitAiMode();
}

/** ページストリップ(複数ページ取り込み時だけ現れる横一列のサムネイル)を描き直す。
 *  1ページしか無い間は表示しない(従来の単一ページ運用と見た目を変えないため)。 */
function renderCaptionPageStrip() {
  if (!camEls.pageStrip) return;
  const show = captionPages.length > 1;
  camEls.pageStrip.classList.toggle('show', show);
  if (!show) { camEls.pageStrip.innerHTML = ''; return; }
  camEls.pageStrip.innerHTML = captionPages
    .map((p, i) => (
      `<button type="button" class="cam-page-chip${i === captionPageIndex ? ' active' : ''}" ` +
      `data-page-index="${i}" title="${i + 1}ページ目へ切り替え">` +
      `<img src="${p.thumbUrl}" alt=""><span class="cam-page-chip-num">${i + 1}</span></button>`
    ))
    .join('');
}

/** ページストリップ用の小さいサムネイルを生成する(captionThumbsの範囲サムネイルとは別、
 *  ページ全体の縮小プレビュー)。 */
function canvasThumbDataUrl(canvas, maxEdge = 120) {
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * scale));
  out.height = Math.max(1, Math.round(canvas.height * scale));
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.7);
}

function updateSelectRunLabel() {
  // 一度でも範囲選択でOCRを実行した後(続けて選択モード中)は、ボタンが「終了」ではなく
  // 「追加」であることが伝わるよう文言を変える(2026年9月追加)。
  if (captionOcrBuffer.length > 0) {
    camEls.selectRunBtn.textContent = captionSelection ? '＋ この範囲を追加' : '＋ 全体を追加';
  } else {
    camEls.selectRunBtn.textContent = captionSelection ? 'この範囲を読み取る' : '全体を読み取る';
  }
}

/** 続けて選択モードの進捗UI(件数バッジ・読み取り中スピナー・終えるボタンの表示/非表示)。
 *  runSelectionOcrInline()の開始/終了と、handleSelectionRun()の分岐から呼ぶ。 */
function updateSelectionOcrUi() {
  camEls.selectProgressEl.hidden = !captionOcrBusy;
  camEls.selectRunBtn.disabled = captionOcrBusy;
  camEls.selectRetakeBtn.disabled = captionOcrBusy;
  camEls.selectFinishBtn.hidden = captionOcrBuffer.length === 0;
  camEls.selectFinishBtn.disabled = captionOcrBusy;
  camEls.selectCountEl.hidden = captionOcrBuffer.length === 0;
  camEls.selectCountEl.textContent = `読み取り済み: ${captionOcrBuffer.length}件`;
  // 「段組みで一括作成」ボタン自体は、OCR実行中は押せないようにする(2026年9月追加。
  // 実行中に矩形一式を作り直すと、既に走っているhandleAiRunAll()のループが古い矩形の
  // スナップショットを使い続けたまま新しいaiRegionsと食い違う恐れがあるため)。
  camEls.selectAiBtn.disabled = captionOcrBusy;
}

/* ---------------- 「段組みで一括作成」モードのUI(2026年9月、Gemini解析(旧AI解析)から全面置き換え) ----------------
 * 「無駄な解析が多すぎる」というユーザー判断を受け、Geminiへ画像を送って矩形を検出する方式は
 * 撤去した(js/gemini.jsのanalyzeCaptionLayout()ごと削除済み)。書籍・雑誌ページはほぼ常に
 * 等幅の格子状の段組みという前提のもと、指定した列数×段数ぶんの矩形をgenerateGridRegions()が
 * その場で均等割りするだけの完全ローカル計算(通信なし)に置き換えた。手動の範囲選択フロー
 * (runSelectionOcrInline()等)には一切手を入れず、独立した並存機能のまま。
 * 作成した矩形+読み順を.cam-select-layer上へ直接重ねて表示し、画面左側の一覧
 * (camEls.aiRegionListEl)で順番の入れ替え・削除・追加ができる。最終的なOCR自体は
 * runAiRegionOcr()が矩形ごとに既存のocrImage()を呼ぶだけで、OCR結果は手動フローと同じ
 * captionOcrBuffer/captionThumbsへ積む(「✓ 読み取りを終える」ボタンもそのまま共用できる)。
 * 内部の変数・関数・CSSクラス名(aiRegions/aiMode/.cam-ai-rect等)は元がGemini解析だった頃の
 * 命名を引き継いでいる(=「AIが検出した領域」の意味ではなく「この編集用オーバーレイの領域」
 * という意味へ用途が変わっただけ)。ユーザーの目に触れるボタン文言・アイコンは
 * 「段組みで一括作成」に統一済み。 */

/** 既定は列2×段4(見開き2ページ×各4段組み相当、ユーザー指定の典型例)。 */
const AI_GRID_DEFAULT_COLS = 2;
const AI_GRID_DEFAULT_ROWS = 4;
const AI_GRID_MAX = 8;

/** 現在のページ画像を、cols列×rows段の格子状に均等分割した矩形へ一括変換する(Gemini呼び出し
 *  無し、同期処理)。**実機報告(2026年9月)を受けた変更**: 当初は列数だけを指定して画像全体を
 *  横一列(=1段)に並ぶ縦長の矩形へ分割していたが、「横に8列でなく2列×4段にしたい」という
 *  指摘があり、列(横方向の分割数)×段(縦方向の分割数)を独立指定できる格子分割へ作り直した。
 *  返す各矩形はcaptionSelectionと同じCSSピクセル座標(letterbox込み)のため、
 *  cropCanvasToBlob()をそのまま使って切り出せる。 */
function generateGridRegions(cols, rows) {
  if (!captionFreezeCanvas) return [];
  const containerRect = camEls.freezeWrap.getBoundingClientRect();
  const { offsetX, offsetY, renderW, renderH } = computeContainRect(
    containerRect.width, containerRect.height, captionFreezeCanvas.width, captionFreezeCanvas.height
  );
  const cellW = renderW / cols;
  const cellH = renderH / rows;
  const regions = [];
  let order = 0;
  // 日本語縦書きの読み順(右の列から左へ、各列は上から下へ)に合わせて並べる。
  // 列/段の割り当てが意図と逆だった場合も、ユーザー自身が「列」「段」の数値を
  // 入れ替えるだけで調整できる。
  for (let c = cols - 1; c >= 0; c--) {
    for (let r = 0; r < rows; r++) {
      order += 1;
      aiRegionSeq += 1;
      const x = offsetX + c * cellW;
      const y = offsetY + r * cellH;
      regions.push({ id: `ai${aiRegionSeq}`, x, y, w: cellW, h: cellH, order, status: 'idle' });
    }
  }
  return regions;
}

function aiRegionStatusBadge(status) {
  if (status === 'pending') return '<span class="cam-select-thumb-spinner" style="width:10px;height:10px;"></span>';
  if (status === 'done') return '✓';
  if (status === 'empty') return '？';
  if (status === 'failed' || status === 'cancelled') return '✕';
  return '';
}

/** 「📐 一括作成」ボタン。#caption-grid-cols×#caption-grid-rowsで指定された格子状の矩形を
 *  その場で均等割りする(通信なし、瞬時に完了)。手動フロー(handleSelectionRun()等)は
 *  一切呼ばない、完全に独立した経路。既に作成済みの矩形があっても、押すたびに現在の
 *  指定で作り直す(確認ダイアログは挟まない、以前のGemini解析ボタンと同じ挙動)。 */
function handleCreateColumnGrid() {
  if (!captionFreezeCanvas || captionOcrBusy) return;
  const cols = clamp(Math.round(Number(camEls.gridColsInput.value)) || AI_GRID_DEFAULT_COLS, 1, AI_GRID_MAX);
  const rows = clamp(Math.round(Number(camEls.gridRowsInput.value)) || AI_GRID_DEFAULT_ROWS, 1, AI_GRID_MAX);
  camEls.gridColsInput.value = cols;
  camEls.gridRowsInput.value = rows;
  aiRegions = generateGridRegions(cols, rows);
  aiMode = true;
  captionSelection = null; // 手動選択と混在させない
  camEls.selectRect.hidden = true;
  aiRegionSelectedId = aiRegions[0] ? aiRegions[0].id : null;
  renderAiRegionOverlay();
  renderAiRegionList();
  updateAiActionsUi();
  if (typeof setStatus === 'function') setStatus(`${cols}列×${rows}段(計${cols * rows}件)の矩形を作成しました。位置を確認・修正してから読み取ってください`);
}

function clearAiRegionElements() {
  camEls.selectLayer.querySelectorAll('.cam-ai-rect').forEach((el) => el.remove());
}

function applyAiRegionRectStyle(el, region) {
  el.style.left = `${region.x}px`;
  el.style.top = `${region.y}px`;
  el.style.width = `${region.w}px`;
  el.style.height = `${region.h}px`;
}

function renderAiRegionOverlay() {
  clearAiRegionElements();
  aiRegions.forEach((region) => {
    const el = document.createElement('div');
    el.className = 'cam-ai-rect' + (region.id === aiRegionSelectedId ? ' selected' : '');
    el.dataset.regionId = region.id;
    applyAiRegionRectStyle(el, region);
    el.innerHTML =
      `<span class="cam-ai-rect-badge">${region.order}</span>` +
      '<button type="button" class="cam-ai-rect-remove" title="この範囲を削除">✕</button>' +
      '<span class="cam-ai-rect-handle cam-ai-rect-handle--nw" data-handle="nw"></span>' +
      '<span class="cam-ai-rect-handle cam-ai-rect-handle--ne" data-handle="ne"></span>' +
      '<span class="cam-ai-rect-handle cam-ai-rect-handle--sw" data-handle="sw"></span>' +
      '<span class="cam-ai-rect-handle cam-ai-rect-handle--se" data-handle="se"></span>';
    camEls.selectLayer.appendChild(el);
    wireAiRegionRectEl(el, region);
  });
}

function wireAiRegionRectEl(el, region) {
  const removeBtn = el.querySelector('.cam-ai-rect-remove');
  removeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeAiRegion(region.id); });
  el.querySelectorAll('.cam-ai-rect-handle').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      beginAiRegionDrag(e, el, region, 'resize', handle.dataset.handle);
    });
  });
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cam-ai-rect-handle, .cam-ai-rect-remove')) return;
    e.stopPropagation();
    selectAiRegion(region.id);
    beginAiRegionDrag(e, el, region, 'move', null);
  });
}

/** 矩形のドラッグ移動/ハンドルリサイズ(js/camera.jsのEclipseガイド実装と同じ、
 *  pointerdown時点のオフセットを基準にpointermoveで差分を反映する方式)。MIN_SIZE未満には
 *  縮められないようにし、選択レイヤーの外へはclamp()する(canvas.jsの既存グローバル関数を
 *  再利用、camera.js側で重複定義しない)。 */
function beginAiRegionDrag(e, el, region, mode, handle) {
  const layerRect = camEls.selectLayer.getBoundingClientRect();
  const startX = e.clientX;
  const startY = e.clientY;
  const orig = { x: region.x, y: region.y, w: region.w, h: region.h };
  const pointerId = e.pointerId;
  const MIN_SIZE = 24;
  try { el.setPointerCapture(pointerId); } catch (err) { /* 無効なpointerIdは無視 */ }

  function onMove(ev) {
    if (ev.pointerId !== pointerId) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (mode === 'move') {
      region.x = clamp(orig.x + dx, 0, Math.max(0, layerRect.width - region.w));
      region.y = clamp(orig.y + dy, 0, Math.max(0, layerRect.height - region.h));
    } else {
      let x = orig.x, y = orig.y, w = orig.w, h = orig.h;
      if (handle.includes('w')) { x = orig.x + dx; w = orig.w - dx; }
      if (handle.includes('e')) { w = orig.w + dx; }
      if (handle.includes('n')) { y = orig.y + dy; h = orig.h - dy; }
      if (handle.includes('s')) { h = orig.h + dy; }
      if (w < MIN_SIZE) { if (handle.includes('w')) x = orig.x + orig.w - MIN_SIZE; w = MIN_SIZE; }
      if (h < MIN_SIZE) { if (handle.includes('n')) y = orig.y + orig.h - MIN_SIZE; h = MIN_SIZE; }
      region.x = clamp(x, 0, layerRect.width - MIN_SIZE);
      region.y = clamp(y, 0, layerRect.height - MIN_SIZE);
      region.w = Math.min(w, layerRect.width - region.x);
      region.h = Math.min(h, layerRect.height - region.y);
    }
    applyAiRegionRectStyle(el, region);
  }
  function onUp(ev) {
    if (ev.pointerId !== pointerId) return;
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
  }
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
}

function selectAiRegion(id) {
  aiRegionSelectedId = id;
  camEls.selectLayer.querySelectorAll('.cam-ai-rect').forEach((el) => {
    el.classList.toggle('selected', el.dataset.regionId === id);
  });
  renderAiRegionList();
}

/** 「＋ 矩形を追加」行(2026年9月追加、旧#caption-ai-addボタンをこの一覧の先頭へ統合)。
 *  リストの中身は毎回丸ごと作り直すため、この行のHTML自体も他の行と同じく
 *  renderAiRegionList()の中で毎回組み立てる。クリック処理はcamEls.aiRegionListElへの
 *  イベント委譲側(wireCameraEvents())で[data-add-region]を見て振り分ける。 */
const AI_REGION_LIST_ADD_ROW_HTML = '<button type="button" class="cam-ai-region-list-add" data-add-region title="矩形を1つ追加">＋ 矩形を追加</button>';

function renderAiRegionList() {
  if (!camEls.aiRegionListEl) return;
  const ordered = [...aiRegions].sort((a, b) => a.order - b.order);
  camEls.aiRegionListEl.innerHTML = AI_REGION_LIST_ADD_ROW_HTML + ordered.map((region) => (
    `<div class="cam-ai-region-row${region.id === aiRegionSelectedId ? ' selected' : ''}" data-region-id="${region.id}">` +
    `<span class="cam-ai-region-row-num">${region.order}</span>` +
    `<span class="cam-ai-region-row-status">${aiRegionStatusBadge(region.status)}</span>` +
    '<span class="cam-ai-region-row-grip" aria-hidden="true">⠿</span>' +
    '<button type="button" class="cam-ai-region-row-del" title="この範囲を削除">✕</button>' +
    '</div>'
  )).join('');
}

/** 左の一覧の長押しドラッグによる並べ替え(2026年9月、旧▲▼ボタンを置き換え)。
 *  行を AI_REGION_DRAG_LONG_PRESS_MS 押さえ続けると掴んだ状態になり、そのまま上下へ
 *  動かすと一覧内のDOM順をその場で入れ替えていく。指を離した時点のDOM順で order を
 *  1始まりの連番に振り直す(例: 6番を一番上へ運ぶと6番が1番になり、元の1〜5番は
 *  1つずつ繰り下がる)。長押し成立前に指が動いた場合は、一覧の通常スクロールに譲る。 */
const AI_REGION_DRAG_LONG_PRESS_MS = 300;
const AI_REGION_DRAG_MOVE_TOLERANCE_PX = 8;
let aiRegionDrag = null;
let aiRegionDragSuppressClick = false;

function wireAiRegionListDragReorder() {
  const listEl = camEls.aiRegionListEl;

  const cleanup = () => {
    if (!aiRegionDrag) return;
    clearTimeout(aiRegionDrag.timer);
    if (aiRegionDrag.rowEl) aiRegionDrag.rowEl.classList.remove('dragging');
    listEl.classList.remove('reordering');
    try { listEl.releasePointerCapture(aiRegionDrag.pointerId); } catch (_) { /* 既に解放済み */ }
    aiRegionDrag = null;
  };

  listEl.addEventListener('pointerdown', (e) => {
    if (aiRegionDrag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const row = e.target.closest('.cam-ai-region-row');
    if (!row || e.target.closest('.cam-ai-region-row-del')) return;
    aiRegionDrag = {
      pointerId: e.pointerId, rowEl: row, startX: e.clientX, startY: e.clientY,
      active: false, moved: false, timer: null,
    };
    aiRegionDrag.timer = setTimeout(() => {
      if (!aiRegionDrag) return;
      aiRegionDrag.active = true;
      row.classList.add('dragging');
      listEl.classList.add('reordering');
      try { listEl.setPointerCapture(aiRegionDrag.pointerId); } catch (_) { /* 非対応環境 */ }
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (_) { /* 無視 */ } }
    }, AI_REGION_DRAG_LONG_PRESS_MS);
  });

  listEl.addEventListener('pointermove', (e) => {
    if (!aiRegionDrag || e.pointerId !== aiRegionDrag.pointerId) return;
    if (!aiRegionDrag.active) {
      // 長押し成立前に動いたらスクロール/通常タップ扱いにして並べ替えは始めない。
      if (Math.hypot(e.clientX - aiRegionDrag.startX, e.clientY - aiRegionDrag.startY) > AI_REGION_DRAG_MOVE_TOLERANCE_PX) cleanup();
      return;
    }
    e.preventDefault();
    const dragged = aiRegionDrag.rowEl;
    const rows = [...listEl.querySelectorAll('.cam-ai-region-row')].filter((r) => r !== dragged);
    // ポインタより下にある最初の行(中央線基準)の直前へ挿入、無ければ末尾へ。
    let before = null;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { before = r; break; }
    }
    if (before) {
      if (dragged.nextElementSibling !== before) { listEl.insertBefore(dragged, before); aiRegionDrag.moved = true; }
    } else if (listEl.lastElementChild !== dragged) {
      listEl.appendChild(dragged);
      aiRegionDrag.moved = true;
    }
    // 一覧の上下端付近では自動スクロールし、長い一覧でも端まで運べるようにする。
    const listRect = listEl.getBoundingClientRect();
    if (e.clientY < listRect.top + 24) listEl.scrollTop -= 8;
    else if (e.clientY > listRect.bottom - 24) listEl.scrollTop += 8;
  });

  const finish = (e) => {
    if (!aiRegionDrag || e.pointerId !== aiRegionDrag.pointerId) return;
    const wasActive = aiRegionDrag.active;
    const moved = aiRegionDrag.moved;
    const draggedId = aiRegionDrag.rowEl.dataset.regionId;
    cleanup();
    if (!wasActive) return;
    // 長押しが成立した時点で「選択のタップ」ではないため、続くclickは握りつぶす。
    aiRegionDragSuppressClick = true;
    setTimeout(() => { aiRegionDragSuppressClick = false; }, 400);
    if (moved) {
      const idsInDomOrder = [...listEl.querySelectorAll('.cam-ai-region-row')].map((r) => r.dataset.regionId);
      idsInDomOrder.forEach((id, i) => {
        const region = aiRegions.find((r) => r.id === id);
        if (region) region.order = i + 1;
      });
    }
    aiRegionSelectedId = draggedId;
    renderAiRegionOverlay();
    camEls.selectLayer.querySelectorAll('.cam-ai-rect').forEach((el) => {
      el.classList.toggle('selected', el.dataset.regionId === draggedId);
    });
    renderAiRegionList();
  };
  listEl.addEventListener('pointerup', finish);
  listEl.addEventListener('pointercancel', (e) => {
    if (!aiRegionDrag || e.pointerId !== aiRegionDrag.pointerId) return;
    if (aiRegionDrag.active) { finish(e); return; }
    cleanup();
  });
  // iOS Safari等: 掴んでいる間だけタッチスクロールを止める(passive:falseでないとpreventDefaultが効かない)。
  listEl.addEventListener('touchmove', (e) => {
    if (aiRegionDrag && aiRegionDrag.active) e.preventDefault();
  }, { passive: false });
  listEl.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.cam-ai-region-row')) e.preventDefault();
  });
}

function removeAiRegion(id) {
  aiRegions = aiRegions.filter((r) => r.id !== id);
  // 削除した分の欠番を詰め、常に1始まりの連番を保つ。
  aiRegions.sort((a, b) => a.order - b.order).forEach((r, i) => { r.order = i + 1; });
  if (aiRegionSelectedId === id) aiRegionSelectedId = aiRegions[0] ? aiRegions[0].id : null;
  renderAiRegionOverlay();
  renderAiRegionList();
  updateAiActionsUi();
}

/** 「＋ 矩形を追加」(左の一覧の先頭行、2026年9月): 段組み一括作成で足りない/ずれた範囲を
 *  人間が手で補うための入口。画面中央付近に既定サイズの矩形を追加するだけで、実際の
 *  位置・大きさはハンドルドラッグで合わせてもらう。 */
function addManualAiRegion() {
  if (!captionFreezeCanvas) return;
  const layerRect = camEls.selectLayer.getBoundingClientRect();
  const w = Math.min(layerRect.width * 0.5, 220);
  const h = Math.min(layerRect.height * 0.3, 160);
  aiRegionSeq += 1;
  const region = {
    id: `ai${aiRegionSeq}`,
    x: clamp((layerRect.width - w) / 2, 0, Math.max(0, layerRect.width - w)),
    y: clamp((layerRect.height - h) / 2, 0, Math.max(0, layerRect.height - h)),
    w, h,
    order: aiRegions.length + 1,
    status: 'idle',
  };
  aiRegions.push(region);
  aiMode = true;
  aiRegionSelectedId = region.id;
  renderAiRegionOverlay();
  renderAiRegionList();
  updateAiActionsUi();
}

/** 段組み一括作成モードを終え、通常の手動範囲選択画面へ戻る。captionOcrBuffer/captionThumbs
 *  (読み取り済みの結果)自体はこのモード中でも手動フローでも共用のため、ここでは消さない。 */
function exitAiMode() {
  aiMode = false;
  aiRegions = [];
  aiRegionSelectedId = null;
  clearAiRegionElements();
  if (camEls.aiRegionListEl) camEls.aiRegionListEl.innerHTML = '';
  updateAiActionsUi();
}

function resetAiRegionState() {
  exitAiMode();
}

/** 段組み一括作成モード中のアクションボタン(まとめて読み取る/手動選択に戻す)と、
 *  通常モードの「全体を読み取る」ボタンの表示/非表示を切り替える。 */
function updateAiActionsUi() {
  if (!camEls.aiRunBtn) return;
  camEls.selectRunBtn.hidden = aiMode;
  // regions.length===0でも一覧自体は隠さない(2026年9月変更): 先頭の「＋ 矩形を追加」行が
  // ここにあるため、全部削除した後も再度そこから追加できる必要がある。
  camEls.aiRegionListEl.hidden = !aiMode;
  camEls.aiRunBtn.hidden = !aiMode;
  camEls.aiCancelBtn.hidden = !aiMode;
  camEls.aiRunBtn.disabled = captionOcrBusy || aiRegions.length === 0;
}

/** 段組み一括作成で確定した1領域ぶんのOCR。runSelectionOcrInline()と役割は同じだが、
 *  captionSelection/camEls.selectRect(単一選択の状態)には一切触れない独立した実装
 *  (「現在の手動OCRを維持したまま」というユーザー指示により、意図的にコードを分離した)。 */
async function runAiRegionOcr(region) {
  const gen = captionSelectionGen;
  region.status = 'pending';
  renderAiRegionList();
  let blob;
  try {
    blob = await cropCanvasToBlob(captionFreezeCanvas, camEls.freezeWrap, region, 0.92);
  } catch (err) {
    console.error(err);
    camDebugLog('AI領域の切り出しに失敗: ' + err.message);
    region.status = 'failed';
    renderAiRegionList();
    return;
  }
  const thumbUrl = URL.createObjectURL(blob);
  const thumbEntry = addCaptionThumb(thumbUrl);
  const controller = new AbortController();
  captionInlineController = controller;
  ocrActiveControllers.add(controller);
  try {
    const text = await ocrImage(blob, { signal: controller.signal });
    if (gen !== captionSelectionGen) { URL.revokeObjectURL(thumbUrl); return; }
    if (!text || text.includes('(テキストなし)')) {
      region.status = 'empty';
      setCaptionThumbStatus(thumbEntry, 'empty');
    } else {
      captionOcrBuffer.push(text);
      region.status = 'done';
      setCaptionThumbStatus(thumbEntry, 'done');
    }
  } catch (err) {
    console.error(err);
    if (gen === captionSelectionGen) {
      region.status = err && err.cancelled ? 'cancelled' : 'failed';
      setCaptionThumbStatus(thumbEntry, region.status);
    } else {
      URL.revokeObjectURL(thumbUrl);
    }
  } finally {
    ocrActiveControllers.delete(controller);
    if (captionInlineController === controller) captionInlineController = null;
    if (gen === captionSelectionGen) renderAiRegionList();
  }
}

/** 「この順番でまとめて読み取る」: 確定した領域を読み順どおり1つずつ(同時並列ではなく
 *  逐次)OCRしていく。無料枠のRPM制限に配慮しつつ、進行状況を一覧上のステータスで追える
 *  ようにするため、あえて並列化していない。既存の「✓ 読み取りを終える」ボタンで、ここまでに
 *  読み取った分(captionOcrBuffer)を結合して確定できる(手動フローと共通の仕組み)。 */
async function handleAiRunAll() {
  if (captionOcrBusy || aiRegions.length === 0) return;
  const gen = captionSelectionGen;
  const targetCanvas = captionFreezeCanvas; // 下記ガード参照
  captionOcrBusy = true;
  updateSelectionOcrUi();
  updateAiActionsUi();
  const ordered = [...aiRegions].sort((a, b) => a.order - b.order);
  for (const region of ordered) {
    // captionSelectionGenは撮り直し/カメラを閉じる操作でのみ増える(ページ切り替えでは
    // 増やさない、switchCaptionPage()のコメント参照)。AI領域の座標は特定ページの
    // captionFreezeCanvasに紐づくため、ページ切り替え自体はこちらで別途検知して打ち切る
    // (でないと、切り替わった後のページの画像から古いページ向けの座標で切り出してしまい、
    // 無関係なテキストがcaptionOcrBufferへ混入しかねない)。
    if (captionSelectionGen !== gen || captionFreezeCanvas !== targetCanvas) break;
    await runAiRegionOcr(region);
    if (captionSelectionGen === gen) updateSelectionOcrUi(); // 件数バッジ(読み取り済み: N件)をその都度更新する
  }
  captionOcrBusy = false;
  updateSelectionOcrUi();
  updateAiActionsUi();
  updateSelectRunLabel();
  if (gen === captionSelectionGen && typeof setStatus === 'function') {
    setStatus(`${ordered.length}件の範囲を読み取りました。「✓ 読み取りを終える」で確定してください`);
  }
}

/* ---------------- 続けて選択モードの範囲サムネイル一覧(2026年9月追加) ----------------
 * 「細かな範囲選択OCR作業が中心のモジュール」向けに、件数の数字だけでなく「どの範囲を・
 * どんな状態で読んだか」を画面右側の縦一列のサムネイルで一目で追えるようにする。
 * captionOcrBuffer(実際に結合されるテキスト)とは別に持ち、失敗・空振りの範囲も
 * (テキストとしては使わないが)見た目の記録として残す。 */

/** 1件ぶんのサムネイルを「読み取り中」状態で追加する。返した参照をsetCaptionThumbStatus()に渡す。 */
function addCaptionThumb(url) {
  const entry = { url, status: 'pending' };
  captionThumbs.push(entry);
  camDebugLog(`サムネ追加(pending) 現在${captionThumbs.length}件`);
  renderCaptionThumbs();
  return entry;
}

function setCaptionThumbStatus(entry, status) {
  entry.status = status;
  camDebugLog(`サムネ状態変更: ${status}`);
  renderCaptionThumbs();
}

/** 状態ごとのバッジ内容(絵文字/記号 or スピナー)。実機で::after(疑似要素)が
 *  親のoverflow:hiddenとの組み合わせで見えなくなる不具合が報告されたため、疑似要素ではなく
 *  実体のDOM要素(span)として描画する(2026年9月変更)。 */
function captionThumbBadgeHtml(status) {
  if (status === 'pending') return '<span class="cam-select-thumb-spinner"></span>';
  if (status === 'done') return '✓';
  if (status === 'empty') return '？';
  return '✕'; // failed | cancelled
}

function renderCaptionThumbs() {
  if (!camEls.selectThumbsEl) return;
  camEls.selectThumbsEl.classList.toggle('show', captionThumbs.length > 0);
  camEls.selectThumbsEl.innerHTML = captionThumbs
    .map((t, i) => (
      `<div class="cam-select-thumb cam-select-thumb--${t.status}">` +
      `<img src="${t.url}" alt="">` +
      `<span class="cam-select-thumb-num">${i + 1}</span>` +
      `<span class="cam-select-thumb-badge">${captionThumbBadgeHtml(t.status)}</span>` +
      '</div>'
    ))
    .join('');
  // 新しいサムネイルが増えるたび、一覧の一番下(＝最新)が見えるようにスクロールする。
  camEls.selectThumbsEl.scrollTop = camEls.selectThumbsEl.scrollHeight;
}

/** 読み取り中に生成したBlob URLはメモリに残り続けるため、撮り直し・カメラを閉じる・
 *  読み取りを終えるタイミングで必ず解放する(resetCaptionState()から呼ぶ)。 */
function clearCaptionThumbs() {
  captionThumbs.forEach((t) => URL.revokeObjectURL(t.url));
  captionThumbs = [];
  if (camEls && camEls.selectThumbsEl) {
    camEls.selectThumbsEl.innerHTML = '';
    camEls.selectThumbsEl.classList.remove('show');
  }
}

/** 選択レイヤー上のドラッグで矩形を描く。指を離すまで始点を固定し、終点だけ動かす。 */
function wireSelectionLayer() {
  const layer = camEls.selectLayer;
  layer.addEventListener('pointerdown', (e) => {
    // AI解析モード中は、この従来の単一矩形ドラッグ選択を無効化する(2026年9月追加)。
    // AI解析モードの矩形自体は.cam-ai-rect側で個別にpointerdownをstopPropagation()して
    // いるため、ここに届くのは「矩形が無い空白部分」への操作のみ。手動で範囲を描き足す
    // 手段は「＋ 手動で範囲を追加」ボタン(addManualAiRegion())に一本化している。
    if (aiMode) return;
    // 診断用(2026年9月追加): 「範囲選択が出にくい」報告の原因切り分け。このpointerdown自体が
    // 期待通りの頻度で発火しているか、closest()判定で誤ってスキップされていないかを常時記録する。
    camDebugLog(
      `layer pointerdown id=${e.pointerId} client=(${Math.round(e.clientX)},${Math.round(e.clientY)}) ` +
      `target=${e.target.tagName}.${e.target.className}`
    );
    // 2026年9月追加: 直前に選択済みの範囲があれば退避しておき、今回の操作の結果が
    // 「新しい範囲を描くドラッグ」ではなく「ほぼ動かないタップ」だった場合(pointerup側で判定)、
    // その退避した選択をそのまま確定に使う。これにより、フリーズ画像上のどこであっても軽く
    // タップするだけで直前の選択を確定できるようになる(浮動スキャンボタンは2026年9月に撤去、
    // この「範囲の内側をタップして確定」が唯一の確定操作になった)。
    selectPendingConfirmSelection = captionSelection;
    camEls.selectRect.classList.remove('scanning'); // 前回の走査線エフェクトが残っていれば消す
    // 前回の失敗時のエラーバナー(#camera-error)は、成功/失敗に関わらず明示的に消さない限り
    // 画面に残り続ける設計だった(2026年9月、実機報告を受けて発見)。#camera-errorはbottom付近を
    // left:16〜right:16の帯で覆い、pointer-eventsも既定(auto)のため、そこに重なる範囲を
    // 選ぼうとしてもタップがバナーに吸われて選択矩形が始まらない、という不具合になっていた。
    // 新しい範囲選択を始める操作自体を「もう一度試す」意思表示とみなし、ここで確実に消す。
    clearCameraError();
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
  layer.addEventListener('pointerup', (e) => {
    // 診断用(2026年9月追加): pointerIdが不一致で無視されるケースも含め常時記録する。
    camDebugLog(
      `layer pointerup id=${e.pointerId} expect=${selectPointerId} ` +
      `captionSelection=${captionSelection ? `${Math.round(captionSelection.w)}x${Math.round(captionSelection.h)}` : 'なし'}`
    );
    if (e.pointerId !== selectPointerId) return;
    selectPointerActive = false;
    selectPointerId = null;
    const rect = layer.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    // captionSelectionはこのジェスチャー自身のpointerdown/pointermoveで既に更新済み
    // (updateSelectRectFromPoints)。それがnullということは、このジェスチャー自体は
    // 8px角以上の有効な矩形を作れなかった(=ドラッグではなく実質的な「タップ」だった)。
    if (!captionSelection && selectPendingConfirmSelection) {
      const pending = selectPendingConfirmSelection;
      const insidePending = endX >= pending.x && endX <= pending.x + pending.w
        && endY >= pending.y && endY <= pending.y + pending.h;
      selectPendingConfirmSelection = null;
      if (insidePending) {
        // 2026年9月追加: 直前の選択の「内側」をタップ=その選択を確定する操作として扱う
        // (上記pointerdownのコメント参照)。浮動ボタンの精密な当たり判定に依存しない。
        camDebugLog('タップ確定フォールバック発動(選択の内側)');
        captionSelection = pending;
        camEls.selectRect.hidden = false;
        camEls.selectRect.style.left = `${pending.x}px`;
        camEls.selectRect.style.top = `${pending.y}px`;
        camEls.selectRect.style.width = `${pending.w}px`;
        camEls.selectRect.style.height = `${pending.h}px`;
        handleSelectionRun();
        return;
      }
      // 2026年9月追加: 直前の選択の「外側」をタップ=やり直し(選択を取り消して未選択の
      // 状態に戻すだけ)として扱う。実機報告「範囲外をタップしてもスキャンが始まってしまい
      // やり直しができない」への対応。captionSelectionは既にnullなので追加操作は不要。
      camDebugLog('選択の外側タップでキャンセル(やり直し可能)');
      updateSelectRunLabel();
      return;
    }
    selectPendingConfirmSelection = null;
    // 範囲を描き終えた時点では確定せず、下部の「この範囲を読み取る」ボタン、または
    // この範囲の内側を軽くタップする(上記のフォールバック)ことで確定する。
  });
  layer.addEventListener('pointercancel', (e) => {
    camDebugLog(`layer pointercancel id=${e.pointerId} expect=${selectPointerId}`); // 診断用(2026年9月追加)
    selectPendingConfirmSelection = null;
    if (e.pointerId !== selectPointerId) return;
    selectPointerActive = false;
    selectPointerId = null;
  });
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
  // blob化した直後に一時canvasの描画バッファを明示的に解放する(2026年9月追加)。
  // iOS Safari等では、使い終わった<canvas>の実データがGCで回収されるまで確保され続ける
  // ことがあり、範囲選択OCRを何度も連続実行するとその分だけ積み上がって重くなる(=選択矩形の
  // 描画やタップ判定が遅く/鈍く感じられる)ことが実機で疑われた。width/heightを0にすると
  // ブラウザがその場でバッキングストアを解放してくれる、という既知の対策。
  return canvasToBlob(out, quality).finally(() => {
    out.width = 0;
    out.height = 0;
  });
}

/**
 * 「この範囲を読み取る」/「全体を読み取る」ボタン。
 * **2026年9月変更**: 以前はここでGeminiの応答(所要時間が読めず、数秒かかることがある)を
 * オーバーレイを開いたまま待っていたため、その間ずっと次の写真が撮れなかった。実際に展覧会場で
 * 使ってみたユーザーから「OCRを待たされている間に次の写真を撮りたい」という要望があり、
 * 押した瞬間にカメラのオーバーレイ自体を閉じ、OCR(Gemini呼び出し)はrunOcrInBackground()で
 * バックグラウンドへ回すように変更した。進行中であることは画面右下の小さなPiP表示
 * (#ocr-pip、css/style.css)だけで示し、カメラは即座に次の撮影に使える状態へ戻る。
 *
 * **2026年9月さらに改良(「続けて選択」モード)**: 美術手帖のような書籍ページは縦書き4段組み
 * など構成が複雑で、1回のOCRでは段の順序が混ざって読み取り精度が落ちる。範囲選択を使って
 * 段ごとに分割してOCRする運用は有効だが、以前は1回読み取るたびにカメラごと閉じてしまうため、
 * 次の段を読み取るには毎回カメラを開き直し・同じ写真を撮り直す/アップロードし直す必要があり
 * 実用上とても不便だった。そこで「範囲を選ばずそのまま読み取る(全体)」場合は従来通りの
 * 一発読み取り(即座に閉じてバックグラウンドPiPへ)のままにしつつ、**一度でも範囲を選んで
 * 読み取った場合は、同じ静止フレームを表示したままにして、続けて次の範囲を選べる**ように
 * した。進行中はこの画面内のインラインの進捗表示(#caption-select-progress)で示し、
 * 「✓ 読み取りを終える」を押した時点で、それまでに読み取った範囲を改行区切りで結合して
 * 呼び出し元へ渡す。
 */
// handleSelectionRun()は「切り出し(cropCanvasToBlob、非同期)→OCR呼び出し」の2段階だが、
// captionOcrBusyは後段(OCR呼び出し)が始まってから初めてtrueになる。前段の切り出し中に
// 連打/連続タップされると、まだcaptionOcrBusyがfalseのままガードをすり抜け、同じ画像に対して
// runSelectionOcrInline()が二重に走ってしまう(=結果が重複して積まれる、または片方が
// 混線して見える)不具合があった(2026年9月、実機報告「2枚目以降の抽出が失敗する」の
// 原因の一つとして修正)。切り出し中もブロックする専用フラグで塞ぐ。
let captionRunGuardActive = false;

async function handleSelectionRun() {
  if (!captionFreezeCanvas || captionOcrBusy || captionRunGuardActive) {
    // 診断用(2026年9月追加): スキャンボタンをタップしても無反応になる不具合の原因切り分け。
    // ここで無条件returnすると呼び出し元(ボタン)からは何も起きなかったように見えるため、
    // どのガードで止まったかを?debugパネルへ残す。
    camDebugLog(
      `handleSelectionRun: 早期return(freezeCanvas=${!!captionFreezeCanvas}, ` +
      `ocrBusy=${captionOcrBusy}, runGuard=${captionRunGuardActive})`
    );
    return;
  }
  captionRunGuardActive = true;
  camEls.selectRunBtn.disabled = true;
  // 走査線エフェクト(2026年9月追加、ユーザー要望): 選択を確定した瞬間から結果が届くまでの間、
  // 選択矩形の内側を光の帯が上下する演出を出す。実際の処理状況とは連動しない純粋な演出。
  if (captionSelection) camEls.selectRect.classList.add('scanning');
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
    camDebugLog('画像の切り出しに失敗: ' + err.message); // 診断用(2026年9月追加)
    showCameraError(`画像の切り出しに失敗しました: ${err.message}`);
    camEls.selectRect.classList.remove('scanning');
    captionRunGuardActive = false;
    camEls.selectRunBtn.disabled = captionOcrBusy;
    return;
  }
  captionRunGuardActive = false;
  const hadSelection = Boolean(captionSelection);
  camDebugLog(`OCR送信(選択=${hadSelection ? 'あり' : 'なし(全体)'}) size=${blob.size}B type=${blob.type}`);

  // まだ一度も範囲選択を使っておらず、かつ今回も「全体」で、呼び出し元が続けて選択モードを
  // 明示的に要求していなければ、単発の写真OCRとしてこれまで通りその場でカメラを閉じ、
  // バックグラウンド(corner PiP)で処理する。continuous指定時は、範囲を選ばない1回目の
  // 読み取りもサムネイル付きの画面内フローに統一する(上記openCamera()のコメント参照)。
  if (!hadSelection && captionOcrBuffer.length === 0 && !captionForceContinuous) {
    const resolve = detachCameraForBackgroundOcr();
    runOcrInBackground(blob, resolve);
    return;
  }
  runSelectionOcrInline(blob);
}

/**
 * 「続けて選択」モード中の1範囲ぶんのOCR。カメラは閉じず、結果はcaptionOcrBufferへ積んで
 * 画面内の進捗表示を更新するだけ(呼び出し元への通知はhandleSelectionFinish()まで行わない)。
 * captionSelectionGenで、撮り直し・カメラを閉じるなどで無効になった古いセッションの結果を
 * 誤って積んでしまわないようにガードする。
 */
let captionInlineController = null; // 今インラインで進行中のOCR呼び出し(#caption-select-progress-cancelで個別に中止する)

async function runSelectionOcrInline(blob) {
  const gen = captionSelectionGen;
  captionOcrBusy = true;
  updateSelectionOcrUi();
  // このblob(切り出し済みの範囲画像)自体をサムネイルの表示元にする(改めて縮小加工しない、
  // 既に範囲だけに切り出された小さめの画像のため、そのままCSSで表示枠に収める)。
  const thumbUrl = URL.createObjectURL(blob);
  const thumbEntry = addCaptionThumb(thumbUrl);
  const controller = new AbortController();
  captionInlineController = controller;
  ocrActiveControllers.add(controller); // PiPの✕(全件中止)にも相乗りできるよう、共有Setにも登録しておく
  try {
    const text = await ocrImage(blob, { signal: controller.signal });
    if (gen !== captionSelectionGen) {
      // テキスト自体は取得できているが、その間に撮り直し/クローズ等でセッションが無効になった
      // ため、サムネイルへは反映しない(このケースが疑われる場合は?debugパネルで確認できる
      // よう記録しておく、2026年9月追加)。
      camDebugLog(`続けて選択: gen不一致のため結果を破棄(呼び出し時gen=${gen}, 現在gen=${captionSelectionGen})`);
      URL.revokeObjectURL(thumbUrl);
      return;
    }
    if (!text || text.includes('(テキストなし)')) {
      setCaptionThumbStatus(thumbEntry, 'empty');
      if (typeof setStatus === 'function') setStatus('この範囲では文字を検出できませんでした');
    } else {
      captionOcrBuffer.push(text);
      setCaptionThumbStatus(thumbEntry, 'done');
      if (typeof setStatus === 'function') setStatus(`範囲を読み取りました(${captionOcrBuffer.length}件目)`);
    }
  } catch (err) {
    console.error(err);
    camDebugLog('OCRエラー(続けて選択): ' + err.message);
    if (gen === captionSelectionGen) {
      if (err && err.cancelled) {
        setCaptionThumbStatus(thumbEntry, 'cancelled');
        if (typeof setStatus === 'function') setStatus('読み取りを中止しました');
      } else {
        setCaptionThumbStatus(thumbEntry, 'failed');
        if (typeof setStatus === 'function') setStatus(`読み取りに失敗しました: ${err.message}`, { important: true });
      }
    } else {
      URL.revokeObjectURL(thumbUrl);
    }
  } finally {
    ocrActiveControllers.delete(controller);
    if (captionInlineController === controller) captionInlineController = null;
    if (gen === captionSelectionGen) {
      captionOcrBusy = false;
      // 次の範囲をすぐ選べるよう、選択矩形だけリセットして同じ画像は表示したままにする。
      captionSelection = null;
      camEls.selectRect.hidden = true;
      camEls.selectRect.classList.remove('scanning'); // 走査線エフェクトも終了(2026年9月追加)
      updateSelectRunLabel();
      updateSelectionOcrUi();
    }
  }
}

/** インライン進捗表示の✕(2026年9月追加): 電波状況が悪い等でこの範囲の読み取りが
 *  いつまでも終わらない場合に、この1件だけを中止できる(#ocr-pip-cancelの「全件中止」より
 *  的を絞った操作)。 */
function handleSelectionOcrCancel() {
  if (captionInlineController) captionInlineController.abort();
}

/** 「✓ 読み取りを終える」: それまでに続けて選択モードで読み取った範囲を改行区切りで結合し、
 *  カメラを閉じて呼び出し元のPromiseへ渡す(単発読み取り(runOcrInBackground())と合流する
 *  出口が違うだけで、呼び出し元からは同じ{kind:'text', text}の形で届く)。 */
function handleSelectionFinish() {
  if (captionOcrBusy || captionOcrBuffer.length === 0) return;
  const combined = captionOcrBuffer.join('\n');
  captionOcrBuffer = [];
  clearCaptionThumbs(); // サムネイルのBlob URLをこの時点で解放する(次回openCamera()を待たない)
  captionPages = []; // 複数ページ分のcanvasも同時に解放する(2026年9月追加)
  captionPageIndex = -1;
  renderCaptionPageStrip();
  const resolve = detachCameraForBackgroundOcr();
  if (typeof setStatus === 'function') setStatus('読み取りました');
  resolve({ kind: 'text', text: combined });
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
  captionForceContinuous = false; // 次のopenCamera()呼び出し元(既定は単発扱い)へ引き継がない
  stopCameraStream(); // track.stop()がハードウェアを解放するため、トーチも自動的に消える
  stopScreenShare();
  camTorchOn = false;
  if (camEls && camEls.eclipseGuidePhoto) camEls.eclipseGuidePhoto.classList.remove('heating', 'torch-on');
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

/** Eclipseガイド起動:「シュルルン↑」。2音の上昇チェイスに、それぞれわずかにデチューンした
 *  ペアを重ねてコロナのようなシマーを出す(2026年9月追加、wireEclipseGuide()のshowDefault()から呼ぶ)。 */
function playEclipseOpen() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  camTone(ctx, 523.25, now, 0.16, 'sine', 0.11);
  camTone(ctx, 526.5, now, 0.16, 'sine', 0.07);
  camTone(ctx, 784, now + 0.09, 0.22, 'sine', 0.12);
  camTone(ctx, 790, now + 0.09, 0.22, 'sine', 0.07);
}

// ターゲッティングスコープの「ピッ」(照準の移動中、距離で間引いて呼ばれる)は、ドラッグ中に
// 何度も鳴らすため、他の単発効果音(shutter等)のように呼ぶたびに新しいAudioContextを作ると、
// ドラッグ1回で大量のコンテキストが生成されてしまう(ブラウザによっては同時に持てる数に
// 上限があり、超えると音が鳴らなくなる恐れがある)。この2音(ピッ/ピコッ)だけは
// 1つのAudioContextを使い回す(js/sound.jsのsoundAudioCtx()と同じ考え方)。
let camTargetTickCtx = null;
function camTargetTickAudioCtx() {
  if (!camTargetTickCtx) camTargetTickCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (camTargetTickCtx.state === 'suspended') camTargetTickCtx.resume();
  return camTargetTickCtx;
}

/** ターゲッティングスコープの照準を動かしている間の「ピッ」。 */
function playTargetMoveTick() {
  const ctx = camTargetTickAudioCtx();
  const now = ctx.currentTime;
  camTone(ctx, 2000, now, 0.05, 'sine', 0.1);
}

/** ターゲッティングスコープで対象へ照準を合わせて再タップ(鑑定を呼び出す)した瞬間の「ピコッ」。 */
function playTargetLock() {
  const ctx = camTargetTickAudioCtx();
  const now = ctx.currentTime;
  camTone(ctx, 1200, now, 0.05, 'sine', 0.14);
  camTone(ctx, 1900, now + 0.05, 0.08, 'sine', 0.16);
}
