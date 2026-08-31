// アプリのエントリーポイント。認証・Drive・キャンバス・Geminiを結線する。

const state = {
  folderId: null,
  fileId: null,
  cards: [],
};

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
  els.addCardBtn = document.getElementById('add-card-btn');
  els.cameraBtn = document.getElementById('camera-btn');
  els.saveBtn = document.getElementById('save-btn');
  els.status = document.getElementById('status');
  els.viewport = document.getElementById('canvas-viewport');
  els.content = document.getElementById('canvas-content');
  els.imageInput = document.getElementById('image-input');

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
  els.addCardBtn.addEventListener('click', () => els.imageInput.click());
  els.imageInput.addEventListener('change', handleImageSelected);
  els.cameraBtn.addEventListener('click', handleOpenCamera);
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
  els.addCardBtn.disabled = !signedIn;
  els.cameraBtn.disabled = !signedIn;
  els.saveBtn.disabled = !signedIn;
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
    renderAllCards();
    setStatus(`読み込み完了(${state.cards.length}件)`);
  } catch (err) {
    console.error(err);
    setStatus('同期に失敗しました(コンソールを確認)');
  }
}

function renderAllCards() {
  els.content.innerHTML = '';
  state.cards.forEach(renderCard);
}

const CAPTIONABLE_MEDIA_TYPES = ['image', 'video'];

// キャプションボタンのアイコン(モノクロのピン、絵文字ではなく currentColor の線画)
const PIN_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-7.58 7-12a7 7 0 10-14 0c0 4.42 7 12 7 12z"/>' +
  '<circle cx="12" cy="9" r="2.4"/></svg>';

function renderCard(card) {
  const mediaType = card.mediaType || 'image';
  const isTextCard = mediaType === 'text';
  const el = document.createElement('div');
  el.className = 'star-card' + (isTextCard ? ' star-card--text' : '');
  el.dataset.id = card.id;
  el.dataset.x = String(card.x);
  el.dataset.y = String(card.y);
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;
  el.style.transform = `translate(${card.x}px, ${card.y}px)`;
  el.innerHTML = `
    <button class="star-card-delete-btn" title="削除">✕</button>
    ${CAPTIONABLE_MEDIA_TYPES.includes(mediaType) ? `<button class="star-card-caption-btn" title="キャプションを読み取る">${PIN_ICON_SVG}</button>` : ''}
    ${isTextCard ? '' : `<div class="star-card-media star-card-media-${mediaType}"></div>`}
    <textarea class="star-card-memo" placeholder="メモ">${escapeHtml(card.memo || '')}</textarea>
  `;
  els.content.appendChild(el);
  makeCardInteractive(el);

  const memoEl = el.querySelector('.star-card-memo');
  memoEl.addEventListener('input', () => {
    card.memo = memoEl.value;
    syncCardHeight(el);
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
  el.querySelector('.star-card-memo').value = card.memo;
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
async function handleOpenCamera() {
  const result = await openCamera('photo');
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
    state.fileId = await saveData(state.folderId, state.fileId, { cards: state.cards });
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
