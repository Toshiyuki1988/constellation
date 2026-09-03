// CONSTELLATION — Module: Crews
//
// 文献・記録に登場する人物の言葉を借りて、サマリーカードをその人格の声で語らせる
// モジュール。CLAUDE.mdの「モジュール」規約に従い、このファイル全体をIIFEで包んで
// トップレベルの名前をグローバルへ漏らさない。
// state / els / scheduleAutoSave() / renderAllCards() / openCamera() などの既存グローバルは
// 直接参照する(モジュールだからといって完全に独立させる必要はないため)。
//
// 起動: js/module-launcher.js(モジュール共通の起動基盤)経由。背景を2本指でダブルタップ
//       するとキーパッドHUDが開き、"456"(電話キーパッドの中央の横一列、洛書の対角線でもある
//       4-5-6=15の並び。中央5を軸に複数のペルソナが集う、というこのモジュールの性質にちなむ)
//       と入力すると起動する(PCではCONSTELLATION PIEの「キーパッド」項目からも同じキーパッドを
//       開ける)。このモジュール自身は registerModuleCode('456', openCrews) で登録するだけでよい。
//
// データモデル: state.crews (配列)。複数セッション・複数年をまたいで使い回すデータなので、
//   カード単位ではなくstate直下に持たせ、js/app.jsのhandleSave()/onSignedIn()で
//   通常のカード/セッションと同じくDriveへ保存/復元する。
//   { id, personInfo, theirWords, name, avatar, enabled, createdAt }
//   - personInfo:【人物情報】— 誰か・どの文献か(自由記述)
//   - theirWords:【その言葉】— 本人の言葉の引用(自由記述)
//   - name: personInfoの冒頭からクライアント側だけで自動生成する表示名(API不使用、deriveName())
//   - enabled: ONのペルソナだけがサマリーカードのヘックス候補になる
//
// 【設計上の重要な決定】ペルソナの「形成」(=人格になりきった実際の生成)は、登録・保存の
// 時点ではGeminiを一切呼ばない。2026年9月、インフォメーションカードの展覧会リンク自動検索で
// google_searchツール(検索グラウンディング)を追加した際、請求先アカウント非紐付けの無料キー
// では割り当てがゼロで即座に429 RESOURCE_EXHAUSTEDになることが実機で判明した。この教訓を
// 踏まえ、Crewsでは「登録のたびに余分なAPI呼び出しを増やす」設計を避けている(表示名の自動
// 抽出のようなAPI呼び出しも含めて、ユーザーの意向により見送った)。実際にGeminiが呼ばれるのは、
// ユーザーがサマリーカード上でそのペルソナのヘックスを押した瞬間だけ(=既存の
// summarizeSession()を1回呼ぶだけで、Education/Academicと全く同じ呼び出しパターン)。
//
// 統合ポイント(js/app.js側):
//   - summaryCardInnerHtml() が window.crewsSummaryHexButtonsHtml() を呼び、ONのペルソナ数ぶん
//     ヘックスボタンを追加で描画する。
//   - wireSummaryCard() が各ヘックスにタップ(=生成)と長押し(=window.showCrewInfoPopup()で
//     【人物情報】【その言葉】をコピー可能な形で見返す)の両方を割り当てる。表示名(ニックネーム)
//     だけでは元の人物情報を思い出せない、というユーザー要望を受けて追加した(2026年9月)。
//   - handleSummaryGenerate() が window.getCrewById() でmodeOrCrewIdがペルソナIDかどうかを判定し、
//     ペルソナなら summarizeSession() に persona: {personInfo, theirWords} を渡す。
//   - renderCard() が card.crewPersonaId を見て、水色グラスモーフ(.star-card--crew)と
//     ペルソナの名前・絵文字ヘッダー(.star-card-crew-head)を付ける。

