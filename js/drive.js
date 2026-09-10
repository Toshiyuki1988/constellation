// Google Drive API v3 をブラウザから直接叩くラッパー。
// drive.file スコープのため、このアプリが作成したファイル/フォルダにのみアクセス可能。
//
// **アプリ側からDrive上の元画像・元ファイルを削除する関数は意図的に持たない(2026年9月)**。
// 以前は写真カードのExtract機能に「元画像を削除してテクストカードに変換」という選択肢があり、
// ゴミ箱を経由しない完全削除(files.delete)を呼んでいたが、確認ダイアログのOK/キャンセルの
// 意味が分かりにくかったせいで実機でユーザーが誤操作し、二度と戻せない写真を失う事故が
// あった。ユーザーから「アプリ側からDriveの元画像はいじらないで。バックアップなので」という
// 明確な方針が示されたため、削除用の関数(旧deleteFile())ごと撤去した。今後も同種の機能
// (元ファイルを消して何かに置き換える等)を作らないこと。ファイルを「使わなくする」場合は、
// カード側の参照(imageFileIdなど)を外すだけに留め、Drive上の実体には触れない。

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

async function driveFetch(path, options = {}) {
  const token = await ensureAccessToken();
  const res = await fetch(`${DRIVE_API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Drive API error ${res.status}: ${await res.text()}`);
  }
  return res;
}

/**
 * Googleアカウント全体のストレージ使用量を取得する(2026年9月追加、ヘッダーの容量表示用)。
 * `about.get`は`drive.file`スコープでも呼べる(ファイル一覧ではなくアカウント全体の集計情報
 * であるため、drive.fileの「このアプリが作成したファイルにしか触れない」制約の対象外)。
 * `usage`はGoogleアカウント全体(Gmail・フォト等も含む)の合計、`usageInDrive`はDriveのみ。
 * Google Workspaceの無制限プラン等では`limit`が返らないことがある。
 */
async function getDriveStorageQuota() {
  const res = await driveFetch('/about?fields=storageQuota');
  const data = await res.json();
  return data.storageQuota || {};
}

/** "Constellation" フォルダを探し、なければ作成してIDを返す */
async function findOrCreateAppFolder() {
  const q = encodeURIComponent(
    `name='${CONFIG.APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const res = await driveFetch(`/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const { files } = await res.json();
  if (files && files.length > 0) return files[0].id;

  const createRes = await driveFetch('/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: CONFIG.APP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  const created = await createRes.json();
  return created.id;
}

/** 指定した親フォルダの直下から、名前が一致するサブフォルダを探し、無ければ作成してIDを返す */
async function findOrCreateSubfolder(name, parentId) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const res = await driveFetch(`/files?q=${q}&fields=files(id,name)&spaces=drive`);
  const { files } = await res.json();
  if (files && files.length > 0) return files[0].id;

  const createRes = await driveFetch('/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  const created = await createRes.json();
  return created.id;
}

/** Drive上のフォルダの表示名を変更する(セッション名編集にDrive側のフォルダ名を追従させる用途) */
async function renameDriveFolder(folderId, newName) {
  await driveFetch(`/files/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
}

async function findDataFile(folderId) {
  const q = encodeURIComponent(
    `name='${CONFIG.DATA_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const res = await driveFetch(`/files?q=${q}&fields=files(id,name)`);
  const { files } = await res.json();
  return files && files[0] ? files[0].id : null;
}

/** @returns {Promise<{fileId: string|null, data: {cards: any[], sessions: any[]}}>} */
async function loadData(folderId) {
  const fileId = await findDataFile(folderId);
  if (!fileId) return { fileId: null, data: { cards: [], sessions: [] } };
  const res = await driveFetch(`/files/${fileId}?alt=media`);
  const data = await res.json();
  return { fileId, data };
}

/**
 * データJSONを作成 or 上書き保存する。
 * @returns {Promise<string>} 保存後のファイルID
 */
async function saveData(folderId, fileId, data) {
  const token = await ensureAccessToken();
  const metadata = fileId
    ? { name: CONFIG.DATA_FILE_NAME }
    : { name: CONFIG.DATA_FILE_NAME, parents: [folderId] };

  const boundary = 'constellation-boundary';
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(data)}\r\n` +
    `--${boundary}--`;

  const url = fileId
    ? `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=multipart`
    : `${DRIVE_UPLOAD_API}/files?uploadType=multipart`;

  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Drive save error ${res.status}: ${await res.text()}`);
  const saved = await res.json();
  return saved.id;
}

/** ファイル(画像・動画・音声)をフォルダにアップロードし、そのファイルIDを返す。
 *  @param {AbortSignal} [signal] 渡すと、進行中のアップロードを外部から中断できる
 *    (js/upload-queue.jsのcancelDriveUpload()、モバイル回線のまま誤って送信ボタンを
 *    押してしまった場合に、通信量を無駄にしないよう即座に止められるようにするため)。 */
async function uploadFile(folderId, blob, filename, signal) {
  const token = await ensureAccessToken();
  const metadata = { name: filename, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal,
  });
  if (!res.ok) throw new Error(`Drive upload error ${res.status}: ${await res.text()}`);
  const created = await res.json();
  return created.id;
}

/** 既存ファイルを別のフォルダへ移動する(旧フラット構造→新しい入れ子フォルダ構造への移行用) */
async function moveFile(fileId, newParentId) {
  const res = await driveFetch(`/files/${fileId}?fields=parents`);
  const { parents } = await res.json();
  const params = new URLSearchParams({ addParents: newParentId });
  if (parents && parents.length > 0) params.set('removeParents', parents.join(','));
  await driveFetch(`/files/${fileId}?${params}`, { method: 'PATCH' });
}

/**
 * ファイルを認証付きで取得し、表示用の blob URL を返す。
 * (drive.file のファイルは既定で非公開のため、Authorization ヘッダ付きで取得する)
 */
async function fetchFileBlobUrl(fileId) {
  const res = await driveFetch(`/files/${fileId}?alt=media`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
