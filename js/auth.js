// Google Identity Services (GIS) を使ったブラウザ完結の OAuth。
// バックエンドを持たないため、リフレッシュトークンは使わず
// アクセストークン(有効期限 約1時間)をその都度取得し直す方式。

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

/**
 * @param {(token: string) => void} onSignedIn サインイン成功時に呼ばれる
 */
function initAuth(onSignedIn) {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: CONFIG.DRIVE_SCOPES,
    callback: (response) => {
      if (response.error) {
        console.error('OAuth error:', response);
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + response.expires_in * 1000;
      onSignedIn(accessToken);
    },
  });
}

/** サインインボタンから呼ぶ。同意画面が必要な場合のみ表示される。 */
function signIn() {
  if (!tokenClient) {
    setStatus('読み込み中です。少し待ってからもう一度お試しください');
    return;
  }
  tokenClient.requestAccessToken({ prompt: '' });
}

/** サインアウト(トークンを失効させる) */
function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
}

/**
 * 有効なアクセストークンを返す。期限切れ間近なら黙って再取得する。
 * @returns {Promise<string>}
 */
function ensureAccessToken() {
  const stillValid = accessToken && Date.now() < tokenExpiresAt - 60_000;
  if (stillValid) return Promise.resolve(accessToken);

  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(`OAuth再取得に失敗: ${response.error}`));
        return;
      }
      accessToken = response.access_token;
      tokenExpiresAt = Date.now() + response.expires_in * 1000;
      resolve(accessToken);
    };
    // 既に同意済みなら通常ダイアログなしで再取得できる
    tokenClient.requestAccessToken({ prompt: '' });
  });
}
