// CONSTELLATION — Module: Almagest
//
// 全セッション横断の個人書庫。美術手帖のような難解な文章をOCR/貼り付けで書物として蓄え、
// Boy(やさしく)/Professor(学術的)の口調でGeminiに噛み砕かせたり、後からキーワードで
// 検索して読み返したりできる。CLAUDE.mdの「モジュール」規約に従い、このファイル全体を
// IIFEで包んでトップレベルの名前をグローバルへ漏らさない。state / els / viewportState /
// applyViewportTransform() / scheduleAutoSave() / renderCard() / renderAllCards() /
// redrawAsterismLines() / activeSessionId() / newCardSpawnPos() / generateThumbnail() /
// openCamera() / createTextCard() / createBookChatCard() / showChoiceDialog() /
// escapeHtml() / setStatus() / cardElById() / EDIT_GUIDE_HANDLES_HTML / editGuideHexHtml() /
// summarizeAlmagestText()(js/gemini.js) / findFileByName・loadNamedData・saveNamedData
// (js/drive.js) / saveAlmagestLocalCache・loadAlmagestLocalCache(js/upload-queue.js) などの
// 既存グローバルは直接参照する。
//
// 起動: js/module-launcher.js経由、コード"159"(洛書の対角線、123/456/789/147/258/369で
// 埋まった残り2枠のうち採用した方。357はまだ空き)。
//
// 【設計(2026年9月確定、CLAUDE.md参照)】
//   - 位置づけ: セッション=展覧会の記録(一次体験)。Almagest=全セッション横断の個人書庫
//     (Crewsと同格の独立モジュール、フルスクリーンオーバーレイでCrews Constellationと同じ扱い)。
//   - 登録は3経路: OCR撮影・貼り付け(どちらも「本」、全文をbodyTextとして保持)。URL
//     (「しおり」、本文を持たない、タップすると読書ビューを開かず外部URLを新規タブで開く)。
//     URLのタイトルは自動取得せず手入力、faviconだけGoogle favicon APIで取得する。
//   - 要約は読書ビュー内のボタンからBoy/Professorの口調でGeminiを1回呼ぶだけ。結果は
//     entry.summaries.easy/academicとしてキャッシュする。
//
// 【2026年9月「大規模修繕」で追加・変更した点(ユーザー実機報告・要望への対応)】
//   1. **書庫データを専用のDriveファイル(almagest-library.json)へ分離した**。以前は
//      メインのconstellation-data.jsonへ埋め込んでいたため、オートセーブ既定OFF(通信量節約
//      のための既存方針、CLAUDE.md参照)の影響を受け、「登録した本が端末内にしか保存されず、
//      別端末(スマホ/PC)に同期されない・消えたように見える」という実機報告につながっていた。
//      Almagestの登録・削除・要約・編集は、この既定に関わらず**常に即座にDriveへ書き込む**
//      (saveAlmagestDataNow())。読み書きの失敗(オフライン等)に備え、js/upload-queue.jsの
//      almagestCache(IndexedDB)へも都度ミラーし、次回読み込み時に「端末側が新しければ
//      端末側を正としてDriveへ送り直す」比較を行う(updatedAtで比較、メイン側の
//      ローカルバックアップと同じ考え方)。本棚を開くたびにバックグラウンドで最新を
//      取りに行く(refreshAlmagestFromDriveInBackground())ため、他端末での変更もある程度
//      追従する。この仕組みが結果的に、非URLの本を(サインイン後・回線が不安定になった後も)
//      端末内キャッシュから読み続けられる、というオフライン耐性の土台にもなっている
//      (ただし「サインイン自体ができないほどの完全なオフライン状態からのアプリ起動」までは
//      サポートしない。このアプリはGoogle Identity Servicesでの都度のトークン取得を前提と
//      した構成であり、認証そのものをオフライン対応させることは範囲外とした)。
//   2. **本(OCR/貼り付け)としおり(URL)を同じ本棚に統合した**。以前は「本」の背表紙一覧と
//      「しおり」の細い行一覧が別セクションだったが、種別を問わず作成日時順の1つの棚に
//      並べる。タップした時の挙動は種別で分かれたまま: 本は読書ビューを開き、しおりは
//      「宇宙の書庫からデータを呼び出す」イメージの一瞬の発光演出(playSummonAnimation())を
//      見せつつ外部URLを新規タブで開く(ポップアップブロック対策のため、window.open()は
//      演出の前にクリックハンドラ内で同期的に呼ぶ)。しおりは背表紙の下部に📌/✎/🗑の
//      小さなアイコンを常設し、読書ビューを経由せずシェルフから直接ピン留め・編集・削除できる
//      ようにした。
//   3. **背表紙のタイトルを省略しない**。以前は`text-overflow:ellipsis`+`max-height`で
//      長いタイトルが見切れていた。背表紙(縦書き)は高さを内容に合わせて伸ばす方式に変え、
//      読書ビューのタイトルも折り返し表示にした。
//   4. **OCR本文の表示を読みやすく**: 保存されるbodyText自体は元のOCR結果のままだが、
//      表示時にだけ`reflowBodyTextHtml()`で「紙面の行送りによる単発の改行」を詰めて
//      連結し、長すぎる塊は句点で読みやすい段落に割り直す。表示パネルも黒背景+白文字から、
//      紙のような白背景+濃い文字色(`.al-read-text-panel`)に変更した。文字サイズは
//      A-/A+ボタンで調整でき、好みを端末のlocalStorageに保持する。
//   5. **「🗣 読書会をひらく」ボタン**をBoy/Professorの要約欄の下に追加した。座談会
//      (js/app.jsのcreateChatCard())と全く同じ仕組みのチャットカード(mediaType:'chat')を
//      現在のセッションへ生成する(createBookChatCard())。card.almagestEntryIdを持たせる
//      ことで、js/app.jsのfetchChatReply()がセッション文脈の代わりにこの本の内容
//      (buildAlmagestChatContext())を会話の文脈として使う。
//   6. **「出典元」欄(citation)を本の登録・編集フォームに追加した**(例:
//      「美術手帖 2024年9月号 p.34」)。登録方法(OCR/貼り付け、sourceLabel)とは別に、
//      引用元の書誌情報を自由記述で残せるようにした。
//   7. **登録後も本文・タイトル・出典元・タグ・サムネイルを編集できるようにした**
//      (読書ビューの✎ボタン、しおりはシェルフの✎アイコン)。
//
// 統合ポイント(js/app.js側):
//   - editGuideHexHtml('book') が本モジュール専用のヘックス構成を返す。
//   - renderCard()のisBookCard分岐が window.almagestBookCardInnerHtml() を呼ぶ
//     (Star Pencilのimaginaryカードと同じ「統合ポイントは薄いフックのみ」パターン)。
//   - hexクリックディスパッチャの action==='almagest' が window.jumpToAlmagestEntry() を呼ぶ。
//   - collectSessionTextContext() が window.getAlmagestEntryById() で参照先のタイトル・
//     本文冒頭を要約文脈に混ぜ込む(出典番号つき)。
//   - redrawAsterismLines() がbookカードを見た順の自動線から除外する。
//   - fetchChatReply()/chatCardInnerHtml() が card.almagestEntryId を見て、読書会チャット
//     カードの文脈・見出しを window.buildAlmagestChatContext()/window.getAlmagestEntryById()
//     経由で差し替える。
//   - onSignedIn() が window.initAlmagestData() を呼んで書庫データを読み込む(collectSaveData()
//     はメインJSONへはもう含めない)。

