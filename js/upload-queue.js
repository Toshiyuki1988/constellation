// Driveへのアップロードを、モバイル通信中は保留してWi-Fi接続時にまとめて行うための待機列。
// 「現地でサクサク写真とキャプションを取り込みたい一方、モバイル通信量は節約したい」という
// ユーザー要望(2026年9月)への対応。**「Driveはバックアップなのでアプリ側から元画像を
// いじらない」という既存方針(js/drive.js参照)とは矛盾しない**: あくまで「いつアップロードするか」
// のタイミングだけを制御するもので、アップロードした後のファイルには一切触れない(削除・上書き
// はしない、これまで通り)。ユーザー自身、「ドライブバックアップ思想と逆行するが、通信量節約が
// 優先」と明言している。
//
// 保留中の実データ(Blob)はメモリ上ではなくIndexedDBへ保存する。メモリだけに置くと、Wi-Fiに
// 辿り着く前にタブが再読み込みされたり、iOS Safariがバックグラウンドタブのプロセスを
// 終了させたりした場合に、その日撮った写真がまるごと失われてしまうため。
//
// 通信種別の判定: navigator.connection(Network Information API)はAndroid Chrome系では
// 概ね使えるが、iOS Safariには2026年9月時点で実装が無い。自動判定できない端末では、
// ヘッダーのボタン(js/app.jsのupdateUploadNetworkButton()側で描画)でユーザー自身が
// 「Wi-Fi/モバイル」を手動切り替えする運用にフォールバックする(自動判定が効く環境では、
// 変化を検知するたびに自動でこの状態を更新する。手動操作は自動判定が無い/効かない環境の
// ためのものだが、いつでも上書きできる)。初回・判定不能時は「保留」を既定にする
// (通信量節約を優先するというユーザー方針を、判定できない場合でも安全側に倒すため)。

const UPLOAD_QUEUE_DB_NAME = 'constellation-upload-queue';
const UPLOAD_QUEUE_STORE = 'pending';
const UPLOAD_ALLOWED_STORAGE_KEY = 'constellation-uploads-allowed';
const UPLOAD_QUEUE_CONCURRENCY = 2;

let uploadQueueDbPromise = null;
let uploadsAllowedNow = readStoredUploadsAllowed();
let uploadQueueDraining = false;

