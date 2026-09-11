// Driveへのアップロードを完全に手動化するための待機列。
// 「現地でサクサク写真とキャプションを取り込みたい一方、モバイル通信量は使いたくない」という
// ユーザー要望への対応。**「Driveはバックアップなのでアプリ側から元画像をいじらない」という
// 既存方針(js/drive.js参照)とは矛盾しない**: あくまで「いつアップロードするか」のタイミング
// だけを制御するもので、アップロードした後のファイルには一切触れない(削除・上書きはしない、
// これまで通り)。
//
// **2026年9月、設計を全面手動化**: 以前はnavigator.connection(Network Information API)や
// ヘッダーのWi-Fi/モバイル切り替えボタンで「今アップロードして良いか」を判定し、Wi-Fiと
// 判定された瞬間に自動でドレインする方式だった。しかしiOS Safariにはnavigator.connectionが
// 無いため、この判定は実質「ユーザーが最後に手動で切り替えた状態」が**localStorageに何日でも
// 残り続けるだけ**の仕組みで、一度でもWi-Fi側にした状態のまま現地(モバイル回線)に行くと、
// 気づかないままモバイル回線で直接アップロードされ続ける事故につながった(2026年9月、実機で
// 3日間・計0.87GBのモバイル通信を消費したことが判明)。
//
// この反省を受け、通信種別の自動判定・自動ドレインは完全に撤去し、**Driveへのアップロードは
// 常にユーザーが設定モーダル内の「☁ Driveへ送信」ボタンを押した時だけ**行う設計にした。それ以外の
// 経路(撮影直後・アプリ起動時・通信状態の変化など)では一切Driveへ送信しない。ボタンをヘッダーの
// 常設位置ではなく設定モーダルの中に置いているのも、誤って押してしまう事故を減らすため。
//
// 撮影データ自体は、ボタンを押すまでの間ずっとIndexedDBへ保存される(メモリだけに置くと、
// タブが再読み込みされたり、iOS Safariがバックグラウンドタブのプロセスを終了させたりした
// 場合に、その日撮った写真がまるごと失われてしまうため)。さらに、この待機列にある間に
// 「📤 端末へ保存」ボタンで端末の「写真」アプリ(または音声ならファイルアプリ等)へも
// コピーしておける(exportPendingUploadsToPhotos()、下記参照)。
//
// **2026年9月、途中停止に対応**: モバイル回線のままうっかり「☁ Driveへ送信」を押してしまった
// 場合に備え、送信中は同じボタンが「■ 停止」に切り替わり(js/app.jsのhandleDriveUploadBtnClick())、
// 押すとAbortController経由で進行中のfetch()自体を即座に中断できるようにした(cancelDriveUpload())。
// 中断されたエントリは待機列に残したまま(uploadFailedにはしない)、いつでも再送信できる。

const UPLOAD_QUEUE_DB_NAME = 'constellation-upload-queue';
const UPLOAD_QUEUE_STORE = 'pending';
const UPLOAD_QUEUE_CONCURRENCY = 2;

let uploadQueueDbPromise = null;
let uploadQueueDraining = false;
// 進行中のDrive送信を中断するためのAbortController。ドレイン中(uploadQueueDraining)だけ
// 存在し、cancelDriveUpload()が呼ばれるとabort()され、進行中のfetch()を即座に打ち切る。
let uploadAbortController = null;

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

/**
 * まだDriveへ送信していない(card.imageFileIdが無い)カードのズーム時、本画像として使う
 * ための実データを1件だけ取得する(2026年9月追加)。**Driveアップロードの完全手動化により、
 * 送信ボタンを押すまでcard.imageFileIdが無い期間が(以前の「Wi-Fiになり次第自動送信」と
 * 違って)数時間〜数日と長くなり得るようになった**。その間ズームしても本画像に切り替わらず
 * サムネイルのまま荒いという実機報告があったが、根本的には解像度の高い元データはこの
 * 待機列(IndexedDB)に既にまるごと存在しており、わざわざDriveへ送るまで取りに行けないのは
 * 不要な制約だった。js/app.jsのloadFullMedia()が、card.imageFileIdが無い間はこちらを
 * フォールバックとして使う。 */
function getQueuedEntryBlob(cardId) {
  return openUploadQueueDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readonly');
    const req = tx.objectStore(UPLOAD_QUEUE_STORE).get(cardId);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  })).catch(() => null);
}

