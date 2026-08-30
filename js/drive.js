// Google Drive API v3 をブラウザから直接叩くラッパー。
// drive.file スコープのため、このアプリが作成したファイル/フォルダにのみアクセス可能。

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

async function findDataFile(folderId) {
  const q = encodeURIComponent(
    `name='${CONFIG.DATA_FILE_NAME}' and '${folderId}' in parents and trashed=false`
  );
  const res = await driveFetch(`/files?q=${q}&fields=files(id,name)`);
  const { files } = await res.json();
  return files && files[0] ? files[0].id : null;
}

/** @returns {Promise<{fileId: string|null, data: {cards: any[]}}>} */
async function loadData(folderId) {
  const fileId = await findDataFile(folderId);
  if (!fileId) return { fileId: null, data: { cards: [] } };
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

/** 画像ファイルをフォルダにアップロードし、そのファイルIDを返す */
async function uploadImage(folderId, blob, filename) {
  const token = await ensureAccessToken();
  const metadata = { name: filename, parents: [folderId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);

  const res = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Drive upload error ${res.status}: ${await res.text()}`);
  const created = await res.json();
  return created.id;
}

/**
 * 画像を認証付きで取得し、表示用の blob URL を返す。
 * (drive.file のファイルは既定で非公開のため、Authorization ヘッダ付きで取得する)
 */
async function fetchImageBlobUrl(fileId) {
  const res = await driveFetch(`/files/${fileId}?alt=media`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
