// アプリのエントリーポイント。認証・Drive・キャンバス・Geminiを結線する。

const state = {
  folderId: null,
  fileId: null,
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

  initCanvas(els.viewport, els.content);
  initExtractRegionPicker();

  els.settingsBtn.addEventListener('click', () => openSettings());
  els.settingsSaveBtn.addEventListener('click', handleSettingsSave);
  els.settingsCancelBtn.addEventListener('click', closeSettings);

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
    setStatus('サインアウトしました');
  });
  els.toolUpload.addEventListener('click', () => els.imageInput.click());
  els.imageInput.addEventListener('change', handleImageSelected);
  els.toolCamera.addEventListener('click', () => handleOpenCamera('photo'));
  els.toolText.addEventListener('click', handleOpenTextTool);
  els.toolVideo.addEventListener('click', () => handleOpenCamera('video'));
  els.toolAudio.addEventListener('click', () => handleOpenCamera('audio'));
  els.toolSession.addEventListener('click', handleCreateSession);
  els.toolInfo.addEventListener('click', createInfoCard);
  els.toolSummary.addEventListener('click', () => createSummaryCard());
  els.toolStreetview.addEventListener('click', createStreetviewCard);
  els.infoTicker.addEventListener('click', () => {
    const card = infoTickerItems[infoTickerIndex];
    if (card) jumpToInfoCard(card);
  });

  initPieMenu(els.viewport, buildPieTools, () => !els.toolUpload.disabled);

  els.viewport.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  els.viewport.addEventListener('drop', handleViewportDrop);
});

/* ---------------- CONSTELLATION PIE用のツール一覧(既存ボトムバーの項目を流用) ---------------- */

// モジュール共通のキーパッド(js/module-launcher.js)のHUD風アイコン。ツールバーには
// 対応するボタンが無いため、他のようにボタンから拝借せずここに直接持つ。
const MODULE_KEYPAD_PIE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round"><rect x="5" y="3" width="14" height="18" rx="2"/>' +
  '<circle cx="9" cy="8" r="0.6" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none"/><circle cx="15" cy="8" r="0.6" fill="currentColor" stroke="none"/>' +
  '<circle cx="9" cy="12" r="0.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="0.6" fill="currentColor" stroke="none"/>' +
  '<circle cx="9" cy="16" r="0.6" fill="currentColor" stroke="none"/><circle cx="12" cy="16" r="0.6" fill="currentColor" stroke="none"/><circle cx="15" cy="16" r="0.6" fill="currentColor" stroke="none"/></svg>';

function buildPieTools() {
  return [
    { label: 'アップロード', icon: els.toolUpload.querySelector('svg').outerHTML, action: () => els.imageInput.click() },
    { label: 'カメラ', icon: els.toolCamera.querySelector('svg').outerHTML, action: () => handleOpenCamera('photo') },
    { label: 'テクスト', icon: els.toolText.querySelector('svg').outerHTML, action: handleOpenTextTool },
    { label: '動画撮影', icon: els.toolVideo.querySelector('svg').outerHTML, action: () => handleOpenCamera('video') },
    { label: '音声録音', icon: els.toolAudio.querySelector('svg').outerHTML, action: () => handleOpenCamera('audio') },
    // PCのマウスでは背景2本指ダブルタップが使えないため、モジュール共通キーパッドへの
    // 確実な入口としてここにも置く(個々のモジュールへの専用項目は増やさない)
    { label: 'キーパッド', icon: MODULE_KEYPAD_PIE_ICON_SVG, action: () => { if (window.openModuleKeypad) window.openModuleKeypad(); } },
  ];
}