function uploadQueueCount() {
  return openUploadQueueDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(UPLOAD_QUEUE_STORE, 'readonly');
    const req = tx.objectStore(UPLOAD_QUEUE_STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  })).catch(() => 0);
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
    if (typeof updateDriveUploadButton === 'function') updateDriveUploadButton();
    return true;
  } catch (err) {
    console.error('アップロード待機列への保存に失敗', err);
    if (typeof debugLog === 'function') debugLog(`待機列への保存に失敗: ${err && err.message ? err.message : err}`);
    return false;
  }
}

/**
 * @returns {Promise<boolean>} このエントリを待機列から消してよいか(=アップロードが実際に
 *   成功したか、またはカード自体が既に削除済みで送りようがないか)。
 *   **2026年9月の重大な不具合修正**: 以前はuploadCardFileInBackground()の成功/失敗に
 *   関わらず無条件でuploadQueueDelete()していたため、アクセストークン切れ等で一時的に
 *   アップロードが失敗しただけでも、待機中の実データ(Blob)がIndexedDBから消えてしまい、
 *   現地で撮った写真が二度と復元できなくなる事故があった。失敗時は消さずに残し、次回の
 *   「☁ Driveへ送信」ボタン押下で再試行できるようにする。
 */
// カードがまだ見つからない場合に、それが「本当に削除された」のか「作成直後でオートセーブ
// (デバウンス)がまだDriveに反映されていないだけ」なのかを区別できないため、この猶予時間内は
// 待機列から消さずに次回のドレインで再確認する(2026年9月、精査で発見)。
const UPLOAD_QUEUE_ORPHAN_GRACE_MS = 10 * 60 * 1000; // 10分

async function uploadQueuedEntry(entry, signal) {
  const card = typeof getCardById === 'function' ? getCardById(entry.cardId) : null;
  if (!card) {
    if (Date.now() - (entry.createdAt || 0) < UPLOAD_QUEUE_ORPHAN_GRACE_MS) {
      // まだ判断を保留する(削除もアップロードもしない)。カードがscheduleAutoSave()の
      // デバウンス中にタブが閉じられた等で、まだDrive側のJSONに存在しないだけの可能性がある。
      return false;
    }
    // 猶予時間を過ぎても見つからない=本当に削除されたとみなし、紐付け先の無いファイルを破棄する。
    await uploadQueueDelete(entry.cardId).catch(() => {});
    return true;
  }
  const ok = await uploadCardFileInBackground(card, entry.blob, entry.filename, signal);
  if (ok) await uploadQueueDelete(entry.cardId).catch(() => {});
  return ok;
}

/** アップロード状況一覧(js/app.jsのopenUploadStatusList()、2026年9月追加)の「この1件を
 *  送信」ボタン用。待機列全体をドレインせず、指定した1件だけをuploadQueuedEntry()に通す
 *  (成功/失敗時の待機列からの削除ルールも自動的に揃う)。 */
async function uploadSingleQueuedEntry(cardId) {
  const entries = await uploadQueueGetAll();
  const entry = entries.find((e) => e.cardId === cardId);
  if (!entry) return false;
  return uploadQueuedEntry(entry);
}

/** 設定モーダルの「☁ Driveへ送信」ボタンを押した時だけ呼ばれる、待機列の一括アップロード。
 *  **通信種別の自動判定は行わない**(2026年9月に撤去)。ユーザーが明示的に押した時にだけ、
 *  今ある分を全部送ろうとする。失敗したエントリは待機列に残り続けるため、1周しても1件も
 *  減らなければ(=全滅)、同じ失敗(トークン切れ等)を無限に繰り返さないようそこで打ち切る。
 *  もう一度ボタンを押せば再挑戦できる。
 *  **途中停止(2026年9月追加)**: モバイル回線のままうっかり押してしまった時のため、
 *  cancelDriveUpload()が呼ばれたらAbortControllerで進行中のfetch()自体を中断し、
 *  そのバッチが終わり次第すぐループを抜ける({cancelled:true}を返す)。中断された
 *  エントリはuploadCardFileInBackground()側で「失敗」ではなく「待機列に残ったまま」に
 *  戻すので、後でもう一度押せば続きから再開できる。 */
