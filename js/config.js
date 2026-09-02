// CONSTELLATION 設定ファイル
//
// OAuthクライアントID・Gemini APIキーはこのファイルにも、Gitリポジトリのどこにも
// 書き込まない。かわりに初回アクセス時に画面の「設定」ダイアログで入力してもらい、
// このブラウザの localStorage にのみ保存する(バックエンドを持たないため、
// ブラウザのローカルストレージが「秘密情報の置き場所」になる。他人のブラウザや
// GitHubリポジトリには一切残らない)。
//
// 値の取得方法は README.md の「セットアップ手順」を参照。

const CONFIG_STORAGE_KEYS = {
  clientId: 'constellation.googleClientId',
  apiKey: 'constellation.geminiApiKey',
};

const CONFIG = {
  // localStorageから読み込む(未設定なら空文字)
  GOOGLE_CLIENT_ID: localStorage.getItem(CONFIG_STORAGE_KEYS.clientId) || '',
  GEMINI_API_KEY: localStorage.getItem(CONFIG_STORAGE_KEYS.apiKey) || '',

  // 使用する Gemini モデル名。無料枠の対象モデルは変わることがあるため
  // https://ai.google.dev/gemini-api/docs/models で最新の無料枠対象モデル名を確認してください。
  // (2026-08: gemini-2.5-flash が新規利用不可になったため gemini-3.6-flash に変更)
  // (2026-09: gemini-3.6-flashの無料枠が「1日20リクエスト」しかなく、OCR中心の使い方と
  //  相性が悪いことが実機で判明。多少の精度低下と引き換えに無料枠が大きいgemini-3.5-flash-liteへ変更)
  GEMINI_MODEL: 'gemini-3.5-flash-lite',

  // OAuthスコープ。どちらも「アプリが作成したものだけ」にアクセスする
  // 非機微(non-sensitive寄り)スコープで統一している(ユーザーのDrive全体・既存カレンダー全体は見えない)。
  // - drive.file: アプリが作成/開いたファイルのみ
  // - calendar.app.created: アプリが作成した二次カレンダー(と、そのイベント)のみ
  OAUTH_SCOPES: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.app.created',

  // データの保存先フォルダ名(ユーザーのマイドライブ直下に作成される)
  APP_FOLDER_NAME: 'Constellation',

  // 全カード情報をまとめて保存する JSON ファイル名(APP_FOLDER_NAME直下、メディアとは別置き)
  DATA_FILE_NAME: 'constellation-data.json',

  // メディア(画像・動画・音声)を置くフォルダ名(APP_FOLDER_NAME直下)。
  // この下に「年セッション名/セッション名/.../ファイル」という入れ子構造でアップロードする。
  MEDIA_FOLDER_NAME: 'media',

  // インフォメーションカードの「鑑賞可能日」を同期する専用Googleカレンダーの名前
  EXHIBITION_CALENDAR_NAME: '展覧会',
};

/** クライアントIDとAPIキーが両方入力済みか */
function isConfigured() {
  return Boolean(CONFIG.GOOGLE_CLIENT_ID && CONFIG.GEMINI_API_KEY);
}

/** 設定ダイアログの保存ボタンから呼ぶ。localStorageに書き込み、CONFIGにも反映する。 */
function saveUserConfig({ clientId, apiKey }) {
  CONFIG.GOOGLE_CLIENT_ID = clientId.trim();
  CONFIG.GEMINI_API_KEY = apiKey.trim();
  localStorage.setItem(CONFIG_STORAGE_KEYS.clientId, CONFIG.GOOGLE_CLIENT_ID);
  localStorage.setItem(CONFIG_STORAGE_KEYS.apiKey, CONFIG.GEMINI_API_KEY);
}

/** 設定を消去する(別アカウントに切り替える場合など) */
function clearUserConfig() {
  CONFIG.GOOGLE_CLIENT_ID = '';
  CONFIG.GEMINI_API_KEY = '';
  localStorage.removeItem(CONFIG_STORAGE_KEYS.clientId);
  localStorage.removeItem(CONFIG_STORAGE_KEYS.apiKey);
}
