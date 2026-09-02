# CONSTELLATION

美術鑑賞記録アプリ。GitHub Pages(静的サイト)+ ブラウザ完結の Google Drive API / Gemini API で、
バックエンドなし・完全無料で動かす構成。

## 構成

| 役割 | 技術 |
|---|---|
| ホスティング | GitHub Pages(プロジェクトサイト) |
| キャンバス操作 | interact.js(ドラッグ・リサイズ・ピンチズーム) |
| データ保存 | Google Drive API v3(ブラウザから直接、OAuth) |
| OCR / AIガイド | Gemini API(ブラウザから直接、APIキー) |
| 展覧会カレンダー同期 | Google Calendar API v3(ブラウザから直接、OAuth) |

## ファイル構成

```
constellation/
├── index.html
├── css/style.css
├── js/
│   ├── config.js   … アプリの既定設定(秘密情報は含まない。詳細は下記)
│   ├── auth.js      … Google Identity Services によるOAuth
│   ├── drive.js      … Drive API v3 ラッパー
│   ├── calendar.js    … Calendar API v3 ラッパー(展覧会カレンダー同期)
│   ├── gemini.js      … Gemini API ラッパー
│   ├── canvas.js       … interact.js によるキャンバス操作
│   └── app.js          … 画面のエントリーポイント
└── README.md
```

データは各ユーザー自身の Google Drive のマイドライブ直下に作成される
`Constellation` フォルダに、`constellation-data.json`(カードの位置・メモ等)と
アップロードした画像ファイルとして保存されます(`drive.file` スコープ = このアプリが
作成したファイルにのみアクセス可能)。

インフォメーションカードで解析した展覧会の「鑑賞可能日」は、`展覧会`という名前の
専用Googleカレンダー(このアプリが自動で新規作成する二次カレンダー)に、開廊日の
まとまりごとの終日イベントとして反映されます(`calendar.app.created` スコープ =
このアプリが作成したカレンダーにのみアクセス可能。既存の他のカレンダーは見えません)。
同期はこのアプリを開いて情報を解析/修正した瞬間だけ行われ、常時バックグラウンドで
同期し続けるものではありません。

## OAuthクライアントID・APIキーの扱いについて

このリポジトリはPublicで公開する前提のため、`js/config.js` にはOAuthクライアントIDや
Gemini APIキーを一切書き込みません。かわりにデプロイ後のサイトを開くと「初期設定」
ダイアログが表示され、そこで入力した値は**そのブラウザの `localStorage` にのみ**保存
されます(サーバーを持たないため、これが唯一の保存先です)。GitHubには残らず、
他人のブラウザにも共有されません。値はツールバー右上の「⚙ 設定」からいつでも
変更できます。

---

## セットアップ手順

### 1. Google Cloud プロジェクトの作成

1. https://console.cloud.google.com/ を開く
2. 上部のプロジェクト選択 → 「新しいプロジェクト」→ 適当な名前(例: `constellation-app`)で作成

### 2. 必要なAPIを有効化

「APIとサービス」→「ライブラリ」から以下を検索して有効化:

- **Google Drive API**
- **Generative Language API**(Gemini API)
- **Google Calendar API**

### 3. OAuth同意画面の設定

「APIとサービス」→「OAuth同意画面」

1. User Type は **外部** を選択
2. アプリ名(例: `CONSTELLATION`)、サポートメール(自分のメールアドレス)を入力
3. スコープの追加は不要(コード側でリクエストするため)
4. テストユーザーに **自分のGoogleアカウント**(このアプリを使うアカウント)を追加
5. 公開ステータスは **「テスト」のままでOK**
   - このアプリは Google Identity Services の「トークンフロー」(暗黙的フロー)を使うため
     リフレッシュトークンを発行しません。「テストモードはリフレッシュトークンが7日で失効する」
     という制限が実質的に関係なく、毎回アクセストークン(有効期限約1時間)を取得し直すだけです。
   - 「確認されていないアプリ」という警告画面が出ますが、自分のアプリなので
     「詳細」→「(アプリ名)に移動」で進めば問題ありません。

### 4. OAuthクライアントIDの作成(Drive用)

「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuthクライアントID」

1. アプリケーションの種類: **ウェブアプリケーション**
2. 名前: 任意(例: `constellation-web`)
3. **承認済みのJavaScript生成元** に以下を追加
   - `https://<あなたのGitHubユーザー名>.github.io`
     - ※プロジェクトサイト(`https://<user>.github.io/constellation/`)でも、
       生成元は **スキーム+ホストのみ**(パスなし)を登録します
   - ローカルで動作確認する場合は `http://localhost:5500` のような開発用オリジンも追加
     (使用するローカルサーバーのポート番号に合わせる)
4. 作成すると表示される **クライアントID** をコピーしておく(手順7でサイト上の設定ダイアログに貼り付けます)

### 5. APIキー(Auth Key)の作成(Gemini用)