async function drainUploadQueue() {
  if (uploadQueueDraining) return { attempted: 0, remaining: 0, cancelled: false };
  uploadQueueDraining = true;
  uploadAbortController = new AbortController();
  const signal = uploadAbortController.signal;
  try {
    let entries = await uploadQueueGetAll();
    const startCount = entries.length;
    if (typeof debugLog === 'function') debugLog(`Driveへ送信を開始(${entries.length}件)`);
    while (entries.length > 0) {
      if (signal.aborted) {
        if (typeof debugLog === 'function') debugLog(`Driveへの送信: ユーザーにより停止(残り${entries.length}件)`);
        return { attempted: startCount, remaining: entries.length, cancelled: true };
      }
      const batch = entries.slice(0, UPLOAD_QUEUE_CONCURRENCY);
      await Promise.all(batch.map((e) => uploadQueuedEntry(e, signal)));
      if (typeof updateDriveUploadButton === 'function') updateDriveUploadButton();
      const nextEntries = await uploadQueueGetAll();
      if (signal.aborted) {
        if (typeof debugLog === 'function') debugLog(`Driveへの送信: ユーザーにより停止(残り${nextEntries.length}件)`);
        return { attempted: startCount, remaining: nextEntries.length, cancelled: true };
      }
      if (nextEntries.length >= entries.length) {
        // 進捗なし(全滅)。無限リトライを避けて打ち切る(個々の失敗理由はuploadCardFileInBackground()側でdebugLog済み)。
        if (typeof debugLog === 'function') debugLog(`Driveへの送信: 進捗なし(残り${nextEntries.length}件)のため打ち切り`);
        return { attempted: startCount, remaining: nextEntries.length, cancelled: false };
      }
      entries = nextEntries;
    }
    return { attempted: startCount, remaining: 0, cancelled: false };
  } catch (err) {
    console.error('アップロード待機列の処理に失敗', err);
    if (typeof debugLog === 'function') debugLog(`アップロード待機列の処理に失敗: ${err && err.message ? err.message : err}`);
    return { attempted: 0, remaining: -1, cancelled: false };
  } finally {
    uploadQueueDraining = false;
    uploadAbortController = null;
  }
}

/** 設定モーダルのボタンが「■ 停止」に切り替わっている間に押された時に呼ぶ。進行中の
 *  fetch()を即座に中断する(バッチの残りメンバーがあれば、それらも同じsignalで中断される)。
 *  ドレインが動いていない時に呼んでも何も起きない(安全なno-op)。 */
function cancelDriveUpload() {
  if (uploadAbortController) uploadAbortController.abort();
}

/* ---------------- 端末の「写真」アプリ等へのコピー保存(2026年9月追加) ---------------- */
//
// 「アプリ(Drive)だけにデータを預けるのは怖い」というユーザー要望への対応。撮影のたびに
// 毎回二重保存するのではなく、まだDriveに送っていない(=待機列にしか実データが無い)写真・
// 動画・音声だけを対象に、ユーザーが好きなタイミングでまとめて端末側(写真アプリ・ファイル
// アプリ等)へも逃がせるようにする。
//
// iOS SafariにはWebページからユーザー操作なしで写真ライブラリへ書き込むAPIが存在しないため、
// Web Share API(navigator.share)で共有シートを開き、ユーザー自身に保存先(写真/ファイル等)を
// 選んでもらう方式にした。これはIndexedDBの待機列やDrive上のデータには一切触れない、あくまで
// 保険用のコピーを増やすだけの機能(Driveへのアップロード成功/失敗判定・待機列からの削除ロジック
// とは独立)。
//
// **2026年9月、音声も対象に追加**: 当初は画像・動画のみだったが、「写真アプリに保存」という
// 名目に引きずられて音声カードが対象から漏れていた。音声も現地でしか録れない一次データである
// 点は写真・動画と変わらないため、共有シート経由(保存先はファイルアプリ等になる)で対象に含めた。
const DEVICE_EXPORTABLE_MEDIA_TYPES = ['image', 'video', 'audio'];

function isDeviceExportableEntry(entry) {
  return DEVICE_EXPORTABLE_MEDIA_TYPES.includes(entry.mediaType);
}

/** まだ端末(写真アプリ等)へコピーしていないか(2026年9月追加)。**重大な表示バグの修正**:
 *  以前はこのチェックが無く、「📤 端末へ保存」ボタンの件数もexportPendingUploadsToPhotos()の
 *  対象も、Drive未送信の待機列に残っているかどうかだけで決めていた。Drive送信とは無関係な
 *  「端末へは既に保存済み」という状態(card.deviceSaved)を全く見ていなかったため、共有シートで
 *  端末保存に成功した直後でも、Driveへまだ送信していない限りボタンの件数が「(1件)」のまま
 *  減らないという実機報告があった(リロードしても変わらない、という状態異常に見える不具合)。 */
