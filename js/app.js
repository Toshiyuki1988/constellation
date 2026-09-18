// アプリのエントリーポイント。認証・Drive・キャンバス・Geminiを結線する。

const state = {
  folderId: null,
  fileId: null,
  // Almagest(書物モジュール)専用のDriveファイル(almagest-library.json)のID。
  // 2026年9月、書庫データをメインのconstellation-data.jsonから独立させた際に追加。
  almagestFileId: null,
  // メディア(画像・動画・音声)の入れ子フォルダのルート(Constellation/media)。
  // 実際のアップロード先は resolveSessionMediaFolderId() が年/セッションごとのサブフォルダを解決する。
  mediaFolderId: null,
  cards: [],
  // セッション(年 / 展覧会 / 作品などの入れ子)。フラット配列 + parentId でツリーを表現する。
  // { id, type: 'year'|'session', parentId, name, year(yearのみ), createdAt }
  sessions: [],
  // Asterism: ASTRガイドから手動で結んだカード同士のつながり。
  // { id, sessionId, cardIdA, cardIdB }(向きの意味は持たない)
  connections: [],
  // Asterism: 自動の見た順の線のうち、個別に非表示にしたペア。
  // { id, sessionId, cardIdA, cardIdB }
  hiddenAutoLinks: [],
  // インフォメーションカードの「鑑賞可能日」を同期する専用Googleカレンダー(「展覧会」)のID。
  // 初回同期時に作成し、以後はこのIDを使い回す。
  exhibitionCalendarId: null,
  // Crewsモジュール(js/modules/crews.js)のペルソナ一覧。複数セッション・複数年をまたいで
  // 使い回すデータなので、カード単位ではなくここに持つ。
  // { id, personInfo, theirWords, name, avatar, enabled, createdAt }
  crews: [],
  // Flight Engineerモジュール(js/modules/flight-engineer.js)の編集履歴(格納/解体のみ、最大10件、
  // 時系列の1本の配列+現在位置)。アプリ/PCのシャットダウンを挟んでも履歴から任意の時点へ
  // 戻れるよう、他のデータと同じくconstellation-data.jsonへ永続化する(クロージャではなく
  // プレーンなデータとして保持する)。feHistoryIndex件ぶんが「現在適用済み」、それ以降は
  // 履歴タップで「やり直し」できる未来の分岐として残る。
  feHistory: [],
  feHistoryIndex: 0,
  // コメント履歴(2026年9月追加)。デイリーコメント・グループビューイングモードで生成された
  // 一過性のコメント(カードとしては残らない)を最大COMMENT_HISTORY_MAX件だけ時系列で保持する。
  // カードに直接付随するコメント(mediaType:'comment')は普通のカードとして永続するため、
  // ここには含まない(ユーザー方針: 「デイリー・グループビューイングは100件までの一過性、
  // カードコメントは永続性」で明確に分ける)。
  // { id, name, avatar, text, source: 'daily'|'group', ts }
  commentHistory: [],
  // グループビューイングモード(js/app.jsのgroupViewingTick())のコメント間隔(秒)。
  // js/modules/crews.jsのペルソナ管理パネルから設定できる。既定60秒。
  groupViewingIntervalSec: 60,
  // オートセーブ(constellation-data.json全体のDrive自動保存)のON/OFF。
  // **2026年9月、手動トグルを廃止し接続状態に自動連動させた**(updateOfflineIndicator()/
  // handleConnectivityChange()参照)。以前は端末ローカルのON/OFFボタンで手動切り替えしていたが、
  // ヘッダーのボタンが増えて煩雑になったこと、切り替え忘れによる「オンラインなのに未保存が
  // 溜まる」取りこぼしが起きうることから、シンプルな「オンライン中は自動保存・オフライン中は
  // 端末内バックアップのみ」という接続状態そのものへの連動に置き換えた。
  autoSaveEnabled: navigator.onLine,
  // クイックカメラ/クイックセッション(2026年9月追加、スタートメニュー)。
  // trueの間は、メインデータ(state.cards/sessions全体)を読み込んでいない代わりに、
  // 【現在の年】セッション+今回新規に作ったセッションだけを持つ軽量な状態で動いている。
  // この間の保存はDriveのメインファイルへは行わず、IndexedDBのクイックバンドルへ留める
  // (js/upload-queue.jsのsaveQuickBundle()、js/app.jsのscheduleAutoSave()参照)。
  quickMode: false,
  // クイックモード中、フルデータを読み込まずに安全に出入りできるセッションID一覧
  // (年セッション+今回作った新規セッションのみ)。enterSession()がこれを見て、
  // 範囲外のセッションへ移動しようとした瞬間だけensureMainDataLoaded()を先に待つ。
  quickSessionIds: null,
  // 今回のクイック外出を識別するID(2026年9月追加、IndexedDBのクイックバンドルを保存する
  // キーに使う)。startQuickSession()で発行し、マージ完了後はnullに戻す。単一キーだった頃、
  // マージし損ねた過去の外出のバンドルを次の外出が上書きして消してしまうバグがあったため、
  // 外出ごとに一意なキーを持たせるようにした(js/upload-queue.jsのクイックバンドルの
  // コメント参照)。
  quickBundleId: null,
  // 年セッションだけの軽量インデックス(constellation-years.json)のファイルID・読み込み状況。
  yearsIndexFileId: null,
  yearsIndexAvailable: false,
};

const FIRST_YEAR = 2025;

const els = {};

document.addEventListener('DOMContentLoaded', () => {
  els.settingsBtn = document.getElementById('settings-btn');
  els.settingsModal = document.getElementById('settings-modal');
  els.settingsClientId = document.getElementById('settings-client-id');
  els.settingsApiKey = document.getElementById('settings-api-key');
  els.settingsError = document.getElementById('settings-error');
  els.settingsSaveBtn = document.getElementById('settings-save-btn');
  els.settingsCancelBtn = document.getElementById('settings-cancel-btn');
  els.settingsCloseBtn = document.getElementById('settings-close-btn');
  els.signInBtn = document.getElementById('sign-in-btn');
  els.signOutBtn = document.getElementById('sign-out-btn');
  els.toolUpload = document.getElementById('tool-upload');
  els.toolCamera = document.getElementById('tool-camera');
  els.toolText = document.getElementById('tool-text');
  els.toolVideo = document.getElementById('tool-video');
  els.toolAudio = document.getElementById('tool-audio');
  els.toolSession = document.getElementById('tool-session');
  els.toolInfo = document.getElementById('tool-info');
  els.toolSummary = document.getElementById('tool-summary');
  els.toolStreetview = document.getElementById('tool-streetview');
  els.toolKeypad = document.getElementById('tool-keypad');
  els.status = document.getElementById('status');
  els.statusProgress = document.getElementById('statusProgress');
  els.statusProgressBar = document.getElementById('statusProgressBar');
  els.viewport = document.getElementById('canvas-viewport');
  els.content = document.getElementById('canvas-content');
  els.imageInput = document.getElementById('image-input');
  els.yearTabs = document.getElementById('year-tabs');
  els.breadcrumb = document.getElementById('breadcrumb');
  els.infoTicker = document.getElementById('infoTicker');
  els.infoTickerText = document.getElementById('infoTickerText');
  els.infoTickerProgress = document.getElementById('infoTickerProgress');
  els.dailyCommentToast = document.getElementById('daily-comment-toast');
  els.dailyCommentAvatar = document.getElementById('daily-comment-avatar');
  els.dailyCommentName = document.getElementById('daily-comment-name');
  els.dailyCommentText = document.getElementById('daily-comment-text');
  els.dailyCommentClose = document.getElementById('daily-comment-close');
  if (els.dailyCommentClose) els.dailyCommentClose.addEventListener('click', hideDailyCommentToast);
  els.groupViewingBtn = document.getElementById('group-viewing-btn');
  if (els.groupViewingBtn) els.groupViewingBtn.addEventListener('click', toggleGroupViewing);
  els.commentHistoryBtn = document.getElementById('comment-history-btn');
  if (els.commentHistoryBtn) els.commentHistoryBtn.addEventListener('click', openCommentHistory);
  els.driveQuotaBtn = document.getElementById('drive-quota-btn');
  if (els.driveQuotaBtn) els.driveQuotaBtn.addEventListener('click', () => refreshDriveQuota());
  els.offlineIndicatorBtn = document.getElementById('offline-indicator-btn');
  if (els.offlineIndicatorBtn) els.offlineIndicatorBtn.addEventListener('click', handleOfflineIndicatorClick);
  window.addEventListener('online', handleConnectivityChange);
  window.addEventListener('offline', handleConnectivityChange);
  updateOfflineIndicator();

  initCanvas(els.viewport, els.content);
  initExtractRegionPicker();

  els.settingsBtn.addEventListener('click', () => openSettings());
  els.settingsSaveBtn.addEventListener('click', handleSettingsSave);
  els.settingsCancelBtn.addEventListener('click', closeSettings);
  els.settingsCloseBtn.addEventListener('click', closeSettings);

  // Driveへの手動アップロード(2026年9月、完全手動化。設定モーダル内に置き、誤操作を防ぐ)。
  // いずれもstate.cards(getCardById())を前提にするため、withMainData()で保護する
  // (メインデータ読み込み前に呼ぶと、待機列のエントリを「対応カードが見つからない」=
  // 削除済みと誤認して消してしまいかねない、2026年9月に発見した重大なリスクへの対応)。
  els.driveUploadBtn = document.getElementById('drive-upload-btn');
  els.driveUploadStatus = document.getElementById('drive-upload-status');
  if (els.driveUploadBtn) els.driveUploadBtn.addEventListener('click', () => withMainData(handleDriveUploadBtnClick));
  els.exportToPhotosBtn = document.getElementById('export-to-photos-btn');
  if (els.exportToPhotosBtn) els.exportToPhotosBtn.addEventListener('click', () => withMainData(handleExportToPhotos));
  updateDriveUploadButton();
  const uploadStatusBtn = document.getElementById('upload-status-btn');
  if (uploadStatusBtn) uploadStatusBtn.addEventListener('click', () => withMainData(openUploadStatusList));

  // 高画質差し替え(EXIF自動照合、2026年9月追加→同月中にユーザー判断でオフ、CLAUDE.md参照)。
  // 「今の使用状況では、必要な写真はズーム時に元画質で見られているため不要」との理由で
  // index.html側でボタンをhiddenにした。この配線・下の一連の関数は削除せず残してある
  // (また必要になればindex.htmlのhidden属性を外すだけで復活する)。
  // state.cards(activeSessionId()の写真カード)を前提にするため、withMainData()で保護する
  // (上と同じ理由)。
  els.exifMatchBtn = document.getElementById('exif-match-btn');
  els.exifMatchInput = document.getElementById('exif-match-input');
  if (els.exifMatchBtn) els.exifMatchBtn.addEventListener('click', () => withMainData(() => els.exifMatchInput.click()));
  if (els.exifMatchInput) els.exifMatchInput.addEventListener('change', handleExifMatchFilesSelected);

  debugLog('DOMContentLoaded, isConfigured=' + isConfigured());

  if (isConfigured()) {
    els.signInBtn.disabled = false;
    els.signInBtn.hidden = true;
    whenGisReady(() => {
      debugLog('whenGisReady -> initAuth() 呼び出し');
      initAuth(onSignedIn, onSignInFailed);
      // ページ読み込み直後(ユーザー操作なし)にrequestAccessTokenを呼ぶとポップアップブロックの
      // 対象になりやすいため、最初のタップ/クリックのタイミングに合わせてサイレント試行する。
      armAutoSignInOnFirstGesture();
    });
  } else {
    openSettings();
  }

  els.signInBtn.addEventListener('click', () => {
    debugLog('signInBtn クリック');
    signIn();
  });
  els.signOutBtn.addEventListener('click', () => {
    signOut();
    toggleAuthUI(false);
    stopGroupViewing(); // サインアウト後もタイマーが回り続けてAPIを呼び続けないようにする
    setStatus('サインアウトしました');
  });
  // ボトムツールバーの各ボタンは、いずれも最終的にstate.cards/sessionsを前提にした
  // カード作成へつながるため、withMainData()でメインデータの読み込みを待ってから実行する
  // (2026年9月追加、「サインイン→すぐAlmagestで読書」の通信量最小化のためonSignedIn()を
  // 2段階に分けたことに伴う対応。ensureMainDataLoaded()のコメント参照)。
  els.toolUpload.addEventListener('click', () => withMainData(() => els.imageInput.click()));
  els.imageInput.addEventListener('change', handleImageSelected);
  els.retryUploadInput = document.getElementById('retry-upload-input');
  if (els.retryUploadInput) els.retryUploadInput.addEventListener('change', handleRetryUploadSelected);
  els.toolCamera.addEventListener('click', () => withMainData(() => handleOpenCamera('photo')));
  els.toolText.addEventListener('click', () => withMainData(handleOpenTextTool));
  els.toolVideo.addEventListener('click', () => withMainData(() => handleOpenCamera('video')));
  els.toolAudio.addEventListener('click', () => withMainData(() => handleOpenCamera('audio')));
  els.toolSession.addEventListener('click', () => withMainData(handleCreateSession));
  els.toolInfo.addEventListener('click', () => withMainData(createInfoCard));
  els.toolSummary.addEventListener('click', () => withMainData(() => createSummaryCard()));
  els.toolStreetview.addEventListener('click', () => withMainData(createStreetviewCard));
  els.toolKeypad.addEventListener('click', () => { if (window.openModuleKeypad) window.openModuleKeypad(); });
  els.infoTicker.addEventListener('click', () => {
    const card = infoTickerItems[infoTickerIndex];
    if (card) jumpToInfoCard(card);
  });

  // CONSTELLATION PIE(長押しメニュー)は使用頻度が低いというユーザー判断により無効化した
  // (2026年9月)。isEnabledを常にfalseにするだけで、コード自体は削除せず残してある
  // (「また必要だと思ったら言う」とのことなので、いつでもtrueに戻せるようにしておく)。
  // PIE内にしか無かった「キーパッド」項目は、上のtoolKeypadボタンとしてボトムツールバーへ
  // 常設したため機能的な代替は確保済み。
  initPieMenu(els.viewport, buildPieTools, () => false);

  els.viewport.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  els.viewport.addEventListener('drop', handleViewportDrop);

  initTextSearchPopup();
});

/* ---------------- CONSTELLATION PIE用のツール一覧(既存ボトムバーの項目を流用) ----------------
 * PIE自体は使用頻度が低いというユーザー判断により無効化されている(initPieMenu()の
 * isEnabledを常にfalseにしているだけ、2026年9月)。buildPieTools()はその無効化されたPIEが
 * 万一再度有効化された時のために残してある。かつてここにあった「キーパッド」項目は、
 * ボトムツールバーの#tool-keypadへ常設で移設したため削除した(PCでの入口を失わないため)。
 */
function buildPieTools() {
  return [
    { label: 'アップロード', icon: els.toolUpload.querySelector('svg').outerHTML, action: () => els.imageInput.click() },
    { label: 'カメラ', icon: els.toolCamera.querySelector('svg').outerHTML, action: () => handleOpenCamera('photo') },
    { label: 'テクスト', icon: els.toolText.querySelector('svg').outerHTML, action: handleOpenTextTool },
    { label: '動画撮影', icon: els.toolVideo.querySelector('svg').outerHTML, action: () => handleOpenCamera('video') },
    { label: '音声録音', icon: els.toolAudio.querySelector('svg').outerHTML, action: () => handleOpenCamera('audio') },
  ];
}

function openSettings() {
  els.settingsClientId.value = CONFIG.GOOGLE_CLIENT_ID;
  els.settingsApiKey.value = CONFIG.GEMINI_API_KEY;
  els.settingsError.hidden = true;
  els.settingsCancelBtn.hidden = !isConfigured();
  els.settingsCloseBtn.hidden = !isConfigured(); // 初回の必須設定中はキャンセル同様、閉じる手段を出さない
  els.settingsModal.classList.add('visible');
}

function closeSettings() {
  els.settingsModal.classList.remove('visible');
}

/**
 * 「OCRか手入力か」のような、両方とも意味のある選択肢が並ぶ二択を出す汎用ダイアログ。
 * window.confirm()だと「OK」「キャンセル」という固定のボタン名しか使えず、
 * 「キャンセルすると手入力になる」のように片方の選択肢がキャンセルに割り当てられてしまい
 * 分かりにくい、というユーザー指摘(2026年9月)を受けて置き換えた。各選択肢は全て
 * ラベル付きの対等なボタンとして並べ、背景クリックだけを「何も選ばない」という本当の意味での
 * キャンセルとして扱う(その場合はnullを返す)。settings-modalと同じ.modal-overlay/.modalの
 * 見た目を流用しつつ、内容は呼び出しごとに動的に組み立てる。
 * @param {{title: string, message?: string, options: {label: string, value: string, secondary?: boolean, danger?: boolean}[]}} params
 *   message: タイトル下に添える補足文(OCR結果のプレビューなど)。改行はそのまま保持して表示する。
 *   danger: 元に戻せない破壊的な選択肢であることを示す赤系の強調ボタンにする(2026年9月追加。
 *   Extractで「OK/キャンセル」の分かりにくさが原因でユーザーが誤って写真を完全に失う実機報告が
 *   あったため、選択肢自体を対等なラベル付きボタンにするだけでなく、破壊的な方だけ見た目でも
 *   区別できるようにした)。
 * @returns {Promise<string|null>}
 */
/**
 * 背景タップ(クリック)で閉じるオーバーレイの共通ヘルパー(2026年9月追加)。単純な`click`
 * イベントの`e.target===backgroundEl`判定だと、スマホでパネル内をスクロール/操作しようと
 * した指がわずかに背景へ流れただけでもclickが発火し、意図せず閉じてしまう不具合があった
 * (Astrometry Scopeでの実機報告を受けて発覚)。pointerdown・pointerupの両方が背景要素
 * 自身で、かつ移動距離が小さい(タップ相当)場合だけ閉じるようにする。オーバーレイ/モーダル/
 * キーパッド等、「背景をタップしたら閉じる」を実装する箇所は全てこのヘルパーを使うこと。
 */
function attachBackgroundTapToClose(backgroundEl, onClose) {
  let start = null;
  backgroundEl.addEventListener('pointerdown', (e) => {
    start = e.target === backgroundEl ? { x: e.clientX, y: e.clientY } : null;
  });
  backgroundEl.addEventListener('pointerup', (e) => {
    if (!start) return;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    start = null;
    if (moved < 10 && e.target === backgroundEl) onClose();
  });
}

function showChoiceDialog({ title, message, options }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const heading = document.createElement('h2');
    heading.textContent = title;
    modal.appendChild(heading);
    if (message) {
      const desc = document.createElement('p');
      desc.className = 'modal-desc';
      desc.style.whiteSpace = 'pre-wrap';
      desc.textContent = message;
      modal.appendChild(desc);
    }
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    modal.appendChild(actions);
    overlay.appendChild(modal);

    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      if (opt.secondary) btn.className = 'secondary';
      if (opt.danger) btn.classList.add('danger');
      btn.addEventListener('click', () => finish(opt.value));
      actions.appendChild(btn);
    });
    attachBackgroundTapToClose(overlay, () => finish(null));

    document.body.appendChild(overlay);
  });
}

/**
 * テキスト媒体(テクストカード・コメント・座談会の発言・各カードのメモ欄・インフォの本文欄)を
 * ドラッグ選択した時に「Googleで検索」ポップアップを出す(2026年9月追加)。js/canvas.jsが
 * キャンバス全体でcontextmenuをpreventDefault()しているため、OS標準の「Web検索」メニューが
 * 出せない(ドラッグ選択自体はできるが、選んだ文字列を検索する手段が無かった)。
 * textarea(メモ欄・テクストカード・インフォの本文欄)はselectionStart/Endで、それ以外
 * (座談会・コメントの発言、document Selection APIで選択するもの)はgetSelection()で
 * 選択文字列を取り、pointerupの座標の近くにポップアップを出す。
 */
const TEXT_SEARCH_SELECTABLE_SELECTOR =
  '.star-card-memo, .star-card-info-text, .star-card-chat-text, .star-card-chat-question, .star-card-comment-text';

function getTextSearchSelection(event) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(TEXT_SEARCH_SELECTABLE_SELECTOR)) return '';
  if (target.tagName === 'TEXTAREA') {
    const { selectionStart, selectionEnd, value } = target;
    return selectionStart == null || selectionStart === selectionEnd ? '' : value.slice(selectionStart, selectionEnd);
  }
  const sel = document.getSelection();
  return sel && !sel.isCollapsed ? sel.toString() : '';
}

function hideTextSearchPopup() {
  if (els.textSearchPopup) els.textSearchPopup.hidden = true;
}

function showTextSearchPopup(text, x, y) {
  if (!els.textSearchPopup) return;
  els.textSearchPopup.dataset.query = text;
  const margin = 12;
  const clampedX = Math.min(Math.max(x, margin), window.innerWidth - margin);
  const clampedY = Math.max(y, 40);
  els.textSearchPopup.style.left = `${clampedX}px`;
  els.textSearchPopup.style.top = `${clampedY}px`;
  els.textSearchPopup.hidden = false;
}

function initTextSearchPopup() {
  els.textSearchPopup = document.getElementById('text-search-popup');
  els.textSearchPopupBtn = document.getElementById('text-search-popup-btn');
  if (!els.textSearchPopup || !els.textSearchPopupBtn) return;

  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('#text-search-popup')) hideTextSearchPopup();
  });

  document.addEventListener('pointerup', (event) => {
    if (event.target.closest('#text-search-popup')) return; // ポップアップ自身の操作は無視
    // pointerup時点ではブラウザの選択確定(特にタッチ)がまだ済んでいないことがあるため、
    // 次のタスクへ回してから判定する。
    setTimeout(() => {
      const text = getTextSearchSelection(event).trim();
      if (text) showTextSearchPopup(text, event.clientX, event.clientY);
      else hideTextSearchPopup();
    }, 0);
  });

  els.textSearchPopupBtn.addEventListener('click', () => {
    const query = els.textSearchPopup.dataset.query || '';
    hideTextSearchPopup();
    if (!query) return;
    window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank', 'noopener');
  });
}

function handleSettingsSave() {
  const clientId = els.settingsClientId.value.trim();
  const apiKey = els.settingsApiKey.value.trim();
  if (!clientId || !apiKey) {
    els.settingsError.textContent = 'クライアントIDとAPIキーの両方を入力してください';
    els.settingsError.hidden = false;
    return;
  }
  saveUserConfig({ clientId, apiKey });
  closeSettings();
  els.signInBtn.disabled = false;
  whenGisReady(() => initAuth(onSignedIn));
  setStatus('設定を保存しました。「Googleでサインイン」を押してください');
}

/** Google Identity Services のスクリプト(非同期読み込み)が使えるようになるまで待つ */
let gisWaitCount = 0;
function whenGisReady(callback) {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    debugLog('GIS ready (待ち回数=' + gisWaitCount + ')');
    callback();
  } else {
    gisWaitCount++;
    if (gisWaitCount === 1 || gisWaitCount % 20 === 0) {
      debugLog('GIS 待機中... (待ち回数=' + gisWaitCount + ', window.google=' + typeof window.google + ')');
    }
    setTimeout(() => whenGisReady(callback), 100);
  }
}

/** 起動時の自動サイレントサインインが失敗した場合(未ログイン・未同意など)。手動サインインボタンを出す。 */
function onSignInFailed() {
  debugLog('onSignInFailed() 呼び出し');
  els.signInBtn.hidden = false;
  setStatus('「Googleでサインイン」を押してください');
}

/**
 * ページ読み込み直後(ユーザー操作なし)にGISのrequestAccessTokenを呼ぶと、ブラウザの
 * ポップアップブロッカーに阻止されて誤動作しやすい。そのため、画面への最初のタップ/クリック
 * (どこでもよい)を合図に1回だけサイレントサインインを試みる。既に同意済み・ログイン中なら
 * ポップアップなしで完了し、未ログインならその1回のタップに紐づく形で正規の同意ポップアップが開く。
 */
let autoSignInArmed = false;
function armAutoSignInOnFirstGesture() {
  if (autoSignInArmed) return;
  autoSignInArmed = true;
  const trigger = () => {
    debugLog('初回タップでサイレントサインインを試行');
    signIn(true);
    // iOS等はAudioContextの生成/再開がユーザー操作に直接紐づいていないと無音になる。
    // 個々のジェスチャー内でも解錠しているが、ここでも保険として解錠しておく。
    soundAudioCtx();
  };
  document.addEventListener('pointerdown', trigger, { capture: true, once: true });
}

function toggleAuthUI(signedIn) {
  els.signInBtn.hidden = signedIn;
  els.signOutBtn.hidden = !signedIn;
  if (els.driveQuotaBtn && !signedIn) els.driveQuotaBtn.hidden = true; // サインアウト後は表示を消す(古い数値を残さない)
  els.toolUpload.disabled = !signedIn;
  els.toolCamera.disabled = !signedIn;
  els.toolText.disabled = !signedIn;
  els.toolVideo.disabled = !signedIn;
  els.toolAudio.disabled = !signedIn;
  els.toolSession.disabled = !signedIn;
  els.toolInfo.disabled = !signedIn;
  els.toolSummary.disabled = !signedIn;
  els.toolStreetview.disabled = !signedIn;
  els.toolKeypad.disabled = !signedIn;
  if (els.exifMatchBtn) els.exifMatchBtn.disabled = !signedIn;
}

// エラーなど「読めるまで消えてほしくない」ステータスを出した直後は、オートセーブなどの
// 定型メッセージがすぐ上書きしてしまわないよう、一定時間だけ保護する。
let importantStatusUntil = 0;
const IMPORTANT_STATUS_HOLD_MS = 6000;

/**
 * @param {string} message
 * @param {{important?: boolean, busy?: boolean, progress?: number}} [opts]
 *   busy: 所要時間が読めない処理中であることを示す(ヘッダー下の進行バーを不定表示にする)
 *   progress: 0〜1の実際の割合が分かる処理で指定する(指定するとbusyより優先され、実測の幅で表示する)
 *   どちらも指定しない呼び出し(=完了・失敗メッセージ)では、進行バーは自動的に消える。
 */
function setStatus(message, opts) {
  if (!opts?.important && Date.now() < importantStatusUntil) return;
  els.status.textContent = message;
  if (opts?.important) importantStatusUntil = Date.now() + IMPORTANT_STATUS_HOLD_MS;
  updateStatusProgress(opts);
}

function updateStatusProgress(opts) {
  const hasProgress = typeof opts?.progress === 'number';
  const showing = hasProgress || Boolean(opts?.busy);
  els.statusProgress.hidden = !showing;
  if (!showing) return;
  if (hasProgress) {
    els.statusProgress.classList.remove('indeterminate');
    els.statusProgressBar.style.width = `${Math.max(0, Math.min(1, opts.progress)) * 100}%`;
  } else {
    els.statusProgress.classList.add('indeterminate');
  }
}

/**
 * 設定モーダル内の「☁ Driveへ送信」ボタン(js/upload-queue.js)の表示を今の状態に合わせる。
 * 待機列の増減時にその都度呼ばれる。**2026年9月、Driveアップロードの完全手動化に伴い刷新**:
 * 通信種別の表示は撤去し、待機件数だけを見せる。送信中(driveUploadInFlight)は件数表示を
 * 上書きせず、handleDriveUploadBtnClick()が管理する「■ 停止(残りN件)」の表示を優先する。
 */
let driveUploadInFlight = false;

function updateDriveUploadButton() {
  if (!els.driveUploadBtn) return;
  if (driveUploadInFlight) {
    uploadQueueCount().then((count) => {
      els.driveUploadBtn.textContent = `■ 停止(残り${count}件)`;
    });
    return;
  }
  uploadQueueCount().then((count) => {
    els.driveUploadBtn.textContent = count > 0 ? `☁ Driveへ送信(${count}件)` : '☁ Driveへ送信';
    els.driveUploadBtn.disabled = count === 0;
  });
  updateExportToPhotosButton();
}

function setDriveUploadStatus(text, isError) {
  if (!els.driveUploadStatus) return;
  els.driveUploadStatus.hidden = false;
  els.driveUploadStatus.textContent = text;
  els.driveUploadStatus.classList.toggle('modal-error', Boolean(isError));
}

/**
 * 設定モーダルの「☁ Driveへ送信」ボタンのクリックハンドラ。押した時だけDriveへ実際に
 * 送信する(2026年9月、通信種別の自動判定・自動アップロードを完全撤去した結果、この
 * ボタンが唯一のDrive送信経路になった)。
 * **モバイル回線のまま誤って押してしまった場合の保険(2026年9月追加)**: 送信中はボタン自体が
 * 「■ 停止」に変わり、押すとcancelDriveUpload()(js/upload-queue.js)がAbortController経由で
 * 進行中のfetch()を即座に中断する。中断されたファイルは待機列に残るので、後で改めて送信できる。
 */
async function handleDriveUploadBtnClick() {
  if (!els.driveUploadBtn) return;
  if (driveUploadInFlight) {
    cancelDriveUpload(); // js/upload-queue.js
    setDriveUploadStatus('停止しています…');
    return;
  }
  driveUploadInFlight = true;
  updateDriveUploadButton();
  setDriveUploadStatus('送信中…');
  try {
    const { attempted, remaining, cancelled } = await drainUploadQueue(); // js/upload-queue.js
    if (cancelled) {
      setDriveUploadStatus(`停止しました(残り${remaining}件、いつでも再開できます)`);
    } else if (attempted === 0) {
      setDriveUploadStatus('送るものはありません');
    } else if (remaining === 0) {
      setDriveUploadStatus(`${attempted}件をDriveへ送信しました`);
    } else if (remaining > 0) {
      setDriveUploadStatus(`一部失敗しました(残り${remaining}件、もう一度お試しください)`, true);
    } else {
      setDriveUploadStatus('送信中にエラーが発生しました', true);
    }
  } finally {
    driveUploadInFlight = false;
    updateDriveUploadButton();
  }
}

/**
 * Drive未送信の写真・動画・音声を端末側(写真アプリ等)へ保存するボタン(js/upload-queue.js)の
 * 表示更新。対象が1件も無い間は、押しても意味が無いため非表示にしておく。
 */
function updateExportToPhotosButton() {
  if (!els.exportToPhotosBtn) return;
  uploadQueuePhotoExportableCount().then((count) => {
    els.exportToPhotosBtn.hidden = count === 0;
    els.exportToPhotosBtn.textContent = `📤 端末へ保存(${count}件)`;
  });
}

async function handleExportToPhotos() {
  const result = await exportPendingUploadsToPhotos(); // js/upload-queue.js
  if (result === 'shared') {
    setStatus('共有シートから保存先を選んでください', { important: true });
  } else if (result === 'empty') {
    setStatus('Drive未送信の写真・動画・音声はありません');
  } else if (result === 'unsupported') {
    setStatus('この端末・ブラウザは共有機能に対応していません', { important: true });
  } else if (result === 'error') {
    setStatus('端末への共有に失敗しました', { important: true });
  }
  // 'cancelled'(ユーザーが共有シートを閉じただけ)は何も表示しない
  // **2026年9月の不具合修正**: 以前はここでボタンの表示を更新しておらず、
  // exportPendingUploadsToPhotos()内でcard.deviceSavedを立てても、たまたま他の操作で
  // updateDriveUploadButton()(内部でupdateExportToPhotosButton()も呼ぶ)が走るまで
  // 「📤 端末へ保存(1件)」の件数表示が減らないままだった(リロードしても直らないように見える
  // 実機報告があった)。共有直後に必ず件数表示を更新する。
  updateExportToPhotosButton();
}

/**
 * 写真カード左上の状態バッジ2種(「☁ Drive未送信」「📵 端末未保存」)の表示を更新する。
 * 2026年9月、Driveアップロードの手動化に合わせて、CSSの::afterによる単一バッジから、
 * 互いに独立してon/offできる実要素の2バッジ構成に作り直した(js/app.jsのrenderCard()で
 * .star-card-status-badges内に両方の<span>を常に用意しておき、ここでtext/hiddenだけ操る)。
 * 呼び出しどころ: renderCard()初期表示時、Drive送信の成功/失敗/中断時、端末への保存成功時、
 * restoreUploadQueueOnLoad()で状態を補正した時。
 */
const DEVICE_BADGE_MEDIA_TYPES = ['image', 'video', 'audio'];

function updateCardStatusBadges(el, card) {
  const driveBadge = el.querySelector('.star-card-badge--drive');
  const deviceBadge = el.querySelector('.star-card-badge--device');
  if (driveBadge) {
    if (card.imageFileId) {
      driveBadge.hidden = true;
    } else if (card.uploadFailed) {
      driveBadge.hidden = false;
      driveBadge.textContent = '⚠ Drive未送信(失敗・タップで再試行)';
      driveBadge.classList.add('star-card-badge--urgent');
      driveBadge.style.cursor = 'pointer';
      driveBadge.title = '同じ写真・動画・音声を選び直して、もう一度送信できるようにします';
    } else if (card.uploadPending) {
      driveBadge.hidden = false;
      driveBadge.textContent = '⏳ Drive送信中…';
      driveBadge.classList.remove('star-card-badge--urgent');
      driveBadge.style.cursor = '';
      driveBadge.title = '';
    } else {
      driveBadge.hidden = false;
      driveBadge.textContent = '☁ Drive未送信';
      driveBadge.classList.remove('star-card-badge--urgent');
      driveBadge.style.cursor = '';
      driveBadge.title = '';
    }
  }
  if (deviceBadge) {
    const exportable = DEVICE_BADGE_MEDIA_TYPES.includes(card.mediaType);
    deviceBadge.hidden = !exportable || Boolean(card.deviceSaved);
  }
}

/**
 * ヘッダーのDriveストレージ使用量表示(2026年9月追加)。about.get()はdrive.fileスコープの
 * ままでも呼べる(アカウント全体の集計値であり、個々のファイル一覧を返すものではないため)。
 * サインイン時と、ボタン自体をタップした時(手動更新)に呼ぶ。
 */
function formatBytesGB(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

async function refreshDriveQuota() {
  if (!els.driveQuotaBtn || !state.folderId) return;
  try {
    const quota = await getDriveStorageQuota();
    const usage = Number(quota.usage || 0);
    const usageInDrive = Number(quota.usageInDrive || 0);
    const limit = quota.limit ? Number(quota.limit) : null; // Workspaceの無制限プラン等ではlimitが無い
    els.driveQuotaBtn.textContent = limit
      ? `💾 ${formatBytesGB(usage)} / ${formatBytesGB(limit)} GB`
      : `💾 ${formatBytesGB(usage)} GB使用中`;
    els.driveQuotaBtn.title = `タップで更新(Driveのみ: ${formatBytesGB(usageInDrive)} GB。表示はGoogleアカウント全体の合計で、Gmail・フォト等も含みます)`;
    els.driveQuotaBtn.hidden = false;
  } catch (err) {
    console.error(err);
    debugLog('Drive容量の取得に失敗: ' + err.message);
    // 失敗時は前回表示があればそのまま残し、無ければ何も表示しない(取得できないだけで
    // アプリの他の機能に影響は無いため、目立つエラー表示はしない)。
  }
}

/* ---------------- オートセーブ(手動の保存ボタンは廃止し、変更のたびに自動保存する) ----------------
 * 2026年9月、写真データ喪失の徹底精査を受けて以下を強化した:
 *   - 保存中フラグ(saveInFlight)を設け、保存に時間がかかっている間に別の変更が入っても
 *     並行して2つのhandleSave()を走らせない。代わりに完了後にもう一度、その時点の最新state
 *     で保存し直す(saveQueued)。これが無いと、後から始まった保存(新しい変更を含む)が先に
 *     完了し、後で完了した古い保存が新しいデータを上書きしてしまうレースが起こりうる。
 *   - pendingSaveフラグで「まだDriveに反映されていない変更があるか」を追跡し、
 *     visibilitychangeでページがバックグラウンドになった瞬間・beforeunloadでページを
 *     離れようとした瞬間に、デバウンス(1.2秒)を待たず即座に保存を試みる。iOS Safariは
 *     バックグラウンドタブのプロセスをある程度の時間経過後に終了させることがあるため、
 *     隠れた直後に保存を始めておくことで、プロセスが終了する前に間に合わせやすくする。
 */

const AUTO_SAVE_DELAY_MS = 1200; // 連続した変更(タイピング等)をまとめて1回の保存にする
let autoSaveTimer = null;
let pendingSave = false; // まだDriveへ反映されていない変更があるか
let saveInFlight = false; // handleSave()/handleLocalBackupSave()が今まさに実行中か
let saveQueued = false; // 実行中の保存が終わったら、最新stateでもう一度保存すべきか

/* ---------------- オフライン検知・オートセーブとの連動(2026年9月) ----------------
 * 以前は「📡 オートセーブ: ON/OFF」という手動トグルボタンをヘッダーに常設していたが、
 * 他の状態表示ボタン(Drive容量・オフライン中インジケーター等)が増えてヘッダーが煩雑に
 * なってきたこと、そして何より**切り替え忘れ**(オンラインに戻ったのにOFFのままで未保存が
 * 溜まり続ける)という取りこぼしのリスクがあったことから、ユーザー判断で手動トグルを廃止し、
 * 「オンライン中は常時オートセーブ、オフライン中(Wi-Fi・モバイル通信ともに端末側でOFFにして
 * いる状態)は自動的に止まる」という接続状態そのものへの連動に置き換えた。
 *
 * これはjs/upload-queue.jsのDriveアップロードで採用していた「通信種別(Wi-Fi/モバイル)の
 * 自動判定」とは性質が異なる点に注意: あちらはnavigator.connection(Chrome系のみ・iOS Safari
 * には存在しない非標準API)で「Wi-Fiかモバイルか」を判定しようとして、iOS Safariでは判定
 * できず「最後に手動で切り替えた状態」がlocalStorageに何日も残り続け、気づかないまま
 * モバイル回線で送信され続けた実機事故(3日間で計0.87GB消費)につながった。今回使う
 * navigator.onLineは、Wi-Fi/モバイルの種別ではなく「OSレベルでそもそもネットワーク経路が
 * 有効か」だけを見る、iOS Safariを含めて広くサポートされた基本的なAPIであり、
 * 「Wi-Fiもモバイルも端末で手動オフにする」というユーザーの運用(機内モード相当)を
 * 確実に検出できる。既知の限界(Wi-Fiに繋がっているが実際にはインターネットに出られない
 * 状況までは判定できない)はあるが、その場合でも実際のDrive呼び出しが失敗するだけで、
 * 既存のフォールバック(saveLocalDataBackup()、失敗時も実データは必ず端末に残る設計)が
 * そのまま効くため、被害が出ない。 */

function updateAutoSaveFromConnectivity() {
  state.autoSaveEnabled = navigator.onLine;
}

/** online/offlineイベント共通のハンドラ。オフライン→オンラインへ復帰した瞬間は、
 *  それまで端末内にだけ溜まっていた変更を即座にDriveへ反映する(以前の手動トグルをONに
 *  した時と同じ作法)。 */
function handleConnectivityChange() {
  const wasEnabled = state.autoSaveEnabled;
  updateAutoSaveFromConnectivity();
  updateOfflineIndicator();
  if (state.autoSaveEnabled && !wasEnabled && state.folderId) {
    saveImmediately();
  }
}

/* ---------------- オフライン中インジケーター(2026年9月追加) ----------------
 * 「通信量節約のための導線」というユーザー要望への対応。navigator.onLine + online/offline
 * イベントだけを見る単純な実装で、**このバッジ自体の表示/クリックが何かを自動的に止めたり
 * 送ったりすることは一切ない**(あくまで表示・説明のみ)。同じnavigator.onLineの変化は、
 * 上記のオートセーブ連動(handleConnectivityChange())からも見られているが、あちらは
 * 「自動的に何かを送信する」のではなく逆に「オフライン中は送信を止める」安全側の連動であり、
 * 両者とも間違えた時の実害が小さい(通信量を無駄に消費したりデータを失ったりしない)ことを
 * 確認した上で自動化している点は共通(js/upload-queue.jsのDriveアップロードで、通信種別の
 * 自動判定を採用して実機事故を起こした反省、CLAUDE.md参照)。
 */
function updateOfflineIndicator() {
  if (!els.offlineIndicatorBtn) return;
  els.offlineIndicatorBtn.hidden = navigator.onLine;
}

/** ステータス欄は1行で省略される(長文向きではない)ため、詳しい説明は簡易ダイアログで見せる。 */
function handleOfflineIndicatorClick() {
  showChoiceDialog({
    title: '📡 オフライン中',
    message:
      'カード・セッションの閲覧、Almagestで既に読み込んだ本(Boy/Professorの要約を含む)は' +
      '引き続き読めます。\n\n' +
      '新規のOCR・要約生成・座談会・Astrometry Scope等、Geminiを呼ぶ操作にはオンラインへの' +
      '復帰が必要です。\n\n' +
      'カードの追加・編集自体は今のまま行えます。Driveへの保存・送信はオンラインに戻り次第、' +
      '自動的に反映されます(操作した内容が失われることはありません)。',
    options: [{ label: '閉じる', secondary: true }],
  });
}

function scheduleAutoSave() {
  // クイックモード中(state.quickMode)は、メインデータを読み込んでいない軽量な状態なので、
  // 通常のmainDataLoadedゲートより先にこちらを見る。Driveのメインファイルには一切触れず、
  // IndexedDBのクイックバンドルへだけ保存する(runScheduledSave()参照)。
  if (state.quickMode) {
    pendingSave = true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(runScheduledSave, AUTO_SAVE_DELAY_MS);
    return;
  }
  // サインイン前、またはメインデータ(state.cards/sessions等)をまだ読み込んでいない間は
  // 何もしない。**mainDataLoadedのチェックは安全上必須**: 2026年9月にonSignedIn()を
  // 「Almagestだけ先に使える」フェーズと「メインデータの読み込み(ensureMainDataLoaded())」
  // フェーズへ分割した際、後者が完了する前にこの関数が万が一呼ばれてしまうと、まだ空の
  // state.cards/sessionsでDrive上のconstellation-data.jsonを上書きしてしまいかねない
  // (=これまでの記録が丸ごと消える最悪のケース)。個々の呼び出し元をすべて洗い出して
  // ensureMainDataLoaded()で塞ぐことに加えて、ここでも二重に防ぐ。
  if (!state.folderId || !mainDataLoaded) return;
  pendingSave = true;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(runScheduledSave, AUTO_SAVE_DELAY_MS);
}

/** デバウンスを待たず、今すぐ保存する(新規カード追加など、タブが閉じられる前に必ず
 *  残しておきたい変更で使う)。scheduleAutoSave()と同じ安全上の理由でmainDataLoaded/
 *  quickModeも見る。 */
function saveImmediately() {
  if (state.quickMode) {
    pendingSave = true;
    clearTimeout(autoSaveTimer);
    runScheduledSave();
    return;
  }
  if (!state.folderId || !mainDataLoaded) return;
  pendingSave = true;
  clearTimeout(autoSaveTimer);
  runScheduledSave();
}

async function runScheduledSave() {
  if (saveInFlight) {
    saveQueued = true; // 今の保存が終わり次第、最新stateでもう一度保存する
    return;
  }
  saveInFlight = true;
  try {
    // クイックモード中は、Driveのメインファイルにもオートセーブのローカルバックアップにも
    // 触れず、専用のクイックバンドル(IndexedDB)へだけ保存する(js/upload-queue.js参照)。
    // メインデータを読み込んでいない軽量な状態でhandleSave()/handleLocalBackupSave()を
    // 呼ぶと、まだ空のstate.cards/sessionsで既存の記録を上書きしてしまう危険があるため、
    // 他の分岐より先に判定する。
    if (state.quickMode) {
      await handleQuickModeSave();
      return;
    }
    // オートセーブOFF中はDriveへ送らず、端末内(IndexedDB)へのバックアップに留める
    // (js/upload-queue.jsのsaveLocalDataBackup()参照、モバイル通信量節約のため2026年9月追加)。
    if (state.autoSaveEnabled) {
      await handleSave();
    } else {
      await handleLocalBackupSave();
    }
  } finally {
    saveInFlight = false;
    if (saveQueued) {
      saveQueued = false;
      runScheduledSave();
    } else {
      pendingSave = false;
    }
  }
}

// ページが隠れる(タブ切り替え・ホーム画面へ戻る等)瞬間に、保存待ちがあれば即座に走らせる。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && pendingSave) {
    clearTimeout(autoSaveTimer);
    runScheduledSave();
  }
});

// ページを閉じよう/離れようとした時、まだDriveへ反映されていない変更が残っていれば
// ブラウザ標準の確認ダイアログを出す(モバイルSafari等では効かないこともあるが、
// PCブラウザでの誤操作防止として有効)。
window.addEventListener('beforeunload', (e) => {
  if (pendingSave || saveInFlight) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/**
 * 2026年9月、電車内など「サインイン→すぐAlmagestで読書」だけで済ませたい場面での通信量を
 * 最小限にするため、onSignedIn()を2段階に分割した:
 *   フェーズ1(この関数、常に即座に実行): フォルダ解決(小さなJSON照会のみ)と、
 *     年セッションだけの軽量インデックス(constellation-years.json)の読み込みを行う。
 *   フェーズ2(ensureMainDataLoaded()/loadMainData()、必要になるまで呼ばない): カード・
 *     セッション全体(各カードのサムネイルをbase64で埋め込んだ、普段いちばん重い
 *     constellation-data.json)の読み込み。年タブ・ボトムツールバー・モジュールキーパッドの
 *     Almagest以外のコード等、実際にメインのキャンバスを触る操作をした時に初めて読み込む
 *     (呼び出し箇所は下記ensureMainDataLoaded()のコメント参照)。
 *
 * **2026年9月、スタートメニューを追加**: フェーズ1完了後、いきなりメインデータを読み込みに
 * 行くのではなく、まず「スタートメニュー」(クイックカメラ/クイックセッション/Almagest/
 * スタート)を開き、ユーザー自身にどの通信量で始めるかを選んでもらう(openStartMenu()参照)。
 *
 * **2026年9月、Almagestの書庫データ読み込みも遅延化**: 以前はこのフェーズ1で
 * `window.initAlmagestData()`を無条件に呼び、Almagestの専用ファイル(almagest-library.json、
 * サムネイル付きの本が多いとそれなりの容量になる)を毎回ダウンロードしていた。スタートメニュー
 * 導入後、クイックカメラ/クイックセッションを選ぶだけの場面でもこの通信が走ってしまい、
 * 「ログインからスタートメニュー表示までが長い」という実機報告があったため、この読み込みを
 * Almagestを実際に開く瞬間(`js/modules/almagest.js`の`openAlmagest()`/
 * `ensureAlmagestDataLoaded()`)まで遅延させ、ここからは呼ばないようにした。あわせて、
 * 互いに依存しない残り2つの読み込み(メディアフォルダ解決・年インデックス)は
 * `Promise.all()`で並行に行い、逐次待ちによる遅延も減らしている。
 *
 * **2026年9月、ロード画面をVOYAGER GOLDEN RECORDモチーフへ刷新**: 「ロード画面が業務的に見える」
 * というユーザー要望を受け、この関数の先頭で`showOpeningLoadingScreen()`を呼び、フォルダ解決・
 * 年インデックス読み込みが終わるまでの間、ゴールデンレコード(パルサーマップが走査するアニメ
 * ーション)を全画面に表示するようにした。処理が成功したら`openStartMenu()`が同じオーバーレイを
 * クイックメニューへクロスフェードし、失敗したら`closeStartMenu()`でオーバーレイごと引っ込めて
 * 既存のエラーステータス表示に譲る。通信が速い環境だとアニメーションが一瞬も見えないまま
 * 切り替わってしまうため、`MIN_LOADING_DISPLAY_MS`で最低限の表示時間だけ保証している(上記の
 * 「ログインからスタートメニュー表示までが長い」不具合とは無関係な、900ms程度のごく小さい待ち)。
 */
async function onSignedIn() {
  toggleAuthUI(true);
  showOpeningLoadingScreen();
  setStatus('Google Driveと同期中…', { busy: true });
  const loadingStartedAt = Date.now();
  const MIN_LOADING_DISPLAY_MS = 900;
  try {
    state.folderId = await findOrCreateAppFolder();
    const [mediaFolderId] = await Promise.all([
      findOrCreateSubfolder(CONFIG.MEDIA_FOLDER_NAME, state.folderId),
      loadYearsIndex(), // クイックカメラ/クイックセッションが「今年のセッション」を知るための軽量インデックス
    ]);
    state.mediaFolderId = mediaFolderId;
    refreshDriveQuota(); // ヘッダーのDrive使用量表示(メインデータ不要)
    setStatus('サインインしました');
    const elapsed = Date.now() - loadingStartedAt;
    if (elapsed < MIN_LOADING_DISPLAY_MS) await sleep(MIN_LOADING_DISPLAY_MS - elapsed);
    openStartMenu();
  } catch (err) {
    console.error(err);
    closeStartMenu();
    setStatus('同期に失敗しました(コンソールを確認)');
  }
}

/* ---------------- スタートメニュー・クイックカメラ・クイックセッション(2026年9月追加) ----------------
 * 「これまでは起動のたびにメインデータ(全セッション・全カードのサムネイル)を読み込んでいたが、
 * 個展を1件記録して帰るだけならその通信量は要らない」というユーザー要望への対応。
 * サインイン直後にこのメニューを出し、ユーザーが選んだ入口だけの通信量で始められるようにする。
 *
 *   - クイックカメラ: カメラだけをその場で開く(通信ゼロ)。撮影した瞬間だけ、【現在の年】
 *     セッションの下に新規セッションを作って格納する(この判定に必要な「今年のセッションID」は
 *     上記の軽量インデックスから分かる)。以降の追加撮影・編集はこの1セッション分の通信量で完結する。
 *   - クイックセッション: 【現在の年】の下に空の新規セッションを作ってすぐ中へ入る。
 *   - Almagest: 既存のフェーズ1のまま、そのまま開く(メインデータ不要)。
 *   - スタート: 今まで通りの全データ読み込み。
 *
 * クイックカメラ/クイックセッションで動いている間(state.quickMode)は、state.cards/sessionsが
 * 「今回新規に作った分だけ」の軽量な状態になる。この間の保存はDriveのメインファイルには一切
 * 触れず、IndexedDBのクイックバンドルに留める(scheduleAutoSave()/saveImmediately()参照)。
 * 実際にメインファイルへ書き戻されるのは、ユーザーが他のセッションへ移動しようとして
 * ensureMainDataLoaded()が呼ばれた瞬間(=「他セッションに移動した時に初めて全データを
 * 読み込む」というユーザー指定の境界)で、その時にメインデータへ追記の形でマージする
 * (mergeQuickBundlesIfAny()参照、削除・上書きは一切行わない)。
 */

/** 年セッションだけの軽量インデックス(constellation-years.json)を読み込む。無ければ
 *  (初回利用、または過去に一度もこのファイルが作られていない古いアカウント)、
 *  state.yearsIndexAvailable=falseのままにする。クイックカメラ/クイックセッションは、
 *  この値がtrueの時だけ「安全に今年のセッションIDが分かる」と判断して即座に動く。
 *  falseの場合は、安全側に倒して先にensureMainDataLoaded()(通常の全データ読み込み)へ
 *  フォールバックする(=重複した年セッションを作ってしまうリスクを避ける)。 */
async function loadYearsIndex() {
  state.yearsIndexAvailable = false;
  try {
    const { fileId, data } = await loadNamedData(state.folderId, CONFIG.YEARS_INDEX_FILE_NAME);
    // **fileIdを保持しておくこと(2026年9月バグ修正)**: 以前はdataだけ取り出しfileIdを
    // 捨てていたため、state.yearsIndexFileIdが既存ファイルからは一切設定されず、
    // saveYearsIndexMirror()が毎回既存ファイルへのPATCHではなく新規POSTを行い、サインインの
    // たびにconstellation-years.jsonが複製されてDrive上に増え続けていた
    // (findFileByName()がどれを拾うか不定になり、古いミラーを読んでしまうリスクもあった)。
    state.yearsIndexFileId = fileId || null;
    // **data===null(ファイル自体が無い)を「年セッション0件」として扱ってはいけない**:
    // このミラーファイルは今回の機能追加で新設したものなので、既にconstellation-data.jsonに
    // 年セッションが実在する既存アカウントでも、ミラーへ一度も保存していない間は同じく
    // data===nullになる。ここで「0件」と誤認して新しい年セッションを作ってしまうと、
    // 後でメインデータとマージした際に同じ年のセッションが重複してしまう。ファイルが
    // 見つからない場合は「まだ分からない」として安全側(yearsIndexAvailable=false)に倒し、
    // クイック系は一度だけ通常の全データ読み込みへフォールバックする。フォールバック後の
    // 保存(handleSave())でこのミラーが作られるため、次回以降はクイックに動ける。
    if (data && Array.isArray(data.years)) {
      // state.sessionsはまだ空(メインデータ未読み込み)のはずだが、念のため重複を避けて足す。
      const existingIds = new Set(state.sessions.map((s) => s.id));
      data.years.forEach((y) => {
        if (!existingIds.has(y.id)) state.sessions.push(y);
      });
      state.yearsIndexAvailable = true;
    }
  } catch (err) {
    console.error('年セッションの軽量インデックス読み込みに失敗', err);
    // 読み込み失敗時はyearsIndexAvailable=falseのまま(=クイック系はフォールバックする)
  }
}

// saveYearsIndexMirror()を最後に書き込んだ時点の年セッションの顔ぶれ(id一覧)。
// handleSave()は編集のたびに(デバウンス後、~1.2秒間隔で)呼ばれるが、年セッションの
// 顔ぶれは新しい年が増える時くらいしか変わらないため、変化が無ければ余計なDrive書き込みを
// 省く(2026年9月、コードレビューで指摘: 通信量節約が目的の機能なのに、無関係な編集のたびに
// 2つ目のDriveリクエストを追加で発生させてしまっていた)。
let lastSavedYearsSignature = null;

function currentYearsSignature() {
  return state.sessions.filter((s) => s.type === 'year').map((s) => s.id).sort().join(',');
}

/** handleSave()(メインデータの保存)成功後に呼ぶ、年セッションだけのミラーの書き戻し。
 *  失敗してもメインデータの保存自体には影響させない(ベストエフォート、次回のloadYearsIndex()で
 *  古い内容が残っていてもyearsIndexAvailableのフォールバックが安全側に効くため実害は小さい)。 */
async function saveYearsIndexMirror() {
  const signature = currentYearsSignature();
  if (signature === lastSavedYearsSignature) return; // 年セッションの顔ぶれに変化なし、書き込み不要
  try {
    const years = state.sessions.filter((s) => s.type === 'year');
    await saveNamedData(state.folderId, state.yearsIndexFileId, { years, updatedAt: Date.now() }, CONFIG.YEARS_INDEX_FILE_NAME)
      .then((id) => { state.yearsIndexFileId = id; });
    lastSavedYearsSignature = signature; // 成功した時だけ更新する(失敗時は次回また書き込みを試みる)
  } catch (err) {
    console.error('年セッションの軽量インデックス書き込みに失敗', err);
  }
}

let startMenuEls = null;
let startMenuCaptionTimer = null;

/** ボイジャーのゴールデンレコードのジャケットに刻まれたパルサーマップ(14個のパルサーとの
 *  相対方向・距離を線の角度・長さで示す図)を簡略化した放射線データ。ロード画面の円盤に
 *  これを重ね、走査するように順番に描いては消えるアニメーション(CSSの.start-menu-scan)を
 *  つける。角度・長さは実物からの厳密な引き写しではなく、雰囲気を借りた近似値。 */
const START_MENU_PULSARS = [
  { angle: -100, len: 100 }, { angle: -72, len: 84 }, { angle: -42, len: 112 },
  { angle: -12, len: 78 }, { angle: 14, len: 104 }, { angle: 44, len: 88 },
  { angle: 74, len: 118 }, { angle: 100, len: 86 }, { angle: 130, len: 98 },
  { angle: 158, len: 80 }, { angle: 188, len: 108 }, { angle: 218, len: 92 },
  { angle: 248, len: 116 }, { angle: 278, len: 84 },
];

/** ロード画面の一言。「Loading...」のような業務的な文言ではなく、ゴールデンレコード
 *  そのものの文脈(パルサーマップ・水素原子の超微細構造遷移=時間の基準単位・針を落とす
 *  =再生開始)から借りた一言を数秒おきに切り替える。 */
const START_MENU_CAPTIONS = [
  'パルサーマップを参照中…',
  '水素原子の振動を基準に…',
  '針を降ろしています…',
  '星々の位置を記録中…',
];

/** ロード画面中央のゴールデンレコード(円盤+パルサーマップ)をSVGで組み立てる。
 *  金は単色フラット塗り(グラデーションの光沢ハイライトは使わない)。 */
function buildStartMenuDiscSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 300');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const rotor = document.createElementNS(ns, 'g');
  rotor.setAttribute('class', 'start-menu-disc-rotor');

  const face = document.createElementNS(ns, 'circle');
  face.setAttribute('class', 'start-menu-disc-face');
  face.setAttribute('cx', '150'); face.setAttribute('cy', '150'); face.setAttribute('r', '118');
  rotor.appendChild(face);

  [100, 82, 64, 46].forEach((r) => {
    const groove = document.createElementNS(ns, 'circle');
    groove.setAttribute('class', 'start-menu-disc-groove');
    groove.setAttribute('cx', '150'); groove.setAttribute('cy', '150'); groove.setAttribute('r', String(r));
    rotor.appendChild(groove);
  });

  const spindle = document.createElementNS(ns, 'circle');
  spindle.setAttribute('class', 'start-menu-disc-spindle');
  spindle.setAttribute('cx', '150'); spindle.setAttribute('cy', '150'); spindle.setAttribute('r', '7');
  rotor.appendChild(spindle);

  const cx = 150, cy = 150;
  START_MENU_PULSARS.forEach((p, i) => {
    const rad = (p.angle * Math.PI) / 180;
    const x2 = (cx + Math.cos(rad) * p.len).toFixed(1);
    const y2 = (cy + Math.sin(rad) * p.len).toFixed(1);
    const delay = `${(i * 0.14).toFixed(2)}s`;

    const line = document.createElementNS(ns, 'line');
    line.setAttribute('class', 'start-menu-pulsar-line');
    line.setAttribute('x1', String(cx)); line.setAttribute('y1', String(cy));
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.style.animationDelay = delay;
    rotor.appendChild(line);

    const tip = document.createElementNS(ns, 'circle');
    tip.setAttribute('class', 'start-menu-pulsar-tip');
    tip.setAttribute('cx', x2); tip.setAttribute('cy', y2); tip.setAttribute('r', '2.2');
    tip.style.animationDelay = delay;
    rotor.appendChild(tip);
  });

  svg.appendChild(rotor);
  return svg;
}

function buildStartMenu() {
  const overlay = document.createElement('div');
  overlay.id = 'start-menu-overlay';
  overlay.className = 'start-menu-overlay';

  const loading = document.createElement('div');
  loading.className = 'start-menu-loading';
  loading.innerHTML = `
    <div class="start-menu-disc-wrap"></div>
    <div class="start-menu-wordmark">CONSTELLATION</div>
    <div class="start-menu-caption" id="start-menu-caption"></div>
  `;
  loading.querySelector('.start-menu-disc-wrap').appendChild(buildStartMenuDiscSvg());

  const menu = document.createElement('div');
  menu.className = 'start-menu-menu';
  menu.innerHTML = `
    <div class="start-menu-kicker">GOLDEN RECORD EDITION</div>
    <div class="start-menu-wordmark start-menu-wordmark--small">CONSTELLATION</div>
    <div class="start-menu-grid">
      <svg class="start-menu-links" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points="25,25 75,25 75,75 25,75 25,25"></polyline>
        <polyline points="25,25 75,75"></polyline>
        <polyline points="75,25 25,75"></polyline>
        <circle cx="25" cy="25" r="1.1"></circle>
        <circle cx="75" cy="25" r="1.1"></circle>
        <circle cx="75" cy="75" r="1.1"></circle>
        <circle cx="25" cy="75" r="1.1"></circle>
      </svg>
      <button class="start-menu-tile" id="start-menu-quick-camera">
        <span class="start-menu-tile-icon"><svg viewBox="0 0 48 48"><line x1="34" y1="8" x2="16" y2="30" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="34" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="30" r="2" fill="currentColor"/><path d="M9 33 A15 15 0 0 0 29 40" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.6"/></svg></span>
        <span class="start-menu-tile-label">STYLUS</span>
        <span class="start-menu-tile-desc">かるく、いま撮る</span>
      </button>
      <button class="start-menu-tile" id="start-menu-quick-session">
        <span class="start-menu-tile-icon"><svg viewBox="0 0 48 48"><path d="M11 35 C 17 30, 22 21, 31 9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-dasharray="2 3.4" opacity="0.65"/><path d="M31 9 L24 11 M31 9 L28 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="31" cy="9" r="2" fill="currentColor"/></svg></span>
        <span class="start-menu-tile-label">LAUNCH</span>
        <span class="start-menu-tile-desc">新しい航海をひらく</span>
      </button>
      <button class="start-menu-tile" id="start-menu-almagest">
        <span class="start-menu-tile-icon"><svg viewBox="0 0 48 48"><path d="M24 15 C 18 11, 10 11, 6 13 L6 34 C 10 32, 18 32, 24 36 C 30 32, 38 32, 42 34 L42 13 C 38 11, 30 11, 24 15 Z" fill="none" stroke="currentColor" stroke-width="1.3"/><line x1="24" y1="15" x2="24" y2="36" stroke="currentColor" stroke-width="1" opacity="0.5"/></svg></span>
        <span class="start-menu-tile-label">ALMAGEST</span>
        <span class="start-menu-tile-desc">書庫をひらく</span>
      </button>
      <button class="start-menu-tile" id="start-menu-start">
        <span class="start-menu-tile-icon"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="16" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="24" cy="24" r="10" fill="none" stroke="currentColor" stroke-width="1" opacity="0.6"/><circle cx="24" cy="24" r="4" fill="none" stroke="currentColor" stroke-width="1" opacity="0.6"/><circle cx="24" cy="24" r="1.4" fill="currentColor"/></svg></span>
        <span class="start-menu-tile-label">PLAYBACK</span>
        <span class="start-menu-tile-desc">すべての記録を開く</span>
      </button>
    </div>
    <div class="start-menu-footnote">SOUNDS · IMAGES · GREETINGS OF EARTH</div>
  `;

  overlay.appendChild(loading);
  overlay.appendChild(menu);
  document.body.appendChild(overlay);
  startMenuEls = { overlay, loading, menu, caption: loading.querySelector('#start-menu-caption') };

  menu.querySelector('#start-menu-quick-camera').addEventListener('click', handleQuickCameraStart);
  menu.querySelector('#start-menu-quick-session').addEventListener('click', handleQuickSessionStart);
  menu.querySelector('#start-menu-almagest').addEventListener('click', () => {
    closeStartMenu();
    if (window.openAlmagest) window.openAlmagest();
  });
  menu.querySelector('#start-menu-start').addEventListener('click', () => {
    closeStartMenu();
    withMainData(() => {});
  });
}

/** ロード中の一言(START_MENU_CAPTIONS)を数秒おきにクロスフェードで切り替える。
 *  クイックメニュー表示中・オーバーレイを閉じた後はstopStartMenuCaptionCycle()で止め、
 *  見えていない間もタイマーを回し続けないようにする。 */
function startStartMenuCaptionCycle() {
  stopStartMenuCaptionCycle();
  if (!startMenuEls) return;
  let idx = 0;
  startMenuEls.caption.textContent = START_MENU_CAPTIONS[0];
  startMenuEls.caption.style.opacity = 1;
  startMenuCaptionTimer = setInterval(() => {
    startMenuEls.caption.style.opacity = 0;
    setTimeout(() => {
      idx = (idx + 1) % START_MENU_CAPTIONS.length;
      startMenuEls.caption.textContent = START_MENU_CAPTIONS[idx];
      startMenuEls.caption.style.opacity = 1;
    }, 300);
  }, 2000);
}

function stopStartMenuCaptionCycle() {
  if (startMenuCaptionTimer) { clearInterval(startMenuCaptionTimer); startMenuCaptionTimer = null; }
}

/** サインイン直後、Google Driveとの同期(フォルダ解決・年インデックス読み込み)が終わるまでの
 *  間、ゴールデンレコードが走査するロード画面を表示する(onSignedIn()参照)。処理が完了したら
 *  openStartMenu()が同じオーバーレイをクイックメニューへクロスフェードする。 */
function showOpeningLoadingScreen() {
  if (!startMenuEls) buildStartMenu();
  startMenuEls.overlay.classList.add('open');
  startMenuEls.overlay.classList.add('phase-loading');
  startMenuEls.overlay.classList.remove('phase-menu');
  startStartMenuCaptionCycle();
}

/** クイックメニュー(STYLUS/LAUNCH/ALMAGEST/PLAYBACK)を表示する。ロード画面から続けて
 *  呼ばれた場合は同じオーバーレイ内でクロスフェードするが、キャンセル操作からの呼び出し
 *  (handleQuickSessionStart()等)やonAlmagestClosed()のように、オーバーレイが一度閉じた
 *  状態から呼ばれることも多いため、常に「クイックメニューを表示する」動作に固定してある
 *  (ロード画面へは戻さない)。 */
function openStartMenu() {
  if (!startMenuEls) buildStartMenu();
  stopStartMenuCaptionCycle();
  startMenuEls.overlay.classList.add('open');
  startMenuEls.overlay.classList.remove('phase-loading');
  startMenuEls.overlay.classList.add('phase-menu');
}

function closeStartMenu() {
  if (!startMenuEls) return;
  stopStartMenuCaptionCycle();
  startMenuEls.overlay.classList.remove('open');
}

/** js/modules/almagest.jsのcloseAlmagest()から呼ばれるフック(2026年9月追加)。
 *  スタートメニューからAlmagestだけを開いた場合、閉じた瞬間はまだメインデータを
 *  読み込んでおらずクイックモードにも入っていない(=キャンバスが空白のまま取り残される)
 *  ため、スタートメニューへ戻す。既にスタート/クイックのどちらかを選んで進んでいた場合
 *  (mainDataLoaded/state.quickModeのいずれかがtrue)は何もしない。 */
function onAlmagestClosed() {
  if (!mainDataLoaded && !state.quickMode) openStartMenu();
}
window.onAlmagestClosed = onAlmagestClosed;

/** 現在(端末のローカル日時)の西暦年。 */
function currentCalendarYear() {
  return new Date().getFullYear();
}

/**
 * 【現在の年】セッションを、メインデータを読み込まずに解決/作成する。
 * @returns {{ok: true, session: object} | {ok: false}} yearsIndexAvailableがfalseの場合は
 *   安全側に倒してok:falseを返す(呼び出し元はensureMainDataLoaded()へフォールバックすること)。
 */
function findOrCreateCurrentYearSessionQuick() {
  if (!state.yearsIndexAvailable) return { ok: false };
  const year = currentCalendarYear();
  let session = state.sessions.find((s) => s.type === 'year' && s.year === year);
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      type: 'year',
      parentId: null,
      name: String(year),
      year,
      createdAt: new Date().toISOString(),
    };
    state.sessions.push(session);
  }
  return { ok: true, session };
}

/** クイックカメラ/クイックセッション共通: 【現在の年】の下に新規セッションを作り、
 *  クイックモードへ入る。セッションカード(親=年セッション)も合わせて作る。 */
function startQuickSession(name) {
  const { session: yearSession } = findOrCreateCurrentYearSessionQuick();
  const session = {
    id: crypto.randomUUID(),
    type: 'session',
    parentId: yearSession.id,
    name,
    createdAt: new Date().toISOString(),
  };
  state.sessions.push(session);

  const spawnPos = newCardSpawnPos();
  const sessionCard = {
    id: crypto.randomUUID(),
    x: spawnPos.x,
    y: spawnPos.y,
    width: 190,
    height: 150,
    memo: '',
    tags: [],
    mediaType: 'session',
    refSessionId: session.id,
    imageFileId: null,
    sessionId: yearSession.id,
    createdAt: new Date().toISOString(),
  };
  state.cards.push(sessionCard);

  state.quickMode = true;
  state.quickSessionIds = new Set([yearSession.id, session.id]);
  // このクイック外出専用のバンドルIDを発行する(2026年9月追加、IndexedDB上で他の未マージの
  // 外出のデータと衝突・上書きしないようにするため)。
  state.quickBundleId = crypto.randomUUID();
  state.breadcrumb = [yearSession.id, session.id];
  renderYearTabs();
  renderBreadcrumb();
  renderAllCards();
  return session;
}

/**
 * loadMainData()から呼ぶ。IndexedDBに残っている全てのクイックバンドル(クイックカメラ/
 * クイックセッションで作った、まだDriveのメインファイルに無い新規セッション・新規カード)を、
 * 今しがたDriveから読み込んだ完全なstate.sessions/cards等へ**追記のみ**で合流させる
 * (既にfresh側に存在するidは上書きしない=常に既存データを優先し、失う/壊すことは無い)。
 * **2026年9月バグ修正**: 以前は単一キー('latest')の前提で1件しか読まなかったが、複数の
 * 未マージバンドルが同時に存在しうる(1回目の外出をマージせずタブを閉じ、後日また別の
 * 外出をした場合)ことが判明したため、`loadAllQuickBundles()`で全件を読み、1つずつ
 * 合流させるようにした。
 * @returns {Promise<string[]>} マージした(=Drive保存が成功したら消してよい)バンドルIDの配列。
 *   何もマージしなければ空配列。
 */
async function mergeQuickBundlesIfAny() {
  if (typeof loadAllQuickBundles !== 'function') return [];
  let entries;
  try {
    entries = await loadAllQuickBundles();
  } catch (err) {
    console.error('クイックバンドルの読み込みに失敗', err);
    return [];
  }
  if (!entries || entries.length === 0) return [];

  const mergeArray = (targetArr, sourceArr) => {
    if (!Array.isArray(sourceArr) || sourceArr.length === 0) return;
    const existingIds = new Set(targetArr.map((x) => x.id));
    sourceArr.forEach((item) => {
      if (!existingIds.has(item.id)) {
        targetArr.push(item);
        existingIds.add(item.id);
      }
    });
  };
  entries.forEach(({ data: bundle }) => {
    if (!bundle) return;
    mergeArray(state.sessions, bundle.sessions);
    mergeArray(state.cards, bundle.cards);
    mergeArray(state.connections, bundle.connections);
    mergeArray(state.hiddenAutoLinks, bundle.hiddenAutoLinks);
    // **意図的に触れないフィールド**: bundleはcollectSaveData()と同じ形をしているため
    // crews/commentHistory/exhibitionCalendarId/feHistory等も持っているが、これらは
    // クイックモード中に一度も読み込んでいない「空の初期値」でしかない。もしここで
    // state.crews等をbundle側の値で上書きしていたら、今しがたDriveから読み込んだ本物の
    // データを空配列で消してしまうところだった。sessions/cards/connections/hiddenAutoLinks
    // だけが「クイックモードで確かに新規に作られた」フィールドなので、この4つだけを対象にする。
  });
  return entries.map((e) => e.id);
}

/**
 * 軽量インデックスが使えずフォールバックした場合の共通処理(2026年9月追加、実機報告を受けて)。
 * 「作って中へ入る」というクイック系の体験は、フォールバックしても変えないようにする
 * (以前はフォールバック時、通常のhandleCreateSession()を呼ぶだけで新規セッションの中へは
 * 入らず、【現在の年】の全カードが見える状態のまま取り残される不具合があった)。
 * 呼び出し前に必ずensureMainDataLoaded()が済んでいること(mainDataLoaded===true)が前提。
 */
async function createAndEnterSessionUnderCurrentYear(name) {
  const yearId = getCurrentYearSessionId();
  if (activeSessionId() !== yearId) {
    await enterSession(yearId, true);
  }
  const session = createChildSessionCard(name);
  await enterSession(session.id, false);
}

/** クイックセッションボタン。セッション名の入力方法(OCR/手入力)はhandleCreateSession()と
 *  同じ二択を踏襲する。軽量インデックスが使えない場合は、安全側に倒して通常の全データ
 *  読み込みへフォールバックするが、その場合も新規セッションを作って中へ入るところまでは
 *  必ず行う(createAndEnterSessionUnderCurrentYear()参照)。 */
async function handleQuickSessionStart() {
  closeStartMenu();
  const choice = await showChoiceDialog({
    title: 'セッション名の入力方法',
    options: [
      { label: 'OCRで読み取る', value: 'ocr' },
      { label: '手入力する', value: 'manual', secondary: true },
    ],
  });
  if (!choice) { openStartMenu(); return; }
  let name;
  if (choice === 'ocr') {
    const result = await openCamera('caption');
    if (!result || result.kind !== 'text' || !result.text.trim()) { openStartMenu(); return; }
    name = result.text.trim();
  } else {
    name = window.prompt('新規セッションの名前(展覧会名や作品名など)');
    if (!name) { openStartMenu(); return; }
    name = name.trim();
  }
  if (state.yearsIndexAvailable) {
    startQuickSession(name);
    setStatus(`「${name}」セッションを作成しました(クイックモード)`);
  } else {
    setStatus('初回だけ全データを読み込みます(次回からは軽量になります)…', { busy: true });
    try {
      await ensureMainDataLoaded();
    } catch (err) {
      openStartMenu();
      return;
    }
    await createAndEnterSessionUnderCurrentYear(name);
  }
}

/** クイックカメラボタン。カメラをその場で開く(この時点では通信ゼロ)。撮影が確定した
 *  瞬間だけ、【現在の年】の下に新規セッションを作って格納する(2回目以降の撮影は同じ
 *  セッションへ、通常のカメラボタン経由で追加できる)。軽量インデックスが使えない場合は
 *  安全側に倒して通常の全データ読み込みへフォールバックするが、その場合も新規セッションの
 *  中へ入るところまでは必ず行う。 */
async function handleQuickCameraStart() {
  closeStartMenu();
  const result = await openCamera('photo');
  if (!result || result.kind !== 'photo') { openStartMenu(); return; }
  const sessionName = `クイック撮影 ${new Date().toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}`;
  if (state.yearsIndexAvailable) {
    if (!state.quickMode && !mainDataLoaded) {
      startQuickSession(sessionName);
    }
  } else {
    setStatus('初回だけ全データを読み込みます(次回からは軽量になります)…', { busy: true });
    try {
      await ensureMainDataLoaded();
    } catch (err) {
      openStartMenu();
      return;
    }
    await createAndEnterSessionUnderCurrentYear(sessionName);
  }
  await createCardFromCapture({
    blob: result.blob,
    filename: `${Date.now()}-photo.jpg`,
    mediaType: 'image',
  });
}

let mainDataLoaded = false; // メインデータ(state.cards/sessions等)を読み込み終えたか
let mainDataLoadPromise = null;

/**
 * メインデータ(state.cards/sessions等)がまだ読み込まれていなければ読み込む。複数箇所から
 * 同時に呼ばれてもPromiseを使い回すだけで、二重に読み込むことはない。
 * **呼び出し箇所(=メインのキャンバスを実際に触りうる操作)**: ボトムツールバーの各ボタン
 * (アップロード/カメラ/テクスト/動画/音声/セッション/インフォ/サマリー/ストリートビュー)、
 * モジュールキーパッドでAlmagest(159)以外のコードを入力した時(js/module-launcher.js)、
 * 年タブの「🌐 他の記録を読み込む」ボタン(quickMode中のrenderYearTabs()参照)、設定モーダルの
 * 「☁ Driveへ送信」「📤 端末へ保存」「📋 アップロード状況を見る」(いずれもstate.cardsを前提にする)、
 * enterSession()がクイックモードの範囲外のセッションへ移動しようとした時(2026年9月追加)。
 * **scheduleAutoSave()/saveImmediately()側にも、空のstateでDriveを上書きしてしまわない
 * ための二重の安全策(mainDataLoaded/quickModeチェック)を入れてある**ため、万が一ここでの
 * 呼び出し漏れがあっても、保存だけは確実に防がれる(=最悪でも「操作が効かない」で済み、
 * データが消えることはない)。**loadMainData()自体もmergeQuickBundlesIfAny()で、クイックモード中に
 * 溜まった変更をここで初めてメインデータへ合流させる**(削除・上書きは一切行わない)。
 */
function ensureMainDataLoaded() {
  if (mainDataLoaded) return Promise.resolve();
  if (mainDataLoadPromise) return mainDataLoadPromise;
  mainDataLoadPromise = loadMainData().finally(() => { mainDataLoadPromise = null; });
  return mainDataLoadPromise;
}

/** メインデータの読み込みを待ってから実行する共通ラッパー(ボトムツールバー等の各ボタンから
 *  呼ぶ、上記ensureMainDataLoaded()のコメント参照)。読み込みに失敗した場合はloadMainData()
 *  側で既にエラーのステータス表示が済んでいるため、ここでは何もせず処理を諦める
 *  (中途半端な状態、例えばsessionIdの無いカードを作ってしまう等を避ける)。
 *  **クイックモード中(state.quickMode)は素通りする(2026年9月追加)**: ボトムツールバーの
 *  各ボタンは「今アクティブなセッションにカードを1枚追加する」だけの操作で、クイックモード中の
 *  軽量なstate.cards/sessionsでも安全に完結する(=わざわざ全データを読み込む必要が無い)。
 *  全データが必要になるのは、他のセッションへ移動しようとした瞬間だけ(enterSession()参照)。 */
async function withMainData(fn) {
  if (state.quickMode) {
    fn();
    return;
  }
  try {
    await ensureMainDataLoaded();
  } catch (err) {
    // **2026年9月バグ修正**: スタートメニューの「スタート」を押した直後の読み込みが
    // (一時的なネットワーク不調等で)失敗すると、以前はここで無言でreturnするだけで、
    // ユーザーは何も選べる手段が無い空白画面に取り残されていた(旧・年タブのプレースホルダー
    // 「📅 タップして読み込む」が、スタートメニュー導入時に削除され、代わりの再試行導線が
    // 用意されていなかった)。まだ何も読み込めていない(mainDataLoaded/quickModeどちらも
    // falseの)場合に限り、スタートメニューを開き直して選び直せるようにする。
    if (!mainDataLoaded && !state.quickMode) openStartMenu();
    return;
  }
  fn();
}

async function loadMainData() {
  // ボトムツールバー等はtoggleAuthUI(true)で即座に有効化されるため、理論上はonSignedIn()の
  // フォルダ解決(state.folderIdの設定)が終わるより前に押される可能性がゼロではない
  // (この一瞬の競合自体は今回の変更以前から存在した)。folderId未確定のままDrive APIを
  // 呼んで分かりにくいエラーになるのを避け、分かりやすい案内にする。
  if (!state.folderId) {
    setStatus('まだサインイン処理中です。少し待ってからもう一度お試しください', { important: true });
    throw new Error('state.folderIdがまだ設定されていません');
  }
  // クイックモード中(state.quickMode)にensureMainDataLoaded()が呼ばれた=「他セッションに
  // 移動しようとした」瞬間。今持っている(新規に作った分だけの)state.cards/sessions等を
  // 失わないよう、まずクイックバンドル(IndexedDB)へ最新の内容を確実に書き出してから、
  // Driveのメインデータを読みに行く(下でmergeQuickBundlesIfAny()が読み戻して合流させる)。
  if (state.quickMode) {
    await handleQuickModeSave();
  }
  setStatus('続きを読み込み中…', { busy: true });
  try {
    // Almagestの書庫データ(almagest-library.json)も、メインデータと並行して確実に読み込んで
    // おく(2026年9月追加)。書庫データの読み込みはopenAlmagest()まで遅延させる設計にしたが、
    // 全データ読み込み(=このloadMainData())が走る場面は「本」カード(mediaType:'book')の
    // 描画(almagestBookCardInnerHtml())やその編集ガイドからのジャンプ(jumpToAlmagestEntry())が
    // 起こりうる場面でもあり、書庫データが未読み込みのままだと本来存在する参照まで
    // 「書庫から削除されました」と誤表示してしまう。ここで一緒に読み込むことで、
    // renderAllCards()が呼ばれる時点には必ず揃っているようにする。
    const [{ fileId, data: driveData }] = await Promise.all([
      loadData(state.folderId),
      typeof ensureAlmagestDataLoaded === 'function' ? ensureAlmagestDataLoaded() : Promise.resolve(),
    ]);
    state.fileId = fileId;
    // オートセーブOFF中に端末内だけへ保存された変更(js/upload-queue.jsのsaveLocalDataBackup())が
    // Drive側より新しければ、そちらを採用する(2026年9月追加。Driveへ送れないままブラウザが
    // 閉じられた場合の保険)。
    let data = driveData;
    if (typeof loadLocalDataBackup === 'function') {
      try {
        const backup = await loadLocalDataBackup();
        if (backup && backup.data && (backup.updatedAt || 0) > (driveData.updatedAt || 0)) {
          data = backup.data;
          setStatus('端末に残っていた未送信の変更を復元しました', { important: true });
        }
      } catch (err) {
        console.error('ローカルバックアップの確認に失敗', err);
      }
    }
    state.cards = data.cards || [];
    state.sessions = data.sessions || [];
    state.connections = data.connections || [];
    state.hiddenAutoLinks = data.hiddenAutoLinks || [];
    state.exhibitionCalendarId = data.exhibitionCalendarId || null;
    state.crews = data.crews || [];
    if (window.migrateLegacyCrews) window.migrateLegacyCrews(); // 旧【人物情報】【その言葉】形式からConstellation形式への一度きりの移行
    // Almagestの一度きりの移行の安全網(2026年9月): onSignedIn()のフェーズ1で
    // window.initAlmagestData()を引数無しで呼んでいるため、専用ファイル(almagest-library.json)
    // がまだ存在せず、かつメインJSON埋め込みの旧データ(legacyEntries)がある場合の移行は
    // そちらでは行えない。ここでメインデータが揃ったタイミングで、その場合に限り移行し直す
    // (通常運用では専用ファイルは既に存在するため、この分岐に入ること自体まず無い)。
    if (window.initAlmagestData && !state.almagestFileId && data.almagestEntries && data.almagestEntries.length &&
        (!state.almagestEntries || state.almagestEntries.length === 0)) {
      await window.initAlmagestData(data.almagestEntries);
    }
    state.commentHistory = data.commentHistory || [];
    state.groupViewingIntervalSec = typeof data.groupViewingIntervalSec === 'number' ? data.groupViewingIntervalSec : 60;
    if (data.feHistory) {
      state.feHistory = data.feHistory;
      state.feHistoryIndex = typeof data.feHistoryIndex === 'number' ? data.feHistoryIndex : state.feHistory.length;
    } else if (data.feUndoStack || data.feRedoStack) {
      // 旧データ形式(Undo/Redoの2本のスタック)からの一度きりの移行
      const undoStack = data.feUndoStack || [];
      const redoStack = data.feRedoStack || [];
      state.feHistory = [...undoStack, ...redoStack.slice().reverse()];
      state.feHistoryIndex = undoStack.length;
    } else {
      state.feHistory = [];
      state.feHistoryIndex = 0;
    }
    // クイックカメラ/クイックセッションで作った、まだDriveのメインファイルに無い新規セッション・
    // 新規カード(1件とは限らない、マージし損ねた過去の外出ぶんも含む)をここでマージする
    // (2026年9月追加)。追記のみ・削除や上書きは一切行わない(mergeQuickBundlesIfAny()参照)。
    // **ensureYearSessions()より必ず先に行うこと**: クイックバンドルが(年をまたいだ直後
    // などで)新しい年セッションを含んでいる場合、先にこちらをマージしておかないと、直後の
    // ensureYearSessions()が「まだ無い」と誤認して同じ年のセッションをもう1つ作ってしまう
    // (=重複)。
    const mergedQuickBundleIds = await mergeQuickBundlesIfAny();
    state.quickMode = false;
    state.quickSessionIds = null;
    state.quickBundleId = null;
    ensureYearSessions();
    // セッション導入前に作られたカードは sessionId を持たないため、当時の年セッションへ引き継ぐ
    const migrationTargetId = getCurrentYearSessionId();
    state.cards.forEach((card) => {
      if (!card.sessionId) card.sessionId = migrationTargetId;
    });
    // イマジナリーカード(Star Pencil)の高さ破損の一度きりの修復(2026年9月)。
    // renderCard()末尾のsyncCardHeight()が、中身が全てposition:absoluteのイマジナリー
    // カードに対しても呼ばれてしまっていたバグ(修正済み)により、そのバグが直る前に
    // 作られたカードはcard.heightがmin-height(100px)相当まで潰れた状態でDriveに
    // 保存されてしまっていた。コード側を直しただけでは既に壊れて保存されたデータは
    // 直らない(長押し判定・移動・削除の当たり判定がその縮んだ高さに基づくため、
    // 「線は見えるのに操作できない」という実機報告があった)ため、ストローク自体の
    // 座標(壊れていない)からbounding boxを逆算して復元する。
    state.cards.forEach((card) => {
      if (card.mediaType !== 'imaginary' || !Array.isArray(card.strokes) || card.strokes.length === 0) return;
      let maxX = 0, maxY = 0;
      card.strokes.forEach((s) => (s.points || []).forEach((p) => {
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }));
      const STAR_PENCIL_BOUNDING_PAD = 24; // js/modules/star-pencil.jsのBOUNDING_PADと同じ値
      const correctWidth = Math.max(60, maxX + STAR_PENCIL_BOUNDING_PAD);
      const correctHeight = Math.max(60, maxY + STAR_PENCIL_BOUNDING_PAD);
      if (Math.abs((card.width || 0) - correctWidth) > 2) card.width = correctWidth;
      if (Math.abs((card.height || 0) - correctHeight) > 2) card.height = correctHeight;
    });
    // 前回作業していた場所を復元する(2026年9月追加、ユーザー要望)。保存されたbreadcrumbの
    // 各IDが現在のsessionsに実在するかを先頭から検証し、削除されたセッションを指していた
    // 箇所で打ち切る(Flight Engineerのensure BreadcrumbValid()と同じ考え方)。復元できる
    // 分が無ければ、従来通り現在の年セッションへ戻す。
    let restoredBreadcrumb = null;
    if (Array.isArray(data.breadcrumb) && data.breadcrumb.length > 0) {
      const valid = [];
      for (const id of data.breadcrumb) {
        if (!getSessionById(id)) break;
        valid.push(id);
      }
      if (valid.length > 0) restoredBreadcrumb = valid;
    }
    state.breadcrumb = restoredBreadcrumb || [migrationTargetId];
    mainDataLoaded = true; // renderAllCards()等より前に立てる(scheduleAutoSave()等がこの直後に動いても安全なように)
    renderYearTabs();
    renderBreadcrumb();
    renderAllCards();
    // 復元先はカードの生座標(scale 1, 原点0,0)のままだと画面外に散らばって見えるため、
    // 既存の「全カードが収まるまでズームアウト」機能で毎回きれいにフィットさせる。
    if (restoredBreadcrumb) fitAllCardsToScreen();
    refreshInfoTicker();
    // 日をまたいでアプリを開きっぱなしにした場合に備え、鑑賞可否を定期的に再判定する
    // (API通信は発生しない、ローカルの日付比較のみ)。このsetIntervalはensureMainDataLoaded()の
    // Promiseキャッシュにより、1セッション中に一度しかここへ来ないため二重登録の心配はない。
    setInterval(refreshInfoTicker, 30 * 60 * 1000);
    // 前回終了時にDrive未送信のまま残っていたファイルの表示状態を拾い直す(js/upload-queue.js)。
    // **自動送信はしない**(2026年9月、完全手動化。実際の送信は設定モーダルの「☁ Driveへ送信」を押した時だけ)。
    await restoreUploadQueueOnLoad();
    maybeShowDailyComment(); // 起動時も「セッションを開いた」扱いで判定する(1日3回までの枠)
    maybeAddRandomCardComment(); // 1日1回、全セッション横断でランダムな1枚にコメントを付ける(通知は出さない)
    if (mergedQuickBundleIds.length > 0) {
      // マージした内容を即座にDriveへ書き戻す(=クイックモード中に溜まった変更を確実に
      // 永続化する)。成功した時だけIndexedDB上の該当バンドルを全て消す(失敗時は次回この
      // タイミングで再度マージを試みればよく、二重にマージしても追記のみのため実害は無い)。
      const saved = await handleSave();
      if (saved && typeof clearQuickBundle === 'function') {
        await Promise.all(mergedQuickBundleIds.map((id) => clearQuickBundle(id)));
      }
      setStatus(`読み込み完了(${state.cards.length}件、クイック記録を統合しました)`, { important: true });
    } else {
      setStatus(`読み込み完了(${state.cards.length}件)`);
    }
  } catch (err) {
    console.error(err);
    setStatus('同期に失敗しました(コンソールを確認)', { important: true });
    throw err; // ensureMainDataLoaded()の呼び出し元(トグル/ボタン)へも失敗を伝え、再試行できるようにする
  }
}

/* ---------------- セッション(年 / 展覧会 / 作品の入れ子) ---------------- */

// 現在表示中の階層。配列の先頭は必ず年セッション、以降は入れ子を辿った順。
state.breadcrumb = [];

function activeSessionId() {
  return state.breadcrumb[state.breadcrumb.length - 1] || null;
}

function getSessionById(id) {
  return state.sessions.find((s) => s.id === id);
}

/** 2025年から「今年の翌年」までの「年セッション」が揃っているか確認し、無ければ作成する。
 *  年明けと同時に翌年分のタブが既に用意されているようにするため、常に1年先まで作っておく。 */
function ensureYearSessions() {
  const currentYear = new Date().getFullYear();
  for (let year = FIRST_YEAR; year <= currentYear + 1; year++) {
    const exists = state.sessions.some((s) => s.type === 'year' && s.year === year);
    if (!exists) {
      state.sessions.push({
        id: crypto.randomUUID(),
        type: 'year',
        parentId: null,
        name: String(year),
        year,
        createdAt: new Date().toISOString(),
      });
    }
  }
}

function getCurrentYearSessionId() {
  const currentYear = new Date().getFullYear();
  const session = state.sessions.find((s) => s.type === 'year' && s.year === currentYear);
  return session ? session.id : state.sessions.find((s) => s.type === 'year').id;
}

function renderYearTabs() {
  const years = state.sessions
    .filter((s) => s.type === 'year')
    .sort((a, b) => a.year - b.year);
  els.yearTabs.innerHTML = '';
  years.forEach((session) => {
    const btn = document.createElement('button');
    btn.className = 'year-tab' + (state.breadcrumb[0] === session.id ? ' active' : '');
    btn.textContent = session.name;
    btn.addEventListener('click', () => enterSession(session.id, true));
    els.yearTabs.appendChild(btn);
  });
  // クイックモード中(2026年9月追加): state.sessionsは今回新規に作った分だけの軽量な状態
  // なので、年タブには他の年・他の展覧会が一切出てこない。「消えたわけではない、読めば
  // 出てくる」ことが伝わるよう、全データを読み込む入口を明示的に添える。
  if (state.quickMode) {
    const btn = document.createElement('button');
    btn.className = 'year-tab year-tab--load-all';
    btn.textContent = '🌐 他の記録を読み込む';
    // withMainData()はクイックモード中は素通りする仕様(トップの各ボタン用)のため、ここは
    // 直接ensureMainDataLoaded()を呼ぶ(=意図的に全データ読み込みの境界を越える操作)。
    btn.addEventListener('click', () => ensureMainDataLoaded().catch(() => {}));
    els.yearTabs.appendChild(btn);
  }
}

function renderBreadcrumb() {
  els.breadcrumb.innerHTML = '';
  state.breadcrumb.forEach((id, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      els.breadcrumb.appendChild(sep);
    }
    const session = getSessionById(id);
    const btn = document.createElement('button');
    btn.className = 'crumb' + (i === state.breadcrumb.length - 1 ? ' current' : '');
    btn.textContent = session.name;
    btn.disabled = i === state.breadcrumb.length - 1;
    btn.addEventListener('click', () => {
      state.breadcrumb = state.breadcrumb.slice(0, i + 1);
      renderYearTabs();
      renderBreadcrumb();
      renderAllCards();
      scheduleAutoSave(); // 前回作業していた場所として復元できるよう、パンくずの変更も保存する
    });
    els.breadcrumb.appendChild(btn);
  });
}

/** セッションに入る。isYear=true のときは年タブからの切り替えとして breadcrumb をリセットする。
 *  **クイックモード中の境界(2026年9月追加)**: 今回のクイックカメラ/クイックセッションで
 *  作った範囲(state.quickSessionIds)の外へ出ようとした瞬間だけ、先にensureMainDataLoaded()
 *  (全データ読み込み+クイックバンドルのマージ)を待つ。これが「他セッションに移動した時に
 *  初めて全データを読み込む」というユーザー指定の境界そのもの。 */
async function enterSession(id, isYear) {
  if (!mainDataLoaded && !(state.quickSessionIds && state.quickSessionIds.has(id))) {
    try {
      await ensureMainDataLoaded();
    } catch (err) {
      return;
    }
  }
  if (isYear) {
    state.breadcrumb = [id];
  } else {
    state.breadcrumb.push(id);
  }
  renderYearTabs();
  renderBreadcrumb();
  renderAllCards();
  if (isYear) refreshInfoTicker(); // ティッカーは年タブ単位なので、年を切り替えた時だけ再集計する
  scheduleAutoSave(); // 前回作業していた場所として復元できるよう、パンくずの変更も保存する
  maybeShowDailyComment(); // セッションを開くたびに判定(1日3回までの枠、失敗/中身なしなら消費しない)
}

/**
 * 現在ビューポート中心が指しているキャンバス座標(canvas-content の生px、js/canvas.jsの
 * clientToContent()を利用)。ボトムツールバー/CONSTELLATION PIEから新規カードを作ると、
 * 常に固定座標(40,40)に生成され、パン/ズームした先から見て遠く離れた場所に出てしまう
 * という実機報告(2026年9月)を受けて、各種カード作成関数の既定位置として使う。
 * 連続で作った時に完全に重ならないよう、軽くランダムなずらしを加えて返す。
 */
function newCardSpawnPos() {
  const rect = els.viewport.getBoundingClientRect();
  const center = clientToContent(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return { x: center.x + (Math.random() * 80 - 40), y: center.y + (Math.random() * 80 - 40) };
}

/** 【現在アクティブなセッション】の直下に新規セッション+セッションカードを作る共通処理
 *  (2026年9月、handleCreateSession()・クイックセッション/クイックカメラのフォールバック
 *  経路の重複を解消するため切り出した)。作った側で「中へ入る」かどうかは呼び出し元に委ねる
 *  (handleCreateSession()は今まで通り入らない、クイック系は作った直後にenterSession()する)。
 *  @returns {object} 作成したセッションオブジェクト */
function createChildSessionCard(name) {
  const parentId = activeSessionId();
  const session = {
    id: crypto.randomUUID(),
    type: 'session',
    parentId,
    name,
    createdAt: new Date().toISOString(),
  };
  state.sessions.push(session);

  const spawnPos = newCardSpawnPos();
  const card = {
    id: crypto.randomUUID(),
    x: spawnPos.x,
    y: spawnPos.y,
    width: 190,
    height: 150,
    memo: '',
    tags: [],
    mediaType: 'session',
    refSessionId: session.id,
    imageFileId: null,
    sessionId: parentId,
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  // クイックモード中に作った入れ子セッションも、フルデータ読み込み無しで安全に出入りできる
  // 対象へ加える(enterSession()のガード参照、2026年9月追加)。
  if (state.quickMode && state.quickSessionIds) state.quickSessionIds.add(session.id);
  renderCard(card);
  redrawAsterismLines();
  setStatus(`「${session.name}」セッションを作成しました`);
  scheduleAutoSave();
  return session;
}

async function handleCreateSession() {
  const choice = await showChoiceDialog({
    title: 'セッション名の入力方法',
    options: [
      { label: 'OCRで読み取る', value: 'ocr' },
      { label: '手入力する', value: 'manual', secondary: true },
    ],
  });
  if (!choice) return;
  let name;
  if (choice === 'ocr') {
    const result = await openCamera('caption');
    if (!result || result.kind !== 'text' || !result.text.trim()) return;
    name = result.text.trim();
  } else {
    name = window.prompt('新規セッションの名前(展覧会名や作品名など)');
    if (!name) return;
    name = name.trim();
  }
  createChildSessionCard(name);
}

function renderAllCards() {
  els.content.innerHTML = '';
  // 破棄する古いカード要素への参照を残すとGCされずリークするため、再描画のたびに空にする。
  // 各カードはこの後renderCard()経由でobserveMediaForLazyLoad()が呼ばれ、新しい要素で入り直す。
  pendingMediaElements.clear();
  if (window.renderMappingStorysLayer) window.renderMappingStorysLayer(); // Mapping Storys: カードより先に挿入し、最背面の地図として敷く
  createAsterismLayer();
  const currentId = activeSessionId();
  state.cards
    .filter((card) => card.sessionId === currentId)
    .forEach(renderCard);
  redrawAsterismLines();
}

/* ---------------- Asterism(見た順の自動線 + ASTRガイドでの手動接続) ----------------
 * 自動の「見た順」線はデータを持たず、毎回createdAt順に並べ替えて描き直すだけ。
 * 手動でつないだ線だけ state.connections に実データとして保持する。
 * 線は .canvas-content の子(カードと同じ座標系)に置いたSVGへ、カード中心の
 * 生座標で描くことで、パン/ズームに追従する計算を別途行わずに済ませている。 */

// SVG_NS は js/pie-menu.js で既に定義されているものを流用する(同一グローバルスコープ内で
// constを二重定義するとページ全体のスクリプトが読み込み時エラーになるため、ここでは宣言しない)
let asterismSvg = null;

function createAsterismLayer() {
  asterismSvg = document.createElementNS(SVG_NS, 'svg');
  asterismSvg.setAttribute('class', 'asterism-layer');
  els.content.appendChild(asterismSvg);
}

function cardElById(id) {
  return els.content.querySelector(`.star-card[data-id="${CSS.escape(String(id))}"]`);
}

function drawAsterismLine(elA, elB, className) {
  const a = getCardCenterFromEl(elA);
  const b = getCardCenterFromEl(elB);
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', a.x);
  line.setAttribute('y1', a.y);
  line.setAttribute('x2', b.x);
  line.setAttribute('y2', b.y);
  line.setAttribute('class', `asterism-line ${className}`);
  // ドラッグ中の軽量追従(updateAsterismLinesForCard())が、フル再構築なしにこの線を
  // 見つけて座標だけ更新できるよう、両端のカードIDを持たせておく(2026年9月追加)。
  line.dataset.cardA = elA.dataset.id;
  line.dataset.cardB = elB.dataset.id;
  asterismSvg.appendChild(line);
  return line;
}

/** 2枚のカードが(順不同で)同じペアかどうか */
function isSameCardPair(cardIdA, cardIdB, otherIdA, otherIdB) {
  return (cardIdA === otherIdA && cardIdB === otherIdB) || (cardIdA === otherIdB && cardIdB === otherIdA);
}

/** 展覧会の混雑などで必ずしも見た順どおりに回れるとは限らないため、自動線も個別に非表示にできる。
 *  非表示にした組み合わせだけ state.hiddenAutoLinks に記録し、以降そのペアの自動線を描かない。 */
function isAutoLinkHidden(sessionId, cardIdA, cardIdB) {
  return state.hiddenAutoLinks.some(
    (h) => h.sessionId === sessionId && isSameCardPair(h.cardIdA, h.cardIdB, cardIdA, cardIdB)
  );
}

function hideAutoLink(sessionId, cardIdA, cardIdB) {
  state.hiddenAutoLinks.push({ id: crypto.randomUUID(), sessionId, cardIdA, cardIdB });
  redrawAsterismLines();
  setStatus('自動線を非表示にしました');
  scheduleAutoSave();
}

/** 削除確認つきで1本の線を描く(自動線・手動線共通)。当たり判定を広く取った透明な線を重ねる。
 *  見えている方の線要素を返す(接続直後の発光演出などで、後から特定の線を掴むために使う)。 */
function drawDeletableAsterismLine(elA, elB, className, onDelete) {
  const line = drawAsterismLine(elA, elB, className);
  const hit = drawAsterismLine(elA, elB, 'asterism-line-hit');
  hit.addEventListener('click', (event) => {
    event.stopPropagation();
    if (window.confirm('この線を削除しますか?')) onDelete();
  });
  return line;
}

/** 現在のセッションの線(自動の見た順+手動接続)をすべて描き直す */
function redrawAsterismLines() {
  if (!asterismSvg) return;
  asterismSvg.innerHTML = '';
  const currentId = activeSessionId();
  // インフォメーションカード・サマリーカード・サマリーの出力カード(summarySourceId持ち)は
  // 見た順(鑑賞順)の一部ではないため、自動線から除外する。これが無いと、連続で生成した
  // サマリー出力同士が(作成時刻が近いというだけで)自動的に繋がってしまい、意図した
  // 「出典への接続」と紛らわしくなる。
  const sessionCards = state.cards.filter(
    (c) =>
      c.sessionId === currentId &&
      c.mediaType !== 'info' &&
      c.mediaType !== 'summary' &&
      c.mediaType !== 'streetview' &&
      c.mediaType !== 'chat' &&
      c.mediaType !== 'comment' && // 生成時に既にASTR接続済みのため、見た順の自動線は対象外
      // イマジナリーカード(Star Pencil)も自動線の対象から除外する(2026年9月、ユーザー
      // 指示)。描いた絵は作成時刻が近いというだけで他のカードと繋がってしまうと画面が
      // 混み合うため。手動のASTR接続(編集ガイド)は「何かに使えるかもしれない」という
      // ユーザー判断で引き続き持たせている。
      c.mediaType !== 'imaginary' &&
      // Almagest(書物モジュール)の参照カード(2026年9月追加)。書庫エントリへの「参照」であり
      // 見た順で自動的に繋がるべき一次記録ではないため、Info/Summary/Comment等と同様に除外する。
      c.mediaType !== 'book' &&
      !c.summarySourceId
  );

  // 自動: 追加した順(見た順)に隣同士をつなぐ。ただしhideAutoLink()で個別に消されたペアは除く
  const sorted = sessionCards.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (let i = 1; i < sorted.length; i++) {
    const cardIdA = sorted[i - 1].id;
    const cardIdB = sorted[i].id;
    if (isAutoLinkHidden(currentId, cardIdA, cardIdB)) continue;
    const elA = cardElById(cardIdA);
    const elB = cardElById(cardIdB);
    if (!elA || !elB) continue;
    drawDeletableAsterismLine(elA, elB, 'asterism-line--auto', () => hideAutoLink(currentId, cardIdA, cardIdB));
  }

  // 手動: ASTRガイドで結んだつながり
  state.connections
    .filter((conn) => conn.sessionId === currentId)
    .forEach((conn) => {
      const elA = cardElById(conn.cardIdA);
      const elB = cardElById(conn.cardIdB);
      if (!elA || !elB) return;
      const line = drawDeletableAsterismLine(elA, elB, 'asterism-line--manual', () => removeAstrConnection(conn.id));
      line.dataset.connectionId = conn.id; // 接続直後の発光演出でこの線を後から特定するため
    });
}

/** カードのドラッグ移動・ハンドルリサイズ中(js/canvas.jsのupdateMove()/updateHandleResize())は
 *  pointermoveのたびに高頻度で呼ばれるため、そのたびにredrawAsterismLines()のフル再構築
 *  (SVG全要素の破棄・再生成、state.cards全体のフィルタ・ソート、カードごとのDOM探索と
 *  getBoundingClientRect相当のレイアウト計算)を行うと、カード数・接続数が多いセッションほど
 *  操作全体が重くなる(2026年9月、「全体的に若干重い」という実機報告を受けて特定)。
 *  動いているカード1枚に関わる既存のline要素(drawAsterismLine()がdata-cardA/cardBを
 *  持たせている)だけを探して座標を更新する軽量パスに切り出した。要素の生成・破棄を
 *  行わないため、カード数・接続数に関わらずコストが一定。フル再構築は指を離した瞬間
 *  (endMove()/commitHandleResize())にだけ1回行う。 */
function updateAsterismLinesForCard(cardId) {
  if (!asterismSvg) return;
  const el = cardElById(cardId);
  if (!el) return;
  const center = getCardCenterFromEl(el);
  const lines = asterismSvg.querySelectorAll(`[data-card-a="${CSS.escape(cardId)}"], [data-card-b="${CSS.escape(cardId)}"]`);
  lines.forEach((line) => {
    if (line.dataset.cardA === cardId) {
      line.setAttribute('x1', center.x);
      line.setAttribute('y1', center.y);
    }
    if (line.dataset.cardB === cardId) {
      line.setAttribute('x2', center.x);
      line.setAttribute('y2', center.y);
    }
  });
}

/** 接続が成立した瞬間、「ピーン」の発音に合わせてその線を一瞬明るく光らせる(CSSアニメーション任せ)。 */
function flashConnectedLine(connectionId) {
  const line = asterismSvg.querySelector(`[data-connection-id="${CSS.escape(String(connectionId))}"]`);
  if (!line) return;
  line.classList.add('asterism-line--connect-flash');
  setTimeout(() => line.classList.remove('asterism-line--connect-flash'), 850);
}

/** ASTRガイドのドラッグ&ドロップから呼ぶ(js/canvas.js) */
function createAstrConnection(cardIdA, cardIdB) {
  if (!cardIdA || !cardIdB || cardIdA === cardIdB) return;
  const sessionId = activeSessionId();
  const exists = state.connections.some(
    (c) =>
      c.sessionId === sessionId &&
      ((c.cardIdA === cardIdA && c.cardIdB === cardIdB) || (c.cardIdA === cardIdB && c.cardIdB === cardIdA))
  );
  if (exists) {
    setStatus('既につながっています');
    return;
  }
  const connection = { id: crypto.randomUUID(), sessionId, cardIdA, cardIdB };
  state.connections.push(connection);
  playAstrConnectSound();
  redrawAsterismLines();
  flashConnectedLine(connection.id);
  setStatus('線でつなぎました');
  scheduleAutoSave();
}

function removeAstrConnection(connectionId) {
  const idx = state.connections.findIndex((c) => c.id === connectionId);
  if (idx === -1) return;
  state.connections.splice(idx, 1);
  redrawAsterismLines();
  setStatus('線を削除しました');
  scheduleAutoSave();
}

const CAPTIONABLE_MEDIA_TYPES = ['image', 'video'];
// コメントカード(2026年9月追加)の「Comment」ヘックスを出すカード種別。info/session/summary等の
// 「メタ」なカードは対象外にし、実際に記録・作品の内容を持つカードだけに絞っている。
// 'imaginary'(Star Pencilのイマジナリーカード、2026年9月追加)はfetchPersonaCommentOnCard()
// 側でmediaType==='imaginary'の分岐によりthumbDataUrl(描いた線のラスタライズ)を画像として
// 一緒に渡す。「絵を見せて一言もらう」というモジュール側のアイデアの実装。
const COMMENTABLE_MEDIA_TYPES = ['image', 'video', 'audio', 'text', 'imaginary'];

// セッションカードのタイトル編集欄に添えるOCR起動ボタンのアイコン(モノクロのカメラ)
const CAMERA_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/>' +
  '<circle cx="12" cy="13.2" r="3.2"/></svg>';

// セッションカードの入室ボタン(2026年9月追加)。絵文字の🚪は茶色が目立ちすぎるため、
// 他のアイコンボタン(CAMERA_ICON_SVG等)と同じ、currentColorで地の文字色に馴染む
// 線画のフォルダアイコンにした(css/style.cssの.star-card-session-enter-btnでvar(--muted)を指定)。
const FOLDER_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a1 1 0 011-1h4.5l1.7 2H20a1 1 0 011 1v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1V7z"/></svg>';

// 編集ガイド(長押しで表示される緑のトンボ)。四隅は自由変形、四辺は縦横どちらか片方だけの
// リサイズを担う。実際のドラッグ処理は js/canvas.js の attachCardGestures() 側で行う。
const EDIT_GUIDE_HANDLES_HTML = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
  .map((edge) => `<div class="star-card-handle" data-edge="${edge}"></div>`)
  .join('');

/**
 * 編集ガイドのSci-Fiパネル(緑のヘックスバッジ)。Caption/Editはキャプション取得・メモ編集、
 * ASTRはカード同士を線で繋ぐ機能(見た目のみのプレースホルダー、実装は未定)、
 * Depthはカードを意図的にぼかす、Deleteは削除。
 */
function editGuideHexHtml(mediaType) {
  const hex = (action, label) =>
    `<div class="star-card-hex star-card-hex--${action}" data-action="${action}">` +
    `<span class="star-card-hex-strut star-card-hex-strut--${action}"></span>${label}</div>`;
  const astrHex = '<div class="star-card-hex star-card-hex--astr" data-action="astr">ASTR</div>';
  // インフォメーションカードはリマインダー用途なので、カード同士を結ぶASTRは搭載しない
  if (mediaType === 'info') {
    return hex('toggle', '開閉') + hex('depth', 'Depth') + hex('delete', 'Delete');
  }
  // サマリーカードは移動(ドラッグ)・要約傾向の入力(カード本体)・Deleteに加えて、ASTRで
  // 写真カードを手動接続できる(繋いだ写真も要約時にGeminiへ渡す、というユーザー指定の入力
  // 手段。Depth/Edit/Captionは不要なので持たない)。
  if (mediaType === 'summary') {
    return astrHex + hex('delete', 'Delete');
  }
  // チャットカード(座談会)は移動(ドラッグ)・新しい質問の入力・次の発言を進めるボタンが
  // カード本体にあるため、大半の編集ガイド操作は不要。ただし発言テキストは既定で
  // pointer-events:none(ドラッグ選択がカード移動/キャンバスパンと競合しないようにするため)
  // にしているので、コピペしたい時だけEditで選択可能に切り替えられるようにしてある
  // (2026年9月追加。テキスト自体は読み取り専用で、実際に書き換えることはできない)。
  if (mediaType === 'chat') {
    return hex('edit', 'Edit') + hex('delete', 'Delete');
  }
  // ストリートビューカードも場所のリマインダー的な性質(インフォと同様)なので、見た順の
  // ASTRは搭載しない。位置の変更は本体の「変更」ボタンから行うため、Captionも不要。
  if (mediaType === 'streetview') {
    return hex('edit', 'Edit') + hex('depth', 'Depth') + hex('delete', 'Delete');
  }
  if (mediaType === 'session') {
    return hex('title', 'Title') + hex('edit', 'Edit') + astrHex + hex('depth', 'Depth') + hex('delete', 'Delete');
  }
  // コメントカード(2026年9月追加)は顔文字・名前・コメント本文だけの読み取り専用カードなので、
  // 座談会カードと同様ASTRは不要(自分から他のカードへ接続を貼る運用は想定していない。
  // 生成時に既に接続済みの状態で作られる)。
  if (mediaType === 'comment') {
    // 2026年9月追加: コメント本文もドラッグ選択してコピペしたい、という要望を受け、
    // 座談会カードと同じ仕組み(Editでpointer-events:noneをトグル解除)のEditを追加した。
    // 本文自体は読み取り専用なので、実際に書き換えることはできない。
    // Reply(2026年9月追加): このコメントを発言したペルソナと会話を続けたい、という要望を
    // 受け、押すとこのカード自体を座談会カード(mediaType:'chat')へ変換する
    // (handleCommentReply()参照)。
    return hex('reply', 'Reply') + hex('edit', 'Edit') + hex('delete', 'Delete');
  }
  // Almagest(書物モジュール)の書庫エントリをセッションのキャンバスへ「参照」として置いた
  // カード(mediaType:'book'、2026年9月追加)。本文自体はコピーせずcard.almagestEntryIdだけを
  // 持つ軽量な参照カードのため、Caption/Edit/Captionは不要。ASTRで他のカードと手動接続でき、
  // Depthで意図的にぼかせる。Almagestは元の書庫エントリの読書ビューへジャンプする専用アクション。
  if (mediaType === 'book') {
    return astrHex + hex('depth', 'Depth') + hex('delete', 'Delete') + hex('almagest', '📖 Almagest');
  }
  // イマジナリーカード(Star Pencil、2026年9月追加)は「ドロー以外透過」で、キャプション・
  // メモ欄を持たないためCaption/Editは不要。ASTRで他のカードと手動接続でき、Depthで
  // 意図的にぼかせる。Draw(描き足し)は他のカードには無いこのカード専用のアクションで、
  // js/modules/star-pencil.jsのwindow.openStarPencilForCard()を呼ぶ。
  if (mediaType === 'imaginary') {
    return astrHex + hex('depth', 'Depth') + hex('delete', 'Delete') + hex('draw', 'Draw') + hex('comment', 'Comment');
  }
  const captionHex = CAPTIONABLE_MEDIA_TYPES.includes(mediaType) ? hex('caption', 'Caption') : '';
  // 写真の中の文字をOCRで抜き出す機能。画像のみ。「写真を残してメモに追記」「写真を破棄してテクストカード化」の2択
  const extractHex = mediaType === 'image' ? hex('extract', 'Extract') : '';
  // この写真に接続された状態のサマリーカードを新規作成するショートカット。画像のみ(サマリーが
  // 画像を見るのは接続された写真だけなので、動画・音声カードに置いても意味を持たないため)。
  const summonHex = mediaType === 'image' ? hex('summon', 'Summon') : '';
  // Astrometry Scopeモジュール(js/modules/astrometry-scope.js)を、この写真をあらかじめ
  // 読み込んだ状態で起動するショートカット。画像のみ(色彩・素材・美術史的な分析は静止画の
  // 見た目に対する分析のため、動画・音声には馴染まない)。
  const scopeHex = mediaType === 'image' ? hex('scope', 'Scope') : '';
  // ONのCrewsペルソナ1人に、このカードの内容(メモ・写真ならサムネイル)を読んで一言だけ
  // コメントさせ、ASTR接続済みの新規コメントカードとして残す(2026年9月追加)。
  const commentHex = COMMENTABLE_MEDIA_TYPES.includes(mediaType) ? hex('comment', 'Comment') : '';
  return captionHex + hex('edit', 'Edit') + astrHex + hex('depth', 'Depth') + hex('delete', 'Delete') + extractHex + summonHex + scopeHex + commentHex;
}

/**
 * セッションカードはドラッグで動かせるようにするため開閉ボタンを持たず、カード本体が
 * ドラッグ対象になる。そのぶん「ほぼ動かさずに指を離した(=タップ/クリック)」場合だけ
 * onOpen を呼び、ドラッグ操作と区別する。
 */
function attachTapToOpen(el, onOpen) {
  let downPos = null;
  el.addEventListener('pointerdown', (event) => {
    downPos = { x: event.clientX, y: event.clientY };
  });
  el.addEventListener('pointerup', (event) => {
    if (!downPos) return;
    const moved = Math.hypot(event.clientX - downPos.x, event.clientY - downPos.y);
    downPos = null;
    // 直前に長押しで編集ガイドが表示された場合は、置いただけでも開かない
    const card = el.closest('.star-card');
    if (card && card.dataset.justLifted) {
      delete card.dataset.justLifted;
      return;
    }
    // Flight Engineer起動中(Shiftによる一時解除を除く)は、タップでセッションへ入らず
    // 選択(js/modules/flight-engineer.js の解体メニュー等)に譲る。
    if (window.isFlightEngineerActive && window.isFlightEngineerActive() && !event.shiftKey) return;
    if (moved < 6) onOpen();
  });
}

// 写真・動画・音声・ストリートビューに付随するキャプションは、写真のリサイズと同じ縦一列の
// 箱の中で場所を取り合っており、情報量が多い(複数キャプションのまとめ貼り等)と全文を読めない
// (Editのドラッグ選択でスクロールさせてようやく見える程度)という実機報告があった(2026年9月)。
// これらのmediaTypeだけ、読み取り専用ビューを常に低い「のぞき見」高さへ固定し(写真の
// リサイズと完全に無関係にする)、あふれる場合だけ⛶ボタンで全画面ポップアップ
// (showMemoOverlay())から全文を読む設計にした(モックアップで検討した3案のうち「案B」を採用。
// Crewsの拡大ポップアップ等と違いグラスモーフィズムは不要、というユーザー判断により
// 既存のsettings-modal等と同じ不透明な.modal-overlay/.modalをそのまま流用する)。
const MEMO_PEEK_MEDIA_TYPES = ['image', 'video', 'audio', 'streetview'];

/**
 * メモ欄のマークアップ(2026年9月、ハイパーリンク対応で二重構造に変更)。
 * `.star-card-memo-view`(読み取り専用、URLをクリックできる<a>として描画、既定で表示)と
 * `.star-card-memo`(実データを持つtextarea、Edit中だけ表示)のペアを返す。textareaは
 * plainテキストしか描画できずリンクをクリックさせられないため、既定表示はview側が担い、
 * textareaはEditボタン/Eキーで開く入力専用の役割に変わった(以前はtextarea自身が
 * 表示も編集も兼ねていた)。
 * MEMO_PEEK_MEDIA_TYPESに該当するカードは、viewを`.star-card-memo-shell`で包み、
 * ⛶ボタン(既定hidden、updateMemoExpandState()があふれを検知した時だけ表示)を添える。
 * ボタンをview自身の子ではなく兄弟にしているのは、Edit確定時に`memoViewEl.innerHTML`を
 * まるごと差し替える既存処理(handleCardCaption()等)がボタンごと消してしまわないため。
 */
function memoFieldHtml(card, hasMemo) {
  const peek = MEMO_PEEK_MEDIA_TYPES.includes(card.mediaType);
  const viewClass = peek ? ' star-card-memo-view--peek' : '';
  const expandBtn = peek ? '<button type="button" class="star-card-memo-expand-btn" title="全文を見る" hidden>⛶</button>' : '';
  return (
    `<div class="star-card-memo-shell">` +
    `<div class="star-card-memo-view${viewClass}" ${hasMemo ? '' : 'hidden'}>${linkifyMemoHtml(card.memo || '')}</div>` +
    `${expandBtn}</div>` +
    `<textarea class="star-card-memo" placeholder="メモ" hidden>${escapeHtml(card.memo || '')}</textarea>`
  );
}

/** MEMO_PEEK_MEDIA_TYPESのキャプションのぞき見プレビューが実際にあふれているか判定し、
 *  ⛶ボタンと下端フェードの表示を更新する。新規描画時・メモ更新時(Edit確定・OCR追記)に呼ぶ。 */
function updateMemoExpandState(el) {
  const memoViewEl = el.querySelector('.star-card-memo-view--peek');
  const expandBtn = el.querySelector('.star-card-memo-expand-btn');
  if (!memoViewEl || !expandBtn) return;
  const overflowing = memoViewEl.scrollHeight > memoViewEl.clientHeight + 1;
  memoViewEl.classList.toggle('star-card-memo-view--overflowing', overflowing);
  expandBtn.hidden = !overflowing;
}

/** ⛶ポップアップで高画質の本体も並べて見たい対象(2026年9月追加)。「キャプションの元に
 *  なった写真そのものを見比べながら全文を読みたい」というユーザー要望への対応。音声には
 *  見た目が無く、ストリートビューは既に大きなパノラマとして別枠(iframe)で持っているため対象外。 */
const MEMO_OVERLAY_MEDIA_TYPES = ['image', 'video'];

/**
 * 「⛶ 全文を見る」ポップアップ(2026年9月、キャプションのぞき見プレビューの案Bとして採用)。
 * settings-modal等と同じ.modal-overlay/.modalの不透明な意匠をそのまま流用する
 * (Crewsの拡大ポップアップと違い、ここではグラスモーフィズムは不要というユーザー判断)。
 * **2026年9月追加**: 写真・動画カードでは、本文の左に高画質の本体も並べて表示する。
 * サムネイル(即表示)→本画像/動画(取得でき次第差し替え)という、カード本体の表示と
 * 同じ「まず低解像度、届いたら差し替え」の考え方をそのまま流用している。
 */
function showMemoOverlay(card) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const hasMedia = MEMO_OVERLAY_MEDIA_TYPES.includes(card.mediaType);
  const modal = document.createElement('div');
  modal.className = 'modal star-card-memo-overlay-modal' + (hasMedia ? ' star-card-memo-overlay-modal--with-media' : '');

  if (hasMedia) {
    const mediaEl = document.createElement('div');
    mediaEl.className = 'star-card-memo-overlay-media';
    // **2026年9月追加**: Driveへまだ送信していない(imageFileIdが無い)間も、待機列
    // (IndexedDB)に元データが残っていれば(uploadQueued)それを直接使う。カード本体の
    // loadFullMedia()と同じ理由(Driveアップロードの完全手動化で、送信ボタンを押すまでの
    // 間ズームしても荒いまま、という実機報告があった)。
    const fullMediaUrlPromise = card.imageFileId
      ? getFileBlobUrlCached(card.imageFileId)
      : (card.uploadQueued && typeof getQueuedEntryBlob === 'function'
        ? getQueuedEntryBlob(card.id).then((blob) => (blob ? URL.createObjectURL(blob) : null))
        : Promise.resolve(null));
    if (card.mediaType === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.src = card.thumbDataUrl || '';
      mediaEl.appendChild(img);
      fullMediaUrlPromise.then((url) => { if (url) img.src = url; }).catch(() => {});
    } else if (card.mediaType === 'video') {
      mediaEl.innerHTML = '<div class="star-card-memo-overlay-media-loading">読み込み中…</div>';
      fullMediaUrlPromise.then((url) => {
        mediaEl.innerHTML = url
          ? `<video src="${url}" controls playsinline></video>`
          : '<div class="star-card-memo-overlay-media-loading">読み込めません</div>';
      }).catch(() => {
        mediaEl.innerHTML = '<div class="star-card-memo-overlay-media-loading">読み込みに失敗しました</div>';
      });
    }
    modal.appendChild(mediaEl);
  }

  const textCol = document.createElement('div');
  textCol.className = 'star-card-memo-overlay-text';
  const heading = document.createElement('h2');
  heading.textContent = 'キャプション全文';
  const body = document.createElement('div');
  body.className = 'star-card-memo-overlay-body';
  body.innerHTML = linkifyMemoHtml(card.memo || '');
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'secondary';
  closeBtn.textContent = '閉じる';
  closeBtn.addEventListener('click', () => overlay.remove());
  actions.appendChild(closeBtn);
  textCol.appendChild(heading);
  textCol.appendChild(body);
  textCol.appendChild(actions);
  modal.appendChild(textCol);

  overlay.appendChild(modal);
  attachBackgroundTapToClose(overlay, () => overlay.remove());
  document.body.appendChild(overlay);
}

function renderCard(card) {
  const mediaType = card.mediaType || 'image';
  const isTextCard = mediaType === 'text';
  const isSessionCard = mediaType === 'session';
  const isInfoCard = mediaType === 'info';
  const isSummaryCard = mediaType === 'summary';
  const isStreetviewCard = mediaType === 'streetview';
  const isChatCard = mediaType === 'chat';
  const isCommentCard = mediaType === 'comment';
  const isImaginaryCard = mediaType === 'imaginary'; // Star Pencil、2026年9月追加
  const isBookCard = mediaType === 'book'; // Almagest(書物モジュール)、2026年9月追加
  // テクストカードは常時展開、それ以外はキャプション/メモが入るまでメモ欄を隠しておく
  const hasMemo = isTextCard || Boolean(card.memo);
  const el = document.createElement('div');
  el.className =
    'star-card' +
    (isTextCard ? ' star-card--text' : '') +
    (isSessionCard ? ' star-card--session' : '') +
    (isInfoCard ? ' star-card--info' : '') +
    (isSummaryCard ? ' star-card--summary' : '') +
    (isStreetviewCard ? ' star-card--streetview' : '') +
    (isChatCard ? ' star-card--chat' : '') +
    (isImaginaryCard ? ' star-card--imaginary' : '') +
    (isCommentCard ? ' star-card--comment' : '') +
    (isBookCard ? ' star-card--book' : '') +
    (card.crewPersonaId ? ' star-card--crew' : ''); // Crewsが生成したテクストカードは水色グラスモーフで区別
  el.dataset.id = card.id;
  el.dataset.x = String(card.x);
  el.dataset.y = String(card.y);
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;
  applyCardTransform(el);

  if (isSessionCard) {
    const refSession = getSessionById(card.refSessionId);
    const childCount = state.cards.filter((c) => c.sessionId === card.refSessionId).length;
    const thumbUrls = pickRandomThumbs(collectDescendantImageThumbs(card.refSessionId), 4);
    const thumbsHtml = thumbUrls.length
      ? `<div class="star-card-session-thumbs">${thumbUrls
          .map((url) => `<div class="star-card-session-thumb" style="background-image:url(${url})"></div>`)
          .join('')}</div>`
      : '';
    el.innerHTML = `
      <div class="star-card-session-body" title="タップで開く">
        ${thumbsHtml}
        <div class="star-card-session-text">
          <button class="star-card-title-ocr-btn" title="OCRでタイトルを読み取る" hidden>${CAMERA_ICON_SVG}</button>
          <div class="star-card-session-title-row">
            <span class="star-card-session-name">${escapeHtml(refSession ? refSession.name : '(不明なセッション)')}</span>
            <button class="star-card-session-enter-btn" title="セッションに入る">${FOLDER_ICON_SVG}</button>
          </div>
          <span class="star-card-session-count">${childCount}件</span>
        </div>
      </div>
      ${memoFieldHtml(card, hasMemo)}
      ${EDIT_GUIDE_HANDLES_HTML}
      ${editGuideHexHtml(mediaType)}
    `;
  } else if (isInfoCard) {
    el.innerHTML = infoCardInnerHtml(card);
  } else if (isSummaryCard) {
    el.innerHTML = summaryCardInnerHtml(card);
  } else if (isStreetviewCard) {
    el.innerHTML = streetviewCardInnerHtml(card);
  } else if (isChatCard) {
    el.innerHTML = chatCardInnerHtml(card);
  } else if (isCommentCard) {
    el.innerHTML = commentCardInnerHtml(card);
  } else if (isImaginaryCard) {
    // 実際のHTML生成(SVG+編集ガイド)はモジュール側(js/modules/star-pencil.js)が担う。
    // Mapping Storys/Astrometry Scopeと同じ「統合ポイントは薄いフックのみ」というパターン。
    el.innerHTML = window.imaginaryCardInnerHtml ? window.imaginaryCardInnerHtml(card) : '';
  } else if (isBookCard) {
    // Almagest(js/modules/almagest.js)の書庫エントリを「参照」として置いたカード。
    // 実際のHTML生成(表紙/タイトル+編集ガイド)はモジュール側が担う(同上のパターン)。
    el.innerHTML = window.almagestBookCardInnerHtml ? window.almagestBookCardInnerHtml(card) : '';
  } else {
    const crewHeadHtml = card.crewPersonaId
      ? `<div class="star-card-crew-head">
           <div class="star-card-crew-avatar">${escapeHtml(card.crewPersonaAvatar || '👤')}</div>
           <div class="star-card-crew-name">${escapeHtml(card.crewPersonaName || '')}</div>
         </div>`
      : '';
    el.innerHTML = `
      ${isTextCard ? '' : `<div class="star-card-media star-card-media-${mediaType}"></div>
      <div class="star-card-status-badges">
        <span class="star-card-badge star-card-badge--drive" hidden></span>
        <span class="star-card-badge star-card-badge--device" hidden title="タップで端末保存済みにする(この表示を消す)">📵 端末未保存</span>
      </div>`}
      ${crewHeadHtml}
      ${memoFieldHtml(card, hasMemo)}
      ${EDIT_GUIDE_HANDLES_HTML}
      ${editGuideHexHtml(mediaType)}
    `;
  }
  els.content.appendChild(el);
  makeCardInteractive(el);
  updateMemoExpandState(el);

  const memoExpandBtn = el.querySelector('.star-card-memo-expand-btn');
  if (memoExpandBtn) {
    memoExpandBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    memoExpandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showMemoOverlay(card);
    });
  }

  // 「📵 端末未保存」バッジは、iPhoneで撮影後すぐ端末に残っている写真や、Googleフォト等
  // からドラッグ&ドロップで取り込んだ写真など「そもそも端末へ改めて保存する必要が無い」
  // ケースでも一律に表示され続けてしまう。タップで手動的に「端末保存済み」扱いにして
  // 消せるようにした(2026年9月追加)。
  const deviceBadgeEl = el.querySelector('.star-card-badge--device');
  if (deviceBadgeEl) {
    deviceBadgeEl.style.pointerEvents = 'auto';
    deviceBadgeEl.style.cursor = 'pointer';
    deviceBadgeEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    deviceBadgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      card.deviceSaved = true;
      updateCardStatusBadges(el, card);
      scheduleAutoSave();
      setStatus('「端末未保存」の表示を消しました');
    });
  }

  // 「⚠ Drive未送信(失敗)」バッジをタップすると、同じファイルを選び直して待機列へ
  // 入れ直せる(openRetryUploadPicker()、2026年9月追加)。失敗していない間はタップしても
  // 何も起きない(通常のDrive未送信/送信中は、設定の「☁ Driveへ送信」から通常通り送れるため)。
  const driveBadgeEl = el.querySelector('.star-card-badge--drive');
  if (driveBadgeEl) {
    driveBadgeEl.style.pointerEvents = 'auto';
    driveBadgeEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    driveBadgeEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!card.uploadFailed) return;
      openRetryUploadPicker(card);
    });
  }

  if (card.depthBlurred) el.classList.add('star-card--depth-blurred');
  el.querySelectorAll('.star-card-hex').forEach((hexEl) => {
    hexEl.addEventListener('click', (event) => {
      event.stopPropagation();
      const action = hexEl.dataset.action;
      if (action === 'delete') deleteCard(card, el);
      else if (action === 'caption') handleCardCaption(card, el);
      else if (action === 'edit') {
        const memoEl = el.querySelector('.star-card-memo');
        if (memoEl) {
          const memoViewEl = el.querySelector('.star-card-memo-view');
          if (memoViewEl) memoViewEl.hidden = true;
          memoEl.hidden = false;
          memoEl.style.pointerEvents = 'auto';
          memoEl.focus();
          syncCardHeight(el);
        } else if (card.mediaType === 'chat') {
          // 座談会カードには編集可能なメモ欄が無いため、代わりに発言テキストの
          // 選択(コピペ)可否をトグルする(2026年9月追加、実際に書き換えることはできない)。
          el.classList.toggle('star-card-chat-editing');
        } else if (card.mediaType === 'comment') {
          // コメントカードも座談会と同じ理由・同じ仕組み(2026年9月追加)。
          // コメント本文は読み取り専用なので、Editは「選択(コピペ)を許可するか」のトグルのみ。
          el.classList.toggle('star-card-comment-editing');
        }
      } else if (action === 'title') {
        startSessionTitleEdit(card, el);
      } else if (action === 'toggle') {
        toggleInfoCardExpanded(card, el);
      } else if (action === 'astr') {
        // 長押し→ドラッグでの接続はjs/canvas.jsのattachAstrGesture()が処理する。
        // ここに来るのは「長押しせずタップだけした」場合なので、使い方のヒントだけ出す。
        if (hexEl.dataset.justDragged) {
          delete hexEl.dataset.justDragged;
        } else {
          setStatus('ASTRを長押しすると、線を引いてカード同士をつなげます');
        }
      } else if (action === 'depth') {
        card.depthBlurred = !card.depthBlurred;
        el.classList.toggle('star-card--depth-blurred', card.depthBlurred);
        scheduleAutoSave();
      } else if (action === 'extract') {
        handleCardExtract(card, el);
      } else if (action === 'summon') {
        handleSummonSummary(card);
      } else if (action === 'comment') {
        handleCardComment(card, el);
      } else if (action === 'reply') {
        handleCommentReply(card, el);
      } else if (action === 'scope') {
        // Astrometry Scope本体はモジュール(js/modules/astrometry-scope.js)側の実装。
        // ここでは起動フックを呼ぶだけ(Mapping Storys等と同じ、window越しの薄い統合)。
        if (window.openAstrometryScope) window.openAstrometryScope(card);
      } else if (action === 'draw') {
        // Star Pencil本体はモジュール(js/modules/star-pencil.js)側の実装。ここでは
        // 起動フックを呼ぶだけ(Astrometry Scopeのscopeと同じ、window越しの薄い統合)。
        if (window.openStarPencilForCard) window.openStarPencilForCard(card);
      } else if (action === 'almagest') {
        // Almagest本体はモジュール(js/modules/almagest.js)側の実装。元の書庫エントリの
        // 読書ビューへジャンプするだけの起動フック(scope/drawと同じ、window越しの薄い統合)。
        if (window.jumpToAlmagestEntry) window.jumpToAlmagestEntry(card.almagestEntryId);
      }
      if (action !== 'astr' && action !== 'title' && action !== 'toggle' && action !== 'extract' && action !== 'summon' && action !== 'comment' && action !== 'reply' && action !== 'scope' && action !== 'draw' && action !== 'almagest') scheduleAutoSave();
    });
  });

  if (isSessionCard) {
    attachTapToOpen(el.querySelector('.star-card-session-body'), () => enterSession(card.refSessionId, false));
    // 2026年9月追加: セッションボディ全面のタップだけに頼らず、タイトル右に専用の
    // 入室ボタンを置いた。タイトル編集用OCRボタン(hidden指定漏れで常時表示になり、
    // 入室のタップ判定を奪っていた不具合が過去にあった)とは別のボタンにすることで、
    // 同じ事故が起きないようにする。
    const enterBtn = el.querySelector('.star-card-session-enter-btn');
    if (enterBtn) {
      enterBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
      enterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        enterSession(card.refSessionId, false);
      });
    }
  }

  // インフォメーションカードは.star-card-memoを使わず専用のフィールドを持つため、
  // ここから先の共通メモ配線は対象外にする(wireInfoCard()で個別に配線する)。
  const memoEl = el.querySelector('.star-card-memo');
  const memoViewEl = el.querySelector('.star-card-memo-view');
  if (memoEl) {
    // 表示中のリンクをクリックした時、既定でpointer-events:noneなカード本体を巻き添えに
    // せずブラウザ標準の遷移だけを行わせる(attachCardGestures()側も<a>を既に除外済み)。
    if (memoViewEl) memoViewEl.addEventListener('pointerdown', (e) => { if (e.target.closest('a')) e.stopPropagation(); });
    memoEl.addEventListener('input', () => {
      card.memo = memoEl.value;
      syncCardHeight(el);
      scheduleAutoSave();
    });
    // 既定ではメモへのポインタ操作を無効化し、カードの移動を優先する。
    // 編集ガイドのEditアクションを押した時だけ編集を受け付け、フォーカスが外れたら移動優先に戻す。
    // 2026年9月、URLをクリックできるリンクとして表示したい要望に対応するため、既定の表示は
    // textarea(平文しか描画できない)ではなく.star-card-memo-view(<a>タグ入りHTML)が担う
    // ようになった。textareaはEdit中だけ表示する入力専用の役割になり、blur時に内容を
    // ビューへ反映して隠れる。
    memoEl.addEventListener('blur', () => {
      memoEl.style.pointerEvents = 'none';
      memoEl.hidden = true;
      if (memoViewEl) {
        memoViewEl.innerHTML = linkifyMemoHtml(memoEl.value);
        // OCR取り込みも手入力もなく空のまま編集を終えた場合は、ビューも隠したままにする
        memoViewEl.hidden = !(isTextCard || memoEl.value.trim());
      }
      syncCardHeight(el);
      updateMemoExpandState(el);
    });
    // Edit中のtextarea(既定でpointer-events:none相当だが、Edit中はauto)は最大高さ+内部
    // スクロールのままなので、カーソルがtextareaの範囲内にある時だけホイールでtextarea自体を
    // スクロールできるようにする(キャンバスのズームには渡さない)。hasMediaのチェックが無いと、
    // テキストカードなどmax-heightの掛かっていないメモ欄でもわずかなサブピクセルの誤差で
    // scrollHeightがclientHeightよりわずかに大きく判定されることがあり、そのたびにホイール
    // ズームを奪ってしまうバグがあった。
    // **2026年9月のキャプションのぞき見プレビュー導入(案B)に伴い、読み取り専用ビュー側の
    // ホイール転送は撤去した**: あふれた分は常に⛶ボタンの全画面ポップアップ(showMemoOverlay())
    // で読む設計に変わり、固定の低い高さしか持たないプレビューをホイールでスクロールさせても
    // 最初の数行が隠れてしまうだけで意味を持たなくなったため。
    const hasMedia = Boolean(el.querySelector('.star-card-media'));
    el.addEventListener('wheel', (event) => {
      if (!hasMedia || memoEl.hidden) return; // 読み取り専用プレビュー表示中は対象外
      const target = memoEl;
      if (target.scrollHeight - target.clientHeight < 4) return;
      const rect = target.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) return;
      event.stopPropagation();
      // deltaYをそのまま使うとマウスの1ノッチで一気に飛んでしまい読んでいた位置を見失うため、
      // 感度を落として細かく動かせるようにする。
      target.scrollTop += event.deltaY * 0.35;
    });
  }

  if (isInfoCard) {
    wireInfoCard(card, el);
  }
  if (isSummaryCard) {
    wireSummaryCard(card, el);
  }
  if (isStreetviewCard) {
    wireStreetviewCard(card, el);
  }
  if (isChatCard) {
    wireChatCard(card, el);
  }

  // uploadQueuedもここに含める(2026年9月追加): 動画・音声カードはthumbDataUrlを持たないため、
  // 以前の条件(imageFileId || thumbDataUrl)だと、Drive送信前は本体自体をobserveMediaForLazyLoad()
  // に登録する機会が無く、待機列にある元データへのフォールバックが届かなかった。
  if (!isSessionCard && (card.imageFileId || card.thumbDataUrl || card.uploadQueued)) {
    const mediaEl = el.querySelector('.star-card-media');
    // 概観時はまず軽量サムネイル(あれば)を即表示し、実際にカードが画面内に来たときだけ
    // Driveへ本画像/動画/音声を取りに行く(OneNoteのサムネイル運用と同じ考え方)。
    if (mediaType === 'image' && card.thumbDataUrl) {
      mediaEl.innerHTML = `<img src="${card.thumbDataUrl}" alt="">`;
    }
    // **2026年9月追加**: Driveへまだ送信していない(imageFileIdが無い)間も、待機列
    // (IndexedDB)に元データがまるごと残っているカード(uploadQueued)は、loadFullMedia()側で
    // それをフォールバックとして使えるため、ここでも監視対象に含める。以前はimageFileIdの
    // 有無だけで判定していたため、Driveアップロードの完全手動化(2026年9月)以降、送信ボタンを
    // 押すまでの間(数時間〜数日になりうる)ズームしても本画像に切り替わらずサムネイルのまま
    // 荒い、という実機報告があった。
    if (card.imageFileId || card.uploadQueued) observeMediaForLazyLoad(el, card);
  }
  if (card.uploadPending) el.classList.add('star-card--upload-pending');
  if (card.uploadFailed) el.classList.add('star-card--upload-failed');
  if (card.uploadQueued) el.classList.add('star-card--upload-queued');
  if (!isTextCard) updateCardStatusBadges(el, card);

  // セッションカードはメモが空のままなら、以前どおりユーザーが手動で決めた高さを保つ
  // (毎回自動採寸すると、写真枠を持たない分だけ小さく潰れてしまうため)。イマジナリー
  // カード(Star Pencil)も同じ理由で自動採寸の対象外にする: 中身(SVG・リサイズ
  // ハンドル・編集ガイドのヘックス)が全てposition:absoluteのため、syncCardHeight()が
  // height:autoへ一度リセットした瞬間、高さの算出根拠が無くなりmin-height(100px)まで
  // 潰れてしまう不具合があった(2026年9月、実機報告: 「完成させてモジュールを閉じると
  // 縦に圧縮される」)。イマジナリーカードの高さは常にcommitDrawing()のbounding box計算
  // で確定するため、そもそも自動採寸が不要。
  if (!isImaginaryCard && (!isSessionCard || card.memo)) {
    syncCardHeight(el);
  }
}

/* ---------------- インフォメーションカード(基本機能) ----------------
 * 展覧会の会期・開廊時間・休廊日のテキスト(ウェブサイトからのコピペ/手入力)を、
 * Geminiで一度だけ構造化データに解析する(js/gemini.js の parseExhibitionInfo())。
 * URL入力は、TOKYO ART BEATなどクライアントサイドレンダリングのサイトではGeminiの
 * url_contextツールが本文を取得できず解析に失敗するため廃止し、コピペのみにした。
 * 以降「今日は鑑賞可能か」はローカルJSだけで判定し、APIを再度呼ぶ必要はない。
 * ヘッダーのティッカーに、現在の年タブ内で「今日鑑賞可能」な展覧会をローテーション表示し、
 * タップでそのカードへジャンプする。ASTR(自動線・手動接続とも)は搭載しない、リマインダー用途。 */

function infoCardInnerHtml(card) {
  if (card.infoParsed) normalizeInfoParsedExceptions(card.infoParsed);
  const parsed = card.infoParsed;
  const expanded = Boolean(card.infoExpanded);
  const visitable = parsed ? isExhibitionVisitableOn(parsed, new Date()) : false;
  const displayTitle = (parsed && parsed.title) || '(無題のインフォメーション)';
  const displayVenue = parsed && parsed.venue;

  const badgeClass = !parsed ? 'unparsed' : visitable ? 'visitable' : 'closed';
  const badgeText = !parsed ? '未解析' : visitable ? '本日鑑賞可能' : '会期外';

  return `
    <div class="star-card-info-badge ${badgeClass}"><span class="dot"></span>${badgeText}</div>
    <div class="star-card-info-head">
      <p class="star-card-info-title">${escapeHtml(displayTitle)}</p>
      ${displayVenue ? `<p class="star-card-info-venue">${escapeHtml(displayVenue)}</p>` : ''}
    </div>
    <div class="star-card-info-body" ${expanded ? '' : 'hidden'}>
      ${infoRawTextSectionHtml(card)}
      ${parsed ? infoParseResultHtml(parsed) : ''}
      ${card.infoParseError ? infoParseErrorHtml(card) : ''}
    </div>
    ${EDIT_GUIDE_HANDLES_HTML}
    ${editGuideHexHtml('info')}
  `;
}

/**
 * 展覧会ページ本文のコピペ欄。一度解析済み(card.infoParsed)になった後もこの欄を常時展開
 * したままだと、カードのほとんどの面積でポインタがtextarea上から始まってしまい、キャンバスの
 * ピンチズームへポインタが伝わらない(wireInfoCard()でtextareaのpointerdownをstopPropagation
 * しているため)。解析済みならペンアイコン1つに格納し、押した時だけ展開してズームとの競合を防ぐ。
 */
function infoRawTextSectionHtml(card) {
  if (card.infoParsed && !card.infoRawEditing) {
    return '<button class="star-card-info-edit-raw-btn" title="展覧会ページの本文を編集">✎ 本文を編集</button>';
  }
  return `
    <p class="star-card-info-label">展覧会ページの本文をコピペ</p>
    <textarea class="star-card-info-text" placeholder="会場名・会期・時間などのテキストを貼り付け">${escapeHtml(card.memo || '')}</textarea>
    <button class="star-card-info-parse-btn">解析する</button>
  `;
}

/**
 * 解析結果(title・venue)からGoogle検索結果ページのURLを組み立てる。Geminiには一切問い合わせず
 * (=無料枠を消費しない)、クライアントサイドだけで完結させる。以前はGeminiのgoogle_searchツール
 * (検索グラウンディング)で公式ページそのものを探させていたが、請求先アカウント非紐付けの
 * 無料キーでは検索グラウンディングの割り当てが無く、呼んだ瞬間に429 RESOURCE_EXHAUSTEDで
 * 解析全体が失敗する不具合が実機で確認されたため撤回し、この方式に置き換えた(2026年9月)。
 * 公式ページを断定できるわけではないが、タップすればユーザー自身がすぐ確認できる。
 */
function exhibitionSearchUrl(parsed) {
  const query = [parsed.title, parsed.venue].filter(Boolean).join(' ');
  if (!query) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function infoParseResultHtml(parsed) {
  const closedLabels = { 0: '日', 1: '月', 2: '火', 3: '水', 4: '木', 5: '金', 6: '土' };
  const closedChips = (parsed.closedWeekdays || []).map((d) => `<span class="chip closed">${closedLabels[d] || d}</span>`).join('');
  const exceptionChips = (parsed.exceptions || [])
    .map((ex) => `<span class="chip ${ex.type === 'open' ? 'exception' : 'closed'}">${escapeHtml(ex.startDate || '')}〜${escapeHtml(ex.endDate || '')}${ex.type === 'open' ? '開廊' : '休廊'}</span>`)
    .join('');
  const searchUrl = exhibitionSearchUrl(parsed);
  return `
    <div class="star-card-info-result">
      <div class="row"><b>会期</b><span>${escapeHtml(parsed.startDate || '?')} 〜 ${escapeHtml(parsed.endDate || '?')}</span></div>
      ${parsed.openTime ? `<div class="row"><b>時間</b><span>${escapeHtml(parsed.openTime)} 〜 ${escapeHtml(parsed.closeTime || '?')}</span></div>` : ''}
      ${closedChips ? `<div class="row"><b>休廊日</b><span class="chip-row">${closedChips}</span></div>` : ''}
      ${exceptionChips ? `<div class="row"><b>例外</b><span class="chip-row">${exceptionChips}</span></div>` : ''}
      ${searchUrl ? `<div class="row"><b>リンク</b><span><a class="star-card-info-link" href="${escapeHtml(searchUrl)}" target="_blank" rel="noopener noreferrer">Google検索で確認</a></span></div>` : ''}
    </div>
    <button class="star-card-info-resync-btn" title="Geminiを呼ばず、この解析結果だけをカレンダーに反映し直す">カレンダーに同期</button>
  `;
}

function infoParseErrorHtml(card) {
  const partial = card.infoParseError.partial || {};
  return `
    <div class="star-card-info-error">
      <p class="title">⚠ ${escapeHtml(card.infoParseError.message || '解析できませんでした')}</p>
      <p class="hint">読み取れた項目は自動入力されています。空欄だけ手入力で埋めてください(開始日・終了日は必須)。</p>
      <div class="manual-fields">
        <div><label>開始日</label><input type="text" class="fix-start" placeholder="YYYY-MM-DD" value="${escapeHtml(partial.startDate || '')}"></div>
        <div><label>終了日</label><input type="text" class="fix-end" placeholder="YYYY-MM-DD" value="${escapeHtml(partial.endDate || '')}"></div>
        <div><label>開始時刻</label><input type="text" class="fix-open" placeholder="HH:MM" value="${escapeHtml(partial.openTime || '')}"></div>
        <div><label>終了時刻</label><input type="text" class="fix-close" placeholder="HH:MM" value="${escapeHtml(partial.closeTime || '')}"></div>
      </div>
      <button class="star-card-info-fix-btn">この内容で確定</button>
    </div>
  `;
}

function wireInfoCard(card, el) {
  const textEl = el.querySelector('.star-card-info-text');
  const parseBtn = el.querySelector('.star-card-info-parse-btn');
  const editRawBtn = el.querySelector('.star-card-info-edit-raw-btn');
  const fixBtn = el.querySelector('.star-card-info-fix-btn');
  const resyncBtn = el.querySelector('.star-card-info-resync-btn');

  if (editRawBtn) {
    editRawBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    editRawBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.infoRawEditing = true;
      rerenderCardInPlace(card, el);
    });
  }
  if (textEl) {
    textEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    textEl.addEventListener('input', () => {
      card.memo = textEl.value;
      syncCardHeight(el);
      scheduleAutoSave();
    });
  }
  if (parseBtn) {
    parseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    parseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleInfoCardParse(card, el);
    });
  }
  if (fixBtn) {
    fixBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    fixBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleInfoCardManualFix(card, el);
    });
  }
  if (resyncBtn) {
    resyncBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    resyncBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleInfoCardResync(card, el);
    });
  }
}

function createInfoCard() {
  const spawnPos = newCardSpawnPos();
  const card = {
    id: crypto.randomUUID(),
    x: spawnPos.x,
    y: spawnPos.y,
    width: 240,
    height: 150,
    memo: '',
    tags: [],
    mediaType: 'info',
    infoParsed: null,
    infoParseError: null,
    infoExpanded: true,
    imageFileId: null,
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  setStatus('インフォメーションカードを追加しました');
  scheduleAutoSave();
  return card;
}

/* ---------------- ストリートビューカード(基本機能) ----------------
 * 指定した場所のGoogleストリートビューをカード内に埋め込む、場所の記録用カード種別。
 * APIキー・GCP請求先アカウントは一切使わない。js/modules/mapping-storys.js の
 * Googleマップ埋め込み(kind:'embed')と同じ「地図を共有/埋め込む」consumer向けno-key iframe
 * (output=svembed)を流用する。ストリートビュー内は本物の360°パノラマとして素手で
 * ドラッグ・ズーム・矢印移動ができる(iframeそのものをpointer-events:autoのまま置く)ため、
 * カード自体の移動・長押し編集ガイドは専用のヘッダー帯(iframeの外)から行う。
 * (iframeの領域は独立したブラウジングコンテキストのため、そこでのpointerdownは
 * そもそもカード側のドラッグリスナーまでバブリングしてこない。リサイズハンドルは
 * .star-cardの子として後からDOMに追加されるため、iframeの上に重なっていても描画順で
 * 手前になり、従来どおりつかんで操作できる)。 */

/** ストリートビュー埋め込み用のURLを組み立てる。cbpの第2値(heading)以外は固定値で良い
 * (向きはiframe内のドラッグでいつでも自由に変えられるため、初期値の精度はさほど重要でない)。 */
function buildStreetviewEmbedSrc(card) {
  const heading = Number.isFinite(card.streetviewHeading) ? card.streetviewHeading : 0;
  return `https://www.google.com/maps?layer=c&cbll=${card.streetviewLat},${card.streetviewLng}&cbp=12,${heading},,0,0&output=svembed`;
}

/**
 * Googleマップ上でストリートビューを開いた時のアドレスバーURL(例: "@35.68,139.76,3a,75y,90h,90t/…")、
 * 通常の地図URL(例: "@35.68,139.76,17z")、または「緯度,経度」のプレーンな数値ペアから
 * 緯度経度(と、あれば向き)を取り出す。施設名の自由文検索はジオコーディングAPIが必要になるため
 * 非対応、というjs/modules/mapping-storys.jsのparseLatLngZoom()と同じ割り切り。
 */
function parseStreetviewInput(text) {
  const v = (text || '').trim();
  if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(v)) return { error: 'short' };
  let m = v.match(/@(-?\d+\.\d+),(-?\d+\.\d+),[^/]*?(\d+(?:\.\d+)?)h/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]), heading: Number(m[3]) };
  m = v.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]), heading: 0 };
  m = v.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
  if (m) return { lat: Number(m[1]), lng: Number(m[2]), heading: 0 };
  return { error: 'unparsed' };
}

function streetviewCardInnerHtml(card) {
  const hasLocation = typeof card.streetviewLat === 'number' && typeof card.streetviewLng === 'number';
  // sandboxでiframeからトップページ遷移・新規ウィンドウを開く権限自体を奪っておく(iframe内は
  // 本物のストリートビューとして自由にドラッグ・ズームできる設計のため、Mapping Storysのembedと
  // 違いpointer-events:noneには頼れない。「Googleマップで見る」等のリンクをうっかりタップしても、
  // アプリ全体がブラウザのGoogleマップへ遷移することがなくなる)。
  const bodyHtml = hasLocation
    ? `<iframe class="star-card-streetview-iframe" loading="lazy" referrerpolicy="no-referrer-when-downgrade" sandbox="allow-scripts allow-same-origin" src="${escapeHtml(buildStreetviewEmbedSrc(card))}"></iframe>`
    : `<div class="star-card-streetview-setup">
         <textarea class="star-card-streetview-input" placeholder="ストリートビューのURL、または「緯度,経度」"></textarea>
         <button class="star-card-streetview-go-btn">呼び出す</button>
         <p class="star-card-streetview-warn" hidden></p>
       </div>`;
  return `
    <div class="star-card-streetview-head" title="ドラッグで移動">
      <span class="star-card-streetview-label">📍 ストリートビュー</span>
      ${hasLocation ? '<button class="star-card-streetview-change-btn">変更</button>' : ''}
    </div>
    <div class="star-card-media star-card-media-streetview">${bodyHtml}</div>
    ${memoFieldHtml(card, Boolean(card.memo))}
    ${EDIT_GUIDE_HANDLES_HTML}
    ${editGuideHexHtml('streetview')}
  `;
}

function wireStreetviewCard(card, el) {
  const changeBtn = el.querySelector('.star-card-streetview-change-btn');
  const input = el.querySelector('.star-card-streetview-input');
  const goBtn = el.querySelector('.star-card-streetview-go-btn');
  const warnEl = el.querySelector('.star-card-streetview-warn');

  if (changeBtn) {
    changeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    changeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.streetviewLat = null;
      card.streetviewLng = null;
      scheduleAutoSave();
      rerenderCardInPlace(card, el);
    });
  }
  if (input) input.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (goBtn) {
    goBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    goBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const parsed = parseStreetviewInput(input.value);
      if (parsed.error) {
        warnEl.hidden = false;
        warnEl.textContent =
          parsed.error === 'short'
            ? '短縮リンク(maps.app.goo.gl)は座標を取り出せません。ブラウザで開いた後のアドレスバーのURLを貼ってください。'
            : '位置を特定できませんでした。ストリートビューのURL、または「緯度,経度」の形式で入力してください。';
        return;
      }
      card.streetviewLat = parsed.lat;
      card.streetviewLng = parsed.lng;
      card.streetviewHeading = parsed.heading || 0;
      scheduleAutoSave();
      rerenderCardInPlace(card, el);
      setStatus('ストリートビューを呼び出しました');
    });
  }
}

function createStreetviewCard() {
  const spawnPos = newCardSpawnPos();
  const card = {
    id: crypto.randomUUID(),
    x: spawnPos.x,
    y: spawnPos.y,
    width: 280,
    height: 240,
    memo: '',
    tags: [],
    mediaType: 'streetview',
    streetviewLat: null,
    streetviewLng: null,
    streetviewHeading: 0,
    imageFileId: null,
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  setStatus('ストリートビューカードを追加しました');
  scheduleAutoSave();
  return card;
}

/* ---------------- サマリーカード(基本機能) ----------------
 * セッション全体(タイトル・入れ子の子セッションを含む全カードのテキスト)をGeminiに読ませ、
 * 「👦 Boy(やさしく、旧Education)」「🎓 Professor(学術的に、旧Academic)」の2つの視点で
 * 要約を作らせる(2026年9月に表示名をBoy/Professorへ改名。内部のdata-summary-mode値・
 * summarizeSession()のmode分岐('education'/'academic')は変更していない)。
 * 押すたびにGeminiを1回呼び、結果はテクストカードとして新規に生成し、ASTRの手動接続と同じ
 * 仕組み(createAstrConnection)でこのサマリーカードに繋げる(効果音・発光演出もそこに乗る)。
 * 既定では画像を送らずテキスト情報だけで要約する(セッション内の全写真を毎回送ると無料枠を
 * すぐ消費してしまうため)。ただしユーザーがサマリーカード自身のASTRヘックスから写真カードを
 * 手動接続した場合は、その写真(サムネイルのみ、最大SUMMARY_MAX_CONNECTED_IMAGES枚)も
 * collectConnectedImageParts()で拾ってGeminiに渡す。動画・音声は対象外(データ量が大きく
 * 無料枠を早く消費するため)。 */

function summaryCardInnerHtml(card) {
  const session = getSessionById(card.sessionId);
  // Crewsモジュール(js/modules/crews.js)が登録されていれば、ONのペルソナの数だけ
  // ヘックスボタンを追加で並べる(未読み込み/未登録なら何も足さない)。
  const crewHexHtml = window.crewsSummaryHexButtonsHtml ? window.crewsSummaryHexButtonsHtml() : '';
  return `
    <div class="star-card-summary-head">
      <button class="star-card-summary-btn" data-summary-mode="education" title="小中学生にも分かるように要約"><span class="emoji">👦</span>Boy</button>
      <button class="star-card-summary-btn" data-summary-mode="academic" title="学術的な視点で要約"><span class="emoji">🎓</span>Professor</button>
      ${crewHexHtml}
    </div>
    <p class="star-card-summary-session"><span class="dot"></span>SESSION: ${escapeHtml(session ? session.name : '(不明)')}</p>
    <p class="star-card-summary-label">要約の傾向(任意)</p>
    <textarea class="star-card-summary-input" placeholder="例: フェミニズム的視点で／ポストインターネット的視点で">${escapeHtml(card.summaryDirection || '')}</textarea>
    <p class="star-card-summary-hint">ASTRで写真を繋ぐと、その写真も見て要約します(動画・音声は対象外)</p>
    <button class="star-card-summary-roundtable-btn" title="Boy・Professor・Gemini・ONのCrewsペルソナで座談会を始める(上の「要約の傾向」欄を最初の質問にする)">🗣 座談会をひらく</button>
    <button class="star-card-summary-question-btn" title="上の「要約の傾向」欄を質問文として、セッション文脈+接続画像を添えてテンプレート化せずそのまま送信">❓ この質問をそのまま送る</button>
    <p class="star-card-summary-question-hint">↑検索グラウンディング無し(API直送・無料枠を消費)。セッション文脈+ASTR接続画像を添えて、上の欄をテンプレート化せず質問として送ります</p>
    <div class="star-card-summary-divider"></div>
    <p class="star-card-summary-label">gemini.google.comの回答を貼り付け(検索グラウンディングあり、任意)</p>
    <textarea class="star-card-summary-paste-input" placeholder="自分で開いたgemini.google.comでの回答をここに貼り付けて保存"></textarea>
    <button class="star-card-summary-paste-btn">この内容をテクストとして保存</button>
    ${EDIT_GUIDE_HANDLES_HTML}
    ${editGuideHexHtml('summary')}
  `;
}

function wireSummaryCard(card, el) {
  const inputEl = el.querySelector('.star-card-summary-input');
  if (inputEl) {
    inputEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    inputEl.addEventListener('input', () => {
      card.summaryDirection = inputEl.value;
      scheduleAutoSave();
    });
  }
  el.querySelectorAll('.star-card-summary-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleSummaryGenerate(card, el, btn.dataset.summaryMode);
    });
  });

  // 「🗣 座談会をひらく」(2026年9月追加)。Boy・Professor・Gemini(素の人格無し)・ONのCrews
  // ペルソナ全員を参加者とする新規チャットカード(mediaType:'chat')をサマリーカードの隣へ
  // ポップアップさせる。「要約の傾向」欄が最初の質問になる(空でもよい、その場合はチャット
  // カード側で後から質問を投げる)。
  const roundtableBtn = el.querySelector('.star-card-summary-roundtable-btn');
  if (roundtableBtn) {
    roundtableBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    roundtableBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const question = (inputEl?.value || '').trim();
      createChatCard(card, question);
      setStatus('座談会をひらきました');
    });
  }

  // 「この質問をそのまま送る」(2026年9月追加、Mapping Storysの伝承欄の自由質問モードと同じ思想)。
  // Education/Academicのようなテンプレート(JSON出力形式・文体指定など)を一切経由せず、
  // 「要約の傾向」欄の文面を質問としてそのままGeminiへ送る。ユーザー要望により、ASTRで
  // 接続した写真・セッション全体の文脈は毎回添えて一括送信する(手動でGeminiチャットへ
  // コピペする場合もどのみち同じ情報を送ることになるため、という判断)。
  const questionBtn = el.querySelector('.star-card-summary-question-btn');
  if (questionBtn) {
    questionBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    questionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleSummaryDirectQuestion(card, el);
    });
  }

  // 「Geminiの回答を貼り付け」(2026年9月追加、Mapping Storysの伝承欄と同じ思想)。当初は
  // 「要約の傾向」欄をコピーしてgemini.google.comを新規タブで開くボタンも用意したが、
  // 「タスクバー等から自分でGeminiを開くのと変わらない」というユーザー自身の指摘を受け、
  // 同日中に撤去した(伝承欄でも同じ理由で撤去済み、CLAUDE.md参照)。自分で得た回答を
  // 貼り付けて保存する導線だけが、この機能でしかできないこととして残っている。保存すると
  // Education/Academicと同じ経路(createTextCard+summarySourceId+ASTR接続)で
  // 出力テクストカードになる。
  const pasteInput = el.querySelector('.star-card-summary-paste-input');
  const pasteBtn = el.querySelector('.star-card-summary-paste-btn');
  if (pasteInput) pasteInput.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (pasteBtn) {
    pasteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    pasteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pasted = (pasteInput?.value || '').trim();
      if (!pasted) return;
      const newCard = createTextCard(pasted);
      newCard.summarySourceId = card.id;
      newCard.x = card.x + 260 + (Math.random() * 80 - 20);
      newCard.y = card.y + (Math.random() * 240 - 120);
      const newEl = cardElById(newCard.id);
      if (newEl) {
        newEl.dataset.x = String(newCard.x);
        newEl.dataset.y = String(newCard.y);
        applyCardTransform(newEl);
      }
      createAstrConnection(card.id, newCard.id); // 効果音・発光演出・保存もここで行われる
      pasteInput.value = '';
      setStatus('Geminiの回答をテクストカードとして保存しました');
    });
  }
  // Crewsモジュールが描画したペルソナのヘックス(.star-card-summary-crew-btn、data-crew-id持ち)。
  // タップ(短押し)は通常のEducation/Academicボタンと同じhandleSummaryGenerate()を、モードの
  // 代わりにcrewIdで呼ぶ。長押しは生成せず、window.showCrewInfoPopup()で【人物情報】【その言葉】を
  // 見返せる(表示名=ニックネームだけでは元の人物情報を思い出せない、というユーザー要望への対応)。
  el.querySelectorAll('.star-card-summary-crew-btn').forEach((btn) => {
    let longPressTimer = null;
    let longPressed = false;
    btn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      longPressed = false;
      longPressTimer = setTimeout(() => {
        longPressed = true;
        if (window.showCrewInfoPopup) window.showCrewInfoPopup(btn.dataset.crewId);
      }, CARD_LONG_PRESS_MS);
    });
    const clearLongPress = () => { clearTimeout(longPressTimer); longPressTimer = null; };
    btn.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      clearLongPress();
      if (!longPressed) handleSummaryGenerate(card, el, btn.dataset.crewId);
    });
    btn.addEventListener('pointerleave', clearLongPress);
    btn.addEventListener('pointercancel', clearLongPress);
  });
}

function createSummaryCard(x, y) {
  const spawnPos = (x === undefined || y === undefined) ? newCardSpawnPos() : null;
  const card = {
    id: crypto.randomUUID(),
    x: x ?? spawnPos.x,
    y: y ?? spawnPos.y,
    width: 260,
    height: 200,
    mediaType: 'summary',
    summaryDirection: '',
    imageFileId: null,
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  setStatus('サマリーカードを追加しました');
  scheduleAutoSave();
  return card;
}

/**
 * 写真カードの編集ガイド「Summon」: この写真に接続された状態のサマリーカードを新規作成する
 * ショートカット(通常の「サマリーカードを作る→ASTRで写真を手動接続する」の2手順を1手順に)。
 */
function handleSummonSummary(card) {
  if (card.mediaType !== 'image') return;
  const summaryCard = createSummaryCard(card.x - 260 - (Math.random() * 80 - 20), card.y + (Math.random() * 240 - 120));
  createAstrConnection(card.id, summaryCard.id); // 効果音・発光演出・保存もここで行われる
}

/**
 * セッション(と入れ子の子セッション全て)にあるカードのテキストを、見出し付きの1つの文章に
 * まとめる。サマリーカード自身と、過去にサマリーから生成されたテクストカード
 * (card.summarySourceId持ち)は、要約が要約を再帰的に参照しないよう対象から除く。
 * sources配列(呼び出し側が空配列を渡す)に、本文中の[出典N]タグの順でcard.idを積んでいく。
 * Geminiに「どの出典を一番参考にしたか」を番号で答えさせ、後から実際のカードへ引き当てる
 * (=最も参考にしたカードへ自動でASTR接続する)ための下ごしらえ。
 */
function collectSessionTextContext(sessionId, sources, depth = 0) {
  if (depth > 10) return ''; // 循環参照などに備えた保険
  const session = getSessionById(sessionId);
  if (!session) return '';
  const indent = '  '.repeat(depth);
  const lines = [`${indent}■ ${session.name}`];
  // Mapping Storys(js/modules/mapping-storys.js)で調べた「この土地の伝承」があれば、
  // 地図と展覧会セッションの「あいだ」を語らせる材料として、出典番号は振らず素直に混ぜ込む
  // (ASTR手動接続・出典自動接続の仕組みには一切手を加えない、というユーザー方針)。
  if (window.getMapLayers) {
    window.getMapLayers(session).forEach((layer) => {
      if (layer.loreText && layer.loreText.trim()) {
        lines.push(`${indent}- [地図の伝承] ${layer.loreText.trim()}`);
      }
    });
  }
  state.cards
    .filter((c) => c.sessionId === sessionId)
    .forEach((c) => {
      if (c.mediaType === 'session') {
        const nested = collectSessionTextContext(c.refSessionId, sources, depth + 1);
        if (nested) lines.push(nested);
      } else if (c.mediaType === 'summary' || c.summarySourceId) {
        // 要約カード自身と、過去に要約から生成されたテクストカードは参照しない
      } else if (c.mediaType === 'book') {
        // Almagest(書物モジュール)の参照カード(2026年9月追加)。カード自身は本文を
        // 持たない(card.almagestEntryIdで参照するだけ)ため、window.getAlmagestEntryById()で
        // 実体を引き当て、タイトル+本文冒頭だけを短く混ぜ込む(全文を混ぜると要約の文脈が
        // 薄まるため、Mapping Storysの伝承欄と同様スニペットに留める)。参照先が削除済みなら
        // 何も足さない。
        const entry = window.getAlmagestEntryById ? window.getAlmagestEntryById(c.almagestEntryId) : null;
        if (entry) {
          // 本文が今メモリ上に無ければ(=このセッションでまだ開いていない本)、索引に
          // 残してある抜粋(entry.excerpt)で代用する(2026年9月、Almagestの「本を開いた時に
          // 内容をロードする」変更に伴う対応。全文を読み込みに行くとこの一覧関数自体が
          // 重くなるため、あくまで既にある情報の範囲で済ませる)。
          const snippet = (entry.bodyText || entry.excerpt || '').trim().slice(0, 200);
          sources.push(c.id);
          lines.push(`${indent}- [出典${sources.length}][Almagest]『${entry.title || '(無題)'}』${snippet}`);
        }
      } else if (c.memo && c.memo.trim()) {
        const label = c.mediaType === 'text' ? 'テキスト' : c.mediaType === 'info' ? 'インフォ' : c.mediaType === 'comment' ? 'コメント' : 'キャプション/メモ';
        sources.push(c.id);
        lines.push(`${indent}- [出典${sources.length}][${label}] ${c.memo.trim()}`);
      }
    });
  return lines.join('\n');
}

/** 与えたdata URL(サムネイル)をGeminiに渡せる{base64, mimeType}の形に分解する */
function dataUrlToImagePart(dataUrl) {
  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

// サマリーカードにASTRで手動接続できる写真の上限。繋げば繋ぐほどGeminiへの画像添付が増え、
// 無料枠(1日250)をすぐ消費してしまうため、常識的な枚数に制限しておく。
const SUMMARY_MAX_CONNECTED_IMAGES = 6;

/**
 * サマリーカードにASTRで手動接続されている、画像カードのサムネイルを集める(動画・音声は
 * 対象外。Geminiへ送るデータ量が増えて無料枠をすぐ消費してしまうため、ユーザーの判断で除外)。
 */
function collectConnectedImageParts(cardId) {
  const connectedIds = state.connections
    .filter((c) => c.cardIdA === cardId || c.cardIdB === cardId)
    .map((c) => (c.cardIdA === cardId ? c.cardIdB : c.cardIdA));
  const parts = [];
  for (const id of connectedIds) {
    if (parts.length >= SUMMARY_MAX_CONNECTED_IMAGES) break;
    const c = getCardById(id);
    if (!c || c.mediaType !== 'image' || !c.thumbDataUrl) continue;
    const part = dataUrlToImagePart(c.thumbDataUrl);
    if (part) parts.push(part);
  }
  return parts;
}

const summaryInFlight = new Set();

/**
 * @param {string} modeOrCrewId 'education'|'academic'、またはCrewsモジュールのペルソナID。
 *   ペルソナIDかどうかはwindow.getCrewById()に問い合わせて判定する(crews.js未読み込み時は
 *   常にeducation/academicの2択のまま、従来通り動く)。
 */
async function handleSummaryGenerate(card, el, modeOrCrewId) {
  const crew = window.getCrewById ? window.getCrewById(modeOrCrewId) : null;
  const mode = crew ? null : modeOrCrewId;
  if (!crew && mode !== 'education' && mode !== 'academic') return;
  if (summaryInFlight.has(card.id)) return;
  summaryInFlight.add(card.id);
  const btns = el.querySelectorAll('.star-card-summary-btn, .star-card-summary-crew-btn, .star-card-summary-question-btn');
  btns.forEach((b) => { b.disabled = true; });

  const speakerLabel = crew ? crew.name : (mode === 'education' ? 'Boy' : 'Professor');
  setStatus(`${speakerLabel}の要約を作成中…`, { busy: true });
  try {
    const sources = [];
    const context = collectSessionTextContext(card.sessionId, sources);
    const direction = (el.querySelector('.star-card-summary-input')?.value || '').trim();
    card.summaryDirection = direction;
    const images = collectConnectedImageParts(card.id);
    const persona = crew ? window.getCrewNarrativeParts(crew) : undefined;
    const { answer, mostRelevantSource } = await summarizeSession({ context, mode, persona, direction, images });
    // 要約傾向に質問文を入れても素直に回答が返ってくるため、後から見返した時に「何を
    // 指示して出てきた要約か」が分かるよう、指示文をQ.として冒頭に残しておく。
    const textWithDirection = direction ? `Q. ${direction}\n\n${answer}` : answer;

    const newCard = createTextCard(textWithDirection);
    newCard.summarySourceId = card.id;
    if (crew) {
      // 通常のテクストカードと一目で区別できるよう、renderCard()側で水色グラスモーフの
      // 見た目(star-card--crew)とペルソナの名前・絵文字ヘッダーを付ける。
      newCard.crewPersonaId = crew.id;
      newCard.crewPersonaName = crew.name;
      newCard.crewPersonaAvatar = crew.avatar;
    }
    newCard.x = card.x + 260 + (Math.random() * 80 - 20);
    newCard.y = card.y + (Math.random() * 240 - 120);
    const newEl = cardElById(newCard.id);
    if (newEl) {
      newEl.dataset.x = String(newCard.x);
      newEl.dataset.y = String(newCard.y);
      applyCardTransform(newEl);
    }
    if (crew) rerenderCardInPlace(newCard, newEl); // crewPersonaId付与後のヘッダー表示を反映
    createAstrConnection(card.id, newCard.id); // 効果音・発光演出・保存もここで行われる

    // Geminiが「最も参考にした出典」を番号で答えていれば、そのカードへも別途ASTR接続する
    // (=どの記録が根拠になったかを、線でたどれるようにする)
    if (mostRelevantSource && sources[mostRelevantSource - 1]) {
      const sourceCardId = sources[mostRelevantSource - 1];
      if (sourceCardId !== newCard.id) createAstrConnection(sourceCardId, newCard.id);
    }
    setStatus(`${speakerLabel}の要約を作成しました`);
  } catch (err) {
    console.error(err);
    debugLog('サマリー生成エラー: ' + err.message);
    setStatus(`要約に失敗しました: ${err.message}`, { important: true });
  } finally {
    summaryInFlight.delete(card.id);
    btns.forEach((b) => { b.disabled = false; });
  }
}

/**
 * 「この質問をそのまま送る」(2026年9月追加)。Education/Academicのようなテンプレート
 * (JSON出力形式・文体指定・「前置きなしで書いて」等の指示文)を一切経由せず、「要約の傾向」欄の
 * 文面を質問としてそのままGeminiへ送る。手動でGeminiチャットへ同じ内容をコピペする場合も
 * どのみちセッションの文脈・接続画像を送ることになる、というユーザー判断により、ASTR接続画像
 * ・セッション全体の文脈は毎回まとめて添えて一括送信する(Mapping Storysの伝承欄の自由質問
 * モードと同じ「テンプレート化しない方が精度が高い」という知見の延長)。
 * **アステリズムフォーカス(2026年9月追加)**: サマリーカードから特定のカードへASTR接続が
 * あれば、それを「前置き不要・この接続先を中心に」という短い指示だけ足して伝える(質問文自体は
 * 加工しない)。接続先がテキスト系カードなら、collectSessionTextContext()が既に本文へ
 * 埋め込んでいる[出典N]番号で名指しする(内容を二重に埋め込まない)。写真カードなら
 * collectConnectedImageParts()の添付画像を指す一文を足す。接続が無ければ何も足さない。
 */
async function handleSummaryDirectQuestion(card, el) {
  const question = (el.querySelector('.star-card-summary-input')?.value || '').trim();
  if (!question) {
    setStatus('「要約の傾向」欄に質問を入力してください', { important: true });
    return;
  }
  if (summaryInFlight.has(card.id)) return;
  summaryInFlight.add(card.id);
  const btns = el.querySelectorAll('.star-card-summary-btn, .star-card-summary-crew-btn, .star-card-summary-question-btn');
  btns.forEach((b) => { b.disabled = true; });
  card.summaryDirection = question;
  setStatus('Geminiに質問を送信中…', { busy: true });
  try {
    const sources = [];
    const context = collectSessionTextContext(card.sessionId, sources);
    const images = collectConnectedImageParts(card.id);
    const connectedIds = state.connections
      .filter((c) => c.cardIdA === card.id || c.cardIdB === card.id)
      .map((c) => (c.cardIdA === card.id ? c.cardIdB : c.cardIdA));
    const focusSourceNums = connectedIds
      .map((id) => sources.indexOf(id))
      .filter((idx) => idx !== -1)
      .map((idx) => idx + 1);
    let focusInstruction = '';
    if (focusSourceNums.length > 0 || images.length > 0) {
      const targets = [];
      if (focusSourceNums.length > 0) targets.push(focusSourceNums.map((n) => `[出典${n}]`).join(''));
      if (images.length > 0) targets.push('添付した写真に写っている作品');
      focusInstruction =
        `${targets.join('と')}を中心に取り上げて答えてください。前置き・見出しを書かず、` +
        '最初の一文から本題そのものについて書き始めてください。\n\n';
    }
    const prompt = `${context ? context + '\n\n' : ''}${focusInstruction}${question}`;
    const raw = await askGemini({ prompt, images });

    const newCard = createTextCard(raw.trim());
    newCard.summarySourceId = card.id;
    newCard.x = card.x + 260 + (Math.random() * 80 - 20);
    newCard.y = card.y + (Math.random() * 240 - 120);
    const newEl = cardElById(newCard.id);
    if (newEl) {
      newEl.dataset.x = String(newCard.x);
      newEl.dataset.y = String(newCard.y);
      applyCardTransform(newEl);
    }
    createAstrConnection(card.id, newCard.id); // 効果音・発光演出・保存もここで行われる
    setStatus('回答をテクストカードとして保存しました');
  } catch (err) {
    console.error(err);
    debugLog('サマリー直接質問エラー: ' + err.message);
    setStatus(`質問の送信に失敗しました: ${err.message}`, { important: true });
  } finally {
    summaryInFlight.delete(card.id);
    btns.forEach((b) => { b.disabled = false; });
  }
}

/* ---------------- チャットカード「座談会」(2026年9月実装、同月に自動カスケード方式へ改修) ----------------
 * サマリーカードの「🗣 座談会をひらく」から、Boy・Professor・Gemini(素の人格無し)・ONの
 * Crewsペルソナ全員を参加者とする新規カード(mediaType:'chat')を隣にポップアップさせる。
 * 参加者はカード作成時点のBoy/Professor/Gemini+ONのCrewsペルソナのスナップショットで固定し、
 * 後からCrewsのON/OFFを変えても既存の座談会カードの参加者は変わらない。
 *
 * **2026年9月改修**: 以前は「次の発言を進める」を押すたびに参加者をラウンドロビンで1人ずつ
 * 手動で呼び出す方式だった。実機でのユーザー要望を受け、質問コンポーザー(🎯宛先選択・📷写真
 * 添付・入力欄)から質問を送ると、宛先(未指定なら全員)がランダムな順・ランダムな間隔で自動的に
 * 1人ずつ返信する「LINEのような」カスケード方式に作り直した(runChatCascade())。
 * 「直前までの会話ログ全文を毎回渡した上で1人ずつ呼ぶ」という土台の仕組み自体は変えていない
 * ため、特別な相互作用エンジンを実装せずとも自然に相互言及が起きる、という既存の設計はそのまま
 * 活きている。1回の送信につき各参加者は最大1回しか発言しない(API暴走防止)。
 * 無料運用の範囲内(検索グラウンディング無し、APIキー経由のaskGemini()を直接呼ぶだけ)で、
 * 1発言=1回のAPI呼び出し。宛先を絞らず全員に聞くと、その場で参加者数ぶんのAPI呼び出しが
 * 連続して走ることになる(1日250回の共有プールを消費する点は変わらないため、宛先を絞る機能を
 * 用意した)。
 */

function buildRoundtableParticipants() {
  const list = [
    { kind: 'boy', id: 'boy', name: 'Boy', avatar: '👦' },
    { kind: 'professor', id: 'professor', name: 'Professor', avatar: '🎓' },
    { kind: 'gemini', id: 'gemini', name: 'Gemini', avatar: '✨' },
  ];
  (state.crews || []).filter((c) => c.enabled).forEach((c) => {
    const narrative = window.getCrewNarrativeParts ? window.getCrewNarrativeParts(c) : { personInfo: '', theirWords: '' };
    list.push({ kind: 'crew', id: c.id, name: c.name, avatar: c.avatar, ...narrative });
  });
  return list;
}

/**
 * カードを開いた瞬間に全参加者の返信が強制的に流れてしまう(=ユーザー自身の質問より先に
 * 大量のコメントが来る)という実機報告(2026年9月)を受け、質問は自動送信しないよう変更した。
 * 「要約の傾向」欄の文面は、送信済みの質問としてではなく、質問コンポーザーの入力欄へ
 * あらかじめ入れておくだけに留める。ユーザーが内容を確認し(必要なら🎯で宛先を絞り)、
 * 自分の意思で送信ボタンを押すまでは何も始まらない。
 */
function createChatCard(summaryCard, question) {
  const card = {
    id: crypto.randomUUID(),
    x: summaryCard.x + 300 + (Math.random() * 80 - 20),
    y: summaryCard.y + (Math.random() * 200 - 100),
    width: 320,
    height: 360,
    mediaType: 'chat',
    sessionId: summaryCard.sessionId,
    summarySourceId: summaryCard.id, // 出力カードと同じ扱い(自動線・collectSessionTextContext()から除外)
    chatParticipants: buildRoundtableParticipants(),
    chatMessages: [],
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  scheduleAutoSave();
  if (question) {
    const el = cardElById(card.id);
    const input = el ? el.querySelector('.star-card-chat-composer-input') : null;
    if (input) input.value = question;
  }
  return card;
}

/**
 * Almagest(書物モジュール、js/modules/almagest.js)の読書ビュー「🗣 読書会をひらく」から
 * 呼ばれる。座談会(createChatCard())と全く同じ仕組みのチャットカード(mediaType:'chat')を、
 * 今アクティブなセッションのキャンバスへ生成する(セッションのサマリーカードに紐付かないため、
 * 位置はnewCardSpawnPos()、sessionIdはactiveSessionId()を使う点だけが異なる)。
 * card.almagestEntryIdを持たせておくことで、fetchChatReply()がセッション文脈の代わりに
 * この本の内容を会話の文脈として使う(chatCardInnerHtml()のヘッダー表示の分岐にも使う)。
 */
function createBookChatCard(entryId) {
  const spawnPos = newCardSpawnPos();
  const card = {
    id: crypto.randomUUID(),
    x: spawnPos.x,
    y: spawnPos.y,
    width: 320,
    height: 360,
    mediaType: 'chat',
    sessionId: activeSessionId(),
    almagestEntryId: entryId,
    chatParticipants: buildRoundtableParticipants(),
    chatMessages: [],
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  scheduleAutoSave();
  return card;
}

/** 1件ぶんのメッセージ(質問 or 発言)をHTMLへ。初期描画・カスケード中の逐次追加の両方で使う。 */
function chatMessageHtml(m) {
  if (m.type === 'question') {
    const toHtml = m.targetNames ? ` <span class="star-card-chat-target-tag">→ ${escapeHtml(m.targetNames)}</span>` : '';
    const imgHtml = m.imageDataUrl ? `<img class="star-card-chat-question-img" src="${m.imageDataUrl}" alt="">` : '';
    return `<div class="star-card-chat-question">❓ ${escapeHtml(m.text)}${toHtml}${imgHtml}</div>`;
  }
  return (
    `<div class="star-card-chat-line${m.kind === 'crew' ? ' crew' : ''}">` +
    `<div class="star-card-chat-avatar">${escapeHtml(m.avatar || '')}</div>` +
    '<div class="star-card-chat-bubble">' +
    `<div class="star-card-chat-name">${escapeHtml(m.name || '')}</div>` +
    `<div class="star-card-chat-text">${escapeHtml(m.text || '')}</div>` +
    '</div></div>'
  );
}

/** 宛先選択ポップオーバーの選択肢一覧(参加者ぶんのボタン)。 */
function chatTargetOptionsHtml(card) {
  return (card.chatParticipants || []).map((p) => (
    `<button type="button" class="star-card-chat-target-option" data-id="${escapeHtml(p.id)}">` +
    `<span class="star-card-chat-avatar${p.kind === 'crew' ? ' crew' : ''}">${escapeHtml(p.avatar || '')}</span>` +
    `<span class="star-card-chat-target-option-name">${escapeHtml(p.name || '')}</span>` +
    '<span class="star-card-chat-target-option-check">✓</span>' +
    '</button>'
  )).join('');
}

function chatCardInnerHtml(card) {
  // Almagest(書物モジュール)の「読書会」チャットカードは、セッションではなく本の内容が
  // 話題のため、ヘッダーの見出しを本のタイトルへ差し替える(2026年9月追加)。
  const bookEntry = card.almagestEntryId && window.getAlmagestEntryById ? window.getAlmagestEntryById(card.almagestEntryId) : null;
  const headLabel = card.almagestEntryId
    ? `📖 読書会 — ${escapeHtml(bookEntry ? (bookEntry.title || '(無題)') : '(書庫から削除されました)')}`
    : (() => { const session = getSessionById(card.sessionId); return `座談会 — ${escapeHtml(session ? session.name : '(不明)')}`; })();
  const messages = card.chatMessages || [];
  const logHtml = messages.length
    ? messages.map((m) => chatMessageHtml(m)).join('')
    : '<p class="star-card-chat-empty">まだ発言はありません。質問を送ってみましょう。</p>';
  return `
    <p class="star-card-chat-head"><span class="dot"></span>${headLabel}</p>
    <div class="star-card-chat-log">${logHtml}</div>
    <div class="star-card-chat-attach-preview" hidden>
      <img class="star-card-chat-attach-thumb" alt="">
      <button type="button" class="star-card-chat-attach-clear" title="添付を外す">✕</button>
    </div>
    <div class="star-card-chat-target-popover" hidden>
      <p class="star-card-chat-target-label">誰に聞く?(未選択=全員)</p>
      <div class="star-card-chat-target-options">${chatTargetOptionsHtml(card)}</div>
      <p class="star-card-chat-target-summary">全員へ質問します</p>
    </div>
    <div class="star-card-chat-composer-row">
      <button type="button" class="star-card-chat-target-btn" title="質問の宛先を選ぶ">🎯<span class="star-card-chat-target-badge" hidden>0</span></button>
      <button type="button" class="star-card-chat-attach-btn" title="写真を添付">📷</button>
      <input type="file" class="star-card-chat-attach-input" accept="image/*" hidden>
      <input type="text" class="star-card-chat-composer-input" placeholder="質問を入力…">
      <button type="button" class="star-card-chat-send-btn" title="送信">➤</button>
    </div>
    <p class="star-card-chat-status"></p>
    ${EDIT_GUIDE_HANDLES_HTML}
    ${editGuideHexHtml('chat')}
  `;
}

function wireChatCard(card, el) {
  const logEl = el.querySelector('.star-card-chat-log');
  const targetBtn = el.querySelector('.star-card-chat-target-btn');
  const targetBadge = el.querySelector('.star-card-chat-target-badge');
  const targetPopover = el.querySelector('.star-card-chat-target-popover');
  const targetSummary = el.querySelector('.star-card-chat-target-summary');
  const attachBtn = el.querySelector('.star-card-chat-attach-btn');
  const attachInput = el.querySelector('.star-card-chat-attach-input');
  const attachPreview = el.querySelector('.star-card-chat-attach-preview');
  const attachThumb = el.querySelector('.star-card-chat-attach-thumb');
  const attachClearBtn = el.querySelector('.star-card-chat-attach-clear');
  const composerInput = el.querySelector('.star-card-chat-composer-input');
  const sendBtn = el.querySelector('.star-card-chat-send-btn');

  // このカードの現在の合成中(未送信)の宛先・添付画像。送信するたびにリセットする、
  // カードデータ(card.chatMessages)には含まれないUIだけの一時状態。
  let pendingTargetIds = new Set();
  let pendingImagePart = null; // askGemini()にそのまま渡せる{base64, mimeType}
  let pendingImageDataUrl = null; // 表示・保存用のdata URL(サムネイル)

  [targetBtn, attachBtn, attachClearBtn, sendBtn, composerInput, attachInput, targetPopover].forEach((elm) => {
    if (elm) elm.addEventListener('pointerdown', (e) => e.stopPropagation());
  });

  function updateTargetUI() {
    const n = pendingTargetIds.size;
    if (targetBadge) {
      targetBadge.textContent = String(n);
      targetBadge.hidden = n === 0;
    }
    if (targetBtn) targetBtn.classList.toggle('active', n > 0);
    if (targetSummary) targetSummary.textContent = n === 0 ? '全員へ質問します' : `${n}人へ名指しで質問します`;
  }

  if (targetBtn && targetPopover) {
    targetBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      targetPopover.hidden = !targetPopover.hidden;
    });
    targetPopover.querySelectorAll('.star-card-chat-target-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = opt.dataset.id;
        if (pendingTargetIds.has(id)) { pendingTargetIds.delete(id); opt.classList.remove('checked'); }
        else { pendingTargetIds.add(id); opt.classList.add('checked'); }
        updateTargetUI();
      });
    });
  }

  /** 📷ボタンからのファイル選択・クリップボード貼り付けの両方で使う、添付画像の反映処理。 */
  async function applyAttachedImageBlob(blob) {
    const dataUrl = await generateThumbnail(blob);
    if (!dataUrl) {
      setStatus('画像の読み込みに失敗しました', { important: true });
      return;
    }
    pendingImageDataUrl = dataUrl;
    pendingImagePart = dataUrlToImagePart(dataUrl);
    if (attachThumb) attachThumb.src = dataUrl;
    if (attachPreview) attachPreview.hidden = false;
  }

  if (attachBtn && attachInput) {
    attachBtn.addEventListener('click', (e) => { e.stopPropagation(); attachInput.click(); });
    attachInput.addEventListener('change', async () => {
      const file = attachInput.files && attachInput.files[0];
      if (!file) return;
      await applyAttachedImageBlob(file);
    });
  }
  if (attachClearBtn) {
    attachClearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pendingImageDataUrl = null;
      pendingImagePart = null;
      if (attachInput) attachInput.value = '';
      if (attachPreview) attachPreview.hidden = true;
    });
  }
  // 質問入力欄にフォーカスした状態でCtrl+V(コピーしてきた画像の貼り付け)しても添付できる
  // ようにする(2026年9月追加)。document全体のペースト処理(createCardFromCapture()経由で
  // 新規写真カードを作る方)は、テキスト入力中はテキストの貼り付けを妨げないよう既定で
  // スキップする作りになっているため、この入力欄専用に別途拾う必要がある。画像が無ければ
  // 通常のテキスト貼り付けに任せる(preventDefaultしない)。
  if (composerInput) {
    composerInput.addEventListener('paste', async (event) => {
      const items = event.clipboardData && event.clipboardData.items;
      if (!items) return;
      const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      event.preventDefault();
      event.stopPropagation();
      const blob = imageItem.getAsFile();
      if (!blob) return;
      await applyAttachedImageBlob(blob);
    });
  }

  function doSend() {
    const text = (composerInput?.value || '').trim();
    if (!text || chatTurnInFlight.has(card.id)) return;
    const targetIds = Array.from(pendingTargetIds);
    const targetNames = targetIds.length
      ? targetIds.map((id) => (card.chatParticipants || []).find((p) => p.id === id)?.name).filter(Boolean).join('・')
      : null;
    const questionMsg = { type: 'question', text, ts: Date.now() };
    if (targetNames) questionMsg.targetNames = targetNames;
    if (pendingImageDataUrl) questionMsg.imageDataUrl = pendingImageDataUrl;
    card.chatMessages = (card.chatMessages || []).concat([questionMsg]);
    scheduleAutoSave();
    appendChatLine(card.id, questionMsg);

    const imageParts = pendingImagePart ? [pendingImagePart] : undefined;
    composerInput.value = '';
    pendingTargetIds = new Set();
    pendingImageDataUrl = null;
    pendingImagePart = null;
    if (attachPreview) attachPreview.hidden = true;
    if (attachInput) attachInput.value = '';
    if (targetPopover) {
      targetPopover.hidden = true;
      targetPopover.querySelectorAll('.checked').forEach((o) => o.classList.remove('checked'));
    }
    updateTargetUI();

    runChatCascade(card, targetIds, imageParts);
  }

  if (sendBtn) sendBtn.addEventListener('click', (e) => { e.stopPropagation(); doSend(); });
  if (composerInput) {
    composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    });
  }

  // 写真付きカードのメモ欄と同じ理由(ホイールがカード自身/キャンバスのズームへ流れてしまう)で、
  // ログの中にカーソルがある時だけホイールをログ自身のスクロールに割り当てる。
  if (logEl) {
    el.addEventListener('wheel', (event) => {
      if (logEl.scrollHeight - logEl.clientHeight < 4) return;
      const rect = logEl.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) return;
      event.stopPropagation();
      logEl.scrollTop += event.deltaY * 0.35;
    });
  }

  if (chatTurnInFlight.has(card.id)) setChatComposerBusy(card.id, true);
}

// 宛先ポップオーバーの「外側クリックで閉じる」は、カードの数だけ document リスナーを増やさない
// よう、ここで1つだけグローバルに監視する(wireChatCard()はカードが再描画されるたびに呼ばれるため、
// カードごとに document.addEventListener してしまうとリスナーが際限なく積み重なってしまう)。
document.addEventListener('click', (e) => {
  document.querySelectorAll('.star-card-chat-target-popover:not([hidden])').forEach((pop) => {
    if (pop.contains(e.target)) return;
    const btn = pop.parentElement?.querySelector('.star-card-chat-target-btn');
    if (btn && (e.target === btn || btn.contains(e.target))) return;
    pop.hidden = true;
  });
});

function chatLogEl(cardId) {
  const el = cardElById(cardId);
  return el ? el.querySelector('.star-card-chat-log') : null;
}

/** カスケード中、参加者が返信を「考えている」ことを示す一時的なタイピングドット。 */
function appendChatTyping(cardId, speaker) {
  const log = chatLogEl(cardId);
  if (!log) return null;
  const node = document.createElement('div');
  node.className = 'star-card-chat-typing';
  node.innerHTML =
    `<div class="star-card-chat-avatar${speaker.kind === 'crew' ? ' crew' : ''}">${escapeHtml(speaker.avatar || '')}</div>` +
    '<div class="star-card-chat-typing-dots"><span></span><span></span><span></span></div>';
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

/** 1件ぶんのメッセージをログへ即座に追記する(カード全体の再描画はしない)。 */
function appendChatLine(cardId, m) {
  const log = chatLogEl(cardId);
  if (!log) return;
  const emptyEl = log.querySelector('.star-card-chat-empty');
  if (emptyEl) emptyEl.remove();
  const wrap = document.createElement('div');
  wrap.innerHTML = chatMessageHtml(m).trim();
  log.appendChild(wrap.firstElementChild);
  log.scrollTop = log.scrollHeight;
}

function setChatComposerBusy(cardId, busy) {
  const el = cardElById(cardId);
  if (!el) return;
  const sendBtn = el.querySelector('.star-card-chat-send-btn');
  const statusEl = el.querySelector('.star-card-chat-status');
  if (sendBtn) sendBtn.disabled = busy;
  if (statusEl) statusEl.textContent = busy ? '返信を待っています…' : '';
}

function shuffledArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chatTurnInFlight = new Set();

/**
 * 参加者の種別(kind)ごとの文体指示。座談会(fetchChatReply)・コメントカード
 * (fetchPersonaCommentOnCard)の両方で共通して使う(2026年9月、コメントカードの手動生成に
 * Boy/Professor/Geminiも選べるようにした際、重複していたこの分岐を1箇所へまとめた)。
 */
function personaStyleInstruction(p) {
  if (p.kind === 'boy') return '小学生・中学生にも分かるやさしい言葉で答えてください。';
  if (p.kind === 'professor') return '学術的な視点から答えてください。専門用語を使っても構いません。';
  if (p.kind === 'crew') return personaVoiceInstruction(p);
  return ''; // Gemini: 素の人格のまま、追加の文体指定なし
}

/** 1人ぶんの発言をGeminiに生成させる(直前までの会話ログ全文を文脈として渡す)。 */
/**
 * **2026年9月修正**: 「質問文に対しても独り言っぽい」という実機報告があった。原因は、
 * 質問(`[質問] ...`)もただの発言と同列に長い会話ログへ埋め込んでいるだけで、
 * 「今まさに答えるべき問い」として明示していなかったこと。プロンプトが「直前までの発言を
 * 踏まえて構いません」としか言っていないため、Geminiが質問を単なる文脈の一部として読み流し、
 * それぞれの立場から自由に一言つぶやくだけ(相互に無関係な独り言の並び)になりやすかった。
 * 対応: 会話ログの中で直近の質問(末尾から遡って最初に見つかった`type:'question'`)を
 * 別枠で取り出し、「まずその質問に直接答えること」をプロンプトで明示的に指示する。
 * 質問がまだ無い(通常のつぶやき合いの段階)場合は、従来通りの「賛成・反論・補足」の指示のみ。
 */
async function fetchChatReply(card, speaker, messages, imageParts) {
  // Almagest(書物モジュール)の「読書会」チャットカードは、セッションの記録ではなく本の
  // 内容そのものを会話の文脈として渡す(2026年9月追加、card.almagestEntryIdの有無で分岐)。
  const isBookChat = Boolean(card.almagestEntryId);
  const sessionContext = isBookChat
    ? (window.buildAlmagestChatContext ? await window.buildAlmagestChatContext(card.almagestEntryId) : '(この書物は書庫から削除されています)')
    : collectSessionTextContext(card.sessionId, []);
  const contextIntro = isBookChat ? '以下はある書物の内容です:' : '以下はある美術展覧会・セッションの記録です:';
  const gatheringLabel = isBookChat ? 'これは1冊の本を巡って複数の立場が一言ずつ感想・意見を交わす読書会のチャットです。' : 'これは複数の立場が一言ずつ意見を交わす座談会のチャットです。';
  const transcriptText = messages
    .map((m) => (m.type === 'question' ? `[質問] ${m.text}` : `[${m.name}] ${m.text}`))
    .join('\n');
  const styleInstruction = personaStyleInstruction(speaker);
  const lastQuestion = [...messages].reverse().find((m) => m.type === 'question');
  const responseInstruction = lastQuestion
    ? `直近の質問「${lastQuestion.text}」に対して、まずあなた自身の答え・考えを直接述べてください。他の参加者の発言を踏まえて賛成・反論・補足を加えても構いませんが、質問への回答から外れた独り言にはしないでください。`
    : '直前までの発言を踏まえて構いません(賛成・反論・補足など)。';
  const prompt =
    `${contextIntro}\n${sessionContext}\n\n` +
    `${gatheringLabel}ここまでの発言:\n` +
    `${transcriptText || '(まだ発言はありません)'}\n\n` +
    `あなたは次の話者「${speaker.name}」です。${styleInstruction}\n` +
    `${responseInstruction} 前置き・名乗りは書かず、1〜2文の短い一言だけを返してください。`;
  const raw = await askGemini({ prompt, images: imageParts });
  return raw.trim();
}

/**
 * 質問送信後、宛先(targetIdsが空なら全員)がランダムな順・ランダムな間隔で自動的に1人ずつ
 * 返信する(2026年9月、手動の「次の発言を進める」からLINEのような自動カスケードへ変更)。
 * 1回のこの呼び出しで各参加者は最大1回しか発言しない(API暴走防止)。カードが削除される等で
 * 見つからなくなったら、その時点で残りをそっと打ち切る。
 */
async function runChatCascade(card, targetIds, imageParts) {
  if (chatTurnInFlight.has(card.id)) return;
  const allParticipants = card.chatParticipants || [];
  const targets = targetIds.length
    ? allParticipants.filter((p) => targetIds.includes(p.id))
    : allParticipants;
  if (targets.length === 0) return;

  chatTurnInFlight.add(card.id);
  setChatComposerBusy(card.id, true);

  for (const speaker of shuffledArray(targets)) {
    if (!getCardById(card.id)) break;
    await sleep(500 + Math.random() * 700); // 人と人の「間」の演出(この間はまだ何も呼び出していない)
    const typingNode = appendChatTyping(card.id, speaker);
    try {
      // 「シュコッ」の音とコメント表示のタイミングがズレる不具合があった(2026年9月)。
      // 原因は、演出用の待ち時間が終わった直後に音を鳴らし、その"あとで"実際のGemini
      // 呼び出しを始めていたため、実際の応答が返ってくるまでの(読めない)時間ぶん、
      // 音だけが先に鳴っていたこと。タイピング表示中に実際の呼び出しを済ませておき、
      // 最低限のタイピング表示時間(演出)と実応答のどちらか長い方を待ってから、
      // 音と表示を同時に出すようにした。
      const messages = card.chatMessages || [];
      const [text] = await Promise.all([
        fetchChatReply(card, speaker, messages, imageParts),
        sleep(700 + Math.random() * 900),
      ]);
      if (typingNode) typingNode.remove();
      playChatReplySound();
      const replyMsg = { kind: speaker.kind, name: speaker.name, avatar: speaker.avatar, text, ts: Date.now() };
      card.chatMessages = messages.concat([replyMsg]);
      scheduleAutoSave();
      appendChatLine(card.id, replyMsg);
    } catch (err) {
      if (typingNode) typingNode.remove();
      console.error(err);
      debugLog('座談会エラー: ' + err.message);
      setStatus(`${speaker.name}の発言取得に失敗しました: ${err.message}`, { important: true });
    }
  }

  chatTurnInFlight.delete(card.id);
  setChatComposerBusy(card.id, false);
}

/* ---------------- コメントカード(2026年9月追加) ----------------
 * 顔文字(絵文字アバター)・名前・コメント本文だけの軽量な読み取り専用カード(mediaType:'comment')。
 * 座談会カードと同じくCrewsペルソナの声を借りるが、こちらは「セッション全体を要約する」
 * のではなく「1枚のカードに一言だけ反応する」軽いつぶやきという位置づけ。
 * カードとして永続するのはこの「付随タイプ」だけで、現れ方は2通り:
 * - 手動(このセクションのhandleCardComment()): 画像・動画・音声・テクストカードの編集ガイド
 *   「💬 Comment」から、ユーザーが選んだ(または唯一の)Crewsペルソナに一言コメントさせる
 * - 自動(後述のmaybeAddRandomCardComment()): 1日1回、全セッション横断でランダムに選んだ
 *   カードへ、ユーザーの操作なしで静かに付く
 * これとは別に、カードにならない一過性の「デイリーコメント」「グループビューイング」がある
 * (後述のセクション参照)。無料枠の消費を抑えるため、いずれも手動トリガーか低頻度(1日1〜3回・
 * 1分間隔)の自動トリガーに限り、無制限に呼び出す設計にはしていない。
 */

/**
 * 画像・動画・音声・テクストカードの編集ガイド「💬 Comment」。ONのCrewsペルソナが複数いる
 * 場合はshowChoiceDialog()でどのペルソナに聞くか選ばせる(1人だけなら聞かずそのまま使う)。
 */
async function handleCardComment(card, el) {
  // 2026年9月: Crewsペルソナだけでなく、座談会と同じ顔ぶれ(Boy/Professor/Gemini+ONのCrews)
  // から選べるようにした(buildRoundtableParticipants()は常に最低3人を返すため、
  // 「ペルソナがいない」という早期returnは不要になった)。
  const participants = buildRoundtableParticipants();
  const choice = await showChoiceDialog({
    title: '誰にコメントさせますか?',
    options: participants.map((p) => ({ label: `${p.avatar || '👤'} ${p.name}`, value: p.id })),
  });
  if (!choice) return;
  const persona = participants.find((p) => p.id === choice);
  if (!persona) return;

  setStatus(`${persona.name}のコメントを考え中…`, { busy: true });
  try {
    const text = await fetchPersonaCommentOnCard(persona, card);
    const newCard = createCommentCard({ sourceCard: card, persona, name: persona.name, avatar: persona.avatar || '👤', text });
    createAstrConnection(card.id, newCard.id); // 効果音・発光演出・保存もここで行われる
    setStatus('コメントを追加しました');
  } catch (err) {
    console.error(err);
    debugLog('コメント生成エラー: ' + err.message);
    setStatus(`コメントの生成に失敗しました: ${err.message}`, { important: true });
  }
}

function createCommentCard({ sourceCard, persona, name, avatar, text, x, y }) {
  const card = {
    id: crypto.randomUUID(),
    x: x ?? sourceCard.x + sourceCard.width + 40 + (Math.random() * 40 - 20),
    y: y ?? sourceCard.y + (Math.random() * 80 - 40),
    width: 190,
    height: 100,
    mediaType: 'comment',
    memo: text,
    commentName: name,
    commentAvatar: avatar,
    // Reply(2026年9月追加)でこのカードを座談会へ変換する際、buildRoundtableParticipants()の
    // どの参加者が発言していたかを引き当てるために持たせておく(kind: 'boy'|'professor'|
    // 'gemini'|'crew'、idはcrewの場合state.crews上のid)。
    commentPersonaKind: persona ? persona.kind : undefined,
    commentPersonaId: persona ? persona.id : undefined,
    sessionId: sourceCard.sessionId,
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  scheduleAutoSave();
  return card;
}

/**
 * コメントカードの「Reply」編集ガイド(2026年9月追加): このカード自体を座談会カード
 * (mediaType: 'chat')へ変換し、発言していたペルソナとの会話をそのまま続けられるようにする。
 * 新しい座談会カードを別途作るのではなく、このカードのIDと座標を保ったまま載せ替える。
 * 発言していたペルソナ(commentPersonaKind/commentPersonaId)を今のbuildRoundtableParticipants()
 * から引き当て、見つからない場合(ONから外されたCrews等)はコメント時点の名前・アバターだけで
 * 簡易的に参加者へ加える(会話の続きが成立しなくなるのを避けるため)。
 */
function handleCommentReply(card, el) {
  const participants = buildRoundtableParticipants();
  let persona = participants.find((p) => p.kind === card.commentPersonaKind && p.id === card.commentPersonaId);
  if (!persona) {
    persona = { kind: card.commentPersonaKind || 'crew', id: card.commentPersonaId || card.id, name: card.commentName, avatar: card.commentAvatar };
    participants.push(persona);
  }
  const firstMessage = { kind: persona.kind, name: card.commentName, avatar: card.commentAvatar, text: card.memo || '' };

  card.mediaType = 'chat';
  card.chatParticipants = participants;
  card.chatMessages = [firstMessage];
  card.width = 320;
  card.height = 360;
  delete card.memo;
  delete card.commentName;
  delete card.commentAvatar;
  delete card.commentPersonaKind;
  delete card.commentPersonaId;

  rerenderCardInPlace(card, el);
  scheduleAutoSave();
  setStatus('座談会に変換しました。続きの質問を送れます');
}

function commentCardInnerHtml(card) {
  return `
    <div class="star-card-comment-head">
      <div class="star-card-comment-avatar">${escapeHtml(card.commentAvatar || '')}</div>
      <div class="star-card-comment-name">${escapeHtml(card.commentName || '')}</div>
    </div>
    <div class="star-card-comment-text">${escapeHtml(card.memo || '')}</div>
    ${EDIT_GUIDE_HANDLES_HTML}
    ${editGuideHexHtml('comment')}
  `;
}

/* ---------------- デイリーコメント・コメント履歴・グループビューイング(2026年9月追加) ----------------
 * ユーザー指示により、以下の3つを明確に使い分ける:
 * - **デイリーコメント**: セッションを開くたびに(enterSession()/onSignedIn()から)判定し、
 *   1日3回まで、ONのCrewsペルソナの誰か1人が現在のセッションについて一言トースト表示する。
 * - **グループビューイング**: ヘッダーのボタンで手動ON/OFF。ONの間、1分に1回、直近に取り込まれた
 *   写真・記録に対してランダムなペルソナが一言コメントする(展覧会で撮影しながら使う想定)。
 * - **カードコメント(自動・全セッション横断)**: 1日1回、アプリ全体のどこかのカードから
 *   ランダムに1枚選び、ランダムなペルソナがASTR接続済みのコメントカードとして残す。
 *   「僕の認識外で進んでほしい」というユーザー要望により、setStatus等の通知は一切出さない。
 *
 * デイリーコメント・グループビューイングの発言は「コメント履歴」(state.commentHistory、
 * 最大COMMENT_HISTORY_MAX件、古い順に切り捨て)へ記録するだけの一過性データで、カードには
 * ならない。カードコメント(自動)だけが、削除可能な通常のカードとして永続する。この区別は
 * ユーザーが明確に指定したもの。
 */
const COMMENT_HISTORY_MAX = 100;

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** persona人物になりきらせる指示文(座談会・コメント系のプロンプトで共通して使う土台部分)。
 *  crew.personInfo/theirWords/photoTitlesはwindow.getCrewNarrativeParts()がConstellationの
 *  プロフィール/言葉/写真カードから集約した文字列(buildRoundtableParticipants()で埋め込み済み)。 */
function personaVoiceInstruction(crew) {
  let text =
    'あなたは次の人物になりきって話してください。あなた自身の言葉ではなく、必ずこの人物の一人称の語りとして書くこと。\n' +
    `【人物情報】\n${crew.personInfo}\n\n` +
    '【その言葉(この人物の語彙・言い回し・ものの見方を、以下の引用から読み取って声を似せること。引用をそのまま繰り返す必要はない)】\n' +
    `${crew.theirWords}`;
  if (crew.photoTitles && crew.photoTitles.length) {
    text += '\n\n【好きな作品】\n' + crew.photoTitles.map((t) => `・${t}`).join('\n');
  }
  return text;
}

function addCommentHistoryEntry({ name, avatar, text, source }) {
  state.commentHistory = state.commentHistory || [];
  state.commentHistory.push({ id: crypto.randomUUID(), name, avatar, text, source, ts: Date.now() });
  if (state.commentHistory.length > COMMENT_HISTORY_MAX) {
    state.commentHistory = state.commentHistory.slice(state.commentHistory.length - COMMENT_HISTORY_MAX);
  }
  scheduleAutoSave();
}

/** コメント履歴を閲覧するモーダル(既存のshowChoiceDialog()と同じ.modal-overlay/.modalを流用)。 */
function openCommentHistory() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const modal = document.createElement('div');
  modal.className = 'modal comment-history-modal';
  const heading = document.createElement('h2');
  heading.textContent = 'コメント履歴';
  const desc = document.createElement('p');
  desc.className = 'modal-desc';
  desc.textContent = 'デイリーコメント・グループビューイングの発言(最新100件)。カードには残らない一過性の記録です。';
  const list = document.createElement('div');
  list.className = 'comment-history-list';
  const entries = (state.commentHistory || []).slice().reverse();
  if (entries.length === 0) {
    list.innerHTML = '<p class="comment-history-empty">まだコメントはありません。</p>';
  } else {
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'comment-history-row';
      const sourceLabel = entry.source === 'group' ? 'グループビューイング' : 'デイリー';
      row.innerHTML = `
        <div class="comment-history-avatar">${escapeHtml(entry.avatar || '')}</div>
        <div class="comment-history-body">
          <div class="comment-history-meta"><b>${escapeHtml(entry.name || '')}</b><span>${escapeHtml(sourceLabel)}</span></div>
          <div class="comment-history-text">${escapeHtml(entry.text || '')}</div>
        </div>
      `;
      list.appendChild(row);
    });
  }
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'secondary';
  closeBtn.textContent = '閉じる';
  actions.appendChild(closeBtn);
  modal.appendChild(heading);
  modal.appendChild(desc);
  modal.appendChild(list);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  attachBackgroundTapToClose(overlay, close);
  document.body.appendChild(overlay);
}

/* ---- デイリーコメント: セッションを開くたび判定、1日3回まで ---- */

const DAILY_COMMENT_PROGRESS_KEY = 'constellation-daily-comment-progress';
const DAILY_COMMENT_MAX_PER_DAY = 3;

function readDailyCommentProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(DAILY_COMMENT_PROGRESS_KEY) || 'null');
    if (raw && raw.date === todayDateStr() && typeof raw.count === 'number') return raw;
  } catch (err) { /* 壊れたデータは無視して初期値を使う */ }
  return { date: todayDateStr(), count: 0 };
}
function writeDailyCommentProgress(progress) {
  try { localStorage.setItem(DAILY_COMMENT_PROGRESS_KEY, JSON.stringify(progress)); } catch (err) { /* 無視 */ }
}

async function maybeShowDailyComment() {
  // クイックモード中(2026年9月追加)は自動的にGeminiを呼ばない。「クイックカメラは撮影しただけ
  // では通信しない(美術様式リサーチを使った時だけ)」というユーザー指定を守るため。
  if (state.quickMode) return;
  const progress = readDailyCommentProgress();
  if (progress.count >= DAILY_COMMENT_MAX_PER_DAY) return;
  // 2026年9月: Crewsペルソナが1つもONになっていないと誰も喋らず「何も起きない」ままだった
  // という実機報告を受け、座談会・コメントカードのCommentヘックスと同じくBoy/Professor/Gemini
  // も候補に含める(buildRoundtableParticipants()は常に最低3人を返す)。
  const participants = buildRoundtableParticipants();
  const context = collectSessionTextContext(activeSessionId(), []);
  if (!context || !context.trim()) return; // 語れる中身が無いセッションでは1日ぶんの枠を消費しない

  // 先に枠を予約する(連続したセッション切り替えで多重に消費してしまわないよう、
  // Gemini応答を待つ前に「今回ぶんは使った」ことにする)。
  progress.count += 1;
  writeDailyCommentProgress(progress);

  const persona = participants[Math.floor(Math.random() * participants.length)];
  try {
    const styleInstruction = personaStyleInstruction(persona);
    const prompt =
      `${styleInstruction ? `${styleInstruction}\n\n` : ''}` +
      `以下はある美術展覧会・セッションの記録です:\n${context}\n\n` +
      'この記録をふと思い出したような、日々のちょっとしたつぶやきを一言だけ返してください。前置き・名乗りは書かず、1文だけにしてください。';
    const raw = await askGemini({ prompt });
    const text = raw.trim();
    showDailyCommentToast(persona, text);
    addCommentHistoryEntry({ name: persona.name, avatar: persona.avatar, text, source: 'daily' });
  } catch (err) {
    console.error(err);
    debugLog('デイリーコメントエラー: ' + err.message);
    progress.count -= 1; // 失敗した回は枠を返す(次のセッション開時に再挑戦できるように)
    writeDailyCommentProgress(progress);
  }
}

/** デイリーコメント・グループビューイングで共用するトースト。表示と同時に「シュコッ」を
 *  鳴らす(2026年9月追加、座談会の自動返信と同じ音・同じ関数を使い回す)。 */
let dailyCommentHideTimer = null;
function showDailyCommentToast(persona, text) {
  if (!els.dailyCommentToast) return;
  els.dailyCommentAvatar.textContent = persona.avatar || '👤';
  els.dailyCommentName.textContent = persona.name;
  els.dailyCommentText.textContent = text;
  els.dailyCommentToast.classList.add('show');
  playChatReplySound();
  clearTimeout(dailyCommentHideTimer);
  dailyCommentHideTimer = setTimeout(hideDailyCommentToast, 8000);
}

function hideDailyCommentToast() {
  clearTimeout(dailyCommentHideTimer);
  if (els.dailyCommentToast) els.dailyCommentToast.classList.remove('show');
}

/* ---- カードコメント(自動・全セッション横断、1日1回、ユーザーの認識外で静かに進める) ---- */

const CARD_COMMENT_DATE_KEY = 'constellation-card-comment-date';

/**
 * ASTR接続を「今アクティブなセッション」ではなく、渡されたsessionId(=カード自身の実際の
 * セッション)で作る、通知・効果音なしの静かな版。既存のcreateAstrConnection()は
 * activeSessionId()を使うため、ユーザーが今見ていないセッションのカード同士を繋ぐと
 * 誤ったsessionIdで保存されてしまう(=繋がったはずの線が永久に描画されない)。
 * 「僕の認識外で進んでほしい」という自動生成の性質上、効果音・発光演出・ステータス表示も
 * あえて鳴らさない。
 */
function createAstrConnectionSilent(cardIdA, cardIdB, sessionId) {
  if (!cardIdA || !cardIdB || cardIdA === cardIdB) return null;
  const exists = state.connections.some(
    (c) =>
      c.sessionId === sessionId &&
      ((c.cardIdA === cardIdA && c.cardIdB === cardIdB) || (c.cardIdA === cardIdB && c.cardIdB === cardIdA))
  );
  if (exists) return null;
  const connection = { id: crypto.randomUUID(), sessionId, cardIdA, cardIdB };
  state.connections.push(connection);
  return connection;
}

/** 対象カードの内容(メモ・写真ならサムネイル)を1文でコメントさせる、共通のプロンプト組み立て。 */
async function fetchPersonaCommentOnCard(persona, targetCard) {
  // 'imaginary'(Star Pencilのイマジナリーカード、2026年9月追加)も画像カードと同様、
  // thumbDataUrl(描いた線のラスタライズ)があれば一緒に渡す。「絵を見せて一言もらう」
  // という活用アイデアの実装。
  const imagePart = (targetCard.mediaType === 'image' || targetCard.mediaType === 'imaginary') && targetCard.thumbDataUrl
    ? dataUrlToImagePart(targetCard.thumbDataUrl)
    : null;
  const targetText = targetCard.memo && targetCard.memo.trim()
    ? targetCard.memo.trim()
    : '(この記録には文字情報がありません。写真があれば見た目だけから感じたことを一言どうぞ)';
  const styleInstruction = personaStyleInstruction(persona);
  const prompt =
    `${styleInstruction ? `${styleInstruction}\n\n` : ''}` +
    `次の記録を見て/読んで、一言だけ感想やつぶやきを返してください:\n${targetText}\n\n` +
    '前置き・名乗りは書かず、1文だけの短いつぶやきにしてください。';
  const raw = await askGemini({ prompt, images: imagePart ? [imagePart] : undefined });
  return raw.trim();
}

/* ---------------- カメラのターゲッティングスコープ(2026年9月追加) ----------------
 * 「美術版ジャーヴィスUI」というユーザー構想。十字の照準を対象物の上に載せて再タップすると、
 * Professorが呼ばれ、建築様式・文様の意匠・衣服のスタイルなど対象の種類に応じた美術的要素を
 * 解説する(js/camera.jsのhandleTargetTrigger()から呼ばれる)。撮影・カード化・履歴保存は
 * 一切行わず、フレームは使い捨て。ペルソナは常にProfessor固定(buildRoundtableParticipants()の
 * professorエントリと同じ人格、座談会のような参加者選択は行わない)。camera.jsはDOMを持たない
 * このファイルの関数を直接呼べない読み込み順(camera.js→app.js)のため、windowへ明示的に
 * 公開している。
 */
window.fetchArtTargetAnalysis = async function fetchArtTargetAnalysis(base64, mimeType) {
  const persona = { kind: 'professor', id: 'professor', name: 'Professor', avatar: '🎓' };
  const styleInstruction = personaStyleInstruction(persona);
  const prompt =
    `${styleInstruction}\n\n` +
    'この画像は、美術鑑賞中に十字の照準を対象へ合わせて切り出した一場面です。中心付近に写って' +
    'いるものが何かを見極め、その種類に最もふさわしい美術的な観点から短く解説してください' +
    '(建築物なら建築様式、文様・装飾なら意匠の詳細、衣服なら仕立てやスタイルというように、' +
    '対象の種類に応じて観点を選ぶこと)。前置き・名乗りは書かず、2〜3文程度で簡潔にまとめて' +
    'ください。';
  const raw = await askGemini({ prompt, images: [{ base64, mimeType }] });
  return raw.trim();
};

/**
 * アプリ起動時に1日1回、全セッション・全カードからランダムに1枚選び、ランダムなONの
 * Crewsペルソナにコメントさせて、ASTR接続済みの新規コメントカードとして残す。
 * ユーザー指示「僕の認識外で進んでほしい」により、成功・失敗どちらもsetStatus()等の
 * 通知は一切出さない(コンソール/デバッグログのみ)。
 */
async function maybeAddRandomCardComment() {
  try {
    if (localStorage.getItem(CARD_COMMENT_DATE_KEY) === todayDateStr()) return;
  } catch (err) {
    return;
  }
  // 2026年9月: Crewsペルソナが1つもONになっていないと何も起きないままだった実機報告を受け、
  // Boy/Professor/Geminiも候補に含める(buildRoundtableParticipants()は常に最低3人を返す)。
  const participants = buildRoundtableParticipants();
  const candidates = state.cards.filter((c) => COMMENTABLE_MEDIA_TYPES.includes(c.mediaType));
  if (candidates.length === 0) return;

  try {
    localStorage.setItem(CARD_COMMENT_DATE_KEY, todayDateStr());
  } catch (err) { /* 無視 */ }

  const targetCard = candidates[Math.floor(Math.random() * candidates.length)];
  const persona = participants[Math.floor(Math.random() * participants.length)];
  try {
    const text = await fetchPersonaCommentOnCard(persona, targetCard);
    const newCard = createCommentCard({ sourceCard: targetCard, persona, name: persona.name, avatar: persona.avatar || '👤', text });
    createAstrConnectionSilent(targetCard.id, newCard.id, targetCard.sessionId);
    scheduleAutoSave();
  } catch (err) {
    console.error(err);
    debugLog('カードコメント(自動)エラー: ' + err.message);
    try { localStorage.removeItem(CARD_COMMENT_DATE_KEY); } catch (e2) { /* 無視 */ } // 失敗は「今日はやった」扱いにしない
  }
}

/* ---- グループビューイングモード(手動ON/OFF、ONの間1分に1回) ---- */

let groupViewingActive = false;
let groupViewingTimer = null;
let groupViewingStartedAt = 0;
let groupViewingTickInFlight = false;
const GROUP_VIEWING_INTERVAL_DEFAULT_SEC = 60;
const GROUP_VIEWING_INTERVAL_MIN_SEC = 10; // API暴走防止の下限(Crews画面からの入力もここでクランプする)

/** Crewsモジュール画面(js/modules/crews.js)の設定入力で変えられる、コメント間隔(ミリ秒)。
 *  下限を下回る/未設定の値は既定の60秒として扱う。 */
function groupViewingIntervalMs() {
  const sec = state.groupViewingIntervalSec;
  const clamped = typeof sec === 'number' && sec >= GROUP_VIEWING_INTERVAL_MIN_SEC ? sec : GROUP_VIEWING_INTERVAL_DEFAULT_SEC;
  return clamped * 1000;
}

function isGroupViewingActive() {
  return groupViewingActive;
}

function toggleGroupViewing() {
  if (groupViewingActive) stopGroupViewing();
  else startGroupViewing();
}

function startGroupViewing() {
  if (groupViewingActive) return;
  groupViewingActive = true;
  groupViewingStartedAt = Date.now();
  updateGroupViewingButton();
  setStatus(`グループビューイングを開始しました(${groupViewingIntervalMs() / 1000}秒に1回、Crewsがコメントします)`);
  groupViewingTimer = setInterval(groupViewingTick, groupViewingIntervalMs());
}

/** js/modules/crews.jsの間隔設定が変わった時に呼ぶ。実行中なら新しい間隔でタイマーを
 *  張り直し、止まっていれば何もしない(次にstartGroupViewing()した時に反映される)。 */
function applyGroupViewingIntervalChange() {
  if (!groupViewingActive) return;
  clearInterval(groupViewingTimer);
  groupViewingTimer = setInterval(groupViewingTick, groupViewingIntervalMs());
}

function stopGroupViewing() {
  if (!groupViewingActive) return;
  groupViewingActive = false;
  clearInterval(groupViewingTimer);
  groupViewingTimer = null;
  updateGroupViewingButton();
  setStatus('グループビューイングを終了しました');
}

function updateGroupViewingButton() {
  if (!els.groupViewingBtn) return;
  els.groupViewingBtn.classList.toggle('group-viewing-btn--active', groupViewingActive);
  els.groupViewingBtn.textContent = groupViewingActive ? '👀 停止' : '👀 グループビューイング';
}

/**
 * 開始してから新しく取り込まれたカードがあればそれを最優先で対象にし、無ければ現在開いている
 * セッションのカードから選ぶ。ランダムなペルソナに一言コメントさせる。
 * **「展覧会現地だけでなく、家で見返している時にも機能してほしい。新規撮影に最も反応して
 * ほしいが、それを唯一のトリガーにはしないでほしい」というユーザー要望(2026年9月)**を受けて、
 * 「新着優先・無ければ今見ているセッション内から」の2段構えにした。以前は新着カードが
 * 無いティックは常にスキップしていたため、新しい写真を撮っていない(=家で見返しているだけの)
 * 間は永久に無反応だった。
 */
async function groupViewingTick() {
  if (groupViewingTickInFlight || !groupViewingActive) return;
  const participants = buildRoundtableParticipants();
  const freshCards = state.cards.filter(
    (c) => COMMENTABLE_MEDIA_TYPES.includes(c.mediaType) && new Date(c.createdAt).getTime() >= groupViewingStartedAt
  );
  let candidates = freshCards;
  let isFallback = false;
  if (candidates.length === 0) {
    candidates = state.cards.filter(
      (c) => c.sessionId === activeSessionId() && COMMENTABLE_MEDIA_TYPES.includes(c.mediaType)
    );
    isFallback = true;
  }
  if (candidates.length === 0) {
    debugLog('グループビューイング: 対象になる新着カード・現在のセッションのカードが無いためスキップ');
    return;
  }

  groupViewingTickInFlight = true;
  try {
    const targetCard = candidates[Math.floor(Math.random() * candidates.length)];
    const persona = participants[Math.floor(Math.random() * participants.length)];
    const text = await fetchPersonaCommentOnCard(persona, targetCard);
    showDailyCommentToast(persona, text); // トーストUIをデイリーコメントと共用する(ユーザー指示)
    addCommentHistoryEntry({ name: persona.name, avatar: persona.avatar, text, source: 'group' });
    debugLog(`グループビューイング: ${isFallback ? '現在のセッション内から' : '新着カードから'}選出`);
  } catch (err) {
    console.error(err);
    debugLog('グループビューイングコメントエラー: ' + err.message);
  } finally {
    groupViewingTickInFlight = false;
  }
}

/**
 * カード1枚を丸ごと作り直す(要素を差し替える)簡易ヘルパー。編集ガイド表示中ならそれも引き継ぐ。
 * 渡されたoldElだけでなく、同じcard.idを持つ要素を全て消してから作り直す(二重クリックなどで
 * 一時的に同じカードの要素が複数存在してしまった場合の保険)。
 */
function rerenderCardInPlace(card, oldEl) {
  const wasEditGuide = oldEl.classList.contains('star-card--edit-guide');
  els.content.querySelectorAll(`.star-card[data-id="${CSS.escape(String(card.id))}"]`).forEach((node) => node.remove());
  renderCard(card);
  const newEl = cardElById(card.id);
  if (wasEditGuide && newEl) activateEditGuide(newEl);
  redrawAsterismLines();
}

function toggleInfoCardExpanded(card, el) {
  card.infoExpanded = !card.infoExpanded;
  rerenderCardInPlace(card, el);
  scheduleAutoSave();
}

// 解析中に同じカードへ二重にGeminiを呼んでしまう(=カードが二重描画される、APIも無駄に消費する)
// のを防ぐための進行中フラグ集合。
const infoCardParseInFlight = new Set();

async function handleInfoCardParse(card, el) {
  if (infoCardParseInFlight.has(card.id)) return;

  const textEl = el.querySelector('.star-card-info-text');
  const text = (textEl ? textEl.value : card.memo) || '';
  card.memo = text;

  if (!text.trim()) {
    setStatus('展覧会ページの本文を貼り付けてください');
    return;
  }

  infoCardParseInFlight.add(card.id);
  const parseBtn = el.querySelector('.star-card-info-parse-btn');
  if (parseBtn) { parseBtn.disabled = true; parseBtn.textContent = '解析中…'; }

  setStatus('展覧会情報を解析中…', { busy: true });
  try {
    const result = await parseExhibitionInfo(text);
    if (result.error) {
      card.infoParsed = null;
      card.infoParseError = { message: result.error, partial: result.partial || {} };
      setStatus('解析できませんでした。空欄だけ手動で補ってください', { important: true });
    } else {
      card.infoParsed = result;
      normalizeInfoParsedExceptions(card.infoParsed);
      card.infoParseError = null;
      card.infoRawEditing = false; // 解析成功時は、コピペ欄をペンアイコンへ格納し直す
      setStatus('展覧会情報を解析しました。カレンダーに同期中…', { busy: true });
      const synced = await syncInfoCardCalendar(card);
      if (synced) setStatus('展覧会情報を解析し、カレンダーに同期しました');
    }
  } catch (err) {
    console.error(err);
    debugLog('展覧会情報の解析エラー: ' + err.message);
    card.infoParseError = { message: `通信に失敗しました: ${err.message}`, partial: {} };
    setStatus(`解析に失敗しました: ${err.message}`, { important: true });
  }
  infoCardParseInFlight.delete(card.id);
  rerenderCardInPlace(card, el);
  scheduleAutoSave();
  refreshInfoTicker();
}

async function handleInfoCardManualFix(card, el) {
  const val = (cls) => el.querySelector(cls)?.value.trim() || '';
  const startDate = val('.fix-start');
  const endDate = val('.fix-end');
  const openTime = val('.fix-open');
  const closeTime = val('.fix-close');
  if (!startDate || !endDate) {
    setStatus('開始日・終了日は入力してください');
    return;
  }
  const partial = (card.infoParseError && card.infoParseError.partial) || {};
  card.infoParsed = {
    title: partial.title || null,
    venue: partial.venue || null,
    startDate,
    endDate,
    openTime: openTime || null,
    closeTime: closeTime || null,
    closedWeekdays: partial.closedWeekdays || [],
    exceptions: partial.exceptions || [],
  };
  normalizeInfoParsedExceptions(card.infoParsed);
  card.infoParseError = null;
  card.infoRawEditing = false; // 手動確定時も、コピペ欄をペンアイコンへ格納し直す
  setStatus('手動入力の内容で確定しました。カレンダーに同期中…', { busy: true });
  const synced = await syncInfoCardCalendar(card);
  rerenderCardInPlace(card, el);
  if (synced) setStatus('手動入力の内容で確定し、カレンダーに同期しました');
  scheduleAutoSave();
  refreshInfoTicker();
}

/**
 * 既に解析済みのカードを、Geminiを呼ばずに(=無料枠を消費せずに)カレンダーへ同期し直す。
 * Gemini無料枠が1日20リクエストしかなく、複数のインフォカードを一度に登録すると
 * すぐ枯渇しうるため、「再解析はしたくないが、カレンダー同期だけやり直したい」場合の入口。
 */
async function handleInfoCardResync(card, el) {
  if (!card.infoParsed || infoCardParseInFlight.has(card.id)) return;
  infoCardParseInFlight.add(card.id);
  const resyncBtn = el.querySelector('.star-card-info-resync-btn');
  if (resyncBtn) { resyncBtn.disabled = true; resyncBtn.textContent = '同期中…'; }

  setStatus('カレンダーに同期中…', { busy: true });
  const synced = await syncInfoCardCalendar(card);
  infoCardParseInFlight.delete(card.id);
  if (resyncBtn) { resyncBtn.disabled = false; resyncBtn.textContent = 'カレンダーに同期'; }
  if (synced) setStatus('カレンダーに同期しました');
  scheduleAutoSave();
}

/* ---- 「今日は鑑賞可能か」の判定(ローカルJSのみ、API不要) ---- */

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Geminiの解析結果には、本当は「例外」ではないexceptionが混ざることがある。2パターン
 * 見つかっている。
 * 1. 同じ日にopenとclosedが矛盾して両方入っている(期間限定で開廊するopen exceptionの
 *    期間内の曜日を、休廊曜日だからと個別にclosedでも列挙してしまう)
 * 2. closedWeekdaysに何も休廊日が無いのに、会期全体をまるごと1つのopen exceptionにして
 *    しまう(休廊日パターンを何も上書きしていない、ただの冗長な記載)
 * どちらも「そのexceptionが無くても結果が変わらない」という共通の性質を持つため、card.infoParsed
 * 自体から取り除く。カードを描画するたびに呼ぶので、過去に(この正規化の実装前に)解析済みの
 * カードも、再解析なしで次に開いた時点で自動的にきれいになる。
 */
function normalizeInfoParsedExceptions(parsed) {
  if (!parsed || !Array.isArray(parsed.exceptions) || parsed.exceptions.length === 0) return;
  const closedWeekdays = parsed.closedWeekdays || [];
  const overlaps = (a, b) => !(a.endDate < b.startDate || a.startDate > b.endDate);
  const opens = parsed.exceptions.filter((ex) => ex.type === 'open' && ex.startDate && ex.endDate);
  const closeds = parsed.exceptions.filter((ex) => ex.type === 'closed' && ex.startDate && ex.endDate);
  const overridesClosedWeekday = (ex) => {
    const cursor = new Date(`${ex.startDate}T00:00:00`);
    const end = new Date(`${ex.endDate}T00:00:00`);
    while (cursor <= end) {
      if (closedWeekdays.includes(cursor.getDay())) return true;
      cursor.setDate(cursor.getDate() + 1);
    }
    return false;
  };
  parsed.exceptions = parsed.exceptions.filter((ex) => {
    if (!ex.startDate || !ex.endDate) return true; // 日付が無いものは判断できないのでそのまま残す
    if (ex.type === 'closed') return !opens.some((o) => overlaps(ex, o));
    // open: 休廊曜日 or 他のclosed exception を1日も上書きしないなら、何も変えていない冗長な記載
    return overridesClosedWeekday(ex) || closeds.some((c) => overlaps(ex, c));
  });
}

function isExhibitionVisitableOn(parsed, date) {
  if (!parsed || !parsed.startDate || !parsed.endDate) return false;
  const ymd = formatDateYMD(date);
  if (ymd < parsed.startDate || ymd > parsed.endDate) return false;
  const exceptions = parsed.exceptions || [];
  const matchesType = (type) =>
    exceptions.some((ex) => ex.type === type && ex.startDate && ex.endDate && ymd >= ex.startDate && ymd <= ex.endDate);
  // Geminiの解析結果が、同じ日付にopenとclosedの矛盾したexceptionを両方含めてしまうことがある
  // (例: 「休廊日+期間限定で開廊」の期間中の日を、休廊日の曜日だからと個別にclosedでも列挙してしまう)。
  // そのため単純な最初にマッチしたもの勝ちにはせず、明示的なopenの記載を優先する。
  if (matchesType('open')) return true;
  if (matchesType('closed')) return false;
  const closedWeekdays = parsed.closedWeekdays || [];
  return !closedWeekdays.includes(date.getDay());
}

/* ---- インフォメーションカードの「鑑賞可能日」をGoogleカレンダー(「展覧会」)へ同期する ----
 * ガントチャートのように、実際に鑑賞できる日のまとまり(連続した開廊日ブロック)ごとに
 * 終日イベントを1つ作る。休廊日を挟むと複数ブロックに分かれる。
 * 常時バックグラウンド同期ではなく、このアプリを開いて解析/手動修正した瞬間だけ動く
 * (静的サイト+API直接呼び出しという構成上の制約)。 */

function addOneDayYMD(ymd) {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return formatDateYMD(d);
}

/** 会期中、実際に鑑賞可能な日を連続ブロックに分けて返す([{start, end}, ...]、両端含む) */
function computeVisitableBlocks(parsed) {
  if (!parsed || !parsed.startDate || !parsed.endDate) return [];
  const blocks = [];
  let blockStart = null;
  let prevYmd = null;
  const cursor = new Date(`${parsed.startDate}T00:00:00`);
  const end = new Date(`${parsed.endDate}T00:00:00`);
  while (cursor <= end) {
    const ymd = formatDateYMD(cursor);
    if (isExhibitionVisitableOn(parsed, cursor)) {
      if (!blockStart) blockStart = ymd;
      prevYmd = ymd;
    } else if (blockStart) {
      blocks.push({ start: blockStart, end: prevYmd });
      blockStart = null;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (blockStart) blocks.push({ start: blockStart, end: prevYmd });
  return blocks;
}

/**
 * カードの解析済み情報を「展覧会」カレンダーに反映する。差分更新はせず、このカードに紐づく
 * 既存イベントを一旦全て消してから、鑑賞可能ブロックの数だけ作り直す(個人利用の規模では
 * API呼び出し回数は問題にならないため、差分計算より単純さを優先した)。
 * 失敗してもインフォカード自体の解析結果は失わない(ベストエフォート、エラーはコンソールのみ)。
 */
async function syncInfoCardCalendar(card) {
  if (!card.infoParsed) return false;
  try {
    state.exhibitionCalendarId = await ensureExhibitionCalendar(state.exhibitionCalendarId);
    const existing = await listCardCalendarEvents(state.exhibitionCalendarId, card.id);
    await Promise.all(existing.map((ev) => deleteCalendarEvent(state.exhibitionCalendarId, ev.id).catch(() => {})));

    const parsed = card.infoParsed;
    const summary = parsed.venue ? `${parsed.title || '(無題)'} - ${parsed.venue}` : (parsed.title || '(無題の展覧会)');
    const blocks = computeVisitableBlocks(parsed);
    for (const block of blocks) {
      await insertCalendarEvent(state.exhibitionCalendarId, {
        summary,
        description: exhibitionSearchUrl(parsed) || undefined,
        start: { date: block.start },
        end: { date: addOneDayYMD(block.end) },
        extendedProperties: { private: { constellationCardId: String(card.id) } },
      });
    }
    return true;
  } catch (err) {
    console.error(err);
    debugLog('カレンダー同期エラー: ' + err.message);
    setStatus(`カレンダー同期に失敗しました: ${err.message}`, { important: true });
    return false;
  }
}

/** インフォカード削除時、そのカードに紐づくカレンダーイベントも削除する */
async function removeInfoCardCalendarEvents(card) {
  if (!state.exhibitionCalendarId) return;
  try {
    const existing = await listCardCalendarEvents(state.exhibitionCalendarId, card.id);
    await Promise.all(existing.map((ev) => deleteCalendarEvent(state.exhibitionCalendarId, ev.id).catch(() => {})));
  } catch (err) {
    console.error(err);
  }
}

/** セッションIDから、その先祖をたどって年セッションのIDを返す */
function sessionYearRootId(sessionId) {
  let s = getSessionById(sessionId);
  let guard = 0;
  while (s && s.type !== 'year' && guard < 30) {
    s = getSessionById(s.parentId);
    guard++;
  }
  return s ? s.id : null;
}

/** 年セッションから対象セッションまでのパンくず(breadcrumb)配列を作る */
function breadcrumbPathTo(sessionId) {
  const path = [];
  let s = getSessionById(sessionId);
  let guard = 0;
  while (s && guard < 30) {
    path.unshift(s.id);
    if (s.type === 'year') break;
    s = getSessionById(s.parentId);
    guard++;
  }
  return path;
}

/**
 * カードが属するセッション(年→...→対象セッション)の階層を、Drive上の入れ子フォルダとして
 * 解決する(Constellation/media/<年名>/<セッション名>/.../)。各セッションが最初にメディアを
 * 持った時だけDrive側にフォルダを作成し、そのIDをsession.driveMediaFolderIdとしてキャッシュする
 * (以後は同じフォルダを使い回し、Driveへの問い合わせを毎回は行わない)。
 */
async function resolveSessionMediaFolderId(sessionId) {
  const path = breadcrumbPathTo(sessionId);
  let parentId = state.mediaFolderId;
  for (const id of path) {
    const session = getSessionById(id);
    if (!session) continue;
    if (!session.driveMediaFolderId) {
      session.driveMediaFolderId = await findOrCreateSubfolder(session.name, parentId);
      scheduleAutoSave();
    }
    parentId = session.driveMediaFolderId;
  }
  return parentId;
}

/**
 * 2026年9月の入れ子フォルダ構造導入より前にアップロード済みだった(Constellation/直下に
 * フラットなままの)メディアファイルを、対応するセッションの入れ子フォルダへ移動する
 * 一度きりの移行処理。ブラウザのコンソールから `migrateExistingMediaToFolders()` を実行する。
 */
async function migrateExistingMediaToFolders() {
  const targets = state.cards.filter((c) => c.imageFileId && ['image', 'video', 'audio'].includes(c.mediaType));
  if (targets.length === 0) {
    setStatus('移行対象のメディアはありません');
    return;
  }
  if (!window.confirm(`${targets.length}件のメディアファイルを、Drive上で新しいフォルダ構造へ移動します。よろしいですか?`)) {
    return;
  }

  let done = 0;
  let failed = 0;
  for (const card of targets) {
    setStatus(`移行中… (${done}/${targets.length})`, { progress: done / targets.length });
    try {
      const folderId = await resolveSessionMediaFolderId(card.sessionId);
      await moveFile(card.imageFileId, folderId);
    } catch (err) {
      console.error('移行に失敗:', card.id, err);
      failed++;
    }
    done++;
  }
  setStatus(`移行完了(${done - failed}/${targets.length}件成功${failed ? `、${failed}件失敗(コンソール参照)` : ''})`, { important: true });
  scheduleAutoSave();
}
window.migrateExistingMediaToFolders = migrateExistingMediaToFolders;

/** 現在の年タブ内で、今日鑑賞可能なインフォメーションカードを集める(階層をまたいだ全年横断はしない) */
function collectVisitableInfoCards() {
  const currentYearId = state.breadcrumb[0];
  if (!currentYearId) return [];
  const today = new Date();
  return state.cards.filter((c) => {
    if (c.mediaType !== 'info' || !c.infoParsed) return false;
    if (sessionYearRootId(c.sessionId) !== currentYearId) return false;
    return isExhibitionVisitableOn(c.infoParsed, today);
  });
}

/** インフォメーションカードが入っているセッションまでパンくずを遡ってから、その位置へジャンプする */
function jumpToInfoCard(card) {
  state.breadcrumb = breadcrumbPathTo(card.sessionId);
  renderYearTabs();
  renderBreadcrumb();
  renderAllCards();
  scheduleAutoSave(); // 前回作業していた場所として復元できるよう、パンくずの変更も保存する
  requestAnimationFrame(() => {
    const el = cardElById(card.id);
    if (!el) return;
    const rect = els.viewport.getBoundingClientRect();
    els.content.classList.add('canvas-content--animated');
    viewportState.x = rect.width / 2 - (card.x + card.width / 2) * viewportState.scale;
    viewportState.y = rect.height / 2 - (card.y + card.height / 2) * viewportState.scale;
    applyViewportTransform();
    setTimeout(() => els.content.classList.remove('canvas-content--animated'), 400);
    el.classList.add('star-card--landed');
    setTimeout(() => el.classList.remove('star-card--landed'), 1600);
  });
}

/* ---- ヘッダーのティッカー(現在の年タブ内で鑑賞可能な展覧会をローテーション表示) ---- */

let infoTickerItems = [];
let infoTickerIndex = 0;
let infoTickerTimer = null;
const INFO_TICKER_ROTATE_MS = 5000;

function refreshInfoTicker() {
  infoTickerItems = collectVisitableInfoCards();
  infoTickerIndex = 0;
  renderInfoTicker();
}

function renderInfoTicker() {
  if (!els.infoTicker) return;
  if (infoTickerTimer) {
    clearInterval(infoTickerTimer);
    infoTickerTimer = null;
  }
  if (infoTickerItems.length === 0) {
    els.infoTicker.hidden = true;
    return;
  }
  els.infoTicker.hidden = false;
  const card = infoTickerItems[infoTickerIndex];
  const parsed = card.infoParsed;
  els.infoTickerText.textContent = parsed.venue ? `${parsed.title} — ${parsed.venue}` : parsed.title;
  els.infoTickerProgress.innerHTML = infoTickerItems
    .map((_, i) => `<span class="${i === infoTickerIndex ? 'active' : ''}"></span>`)
    .join('');

  if (infoTickerItems.length > 1) {
    infoTickerTimer = setInterval(() => {
      infoTickerIndex = (infoTickerIndex + 1) % infoTickerItems.length;
      renderInfoTicker();
    }, INFO_TICKER_ROTATE_MS);
  }
}

/* ---------------- 画像・動画・音声の遅延読み込み ----------------
 * キャンバス上に大量のカードを置いても、実際に画面内へ入ったものだけをDriveから取得する。
 * 取得済みのfileIdはキャッシュし、セッションの行き来などで再描画されても再取得しない。 */

const blobUrlCache = new Map();
// 一日を通して複数のセッションを行き来していると、開いた写真・動画の実データ(Blob)が
// ブラウザメモリに際限なく溜まり続け、俯瞰でカードが多い時にカクつくという実機報告(2026年9月)
// があった。「セッションの行き来で再描画されても再取得しない」という既存のキャッシュの狙いは
// 保ちつつ、上限を超えたら現在のセッション以外で最近使っていないものから実際のBlobを
// 解放する(URL.revokeObjectURL())ことで両立させる。
const BLOB_CACHE_MAX = 120;

// モデルにしているOneNoteをスマホ実機で観察したところ、ズーム時の白い一瞬の点滅・
// 「0.5秒ほど操作が止まってからサムネイルが本画像に切り替わる」・パン時の画像のポップインは
// いずれも許容されている(2026年9月)。つまり「切り替えに一切遅延を出さない」ことは目指さず、
// 「有限時間で必ず本画像に切り替わる」ことを目標に据え直した。
//
// これまでは俯瞰(全体表示)でセッションに入った瞬間、画面内に見えている写真カードの数だけ
// IntersectionObserverが同時に発火し、Driveから元サイズファイルを無制限に並列フェッチしていた。
// モバイル回線・メモリの圧迫で一部のフェッチが遅延/失敗し、リトライ上限を使い切ると
// サムネイルのまま永久に固定される(=OneNoteと違って「有限時間で必ず戻る」を満たせない)
// 実機不具合につながっていたため、同時実行数を絞るキューを挟んだ。
const MEDIA_FETCH_CONCURRENCY = 4;
let activeMediaFetchCount = 0;
const mediaFetchQueue = [];

function drainMediaFetchQueue() {
  while (activeMediaFetchCount < MEDIA_FETCH_CONCURRENCY && mediaFetchQueue.length > 0) {
    const run = mediaFetchQueue.shift();
    run();
  }
}

/** fetchFileBlobUrl()の実行タイミングだけをキューで絞る(呼び出し側からはPromiseを返す通常の関数に見える)。
 *  同時実行数の絞り込みが原因で特定の写真だけ表示に時間がかかっていないか実機で追えるよう、
 *  待ち行列の深さ・待機時間を?debugログに残す(2026年9月、実機での「劣化したまま」報告の診断用)。 */
function queueMediaFetch(fileId) {
  const queuedAt = Date.now();
  return new Promise((resolve, reject) => {
    mediaFetchQueue.push(() => {
      const waitedMs = Date.now() - queuedAt;
      debugLog(`本画像フェッチ開始: ${fileId.slice(0, 8)}(待ち行列で${waitedMs}ms待機、同時実行${activeMediaFetchCount + 1}/${MEDIA_FETCH_CONCURRENCY}、残り待ち行列${mediaFetchQueue.length}件)`);
      activeMediaFetchCount++;
      fetchFileBlobUrl(fileId).then(
        (url) => {
          activeMediaFetchCount--;
          debugLog(`本画像フェッチ成功: ${fileId.slice(0, 8)}(合計${Date.now() - queuedAt}ms)`);
          drainMediaFetchQueue();
          resolve(url);
        },
        (err) => {
          activeMediaFetchCount--;
          drainMediaFetchQueue();
          reject(err);
        }
      );
    });
    debugLog(`本画像フェッチをキューに追加: ${fileId.slice(0, 8)}(待ち行列${mediaFetchQueue.length}件)`);
    drainMediaFetchQueue();
  });
}

function getFileBlobUrlCached(fileId) {
  if (blobUrlCache.has(fileId)) {
    // LRU: 触れたら最後尾(最近使った側)へ移動する(Mapは挿入順を保持するため、
    // 削除して入れ直すだけで並び替えられる)
    const existing = blobUrlCache.get(fileId);
    blobUrlCache.delete(fileId);
    blobUrlCache.set(fileId, existing);
    return existing;
  }
  const promise = queueMediaFetch(fileId).catch((err) => {
    // 失敗したPromiseをキャッシュに残すと、原因(トークン失効直後の再取得タイミングなど、
    // 一時的なことが多い)が解消した後もこのfileIdだけ永久に再取得されなくなり、
    // ズームインしても低解像度のサムネイルのまま固定されてしまう(2026年9月、実機報告)。
    // 失敗時はキャッシュから消し、次に呼ばれた時に改めて取得を試みられるようにする。
    blobUrlCache.delete(fileId);
    throw err;
  });
  blobUrlCache.set(fileId, promise);
  evictOldBlobUrls();
  return promise;
}

/** 現在のセッションのファイルは対象外(表示中のものを誤って解放しないため)にしつつ、
 *  上限を超えたぶんだけ最も長く使われていないものから解放する。 */
function evictOldBlobUrls() {
  if (blobUrlCache.size <= BLOB_CACHE_MAX) return;
  const keepFileIds = new Set(
    state.cards.filter((c) => c.sessionId === activeSessionId() && c.imageFileId).map((c) => c.imageFileId)
  );
  for (const [fileId, promise] of blobUrlCache) {
    if (blobUrlCache.size <= BLOB_CACHE_MAX) break;
    if (keepFileIds.has(fileId)) continue;
    blobUrlCache.delete(fileId);
    promise.then((url) => URL.revokeObjectURL(url)).catch(() => {});
  }
}

let mediaVisibilityObserver = null;
const cardByMediaEl = new WeakMap();

// generateThumbnail()が作るサムネイルの長辺(240px)と合わせたしきい値。カードの画面上の
// 表示サイズ(ズームスケール込みの実際のpx)がこれを超えたら、サムネイルの画素が足りず
// ぼやけて見える段階とみなし、本画像(フル解像度)へ切り替える。「画面内に入った瞬間」では
// なく「ユーザーが実際にその写真へズームしてフォーカスした段階」で読み込むための基準
// (2026年9月、ユーザー提案)。
const FULL_RES_TRIGGER_PX = 240;

// IntersectionObserverで「画面内に入った」だけでなく上記の表示サイズ条件も満たすまで
// 本画像を取りに行かないカード(el)の集合。ズーム操作中はIntersectionObserverが再発火
// しない(既に画面内に入ったままなので enter/exit イベントが起きない)ため、ズームが
// 止まった時にjs/canvas.jsから呼ばれるonViewportScaleSettled()側でここを走査し直す。
const pendingMediaElements = new Set();

/** カードの画像・動画・音声枠(.star-card-media)が、実際の画面上で本画像に見合う大きさで
 *  表示されているか。 */
function isMediaDisplaySizeEnoughForFullRes(el) {
  const mediaEl = el.querySelector('.star-card-media');
  if (!mediaEl) return false;
  const rect = mediaEl.getBoundingClientRect();
  return Math.max(rect.width, rect.height) >= FULL_RES_TRIGGER_PX;
}

function observeMediaForLazyLoad(el, card) {
  cardByMediaEl.set(el, card);
  pendingMediaElements.add(el);
  if (!mediaVisibilityObserver) {
    mediaVisibilityObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        // 画面内に入っても、まだズームアウトしたままで小さくしか表示されていない間は
        // サムネイルのままにする(監視は続け、unobserveしない)。実際にそのサイズで
        // 表示されている(=既にズームインした状態で視界に入ってきた)場合のみ即読み込む。
        if (!isMediaDisplaySizeEnoughForFullRes(entry.target)) return;
        mediaVisibilityObserver.unobserve(entry.target);
        pendingMediaElements.delete(entry.target);
        loadFullMedia(entry.target, cardByMediaEl.get(entry.target));
      });
    }, { root: els.viewport, rootMargin: '400px' });
  }
  mediaVisibilityObserver.observe(el);
}

/**
 * js/canvas.jsからズーム操作が止まった時に呼ばれる。画面内に留まったまま(=交差状態が
 * 変化しないため、IntersectionObserver自体は再発火しない)ズームインで表示サイズだけが
 * 大きくなったカードを拾い直し、しきい値を超えたものから本画像へ切り替える。
 */
function onViewportScaleSettled() {
  if (pendingMediaElements.size === 0) return;
  const viewportRect = els.viewport.getBoundingClientRect();
  let upgraded = 0;
  for (const el of Array.from(pendingMediaElements)) {
    if (!el.isConnected) {
      pendingMediaElements.delete(el);
      continue;
    }
    const rect = el.getBoundingClientRect();
    const intersects =
      rect.right > viewportRect.left && rect.left < viewportRect.right &&
      rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
    if (!intersects || !isMediaDisplaySizeEnoughForFullRes(el)) continue;
    pendingMediaElements.delete(el);
    if (mediaVisibilityObserver) mediaVisibilityObserver.unobserve(el);
    loadFullMedia(el, cardByMediaEl.get(el));
    upgraded++;
  }
  if (upgraded > 0) debugLog(`ズーム確定によりフォーカス中の写真${upgraded}件を本画像へ切り替え`);
}

// 本画像の取得に失敗した回数(カード要素ごと)。無限リトライで叩き続けないよう上限を設ける。
const mediaLoadFailCount = new WeakMap();

/**
 * 本画像(フル解像度)の取得に失敗しても、以前は静かに諦めてサムネイルのまま固定されて
 * しまっていた(.then()にcatchが無く、失敗の痕跡も残らなかった。2026年9月、実機報告:
 * 一日使っていると写真がいつまでもぼやけたサムネイルのまま)。原因の多くはOAuthトークンの
 * 失効タイミングなど一時的なものと考えられるため、失敗時は少し待ってから再度Observerへ
 * 登録し直し、画面内に入り直したタイミングで自然にリトライさせる(最大3回まで)。
 * **2026年9月追加(Driveアップロード完全手動化に伴う修正)**: `card.imageFileId`がまだ無い
 * (=Driveへ送信していない)間、以前は本画像への切り替え手段が無く、ズームしてもサムネイル
 * (240px)のまま固定されていた。以前の「Wi-Fiになり次第自動送信」の頃はこの空白期間が
 * 短かったため実害が目立たなかったが、送信が完全手動になったことで**数時間〜数日この状態が
 * 続きうる**ようになり、「送信ボタンを押すまで自分の撮った写真がキャンバス上でずっと荒いまま」
 * という実機報告があった。実際には元データ(高解像度)はDriveへ送るまでもなくIndexedDBの
 * アップロード待機列に既にまるごと存在しているため、`card.imageFileId`が無い間は
 * `getQueuedEntryBlob()`(js/upload-queue.js)でそれを直接使う(ネットワーク不要、待機列に
 * 既にあるものを読むだけなので即座に切り替わる)。Driveへ送信済みになった後は、従来通り
 * Drive経由の取得(`getFileBlobUrlCached()`)を使う。
 */
function loadFullMedia(el, card) {
  const mediaEl = el.querySelector('.star-card-media');
  if (!mediaEl) return;
  const mediaType = card.mediaType || 'image';

  const applyUrl = (url) => {
    mediaLoadFailCount.delete(el);
    if (mediaType === 'video') {
      mediaEl.innerHTML = `<video src="${url}" controls playsinline></video>`;
    } else if (mediaType === 'audio') {
      mediaEl.innerHTML = `<audio src="${url}" controls></audio>`;
    } else {
      // 以前はbackground-imageで表示していたが、実機で「本画像に切り替わったはずなのに
      // 小さい文字がぼやけたまま」という報告があった(2026年9月)。ズームでキャンバス全体を
      // transform: scale()している構成上、background-imageはその祖先スケールに応じて
      // モバイルブラウザ側で描画解像度が頭打ちになりやすい(GPU合成レイヤーのラスタ解像度が
      // 実際のズーム倍率まで追従しない既知の傾向)。<img>要素(デコード済みの実ピクセルを
      // 直接持つ)に置き換えることで、ズームインした時により高い解像度でサンプリングされる
      // ことを期待する変更。
      mediaEl.innerHTML = `<img src="${url}" alt="">`;
    }
  };

  if (card.imageFileId) {
    getFileBlobUrlCached(card.imageFileId)
      .then(applyUrl)
      .catch((err) => {
        const failCount = (mediaLoadFailCount.get(el) || 0) + 1;
        mediaLoadFailCount.set(el, failCount);
        console.warn(`本画像の取得に失敗(${failCount}回目、サムネイルのまま表示を続けます)`, err);
        debugLog(`本画像の取得に失敗(${failCount}回目): ${err.message}`); // スマホでもデバッグパネル(🐞)から追える
        if (failCount <= 3) {
          setTimeout(() => observeMediaForLazyLoad(el, card), 3000);
        }
      });
    return;
  }

  if (card.uploadQueued && typeof getQueuedEntryBlob === 'function') {
    getQueuedEntryBlob(card.id)
      .then((blob) => {
        if (!blob) return; // 待機列に実データが見つからない(異常系)。サムネイルのままにする
        applyUrl(URL.createObjectURL(blob));
      })
      .catch(() => {});
  }
}

/**
 * メモの中身に合わせてテキストエリアとカード全体の高さを伸ばし、スクロールなしで全文が
 * 見えるようにする。写真・動画のメディア枠は現在の高さでいったん固定してから、
 * メモぶんだけカードを縦に伸ばす。
 */
function syncCardHeight(el) {
  // getBoundingClientRect() はキャンバスのズーム後の画面px を返すため、カード自身の
  // CSS px(ズーム前の論理値)に戻してから style.height に反映する。これをしないと、
  // キャンバスを縮小表示している間にカードを編集・追加した際、実際より小さい値が
  // 固定されてしまい、あとで空白ができる原因になる。
  const mediaEl = el.querySelector('.star-card-media');
  if (mediaEl && mediaEl.style.flex !== 'none') {
    mediaEl.style.height = `${mediaEl.getBoundingClientRect().height / viewportState.scale}px`;
    mediaEl.style.flex = 'none';
  }
  const memoEl = el.querySelector('.star-card-memo');
  if (memoEl) {
    memoEl.style.height = 'auto';
    memoEl.style.height = `${memoEl.scrollHeight}px`;
  }
  el.style.height = 'auto';
  const total = el.getBoundingClientRect().height / viewportState.scale;
  el.style.height = `${total}px`;
  const card = getCardById(el.dataset.id);
  if (card) card.height = total;
  redrawAsterismLines(); // 高さが変わるとカード中心もずれるため、繋がっている線を引き直す
}

/** セッション配下(入れ子を含む)にある画像カードのサムネイル(dataURL)を再帰的に集める */
function collectDescendantImageThumbs(sessionId, depth = 0) {
  if (depth > 6) return []; // 循環参照などに備えた保険
  const thumbs = [];
  state.cards
    .filter((c) => c.sessionId === sessionId)
    .forEach((c) => {
      if (c.mediaType === 'session') {
        thumbs.push(...collectDescendantImageThumbs(c.refSessionId, depth + 1));
      } else if (c.mediaType === 'image' && c.thumbDataUrl) {
        thumbs.push(c.thumbDataUrl);
      }
    });
  return thumbs;
}

/** 配列からランダムにcount件を選ぶ(元の配列は変更しない) */
function pickRandomThumbs(arr, count) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

/**
 * セッションカードの「Title」ガイドから呼ぶ。タイトルをその場でテキスト入力に切り替え、
 * OCRボタン(カメラ起動→読み取ったテキストをそのまま入力欄へ)も一時的に表示する。
 */
function startSessionTitleEdit(card, el) {
  const refSession = getSessionById(card.refSessionId);
  if (!refSession) return;
  const nameEl = el.querySelector('.star-card-session-name');
  const ocrBtn = el.querySelector('.star-card-title-ocr-btn');
  if (!nameEl || nameEl.tagName === 'INPUT') return; // 既に編集中なら何もしない

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'star-card-session-name-input';
  input.value = refSession.name;
  input.addEventListener('pointerdown', (event) => event.stopPropagation());
  input.addEventListener('click', (event) => event.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  ocrBtn.hidden = false;

  function commit() {
    const newName = input.value.trim();
    if (newName && newName !== refSession.name) {
      refSession.name = newName;
      // Driveに既にメディアフォルダを作成済みなら、名前もそこに追従させる(ベストエフォート)
      if (refSession.driveMediaFolderId) {
        renameDriveFolder(refSession.driveMediaFolderId, newName).catch((err) => console.error('Driveフォルダのリネームに失敗', err));
      }
      scheduleAutoSave();
    }
    const span = document.createElement('span');
    span.className = 'star-card-session-name';
    span.textContent = refSession.name;
    input.replaceWith(span);
    ocrBtn.hidden = true;
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
  });

  ocrBtn.onpointerdown = (event) => {
    event.stopPropagation();
    event.preventDefault(); // input からフォーカスを奪わない(blurでの早期commitを防ぐ)
  };
  ocrBtn.onclick = async (event) => {
    event.stopPropagation();
    const result = await openCamera('caption');
    if (!result || result.kind !== 'text' || !result.text.trim()) return;
    // js/camera.jsのOCRはバックグラウンド実行のため、結果が届く頃には既にタイトル編集を
    // 終えてこのinputがDOMから外れている可能性がある(2026年9月)。その場合は入力欄へは
    // 書き込めないため、読み取った文字を失わないよう新規テクストカードとして残す。
    if (!input.isConnected) {
      createTextCard(result.text.trim());
      setStatus('セッション名の編集は終了していたため、読み取った文字は新しいテクストカードに残しました');
      return;
    }
    input.value = result.text.trim();
    input.focus();
  };
}

/* ---------------- クリップボード(編集ガイド中の Ctrl+C / Ctrl+X / Ctrl+V) ----------------
 * セッションカードは中身(参照先セッション + その配下のカード/子セッション)ごと、
 * 新しいIDを振り直しながら丸ごとコピー/ペーストできる。 */

let cardClipboard = null; // snapshotCardSubtree() の戻り値、またはnull

/** カード(セッションカードなら配下も再帰的に)を、Driveへの参照はそのままにデータだけ複製する */
function snapshotCardSubtree(card) {
  const cardCopy = JSON.parse(JSON.stringify(card));
  if (card.mediaType === 'session') {
    const session = getSessionById(card.refSessionId);
    const sessionCopy = session ? JSON.parse(JSON.stringify(session)) : null;
    const children = state.cards
      .filter((c) => c.sessionId === card.refSessionId)
      .map((c) => snapshotCardSubtree(c));
    return { card: cardCopy, session: sessionCopy, children };
  }
  return { card: cardCopy };
}

/** snapshotCardSubtree() のスナップショットを新しいIDで state に実体化する */
function materializeSnapshot(node, targetSessionId, offset) {
  const newCard = { ...node.card, id: crypto.randomUUID(), sessionId: targetSessionId };
  if (offset) {
    newCard.x = (newCard.x || 0) + offset.x;
    newCard.y = (newCard.y || 0) + offset.y;
  }
  if (node.session) {
    const newSession = { ...node.session, id: crypto.randomUUID(), parentId: targetSessionId };
    state.sessions.push(newSession);
    newCard.refSessionId = newSession.id;
    (node.children || []).forEach((childNode) => materializeSnapshot(childNode, newSession.id, null));
  }
  state.cards.push(newCard);
  return newCard;
}

/** 確認なしでカードをキャンバス/state から取り除く(カット・確認済み削除の共通処理) */
function removeCardFromState(card, el) {
  const idx = state.cards.indexOf(card);
  if (idx !== -1) state.cards.splice(idx, 1);
  el.remove();
  redrawAsterismLines(); // 消えたカードに繋がっていた線も引き直しで自然に消える
  if (card.mediaType === 'info') {
    refreshInfoTicker();
    if (card.infoParsed) removeInfoCardCalendarEvents(card);
  }
  // アップロード待機列(IndexedDB)にも実データが残っている場合があるため、カードの削除に
  // 合わせて破棄する。**2026年9月の不具合修正**: 以前はここで待機列を一切触っておらず、
  // 「⚠Drive未送信」カードを削除しても待機列の実データ(Blob)だけが孤児として残り続け、
  // 設定モーダルの「Driveへ送信N件」「端末へ保存N件」の件数がいつまでも減らなかった。カードが
  // 待機列に載っていたかどうかに関わらず常に試みる(載っていなければ何も起きない、安全な no-op)。
  if (typeof uploadQueueDelete === 'function') {
    uploadQueueDelete(card.id)
      .then(() => { if (typeof updateDriveUploadButton === 'function') updateDriveUploadButton(); })
      .catch(() => {});
  }
  scheduleAutoSave();
}

function pasteCardFromClipboard() {
  if (!cardClipboard) return;
  const newCard = materializeSnapshot(cardClipboard, activeSessionId(), { x: 24, y: 24 });
  renderCard(newCard);
  redrawAsterismLines();
  setStatus('貼り付けました');
  scheduleAutoSave();
}

document.addEventListener('keydown', (event) => {
  const active = document.activeElement;
  const isEditingText = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
  if (isEditingText) return; // テキスト編集中は通常の編集操作に任せる

  const guideEl = getEditGuideCard();

  // 編集ガイド表示中のカードは、PCのDeleteキーでも(ヘックスのDeleteボタンと同じ確認フローで)削除できる
  if (event.key === 'Delete' && guideEl) {
    const card = getCardById(guideEl.dataset.id);
    if (!card) return;
    event.preventDefault();
    if (!confirmDeleteCard(card)) return;
    removeCardFromState(card, guideEl);
    deactivateEditGuide(guideEl);
    setStatus('削除しました(Drive上のファイル本体は残ります)');
    return;
  }

  // 編集ガイド表示中のカードは、PCのEキーでも(ヘックスのEditボタンと同じ動作で)メモ欄を
  // 編集できる(2026年9月追加)。メモ欄を持たないカード種別(セッションカード等)では無視する。
  if (event.key.toLowerCase() === 'e' && guideEl) {
    const memoEl = guideEl.querySelector('.star-card-memo');
    if (memoEl) {
      event.preventDefault();
      const memoViewEl = guideEl.querySelector('.star-card-memo-view');
      if (memoViewEl) memoViewEl.hidden = true;
      memoEl.hidden = false;
      memoEl.style.pointerEvents = 'auto';
      memoEl.focus();
      syncCardHeight(guideEl);
      return;
    }
    const guideCard = getCardById(guideEl.dataset.id);
    if (guideCard && guideCard.mediaType === 'chat') {
      event.preventDefault();
      guideEl.classList.toggle('star-card-chat-editing');
      return;
    }
    if (guideCard && guideCard.mediaType === 'comment') {
      event.preventDefault();
      guideEl.classList.toggle('star-card-comment-editing');
      return;
    }
  }

  const isMod = event.ctrlKey || event.metaKey;
  if (!isMod) return;
  const key = event.key.toLowerCase();

  // 座談会カードのEditモードで発言テキストを選択してCtrl+Cした時、下のカードコピー
  // ショートカットがevent.preventDefault()でブラウザ標準のテキストコピーを奪ってしまい
  // 「コピーできない」という実機報告(2026年9月)があった。テキスト選択中は素直にブラウザへ
  // 譲る(選択が無い時だけ、従来通りカードそのものをコピーする)。
  const hasTextSelection = !document.getSelection().isCollapsed;
  if (key === 'c' && guideEl && !hasTextSelection) {
    const card = getCardById(guideEl.dataset.id);
    if (!card) return;
    event.preventDefault();
    cardClipboard = snapshotCardSubtree(card);
    setStatus('コピーしました');
  } else if (key === 'x' && guideEl) {
    const card = getCardById(guideEl.dataset.id);
    if (!card) return;
    event.preventDefault();
    cardClipboard = snapshotCardSubtree(card);
    removeCardFromState(card, guideEl);
    deactivateEditGuide(guideEl);
    setStatus('カットしました');
  } else if (key === 'v' && cardClipboard) {
    event.preventDefault();
    pasteCardFromClipboard();
  }
});

function extensionForImageMime(mimeType) {
  if (!mimeType) return 'png';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

/**
 * OSクリップボードに画像がある状態でCtrl+Vすると、写真カードとして直接追加する。
 * カード自体のコピー&ペースト(cardClipboard、上のkeydownハンドラ)とは別の経路で、
 * こちらはブラウザ標準の`paste`イベント(clipboardData)を使う。
 */
document.addEventListener('paste', async (event) => {
  if (!state.folderId) return; // サインイン前は何もしない
  const active = document.activeElement;
  const isEditingText = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
  if (isEditingText) return; // テキスト欄への通常のペーストを妨げない

  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return;
  const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
  if (!imageItem) return;

  event.preventDefault();
  const blob = imageItem.getAsFile();
  if (!blob) return;
  await createCardFromCapture({
    blob,
    filename: `${Date.now()}-clipboard.${extensionForImageMime(blob.type)}`,
    mediaType: 'image',
  });
});

/** セッション配下(入れ子を含む)のカード数・子セッション数を数える(削除確認の文言に使う) */
function countSessionContents(sessionId) {
  let cardCount = 0;
  let sessionCount = 0;
  state.cards
    .filter((c) => c.sessionId === sessionId)
    .forEach((c) => {
      if (c.mediaType === 'session') {
        sessionCount += 1;
        const sub = countSessionContents(c.refSessionId);
        cardCount += sub.cardCount;
        sessionCount += sub.sessionCount;
      } else {
        cardCount += 1;
      }
    });
  return { cardCount, sessionCount };
}

/**
 * カード削除の確認ダイアログを出す。セッションカードは中身の件数を提示したうえで2段階確認にする。
 * 削除はキャンバス上の参照(カード)を消すだけで、Drive上のファイル本体(画像・動画・音声)は削除しない。
 */
function confirmDeleteCard(card) {
  if (card.mediaType !== 'session') {
    return window.confirm('このカードを削除しますか?\n(Drive上のファイル本体は削除されません)');
  }
  const refSession = getSessionById(card.refSessionId);
  const { cardCount, sessionCount } = countSessionContents(card.refSessionId);
  const parts = [];
  if (sessionCount > 0) parts.push(`内包セッション${sessionCount}件`);
  if (cardCount > 0) parts.push(`カード${cardCount}件`);
  const detail = parts.length > 0 ? `中身: ${parts.join(' / ')}\n` : '中身は空です。\n';
  const name = refSession ? refSession.name : '(不明なセッション)';
  const step1 = window.confirm(`「${name}」を削除しますか?\n${detail}(Drive上のファイル本体は削除されません)`);
  if (!step1) return false;
  return window.confirm(`本当によろしいですか?\n「${name}」への参照が完全に失われます。`);
}

function deleteCard(card, el) {
  if (!confirmDeleteCard(card)) return;
  removeCardFromState(card, el);
  setStatus('削除しました(Drive上のファイル本体は残ります)');
}

/**
 * 写真・動画カードの📌ボタン: OCRだけ起動し、結果をそのカードのメモに追記する。
 * **2026年9月**: js/camera.jsのOCRがバックグラウンド実行に変わり、結果が届くまでの間に
 * ユーザーが別のセッションへ移動したり、このカード自体を削除したりできるようになった
 * (以前はカメラのオーバーレイがOCR完了まで画面を占有していたため起こり得なかった)。
 * 呼び出し時に捕まえた`el`(カード要素)が結果到着時には既に破棄・差し替わっている
 * 可能性があるため、`cardElById()`で最新の要素を取り直し、カード自体が消えていたら
 * (state.cardsに存在しなければ)テキストを失わないよう新規テクストカードとして残す。
 */
async function handleCardCaption(card, el) {
  void el; // 呼び出し時点の要素は使わない(下記の理由でOCR完了時に取り直す)
  const cardId = card.id;
  const result = await openCamera('caption');
  if (!result || result.kind !== 'text') return;
  const liveCard = getCardById(cardId);
  if (!liveCard) {
    // カードが削除された等で戻す先を失った場合、OCRした文字自体は失わず新規カードにする
    createTextCard(result.text);
    setStatus('元のカードが見つからないため、新しいテクストカードに読み取り結果を残しました');
    return;
  }
  liveCard.memo = liveCard.memo ? `${liveCard.memo}\n\n${result.text}` : result.text;
  const liveEl = cardElById(cardId);
  if (liveEl) {
    const memoEl = liveEl.querySelector('.star-card-memo');
    if (memoEl) memoEl.value = liveCard.memo;
    const memoViewEl = liveEl.querySelector('.star-card-memo-view');
    if (memoViewEl) {
      memoViewEl.innerHTML = linkifyMemoHtml(liveCard.memo);
      memoViewEl.hidden = false;
    }
    syncCardHeight(liveEl);
    updateMemoExpandState(liveEl);
  }
  setStatus('キャプションを反映しました');
  scheduleAutoSave();
}

/**
 * 写真カードの編集ガイド「Extract」: 写真に写っている文字をOCRで抜き出す。
 * **2026年9月に範囲選択機能を追加**: 押すとまず`openExtractRegionPicker()`のオーバーレイが開き、
 * 読み取りたい部分を自由形状(なぞって囲む、四角形限定ではない)で選べるようにした。何も囲まずに
 * 「画像全体を読み取る」を押せば、これまで通り画像全体が対象になる。キャンバス上の小さいカード
 * 表示のまま範囲を選ばせると精度が出ないため、専用のフルスクリーンオーバーレイで元画像の
 * 表示サイズいっぱいに描かせる。抽出は1回だけ行い、その後どう使うかをshowChoiceDialog()の2択
 * (ラベル付きの対等なボタン)で確認する。**window.confirm()のOK/キャンセルは使わない**
 * (以前はOK/キャンセルで実装しており、どちらが写真を破棄する方か分かりにくく、実機でユーザーが
 * 誤って写真とDrive上の元ファイルを完全に失う事故があった。2026年9月、致命的なバグとして修正)。
 * **Drive上の元画像は、アプリ側からは一切削除・変更しない**(2026年9月、ユーザー方針: Driveは
 * バックアップなので、アプリ側から元画像をいじらないこと)。以前は「破棄」を選ぶと
 * deleteFile()でDrive上のファイルまで完全削除していたが、この呼び出し自体を撤去した。
 * - 「テクストのみ表示に切り替える」: このカードのmediaTypeをimageからtextへ切り替え、
 *   card.imageFileId(このカードからの参照)だけを外す。Drive上のファイル本体には触れない
 *   ため、セッションのmediaフォルダに残り続け、Drive UI側からは引き続き見つけられる
 * - 「写真はそのまま残す」: 元の写真カードには一切触れず、抽出した文字だけを新しいテクストカード
 *   として作る(サマリーカードの出力と同じ経路: createAstrConnection()で星座線を繋ぎ、効果音・
 *   発光演出も乗る)。以前は写真カード自身のメモ欄に追記していたが、長文だとメモ欄がスクロール
 *   形式になり読みにくくなるため、別カードに分ける形に変更した。
 * - ダイアログの背景クリック(どちらも選ばない、本当の意味でのキャンセル): 何も変更せず終了する
 */
async function handleCardExtract(card, el) {
  if (card.mediaType !== 'image') return;
  if (!card.imageFileId && !card.uploadQueued) {
    if (card.uploadPending) {
      setStatus('アップロード中です。少し待ってから試してください');
    } else {
      setStatus('画像が読み込めないため抽出できません');
    }
    return;
  }

  setStatus('画像を読み込み中…', { busy: true });
  let originalBlob;
  try {
    // Drive未送信(uploadQueued)でも、高解像度の元データは待機列(IndexedDB)に既に
    // まるごと存在している。loadFullMedia()と同じフォールバックで、Driveへ送信するまで
    // Extractが一切使えない状態を避ける(2026年9月修正)。
    if (!card.imageFileId && card.uploadQueued && typeof getQueuedEntryBlob === 'function') {
      originalBlob = await getQueuedEntryBlob(card.id);
      if (!originalBlob) throw new Error('端末に保存された元データが見つかりませんでした');
    } else {
      const blobUrl = await getFileBlobUrlCached(card.imageFileId);
      originalBlob = await (await fetch(blobUrl)).blob();
    }
  } catch (err) {
    console.error(err);
    setStatus(`画像の読み込みに失敗しました: ${err.message}`, { important: true });
    return;
  }

  const picked = await openExtractRegionPicker(originalBlob);
  if (picked.mode === 'cancel') {
    setStatus('範囲選択をキャンセルしました');
    return;
  }
  const targetBlob = picked.mode === 'region' ? picked.blob : originalBlob;

  setStatus('文字を読み取り中…', { busy: true });
  let text;
  try {
    text = await ocrImage(targetBlob);
  } catch (err) {
    console.error(err);
    setStatus(`抽出に失敗しました: ${err.message}`, { important: true });
    return;
  }
  if (!text || text.includes('(テキストなし)')) {
    setStatus('文字を検出できませんでした');
    return;
  }

  const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  // 以前はwindow.confirm()の「OK」「キャンセル」で2択を出していたが、どちらが写真を破棄する方か
  // 分かりにくく、実機でユーザーが誤って写真とDrive上の元ファイルを完全に失う事故があった
  // (2026年9月)。ラベル付きの対等なボタン(showChoiceDialog())に置き換えた。さらに、
  // 「アプリ側からDriveの元画像は(バックアップなので)一切いじらない」というユーザー方針
  // (2026年9月)を受けて、Drive上のファイルを削除するdeleteFile()の呼び出し自体を撤去した。
  // 「テクストのみ表示」を選んでも、変更されるのはこのカードの表示形態(mediaType)だけで、
  // Drive上の元ファイルはそのまま(セッションのmediaフォルダに)残り続ける。カード側の参照を
  // 外すだけなので、アプリの表示からは見えなくなるが、Drive UI側からは引き続き見つけられる。
  // 背景クリックで閉じた場合(null)はどちらも実行せず、何も変更しないまま終了する。
  const choice = await showChoiceDialog({
    title: '抽出した文字をどうしますか?',
    message: `文字を検出しました:\n\n${preview}`,
    options: [
      { label: '写真はそのまま残す(文字を新しいカードに追加)', value: 'keep' },
      { label: 'テクストのみ表示に切り替える(Driveの元画像は削除せず残します)', value: 'discard', secondary: true },
    ],
  });
  if (!choice) {
    setStatus('抽出結果の保存をキャンセルしました');
    return;
  }

  if (choice === 'discard') {
    const oldFileId = card.imageFileId;
    const wasQueued = Boolean(card.uploadQueued);
    card.mediaType = 'text';
    card.memo = text;
    card.imageFileId = null;
    delete card.thumbDataUrl;
    delete card.uploadPending;
    delete card.uploadFailed;
    // **card.uploadQueuedは意図的にそのまま残す**: まだDriveへ一度も送っていない元データは
    // 待機列(IndexedDB)にしか実体が無い。「アプリ側からオリジナルの画像データを消す機能は
    // 一切作らない」という絶対条件はDrive上のファイルだけでなくこの待機列の実データにも
    // 適用されるべきと考え、テクストカードへ切り替わった後も通常通りバックグラウンドで
    // Driveへアップロードされるに任せる(結果としてテクストカードにimageFileIdが付くだけの
    // 見た目に影響しない副作用だが、データを守ることを優先した)。
    blobUrlCache.delete(oldFileId);
    rerenderCardInPlace(card, el);
    setStatus(wasQueued
      ? 'テクストカードに変換しました(元の写真データは引き続きDriveへ送信されます)'
      : 'テクストカードに変換しました(Drive上の元画像は残しています)');
    scheduleAutoSave();
  } else {
    // 元の写真カードには触れず、抽出した文字だけを新しいテクストカードとして出す
    // (サマリーカードの出力と同じ配置・接続の仕方)
    const newCard = createTextCard(text);
    newCard.x = card.x + 260 + (Math.random() * 80 - 20);
    newCard.y = card.y + (Math.random() * 240 - 120);
    const newEl = cardElById(newCard.id);
    if (newEl) {
      newEl.dataset.x = String(newCard.x);
      newEl.dataset.y = String(newCard.y);
      applyCardTransform(newEl);
    }
    createAstrConnection(card.id, newCard.id); // 効果音・発光演出・保存もここで行われる
    setStatus('抽出した文字を新しいテクストカードにしました');
  }
}

/* ---------------- Extract範囲選択オーバーレイ(2026年9月追加) ----------------
 * handleCardExtract()専用。指/マウスでなぞった自由形状のパスをそのままクリップパスとして使い、
 * 元画像から「選んだ範囲の外側は白地」の切り抜き画像を作ってOCRへ渡す(四角形限定ではなく、
 * 斜めのキャプションや、隣の作品の文字を避けたい時にも対応できるようにするため)。
 * camera.jsの常時黒背景オーバーレイと同じ、アプリ本体のテーマとは独立した見た目にしている。
 */
const erxEls = {};
let erxPoints = [];
let erxDrawing = false;
let erxResolve = null;
let erxNaturalW = 0;
let erxNaturalH = 0;

function initExtractRegionPicker() {
  erxEls.overlay = document.getElementById('extract-region-overlay');
  erxEls.closeBtn = document.getElementById('extract-region-close');
  erxEls.img = document.getElementById('extract-region-img');
  erxEls.canvas = document.getElementById('extract-region-canvas');
  erxEls.ctx = erxEls.canvas.getContext('2d');
  erxEls.redoBtn = document.getElementById('extract-region-redo');
  erxEls.wholeBtn = document.getElementById('extract-region-whole');
  erxEls.goBtn = document.getElementById('extract-region-go');

  erxEls.canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    erxDrawing = true;
    erxPoints = [];
    const rect = erxEls.canvas.getBoundingClientRect();
    erxPoints.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    erxEls.canvas.setPointerCapture(e.pointerId);
    erxRedrawPath();
  });
  erxEls.canvas.addEventListener('pointermove', (e) => {
    if (!erxDrawing) return;
    const rect = erxEls.canvas.getBoundingClientRect();
    erxPoints.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    erxRedrawPath();
  });
  const endDraw = () => {
    if (!erxDrawing) return;
    erxDrawing = false;
    erxEls.goBtn.disabled = erxPoints.length < 3;
  };
  erxEls.canvas.addEventListener('pointerup', endDraw);
  erxEls.canvas.addEventListener('pointercancel', endDraw);

  erxEls.redoBtn.addEventListener('click', erxClearPath);
  erxEls.closeBtn.addEventListener('click', () => erxFinish({ mode: 'cancel' }));
  erxEls.wholeBtn.addEventListener('click', () => erxFinish({ mode: 'whole' }));
  erxEls.goBtn.addEventListener('click', erxHandleGoClick);
}

function erxClearPath() {
  erxPoints = [];
  erxDrawing = false;
  erxEls.ctx.clearRect(0, 0, erxEls.canvas.width, erxEls.canvas.height);
  erxEls.goBtn.disabled = true;
}

function erxRedrawPath() {
  const ctx = erxEls.ctx;
  ctx.clearRect(0, 0, erxEls.canvas.width, erxEls.canvas.height);
  if (erxPoints.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(erxPoints[0].x, erxPoints[0].y);
  for (let i = 1; i < erxPoints.length; i++) ctx.lineTo(erxPoints[i].x, erxPoints[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(63, 174, 99, 0.25)';
  ctx.fill();
  ctx.strokeStyle = '#3fae63';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function erxFinish(payload) {
  erxEls.overlay.classList.remove('open');
  if (erxEls.img.src) URL.revokeObjectURL(erxEls.img.src);
  erxEls.img.removeAttribute('src');
  erxClearPath();
  if (erxResolve) {
    const resolve = erxResolve;
    erxResolve = null;
    resolve(payload);
  }
}

/** 選んだパスの外側を白地にした切り抜き画像(bboxサイズのcanvas)をBlobにして解決する */
function erxHandleGoClick() {
  if (erxPoints.length < 3) return;
  const sx = erxNaturalW / erxEls.canvas.width;
  const sy = erxNaturalH / erxEls.canvas.height;
  const natPoints = erxPoints.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  natPoints.forEach((p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  });
  minX = Math.max(0, Math.floor(minX));
  minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(erxNaturalW, Math.ceil(maxX));
  maxY = Math.min(erxNaturalH, Math.ceil(maxY));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  octx.save();
  octx.beginPath();
  octx.moveTo(natPoints[0].x - minX, natPoints[0].y - minY);
  for (let i = 1; i < natPoints.length; i++) octx.lineTo(natPoints[i].x - minX, natPoints[i].y - minY);
  octx.closePath();
  // 選択範囲の外側は白地で塗ってからクリップする(OCRの背景として自然に見えるようにするため。
  // 透明のままだと、実装によっては黒として読まれてしまうことがある)。
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, w, h);
  octx.clip();
  octx.drawImage(erxEls.img, -minX, -minY, erxNaturalW, erxNaturalH);
  octx.restore();
  out.toBlob((blob) => erxFinish({ mode: 'region', blob }), 'image/png');
}

/**
 * @param {Blob} sourceBlob 範囲選択の対象にする元画像
 * @returns {Promise<{mode: 'region', blob: Blob} | {mode: 'whole'} | {mode: 'cancel'}>}
 */
function openExtractRegionPicker(sourceBlob) {
  return new Promise((resolve) => {
    erxResolve = resolve;
    erxClearPath();
    const url = URL.createObjectURL(sourceBlob);
    erxEls.img.onload = () => {
      erxNaturalW = erxEls.img.naturalWidth;
      erxNaturalH = erxEls.img.naturalHeight;
      // 表示サイズはCSSのmax-width/max-height任せでレイアウトされるため、実際に確定した
      // サイズを次のフレームで読み取ってcanvasへ反映する(canvasの座標系を画像の表示px
      // ぴったりに揃えることで、あとの自然座標への換算が単純な倍率計算だけで済む)。
      requestAnimationFrame(() => {
        const rect = erxEls.img.getBoundingClientRect();
        erxEls.canvas.width = rect.width;
        erxEls.canvas.height = rect.height;
        erxEls.canvas.style.width = `${rect.width}px`;
        erxEls.canvas.style.height = `${rect.height}px`;
      });
    };
    erxEls.img.src = url;
    erxEls.overlay.classList.add('open');
  });
}

function getCardById(id) {
  return state.cards.find((c) => String(c.id) === String(id));
}

async function handleImageSelected(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (files.length === 0) return;

  // 端末の「写真」アプリ等から複数枚まとめて選んだ場合、1枚ずつ順番にカード化する
  // (handleViewportDrop()の複数ドロップ処理と同じ考え方)。位置はcreateCardFromCapture()内の
  // newCardSpawnPos()が呼び出すたびランダムにずらすため、重ならず自然に散らばる。
  for (const file of files) {
    await createCardFromCapture({
      blob: file,
      filename: `${Date.now()}-${file.name}`,
      mediaType: 'image',
    });
  }
  if (files.length > 1) setStatus(`${files.length}枚追加しました`);
}

/**
 * 「⚠ Drive未送信(失敗)」バッジからの手動リカバリ(2026年9月追加)。
 * このカードが失敗した経緯によっては、待機列(IndexedDB)に実データが一切残っていない
 * (=このアプリ側からはもう二度と送信できない)ことがある。特に、以前は即時アップロードの
 * フォールバックが失敗すると待機列に一度も載らずdead endになるバグがあった(2026年9月修正)ため、
 * その修正より前に失敗したカードは、既に端末を再読み込みしていればメモリ上のBlobも失われ、
 * アプリ側にはもう元データが残っていない。
 * その場合でも、写真・動画・音声はもともと端末(iPhoneの「写真」アプリ等)からこのアプリへ
 * コピーして取り込んだだけなので、**元の実体は端末側にまだ残っている**。このバッジをタップして
 * 同じファイルを選び直してもらうことで、カードの位置やメモ・ASTR接続はそのままに、実データだけ
 * 待機列へ入れ直し、通常の「☁ Driveへ送信」から送信できる状態に復帰させる。
 */
let retryUploadCardId = null;

function openRetryUploadPicker(card) {
  if (!els.retryUploadInput) return;
  retryUploadCardId = card.id;
  els.retryUploadInput.accept = `${card.mediaType}/*`;
  els.retryUploadInput.click();
}

async function handleRetryUploadSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  const cardId = retryUploadCardId;
  retryUploadCardId = null;
  if (!file || !cardId) return;

  const card = getCardById(cardId);
  if (!card) {
    setStatus('対象のカードが見つかりませんでした', { important: true });
    return;
  }

  const filename = `${Date.now()}-${file.name}`;
  const persisted = await persistToUploadQueue(card, file, filename);
  if (!persisted) {
    setStatus('端末への保存に失敗しました。もう一度お試しください', { important: true });
    return;
  }
  card.uploadQueued = true;
  card.uploadFailed = false;
  card.uploadPending = false;
  const el = cardElById(card.id);
  if (el) {
    el.classList.remove('star-card--upload-failed', 'star-card--upload-pending');
    el.classList.add('star-card--upload-queued');
    updateCardStatusBadges(el, card);
  }
  scheduleAutoSave();
  setStatus('端末に保存しました。設定の「☁ Driveへ送信」から送信できます');
}

/* ---------------- アップロード状況一覧(2026年9月追加) ----------------
 * 「端末⇔このブラウザの待機列(IndexedDB)⇔Drive」の3者の状態が、カードに付いた
 * card.uploadQueued/uploadFailed/uploadPendingといったフラグの表示だけでは分かりにくい
 * (実機で、フラグ上は「送信待ち」のはずなのに実データが既に無い、という食い違いが
 * 起きたことがある)という実機報告を受けて追加した診断用一覧。写真・動画・音声カードごとに、
 * ①Drive側の状態(フラグ由来)、②この端末の待機列に実データがあるか(IndexedDBを直接確認)、
 * ③画像なら解像度、を並べて表示し、1件ずつ個別に送信/選び直しができるようにする。 */

const UPLOAD_STATUS_MEDIA_TYPES = ['image', 'video', 'audio'];

function formatBytesKBorMB(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** dataURL文字列またはBlobから、実際にデコードして幅×高さを求める(サーバー不要、
 *  ローカルで完結)。取得できなければnull。 */
function computeImageDimensions(source) {
  return new Promise((resolve) => {
    const isBlob = source instanceof Blob;
    const url = isBlob ? URL.createObjectURL(source) : source;
    const img = new Image();
    const finish = (result) => {
      if (isBlob) URL.revokeObjectURL(url);
      resolve(result);
    };
    img.onload = () => finish({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => finish(null);
    img.src = url;
  });
}

/** 一覧の1行を組み立てる。entry(待機列のIndexedDBエントリ)が無ければ、この端末には
 *  もう実データが残っていない(Driveに送信済みでない限り、送信手段が「選び直す」しか無い)。 */
async function buildUploadStatusRowEl(card, entry) {
  const row = document.createElement('div');
  row.className = 'upload-status-row';

  const thumb = document.createElement('div');
  thumb.className = 'upload-status-thumb';
  if (card.thumbDataUrl) {
    thumb.innerHTML = `<img src="${card.thumbDataUrl}" alt="">`;
  } else {
    thumb.textContent = card.mediaType === 'video' ? '🎬' : card.mediaType === 'audio' ? '🎙' : '🖼';
  }

  const body = document.createElement('div');
  body.className = 'upload-status-body';

  const title = document.createElement('div');
  title.className = 'upload-status-title';
  title.textContent = (card.memo || '').trim().slice(0, 24) || '(無題)';

  const driveLine = document.createElement('div');
  driveLine.className = 'upload-status-line';
  if (card.imageFileId) {
    driveLine.textContent = '🟢 Drive: 保存済み(元解像度)';
  } else if (card.uploadPending) {
    driveLine.textContent = '⏳ Drive: 送信中…';
  } else if (card.uploadFailed) {
    driveLine.textContent = '🔴 Drive: 未送信(失敗)';
  } else {
    driveLine.textContent = '🔵 Drive: 未送信';
  }

  const localLine = document.createElement('div');
  localLine.className = 'upload-status-line';
  if (entry && entry.blob) {
    localLine.textContent = `🟢 端末: あり(${formatBytesKBorMB(entry.blob.size)})`;
  } else if (card.imageFileId) {
    localLine.textContent = '⬜ 端末: なし(Drive送信済みのため不要)';
  } else {
    localLine.textContent = '🔴 端末: なし(高画質データが見つかりません)';
  }

  const resLine = document.createElement('div');
  resLine.className = 'upload-status-line';
  resLine.textContent = '解像度: 計測中…';

  body.appendChild(title);
  body.appendChild(driveLine);
  body.appendChild(localLine);
  if (card.mediaType === 'image') body.appendChild(resLine);

  const actionWrap = document.createElement('div');
  actionWrap.className = 'upload-status-action';
  if (card.imageFileId) {
    actionWrap.textContent = '済';
  } else if (card.uploadPending) {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.disabled = true;
    btn.textContent = '送信中…';
    actionWrap.appendChild(btn);
  } else if (entry && entry.blob) {
    const btn = document.createElement('button');
    btn.textContent = 'この1件を送信';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '送信中…';
      const ok = await uploadSingleQueuedEntry(card.id);
      setStatus(ok ? '送信しました' : '送信に失敗しました。もう一度お試しください', { important: !ok });
      const list = row.closest('.upload-status-list');
      if (list) renderUploadStatusList(list);
    });
    actionWrap.appendChild(btn);
  } else {
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = '🔁 選び直す';
    btn.addEventListener('click', () => {
      openRetryUploadPicker(card);
      setStatus('ファイルを選び終えたら、「↻ 更新」で最新状態を確認できます');
    });
    actionWrap.appendChild(btn);
  }

  row.appendChild(thumb);
  row.appendChild(body);
  row.appendChild(actionWrap);

  if (card.mediaType === 'image') {
    let dims = null;
    let label = '解像度: データがありません';
    if (entry && entry.blob) {
      dims = await computeImageDimensions(entry.blob);
      label = dims ? `解像度(端末内の元データ): ${dims.width}×${dims.height}` : '解像度: 取得できませんでした';
    } else if (card.thumbDataUrl) {
      dims = await computeImageDimensions(card.thumbDataUrl);
      label = dims ? `解像度(サムネイルのみ): ${dims.width}×${dims.height}` : '解像度: 取得できませんでした';
    }
    resLine.textContent = label;
  }

  return row;
}

/** 「詰まっているもの」が上に来るよう並べ替える: ①端末にもDriveにも実データが無い
 *  (最優先で気づいてほしい) → ②失敗 → ③送信待ち → ④送信済み。 */
async function renderUploadStatusList(list) {
  let queueEntries = [];
  try { queueEntries = await uploadQueueGetAll(); } catch (err) { /* 取得できなければ空のまま扱う */ }
  const queueByCardId = new Map(queueEntries.map((e) => [e.cardId, e]));

  const cards = state.cards.filter((c) => UPLOAD_STATUS_MEDIA_TYPES.includes(c.mediaType));
  const rank = (c) => {
    if (!c.imageFileId && !queueByCardId.has(c.id)) return 0;
    if (c.uploadFailed) return 1;
    if (!c.imageFileId) return 2;
    return 3;
  };
  const sorted = cards.slice().sort((a, b) => rank(a) - rank(b));

  list.innerHTML = '';
  if (sorted.length === 0) {
    list.innerHTML = '<p class="upload-status-empty">写真・動画・音声カードがありません。</p>';
    return;
  }
  for (const card of sorted) {
    const rowEl = await buildUploadStatusRowEl(card, queueByCardId.get(card.id));
    list.appendChild(rowEl);
  }
}

/** 設定モーダルの「📋 アップロード状況を見る」ボタン。既存のopenCommentHistory()と
 *  同じ.modal-overlay/.modalを流用する。 */
async function openUploadStatusList() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const modal = document.createElement('div');
  modal.className = 'modal upload-status-modal';
  const heading = document.createElement('h2');
  heading.textContent = 'アップロード状況';
  const desc = document.createElement('p');
  desc.className = 'modal-desc';
  desc.textContent = '写真・動画・音声カードごとに、Drive・この端末のどちらにデータがあるか、画像なら解像度も確認できます。詰まっているものが上に表示されます。';
  const list = document.createElement('div');
  list.className = 'upload-status-list';
  list.textContent = '読み込み中…';
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'secondary';
  refreshBtn.textContent = '↻ 更新';
  refreshBtn.addEventListener('click', () => renderUploadStatusList(list));
  const closeBtn = document.createElement('button');
  closeBtn.className = 'secondary';
  closeBtn.textContent = '閉じる';
  actions.appendChild(refreshBtn);
  actions.appendChild(closeBtn);
  modal.appendChild(heading);
  modal.appendChild(desc);
  modal.appendChild(list);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  attachBackgroundTapToClose(overlay, close);
  document.body.appendChild(overlay);
  await renderUploadStatusList(list);
}

/**
 * キャンバスへ画像をドラッグ&ドロップした時、ドロップした位置に写真カードを作る。
 * OSのファイル(エクスプローラー等)からのドロップなら dataTransfer.files に実体が入るので
 * そのまま使う。Googleフォトのようなウェブページ上の画像をドラッグした場合はファイル実体が
 * 取れず、代わりにURL(text/uri-list や text/html 内のimg src)だけが渡ってくることが多いので、
 * そのURLを直接fetchしてみる(ホスト側がCORSを許可していない場合は失敗し、その旨を伝える)。
 */
async function handleViewportDrop(event) {
  event.preventDefault();
  if (!state.folderId) return; // サインイン前は何もしない
  const dt = event.dataTransfer;
  if (!dt) return;

  const pos = clientToContent(event.clientX, event.clientY);
  const imageFiles = Array.from(dt.files || []).filter((f) => f.type.startsWith('image/'));

  if (imageFiles.length > 0) {
    for (const file of imageFiles) {
      await createCardFromCapture({
        blob: file,
        filename: `${Date.now()}-${file.name}`,
        mediaType: 'image',
        x: pos.x,
        y: pos.y,
      });
      playAstrConnectSound();
    }
    return;
  }

  const url = extractDroppedImageUrl(dt);
  if (!url) {
    setStatus('画像を認識できませんでした');
    return;
  }

  setStatus('画像を取得中…', { busy: true });
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('画像として認識できませんでした');
    await createCardFromCapture({
      blob,
      filename: `${Date.now()}-dropped.${extensionForImageMime(blob.type)}`,
      mediaType: 'image',
      x: pos.x,
      y: pos.y,
    });
    playAstrConnectSound();
  } catch (err) {
    console.error(err);
    debugLog('ドロップ画像の取得に失敗: ' + err.message);
    setStatus('この画像は取得できませんでした(ブラウザのセキュリティ制限の可能性があります)', { important: true });
  }
}

/** ドロップされたデータから画像URLを推定する(text/uri-list、または text/html 内のimg src) */
function extractDroppedImageUrl(dataTransfer) {
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    const line = uriList.split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    if (line) return line;
  }
  const html = dataTransfer.getData('text/html');
  if (html) {
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match) return match[1];
  }
  const plain = dataTransfer.getData('text/plain');
  if (plain && /^https?:\/\//i.test(plain.trim())) return plain.trim();
  return null;
}

/** アプリ内蔵カメラ(js/camera.js)を開き、撮影結果をカードとして追加する */
async function handleOpenCamera(mode) {
  const result = await openCamera(mode);
  if (!result) return;

  if (result.kind === 'photo') {
    await createCardFromCapture({
      blob: result.blob,
      filename: `${Date.now()}-photo.jpg`,
      mediaType: 'image',
    });
  } else if (result.kind === 'text') {
    createTextCard(result.text);
  } else if (result.kind === 'video') {
    await createCardFromCapture({
      blob: result.blob,
      filename: `${Date.now()}-video.${extensionForMime(result.blob.type, 'webm')}`,
      mediaType: 'video',
    });
  } else if (result.kind === 'audio') {
    await createCardFromCapture({
      blob: result.blob,
      filename: `${Date.now()}-audio.${extensionForMime(result.blob.type, 'webm')}`,
      mediaType: 'audio',
    });
  }
}

function extensionForMime(mimeType, fallback) {
  if (!mimeType) return fallback;
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('webm')) return 'webm';
  return fallback;
}

/**
 * ボトムツールバー/CONSTELLATION PIEの「テクスト」ボタン。OCR(カメラでキャプションを撮影して
 * 読み取る)と直接入力(カメラを使わずその場で手入力する)のどちらにするかをまず確認する
 * (handleCreateSession()のセッション名入力と同じshowChoiceDialog()の二択を踏襲)。
 */
async function handleOpenTextTool() {
  const choice = await showChoiceDialog({
    title: 'テクストの入力方法',
    options: [
      { label: 'OCRで読み取る', value: 'ocr' },
      { label: '直接入力する', value: 'manual', secondary: true },
    ],
  });
  if (!choice) return;
  if (choice === 'ocr') {
    await handleOpenCamera('caption');
  } else {
    const card = createTextCard('');
    const el = cardElById(card.id);
    const memoEl = el?.querySelector('.star-card-memo');
    if (memoEl) {
      const memoViewEl = el.querySelector('.star-card-memo-view');
      if (memoViewEl) memoViewEl.hidden = true;
      memoEl.hidden = false;
      memoEl.style.pointerEvents = 'auto';
      memoEl.focus();
    }
  }
}

/** テクストモードの読み取り結果からカードを作る(画像を伴わないため Drive アップロードは不要) */
function createTextCard(text) {
  const spawnPos = newCardSpawnPos();
  const card = {
    id: crypto.randomUUID(),
    x: spawnPos.x,
    y: spawnPos.y,
    width: 240,
    height: 120,
    memo: text,
    tags: [],
    mediaType: 'text',
    imageFileId: null,
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  setStatus('テクストを追加しました');
  scheduleAutoSave();
  return card;
}

/**
 * 画像を軽量なサムネイル(dataURL、長辺240px・JPEG圧縮)に縮小する。カードデータに同梱しておくことで、
 * 概観時にDriveへ問い合わせなくても即座にプレビューを表示できる(OneNoteのサムネイル運用と同じ考え方)。
 * 実寸の画像は表示中のカードだけ observeMediaForLazyLoad() 経由で遅延取得する。
 */
function generateThumbnail(blob, maxSize = 240, quality = 0.6) {
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(null);
    };
    img.src = objectUrl;
  });
}

/**
 * カード生成とIndexedDBへの保存だけを行う共通処理。file-input・アプリ内蔵カメラ・
 * クリップボード貼り付けの各経路から使う。
 * 画像はローカルで一瞬で作れるサムネイルだけを待ってすぐカードを表示する。動画・音声は
 * ローカルサムネイルが無いため、この最適化の恩恵は薄いが、同じ経路に揃えて実装をシンプルに
 * 保っている。
 * **2026年9月、Driveアップロードを完全手動化**: 以前はモバイル通信中だけ待機列に留め、
 * Wi-Fiと判定された瞬間に自動アップロードしていたが、iOS Safariには通信種別の自動判定が
 * 無いため、この判定は実質「最後に手動で切り替えた状態」がlocalStorageに何日も残り続ける
 * だけの仕組みで、気づかないままモバイル回線で直接アップロードされ続ける事故につながった
 * (3日間で計0.87GB消費)。この反省を受け、**撮影直後には一切Driveへ送信せず、常に
 * IndexedDBの待機列へ保存するだけ**に統一した。実際の送信は、ユーザーが設定モーダルの
 * 「☁ Driveへ送信」ボタンを押した時だけ行われる(js/upload-queue.jsのdrainUploadQueue())。
 */
async function createCardFromCapture({ blob, filename, mediaType, memo, x, y }) {
  const thumbDataUrl = mediaType === 'image' ? await generateThumbnail(blob) : null;
  const spawnPos = (x === undefined || y === undefined) ? newCardSpawnPos() : null;

  const card = {
    id: crypto.randomUUID(),
    x: x ?? spawnPos.x,
    y: y ?? spawnPos.y,
    width: 220,
    height: 260,
    memo: memo || '',
    tags: [],
    mediaType,
    imageFileId: null,
    thumbDataUrl,
    uploadPending: false,
    uploadQueued: true, // Driveへはまだ送信していない(常にこの状態で作成、手動送信を待つ)
    uploadFailed: false,
    deviceSaved: false, // 端末の「写真」アプリ等へまだコピーしていない
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  saveImmediately(); // IndexedDBへの保存前にタブを閉じても、カードの存在自体は確実に残るように(デバウンスを待たない)

  const persisted = await persistToUploadQueue(card, blob, filename);
  if (persisted) {
    setStatus('追加しました(端末に保存。Driveへは未送信)');
  } else {
    // IndexedDBが使えない等の理由で待機列に保存できなかった場合は、データを失わないよう
    // その場でアップロードする(通信量節約より、写真を失わないことを優先する)。
    card.uploadQueued = false;
    const el = cardElById(card.id);
    if (el) {
      el.classList.remove('star-card--upload-queued');
      updateCardStatusBadges(el, card);
    }
    setStatus('追加しました。アップロード中…', { busy: true });
    const uploaded = await uploadCardFileInBackground(card, blob, filename);
    if (!uploaded) {
      // **2026年9月修正**: 以前はここで失敗すると、そのカードは待機列(IndexedDB)に一度も
      // 載らないまま`card.uploadFailed = true`だけが残り、「☁ Driveへ送信」ボタンは待機列の
      // 中身しか見ないため、このカードを二度と拾えない(=手動での再送信手段が無い)dead endに
      // なっていた。ここでBlobがまだメモリ上に残っているうちに、もう一度だけ待機列への保存を
      // 試みることで、後から「☁ Driveへ送信」ボタンで再挑戦できる状態に戻す(写真を失わないことを
      // 最優先する既存方針の徹底)。
      const retried = await persistToUploadQueue(card, blob, filename);
      if (retried) {
        card.uploadQueued = true;
        card.uploadFailed = false;
        const retryEl = cardElById(card.id);
        if (retryEl) {
          retryEl.classList.remove('star-card--upload-failed');
          retryEl.classList.add('star-card--upload-queued');
          updateCardStatusBadges(retryEl, card);
        }
        setStatus('送信に失敗しましたが端末に保存しました。設定の「☁ Driveへ送信」から再送信できます', { important: true });
        scheduleAutoSave();
      }
    }
  }
  return card;
}

/* ---------------- 高画質差し替え(EXIF自動照合、2026年9月追加) ----------------
 * 「帰宅後、EXIFタイムスタンプを手がかりに、現地で撮った高画質写真を仮画像と自動的に
 * 差し替える」という、アプリのコンセプト当初からの構想(CLAUDE.md「コアコンセプト」参照)。
 * 設定モーダルの「📥 高画質差し替え」ボタンから、カメラ本体等で撮った写真を複数選ぶと、
 * 各写真のEXIF撮影時刻(DateTimeOriginal)と、今開いているセッション内の写真カードの
 * 記録時刻(card.createdAt)を照らし合わせ、近いものを差し替え候補として提案する。
 *
 * 外部ライブラリは使わず、JPEGのAPP1(Exif)セグメントに含まれるTIFF形式のIFDを
 * 直接パースする最小実装にしている(HEIC/HEIFは非対応、下記参照)。
 */

// マッチとみなす最大の時刻差(実機で調整の余地あり、まずは15分に設定)。
// 現地でのメモ用撮影とカメラ本体での撮影は数十秒〜数分しかズレない想定だが、
// 機材の時計がずれている場合も考慮してやや余裕を持たせている。
const EXIF_MATCH_MAX_DIFF_MS = 15 * 60 * 1000;

/**
 * JPEGファイルの拡張子・種別のみで判定する軽いチェック(EXIF読み取り前のフィルタ用)。
 * HEIC/HEIF(iPhone既定の撮影形式)はJPEGと異なるコンテナ形式のため、この最小実装では
 * 非対応(EXIF抽出は常にnullを返す、= 「記録なし」として新規カード追加の対象になる)。
 */
function isJpegBlob(blob) {
  return Boolean(blob && (blob.type === 'image/jpeg' || /\.jpe?g$/i.test(blob.name || '')));
}

/** IFD(Image File Directory)を読み、tag→値のMapを返す。ASCII(type 2)は文字列、
 *  SHORT/LONG(type 3/4/9)は数値として読む(このアプリで必要なタグに絞った最小実装、
 *  RATIONAL等その他の型は今回使わないため読まない)。 */
function readExifIfdEntries(view, tiffStart, ifdOffset, littleEndian) {
  const map = new Map();
  if (ifdOffset < 0 || ifdOffset + 2 > view.byteLength) return map;
  const count = view.getUint16(ifdOffset, littleEndian);
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = view.getUint16(entryOffset, littleEndian);
    const type = view.getUint16(entryOffset + 2, littleEndian);
    const numValues = view.getUint32(entryOffset + 4, littleEndian);
    const valueOffsetField = entryOffset + 8;
    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
    const totalSize = typeSize * numValues;
    const dataOffset = totalSize <= 4 ? valueOffsetField : tiffStart + view.getUint32(valueOffsetField, littleEndian);
    if (type === 2) {
      // ASCII文字列(null終端)
      if (dataOffset < 0 || dataOffset + numValues > view.byteLength) continue;
      let str = '';
      for (let j = 0; j < numValues; j++) {
        const b = view.getUint8(dataOffset + j);
        if (b === 0) break;
        str += String.fromCharCode(b);
      }
      map.set(tag, str);
    } else if (type === 3) {
      map.set(tag, view.getUint16(valueOffsetField, littleEndian));
    } else if (type === 4 || type === 9) {
      map.set(tag, view.getUint32(valueOffsetField, littleEndian));
    }
  }
  return map;
}

/** "YYYY:MM:DD HH:MM:SS" 形式(EXIFの日時タグの書式)をローカル時刻のDateへ変換する。
 *  タイムゾーン情報を持たないため、カメラの時計がローカル時刻に合っている前提で扱う。 */
function parseExifDateString(str) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(str || '');
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/** TIFF本体(Exifヘッダーの直後)からDateTimeOriginal(無ければDateTimeDigitized、
 *  さらに無ければIFD0のDateTime)を探す。 */
function parseExifTiffForDate(view, tiffStart) {
  const byteOrderMark = view.getUint16(tiffStart);
  const littleEndian = byteOrderMark === 0x4949; // "II"
  if (!littleEndian && byteOrderMark !== 0x4d4d) return null; // "MM"でもなければ壊れている
  const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
  const ifd0 = readExifIfdEntries(view, tiffStart, tiffStart + ifd0Offset, littleEndian);
  const exifIfdPointer = ifd0.get(0x8769); // Exif IFD Pointer
  if (exifIfdPointer != null) {
    const exifIfd = readExifIfdEntries(view, tiffStart, tiffStart + exifIfdPointer, littleEndian);
    const dt = exifIfd.get(0x9003) || exifIfd.get(0x9004); // DateTimeOriginal / DateTimeDigitized
    if (dt) return parseExifDateString(dt);
  }
  const dt0 = ifd0.get(0x0132); // IFD0のDateTime(更新日時、フォールバック)
  return dt0 ? parseExifDateString(dt0) : null;
}

/**
 * JPEGファイルのEXIFから撮影日時を読み取る。外部ライブラリを使わない最小実装
 * (実装時にNode.jsで合成したExifバイナリを使って単体テスト済み)。先頭部分だけ読めば
 * 十分なため(APP1セグメントは最大64KB強)、ファイル全体は読み込まない。
 * @param {Blob} blob
 * @returns {Promise<Date|null>}
 */
async function extractExifDateTime(blob) {
  if (!isJpegBlob(blob)) return null; // HEIC/HEIF等は非対応、素直にnullを返す
  try {
    const head = await blob.slice(0, 128 * 1024).arrayBuffer();
    const view = new DataView(head);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
    let offset = 2;
    while (offset < view.byteLength - 4) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      if (marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue; } // RSTn(データを持たない)
      const size = view.getUint16(offset + 2);
      if (marker === 0xe1) {
        const exifStart = offset + 4;
        if (
          exifStart + 6 <= view.byteLength &&
          view.getUint32(exifStart) === 0x45786966 && // "Exif"
          view.getUint16(exifStart + 4) === 0x0000
        ) {
          return parseExifTiffForDate(view, exifStart + 6);
        }
      }
      if (marker === 0xda) break; // Start of Scan、以降は画像本体
      offset += 2 + size;
    }
    return null;
  } catch (err) {
    console.error('EXIF読み取りに失敗', err);
    return null;
  }
}

/**
 * 新しく取り込む写真(incoming)と、既存の写真カード(candidateCards)を、撮影/記録時刻の
 * 近さで1対1にマッチングする(貪欲法: 時刻差が小さい組み合わせから確定していく)。
 * @param {{file: File, exifDate: Date|null}[]} incoming
 * @param {object[]} candidateCards
 * @returns {{matches: {incoming: object, card: object, diffMs: number}[], unmatchedIncoming: object[]}}
 */
function matchExifPhotosToCards(incoming, candidateCards) {
  const pairs = [];
  incoming.forEach((inc, i) => {
    if (!inc.exifDate) return;
    candidateCards.forEach((card, j) => {
      const diff = Math.abs(inc.exifDate.getTime() - new Date(card.createdAt).getTime());
      if (diff <= EXIF_MATCH_MAX_DIFF_MS) pairs.push({ i, j, diff });
    });
  });
  pairs.sort((a, b) => a.diff - b.diff);
  const usedIncoming = new Set();
  const usedCards = new Set();
  const matches = [];
  for (const pair of pairs) {
    if (usedIncoming.has(pair.i) || usedCards.has(pair.j)) continue;
    usedIncoming.add(pair.i);
    usedCards.add(pair.j);
    matches.push({ incoming: incoming[pair.i], card: candidateCards[pair.j], diffMs: pair.diff });
  }
  const unmatchedIncoming = incoming.filter((_, i) => !usedIncoming.has(i));
  return { matches, unmatchedIncoming };
}

/** ボタンから呼ばれ、ファイル選択後にEXIF抽出・マッチング・確認モーダル表示までを行う。 */
async function handleExifMatchFilesSelected(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (files.length === 0) return;
  setStatus('EXIFを確認中…', { busy: true });
  const incoming = await Promise.all(files.map(async (file) => ({ file, exifDate: await extractExifDateTime(file) })));
  const candidateCards = state.cards.filter((c) => c.sessionId === activeSessionId() && c.mediaType === 'image');
  const { matches, unmatchedIncoming } = matchExifPhotosToCards(incoming, candidateCards);
  if (matches.length === 0 && unmatchedIncoming.length === 0) {
    setStatus('対象の写真がありませんでした');
    return;
  }
  setStatus(`${matches.length}件の差し替え候補が見つかりました`);
  openExifMatchReviewModal(matches, unmatchedIncoming);
}

function formatClockTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function formatDiffMinutes(diffMs) {
  const minutes = Math.round(diffMs / 60000);
  return minutes === 0 ? '1分未満' : `${minutes}分`;
}

/** 確認モーダル。差し替え候補・新規追加候補それぞれにチェックボックスを付け、選んだ分だけ
 *  「実行」で反映する。行ごとに新しい写真のプレビュー用object URLを作るため、閉じる時に
 *  必ずrevokeObjectURL()すること(下のclose()参照)。 */
function openExifMatchReviewModal(matches, unmatchedIncoming) {
  const objectUrls = [];
  const makePreviewUrl = (file) => {
    const url = URL.createObjectURL(file);
    objectUrls.push(url);
    return url;
  };

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay visible';
  const modal = document.createElement('div');
  modal.className = 'modal exif-match-modal';
  const heading = document.createElement('h2');
  heading.textContent = '高画質差し替え';
  const desc = document.createElement('p');
  desc.className = 'modal-desc';
  desc.textContent = '撮影時刻が近いものを見つけました。差し替えたい/追加したい組み合わせだけチェックを残してください。元のDrive上のファイルは削除されず、そのまま残ります。';
  modal.appendChild(heading);
  modal.appendChild(desc);

  const matchInputs = [];
  if (matches.length > 0) {
    const label = document.createElement('p');
    label.className = 'modal-desc';
    label.innerHTML = `<strong>差し替え候補(${matches.length}件)</strong>`;
    modal.appendChild(label);
    const list = document.createElement('div');
    list.className = 'exif-match-list';
    matches.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'exif-match-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      matchInputs.push({ checkbox, match: m });
      const oldThumb = document.createElement('div');
      oldThumb.className = 'exif-match-thumb';
      oldThumb.innerHTML = m.card.thumbDataUrl ? `<img src="${escapeAttrExif(m.card.thumbDataUrl)}" alt="">` : '🖼️';
      const arrow = document.createElement('span');
      arrow.className = 'exif-match-arrow';
      arrow.textContent = '→';
      const newThumb = document.createElement('div');
      newThumb.className = 'exif-match-thumb';
      newThumb.innerHTML = `<img src="${escapeAttrExif(makePreviewUrl(m.incoming.file))}" alt="">`;
      const body = document.createElement('div');
      body.className = 'exif-match-body';
      const memoSnippet = (m.card.memo || '').trim().slice(0, 20);
      body.innerHTML =
        `<div class="exif-match-title">${escapeHtml(memoSnippet || '(無題の写真カード)')}</div>` +
        `<div class="exif-match-line">記録 ${formatClockTime(new Date(m.card.createdAt))} → 撮影 ${formatClockTime(m.incoming.exifDate)}(差${formatDiffMinutes(m.diffMs)})</div>`;
      row.appendChild(checkbox);
      row.appendChild(oldThumb);
      row.appendChild(arrow);
      row.appendChild(newThumb);
      row.appendChild(body);
      list.appendChild(row);
    });
    modal.appendChild(list);
  }

  const newInputs = [];
  if (unmatchedIncoming.length > 0) {
    const label = document.createElement('p');
    label.className = 'modal-desc';
    label.innerHTML = `<strong>近い記録が見つからなかった写真(${unmatchedIncoming.length}件、新規カードとして追加)</strong>`;
    modal.appendChild(label);
    const list = document.createElement('div');
    list.className = 'exif-match-list';
    unmatchedIncoming.forEach((inc) => {
      const row = document.createElement('div');
      row.className = 'exif-match-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      newInputs.push({ checkbox, incoming: inc });
      const newThumb = document.createElement('div');
      newThumb.className = 'exif-match-thumb';
      newThumb.innerHTML = `<img src="${escapeAttrExif(makePreviewUrl(inc.file))}" alt="">`;
      const body = document.createElement('div');
      body.className = 'exif-match-body';
      body.innerHTML =
        `<div class="exif-match-title">${escapeHtml(inc.file.name)}</div>` +
        `<div class="exif-match-line">${inc.exifDate ? `撮影 ${formatClockTime(inc.exifDate)}(近い記録なし)` : 'EXIF撮影時刻が読み取れませんでした'}</div>`;
      row.appendChild(checkbox);
      row.appendChild(newThumb);
      row.appendChild(body);
      list.appendChild(row);
    });
    modal.appendChild(list);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'secondary';
  cancelBtn.textContent = 'キャンセル';
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = '実行';
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  modal.appendChild(actions);
  overlay.appendChild(modal);

  const close = () => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    overlay.remove();
  };
  cancelBtn.addEventListener('click', close);
  attachBackgroundTapToClose(overlay, close);
  confirmBtn.addEventListener('click', async () => {
    const selectedMatches = matchInputs.filter((x) => x.checkbox.checked).map((x) => x.match);
    const selectedNew = newInputs.filter((x) => x.checkbox.checked).map((x) => x.incoming);
    close();
    await commitExifMatches(selectedMatches, selectedNew);
  });

  document.body.appendChild(overlay);
}

function escapeAttrExif(str) {
  return String(str).replace(/"/g, '&quot;');
}

/** 確認済みの1件を、既存カードへの差し替えとして適用する。古いDrive参照(imageFileId)は
 *  外すだけで、Drive上の元ファイルには一切触れない(削除しない)。新しい実体は既存の
 *  待機列(IndexedDB)経由の手動アップロードの仕組みにそのまま乗せる。 */
async function applyExifReplacement(card, file) {
  const thumbDataUrl = await generateThumbnail(file);
  if (thumbDataUrl) card.thumbDataUrl = thumbDataUrl;
  card.imageFileId = null;
  card.uploadQueued = true;
  card.uploadPending = false;
  card.uploadFailed = false;
  card.deviceSaved = false;
  const filename = `${Date.now()}-${file.name}`;
  const persisted = await persistToUploadQueue(card, file, filename);
  if (!persisted) {
    // IndexedDBが使えない場合は、データを失わないようその場でアップロードする
    // (createCardFromCapture()と同じフォールバック方針)。
    card.uploadQueued = false;
    await uploadCardFileInBackground(card, file, filename);
  }
}

/** 確認モーダルの「実行」から呼ぶ。差し替え・新規追加をまとめて適用し、最後に1回だけ
 *  再描画・保存する(1件ごとに描画すると件数分だけ余計な再計算が走るため)。 */
async function commitExifMatches(selectedMatches, selectedNew) {
  if (selectedMatches.length === 0 && selectedNew.length === 0) return;
  setStatus('高画質差し替えを適用中…', { busy: true });
  for (const m of selectedMatches) {
    await applyExifReplacement(m.card, m.incoming.file);
  }
  for (const inc of selectedNew) {
    await createCardFromCapture({ blob: inc.file, filename: `${Date.now()}-${inc.file.name}`, mediaType: 'image' });
  }
  renderAllCards();
  redrawAsterismLines();
  scheduleAutoSave();
  setStatus(`高画質差し替え: ${selectedMatches.length}件差し替え・${selectedNew.length}件新規追加しました`, { important: true });
}

/** カードの実体を、裏でDriveへアップロードする。js/upload-queue.jsの待機列ドレイン時
 *  (「☁ Driveへ送信」ボタン押下時)にも同じ関数を使い回す。
 *  @param {AbortSignal} [signal] ドレイン中の「■ 停止」で中断できるようにするためのシグナル
 *    (js/upload-queue.jsのcancelDriveUpload()参照)。単発呼び出し(IndexedDB保存に失敗した
 *    場合のその場アップロード)では渡されない。
 *  @returns {Promise<boolean>} 成功したか。js/upload-queue.jsのuploadQueuedEntry()が、
 *    IndexedDB上の待機中データを削除してよいかどうかの判断に使う(2026年9月、失敗時にも
 *    無条件で削除していたため、アップロード失敗のたびに元データが消えてしまうバグがあった)。 */
async function uploadCardFileInBackground(card, blob, filename, signal) {
  card.uploadQueued = false;
  card.uploadPending = true;
  card.uploadFailed = false; // 再送信を始めた時点で、前回失敗の赤バッジを一旦消す(送信中に紛らわしいため)
  const startEl = cardElById(card.id);
  if (startEl) {
    startEl.classList.remove('star-card--upload-queued', 'star-card--upload-failed');
    startEl.classList.add('star-card--upload-pending');
    updateCardStatusBadges(startEl, card);
  }
  try {
    const folderId = await resolveSessionMediaFolderId(card.sessionId);
    const fileId = await uploadFile(folderId, blob, filename, signal);
    card.imageFileId = fileId;
    card.uploadPending = false;
    card.uploadQueued = false;
    card.uploadFailed = false; // 前回失敗して付いたバッジを、再試行成功時にはきちんと消す
    const el = cardElById(card.id);
    if (el) {
      el.classList.remove('star-card--upload-pending', 'star-card--upload-queued', 'star-card--upload-failed');
      observeMediaForLazyLoad(el, card);
      updateCardStatusBadges(el, card);
    }
    // アップロード成功直後、js/upload-queue.jsのuploadQueuedEntry()がIndexedDB上の
    // 実データを即座に削除する。scheduleAutoSave()のデバウンス(1.2秒)が終わる前に
    // タブが閉じられると、imageFileIdがDrive上のJSONへ反映されないまま実データだけ
    // 消え、そのカードがDrive上のファイルへ二度とたどり着けなくなるため、デバウンスを
    // 待たず即座に保存する。
    saveImmediately();
    return true;
  } catch (err) {
    const el = cardElById(card.id);
    if (err && err.name === 'AbortError') {
      // 「■ 停止」によるユーザーの意図的な中断。失敗扱いにはせず、待機列に残したまま
      // 静かに「Drive未送信」の状態へ戻す(次に送信ボタンを押した時に再挑戦される)。
      debugLog(`アップロード停止(card ${card.id})`);
      card.uploadPending = false;
      card.uploadQueued = true;
      if (el) {
        el.classList.remove('star-card--upload-pending');
        el.classList.add('star-card--upload-queued');
        updateCardStatusBadges(el, card);
      }
      return false;
    }
    console.error(err);
    debugLog(`アップロード失敗(card ${card.id}): ${err && err.message ? err.message : err}`);
    card.uploadPending = false;
    card.uploadQueued = false;
    card.uploadFailed = true;
    if (el) {
      el.classList.remove('star-card--upload-pending', 'star-card--upload-queued');
      el.classList.add('star-card--upload-failed');
      updateCardStatusBadges(el, card);
    }
    setStatus('アップロードに失敗しました(カードは残りますがDriveには保存されていません)', { important: true });
    scheduleAutoSave();
    return false;
  } finally {
    if (typeof updateDriveUploadButton === 'function') updateDriveUploadButton();
  }
}

/** Driveへ保存するデータ本体。updatedAtは、オートセーブOFF中の端末内バックアップ
 *  (js/upload-queue.jsのsaveLocalDataBackup())とDrive側のどちらが新しいか、次回起動時の
 *  onSignedIn()が比較するために持たせている(2026年9月追加)。 */
function collectSaveData() {
  return {
    cards: state.cards,
    sessions: state.sessions,
    connections: state.connections,
    hiddenAutoLinks: state.hiddenAutoLinks,
    exhibitionCalendarId: state.exhibitionCalendarId,
    crews: state.crews,
    // almagestEntriesはここには含めない(2026年9月〜): Almagestは専用のDriveファイル
    // (almagest-library.json)へ変更のたびに即座に保存するようになったため、オートセーブの
    // ON/OFF・デバウンスの影響を受けるこのメインファイルには含めない(js/modules/almagest.js参照)。
    commentHistory: state.commentHistory,
    groupViewingIntervalSec: state.groupViewingIntervalSec,
    feHistory: state.feHistory,
    feHistoryIndex: state.feHistoryIndex,
    breadcrumb: state.breadcrumb,
    updatedAt: Date.now(),
  };
}

/** @returns {Promise<boolean>} Driveへの保存に成功したか。mergeQuickBundlesIfAny()が、
 *  クイックバンドルをIndexedDBから消してよいか判断するために使う(2026年9月追加)。 */
async function handleSave() {
  setStatus('自動保存中…');
  const data = collectSaveData();
  try {
    state.fileId = await saveData(state.folderId, state.fileId, data);
    if (typeof clearLocalDataBackup === 'function') clearLocalDataBackup();
    // 年セッションだけの軽量インデックス(constellation-years.json)も追従させる(2026年9月追加、
    // クイックカメラ/クイックセッションが読む。ベストエフォート、失敗してもメイン保存の
    // 成否には影響させない)。
    saveYearsIndexMirror().catch(() => {});
    setStatus('自動保存しました');
    return true;
  } catch (err) {
    console.error(err);
    // Driveへの送信自体が(オフライン等で)失敗しても変更を失わないよう、端末内バックアップへ
    // 逃がしておく(2026年9月追加、オートセーブOFF中の保護と同じ仕組みを再利用する)。
    if (typeof saveLocalDataBackup === 'function') await saveLocalDataBackup(data).catch(() => {});
    setStatus('自動保存に失敗しました(端末に保持、コンソールを確認)', { important: true });
    return false;
  }
}

/** オートセーブOFF中の保存先。Driveへは一切送らず、IndexedDBへ現在のデータ全体を
 *  バックアップするだけに留める(2026年9月追加)。 */
async function handleLocalBackupSave() {
  if (typeof saveLocalDataBackup !== 'function') return;
  try {
    await saveLocalDataBackup(collectSaveData());
    setStatus('端末に保存しました(Drive未送信)');
  } catch (err) {
    console.error('ローカルバックアップの保存に失敗', err);
    setStatus('端末への保存に失敗しました(コンソールを確認)', { important: true });
  }
}

/** クイックモード中(state.quickMode)の保存先。Driveのメインファイルには一切触れず、
 *  IndexedDBの専用バンドルへ現在のstate(=今回新規に作った分だけ)を保存するだけに
 *  留める(2026年9月追加、js/upload-queue.jsのsaveQuickBundle()参照)。 */
async function handleQuickModeSave() {
  if (typeof saveQuickBundle !== 'function' || !state.quickBundleId) return;
  try {
    await saveQuickBundle(state.quickBundleId, collectSaveData());
    setStatus('端末に保存しました(クイックモード、Drive未送信)');
  } catch (err) {
    console.error('クイックバンドルの保存に失敗', err);
    setStatus('端末への保存に失敗しました(コンソールを確認)', { important: true });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * メモ本文中のURLをクリックできるリンクとして描画するためのHTML化(2026年9月追加)。
 * URL以外の部分はescapeHtml()でエスケープしてからURL部分だけ<a>タグに差し替える(XSS対策、
 * href自体も念のためエスケープする)。文末の句読点・閉じ括弧をURLの一部として誤って
 * 拾わないよう末尾から除く。改行はCSS側のwhite-space:pre-wrapに任せ、ここでは変換しない。
 */
function linkifyMemoHtml(text) {
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  let result = '';
  let lastIndex = 0;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    result += escapeHtml(text.slice(lastIndex, match.index));
    const trimTrailing = match[0].match(/^(.*?)([.,;:!?)\]]*)$/s);
    const url = trimTrailing ? trimTrailing[1] : match[0];
    const trailing = trimTrailing ? trimTrailing[2] : '';
    if (url) {
      // リンク先のファビコンを添える(2026年9月追加)。任意URLのOGP画像はCORS制約で
      // ブラウザから直接取得できず、Geminiの検索系ツールは無料キーで429になるため、
      // APIキー不要でAPI無料枠も消費しないGoogleの公開ファビコンサービスを使う。
      // ドメインとして解釈できないURL(相対パスの誤検出など)ではファビコンを省く。
      let faviconHtml = '';
      try {
        const domain = new URL(url).hostname;
        faviconHtml = `<img class="star-card-memo-favicon" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32" alt="" width="14" height="14">`;
      } catch (err) {
        // URLとして解釈できなければファビコンは付けない(リンク自体は表示する)
      }
      result += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${faviconHtml}${escapeHtml(url)}</a>`;
    }
    result += escapeHtml(trailing);
    lastIndex = match.index + match[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}