(function () {
  'use strict';

  // 固定の絵文字パレットから選ぶだけ(生成しない、APIを使わない)。
  const AVATAR_PALETTE = ['👤', '🌳', '🧑‍🌾', '🧒', '🧓', '🕊️', '🧑‍🏫', '🖋️', '👧', '🧑‍🎨', '🧑‍🏭', '👴'];

  let crEls = null;
  let editingId = null; // 編集中のペルソナID。null なら「新規」
  let pendingAvatar = AVATAR_PALETTE[0];
  let stylesInjected = false; // ペルソナ管理パネルと情報ポップアップ、どちらが先に開かれてもCSSを二重注入しない
  let infoPopupEls = null;

  /* ---------------- DOM / CSS をこのファイルだけで自己完結させて注入する ---------------- */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .crews-overlay {
        position: fixed; inset: 0; z-index: 120;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none;
        transition: opacity 0.25s ease-out;
        padding: 16px;
      }
      .crews-overlay.open { opacity: 1; pointer-events: auto; }
      .crews-backdrop { position: absolute; inset: 0; background: rgba(6, 10, 12, 0.88); }
      .crews-panel {
        position: relative;
        width: min(92vw, 760px);
        max-height: 88vh;
        overflow-y: auto;
        background: rgba(9, 15, 18, 0.96);
        border: 1px solid rgba(85, 230, 247, 0.28);
        border-radius: 16px;
        padding: 22px 22px 26px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
        transform: scale(0.92); transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .crews-overlay.open .crews-panel { transform: scale(1); }
      .crews-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
      .crews-top-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.14em;
        color: #55e6f7; text-transform: uppercase;
      }
      .crews-close-btn {
        width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(85, 230, 247, 0.3);
        color: rgba(255, 255, 255, 0.85); font-size: 14px; cursor: pointer;
      }
      .crews-close-btn:hover { background: rgba(85, 230, 247, 0.25); }
      .crews-body { display: grid; grid-template-columns: 1fr 1.15fr; gap: 22px; }
      @media (max-width: 640px) { .crews-body { grid-template-columns: 1fr; } }

      .crews-col-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45); margin: 0 0 10px;
      }
      .crews-roster { display: flex; flex-direction: column; gap: 7px; }
      .crews-roster-empty {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11.5px; color: rgba(255, 255, 255, 0.4);
        line-height: 1.7; padding: 6px 2px;
      }
      .crews-chip {
        display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 9px;
      }
      .crews-chip.on { background: rgba(85, 230, 247, 0.13); border-color: rgba(85, 230, 247, 0.5); }
      .crews-chip.editing { box-shadow: 0 0 0 1px #55e6f7; }
      .crews-chip-avatar {
        width: 32px; height: 32px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        font-size: 15px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .crews-chip.on .crews-chip-avatar { background: rgba(85, 230, 247, 0.22); border-color: rgba(85, 230, 247, 0.5); }
      .crews-chip-meta { flex: 1; min-width: 0; }
      .crews-chip-name {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 11.5px; color: #fff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .crews-chip-src {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.4); margin-top: 2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .crews-chip-toggle {
        width: 18px; height: 18px; border-radius: 50%; flex: none; border: 1px solid rgba(255, 255, 255, 0.25);
        display: flex; align-items: center; justify-content: center; font-size: 10px; color: transparent;
      }
      .crews-chip.on .crews-chip-toggle { background: #55e6f7; border-color: #55e6f7; color: #06282c; }
      .crews-add {
        margin-top: 4px; padding: 9px 12px; border: 1px dashed rgba(255, 255, 255, 0.18); border-radius: 10px;
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: rgba(255, 255, 255, 0.45);
        text-align: center; cursor: pointer;
      }
      .crews-add:hover { color: #55e6f7; border-color: rgba(85, 230, 247, 0.4); }

      .crews-editor {
        background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px; padding: 15px 15px 17px;
      }
      .crews-field { margin-bottom: 13px; }
      .crews-field-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .crews-field-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
      }
      .crews-ocr-btn {
        width: 24px; height: 24px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(85, 230, 247, 0.12); border: 1px solid rgba(85, 230, 247, 0.35); color: #55e6f7; cursor: pointer;
      }
      .crews-ocr-btn:hover { background: rgba(85, 230, 247, 0.25); }
      .crews-ocr-btn:disabled { opacity: 0.5; cursor: default; }
      .crews-field-input {
        width: 100%; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px;
        padding: 8px 10px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12.5px; color: #fff;
        line-height: 1.6; resize: vertical;
      }
      .crews-field-input::placeholder { color: rgba(255, 255, 255, 0.3); }
      .crews-field-hint { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.35); margin: 5px 0 0; line-height: 1.6; }

      .crews-avatar-grid { display: flex; gap: 6px; flex-wrap: wrap; }
      .crews-avatar-opt {
        width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-size: 14px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer;
      }
      .crews-avatar-opt.sel { background: rgba(85, 230, 247, 0.22); border-color: #55e6f7; }

      .crews-actions { display: flex; gap: 8px; margin-top: 4px; }
      .crews-save-btn {
        flex: 1; padding: 10px 12px; border-radius: 8px; border: none;
        background: #55e6f7; color: #06282c; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 12px;
        cursor: pointer;
      }
      .crews-save-btn:hover { background: #83eefb; }
      .crews-delete-btn {
        padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.18); background: transparent;
        color: rgba(255, 255, 255, 0.6); font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer;
      }
      .crews-delete-btn:hover { border-color: #b3402b; color: #ff8a70; }

      .crews-rationale {
        margin-top: 16px; padding: 11px 13px; border-radius: 9px;
        background: rgba(85, 230, 247, 0.08); border: 1px solid rgba(85, 230, 247, 0.22);
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; line-height: 1.8; color: rgba(255, 255, 255, 0.55);
      }

      /* サマリーカードのペルソナのヘックスを長押しすると出る、人物情報・その言葉の閲覧/コピー用ポップアップ */
      .crews-info-overlay {
        position: fixed; inset: 0; z-index: 130;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity 0.18s ease-out; padding: 16px;
      }
      .crews-info-overlay.open { opacity: 1; pointer-events: auto; }
      .crews-info-backdrop { position: absolute; inset: 0; background: rgba(6, 10, 12, 0.72); }
      .crews-info-modal {
        position: relative; width: min(92vw, 420px); max-height: 82vh; overflow-y: auto;
        background: rgba(9, 15, 18, 0.97); border: 1px solid rgba(85, 230, 247, 0.3); border-radius: 14px;
        padding: 18px 18px 20px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        transform: scale(0.94); transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .crews-info-overlay.open .crews-info-modal { transform: scale(1); }
      .crews-info-head { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }
      .crews-info-avatar {
        width: 30px; height: 30px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        font-size: 15px; background: rgba(85, 230, 247, 0.14); border: 1px solid rgba(85, 230, 247, 0.4);
      }
      .crews-info-name {
        flex: 1; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 13px; color: #fff;
      }
      .crews-info-close {
        width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(85, 230, 247, 0.3); color: rgba(255, 255, 255, 0.85);
        font-size: 12px; cursor: pointer;
      }
      .crews-info-close:hover { background: rgba(85, 230, 247, 0.25); }
      .crews-info-field { margin-bottom: 14px; }
      .crews-info-field:last-child { margin-bottom: 0; }
      .crews-info-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .crews-info-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
      }
      .crews-info-copy {
        padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(85, 230, 247, 0.35);
        background: rgba(85, 230, 247, 0.1); color: #55e6f7; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px;
        cursor: pointer;
      }
      .crews-info-copy:hover { background: rgba(85, 230, 247, 0.22); }
      .crews-info-text {
        margin: 0; padding: 9px 10px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 7px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; line-height: 1.7;
        color: rgba(255, 255, 255, 0.88); white-space: pre-wrap; word-break: break-word;
      }
    `;
    document.head.appendChild(style);
  }

  function buildDom() {
    const overlay = document.createElement('div');
    overlay.className = 'crews-overlay';
    overlay.innerHTML = `
      <div class="crews-backdrop"></div>
      <div class="crews-panel">
        <div class="crews-top">
          <span class="crews-top-label">Crews — ペルソナ管理</span>
          <button class="crews-close-btn" title="閉じる">✕</button>
        </div>
        <div class="crews-body">
          <div>
            <p class="crews-col-label">登録済み — ONのペルソナがサマリーの話し手候補になる</p>
            <div class="crews-roster"></div>
          </div>
          <div class="crews-editor">
            <p class="crews-col-label crews-editor-title">召喚フォーム — 新規</p>
            <div class="crews-field">
              <div class="crews-field-label-row">
                <span class="crews-field-label">【人物情報】— 誰か・どの文献か</span>
                <button class="crews-ocr-btn crews-ocr-person" title="カメラでOCR読み取り">${CAMERA_ICON_SVG}</button>
              </div>
              <textarea class="crews-field-input crews-person-info" rows="3" placeholder="例: グスタフソン&ハーポヤ『つぼみの本』に登場する、森のそばで長く暮らしてきた人物。"></textarea>
            </div>
            <div class="crews-field">
              <div class="crews-field-label-row">
                <span class="crews-field-label">【その言葉】— 本人の言葉をそのまま引用</span>
                <button class="crews-ocr-btn crews-ocr-words" title="カメラでOCR読み取り">${CAMERA_ICON_SVG}</button>
              </div>
              <textarea class="crews-field-input crews-their-words" rows="5" placeholder="本の一節などをそのまま。長ければカメラで複数回読み取って構いません(追記されます)。"></textarea>
              <p class="crews-field-hint">口調・人となりはこの引用そのものから読み取られます。性別や職業を別途指定する欄はありません。</p>
            </div>
            <div class="crews-field">
              <div class="crews-field-label-row"><span class="crews-field-label">似顔絵(任意・APIは使わない)</span></div>
              <div class="crews-avatar-grid"></div>
            </div>
            <div class="crews-actions">
              <button class="crews-save-btn">ロスターに保存する</button>
              <button class="crews-delete-btn" hidden>削除</button>
            </div>
          </div>
        </div>
        <p class="crews-rationale">保存時にGeminiは呼びません。実際にこの人格になりきって語らせるのは、サマリーカード上でこのペルソナのヘックスを押した瞬間だけです(Education/Academicと同じ1回のAPI呼び出し)。長押しすると、召喚時に入力した【人物情報】【その言葉】をいつでも見返せます(コピーも可能)。</p>
      </div>
    `;
    document.body.appendChild(overlay);

    crEls = {
      overlay,
      panel: overlay.querySelector('.crews-panel'),
      roster: overlay.querySelector('.crews-roster'),
      editorTitle: overlay.querySelector('.crews-editor-title'),
      personInfo: overlay.querySelector('.crews-person-info'),
      theirWords: overlay.querySelector('.crews-their-words'),
      ocrPersonBtn: overlay.querySelector('.crews-ocr-person'),
      ocrWordsBtn: overlay.querySelector('.crews-ocr-words'),
      avatarGrid: overlay.querySelector('.crews-avatar-grid'),
      saveBtn: overlay.querySelector('.crews-save-btn'),
      deleteBtn: overlay.querySelector('.crews-delete-btn'),
    };

    [crEls.personInfo, crEls.theirWords].forEach((ta) => {
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    crEls.overlay.querySelector('.crews-close-btn').addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.overlay.querySelector('.crews-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeCrews();
    });
    crEls.overlay.querySelector('.crews-backdrop').addEventListener('click', closeCrews);

    crEls.ocrPersonBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.ocrPersonBtn.addEventListener('click', (e) => { e.stopPropagation(); ocrIntoTextarea(crEls.personInfo, crEls.ocrPersonBtn); });
    crEls.ocrWordsBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.ocrWordsBtn.addEventListener('click', (e) => { e.stopPropagation(); ocrIntoTextarea(crEls.theirWords, crEls.ocrWordsBtn); });

    crEls.saveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.saveBtn.addEventListener('click', (e) => { e.stopPropagation(); savePersona(); });
    crEls.deleteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deletePersona(); });

    // スワイプで閉じる(モジュール共通デザイン言語)。パネル内部からのスワイプはテキスト選択・
    // スクロール操作と紛れるため、背景(バックドロップ)から始まった場合だけ判定する。
    let swipeStartX = null;
    let swipeStartY = null;
    let swipeStartT = 0;
    overlay.querySelector('.crews-backdrop').addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX;
      swipeStartY = e.clientY;
      swipeStartT = performance.now();
    });
    overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX;
      const dy = e.clientY - swipeStartY;
      const dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeCrews();
    });
  }

  /* ---------------- データアクセス(app.js側から window 経由で参照される) ---------------- */

  function getEnabledCrews() {
    return (state.crews || []).filter((c) => c.enabled);
  }

  function getCrewById(id) {
    return (state.crews || []).find((c) => c.id === id) || null;
  }

  /**
   * サマリーカードのヘックス行に追加するHTML(js/app.js の summaryCardInnerHtml() から呼ばれる)。
   * 「名前：役割」形式は長くなりうるため、名前部分は.nameでラップしてCSS側(css/style.css)で
   * 省略記号(…)にする。フルネームはtitle属性(ホバー/長押しで見える)に残す。
   */
  function crewsSummaryHexButtonsHtml() {
    return getEnabledCrews()
      .map((c) => (
        `<button class="star-card-summary-crew-btn" data-crew-id="${c.id}" title="${escapeAttr(c.personInfo)}">` +
        `<span class="emoji">${escapeHtmlLocal(c.avatar || '👤')}</span>` +
        `<span class="name">${escapeHtmlLocal(c.name || '(無名)')}</span></button>`
      ))
      .join('');
  }

  function escapeHtmlLocal(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return escapeHtmlLocal(str).replace(/"/g, '&quot;');
  }

  /** 【人物情報】の冒頭から表示名を自動生成する(句読点・改行で区切って短く、API不使用) */
  function deriveName(personInfo) {
    const firstLine = (personInfo || '').trim().split(/\n/)[0] || '';
    const firstClause = firstLine.split(/[。、,.]/)[0] || firstLine;
    return firstClause.trim().slice(0, 22) || '(無名のペルソナ)';
  }

  /* ---------------- ロスター / 編集フォーム ---------------- */

  function renderRoster() {
    const list = crEls.roster;
    list.innerHTML = '';
    const crews = state.crews || [];
    if (!crews.length) {
      const empty = document.createElement('p');
      empty.className = 'crews-roster-empty';
      empty.textContent = 'まだペルソナがいません。右のフォームから召喚してください。';
      list.appendChild(empty);
    }
    crews.forEach((crew) => {
      const chip = document.createElement('div');
      chip.className = 'crews-chip' + (crew.enabled ? ' on' : '') + (crew.id === editingId ? ' editing' : '');
      chip.innerHTML = `
        <div class="crews-chip-avatar">${escapeHtmlLocal(crew.avatar || '👤')}</div>
        <div class="crews-chip-meta">
          <div class="crews-chip-name">${escapeHtmlLocal(crew.name || '(無名)')}</div>
          <div class="crews-chip-src">${escapeHtmlLocal((crew.personInfo || '').slice(0, 28))}</div>
        </div>
        <div class="crews-chip-toggle">${crew.enabled ? '✓' : ''}</div>
      `;
      const toggleEl = chip.querySelector('.crews-chip-toggle');
      toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        crew.enabled = !crew.enabled;
        scheduleAutoSave();
        renderRoster();
        renderAllCards();
      });
      chip.addEventListener('click', () => loadPersonaIntoEditor(crew.id));
      list.appendChild(chip);
    });
    const addBtn = document.createElement('div');
    addBtn.className = 'crews-add';
    addBtn.textContent = '+ 新しいペルソナを召喚';
    addBtn.addEventListener('click', startNewPersona);
    list.appendChild(addBtn);
  }

  function renderAvatarGrid() {
    crEls.avatarGrid.innerHTML = AVATAR_PALETTE
      .map((em) => `<div class="crews-avatar-opt${em === pendingAvatar ? ' sel' : ''}" data-em="${escapeAttr(em)}">${em}</div>`)
      .join('');
    crEls.avatarGrid.querySelectorAll('.crews-avatar-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        pendingAvatar = opt.dataset.em;
        renderAvatarGrid();
      });
    });
  }

  function startNewPersona() {
    editingId = null;
    pendingAvatar = AVATAR_PALETTE[0];
    crEls.editorTitle.textContent = '召喚フォーム — 新規';
    crEls.personInfo.value = '';
    crEls.theirWords.value = '';
    crEls.deleteBtn.hidden = true;
    renderAvatarGrid();
    renderRoster();
  }

  function loadPersonaIntoEditor(id) {
    const crew = getCrewById(id);
    if (!crew) return;
    editingId = id;
    pendingAvatar = crew.avatar || AVATAR_PALETTE[0];
    crEls.editorTitle.textContent = `召喚フォーム — 編集中「${crew.name || '(無名)'}」`;
    crEls.personInfo.value = crew.personInfo || '';
    crEls.theirWords.value = crew.theirWords || '';
    crEls.deleteBtn.hidden = false;
    renderAvatarGrid();
    renderRoster();
  }

  function savePersona() {
    const personInfo = crEls.personInfo.value.trim();
    const theirWords = crEls.theirWords.value.trim();
    if (!personInfo) {
      setStatus('【人物情報】を入力してください');
      return;
    }
    if (!state.crews) state.crews = [];
    let crew = editingId ? getCrewById(editingId) : null;
    if (crew) {
      crew.personInfo = personInfo;
      crew.theirWords = theirWords;
      crew.name = deriveName(personInfo);
      crew.avatar = pendingAvatar;
    } else {
      crew = {
        id: crypto.randomUUID(),
        personInfo,
        theirWords,
        name: deriveName(personInfo),
        avatar: pendingAvatar,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      state.crews.push(crew);
      editingId = crew.id;
    }
    scheduleAutoSave();
    loadPersonaIntoEditor(crew.id);
    renderAllCards(); // サマリーカードのヘックス行へ即座に反映する
    setStatus(`ペルソナ「${crew.name}」を保存しました`);
  }

  function deletePersona() {
    if (!editingId) return;
    const crew = getCrewById(editingId);
    if (!crew) return;
    if (!window.confirm(`「${crew.name}」を削除しますか?(このペルソナが既に生成したカードは残ります)`)) return;
    state.crews = (state.crews || []).filter((c) => c.id !== editingId);
    scheduleAutoSave();
    startNewPersona();
    renderAllCards();
    setStatus('ペルソナを削除しました');
  }

  /* ---------------- OCR(カメラでキャプション読み取り、js/camera.js を流用) ----------------
   * 【人物情報】【その言葉】は長文になりうるため、ボタン横に📷を置いてその場で撮影→読み取り
   * できるようにする。1回で足りなければ何度でも追記できる(既存の内容の末尾に改行して足す)。 */
  async function ocrIntoTextarea(textareaEl, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const result = await openCamera('caption');
      if (!result || result.kind !== 'text' || !result.text.trim()) return;
      const existing = textareaEl.value.trim();
      textareaEl.value = existing ? `${existing}\n${result.text.trim()}` : result.text.trim();
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  /* ---------------- 開閉(ペルソナ管理パネル) ---------------- */

  function openCrews() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!crEls) buildDom();
    renderRoster();
    if (editingId && getCrewById(editingId)) {
      loadPersonaIntoEditor(editingId);
    } else {
      startNewPersona();
    }
    crEls.overlay.classList.add('open');
  }

  function closeCrews() {
    if (crEls) crEls.overlay.classList.remove('open');
  }

  /* ---------------- 情報ポップアップ(サマリーカードのヘックスを長押しすると開く) ----------------
   * ニックネーム(表示名)だけでは元の人物情報を思い出せない、というユーザー要望を受けて追加。
   * 【人物情報】【その言葉】を全文表示し、それぞれコピーボタンを付ける。生成(=summarizeSession()
   * の呼び出し)は一切行わない、完全にローカルな閲覧機能。 */

  function buildInfoPopupDom() {
    const overlay = document.createElement('div');
    overlay.className = 'crews-info-overlay';
    overlay.innerHTML = `
      <div class="crews-info-backdrop"></div>
      <div class="crews-info-modal">
        <div class="crews-info-head">
          <span class="crews-info-avatar"></span>
          <span class="crews-info-name"></span>
          <button class="crews-info-close" title="閉じる">✕</button>
        </div>
        <div class="crews-info-field">
          <div class="crews-info-label-row">
            <span class="crews-info-label">【人物情報】</span>
            <button class="crews-info-copy" data-target="person">コピー</button>
          </div>
          <p class="crews-info-text crews-info-text-person"></p>
        </div>
        <div class="crews-info-field">
          <div class="crews-info-label-row">
            <span class="crews-info-label">【その言葉】</span>
            <button class="crews-info-copy" data-target="words">コピー</button>
          </div>
          <p class="crews-info-text crews-info-text-words"></p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    infoPopupEls = {
      overlay,
      avatar: overlay.querySelector('.crews-info-avatar'),
      name: overlay.querySelector('.crews-info-name'),
      personText: overlay.querySelector('.crews-info-text-person'),
      wordsText: overlay.querySelector('.crews-info-text-words'),
    };

    overlay.querySelector('.crews-info-close').addEventListener('click', hideCrewInfoPopup);
    overlay.querySelector('.crews-info-backdrop').addEventListener('click', hideCrewInfoPopup);
    overlay.querySelectorAll('.crews-info-copy').forEach((btn) => {
      btn.addEventListener('click', () => copyInfoPopupField(btn));
    });
  }

  async function copyInfoPopupField(btn) {
    const text = btn.dataset.target === 'person' ? infoPopupEls.personText.textContent : infoPopupEls.wordsText.textContent;
    const original = btn.textContent;
    const ok = await copyTextToClipboard(text || '');
    btn.textContent = ok ? 'コピーしました' : 'コピーできません';
    if (!ok) setStatus('コピーに失敗しました(ブラウザの権限を確認してください)', { important: true });
    setTimeout(() => { btn.textContent = original; }, 1200);
  }

  /**
   * navigator.clipboard.writeText()はモバイルブラウザによって権限まわりの挙動が揺れる
   * (許可プロンプトへの応答待ちのままpromiseがresolve/rejectどちらもせず固まる、等)。
   * 一定時間で諦めてdocument.execCommand('copy')にフォールバックし、ボタンが「コピー」の
   * まま無反応になり続けることのないようにする。
   * @returns {Promise<boolean>} コピーできたか
   */
  function copyTextToClipboard(text) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => finish(execCommandCopy(text)));
        setTimeout(() => finish(execCommandCopy(text)), 1500);
      } else {
        finish(execCommandCopy(text));
      }
    });
  }

  function execCommandCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  /** @param {string} crewId js/app.jsのwireSummaryCard()から、ヘックスの長押しで呼ばれる */
  function showCrewInfoPopup(crewId) {
    const crew = getCrewById(crewId);
    if (!crew) return;
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!infoPopupEls) buildInfoPopupDom();
    infoPopupEls.avatar.textContent = crew.avatar || '👤';
    infoPopupEls.name.textContent = crew.name || '(無名)';
    infoPopupEls.personText.textContent = crew.personInfo || '';
    infoPopupEls.wordsText.textContent = crew.theirWords || '(未入力)';
    infoPopupEls.overlay.classList.add('open');
  }

  function hideCrewInfoPopup() {
    if (infoPopupEls) infoPopupEls.overlay.classList.remove('open');
  }

  // 起動ジェスチャーはjs/module-launcher.js(背景2本指ダブルタップ→キーパッド)に一本化されている。
  // このモジュールはコード("456")を登録するだけでよい。
  registerModuleCode('456', openCrews);

  // js/app.js側からの参照口(要約カードのヘックス描画・生成・長押し閲覧で使う)。
  window.getCrewById = getCrewById;
  window.crewsSummaryHexButtonsHtml = crewsSummaryHexButtonsHtml;
  window.showCrewInfoPopup = showCrewInfoPopup;
  window.openCrews = openCrews;
})();
