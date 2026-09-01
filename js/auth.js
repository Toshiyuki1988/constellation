// Google Identity Services (GIS) を使ったブラウザ完結の OAuth。
// バックエンドを持たないため、リフレッシュトークンは使わず
// アクセストークン(有効期限 約1時間)をその都度取得し直す方式。

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

/**
 * @param {(token: string) => void} onSignedIn サインイン成功時に呼ばれる
 * @param {(error: string) => void} [onSignInFailed] サイレント取得に失敗した時に呼ばれる(未同意・未ログインなど)
 */
function initAuth(onSignedIn, onSignInFailed) {
  debugLog('initAuth() 開始, client_id先頭=' + String(CONFIG.GOOGLE_CLIENT_ID).slice(0, 12) + '...');
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      scope: CONFIG.DRIVE_SCOPES,
      callback: (response) => {
        debugLog('OAuthコールバック受信, error=' + (response && response.error));
        if (response.error) {
          console.error('OAuth error:', response);
          if (onSignInFailed) onSignInFailed(response.error);
          return;
        }
        accessToken = response.access_token;
        tokenExpiresAt = Date.now() + response.expires_in * 1000;
        onSignedIn(accessToken);
      },
    });
    debugLog('initTokenClient 成功, tokenClient=' + (tokenClient ? 'set' : 'null'));
  } catch (err) {
    debugLog('initTokenClient 例外: ' + err);
    console.error(err);
  }
}

/**
 * サインイン(トークン取得)を試みる。既に同意済み・ログイン中ならポップアップなしで完了する。
 * @param {boolean} [silent] true の場合、失敗してもエラー表示をtokenClient任せにする(起動時の自動試行用)
 */
function signIn(silent) {
  debugLog('signIn() 呼び出し, tokenClient=' + (tokenClient ? 'set' : 'null') + ', silent=' + !!silent);
  if (!tokenClient) {
    if (!silent) setStatus('読み込み中です。少し待ってからもう一度お試しください');
    return;
  }
  try {
    tokenClient.requestAccessToken({ prompt: '' });
    debugLog('requestAccessToken 呼び出し完了');
  } catch (err) {
    debugLog('requestAccessToken 例外: ' + err);
    console.error(err);
  }
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
