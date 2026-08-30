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
  els.saveBtn = document.getElementById('save-btn');
  els.status = document.getElementById('status');
  els.viewport = document.getElementById('canvas-viewport');
  els.content = document.getElementById('canvas-content');
  els.imageInput = document.getElementById('image-input');

  initCanvas(els.viewport, els.content);

  els.settingsBtn.addEventListener('click', () => openSettings());
  els.settingsSaveBtn.addEventListener('click', handleSettingsSave);
  els.settingsCancelBtn.addEventListener('click', closeSettings);

  if (isConfigured()) {
    els.signInBtn.disabled = false;
    initAuth(onSignedIn);
  } else {
    openSettings();
  }

  els.signInBtn.addEventListener('click', () => signIn());
  els.signOutBtn.addEventListener('click', () => {
    signOut();
    toggleAuthUI(false);
    setStatus('サインアウトしました');
  });
  els.addCardBtn.addEventListener('click', () => els.imageInput.click());
  els.imageInput.addEventListener('change', handleImageSelected);
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
  initAuth(onSignedIn);
  setStatus('設定を保存しました。「Googleでサインイン」を押してください');
}

function toggleAuthUI(signedIn) {
  els.signInBtn.hidden = signedIn;
  els.signOutBtn.hidden = !signedIn;
  els.addCardBtn.disabled = !signedIn;
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

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'star-card';
  el.dataset.id = card.id;
  el.dataset.x = String(card.x);
  el.dataset.y = String(card.y);
  el.style.width = `${card.width}px`;
  el.style.height = `${card.height}px`;
  el.style.transform = `translate(${card.x}px, ${card.y}px)`;
  el.innerHTML = `
    <div class="star-card-image"></div>
    <div class="star-card-title">${escapeHtml(card.title || '無題')}</div>
    <textarea class="star-card-memo" placeholder="メモ">${escapeHtml(card.memo || '')}</textarea>
  `;
  els.content.appendChild(el);
  makeCardInteractive(el);

  const memoEl = el.querySelector('.star-card-memo');
  memoEl.addEventListener('input', () => {
    card.memo = memoEl.value;
  });

  if (card.imageFileId) {
    fetchImageBlobUrl(card.imageFileId).then((url) => {
      el.querySelector('.star-card-image').style.backgroundImage = `url(${url})`;
    });
  }
}

function getCardById(id) {
  return state.cards.find((c) => String(c.id) === String(id));
}

async function handleImageSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  setStatus('画像をアップロード中…');
  let imageFileId;
  try {
    imageFileId = await uploadImage(state.folderId, file, `${Date.now()}-${file.name}`);
  } catch (err) {
    console.error(err);
    setStatus('画像のアップロードに失敗しました');
    return;
  }

  const card = {
    id: crypto.randomUUID(),
    x: 40,
    y: 40,
    width: 220,
    height: 260,
    title: '',
    memo: '',
    tags: [],
    imageFileId,
    createdAt: new Date().toISOString(),
  };
  state.cards.push(card);
  renderCard(card);
  setStatus('画像を追加しました(保存ボタンで確定)');

  try {
    const ocrText = await ocrImage(file);
    if (ocrText && !ocrText.includes('(テキストなし)')) {
      card.title = ocrText.split('\n')[0].slice(0, 40);
      renderAllCards();
    }
  } catch (err) {
    console.warn('Gemini OCR に失敗しました', err);
  }
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