(function () {
  'use strict';

  let alEls = null; // 本棚(シェルフ)オーバーレイ
  let rdEls = null; // 読書ビューオーバーレイ
  let stylesInjected = false;

  let searchQuery = '';
  let activeTagFilter = null; // null='すべて'、'__unsummarized__'='未要約'、それ以外はタグ文字列
  let readingEntryId = null; // 読書ビューで開いている本のid
  let editingEntry = false; // 読書ビューが編集フォームを表示中か
  let editThumbDataUrl = null; // 編集フォームで選択中のサムネイル(book限定)
  let newEntryKind = 'book'; // 新規登録フォームのタブ状態。'book'|'url'
  let newEntryUsedOcr = false; // 今開いているフォームでOCRを使ったか(kind='ocr'|'paste'の判定用)
  let newEntryThumbDataUrl = null; // 新規登録フォームで設定したサムネイル(book限定)
  let almagestUpdatedAt = 0; // 最後に確定した(Driveへ送った、またはDriveから読んだ)書庫データの時刻
  // 書庫データの読み込み状況(2026年9月追加)。詳細はensureAlmagestDataLoaded()参照。
  let almagestDataLoaded = false;
  let almagestDataLoadPromise = null;

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

  /* ---------------- Driveとの同期(2026年9月追加、上記「大規模修繕」1参照) ---------------- */

  function almagestPayload() {
    return { entries: getEntries(), updatedAt: Date.now() };
  }

  /**
   * 書庫データを専用ファイル(almagest-library.json)へ即座に保存する。オートセーブの
   * ON/OFFトグルには一切従わない(常に送る)。失敗時・成功時ともIndexedDBへもミラーし、
   * 次回読み込み時の突き合わせに使う。
   * @returns {Promise<boolean>} Driveへの送信に成功したか
   */
  async function saveAlmagestDataNow() {
    const payload = almagestPayload();
    almagestUpdatedAt = payload.updatedAt;
    if (typeof saveAlmagestLocalCache === 'function') {
      await saveAlmagestLocalCache(payload).catch(() => {});
    }
    if (!state.folderId) return false;
    try {
      state.almagestFileId = await saveNamedData(state.folderId, state.almagestFileId, payload, CONFIG.ALMAGEST_FILE_NAME);
      return true;
    } catch (err) {
      console.error('Almagestの書庫データ保存に失敗', err);
      return false;
    }
  }

  /**
   * js/app.jsのloadMainData()(旧形式からの移行の安全網)、またはこのファイル自身の
   * ensureAlmagestDataLoaded()から呼ばれる。専用ファイルからの読み込み、端末に残っている
   * 未送信の変更との突き合わせ、旧形式(メインJSON埋め込み)からの一度きりの移行を行う。
   * @param {Array|undefined} legacyEntries 旧constellation-data.jsonのalmagestEntries(移行元)
   */
  async function initAlmagestData(legacyEntries) {
    let localCache = null;
    try {
      localCache = typeof loadAlmagestLocalCache === 'function' ? await loadAlmagestLocalCache() : null;
    } catch (err) {
      console.error('Almagestローカルキャッシュの確認に失敗', err);
    }
    if (!state.folderId) {
      state.almagestEntries = (localCache && localCache.entries) || legacyEntries || [];
      almagestUpdatedAt = (localCache && localCache.updatedAt) || 0;
      almagestDataLoaded = true;
      return;
    }
    try {
      const remote = await loadNamedData(state.folderId, CONFIG.ALMAGEST_FILE_NAME);
      if (remote.fileId) {
        state.almagestFileId = remote.fileId;
        const remoteData = remote.data || {};
        if (localCache && (localCache.updatedAt || 0) > (remoteData.updatedAt || 0)) {
          // 前回オフライン等でDriveへ送れなかった、端末内だけの新しい変更が残っている。
          state.almagestEntries = localCache.entries || [];
          almagestUpdatedAt = localCache.updatedAt;
          await saveAlmagestDataNow();
          setStatus('端末に残っていた書庫の未送信の変更をDriveへ反映しました', { important: true });
        } else {
          state.almagestEntries = remoteData.entries || [];
          almagestUpdatedAt = remoteData.updatedAt || 0;
          if (typeof saveAlmagestLocalCache === 'function') saveAlmagestLocalCache(remoteData).catch(() => {});
        }
      } else if (legacyEntries && legacyEntries.length) {
        // 一度きりの移行: 以前メインJSONへ埋め込んでいた分を専用ファイルへ引っ越す。
        state.almagestEntries = legacyEntries;
        await saveAlmagestDataNow();
        setStatus('書庫データを専用ファイルへ移行しました', { important: true });
      } else {
        state.almagestEntries = (localCache && localCache.entries) || [];
        almagestUpdatedAt = (localCache && localCache.updatedAt) || 0;
      }
    } catch (err) {
      console.error('Almagestデータの読み込みに失敗(オフラインの可能性があります)', err);
      state.almagestEntries = (localCache && localCache.entries) || legacyEntries || [];
      almagestUpdatedAt = (localCache && localCache.updatedAt) || 0;
      if (state.almagestEntries.length) {
        setStatus('オフラインのため書庫は端末キャッシュから表示しています', { important: true });
      }
    }
    almagestDataLoaded = true;
  }

  /**
   * 書庫データ(state.almagestEntries)がまだ読み込まれていなければ読み込む(2026年9月追加)。
   * **背景**: 以前はサインイン直後(onSignedIn()のフェーズ1)に毎回無条件でinitAlmagestData()を
   * 呼んでいたが、これはalmagest-library.json(サムネイル付きの本が多いとそれなりの容量になる)
   * を、ユーザーがAlmagestを開くかどうかに関わらず**必ず**ダウンロードすることを意味していた。
   * スタートメニュー導入後、クイックカメラ/クイックセッションを選ぶだけの場面でもこの通信が
   * 発生してしまい、「ログインからクイックメニュー表示までの待ち時間が長い」という実機報告が
   * あった。対応として、この読み込み自体をAlmagestを実際に開く瞬間(openAlmagest())まで
   * 遅延させ、onSignedIn()側からは呼ばなくした(js/app.jsのensureMainDataLoaded()と同じ
   * Promiseキャッシュの作法)。 */
  function ensureAlmagestDataLoaded() {
    if (almagestDataLoaded) return Promise.resolve();
    if (almagestDataLoadPromise) return almagestDataLoadPromise;
    almagestDataLoadPromise = initAlmagestData().finally(() => { almagestDataLoadPromise = null; });
    return almagestDataLoadPromise;
  }

  /**
   * 本棚を開くたびにバックグラウンドで最新を取りに行く。失敗しても(オフライン等)
   * 何もせず今の表示のまま続行する(=非URLの本のオフライン閲覧を妨げない)。
   */
  async function refreshAlmagestFromDriveInBackground() {
    if (!state.folderId) return;
    try {
      const remote = await loadNamedData(state.folderId, CONFIG.ALMAGEST_FILE_NAME);
      if (!remote.fileId || !remote.data) return;
      if ((remote.data.updatedAt || 0) <= almagestUpdatedAt) return; // 今の内容の方が新しい(未送信の変更中 等)
      state.almagestFileId = remote.fileId;
      state.almagestEntries = remote.data.entries || [];
      almagestUpdatedAt = remote.data.updatedAt || 0;
      if (typeof saveAlmagestLocalCache === 'function') saveAlmagestLocalCache(remote.data).catch(() => {});
      if (alEls && alEls.overlay.classList.contains('open')) renderShelf();
      if (rdEls && rdEls.overlay.classList.contains('open') && readingEntryId) {
        const entry = getAlmagestEntryById(readingEntryId);
        if (entry) renderReadingView(entry);
      }
    } catch (err) {
      console.warn('Almagestの最新データ取得に失敗(オフラインの可能性)', err);
    }
  }

  /** 「読書会」チャットカード(js/app.jsのcreateBookChatCard())が会話の文脈として使う、
   *  本の内容のテキスト表現。タイトル・出典元・本文全文・既存の要約(あれば)をまとめて返す。 */
  function buildAlmagestChatContext(entryId) {
    const entry = getAlmagestEntryById(entryId);
    if (!entry) return '(この書物は書庫から削除されています)';
    const parts = [`『${entry.title || '(無題)'}』`];
    if (entry.citation) parts.push(`出典: ${entry.citation}`);
    if (entry.bodyText) parts.push(entry.bodyText.trim());
    if (entry.summaries) {
      if (entry.summaries.easy) parts.push(`[やさしい要約]\n${entry.summaries.easy}`);
      if (entry.summaries.academic) parts.push(`[学術的な要約]\n${entry.summaries.academic}`);
    }
    return parts.join('\n\n');
  }

  /* ---------------- 表示用の本文整形・文字サイズ設定(2026年9月追加) ---------------- */

  /**
   * OCRで読み取った文章はハードな改行(紙面の行送りによるもの)を含むことが多く、そのまま
   * 表示すると不自然な位置で改行された壁のような文章になる。**保存されるbodyText自体は
   * 元のまま変更しない**(編集フォームでは常に生データを見せる)、表示専用の整形関数。
   *   1. 空行(2つ以上の連続する改行)で区切られた既存の段落はそのまま尊重する。
   *   2. 段落内の単発の改行(紙面の行送りによるもの)は詰めて連結する。
   *   3. 1つの段落が長すぎる場合は、句点(。/！/？)の後で読みやすい長さに区切り直す。
   */
  function reflowBodyTextHtml(raw) {
    const text = (raw || '').replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';
    const rawParagraphs = text.split(/\n{2,}/);
    const paragraphs = [];
    rawParagraphs.forEach((block) => {
      const joined = block.split('\n').map((l) => l.trim()).filter(Boolean).join('');
      if (!joined) return;
      if (joined.length <= 140) {
        paragraphs.push(joined);
        return;
      }
      const sentences = joined.match(/[^。！？]*[。！？]|[^。！？]+$/g) || [joined];
      let current = '';
      sentences.forEach((s) => {
        if (current && (current + s).length > 140) {
          paragraphs.push(current);
          current = s;
        } else {
          current += s;
        }
      });
      if (current) paragraphs.push(current);
    });
    return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }

  const READ_FONT_SIZE_KEY = 'constellation-almagest-font-size';
  const READ_FONT_SIZE_MIN = 12;
  const READ_FONT_SIZE_MAX = 22;
  const READ_FONT_SIZE_DEFAULT = 14;

  function loadReadFontSize() {
    try {
      const v = parseInt(localStorage.getItem(READ_FONT_SIZE_KEY), 10);
      if (!Number.isNaN(v) && v >= READ_FONT_SIZE_MIN && v <= READ_FONT_SIZE_MAX) return v;
    } catch (err) {
      // localStorageが使えない環境でも致命的ではない
    }
    return READ_FONT_SIZE_DEFAULT;
  }

  function saveReadFontSize(v) {
    try {
      localStorage.setItem(READ_FONT_SIZE_KEY, String(v));
    } catch (err) {
      // 無視(端末ローカルの好みが次回引き継がれないだけ)
    }
  }

  let readFontSize = loadReadFontSize();

  function applyReadingFontSize() {
    if (rdEls && rdEls.text) rdEls.text.style.fontSize = `${readFontSize}px`;
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

      /* タグ絞り込みチップ: 「すべて」「未要約」+登録済みタグの一覧。 */
      .al-tags { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 10px; flex: none; }
      .al-tag {
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.04em; padding: 4px 11px;
        border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.05);
        color: rgba(255, 255, 255, 0.55); cursor: pointer;
      }
      .al-tag.active {
        background: linear-gradient(155deg, #c9a227, #8a6d10); color: #241a06; border-color: transparent; font-weight: 700;
      }

      .al-new-panel {
        margin: 0 16px 12px; padding: 13px 13px 15px; flex: none;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(201, 162, 39, 0.28); border-radius: 12px;
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
        box-sizing: border-box;
        /* OCR結果は空白の無い長い英数字の並び(URL・型番等)を含むことがあり、それが原因で
           テキストエリアの外(ウィンドウの外)へ見切れる実機報告があった(2026年9月)ため、
           強制的に折り返す。 */
        overflow-wrap: anywhere; word-break: break-word;
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

      .al-shelf { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 16px 24px; }
      .al-empty {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; color: rgba(255, 255, 255, 0.4);
        line-height: 1.8; padding: 10px 2px;
      }

      /* 本棚: 本(OCR/貼り付け)としおり(URL)を同じ「ブック」として1つの棚に並べる
         (2026年9月、大規模修繕)。align-items:flex-endで、高さが不揃いな背表紙も
         本棚らしく下端が揃う。 */
      .al-shelf-items { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px; }
      .al-book {
        position: relative; cursor: pointer;
        width: 56px; height: auto; min-height: 132px; border-radius: 4px 7px 7px 4px;
        background: linear-gradient(160deg, #35290f, #1c1608);
        border: 1px solid rgba(201, 162, 39, 0.45);
        box-shadow: 2px 3px 8px rgba(0, 0, 0, 0.4), inset -7px 0 12px -8px rgba(0, 0, 0, 0.6);
        display: flex; align-items: center; justify-content: center; padding: 10px 4px;
        transition: transform 0.12s ease;
      }
      .al-book:hover { transform: translateY(-4px); }
      /* 出典の種類ごとに背表紙の色を変える: OCR=赤系、貼り付け=青系、しおり(URL)=金系。
         既定(.al-book)の金茶色より後に置いて上書きする。 */
      .al-book--ocr { background: linear-gradient(160deg, #6b3838, #3a1c1c); border-color: rgba(217, 140, 110, 0.5); }
      .al-book--paste { background: linear-gradient(160deg, #2f4a63, #17242f); border-color: rgba(120, 170, 217, 0.5); }
      .al-book--url { background: linear-gradient(160deg, #4a3f1f, #241f0f); border-color: rgba(201, 162, 39, 0.65); padding-bottom: 32px; }
      .al-book-badge { position: absolute; top: 6px; right: 6px; font-size: 10px; opacity: 0.85; }
      .al-book-spine-title {
        writing-mode: vertical-rl; text-orientation: mixed;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; font-weight: 700; color: #e8d9a8;
        line-height: 1.45; white-space: normal; overflow: visible; max-height: none; overflow-wrap: anywhere;
      }
      /* しおり(URL)の背表紙だけに常設する小さなアクション行(2026年9月追加)。本(OCR/貼り付け)は
         読書ビューを開いてから📌/✎/🗑を使うため、シェルフ上には持たせない(タップで即座に
         外部URLへ飛ぶしおりだけ、シェルフから直接操作できる必要があるための非対称)。 */
      .al-book-footer { position: absolute; left: 0; right: 0; bottom: 5px; display: flex; justify-content: center; gap: 4px; }
      .al-book-footer-btn {
        width: 16px; height: 16px; border-radius: 50%; border: none; padding: 0; font-size: 8px; line-height: 16px;
        background: rgba(255, 255, 255, 0.14); color: #f1e4bd; cursor: pointer;
      }
      .al-book-footer-btn:hover { background: rgba(201, 162, 39, 0.4); }
      .al-book-footer-btn--danger:hover { background: rgba(179, 64, 43, 0.4); color: #ff8a70; }
      .al-book--cover {
        width: 100px; height: auto; min-height: 140px; background-size: cover; background-position: center;
        align-items: flex-end; justify-content: stretch; padding: 0;
      }
      .al-book-cover-badge {
        position: absolute; top: 8px; left: 8px; font-size: 13px;
        filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.8));
      }
      .al-book-title-overlay {
        display: block; width: 100%; padding: 22px 8px 8px; box-sizing: border-box;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.85), transparent);
        color: #fff; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 10.5px; font-weight: 700; line-height: 1.35;
        overflow-wrap: anywhere;
      }
      .al-book-src {
        display: block; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; font-weight: 400;
        color: rgba(255, 255, 255, 0.65); margin-top: 3px;
      }

      /* 呼び出し演出(2026年9月追加): しおり(URL)をタップした瞬間、「宇宙の書庫から
         データを呼び出す」イメージの一瞬の発光リング。重くならないよう1回きりのCSS
         アニメーションで、終了後にDOMごと自動的に消える(常時ループするパルスは無し)。 */
      .al-summon-fx {
        position: fixed; z-index: 200; transform: translate(-50%, -50%); pointer-events: none;
        display: flex; flex-direction: column; align-items: center;
      }
      .al-summon-ring {
        width: 60px; height: 60px; border-radius: 50%;
        border: 2px solid rgba(201, 162, 39, 0.9);
        box-shadow: 0 0 18px 2px rgba(201, 162, 39, 0.6);
        animation: al-summon-expand 0.7s ease-out forwards;
      }
      .al-summon-ring--delay { position: absolute; animation-delay: 0.12s; }
      @keyframes al-summon-expand {
        0% { transform: scale(0.2); opacity: 1; }
        100% { transform: scale(2.6); opacity: 0; }
      }
      .al-summon-label {
        margin-top: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.08em;
        color: #f1e4bd; text-shadow: 0 0 8px rgba(201, 162, 39, 0.8); opacity: 0;
        animation: al-summon-label-fade 0.7s ease-out forwards;
      }
      @keyframes al-summon-label-fade {
        0% { opacity: 0; transform: translateY(4px); }
        30% { opacity: 1; transform: translateY(0); }
        100% { opacity: 0; }
      }

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
        white-space: normal; line-height: 1.4; overflow-wrap: anywhere;
      }
      .al-read-edit-btn, .al-read-close {
        width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(201, 162, 39, 0.4); color: rgba(255, 255, 255, 0.85);
        font-size: 12px; cursor: pointer;
      }
      .al-read-edit-btn:hover, .al-read-close:hover { background: rgba(201, 162, 39, 0.25); }
      .al-read-edit-btn.active { background: rgba(201, 162, 39, 0.4); color: #f1e4bd; }

      .al-read-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 16px; }
      .al-read-cover { width: 100%; max-height: 220px; object-fit: cover; border-radius: 10px; margin-bottom: 14px; display: block; }
      .al-read-src { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 255, 255, 0.4); margin-bottom: 4px; }
      .al-read-citation {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; font-style: italic;
        color: rgba(241, 228, 189, 0.75); margin-bottom: 8px;
      }
      .al-read-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
      .al-read-tag {
        padding: 3px 10px; border-radius: 999px; background: rgba(201, 162, 39, 0.14); border: 1px solid rgba(201, 162, 39, 0.4);
        color: #f1e4bd; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px;
      }
      .al-read-url-box { margin-bottom: 16px; }
      .al-read-url-link {
        display: inline-block; word-break: break-all; color: #8ab4ff; font-family: 'IBM Plex Mono', monospace;
        font-size: 12px; text-decoration: underline;
      }
      .al-read-text-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .al-read-text-controls-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
      }
      .al-read-font-btn {
        width: 28px; height: 24px; border-radius: 6px; border: 1px solid rgba(201, 162, 39, 0.4);
        background: rgba(201, 162, 39, 0.12); color: #f1e4bd; font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer;
      }
      .al-read-font-btn:hover { background: rgba(201, 162, 39, 0.26); }
      /* 本文パネル: OCR/貼り付けの文章を紙のような白地(黒地ではなく)で読みやすく表示する
         (2026年9月、実機要望)。段落はreflowBodyTextHtml()が<p>単位で区切る。 */
      .al-read-text-panel {
        background: #f7f1e0; border-radius: 10px; padding: 16px; margin-bottom: 18px;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
      }
      .al-read-text {
        font-family: 'Zen Kaku Gothic New', sans-serif; color: #241c05; line-height: 1.9;
        white-space: normal; word-break: break-word; overflow-wrap: anywhere;
      }
      .al-read-text p { margin: 0 0 0.9em; }
      .al-read-text p:last-child { margin-bottom: 0; }
      .al-read-summary-row { display: flex; gap: 8px; margin-bottom: 12px; }
      .al-read-summary-btn {
        flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(201, 162, 39, 0.4);
        background: rgba(201, 162, 39, 0.1); color: #f1e4bd; font-family: 'Zen Kaku Gothic New', sans-serif;
        font-weight: 700; font-size: 12px; cursor: pointer;
      }
      .al-read-summary-btn:hover:not(:disabled) { background: rgba(201, 162, 39, 0.24); }
      .al-read-summary-btn:disabled { opacity: 0.5; cursor: default; }
      .al-read-summary-box { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
      .al-read-summary-block {
        padding: 11px 12px; border-radius: 9px; background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .al-read-summary-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(201, 162, 39, 0.85); margin-bottom: 6px;
      }
      .al-read-summary-text { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; line-height: 1.75; color: rgba(255, 255, 255, 0.88); }
      .al-read-roundtable-btn {
        width: 100%; padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(201, 162, 39, 0.4);
        background: rgba(201, 162, 39, 0.14); color: #f1e4bd; font-family: 'Zen Kaku Gothic New', sans-serif;
        font-weight: 700; font-size: 12px; cursor: pointer;
      }
      .al-read-roundtable-btn:hover { background: rgba(201, 162, 39, 0.28); }

      /* 編集フォーム(2026年9月追加): 読書ビューの✎から表示/非表示をトグルする。
         .al-field系のスタイルは新規登録パネルと共通のものを流用する。 */
      .al-read-edit-actions { display: flex; gap: 8px; margin-top: 4px; }
      .al-edit-save-btn {
        flex: 1; padding: 9px 12px; border-radius: 8px; border: none; background: #c9a227; color: #241c05;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 12.5px; cursor: pointer;
      }
      .al-edit-save-btn:hover { background: #ddb843; }
      .al-edit-cancel-btn {
        padding: 9px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.18); background: transparent;
        color: rgba(255, 255, 255, 0.6); font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer;
      }
      .al-edit-cancel-btn:hover { border-color: #c9a227; color: #f1e4bd; }

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
      <div class="al-tags"></div>
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
            <label>出典元(任意)</label>
            <input type="text" class="al-new-citation-input" placeholder="例: 美術手帖 2024年9月号 p.34">
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
        <div class="al-shelf-items"></div>
        <p class="al-empty" hidden></p>
      </div>
    `;
    document.body.appendChild(overlay);

    alEls = {
      overlay,
      searchInput: overlay.querySelector('.al-search-input'),
      tagsEl: overlay.querySelector('.al-tags'),
      newToggleBtn: overlay.querySelector('.al-new-toggle-btn'),
      newPanel: overlay.querySelector('.al-new-panel'),
      newTitleInput: overlay.querySelector('.al-new-title-input'),
      newThumbBox: overlay.querySelector('.al-new-thumb-box'),
      newThumbFile: overlay.querySelector('.al-new-thumb-file'),
      newOcrBtn: overlay.querySelector('.al-new-ocr-btn'),
      newBodyInput: overlay.querySelector('.al-new-body-input'),
      newCitationInput: overlay.querySelector('.al-new-citation-input'),
      newTagsInput: overlay.querySelector('.al-new-tags-input'),
      newUrlTitleInput: overlay.querySelector('.al-new-url-title-input'),
      newUrlInput: overlay.querySelector('.al-new-url-input'),
      newUrlTagsInput: overlay.querySelector('.al-new-url-tags-input'),
      newSaveBtn: overlay.querySelector('.al-new-save-btn'),
      shelfItemsEl: overlay.querySelector('.al-shelf-items'),
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

    alEls.tagsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.al-tag');
      if (!chip) return;
      activeTagFilter = chip.dataset.tagKey || null;
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

    // 本(タップで読書ビュー)・しおり(タップで新規タブ、📌/✎/🗑は常設のフッターアイコン)は
    // 再描画のたびに要素が差し替わるため、個別バインドではなくコンテナへのイベント委譲にする。
    alEls.shelfItemsEl.addEventListener('click', (e) => {
      const pinBtn = e.target.closest('[data-pin-id]');
      if (pinBtn) { placeEntryOnCanvas(pinBtn.dataset.pinId); return; }
      const editBtn = e.target.closest('[data-edit-id]');
      if (editBtn) { openReadingView(editBtn.dataset.editId, { startEditing: true }); return; }
      const delBtn = e.target.closest('[data-del-id]');
      if (delBtn) { deleteEntry(delBtn.dataset.delId); return; }
      const bookItem = e.target.closest('[data-book-id]');
      if (bookItem) { openReadingView(bookItem.dataset.bookId); return; }
      const markItem = e.target.closest('[data-mark-id]');
      if (markItem) { handleOpenBookmark(markItem.dataset.markId, markItem); }
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
    alEls.newCitationInput.value = '';
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
      // continuous:true(2026年9月追加): Almagestは複数段組みのページを範囲選択で分割して
      // 読み取る運用が中心のため、範囲を選ばない1回目の読み取りも「単発ですぐ閉じる」旧来の
      // 経路には流さず、常にサムネイル付きの続けて選択フローに固定する(呼ぶたびに単発/連続の
      // 挙動が変わって分かりにくい、という実機報告への対応)。
      const result = await openCamera('caption', { continuous: true });
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

  /** 読書ビューの編集フォーム版のOCR追記(2026年9月追加、上記handleOcrIntoDraft()と同じ
   *  パターン)。**以前は編集フォームにOCRボタン自体が無く、「登録後に本文を直そうとしても
   *  カメラが呼び出せない」という実機報告があった**ため追加した。バックグラウンド実行中に
   *  編集を終了/別の本を開き直した場合に備え、対象の本のID(targetEntryId)と編集フォームが
   *  今も同じ本を表示中かを確認し、一致しなければ(handleOcrIntoDraft()と同様)読み取った
   *  文字を失わないよう新規テクストカードとして残す。 */
  async function handleOcrIntoEdit(btnEl) {
    const targetEntryId = readingEntryId;
    if (btnEl) btnEl.disabled = true;
    try {
      const result = await openCamera('caption', { continuous: true }); // 上記handleOcrIntoDraft()と同じ理由
      if (!result || result.kind !== 'text' || !result.text.trim()) return;
      const stillEditingSame =
        editingEntry && readingEntryId === targetEntryId &&
        rdEls.editBodyInput.isConnected && !rdEls.editBodyField.hidden;
      if (!stillEditingSame) {
        createTextCard(result.text.trim());
        setStatus('編集画面が閉じられていたため、読み取った文字は新しいテクストカードに残しました');
        return;
      }
      const existing = rdEls.editBodyInput.value.trim();
      rdEls.editBodyInput.value = existing ? `${existing}\n${result.text.trim()}` : result.text.trim();
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function handleSaveNewEntry() {
    let entry;
    if (newEntryKind === 'book') {
      const title = alEls.newTitleInput.value.trim();
      const bodyText = alEls.newBodyInput.value.trim();
      if (!title || !bodyText) {
        setStatus('タイトルと本文を入力してください', { important: true });
        return;
      }
      entry = {
        id: crypto.randomUUID(),
        kind: newEntryUsedOcr ? 'ocr' : 'paste',
        title,
        sourceLabel: newEntryUsedOcr ? 'OCR' : '貼り付け',
        bodyText,
        url: null,
        citation: alEls.newCitationInput.value.trim() || null,
        thumbDataUrl: newEntryThumbDataUrl || null,
        tags: parseTags(alEls.newTagsInput.value),
        summaries: { easy: null, academic: null },
        createdAt: new Date().toISOString(),
      };
    } else {
      const title = alEls.newUrlTitleInput.value.trim();
      const url = alEls.newUrlInput.value.trim();
      if (!title || !url) {
        setStatus('タイトルとURLを入力してください', { important: true });
        return;
      }
      entry = {
        id: crypto.randomUUID(),
        kind: 'url',
        title,
        sourceLabel: hostnameOf(url),
        bodyText: null,
        url,
        citation: null,
        thumbDataUrl: null,
        tags: parseTags(alEls.newUrlTagsInput.value),
        summaries: { easy: null, academic: null },
        createdAt: new Date().toISOString(),
      };
    }
    getEntries().push(entry);
    alEls.newPanel.hidden = true;
    renderShelf();
    setStatus('書庫に登録中…', { busy: true });
    const ok = await saveAlmagestDataNow();
    setStatus(ok ? '書庫に登録しました' : '書庫に登録しました(Driveへの送信は保留中、後で自動的に再試行します)', { important: !ok });
  }

  function matchesSearch(entry, q) {
    if (!q) return true;
    const hay = [entry.title, entry.bodyText, entry.citation, (entry.tags || []).join(' ')].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q.toLowerCase());
  }

  function isUnsummarized(entry) {
    return entry.kind !== 'url' && !(entry.summaries && (entry.summaries.easy || entry.summaries.academic));
  }

  function matchesTagFilter(entry) {
    if (!activeTagFilter) return true;
    if (activeTagFilter === '__unsummarized__') return isUnsummarized(entry);
    return (entry.tags || []).includes(activeTagFilter);
  }

  function collectAllTags() {
    const set = new Set();
    getEntries().forEach((e) => (e.tags || []).forEach((t) => set.add(t)));
    return [...set].sort();
  }

  function renderTagChips() {
    const chips = [
      { key: null, label: 'すべて' },
      { key: '__unsummarized__', label: '未要約' },
      ...collectAllTags().map((t) => ({ key: t, label: t })),
    ];
    alEls.tagsEl.innerHTML = chips
      .map((c) => `<span class="al-tag${activeTagFilter === c.key ? ' active' : ''}" data-tag-key="${escapeAttrLocal(c.key || '')}">${escapeHtml(c.label)}</span>`)
      .join('');
  }

  function bookSpineHtml(entry) {
    const hasCover = Boolean(entry.thumbDataUrl);
    const kindClass = entry.kind === 'ocr' ? 'al-book--ocr' : 'al-book--paste';
    const badge = entry.kind === 'ocr' ? '📷' : '📋';
    if (hasCover) {
      const srcHtml = entry.sourceLabel ? `<span class="al-book-src">${escapeHtml(entry.sourceLabel)}</span>` : '';
      return (
        `<div class="al-book al-book--cover ${kindClass}" data-book-id="${entry.id}" style="background-image:url('${escapeAttrLocal(entry.thumbDataUrl)}')">` +
        `<span class="al-book-cover-badge">${badge}</span>` +
        `<span class="al-book-title-overlay">${escapeHtml(entry.title || '(無題)')}${srcHtml}</span></div>`
      );
    }
    return (
      `<div class="al-book ${kindClass}" data-book-id="${entry.id}">` +
      `<span class="al-book-badge">${badge}</span>` +
      `<span class="al-book-spine-title">${escapeHtml(entry.title || '(無題)')}</span></div>`
    );
  }

  /** しおり(URL)の背表紙。タップ(本文以外の部分)で外部URLを開く。📌/✎/🗑は常設のフッター
   *  アイコンから、読書ビューを経由せず直接呼べる(本と違いこの種別には読書ビューが無いため)。 */
  function bookmarkSpineHtml(entry) {
    return (
      `<div class="al-book al-book--url" data-mark-id="${entry.id}">` +
      `<span class="al-book-badge">🔖</span>` +
      `<span class="al-book-spine-title">${escapeHtml(entry.title || '(無題)')}</span>` +
      `<div class="al-book-footer">` +
      `<button type="button" class="al-book-footer-btn" data-pin-id="${entry.id}" title="このセッションに置く">📌</button>` +
      `<button type="button" class="al-book-footer-btn" data-edit-id="${entry.id}" title="編集">✎</button>` +
      `<button type="button" class="al-book-footer-btn al-book-footer-btn--danger" data-del-id="${entry.id}" title="書庫から削除">🗑</button>` +
      `</div></div>`
    );
  }

  /** 「宇宙の書庫からデータを呼び出す」イメージの一瞬の発光演出(2026年9月追加)。ポップアップ
   *  ブロック対策のため、window.open()はこの関数の呼び出し元(クリックハンドラ内)で
   *  同期的に済ませてから呼ぶこと(この関数自体は演出のみで、外部URLを開く処理を持たない)。 */
  function playSummonAnimation(originEl) {
    if (!originEl) return;
    const rect = originEl.getBoundingClientRect();
    const fx = document.createElement('div');
    fx.className = 'al-summon-fx';
    fx.style.left = `${rect.left + rect.width / 2}px`;
    fx.style.top = `${rect.top + rect.height / 2}px`;
    fx.innerHTML =
      '<div class="al-summon-ring"></div>' +
      '<div class="al-summon-ring al-summon-ring--delay"></div>' +
      '<div class="al-summon-label">呼び出し中…</div>';
    document.body.appendChild(fx);
    setTimeout(() => fx.remove(), 850);
  }

  function handleOpenBookmark(entryId, itemEl) {
    const entry = getAlmagestEntryById(entryId);
    if (!entry || !entry.url) return;
    // ポップアップブロッカー対策: window.open()はユーザー操作(クリック)から同期的に
    // 呼ぶ必要があるため、演出より先に(かつ演出を待たず)呼ぶ。
    window.open(entry.url, '_blank', 'noopener');
    playSummonAnimation(itemEl);
  }

  function renderShelf() {
    const totalCount = getEntries().length;
    renderTagChips();
    const q = searchQuery.trim();
    const filtered = getEntries().filter((e) => matchesSearch(e, q) && matchesTagFilter(e)).sort(byCreatedDesc);
    alEls.shelfItemsEl.innerHTML = filtered
      .map((e) => (e.kind === 'url' ? bookmarkSpineHtml(e) : bookSpineHtml(e)))
      .join('');
    alEls.emptyEl.hidden = filtered.length > 0;
    alEls.emptyEl.textContent = totalCount === 0
      ? 'まだ何も登録されていません。「＋ 登録」から書庫を育てましょう。'
      : '検索条件に一致するものがありません。';
  }

  /** 2026年9月、書庫データの読み込みを遅延させたことに伴いasync化した。overlay自体は
   *  データが揃うのを待たず先に開き(体感の即応性を優先)、読み込み中は本棚を空のまま
   *  「読み込み中…」のステータスで示してから、揃い次第renderShelf()する。 */
  async function openAlmagest() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!alEls) buildShelfDom();
    searchQuery = '';
    activeTagFilter = null;
    alEls.searchInput.value = '';
    alEls.newPanel.hidden = true;
    alEls.overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (!almagestDataLoaded) {
      setStatus('書庫を読み込み中…', { busy: true });
      await ensureAlmagestDataLoaded();
      setStatus('書庫を読み込みました');
    }
    renderShelf();
    // 他端末での変更を拾う(2026年9月追加)。失敗(オフライン等)しても今の表示のまま続行する。
    refreshAlmagestFromDriveInBackground();
  }

  function closeAlmagest() {
    closeReadingView();
    if (alEls) alEls.overlay.classList.remove('open');
    document.body.style.overflow = '';
    // スタートメニュー経由でAlmagestだけ開いてメインデータを読み込んでいない場合、
    // 閉じた瞬間にキャンバスが空白のまま取り残されるという実機報告(2026年9月)があった。
    // js/app.jsのonAlmagestClosed()が「まだ何も選んでいなければスタートメニューへ戻す」
    // 判断を行う(state.quickMode/mainDataLoadedを見るのはapp.js側の責務のため、ここでは
    // 存在すれば呼ぶだけの薄いフックに留める)。
    if (window.onAlmagestClosed) window.onAlmagestClosed();
  }

  /* ---------------- 読書ビュー ---------------- */

  function buildReadingDom() {
    const overlay = document.createElement('div');
    overlay.className = 'al-read-overlay';
    overlay.innerHTML = `
      <div class="al-read-topbar">
        <span class="al-read-icon">📖</span>
        <span class="al-read-title"></span>
        <button class="al-read-edit-btn" title="編集">✎</button>
        <button class="al-read-close" title="閉じる">✕</button>
      </div>
      <div class="al-read-body">
        <div class="al-read-display">
          <img class="al-read-cover" hidden>
          <div class="al-read-src"></div>
          <div class="al-read-citation"></div>
          <div class="al-read-tags"></div>
          <div class="al-read-url-box" hidden><a class="al-read-url-link" target="_blank" rel="noopener"></a></div>
          <div class="al-read-text-controls" hidden>
            <span class="al-read-text-controls-label">文字サイズ</span>
            <button type="button" class="al-read-font-btn" data-delta="-1">A-</button>
            <button type="button" class="al-read-font-btn" data-delta="1">A+</button>
          </div>
          <div class="al-read-text-panel" hidden><div class="al-read-text"></div></div>
          <div class="al-read-summary-row" hidden>
            <button type="button" class="al-read-summary-btn" data-mode="education">👦 Boy</button>
            <button type="button" class="al-read-summary-btn" data-mode="academic">🎓 Professor</button>
          </div>
          <div class="al-read-summary-box"></div>
          <button type="button" class="al-read-roundtable-btn" hidden>🗣 読書会をひらく</button>
        </div>
        <div class="al-read-edit-form" hidden>
          <div class="al-field">
            <label>タイトル</label>
            <input type="text" class="al-edit-title-input">
          </div>
          <div class="al-field al-edit-thumb-field">
            <label>サムネイル(任意)</label>
            <div class="al-new-thumb-box al-edit-thumb-box"><span class="al-new-thumb-hint">🖼️ クリックで選択<br>/貼り付け</span></div>
            <input type="file" accept="image/*" class="al-edit-thumb-file" hidden>
          </div>
          <div class="al-field al-edit-body-field">
            <div class="al-field-label-row">
              <label>本文</label>
              <button type="button" class="al-new-ocr-btn al-edit-ocr-btn" title="カメラでOCR読み取り(追記)">📷</button>
            </div>
            <textarea class="al-edit-body-input al-new-body-input"></textarea>
          </div>
          <div class="al-field al-edit-citation-field">
            <label>出典元(任意)</label>
            <input type="text" class="al-edit-citation-input">
          </div>
          <div class="al-field al-edit-url-field">
            <label>URL</label>
            <input type="text" class="al-edit-url-input">
          </div>
          <div class="al-field">
            <label>タグ(カンマ区切り)</label>
            <input type="text" class="al-edit-tags-input">
          </div>
          <div class="al-read-edit-actions">
            <button type="button" class="al-edit-save-btn">保存</button>
            <button type="button" class="al-edit-cancel-btn">キャンセル</button>
          </div>
        </div>
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
      editBtn: overlay.querySelector('.al-read-edit-btn'),
      display: overlay.querySelector('.al-read-display'),
      cover: overlay.querySelector('.al-read-cover'),
      src: overlay.querySelector('.al-read-src'),
      citation: overlay.querySelector('.al-read-citation'),
      tags: overlay.querySelector('.al-read-tags'),
      urlBox: overlay.querySelector('.al-read-url-box'),
      urlLink: overlay.querySelector('.al-read-url-link'),
      textControls: overlay.querySelector('.al-read-text-controls'),
      textPanel: overlay.querySelector('.al-read-text-panel'),
      text: overlay.querySelector('.al-read-text'),
      summaryRow: overlay.querySelector('.al-read-summary-row'),
      summaryBox: overlay.querySelector('.al-read-summary-box'),
      roundtableBtn: overlay.querySelector('.al-read-roundtable-btn'),
      editForm: overlay.querySelector('.al-read-edit-form'),
      editTitleInput: overlay.querySelector('.al-edit-title-input'),
      editThumbField: overlay.querySelector('.al-edit-thumb-field'),
      editThumbBox: overlay.querySelector('.al-edit-thumb-box'),
      editThumbFile: overlay.querySelector('.al-edit-thumb-file'),
      editBodyField: overlay.querySelector('.al-edit-body-field'),
      editBodyInput: overlay.querySelector('.al-edit-body-input'),
      editOcrBtn: overlay.querySelector('.al-edit-ocr-btn'),
      editCitationField: overlay.querySelector('.al-edit-citation-field'),
      editCitationInput: overlay.querySelector('.al-edit-citation-input'),
      editUrlField: overlay.querySelector('.al-edit-url-field'),
      editUrlInput: overlay.querySelector('.al-edit-url-input'),
      editTagsInput: overlay.querySelector('.al-edit-tags-input'),
      editSaveBtn: overlay.querySelector('.al-edit-save-btn'),
      editCancelBtn: overlay.querySelector('.al-edit-cancel-btn'),
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

    rdEls.roundtableBtn.addEventListener('click', () => {
      if (!readingEntryId || !getAlmagestEntryById(readingEntryId)) return;
      const card = createBookChatCard(readingEntryId);
      closeAlmagest();
      setStatus('読書会をひらきました');
      landCardOnCanvas(card);
    });

    rdEls.editBtn.addEventListener('click', () => {
      const entry = getAlmagestEntryById(readingEntryId);
      if (!entry) return;
      editingEntry = !editingEntry;
      renderReadingView(entry);
    });

    overlay.querySelectorAll('.al-read-font-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.delta) || 0;
        readFontSize = Math.min(READ_FONT_SIZE_MAX, Math.max(READ_FONT_SIZE_MIN, readFontSize + delta));
        saveReadFontSize(readFontSize);
        applyReadingFontSize();
      });
    });

    rdEls.editThumbBox.addEventListener('click', () => rdEls.editThumbFile.click());
    rdEls.editThumbFile.addEventListener('change', async () => {
      const file = rdEls.editThumbFile.files && rdEls.editThumbFile.files[0];
      rdEls.editThumbFile.value = '';
      if (file) await applyEditThumbBlob(file);
    });
    overlay.addEventListener('paste', async (e) => {
      if (!editingEntry || rdEls.editThumbField.hidden) return;
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageItem = Array.from(items).find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (blob) await applyEditThumbBlob(blob);
    });

    rdEls.editOcrBtn.addEventListener('click', () => handleOcrIntoEdit(rdEls.editOcrBtn));
    rdEls.editSaveBtn.addEventListener('click', handleSaveEdit);
    rdEls.editCancelBtn.addEventListener('click', handleCancelEdit);

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

  function renderEditThumbBox() {
    rdEls.editThumbBox.innerHTML = editThumbDataUrl
      ? `<img class="al-new-thumb-img" src="${escapeAttrLocal(editThumbDataUrl)}" alt="">`
      : '<span class="al-new-thumb-hint">🖼️ クリックで選択<br>/貼り付け</span>';
  }

  async function applyEditThumbBlob(blob) {
    const dataUrl = await generateThumbnail(blob, 360, 0.75);
    if (!dataUrl) return;
    editThumbDataUrl = dataUrl;
    renderEditThumbBox();
  }

  /**
   * 読書ビューの表示/編集の切り替えをまとめて描画する(2026年9月追加)。entry.kindにより
   * 表示・編集フォームの中身を出し分ける(url=タイトル/URL/タグのみ、それ以外=タイトル/
   * サムネイル/本文/出典元/タグ)。
   */
  function renderReadingView(entry) {
    rdEls.title.textContent = entry.title || '(無題)';
    rdEls.editBtn.classList.toggle('active', editingEntry);
    const isUrl = entry.kind === 'url';

    if (editingEntry) {
      rdEls.display.hidden = true;
      rdEls.editForm.hidden = false;
      rdEls.editTitleInput.value = entry.title || '';
      rdEls.editTagsInput.value = (entry.tags || []).join(', ');
      rdEls.editBodyField.hidden = isUrl;
      rdEls.editThumbField.hidden = isUrl;
      rdEls.editCitationField.hidden = isUrl;
      rdEls.editUrlField.hidden = !isUrl;
      if (isUrl) {
        rdEls.editUrlInput.value = entry.url || '';
      } else {
        rdEls.editBodyInput.value = entry.bodyText || '';
        rdEls.editCitationInput.value = entry.citation || '';
        editThumbDataUrl = entry.thumbDataUrl || null;
        renderEditThumbBox();
      }
      return;
    }

    rdEls.display.hidden = false;
    rdEls.editForm.hidden = true;

    if (!isUrl && entry.thumbDataUrl) {
      rdEls.cover.src = entry.thumbDataUrl;
      rdEls.cover.hidden = false;
    } else {
      rdEls.cover.hidden = true;
    }
    rdEls.src.textContent = entry.sourceLabel || '';
    rdEls.src.hidden = !entry.sourceLabel;
    rdEls.citation.textContent = entry.citation ? `出典: ${entry.citation}` : '';
    rdEls.citation.hidden = !entry.citation;
    rdEls.tags.innerHTML = (entry.tags || []).map((t) => `<span class="al-read-tag">${escapeHtml(t)}</span>`).join('');

    rdEls.urlBox.hidden = !isUrl;
    if (isUrl) {
      rdEls.urlLink.href = entry.url || '#';
      rdEls.urlLink.textContent = entry.url || '';
    }

    rdEls.textControls.hidden = isUrl;
    rdEls.textPanel.hidden = isUrl;
    if (!isUrl) {
      applyReadingFontSize();
      rdEls.text.innerHTML = reflowBodyTextHtml(entry.bodyText || '');
    }
    rdEls.summaryRow.hidden = isUrl;
    rdEls.roundtableBtn.hidden = isUrl;
    renderReadingSummaries(entry);
  }

  function openReadingView(entryId, opts) {
    const entry = getAlmagestEntryById(entryId);
    if (!entry) {
      setStatus('この本は見つかりませんでした', { important: true });
      return;
    }
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!rdEls) buildReadingDom();
    readingEntryId = entryId;
    editingEntry = Boolean(opts && opts.startEditing);
    renderReadingView(entry);
    rdEls.overlay.classList.add('open');
  }

  function closeReadingView() {
    readingEntryId = null;
    editingEntry = false;
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
      renderReadingSummaries(entry);
      const ok = await saveAlmagestDataNow();
      setStatus(ok ? '要約しました' : '要約しました(Driveへの送信は保留中、後で自動的に再試行します)', { important: !ok });
    } catch (err) {
      console.error(err);
      setStatus(`要約に失敗しました: ${err.message}`, { important: true });
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function handleSaveEdit() {
    const entry = getAlmagestEntryById(readingEntryId);
    if (!entry) return;
    const title = rdEls.editTitleInput.value.trim();
    if (!title) {
      setStatus('タイトルを入力してください', { important: true });
      return;
    }
    entry.title = title;
    entry.tags = parseTags(rdEls.editTagsInput.value);
    if (entry.kind === 'url') {
      const url = rdEls.editUrlInput.value.trim();
      if (!url) {
        setStatus('URLを入力してください', { important: true });
        return;
      }
      entry.url = url;
      entry.sourceLabel = hostnameOf(url);
    } else {
      const bodyText = rdEls.editBodyInput.value.trim();
      if (!bodyText) {
        setStatus('本文を入力してください', { important: true });
        return;
      }
      entry.bodyText = bodyText;
      entry.citation = rdEls.editCitationInput.value.trim() || null;
      entry.thumbDataUrl = editThumbDataUrl || null;
    }
    editingEntry = false;
    renderReadingView(entry);
    renderShelf();
    renderAllCards(); // タイトル・サムネイルの変更を、キャンバス上の参照カードの表示にも反映する
    setStatus('保存中…', { busy: true });
    const ok = await saveAlmagestDataNow();
    setStatus(ok ? '書庫を更新しました' : '書庫を更新しました(Driveへの送信は保留中、後で自動的に再試行します)', { important: !ok });
  }

  function handleCancelEdit() {
    editingEntry = false;
    const entry = getAlmagestEntryById(readingEntryId);
    if (entry) renderReadingView(entry);
  }

  /**
   * 書庫からエントリを削除する共通処理。読書ビューの🗑削除ボタン(本)と、しおりの背表紙に
   * 直接付けた🗑アイコンの両方から呼ぶ。
   */
  async function deleteEntry(entryId) {
    const entry = getAlmagestEntryById(entryId);
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
    if (readingEntryId === entryId) closeReadingView();
    renderShelf();
    renderAllCards(); // 参照カードの表示を「削除済み」の見た目へ更新する
    setStatus('削除中…', { busy: true });
    const ok = await saveAlmagestDataNow();
    setStatus(ok ? '書庫から削除しました' : '書庫から削除しました(Driveへの送信は保留中、後で自動的に再試行します)', { important: !ok });
  }

  function handleDeleteEntry() {
    deleteEntry(readingEntryId);
  }

  /* ---------------- セッションのキャンバスへの配置(橋渡し機能) ---------------- */

  /** カードをキャンバスへ追加した直後、Almagestを抜けてその場でカードが生まれたことを示す
   *  「パン+一瞬の発光」の着地演出(jumpToInfoCard()と同じ考え方)。placeEntryOnCanvas()と
   *  createBookChatCard()経由の「🗣 読書会をひらく」の両方から使う共通処理(2026年9月切り出し)。 */
  function landCardOnCanvas(card) {
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

  /** 書庫エントリを複製せず「参照」として、現在のセッションのキャンバスへカード
   *  (mediaType:'book')として置く。押すとAlmagestを抜けて、その場でカードが生まれる。 */
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
    landCardOnCanvas(card);
  }

  /** 写真カードの編集ガイド「📖 Almagest」から呼ばれる: 元の書庫エントリの読書ビューへ
   *  ジャンプする。参照先が削除済みならその旨を知らせるだけ(js/app.jsのhexクリック
   *  ディスパッチャからwindow経由で呼ばれる、Astrometry Scope/Star Pencilと同じ薄い統合)。 */
  async function jumpToAlmagestEntry(entryId) {
    // 通常は本カードが描画済み(=loadMainData()の並行読み込みで既に揃っている)時点でしか
    // 呼ばれないため実質no-opだが、念のため（js/app.jsのensureMainDataLoaded()と同じ作法の)
    // 防御として待つ。
    await ensureAlmagestDataLoaded();
    const entry = getAlmagestEntryById(entryId);
    if (!entry) {
      setStatus('この参照先は書庫から削除されています', { important: true });
      return;
    }
    // しおり(URL)は本文を持たず読書ビューの対象外(本棚のタップと同じ挙動)なので、
    // ここでも読書ビューではなく外部URLを新規タブで直接開く。
    if (entry.kind === 'url') {
      if (entry.url) window.open(entry.url, '_blank', 'noopener');
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
  window.initAlmagestData = initAlmagestData;
  window.buildAlmagestChatContext = buildAlmagestChatContext;
})();