function isNotYetDeviceSaved(entry) {
  const card = typeof getCardById === 'function' ? getCardById(entry.cardId) : null;
  return !card || !card.deviceSaved;
}

/** ヘッダーのボタン表示更新用。端末保存がまだの待機件数を返す。 */
async function uploadQueuePhotoExportableCount() {
  try {
    const entries = await uploadQueueGetAll();
    return entries.filter(isDeviceExportableEntry).filter(isNotYetDeviceSaved).length;
  } catch (err) {
    return 0;
  }
}

function exportableBlobType(entry) {
  if (entry.blob.type) return entry.blob.type;
  if (entry.mediaType === 'video') return 'video/mp4';
  if (entry.mediaType === 'audio') return 'audio/webm';
  return 'image/jpeg';
}

/**
 * Drive未送信の写真・動画・音声を、端末標準の共有シート経由で保存する。
 * @returns {Promise<'shared'|'cancelled'|'unsupported'|'empty'|'error'>}
 */
async function exportPendingUploadsToPhotos() {
  let entries;
  try {
    // 既にdeviceSaved済みのものは除く(2026年9月追加。含めたままだと、まだDriveへ送信して
    // いない間はボタンを押すたびに同じ写真を毎回また共有シートに乗せて重複保存させてしまう)。
    entries = (await uploadQueueGetAll()).filter(isDeviceExportableEntry).filter(isNotYetDeviceSaved);
  } catch (err) {
    console.error('待機列の読み込みに失敗', err);
    return 'error';
  }
  if (entries.length === 0) return 'empty';

  if (!navigator.share || !navigator.canShare) return 'unsupported';

  const files = entries.map((entry, i) => {
    const name = entry.filename || `constellation-${entry.cardId || i}`;
    return new File([entry.blob], name, { type: exportableBlobType(entry) });
  });

  if (!navigator.canShare({ files })) return 'unsupported';

  try {
    await navigator.share({ files, title: 'CONSTELLATION - Drive未送信の写真・動画・音声' });
    // 共有シートの操作自体が成功で戻ってきた時点で「端末側へ保存できたはず」とみなし
    // (Web Share APIは個々のファイルで保存先を選んだかまでは教えてくれないため、既存の
    // 「保険用コピー」という位置づけ通りベストエフォートで扱う)、対象カードにdeviceSavedを
    // 立てて「📵 端末未保存」バッジを消す。待機列・Driveアップロード状態には一切触れない。
    entries.forEach((entry) => {
      const card = typeof getCardById === 'function' ? getCardById(entry.cardId) : null;
      if (!card) return;
      card.deviceSaved = true;
      const el = typeof cardElById === 'function' ? cardElById(card.id) : null;
      if (el && typeof updateCardStatusBadges === 'function') updateCardStatusBadges(el, card);
    });
    if (typeof scheduleAutoSave === 'function') scheduleAutoSave();
    return 'shared';
  } catch (err) {
    if (err && err.name === 'AbortError') return 'cancelled'; // ユーザーが共有シートを閉じただけ
    console.error('端末への共有に失敗', err);
    if (typeof debugLog === 'function') debugLog(`端末への共有に失敗: ${err && err.message ? err.message : err}`);
    return 'error';
  }
}

/**
 * 再読み込み直後、js/app.jsのonSignedIn()から1回呼ぶ。前回終了時に待機列へ残っていたぶんを
 * 表示上だけ拾い直す(**自動アップロードは一切行わない**、2026年9月に撤去)。
 * card.uploadQueuedが立っているのに実データが見つからない(別端末で作られた・ブラウザの
 * ストレージが消去された等)場合は、詰まったままにせず「アップロード失敗」扱いにして、
 * 少なくともユーザーが気づけるようにする。
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
        if (typeof updateCardStatusBadges === 'function') updateCardStatusBadges(el, card);
      }
    } else if (!card.uploadQueued && card.uploadPending && queuedCardIds.has(card.id)) {
      card.uploadQueued = true;
      const el = typeof cardElById === 'function' ? cardElById(card.id) : null;
      if (el) {
        el.classList.add('star-card--upload-queued');
        if (typeof updateCardStatusBadges === 'function') updateCardStatusBadges(el, card);
      }
    }
  });
  if (typeof updateDriveUploadButton === 'function') updateDriveUploadButton();
}