function readStoredUploadsAllowed() {
  try {
    const raw = localStorage.getItem(UPLOAD_ALLOWED_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch (err) { /* localStorageが使えない環境では無視 */ }
  return false;
}

function persistUploadsAllowed(value) {
  try { localStorage.setItem(UPLOAD_ALLOWED_STORAGE_KEY, String(value)); } catch (err) { /* 無視 */ }
}

/* ---------------- IndexedDB(保留中のBlobの永続化) ---------------- */

function openUploadQueueDb() {
  if (uploadQueueDbPromise) return uploadQueueDbPromise;
  uploadQueueDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(UPLOAD_QUEUE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(UPLOAD_QUEUE_STORE)) {
        req.result.createObjectStore(UPLOAD_QUEUE_STORE, { keyPath: 'cardId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return uploadQueueDbPromise;
}

function uploadQueuePut(entry) {
  return openUploadQueueDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readwrite');
    tx.objectStore(UPLOAD_QUEUE_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function uploadQueueDelete(cardId) {
  return openUploadQueueDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readwrite');
    tx.objectStore(UPLOAD_QUEUE_STORE).delete(cardId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function uploadQueueGetAll() {
  return openUploadQueueDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readonly');
    const req = tx.objectStore(UPLOAD_QUEUE_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

function uploadQueueCount() {
  return openUploadQueueDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readonly');
    const req = tx.objectStore(UPLOAD_QUEUE_STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  })).catch(() => 0);
}

/* ---------------- 通信種別の判定・切り替え ---------------- */

function isUploadAllowedNow() {
  return uploadsAllowedNow;
}

function setUploadsAllowed(value) {
  const changed = uploadsAllowedNow !== value;
  uploadsAllowedNow = value;
  persistUploadsAllowed(value);
  if (typeof updateUploadNetworkButton === 'function') updateUploadNetworkButton();
  if (changed && value) drainUploadQueue();
}

/** ヘッダーのボタンから呼ぶ手動切り替え */
function toggleUploadsAllowed() {
  setUploadsAllowed(!uploadsAllowedNow);
}

/** DOMContentLoaded時にjs/app.jsから1回呼ぶ。navigator.connectionが使えない端末
 *  (iOS Safari等)では何もせず、ヘッダーの手動トグルだけに委ねる。 */
function initUploadNetworkDetection() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;
  const applyFromConnection = () => {
    if (typeof conn.type === 'undefined') return; // typeを持たない実装(effectiveTypeのみ等)は対象外
    if (conn.type === 'wifi' || conn.type === 'ethernet') setUploadsAllowed(true);
    else if (conn.type === 'cellular') setUploadsAllowed(false);
    // 'none'/'unknown'等は判断材料にせず、直前の状態を維持する
  };
  conn.addEventListener('change', applyFromConnection);
  applyFromConnection();
}

/* ---------------- キューへの出し入れ ---------------- */

/** 待機列へ保存する。成功すればtrue(呼び出し元は何もアップロードしない)、IndexedDBが
 *  使えない等の理由で失敗すればfalse(呼び出し元はその場でアップロードすべき、データを
 *  失わないことを優先する)を返す。 */
async function persistToUploadQueue(card, blob, filename) {
  try {
    await uploadQueuePut({
      cardId: card.id,
      sessionId: card.sessionId,
      blob,
      filename,
      mediaType: card.mediaType,
      createdAt: Date.now(),
    });
    if (typeof updateUploadNetworkButton === 'function') updateUploadNetworkButton();
    return true;
  } catch (err) {
    console.error('アップロード待機列への保存に失敗', err);
    return false;
  }
}

async function uploadQueuedEntry(entry) {
  const card = typeof getCardById === 'function' ? getCardById(entry.cardId) : null;
  if (!card) {
    // カード自体が既に削除済み。待機中のファイルだけDriveへ送っても紐付け先が無いため破棄する。
    await uploadQueueDelete(entry.cardId).catch(() => {});
    return;
  }
  await uploadCardFileInBackground(card, entry.blob, entry.filename);
  await uploadQueueDelete(entry.cardId).catch(() => {});
}

/** Wi-Fi中(isUploadAllowedNow()がtrue)の間だけ、待機列を少しずつアップロードしていく。
 *  ドレイン中にモバイルへ戻った場合はそこで打ち切り、残りは次にWi-Fiになった時に再開する。 */
async function drainUploadQueue() {
  if (uploadQueueDraining) return;
  if (!isUploadAllowedNow()) return;
  uploadQueueDraining = true;
  try {
    let entries = await uploadQueueGetAll();
    while (entries.length > 0 && isUploadAllowedNow()) {
      const batch = entries.slice(0, UPLOAD_QUEUE_CONCURRENCY);
      await Promise.all(batch.map(uploadQueuedEntry));
      if (typeof updateUploadNetworkButton === 'function') updateUploadNetworkButton();
      entries = await uploadQueueGetAll();
    }
  } catch (err) {
    console.error('アップロード待機列の処理に失敗', err);
  } finally {
    uploadQueueDraining = false;
  }
}

/**
 * 再読み込み直後、js/app.jsのonSignedIn()から1回呼ぶ。前回終了時に待機列へ残っていたぶんを
 * 拾い直し、Wi-Fi中ならそのままドレインを始める。card.uploadQueuedが立っているのに実データが
 * 見つからない(別端末で作られた・ブラウザのストレージが消去された等)場合は、詰まったままに
 * せず「アップロード失敗」扱いにして、少なくともユーザーが気づけるようにする。
 */
async function restoreUploadQueueOnLoad() {
  let entries;
  try {
    entries = await uploadQueueGetAll();
  } catch (err) {
    console.error('アップロード待機列の読み込みに失敗', err);
    entries = [];
  }
  const queuedCardIds = new Set(entries.map((e) => e.cardId));
  state.cards.forEach((card) => {
    if (card.uploadQueued && !queuedCardIds.has(card.id)) {
      card.uploadQueued = false;
      card.uploadPending = false;
      card.uploadFailed = true;
      const el = typeof cardElById === 'function' ? cardElById(card.id) : null;
      if (el) {
        el.classList.remove('star-card--upload-pending', 'star-card--upload-queued');
        el.classList.add('star-card--upload-failed');
      }
    }
  });
  if (typeof updateUploadNetworkButton === 'function') updateUploadNetworkButton();
  if (isUploadAllowedNow()) drainUploadQueue();
}