**2026年6月〜9月の移行により、Gemini APIキーは Google Cloud Console の「認証情報」画面
ではなく、Google AI Studio で発行する「Auth Key」形式が標準になりました。**
(Cloud Console側の認証情報作成で「Generative Language API」が選べないのはこのため。
旧来の Standard Key は2026年9月に完全に使えなくなります。)

1. https://aistudio.google.com/api-keys を開く(Cloud Consoleと同じGoogleアカウントでログイン)
2. 対象のプロジェクト(`CONSTELLATION`)を選択した状態で **「Create API key」** をクリック
3. 生成されたキーは自動的に **Auth Key** になります(Gemini APIに限定され、
   漏洩時の自動検知・停止機能つき)
4. 表示されたキーをコピーしておく(手順7でサイト上の設定ダイアログに貼り付けます)

**追加のHTTPリファラー制限(できる場合は設定推奨)**

1. https://console.cloud.google.com/apis/credentials を開く(先ほど作ったキーが
   一覧に表示されているか確認)
2. 表示されていれば、そのキーを開き **アプリケーションの制限 → HTTPリファラー(ウェブサイト)**
   に `https://<あなたのGitHubユーザー名>.github.io/*` を追加して保存
   - Auth Keyの管理はService Account経由に一本化されつつあり、Cloud Console側で
     この設定項目が出ない/グレーアウトしている場合は無理に設定しなくてOKです。
     その場合は次の「課金を有効化しない」対策が実質的な防御線になります。

> リファラー制限はブラウザ経由のリクエストに対する抑止であり、非ブラウザからの
> リクエストでは偽装され得ます。また、Google公式ドキュメントは
> 「クライアント側コードにAPIキーを直書きせず、バックエンドプロキシ経由にする」ことを
> 推奨していますが、本プロジェクトは「バックエンドなし・完全無料」を前提とするため、
> あえてブラウザから直接呼び出す構成を取っています。リスクを抑える現実的な対策は
> ①Auth Key化(自動検知・停止)②可能ならリファラー制限③次の手順(課金を有効化しない)
> の組み合わせです。

### 6. 課金を有効化しない(最重要)

「お支払い」(Billing)メニューを開き、**このプロジェクトに請求先アカウントが
リンクされていないこと** を確認してください。

- Gemini APIは無料枠があり、請求先アカウントをリンクしなければ無料枠を超えたリクエストは
  課金される代わりに単にエラー(429など)になります。これにより「絶対に無料」を機械的に保証できます。
- Google Drive APIの利用自体(リクエスト数)は無料です。ストレージ容量はユーザー本人の
  Googleアカウントの無料枠(15GB)を使用します。

### 7. GitHub Pagesへのデプロイ

`js/config.js` を編集する必要はありません(秘密情報は含まれていません)。

1. GitHubで `constellation` という名前のリポジトリを作成(Publicで問題ありません)
2. このフォルダの中身をpush
   ```bash
   git init
   git add .
   git commit -m "Initial scaffold"
   git branch -M main
   git remote add origin https://github.com/<あなたのユーザー名>/constellation.git
   git push -u origin main
   ```
3. リポジトリの「Settings」→「Pages」→ Source を **Deploy from a branch**、
   Branch を **main / (root)** に設定
4. しばらくすると `https://<あなたのユーザー名>.github.io/constellation/` で公開される

### 8. 初期設定と動作確認

1. 公開されたURLを開くと「初期設定」ダイアログが自動的に表示される
2. 手順4で取得した **クライアントID** と、手順5で取得した **Gemini APIキー** を入力して「保存」
   - このブラウザの `localStorage` にのみ保存されます(GitHubには残りません)
   - 後から値を変更したい場合はツールバーの「⚙ 設定」から再度開けます
3. 「Googleでサインイン」→ 自分のGoogleアカウントで同意
4. 「+ 作品を追加」で画像を選択 → Driveの `Constellation` フォルダにアップロードされ、
   Geminiがキャプション文字をタイトルとして自動抽出(失敗しても無視されるだけ)
5. カードをドラッグ・端をつまんでリサイズ、キャンバス背景をドラッグでパン、
   ピンチ(またはホイール)でズーム
6. 「保存」でDrive上の `constellation-data.json` に書き込み

`GEMINI_MODEL` (`js/config.js` 内)は無料枠対象モデルが変わることがあるため、
https://ai.google.dev/gemini-api/docs/models で最新の無料枠モデル名を確認してください。

---

## 今後の拡張ポイント

- カードのデータモデル(タグ、展覧会情報、評価など)を `js/app.js` の `card` オブジェクトに追加
- Gemini によるAIガイド(作品解説・鑑賞のヒント)は `askGemini()` を呼ぶUIを追加すれば流用可能
- ローカルテスト用に `npx serve` や VS Code の Live Server 拡張などで簡易サーバーを立てて確認可能
  (OAuth生成元にそのオリジンを追加しておくこと)