function openSettings() {
  els.settingsClientId.value = CONFIG.GOOGLE_CLIENT_ID;
  els.settingsApiKey.value = CONFIG.GEMINI_API_KEY;
  els.settingsError.hidden = true;
  els.settingsCancelBtn.hidden = !isConfigured();
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
 * @param {{title: string, options: {label: string, value: string, secondary?: boolean}[]}} params
 * @returns {Promise<string|null>}
 */
function showChoiceDialog({ title, options }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    modal.appendChild(heading);
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
      btn.addEventListener('click', () => finish(opt.value));
      actions.appendChild(btn);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });

    document.body.appendChild(overlay);
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
  els.toolUpload.disabled = !signedIn;
  els.toolCamera.disabled = !signedIn;
  els.toolText.disabled = !signedIn;
  els.toolVideo.disabled = !signedIn;
  els.toolAudio.disabled = !signedIn;
  els.toolSession.disabled = !signedIn;
  els.toolInfo.disabled = !signedIn;
  els.toolSummary.disabled = !signedIn;
  els.toolStreetview.disabled = !signedIn;
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

/* ---------------- オートセーブ(手動の保存ボタンは廃止し、変更のたびに自動保存する) ---------------- */

const AUTO_SAVE_DELAY_MS = 1200; // 連続した変更(タイピング等)をまとめて1回の保存にする
let autoSaveTimer = null;

function scheduleAutoSave() {
  if (!state.folderId) return; // サインイン前は何もしない
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => { handleSave(); }, AUTO_SAVE_DELAY_MS);
}

