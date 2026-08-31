// アプリのエントリーポイント。認証・Drive・キャンバス・Geminiを結線する。

const state = {
  folderId: null,
  fileId: null,
  cards: [],
  // セッション(年 / 展覧会 / 作品などの入れ子)。フラット配列 + parentId でツリーを表現する。
  // { id, type: 'year'|'session', parentId, name, year(yearのみ), createdAt }
  sessions: [],
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
  els.saveBtn = document.getElementById('save-btn');
  els.toolUpload = document.getElementById('tool-upload');
  els.toolCamera = document.getElementById('tool-camera');
  els.toolOcr = document.getElementById('tool-ocr');
  els.toolVideo = document.getElementById('tool-video');
  els.toolAudio = document.getElementById('tool-audio');
  els.toolSession = document.getElementById('tool-session');
  els.status = document.getElementById('status');
  els.viewport = document.getElementById('canvas-viewport');
  els.content = document.getElementById('canvas-content');
  els.imageInput = document.getElementById('image-input');
  els.yearTabs = document.getElementById('year-tabs');
  els.breadcrumb = document.getElementById('breadcrumb');

  initCanvas(els.viewport, els.content);

  els.settingsBtn.addEventListener('click', () => openSettings());
  els.settingsSaveBtn.addEventListener('click', handleSettingsSave);
  els.settingsCancelBtn.addEventListener('click', closeSettings);

  debugLog('DOMContentLoaded, isConfigured=' + isConfigured());

  if (isConfigured()) {
    els.signInBtn.disabled = false;
    whenGisReady(() => {
      debugLog('whenGisReady -> initAuth() 呼び出し');
      initAuth(onSignedIn);
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
  els.toolOcr.addEventListener('click', () => handleOpenCamera('caption'));
  els.toolVideo.addEventListener('click', () => handleOpenCamera('video'));
  els.toolAudio.addEventListener('click', () => handleOpenCamera('audio'));
  els.toolSession.addEventListener('click', handleCreateSession);
  els.saveBtn.addEventListener('click', handleSave);
});

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

function toggleAuthUI(signedIn) {
  els.signInBtn.hidden = signedIn;
  els.signOutBtn.hidden = !signedIn;
  els.saveBtn.disabled = !signedIn;
  els.toolUpload.disabled = !signedIn;
  els.toolCamera.disabled = !signedIn;
  els.toolOcr.disabled = !signedIn;
  els.toolVideo.disabled = !signedIn;
  els.toolAudio.disabled = !signedIn;
  els.toolSession.disabled = !signedIn;
}

function setStatus(message) {
  els.status.textContent = message;
}

async function onSignedIn() {
  toggleAuthUI(true);
  setStatus('Google Driveと同期中…');
  try {
    state.folderId = await findOrCreateAppFolder();
    const { fileId, data } = await loadData(state.folderId);
    state.fileId = fileId;
    state.cards = data.cards || [];
    state.sessions = data.sessions || [];
    ensureYearSessions();
    // セッション導入前に作られたカードは sessionId を持たないため、当時の年セッションへ引き継ぐ
    const migrationTargetId = getCurrentYearSessionId();
    state.cards.forEach((card) => {
      if (!card.sessionId) card.sessionId = migrationTargetId;
    });
    state.breadcrumb = [migrationTargetId];
    renderYearTabs();
    renderBreadcrumb();
    renderAllCards();
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
}

function handleCreateSession() {
  const name = window.prompt('新規セッションの名前(展覧会名や作品名など)');
  if (!name) return;
  const session = {
    id: crypto.randomUUID(),
    type: 'session',
    parentId: activeSessionId(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
  };
  state.sessions.push(session);

  const card = {
    id: crypto.randomUUID(),
    x: 40,
    y: 40,
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
  setStatus(`「${session.name}」セッションを作成しました(保存ボタンで確定)`);
}

function renderAllCards() {
  els.content.innerHTML = '';
  const currentId = activeSessionId();
  state.cards
    .filter((card) => card.sessionId === currentId)
    .forEach(renderCard);
}

const CAPTIONABLE_MEDIA_TYPES = ['image', 'video'];

// キャプションボタンのアイコン(モノクロのピン、絵文字ではなく currentColor の線画)
const PIN_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-7.58 7-12a7 7 0 10-14 0c0 4.42 7 12 7 12z"/>' +
  '<circle cx="12" cy="9" r="2.4"/></svg>';

// メモ編集ボタンのアイコン(モノクロの鉛筆)
const EDIT_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/>' +
  '<path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>';

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
    if (moved < 6) onOpen();
  });
}

function renderCard(card) {
  const mediaType = card.mediaType || 'image';
  const isTextCard = mediaType === 'text';
  const isSessionCard = mediaType === 'session';
  // テクストカードは常時展開、それ以外はキャプションが入るまでメモ欄を隠しておく
  const hasMemo = !isSessionCard && (isTextCard || Boolean(card.memo));
  const el = document.createElement('div');
  el.className = 'star-card' + (isTextCard ? ' star-card--text' : '') + (isSessionCard ? ' star-card--session' : '');
  el.dataset.id = card.id;
  el.dataset.x = String(card.x);
  el.dataset.y = String(card.y);
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;
  el.style.transform = `translate(${card.x}px, ${card.y}px)`;

  if (isSessionCard) {
    const refSession = getSessionById(card.refSessionId);
    const childCount = state.cards.filter((c) => c.sessionId === card.refSessionId).length;
    el.innerHTML = `
      <button class="star-card-delete-btn" title="削除">✕</button>
      <div class="star-card-session-body" title="タップで開く">
        <span class="star-card-session-name">${escapeHtml(refSession ? refSession.name : '(不明なセッション)')}</span>
        <span class="star-card-session-count">${childCount}件</span>
      </div>
    `;
  } else {
    el.innerHTML = `
      <button class="star-card-delete-btn" title="削除">✕</button>
      ${CAPTIONABLE_MEDIA_TYPES.includes(mediaType) ? `<button class="star-card-caption-btn" title="キャプションを読み取る">${PIN_ICON_SVG}</button>` : ''}
      ${isTextCard ? '' : `<div class="star-card-media star-card-media-${mediaType}"></div>`}
      <textarea class="star-card-memo" placeholder="メモ" ${hasMemo ? '' : 'hidden'}>${escapeHtml(card.memo || '')}</textarea>
      <button class="star-card-edit-btn" title="メモを編集" ${hasMemo ? '' : 'hidden'}>${EDIT_ICON_SVG}</button>
    `;
  }
  els.content.appendChild(el);
  makeCardInteractive(el);

  if (isSessionCard) {
    el.querySelector('.star-card-delete-btn').addEventListener('click', () => deleteCard(card, el));
    attachTapToOpen(el.querySelector('.star-card-session-body'), () => enterSession(card.refSessionId, false));
    return;
  }

  const memoEl = el.querySelector('.star-card-memo');
  const editBtn = el.querySelector('.star-card-edit-btn');

  memoEl.addEventListener('input', () => {
    card.memo = memoEl.value;
    syncCardHeight(el);
  });
  // 既定ではメモへのポインタ操作を無効化し、カードの移動を優先する。
  // 鉛筆ボタンを押した時だけ編集を受け付け、フォーカスが外れたら移動優先に戻す。
  memoEl.addEventListener('blur', () => {
    memoEl.style.pointerEvents = 'none';
  });
  editBtn.addEventListener('click', () => {
    memoEl.style.pointerEvents = 'auto';
    memoEl.focus();
  });

  el.querySelector('.star-card-delete-btn').addEventListener('click', () => deleteCard(card, el));

  const captionBtn = el.querySelector('.star-card-caption-btn');
  if (captionBtn) {
    captionBtn.addEventListener('click', () => handleCardCaption(card, el));
  }

  if (card.imageFileId) {
    fetchFileBlobUrl(card.imageFileId).then((url) => {
      const mediaEl = el.querySelector('.star-card-media');
      if (mediaType === 'video') {
        mediaEl.innerHTML = `<video src="${url}" controls playsinline></video>`;
      } else if (mediaType === 'audio') {
        mediaEl.innerHTML = `<audio src="${url}" controls></audio>`;
      } else {
        mediaEl.style.backgroundImage = `url(${url})`;
      }
    });
  }

  syncCardHeight(el);
}

/**
 * メモの中身に合わせてテキストエリアとカード全体の高さを伸ばし、スクロールなしで全文が
 * 見えるようにする。写真・動画のメディア枠は現在の高さでいったん固定してから、
 * メモぶんだけカードを縦に伸ばす。
 */
function syncCardHeight(el) {
  const memoEl = el.querySelector('.star-card-memo');
  if (!memoEl) return;
  const mediaEl = el.querySelector('.star-card-media');
  if (mediaEl && mediaEl.style.flex !== 'none') {
    mediaEl.style.height = `${mediaEl.getBoundingClientRect().height}px`;
    mediaEl.style.flex = 'none';
  }
  memoEl.style.height = 'auto';
  memoEl.style.height = `${memoEl.scrollHeight}px`;
  el.style.height = 'auto';
  const total = el.getBoundingClientRect().height;
  el.style.height = `${total}px`;
  const card = getCardById(el.dataset.id);
  if (card) card.height = total;
}

function deleteCard(card, el) {
  const idx = state.cards.indexOf(card);
  if (idx !== -1) state.cards.splice(idx, 1);
  el.remove();
  setStatus('削除しました(保存ボタンで確定)');
}

/** 写真・動画カードの📌ボタン: OCRだけ起動し、結果をそのカードのメモに追記する */
async function handleCardCaption(card, el) {
  const result = await openCamera('caption');
  if (!result || result.kind !== 'text') return;
  card.memo = card.memo ? `${card.memo}\n\n${result.text}` : result.text;
  const memoEl = el.querySelector('.star-card-memo');
  memoEl.value = card.memo;
  memoEl.hidden = false;
  el.querySelector('.star-card-edit-btn').hidden = false;
  syncCardHeight(el);
  setStatus('キャプションを反映しました(保存ボタンで確定)');
}

function getCardById(id) {
  return state.cards.find((c) => String(c.id) === String(id));
}

async function handleImageSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const card = await createCardFromCapture({
    blob: file,
    filename: `${Date.now()}-${file.name}`,
    mediaType: 'image',
  });
  if (!card) return;

  try {
    const ocrText = await ocrImage(file);
    if (ocrText && !ocrText.includes('(テキストなし)')) {
      card.memo = ocrText;
      renderAllCards();
    }
  } catch (err) {
    console.warn('Gemini OCR に失敗しました', err);
  }
}

/** アプリ内蔵カメラ(js/camera.js)を開き、撮影結果をカードとして追加する */
async function handleOpenCamera(mode) {
  const result = await openCamera(mode);
  if (!result) return;

  if (result.kind === 'photo') {
    const card = await createCardFromCapture({
      blob: result.blob,
      filename: `${Date.now()}-photo.jpg`,
      mediaType: 'image',
    });
    if (!card) return;
    try {
      const ocrText = await ocrImage(result.blob);
      if (ocrText && !ocrText.includes('(テキストなし)')) {
        card.memo = ocrText;
        renderAllCards();
      }
    } catch (err) {
      console.warn('Gemini OCR に失敗しました', err);
    }
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

/** テクストモードの読み取り結果からカードを作る(画像を伴わないため Drive アップロードは不要) */
function createTextCard(text) {
  const card = {
    id: crypto.randomUUID(),
    x: 40,
    y: 40,
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
  setStatus('テクストを追加しました(保存ボタンで確定)');
  return card;
}

/** Drive へのアップロードとカード生成の共通処理。file-input・アプリ内蔵カメラの両経路から使う */
async function createCardFromCapture({ blob, filename, mediaType, memo }) {
  setStatus('アップロード中…');
  let fileId;
  try {
    fileId = await uploadFile(state.folderId, blob, filename);
  } catch (err) {
    console.error(err);
    setStatus('アップロードに失敗しました');
    return null;
  }

  const card = {
    id: crypto.randomUUID(),
    x: 40,
    y: 40,
    width: 220,
    height: 260,
    memo: memo || '',
    tags: [],
    mediaType,
    imageFileId: fileId,
    sessionId: activeSessionId(),
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  setStatus('追加しました(保存ボタンで確定)');
  return card;
}

async function handleSave() {
  setStatus('保存中…');
  try {
    state.fileId = await saveData(state.folderId, state.fileId, {
      cards: state.cards,
      sessions: state.sessions,
    });
    setStatus('保存しました');
  } catch (err) {
    console.error(err);
    setStatus('保存に失敗しました(コンソールを確認)');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
