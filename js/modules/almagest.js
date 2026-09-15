// CONSTELLATION — Module: Almagest
//
// 全セッション横断の個人書庫。美術手帖のような難解な文章をOCR/貼り付けで書物として蓄え、
// Boy(やさしく)/Professor(学術的)の口調でGeminiに噛み砕かせたり、後からキーワードで
// 検索して読み返したりできる。CLAUDE.mdの「モジュール」規約に従い、このファイル全体を
// IIFEで包んでトップレベルの名前をグローバルへ漏らさない。state / els / viewportState /
// applyViewportTransform() / scheduleAutoSave() / renderCard() / redrawAsterismLines() /
// activeSessionId() / newCardSpawnPos() / generateThumbnail() / openCamera() /
// createTextCard() / showChoiceDialog() / escapeHtml() / renderAllCards() /
// setStatus() / cardElById() / EDIT_GUIDE_HANDLES_HTML / editGuideHexHtml() /
// summarizeAlmagestText()(js/gemini.js) などの既存グローバルは直接参照する。
//
// 起動: js/module-launcher.js経由、コード"159"(洛書の対角線、123/456/789/147/258/369で
// 埋まった残り2枠のうち採用した方。357はまだ空き)。
//
// 【設計(2026年9月確定、CLAUDE.md参照)】
//   - 位置づけ: セッション=展覧会の記録(一次体験)。Almagest=全セッション横断の個人書庫
//     (Crewsと同格の独立モジュール、フルスクリーンオーバーレイでCrews Constellationと同じ扱い)。
//     「読んで噛み砕く」までに留め、v1ではCrewsにコメントさせる機能は入れない。
//   - 登録は3経路: OCR撮影・貼り付け(どちらも「本」、全文をbodyTextとして保持、本棚で
//     分厚い背表紙、タップで読書ビュー+要約対象)。URL(「しおり」、本文を持たない、本棚では
//     薄いしおり形状、タップで読書ビューを開かずそのまま外部URLを新規タブで開くだけの単純な
//     ブックマーク)。URLのタイトルは自動取得せず手入力、faviconだけGoogle favicon APIで
//     クライアント側だけで取得する(CORSでの本文取得・Geminiのurl_context/google_searchの
//     429リスクを避けるため、インフォメーションカードと同じ「手入力フォールバックが主」の
//     設計に倒した)。
//   - 要約は読書ビュー内のボタンからBoy/Professorの口調でGeminiを1回呼ぶだけ(検索
//     グラウンディング等は使わない)。結果はentry.summaries.easy/academicとしてキャッシュし、
//     再度開いた時はAPIを呼ばず表示する(ボタンを押すたびに上書き再生成もできる)。
//   - サムネイルは新規登録パネルの任意欄(タップでファイル選択、または画像ペースト)。設定した
//     本は本棚で背表紙ではなく表紙(画像全面+下部にタイトルを黒フェードで重ねる)表示になる。
//   - 検索はキーワードのみ、タイトル・本文・タグの文字列一致をクライアント側で行う(API不使用)。
//     タグは自動抽出せず自由入力の手打ち(カンマ区切り)。
//   - セッションのキャンバスへは複製せず「参照」としてカード(mediaType:'book')を置ける
//     (card.almagestEntryIdで参照するだけ)。しおりは本棚の常設📌ボタンから、本は読書ビュー内の
//     「📌このセッションに置く」ボタンから。押すとAlmagestを抜けて、その場でカードが生まれる
//     (元の書庫エントリは消えない)。**設計メモは「しおりはホバーで出る📌ボタン」としていたが、
//     このアプリの主要利用環境はスマホ(タッチ)でhoverが発火しないため、常時表示の小さな
//     ボタンに変更した(CLAUDE.md「セッションへの入室手段」の教訓と同じ判断: 確実に押せる
//     手段を優先する)。**
//   - カードの見た目は本体アプリの白カード意匠に、Almagestの金色アクセントヘッダーだけ乗せる
//     (Crewsのテクストカードが水色グラスモーフで出自を示すのと同じ作法)。編集ガイドは
//     ASTR・Depth・Delete・「📖 Almagest」(元エントリの読書ビューへジャンプ)のみ。
//     元エントリが削除されていても、カード自体は残り「(書庫から削除されました)」と表示する
//     (Driveの元ファイルと同じく、参照が壊れてもカード自体は勝手に消さない)。
//   - Asterismの自動(見た順)線・collectSessionTextContext()からの扱いは、Info/Summary/
//     Comment等の既存の「連動生成/参照カード」と同様に決めた: 自動線からは除外、
//     テキスト文脈への混ぜ込みはタイトル+本文冒頭のスニペットのみ(全文は混ぜない)。
//
// 統合ポイント(js/app.js側):
//   - editGuideHexHtml('book') が本モジュール専用のヘックス構成を返す。
//   - renderCard()のisBookCard分岐が window.almagestBookCardInnerHtml() を呼ぶ
//     (Star Pencilのimaginaryカードと同じ「統合ポイントは薄いフックのみ」パターン)。
//   - hexクリックディスパッチャの action==='almagest' が window.jumpToAlmagestEntry() を呼ぶ。
//   - collectSessionTextContext() が window.getAlmagestEntryById() で参照先のタイトル・
//     本文冒頭を要約文脈に混ぜ込む(出典番号つき)。
//   - redrawAsterismLines() がbookカードを見た順の自動線から除外する。
//   - onSignedIn() が state.almagestEntries を読み込む、collectSaveData() が保存する。