async function onSignedIn() {
  toggleAuthUI(true);
  setStatus('Google Driveと同期中…', { busy: true });
  try {
    state.folderId = await findOrCreateAppFolder();
    state.mediaFolderId = await findOrCreateSubfolder(CONFIG.MEDIA_FOLDER_NAME, state.folderId);
    const { fileId, data } = await loadData(state.folderId);
    state.fileId = fileId;
    state.cards = data.cards || [];
    state.sessions = data.sessions || [];
    state.connections = data.connections || [];
    state.hiddenAutoLinks = data.hiddenAutoLinks || [];
    state.exhibitionCalendarId = data.exhibitionCalendarId || null;
    state.crews = data.crews || [];
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
    ensureYearSessions();
    // セッション導入前に作られたカードは sessionId を持たないため、当時の年セッションへ引き継ぐ
    const migrationTargetId = getCurrentYearSessionId();
    state.cards.forEach((card) => {
      if (!card.sessionId) card.sessionId = migrationTargetId;
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
    renderYearTabs();
    renderBreadcrumb();
    renderAllCards();
    // 復元先はカードの生座標(scale 1, 原点0,0)のままだと画面外に散らばって見えるため、
    // 既存の「全カードが収まるまでズームアウト」機能で毎回きれいにフィットさせる。
    if (restoredBreadcrumb) fitAllCardsToScreen();
    refreshInfoTicker();
    // 日をまたいでアプリを開きっぱなしにした場合に備え、鑑賞可否を定期的に再判定する
    // (API通信は発生しない、ローカルの日付比較のみ)。
    setInterval(refreshInfoTicker, 30 * 60 * 1000);
    setStatus(`読み込み完了(${state.cards.length}件)`);
  } catch (err) {
    console.error(err);
    setStatus('同期に失敗しました(コンソールを確認)');
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

/** セッションに入る。isYear=true のときは年タブからの切り替えとして breadcrumb をリセットする */
function enterSession(id, isYear) {
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
  const session = {
    id: crypto.randomUUID(),
    type: 'session',
    parentId: activeSessionId(),
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
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  setStatus(`「${session.name}」セッションを作成しました`);
  scheduleAutoSave();
}

function renderAllCards() {
  els.content.innerHTML = '';
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

// セッションカードのタイトル編集欄に添えるOCR起動ボタンのアイコン(モノクロのカメラ)
const CAMERA_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z"/>' +
  '<circle cx="12" cy="13.2" r="3.2"/></svg>';

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
  const captionHex = CAPTIONABLE_MEDIA_TYPES.includes(mediaType) ? hex('caption', 'Caption') : '';
  // 写真の中の文字をOCRで抜き出す機能。画像のみ。「写真を残してメモに追記」「写真を破棄してテクストカード化」の2択
  const extractHex = mediaType === 'image' ? hex('extract', 'Extract') : '';
  // この写真に接続された状態のサマリーカードを新規作成するショートカット。画像のみ(サマリーが
  // 画像を見るのは接続された写真だけなので、動画・音声カードに置いても意味を持たないため)。
  const summonHex = mediaType === 'image' ? hex('summon', 'Summon') : '';
  return captionHex + hex('edit', 'Edit') + astrHex + hex('depth', 'Depth') + hex('delete', 'Delete') + extractHex + summonHex;
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

/**
 * メモ欄のマークアップ(2026年9月、ハイパーリンク対応で二重構造に変更)。
 * `.star-card-memo-view`(読み取り専用、URLをクリックできる<a>として描画、既定で表示)と
 * `.star-card-memo`(実データを持つtextarea、Edit中だけ表示)のペアを返す。textareaは
 * plainテキストしか描画できずリンクをクリックさせられないため、既定表示はview側が担い、
 * textareaはEditボタン/Eキーで開く入力専用の役割に変わった(以前はtextarea自身が
 * 表示も編集も兼ねていた)。
 */
function memoFieldHtml(card, hasMemo) {
  return (
    `<div class="star-card-memo-view" ${hasMemo ? '' : 'hidden'}>${linkifyMemoHtml(card.memo || '')}</div>` +
    `<textarea class="star-card-memo" placeholder="メモ" hidden>${escapeHtml(card.memo || '')}</textarea>`
  );
}

function renderCard(card) {
  const mediaType = card.mediaType || 'image';
  const isTextCard = mediaType === 'text';
  const isSessionCard = mediaType === 'session';
  const isInfoCard = mediaType === 'info';
  const isSummaryCard = mediaType === 'summary';
  const isStreetviewCard = mediaType === 'streetview';
  const isChatCard = mediaType === 'chat';
  // テクストカードは常時展開、それ以外はキャプション/メモが入るまでメモ欄を隠しておく
  const hasMemo = isTextCard || Boolean(card.memo);
  // 画像・動画・音声カード(observeMediaForLazyLoad()でDriveの実体を遅延読み込みする種別)には
  // CSSのcontent-visibility:autoを付けない(2026年9月、下記参照)。
  const isPlainMediaCard = !isTextCard && !isSessionCard && !isInfoCard && !isSummaryCard && !isStreetviewCard && !isChatCard;
  const el = document.createElement('div');
  el.className =
    'star-card' +
    (isTextCard ? ' star-card--text' : '') +
    (isSessionCard ? ' star-card--session' : '') +
    (isInfoCard ? ' star-card--info' : '') +
    (isSummaryCard ? ' star-card--summary' : '') +
    (isStreetviewCard ? ' star-card--streetview' : '') +
    (isChatCard ? ' star-card--chat' : '') +
    (isPlainMediaCard ? ' star-card--media' : '') +
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
          <span class="star-card-session-name">${escapeHtml(refSession ? refSession.name : '(不明なセッション)')}</span>
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
  } else {
    const crewHeadHtml = card.crewPersonaId
      ? `<div class="star-card-crew-head">
           <div class="star-card-crew-avatar">${escapeHtml(card.crewPersonaAvatar || '👤')}</div>
           <div class="star-card-crew-name">${escapeHtml(card.crewPersonaName || '')}</div>
         </div>`
      : '';
    el.innerHTML = `
      ${isTextCard ? '' : `<div class="star-card-media star-card-media-${mediaType}"></div>`}
      ${crewHeadHtml}
      ${memoFieldHtml(card, hasMemo)}
      ${EDIT_GUIDE_HANDLES_HTML}
      ${editGuideHexHtml(mediaType)}
    `;
  }
  els.content.appendChild(el);
  makeCardInteractive(el);

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
      }
      if (action !== 'astr' && action !== 'title' && action !== 'toggle' && action !== 'extract' && action !== 'summon') scheduleAutoSave();
    });
  });

  if (isSessionCard) {
    attachTapToOpen(el.querySelector('.star-card-session-body'), () => enterSession(card.refSessionId, false));
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
    });
    // メモ欄(ビュー/textareaいずれか表示中の方)は既定でpointer-events:none相当なので
    // (カード移動を優先するため)、通常はホイールもカード自身(ひいてはキャンバスのズーム)に
    // 流れてしまう。写真付きカードのメモ欄だけ最大高さ+内部スクロールにしてあるので、
    // カーソルがメモ欄の範囲内にある時だけホイールでメモ欄自体をスクロールできるようにする
    // (キャンバスのズームには渡さない)。hasMediaのチェックが無いと、テキストカードなど
    // max-heightの掛かっていないメモ欄でもわずかなサブピクセルの誤差でscrollHeightが
    // clientHeightよりわずかに大きく判定されることがあり、そのたびにホイールズームを
    // 奪ってしまうバグがあった(リサイズでsyncCardHeight()が再計算されるとこの誤差が
    // 解消されるため「リサイズすると直る」という症状になっていた)。
    const hasMedia = Boolean(el.querySelector('.star-card-media'));
    el.addEventListener('wheel', (event) => {
      const target = memoEl.hidden ? memoViewEl : memoEl;
      if (!hasMedia || !target || target.hidden || target.scrollHeight - target.clientHeight < 4) return;
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

  if (!isSessionCard && (card.imageFileId || card.thumbDataUrl)) {
    const mediaEl = el.querySelector('.star-card-media');
    // 概観時はまず軽量サムネイル(あれば)を即表示し、実際にカードが画面内に来たときだけ
    // Driveへ本画像/動画/音声を取りに行く(OneNoteのサムネイル運用と同じ考え方)。
    if (mediaType === 'image' && card.thumbDataUrl) {
      mediaEl.style.backgroundImage = `url(${card.thumbDataUrl})`;
    }
    // Driveアップロードがバックグラウンドで進行中でまだimageFileIdが無い場合、本体取得は
    // アップロード完了時(uploadCardFileInBackground)に改めてobserveMediaForLazyLoad()を呼ぶ。
    if (card.imageFileId) observeMediaForLazyLoad(el, card);
  }
  if (card.uploadPending) el.classList.add('star-card--upload-pending');
  if (card.uploadFailed) el.classList.add('star-card--upload-failed');

  // セッションカードはメモが空のままなら、以前どおりユーザーが手動で決めた高さを保つ
  // (毎回自動採寸すると、写真枠を持たない分だけ小さく潰れてしまうため)。
  if (!isSessionCard || card.memo) {
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
      } else if (c.memo && c.memo.trim()) {
        const label = c.mediaType === 'text' ? 'テキスト' : c.mediaType === 'info' ? 'インフォ' : 'キャプション/メモ';
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
    const persona = crew ? { personInfo: crew.personInfo, theirWords: crew.theirWords } : undefined;
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

/* ---------------- チャットカード「座談会」(2026年9月追加) ----------------
 * サマリーカードの「🗣 座談会をひらく」から、Boy・Professor・Gemini(素の人格無し)・ONの
 * Crewsペルソナ全員を参加者とする新規カード(mediaType:'chat')を隣にポップアップさせる。
 * 「要約の傾向」欄が最初の質問になる。ユーザーが「次の発言を進める」を押すたびに、参加者を
 * 順番に1人ずつ(ラウンドロビン)呼び出し、そこまでの会話ログ全体を文脈として渡した上で
 * 一言だけ発言させる。この「順番に呼んで、直前までの発言を見せる」だけの単純な仕組みで、
 * 特別な相互作用エンジンを実装せずとも自然と相互に言及し合う会話になる。会話の途中でも
 * いつでも新しい質問を投げ込める(次に呼ばれる参加者が、その質問を踏まえて答える)。
 * 参加者はカード作成時点のBoy/Professor/Gemini+ONのCrewsペルソナのスナップショットで固定し、
 * 後からCrewsのON/OFFを変えても既存の座談会カードの参加者は変わらない。
 * 無料運用の範囲内(検索グラウンディング無し、APIキー経由のaskGemini()を直接呼ぶだけ)で、
 * 1発言=1回のAPI呼び出し。会話が長くなるほど1日250回の共有プールを消費するため、ペースは
 * ユーザーのクリック任せ(自動連鎖はしない)。
 */

function buildRoundtableParticipants() {
  const list = [
    { kind: 'boy', id: 'boy', name: 'Boy', avatar: '👦' },
    { kind: 'professor', id: 'professor', name: 'Professor', avatar: '🎓' },
    { kind: 'gemini', id: 'gemini', name: 'Gemini', avatar: '✨' },
  ];
  (state.crews || []).filter((c) => c.enabled).forEach((c) => {
    list.push({ kind: 'crew', id: c.id, name: c.name, avatar: c.avatar, personInfo: c.personInfo, theirWords: c.theirWords });
  });
  return list;
}

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
    chatMessages: question ? [{ type: 'question', text: question, ts: Date.now() }] : [],
    chatNextIndex: 0,
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  scheduleAutoSave();
  return card;
}

function chatCardInnerHtml(card) {
  const session = getSessionById(card.sessionId);
  const messages = card.chatMessages || [];
  const logHtml = messages.length
    ? messages.map((m) => {
        if (m.type === 'question') {
          return `<div class="star-card-chat-question">❓ ${escapeHtml(m.text)}</div>`;
        }
        return `
          <div class="star-card-chat-line${m.kind === 'crew' ? ' crew' : ''}">
            <div class="star-card-chat-avatar">${escapeHtml(m.avatar || '')}</div>
            <div class="star-card-chat-bubble">
              <div class="star-card-chat-name">${escapeHtml(m.name || '')}</div>
              <div class="star-card-chat-text">${escapeHtml(m.text || '')}</div>
            </div>
          </div>
        `;
      }).join('')
    : '<p class="star-card-chat-empty">まだ発言はありません。「次の発言を進める」を押してください。</p>';
  return `
    <p class="star-card-chat-head"><span class="dot"></span>座談会 — ${escapeHtml(session ? session.name : '(不明)')}</p>
    <div class="star-card-chat-log">${logHtml}</div>
    <div class="star-card-chat-newq-row">
      <input type="text" class="star-card-chat-newq-input" placeholder="新しい質問を投げる(任意)">
      <button class="star-card-chat-newq-btn">投げる</button>
    </div>
    <button class="star-card-chat-next-btn">▶ 次の発言を進める</button>
    <p class="star-card-chat-status"></p>
    ${EDIT_GUIDE_HANDLES_HTML}
    ${editGuideHexHtml('chat')}
  `;
}

function wireChatCard(card, el) {
  const logEl = el.querySelector('.star-card-chat-log');
  const newqInput = el.querySelector('.star-card-chat-newq-input');
  const newqBtn = el.querySelector('.star-card-chat-newq-btn');

  if (newqInput) newqInput.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (newqBtn) {
    newqBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    newqBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = (newqInput?.value || '').trim();
      if (!text) return;
      card.chatMessages = card.chatMessages || [];
      card.chatMessages.push({ type: 'question', text, ts: Date.now() });
      scheduleAutoSave();
      rerenderCardInPlace(card, el);
      setStatus('新しい質問を投げました');
    });
  }

  const nextBtn = el.querySelector('.star-card-chat-next-btn');
  if (nextBtn) {
    nextBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleChatAdvanceTurn(card, el);
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
}

const chatTurnInFlight = new Set();

/** 座談会の参加者をラウンドロビンで1人呼び出し、そこまでの会話ログを文脈に一言だけ発言させる。 */
async function handleChatAdvanceTurn(card, el) {
  if (chatTurnInFlight.has(card.id)) return;
  const participants = card.chatParticipants || [];
  if (participants.length === 0) {
    setStatus('参加者がいません', { important: true });
    return;
  }
  const messages = card.chatMessages || [];
  if (!messages.some((m) => m.type === 'question')) {
    setStatus('先に質問を投げてください', { important: true });
    return;
  }

  chatTurnInFlight.add(card.id);
  const nextBtn = el.querySelector('.star-card-chat-next-btn');
  const statusEl = el.querySelector('.star-card-chat-status');
  if (nextBtn) nextBtn.disabled = true;
  if (statusEl) statusEl.textContent = '発言を考え中…';

  const speaker = participants[(card.chatNextIndex || 0) % participants.length];
  try {
    const sessionContext = collectSessionTextContext(card.sessionId, []);
    const transcriptText = messages
      .map((m) => (m.type === 'question' ? `[質問] ${m.text}` : `[${m.name}] ${m.text}`))
      .join('\n');
    const styleInstruction =
      speaker.kind === 'boy'
        ? '小学生・中学生にも分かるやさしい言葉で答えてください。'
        : speaker.kind === 'professor'
          ? '学術的な視点から答えてください。専門用語を使っても構いません。'
          : speaker.kind === 'crew'
            ? 'あなたは次の人物になりきって話してください。あなた自身の言葉ではなく、必ずこの人物の一人称の語りとして書くこと。\n' +
              `【人物情報】\n${speaker.personInfo}\n\n` +
              '【その言葉(この人物の語彙・言い回し・ものの見方を、以下の引用から読み取って声を似せること。引用をそのまま繰り返す必要はない)】\n' +
              `${speaker.theirWords}`
            : ''; // Gemini: 素の人格のまま、追加の文体指定なし
    const prompt =
      `以下はある美術展覧会・セッションの記録です:\n${sessionContext}\n\n` +
      'これは複数の立場が一言ずつ意見を交わす座談会のチャットです。ここまでの発言:\n' +
      `${transcriptText || '(まだ発言はありません)'}\n\n` +
      `あなたは次の話者「${speaker.name}」です。${styleInstruction}\n` +
      '直前までの発言を踏まえて構いません(賛成・反論・補足など)。前置き・名乗りは書かず、1〜2文の短い一言だけを返してください。';
    const raw = await askGemini({ prompt });

    card.chatMessages = messages.concat([{
      kind: speaker.kind, name: speaker.name, avatar: speaker.avatar, text: raw.trim(), ts: Date.now(),
    }]);
    card.chatNextIndex = ((card.chatNextIndex || 0) + 1) % participants.length;
    scheduleAutoSave();
    rerenderCardInPlace(card, el);
    setStatus(`${speaker.name}が発言しました`);
  } catch (err) {
    console.error(err);
    debugLog('座談会エラー: ' + err.message);
    setStatus(`発言の取得に失敗しました: ${err.message}`, { important: true });
    if (nextBtn) nextBtn.disabled = false;
    if (statusEl) statusEl.textContent = '';
  } finally {
    chatTurnInFlight.delete(card.id);
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

function getFileBlobUrlCached(fileId) {
  if (blobUrlCache.has(fileId)) {
    // LRU: 触れたら最後尾(最近使った側)へ移動する(Mapは挿入順を保持するため、
    // 削除して入れ直すだけで並び替えられる)
    const existing = blobUrlCache.get(fileId);
    blobUrlCache.delete(fileId);
    blobUrlCache.set(fileId, existing);
    return existing;
  }
  const promise = fetchFileBlobUrl(fileId).catch((err) => {
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

function observeMediaForLazyLoad(el, card) {
  cardByMediaEl.set(el, card);
  if (!mediaVisibilityObserver) {
    mediaVisibilityObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        mediaVisibilityObserver.unobserve(entry.target);
        loadFullMedia(entry.target, cardByMediaEl.get(entry.target));
      });
    }, { root: els.viewport, rootMargin: '400px' });
  }
  mediaVisibilityObserver.observe(el);
}

// 本画像の取得に失敗した回数(カード要素ごと)。無限リトライで叩き続けないよう上限を設ける。
const mediaLoadFailCount = new WeakMap();

/**
 * 本画像(フル解像度)の取得に失敗しても、以前は静かに諦めてサムネイルのまま固定されて
 * しまっていた(.then()にcatchが無く、失敗の痕跡も残らなかった。2026年9月、実機報告:
 * 一日使っていると写真がいつまでもぼやけたサムネイルのまま)。原因の多くはOAuthトークンの
 * 失効タイミングなど一時的なものと考えられるため、失敗時は少し待ってから再度Observerへ
 * 登録し直し、画面内に入り直したタイミングで自然にリトライさせる(最大3回まで)。
 */
function loadFullMedia(el, card) {
  const mediaEl = el.querySelector('.star-card-media');
  if (!mediaEl || !card.imageFileId) return;
  const mediaType = card.mediaType || 'image';
  getFileBlobUrlCached(card.imageFileId)
    .then((url) => {
      mediaLoadFailCount.delete(el);
      if (mediaType === 'video') {
        mediaEl.innerHTML = `<video src="${url}" controls playsinline></video>`;
      } else if (mediaType === 'audio') {
        mediaEl.innerHTML = `<audio src="${url}" controls></audio>`;
      } else {
        mediaEl.style.backgroundImage = `url(${url})`;
      }
    })
    .catch((err) => {
      const failCount = (mediaLoadFailCount.get(el) || 0) + 1;
      mediaLoadFailCount.set(el, failCount);
      console.warn(`本画像の取得に失敗(${failCount}回目、サムネイルのまま表示を続けます)`, err);
      debugLog(`本画像の取得に失敗(${failCount}回目): ${err.message}`); // スマホでもデバッグパネル(🐞)から追える
      if (failCount <= 3) {
        setTimeout(() => observeMediaForLazyLoad(el, card), 3000);
      }
    });
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
    if (result && result.kind === 'text' && result.text.trim()) {
      input.value = result.text.trim();
    }
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

/** 写真・動画カードの📌ボタン: OCRだけ起動し、結果をそのカードのメモに追記する */
async function handleCardCaption(card, el) {
  const result = await openCamera('caption');
  if (!result || result.kind !== 'text') return;
  card.memo = card.memo ? `${card.memo}\n\n${result.text}` : result.text;
  const memoEl = el.querySelector('.star-card-memo');
  memoEl.value = card.memo;
  const memoViewEl = el.querySelector('.star-card-memo-view');
  if (memoViewEl) {
    memoViewEl.innerHTML = linkifyMemoHtml(card.memo);
    memoViewEl.hidden = false;
  }
  syncCardHeight(el);
  setStatus('キャプションを反映しました');
  scheduleAutoSave();
}

/**
 * 写真カードの編集ガイド「Extract」: 写真に写っている文字をOCRで抜き出す。
 * **2026年9月に範囲選択機能を追加**: 押すとまず`openExtractRegionPicker()`のオーバーレイが開き、
 * 読み取りたい部分を自由形状(なぞって囲む、四角形限定ではない)で選べるようにした。何も囲まずに
 * 「画像全体を読み取る」を押せば、これまで通り画像全体が対象になる。キャンバス上の小さいカード
 * 表示のまま範囲を選ばせると精度が出ないため、専用のフルスクリーンオーバーレイで元画像の
 * 表示サイズいっぱいに描かせる。抽出は1回だけ行い、その後どう使うかを2択で確認する。
 * - OK(破棄): mediaTypeをimageからtextへ完全に作り替え、Drive上の元画像も削除する(元に戻せない)
 * - キャンセル(残す): 元の写真カードには一切触れず、抽出した文字だけを新しいテクストカードとして
 *   作る(サマリーカードの出力と同じ経路: createAstrConnection()で星座線を繋ぎ、効果音・発光
 *   演出も乗る)。以前は写真カード自身のメモ欄に追記していたが、長文だとメモ欄がスクロール
 *   形式になり読みにくくなるため、別カードに分ける形に変更した。
 */
async function handleCardExtract(card, el) {
  if (card.mediaType !== 'image') return;
  if (!card.imageFileId) {
    setStatus(card.uploadPending ? 'アップロード中です。少し待ってから試してください' : '画像が読み込めないため抽出できません');
    return;
  }

  setStatus('画像を読み込み中…', { busy: true });
  let originalBlob;
  try {
    const blobUrl = await getFileBlobUrlCached(card.imageFileId);
    originalBlob = await (await fetch(blobUrl)).blob();
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
  const discard = window.confirm(
    `文字を検出しました:\n\n${preview}\n\n` +
    '「OK」: 写真を破棄し、この文字だけのテクストカードに完全変換します(元に戻せません)\n' +
    '「キャンセル」: 元の写真カードはそのまま残し、抽出した文字を新しいテクストカードとして作ります'
  );

  if (discard) {
    const oldFileId = card.imageFileId;
    card.mediaType = 'text';
    card.memo = text;
    card.imageFileId = null;
    delete card.thumbDataUrl;
    delete card.uploadPending;
    delete card.uploadFailed;
    blobUrlCache.delete(oldFileId);
    rerenderCardInPlace(card, el);
    setStatus('テクストカードに変換しました');
    scheduleAutoSave();

    deleteFile(oldFileId).catch((err) => {
      console.error('元画像の削除に失敗', err);
      debugLog('Extract: 元画像のDrive削除に失敗: ' + err.message);
    });
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
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  await createCardFromCapture({
    blob: file,
    filename: `${Date.now()}-${file.name}`,
    mediaType: 'image',
  });
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
 * Drive へのアップロードとカード生成の共通処理。file-input・アプリ内蔵カメラ・クリップボード
 * 貼り付けの各経路から使う。
 * 画像はローカルで一瞬で作れるサムネイルだけを待ってすぐカードを表示し、Driveへのフル
 * サイズアップロードはバックグラウンドで進める(=Ctrl+Vや撮影直後の「ワンクッション」を
 * 無くすための最適化)。アップロード完了時にuploadCardFileInBackground()がimageFileIdを
 * 差し込む。動画・音声はローカルサムネイルが無いため、この最適化の恩恵は薄いが、同じ
 * 経路に揃えて実装をシンプルに保っている。
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
    uploadPending: true,
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  redrawAsterismLines();
  setStatus('追加しました。アップロード中…', { busy: true });
  scheduleAutoSave(); // アップロード完了前にタブを閉じても、カードの存在自体は残るように

  uploadCardFileInBackground(card, blob, filename);
  return card;
}

/** createCardFromCapture()が即座に表示したカードの実体を、裏でDriveへアップロードする */
async function uploadCardFileInBackground(card, blob, filename) {
  try {
    const folderId = await resolveSessionMediaFolderId(card.sessionId);
    const fileId = await uploadFile(folderId, blob, filename);
    card.imageFileId = fileId;
    card.uploadPending = false;
    const el = cardElById(card.id);
    if (el) {
      el.classList.remove('star-card--upload-pending');
      observeMediaForLazyLoad(el, card);
    }
    scheduleAutoSave();
  } catch (err) {
    console.error(err);
    card.uploadPending = false;
    card.uploadFailed = true;
    const el = cardElById(card.id);
    if (el) {
      el.classList.remove('star-card--upload-pending');
      el.classList.add('star-card--upload-failed');
    }
    setStatus('アップロードに失敗しました(カードは残りますがDriveには保存されていません)', { important: true });
    scheduleAutoSave();
  }
}

async function handleSave() {
  setStatus('自動保存中…');
  try {
    state.fileId = await saveData(state.folderId, state.fileId, {
      cards: state.cards,
      sessions: state.sessions,
      connections: state.connections,
      hiddenAutoLinks: state.hiddenAutoLinks,
      exhibitionCalendarId: state.exhibitionCalendarId,
      crews: state.crews,
      feHistory: state.feHistory,
      feHistoryIndex: state.feHistoryIndex,
      breadcrumb: state.breadcrumb,
    });
    setStatus('自動保存しました');
  } catch (err) {
    console.error(err);
    setStatus('自動保存に失敗しました(コンソールを確認)', { important: true });
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