(function () {
  'use strict';

  let alEls = null; // 本棚(シェルフ)オーバーレイ
  let rdEls = null; // 読書ビューオーバーレイ
  let stylesInjected = false;

  let searchQuery = '';
  let readingEntryId = null; // 読書ビューで開いている本のid
  let newEntryKind = 'book'; // 新規登録フォームのタブ状態。'book'|'url'
  let newEntryUsedOcr = false; // 今開いているフォームでOCRを使ったか(kind='ocr'|'paste'の判定用)
  let newEntryThumbDataUrl = null; // 新規登録フォームで設定したサムネイル(book限定)

  /* ---------------- データアクセス(app.js側からwindow経由で参照される) ---------------- */

  function getEntries() {
    return state.almagestEntries || (state.almagestEntries = []);
  }

  function getAlmagestEntryById(id) {
    if (!id) return null;
    return getEntries().find((e) => e.id === id) || null;
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname;
    } catch (err) {
      return 'URL';
    }
  }

  function parseTags(raw) {
    return (raw || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  function byCreatedDesc(a, b) {
    return new Date(b.createdAt) - new Date(a.createdAt);
  }

  function escapeAttrLocal(str) {
    return escapeHtml(str || '').replace(/"/g, '&quot;');
  }

  /* ---------------- スタイル注入 ---------------- */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .al-overlay {
        position: fixed; inset: 0; z-index: 150;
        display: flex; flex-direction: column;
        background: #0a0704;
        opacity: 0; pointer-events: none;
        transform: scale(0.98);
        transition: opacity 0.22s ease-out, transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1);
      }
      .al-overlay.open { opacity: 1; pointer-events: auto; }
      .al-topbar {
        display: flex; align-items: center; gap: 10px; padding: 12px 16px; flex: none;
        background: rgba(20, 16, 8, 0.9); border-bottom: 1px solid rgba(201, 162, 39, 0.32);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      }
      .al-topbar-label {
        flex: 1; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 13px; color: #f1e4bd;
      }
      .al-close {
        width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(201, 162, 39, 0.4); color: rgba(255, 255, 255, 0.85);
        font-size: 12px; cursor: pointer;
      }
      .al-close:hover { background: rgba(201, 162, 39, 0.25); }

      .al-toolbar { display: flex; gap: 8px; padding: 10px 16px; flex: none; }
      .al-search-input {
        flex: 1; min-width: 0; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px; padding: 8px 11px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; color: #fff;
      }
      .al-search-input::placeholder { color: rgba(255, 255, 255, 0.35); }
      .al-new-toggle-btn {
        flex: none; padding: 8px 14px; border-radius: 8px; border: 1px solid rgba(201, 162, 39, 0.5);
        background: rgba(201, 162, 39, 0.14); color: #f1e4bd; font-family: 'Zen Kaku Gothic New', sans-serif;
        font-weight: 700; font-size: 12px; cursor: pointer; white-space: nowrap;
      }
      .al-new-toggle-btn:hover { background: rgba(201, 162, 39, 0.28); }

      .al-new-panel {
        margin: 0 16px 12px; padding: 13px 13px 15px; flex: none;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(201, 162, 39, 0.28); border-radius: 12px;
        /* フォームが縦に長い(サムネイル+本文+タグ等)ため、ソフトキーボード表示で実効的な
           画面高さが縮む携帯端末でも保存ボタンまで必ず辿り着けるよう、パネル自身にも
           独立したスクロール上限を持たせる(2026年9月)。 */
        max-height: 58vh; overflow-y: auto;
      }
      .al-new-kind-tabs { display: flex; gap: 6px; margin-bottom: 12px; }
      .al-new-kind-tab {
        flex: 1; padding: 7px 8px; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04); color: rgba(255, 255, 255, 0.6);
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; font-weight: 700; cursor: pointer;
      }
      .al-new-kind-tab.active { background: rgba(201, 162, 39, 0.22); border-color: rgba(201, 162, 39, 0.55); color: #f1e4bd; }
      .al-field { margin-bottom: 11px; }
      .al-field:last-child { margin-bottom: 0; }
      .al-field-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
      .al-field label, .al-field-label-row label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
      }
      .al-field input, .al-field textarea {
        width: 100%; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px;
        padding: 7px 9px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; color: #fff; line-height: 1.6;
      }
      .al-field input::placeholder, .al-field textarea::placeholder { color: rgba(255, 255, 255, 0.3); }
      .al-new-body-input { min-height: 96px; resize: vertical; }
      .al-new-ocr-btn {
        width: 24px; height: 24px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(201, 162, 39, 0.16); border: 1px solid rgba(201, 162, 39, 0.5); color: #f1e4bd; cursor: pointer; font-size: 12px;
      }
      .al-new-ocr-btn:hover { background: rgba(201, 162, 39, 0.3); }
      .al-new-ocr-btn:disabled { opacity: 0.5; cursor: default; }
      .al-new-thumb-box {
        width: 100%; height: 84px; border-radius: 8px; background: rgba(255, 255, 255, 0.04);
        border: 1px dashed rgba(255, 255, 255, 0.2); display: flex; align-items: center; justify-content: center;
        color: rgba(255, 255, 255, 0.35); cursor: pointer; overflow: hidden;
      }
      .al-new-thumb-hint { font-size: 10.5px; line-height: 1.5; text-align: center; }
      .al-new-thumb-img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .al-new-save-btn {
        width: 100%; margin-top: 13px; padding: 9px 14px; border-radius: 8px; border: none;
        background: #c9a227; color: #241c05; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 12.5px;
        cursor: pointer;
      }
      .al-new-save-btn:hover { background: #ddb843; }

      .al-shelf { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 16px 24px; }
      .al-section-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase;
        color: rgba(201, 162, 39, 0.75); margin: 16px 0 10px;
      }
      .al-empty {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; color: rgba(255, 255, 255, 0.4);
        line-height: 1.8; padding: 10px 2px;
      }

      .al-books { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
      .al-book {
        position: relative; cursor: pointer;
        width: 56px; height: 132px; border-radius: 4px 7px 7px 4px;
        background: linear-gradient(160deg, #35290f, #1c1608);
        border: 1px solid rgba(201, 162, 39, 0.45);
        box-shadow: 2px 3px 8px rgba(0, 0, 0, 0.4), inset -7px 0 12px -8px rgba(0, 0, 0, 0.6);
        display: flex; align-items: center; justify-content: center; padding: 8px 4px;
        transition: transform 0.12s ease;
      }
      .al-book:hover { transform: translateY(-4px); }
      .al-book-spine-title {
        writing-mode: vertical-rl; text-orientation: mixed;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; font-weight: 700; color: #e8d9a8;
        line-height: 1.45; max-height: 114px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .al-book--cover {
        width: 100px; height: 140px; background-size: cover; background-position: center;
        align-items: flex-end; justify-content: stretch; padding: 0;
      }
      .al-book-title-overlay {
        display: block; width: 100%; padding: 22px 8px 8px; box-sizing: border-box;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.85), transparent);
        color: #fff; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 10.5px; font-weight: 700; line-height: 1.35;
      }

      .al-bookmarks { display: flex; flex-direction: column; gap: 6px; }
      .al-bookmark {
        position: relative; display: flex; align-items: center; gap: 8px; padding: 8px 34px 8px 10px; cursor: pointer;
        background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.09); border-left: 3px solid #c9a227;
        border-radius: 0 8px 8px 0;
      }
      .al-bookmark:hover { background: rgba(255, 255, 255, 0.07); }
      .al-bookmark-favicon { width: 16px; height: 16px; flex: none; border-radius: 3px; }
      .al-bookmark-title {
        flex: 1; min-width: 0; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11.5px; color: #fff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .al-bookmark-pin {
        position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
        width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(201, 162, 39, 0.5);
        background: rgba(201, 162, 39, 0.16); color: #f1e4bd; font-size: 11px; cursor: pointer; padding: 0;
      }
      .al-bookmark-pin:hover { background: rgba(201, 162, 39, 0.32); }

      /* ---------------- 読書ビュー(本を開いた時の別階層オーバーレイ) ---------------- */
      .al-read-overlay {
        position: fixed; inset: 0; z-index: 155;
        display: flex; flex-direction: column;
        background: #0a0704;
        opacity: 0; pointer-events: none;
        transform: scale(0.98);
        transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.1);
      }
      .al-read-overlay.open { opacity: 1; pointer-events: auto; }
      .al-read-topbar {
        display: flex; align-items: center; gap: 9px; padding: 12px 16px; flex: none;
        background: rgba(20, 16, 8, 0.9); border-bottom: 1px solid rgba(201, 162, 39, 0.32);
      }
      .al-read-icon { font-size: 15px; flex: none; }
      .al-read-title {
        flex: 1; min-width: 0; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 13.5px; color: #f1e4bd;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .al-read-close {
        width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(201, 162, 39, 0.4); color: rgba(255, 255, 255, 0.85);
        font-size: 12px; cursor: pointer;
      }
      .al-read-close:hover { background: rgba(201, 162, 39, 0.25); }

      .al-read-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
      .al-read-cover { width: 100%; max-height: 220px; object-fit: cover; border-radius: 10px; margin-bottom: 14px; display: block; }
      .al-read-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
      .al-read-tag {
        padding: 3px 10px; border-radius: 999px; background: rgba(201, 162, 39, 0.14); border: 1px solid rgba(201, 162, 39, 0.4);
        color: #f1e4bd; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px;
      }
      .al-read-text {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 13px; line-height: 1.85; color: rgba(255, 255, 255, 0.9);
        white-space: pre-wrap; word-break: break-word; margin-bottom: 18px;
      }
      .al-read-summary-row { display: flex; gap: 8px; margin-bottom: 12px; }
      .al-read-summary-btn {
        flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(201, 162, 39, 0.4);
        background: rgba(201, 162, 39, 0.1); color: #f1e4bd; font-family: 'Zen Kaku Gothic New', sans-serif;
        font-weight: 700; font-size: 12px; cursor: pointer;
      }
      .al-read-summary-btn:hover:not(:disabled) { background: rgba(201, 162, 39, 0.24); }
      .al-read-summary-btn:disabled { opacity: 0.5; cursor: default; }
      .al-read-summary-box { display: flex; flex-direction: column; gap: 10px; }
      .al-read-summary-block {
        padding: 11px 12px; border-radius: 9px; background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .al-read-summary-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(201, 162, 39, 0.85); margin-bottom: 6px;
      }
      .al-read-summary-text { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; line-height: 1.75; color: rgba(255, 255, 255, 0.88); }

      .al-read-actions {
        display: flex; gap: 8px; padding: 11px 16px; flex: none;
        background: rgba(20, 16, 8, 0.9); border-top: 1px solid rgba(201, 162, 39, 0.22);
      }
      .al-read-pin-btn {
        flex: 1; padding: 9px 12px; border-radius: 8px; border: none; background: #c9a227; color: #241c05;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer;
      }
      .al-read-pin-btn:hover { background: #ddb843; }
      .al-read-delete-btn {
        padding: 9px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.18); background: transparent;
        color: rgba(255, 255, 255, 0.6); font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer;
      }
      .al-read-delete-btn:hover { border-color: #b3402b; color: #ff8a70; }
    `;
    document.head.appendChild(style);
  }

  /* ---------------- 本棚(シェルフ)オーバーレイ ---------------- */

  function buildShelfDom() {
    const overlay = document.createElement('div');
    overlay.className = 'al-overlay';
    overlay.innerHTML = `
      <div class="al-topbar">
        <span class="al-topbar-label">📚 Almagest — 個人書庫</span>
        <button class="al-close" title="閉じる">✕</button>
      </div>
      <div class="al-toolbar">
        <input type="text" class="al-search-input" placeholder="検索(タイトル・本文・タグ)">
        <button class="al-new-toggle-btn">＋ 登録</button>
      </div>
      <div class="al-new-panel" hidden>
        <div class="al-new-kind-tabs">
          <button type="button" class="al-new-kind-tab active" data-kind="book">📖 本(OCR/貼り付け)</button>
          <button type="button" class="al-new-kind-tab" data-kind="url">🔖 しおり(URL)</button>
        </div>
        <div data-kind-panel="book">
          <div class="al-field">
            <label>タイトル</label>
            <input type="text" class="al-new-title-input" placeholder="タイトル">
          </div>
          <div class="al-field">
            <label>サムネイル(任意)</label>
            <div class="al-new-thumb-box"><span class="al-new-thumb-hint">🖼️ クリックで選択<br>/貼り付け</span></div>
            <input type="file" accept="image/*" class="al-new-thumb-file" hidden>
          </div>
          <div class="al-field">
            <div class="al-field-label-row">
              <label>本文</label>
              <button type="button" class="al-new-ocr-btn" title="カメラでOCR読み取り">📷</button>
            </div>
            <textarea class="al-new-body-input" placeholder="本文を貼り付け、またはOCRで読み取る"></textarea>
          </div>
          <div class="al-field">
            <label>タグ(カンマ区切り・任意)</label>
            <input type="text" class="al-new-tags-input" placeholder="例: 現代美術, 陶芸">
          </div>
        </div>
        <div data-kind-panel="url" hidden>
          <div class="al-field">
            <label>タイトル</label>
            <input type="text" class="al-new-url-title-input" placeholder="タイトル(手入力)">
          </div>
          <div class="al-field">
            <label>URL</label>
            <input type="text" class="al-new-url-input" placeholder="https://...">
          </div>
          <div class="al-field">
            <label>タグ(カンマ区切り・任意)</label>
            <input type="text" class="al-new-url-tags-input" placeholder="例: 展覧会情報">
          </div>
        </div>
        <button type="button" class="al-new-save-btn">書庫に登録</button>
      </div>
      <div class="al-shelf">
        <p class="al-section-label">本</p>
        <div class="al-books"></div>
        <p class="al-section-label">しおり</p>
        <div class="al-bookmarks"></div>
        <p class="al-empty" hidden></p>
      </div>
    `;
    document.body.appendChild(overlay);

    alEls = {
      overlay,
      searchInput: overlay.querySelector('.al-search-input'),
      newToggleBtn: overlay.querySelector('.al-new-toggle-btn'),
      newPanel: overlay.querySelector('.al-new-panel'),
      newTitleInput: overlay.querySelector('.al-new-title-input'),
      newThumbBox: overlay.querySelector('.al-new-thumb-box'),
      newThumbFile: overlay.querySelector('.al-new-thumb-file'),
      newOcrBtn: overlay.querySelector('.al-new-ocr-btn'),
      newBodyInput: overlay.querySelector('.al-new-body-input'),
      newTagsInput: overlay.querySelector('.al-new-tags-input'),
      newUrlTitleInput: overlay.querySelector('.al-new-url-title-input'),
      newUrlInput: overlay.querySelector('.al-new-url-input'),
      newUrlTagsInput: overlay.querySelector('.al-new-url-tags-input'),
      newSaveBtn: overlay.querySelector('.al-new-save-btn'),
      booksEl: overlay.querySelector('.al-books'),
      bookmarksEl: overlay.querySelector('.al-bookmarks'),
      emptyEl: overlay.querySelector('.al-empty'),
    };

    // スマホでパネル内の操作がキャンバス側のジェスチャー判定・背景タップ閉じと紛れないよう、
    // 入力/ボタン類は一律pointerdownをstopPropagationする(Crews等の既存モジュールと同じ作法)。
    overlay.querySelectorAll('input, textarea, button').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    overlay.querySelector('.al-close').addEventListener('click', (e) => { e.stopPropagation(); closeAlmagest(); });
    // このオーバーレイはCrews Constellationと同様、topbar/toolbar/shelfが縦に積み重なって
    // 画面を隙間なく覆うフルスクリーン構成のため、「背景をタップしたら閉じる」が機能する
    // 露出した背景領域が存在しない(attachBackgroundTapToClose()は使わない、CLAUDE.mdの
    // 既存の整理と同じ判断)。閉じる手段は✕ボタン・スワイプ・Escキーの3通りに統一する。

    alEls.searchInput.addEventListener('input', () => {
      searchQuery = alEls.searchInput.value;
      renderShelf();
    });

    alEls.newToggleBtn.addEventListener('click', () => {
      const willOpen = alEls.newPanel.hidden;
      alEls.newPanel.hidden = !willOpen;
      if (willOpen) resetNewPanel();
    });

    overlay.querySelectorAll('.al-new-kind-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        newEntryKind = tab.dataset.kind;
        overlay.querySelectorAll('.al-new-kind-tab').forEach((t) => t.classList.toggle('active', t === tab));
        overlay.querySelectorAll('[data-kind-panel]').forEach((p) => { p.hidden = p.dataset.kindPanel !== newEntryKind; });
      });
    });

    alEls.newThumbBox.addEventListener('click', () => alEls.newThumbFile.click());
    alEls.newThumbFile.addEventListener('change', async () => {
      const file = alEls.newThumbFile.files && alEls.newThumbFile.files[0];
      alEls.newThumbFile.value = '';
      if (file) await applyDraftThumbBlob(file);
    });
    // クリップボードからの画像ペースト(book欄が開いている時だけ、Crews Constellationの
    // 写真カードと同じパターン)。画像アイテムが無ければ通常のテキスト貼り付けに譲る。
    overlay.addEventListener('paste', async (e) => {
      if (alEls.newPanel.hidden || newEntryKind !== 'book') return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (blob) await applyDraftThumbBlob(blob);
    });

    alEls.newOcrBtn.addEventListener('click', () => handleOcrIntoDraft(alEls.newOcrBtn));
    alEls.newSaveBtn.addEventListener('click', handleSaveNewEntry);

    // 本(タップで読書ビュー)・しおり(タップで新規タブ、📌で配置)は再描画のたびに要素が
    // 差し替わるため、個別バインドではなくコンテナへのイベント委譲にする。
    alEls.booksEl.addEventListener('click', (e) => {
      const item = e.target.closest('[data-book-id]');
      if (item) openReadingView(item.dataset.bookId);
    });
    alEls.bookmarksEl.addEventListener('click', (e) => {
      const pinBtn = e.target.closest('[data-pin-id]');
      if (pinBtn) { placeEntryOnCanvas(pinBtn.dataset.pinId); return; }
      const item = e.target.closest('[data-mark-id]');
      if (!item) return;
      const entry = getAlmagestEntryById(item.dataset.markId);
      if (entry && entry.url) window.open(entry.url, '_blank', 'noopener');
    });

    // スワイプで閉じる(モジュール共通デザイン言語)。トップバーから始まった場合だけ判定する。
    let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
    overlay.querySelector('.al-topbar').addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX; swipeStartY = e.clientY; swipeStartT = performance.now();
    });
    overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX, dy = e.clientY - swipeStartY, dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeAlmagest();
    });
  }

  function resetNewPanel() {
    newEntryKind = 'book';
    newEntryUsedOcr = false;
    newEntryThumbDataUrl = null;
    alEls.newTitleInput.value = '';
    alEls.newBodyInput.value = '';
    alEls.newTagsInput.value = '';
    alEls.newUrlTitleInput.value = '';
    alEls.newUrlInput.value = '';
    alEls.newUrlTagsInput.value = '';
    renderDraftThumbBox();
    alEls.overlay.querySelectorAll('.al-new-kind-tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === 'book'));
    alEls.overlay.querySelectorAll('[data-kind-panel]').forEach((p) => { p.hidden = p.dataset.kindPanel !== 'book'; });
  }

  function renderDraftThumbBox() {
    if (!alEls) return;
    alEls.newThumbBox.innerHTML = newEntryThumbDataUrl
      ? `<img class="al-new-thumb-img" src="${escapeAttrLocal(newEntryThumbDataUrl)}" alt="">`
      : '<span class="al-new-thumb-hint">🖼️ クリックで選択<br>/貼り付け</span>';
  }

  async function applyDraftThumbBlob(blob) {
    const dataUrl = await generateThumbnail(blob, 360, 0.75);
    if (!dataUrl) return;
    newEntryThumbDataUrl = dataUrl;
    renderDraftThumbBox();
  }

  /** OCRで本文欄へ追記する(js/camera.jsを流用、js/modules/crews.jsのocrIntoTextarea()と同じ
   *  パターン)。バックグラウンド実行のため、結果が届く頃にはこのパネル自体が既に閉じられている
   *  可能性がある。その場合は読み取った文字を失わないよう新規テクストカードとして残す。 */
  async function handleOcrIntoDraft(btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const result = await openCamera('caption');
      if (!result || result.kind !== 'text' || !result.text.trim()) return;
      if (!alEls.newBodyInput.isConnected || alEls.newPanel.hidden) {
        createTextCard(result.text.trim());
        setStatus('Almagestのフォームが閉じられていたため、読み取った文字は新しいテクストカードに残しました');
        return;
      }
      newEntryUsedOcr = true;
      const existing = alEls.newBodyInput.value.trim();
      alEls.newBodyInput.value = existing ? `${existing}\n${result.text.trim()}` : result.text.trim();
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  function handleSaveNewEntry() {
    if (newEntryKind === 'book') {
      const title = alEls.newTitleInput.value.trim();
      const bodyText = alEls.newBodyInput.value.trim();
      if (!title || !bodyText) {
        setStatus('タイトルと本文を入力してください', { important: true });
        return;
      }
      const entry = {
        id: crypto.randomUUID(),
        kind: newEntryUsedOcr ? 'ocr' : 'paste',
        title,
        sourceLabel: newEntryUsedOcr ? 'OCR' : '貼り付け',
        bodyText,
        url: null,
        thumbDataUrl: newEntryThumbDataUrl || null,
        tags: parseTags(alEls.newTagsInput.value),
        summaries: { easy: null, academic: null },
        createdAt: new Date().toISOString(),
      };
      getEntries().push(entry);
    } else {
      const title = alEls.newUrlTitleInput.value.trim();
      const url = alEls.newUrlInput.value.trim();
      if (!title || !url) {
        setStatus('タイトルとURLを入力してください', { important: true });
        return;
      }
      const entry = {
        id: crypto.randomUUID(),
        kind: 'url',
        title,
        sourceLabel: hostnameOf(url),
        bodyText: null,
        url,
        thumbDataUrl: null,
        tags: parseTags(alEls.newUrlTagsInput.value),
        summaries: { easy: null, academic: null },
        createdAt: new Date().toISOString(),
      };
      getEntries().push(entry);
    }
    scheduleAutoSave();
    alEls.newPanel.hidden = true;
    renderShelf();
    setStatus('書庫に登録しました');
  }

  function matchesSearch(entry, q) {
    if (!q) return true;
    const hay = [entry.title, entry.bodyText, (entry.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function bookSpineHtml(entry) {
    const hasCover = Boolean(entry.thumbDataUrl);
    if (hasCover) {
      return (
        `<div class="al-book al-book--cover" data-book-id="${entry.id}" style="background-image:url('${escapeAttrLocal(entry.thumbDataUrl)}')">` +
        `<span class="al-book-title-overlay">${escapeHtml(entry.title || '(無題)')}</span></div>`
      );
    }
    return (
      `<div class="al-book" data-book-id="${entry.id}">` +
      `<span class="al-book-spine-title">${escapeHtml(entry.title || '(無題)')}</span></div>`
    );
  }

  function bookmarkRowHtml(entry) {
    const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostnameOf(entry.url))}`;
    return `
      <div class="al-bookmark" data-mark-id="${entry.id}">
        <img class="al-bookmark-favicon" src="${escapeAttrLocal(favicon)}" alt="">
        <span class="al-bookmark-title">${escapeHtml(entry.title || '(無題)')}</span>
        <button type="button" class="al-bookmark-pin" data-pin-id="${entry.id}" title="このセッションに置く">📌</button>
      </div>
    `;
  }

  function renderShelf() {
    const totalCount = getEntries().length;
    const q = searchQuery.trim();
    const filtered = getEntries().filter((e) => matchesSearch(e, q));
    const books = filtered.filter((e) => e.kind !== 'url').sort(byCreatedDesc);
    const marks = filtered.filter((e) => e.kind === 'url').sort(byCreatedDesc);
    alEls.booksEl.innerHTML = books.map(bookSpineHtml).join('');
    alEls.bookmarksEl.innerHTML = marks.map(bookmarkRowHtml).join('');
    alEls.emptyEl.hidden = filtered.length > 0;
    alEls.emptyEl.textContent = totalCount === 0
      ? 'まだ何も登録されていません。「＋ 登録」から書庫を育てましょう。'
      : '検索条件に一致するものがありません。';
  }

  function openAlmagest() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!alEls) buildShelfDom();
    searchQuery = '';
    alEls.searchInput.value = '';
    alEls.newPanel.hidden = true;
    renderShelf();
    alEls.overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeAlmagest() {
    closeReadingView();
    if (alEls) alEls.overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /* ---------------- 読書ビュー ---------------- */

  function buildReadingDom() {
    const overlay = document.createElement('div');
    overlay.className = 'al-read-overlay';
    overlay.innerHTML = `
      <div class="al-read-topbar">
        <span class="al-read-icon">📖</span>
        <span class="al-read-title"></span>
        <button class="al-read-close" title="閉じる">✕</button>
      </div>
      <div class="al-read-body">
        <img class="al-read-cover" hidden>
        <div class="al-read-tags"></div>
        <div class="al-read-text"></div>
        <div class="al-read-summary-row">
          <button type="button" class="al-read-summary-btn" data-mode="education">👦 Boy</button>
          <button type="button" class="al-read-summary-btn" data-mode="academic">🎓 Professor</button>
        </div>
        <div class="al-read-summary-box"></div>
      </div>
      <div class="al-read-actions">
        <button type="button" class="al-read-pin-btn">📌 このセッションに置く</button>
        <button type="button" class="al-read-delete-btn">🗑 削除</button>
      </div>
    `;
    document.body.appendChild(overlay);

    rdEls = {
      overlay,
      title: overlay.querySelector('.al-read-title'),
      cover: overlay.querySelector('.al-read-cover'),
      tags: overlay.querySelector('.al-read-tags'),
      text: overlay.querySelector('.al-read-text'),
      summaryBox: overlay.querySelector('.al-read-summary-box'),
      pinBtn: overlay.querySelector('.al-read-pin-btn'),
      deleteBtn: overlay.querySelector('.al-read-delete-btn'),
    };

    overlay.querySelectorAll('input, textarea, button').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    overlay.querySelector('.al-read-close').addEventListener('click', (e) => { e.stopPropagation(); closeReadingView(); });
    // 本棚オーバーレイと同じ理由(topbar/body/actionsが隙間なく画面を覆うフルスクリーン構成)で
    // attachBackgroundTapToClose()は使わない。✕ボタン・スワイプ・Escキーで閉じる。

    overlay.querySelectorAll('.al-read-summary-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleSummarize(btn.dataset.mode, btn));
    });
    rdEls.pinBtn.addEventListener('click', () => placeEntryOnCanvas(readingEntryId));
    rdEls.deleteBtn.addEventListener('click', handleDeleteEntry);

    let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
    overlay.querySelector('.al-read-topbar').addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX; swipeStartY = e.clientY; swipeStartT = performance.now();
    });
    overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX, dy = e.clientY - swipeStartY, dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeReadingView();
    });
  }

  function renderReadingSummaries(entry) {
    const parts = [];
    if (entry.summaries && entry.summaries.easy) {
      parts.push(`<div class="al-read-summary-block"><div class="al-read-summary-label">👦 Boy</div><div class="al-read-summary-text">${escapeHtml(entry.summaries.easy)}</div></div>`);
    }
    if (entry.summaries && entry.summaries.academic) {
      parts.push(`<div class="al-read-summary-block"><div class="al-read-summary-label">🎓 Professor</div><div class="al-read-summary-text">${escapeHtml(entry.summaries.academic)}</div></div>`);
    }
    rdEls.summaryBox.innerHTML = parts.join('');
  }

  function openReadingView(entryId) {
    const entry = getAlmagestEntryById(entryId);
    if (!entry) {
      setStatus('この本は見つかりませんでした', { important: true });
      return;
    }
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!rdEls) buildReadingDom();
    readingEntryId = entryId;
    rdEls.title.textContent = entry.title || '(無題)';
    if (entry.thumbDataUrl) {
      rdEls.cover.src = entry.thumbDataUrl;
      rdEls.cover.hidden = false;
    } else {
      rdEls.cover.hidden = true;
    }
    rdEls.tags.innerHTML = (entry.tags || []).map((t) => `<span class="al-read-tag">${escapeHtml(t)}</span>`).join('');
    rdEls.text.textContent = entry.bodyText || '';
    renderReadingSummaries(entry);
    rdEls.overlay.classList.add('open');
  }

  function closeReadingView() {
    readingEntryId = null;
    if (rdEls) rdEls.overlay.classList.remove('open');
  }

  async function handleSummarize(mode, btnEl) {
    const entry = getAlmagestEntryById(readingEntryId);
    if (!entry || !entry.bodyText) return;
    if (btnEl) btnEl.disabled = true;
    setStatus(`${mode === 'education' ? 'Boy' : 'Professor'}が要約を考え中…`, { busy: true });
    try {
      const text = await summarizeAlmagestText({ text: entry.bodyText, mode });
      entry.summaries = entry.summaries || {};
      if (mode === 'education') entry.summaries.easy = text; else entry.summaries.academic = text;
      scheduleAutoSave();
      renderReadingSummaries(entry);
      setStatus('要約しました');
    } catch (err) {
      console.error(err);
      setStatus(`要約に失敗しました: ${err.message}`, { important: true });
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function handleDeleteEntry() {
    const entry = getAlmagestEntryById(readingEntryId);
    if (!entry) return;
    const choice = await showChoiceDialog({
      title: `「${entry.title || '(無題)'}」を書庫から削除しますか?`,
      message: 'このセッションに置いた参照カードは残りますが、参照先が無いことを示す表示になります。',
      options: [
        { label: 'このまま残す', value: 'keep', secondary: true },
        { label: '削除する', value: 'delete', danger: true },
      ],
    });
    if (choice !== 'delete') return;
    state.almagestEntries = getEntries().filter((e) => e.id !== entry.id);
    scheduleAutoSave();
    closeReadingView();
    renderShelf();
    renderAllCards(); // 参照カードの表示を「削除済み」の見た目へ更新する
    setStatus('書庫から削除しました');
  }

  /* ---------------- セッションのキャンバスへの配置(橋渡し機能) ---------------- */

  /** 書庫エントリを複製せず「参照」として、現在のセッションのキャンバスへカード
   *  (mediaType:'book')として置く。押すとAlmagestを抜けて、その場でカードが生まれる
   *  (jumpToInfoCard()と同じ、パン+一瞬の発光で着地位置を示す演出)。 */
  function placeEntryOnCanvas(entryId) {
    const entry = getAlmagestEntryById(entryId);
    if (!entry) return;
    const spawnPos = newCardSpawnPos();
    const card = {
      id: crypto.randomUUID(),
      mediaType: 'book',
      almagestEntryId: entryId,
      x: spawnPos.x,
      y: spawnPos.y,
      width: 170,
      height: 150,
      sessionId: activeSessionId(),
      createdAt: new Date().toISOString(),
    };
    state.cards.push(card);
    renderCard(card);
    redrawAsterismLines();
    scheduleAutoSave();
    closeAlmagest();
    setStatus('このセッションに置きました');
    requestAnimationFrame(() => {
      const el = cardElById(card.id);
      if (!el) return;
      const rect = els.viewport.getBoundingClientRect();
      els.content.classList.add('canvas-content--animated');
      viewportState.x = rect.width / 2 - (card.x + card.width / 2) * viewportState.scale;
      viewportState.y = rect.height / 2 - (card.y + card.height / 2) * viewportState.scale;
      applyViewportTransform();
      setTimeout(() => els.content.classList.remove('canvas-content--animated'), 400);
      el.classList.add('star-card--landed');
      setTimeout(() => el.classList.remove('star-card--landed'), 1600);
    });
  }

  /** 写真カードの編集ガイド「📖 Almagest」から呼ばれる: 元の書庫エントリの読書ビューへ
   *  ジャンプする。参照先が削除済みならその旨を知らせるだけ(js/app.jsのhexクリック
   *  ディスパッチャからwindow経由で呼ばれる、Astrometry Scope/Star Pencilと同じ薄い統合)。 */
  function jumpToAlmagestEntry(entryId) {
    if (!getAlmagestEntryById(entryId)) {
      setStatus('この参照先は書庫から削除されています', { important: true });
      return;
    }
    openAlmagest();
    openReadingView(entryId);
  }

  /* ---------------- カードのHTML生成(js/app.jsのrenderCard()から薄いフック経由で呼ばれる) ---------------- */

  function almagestBookCardInnerHtml(card) {
    const entry = getAlmagestEntryById(card.almagestEntryId);
    if (!entry) {
      return (
        '<div class="star-card-book-head"><span class="star-card-book-icon">📖</span><span class="star-card-book-label">Almagest</span></div>' +
        '<p class="star-card-book-missing">(書庫から削除されました)</p>' +
        EDIT_GUIDE_HANDLES_HTML + editGuideHexHtml('book')
      );
    }
    const coverHtml = entry.thumbDataUrl ? `<img class="star-card-book-cover" src="${escapeAttrLocal(entry.thumbDataUrl)}" alt="">` : '';
    return (
      `<div class="star-card-book-head"><span class="star-card-book-icon">${entry.kind === 'url' ? '🔖' : '📖'}</span><span class="star-card-book-label">Almagest</span></div>` +
      coverHtml +
      `<div class="star-card-book-title">${escapeHtml(entry.title || '(無題)')}</div>` +
      EDIT_GUIDE_HANDLES_HTML + editGuideHexHtml('book')
    );
  }

  // Escキーで閉じる(モジュール共通デザイン言語)。読書ビューが開いていればそちらを先に
  // 閉じ、本棚だけが開いていれば本棚ごと閉じる(Crews Constellationと同じ考え方)。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (rdEls && rdEls.overlay.classList.contains('open')) { closeReadingView(); return; }
    if (alEls && alEls.overlay.classList.contains('open')) closeAlmagest();
  });

  registerModuleCode('159', openAlmagest);
  window.getAlmagestEntryById = getAlmagestEntryById;
  window.almagestBookCardInnerHtml = almagestBookCardInnerHtml;
  window.jumpToAlmagestEntry = jumpToAlmagestEntry;
  window.openAlmagest = openAlmagest;
})();
