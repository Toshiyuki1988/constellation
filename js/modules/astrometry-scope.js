// CONSTELLATION — Module: Astrometry Scope
//
// 写真カードに写っている美術作品を、Geminiに1回だけ問い合わせて色彩・素材・美術史上の
// 位置(系譜)・4つの文脈(日本美術史/西洋美術史/現代美術史/現在の視点)の複合分析を
// 行わせる「鑑定スコープ」。CLAUDE.mdの「モジュール」規約に従い、このファイル全体を
// IIFEで包んでトップレベルの名前をグローバルへ漏らさない。
// state / els / escapeHtml() / setStatus() / scheduleAutoSave() / getFileBlobUrlCached() /
// getQueuedEntryBlob() / askGemini() / soundAudioCtx() / playScopeScanSound() /
// playScopeCompleteSound() など、既存のグローバルをそのまま参照する。
//
// 実装前に単体HTMLのモックアップ(astrometry-scope-mockup.html、2026年9月、git未管理)で
// 見た目・操作感・API呼び出し1回あたりのJSON構造を検証してから本実装した。実アプリへの
// 統合にあたり、モックアップから以下を変更している。
// - モックアップ独自の⚙APIキー設定・MOCK/LIVEモード切り替えは撤去した。実アプリは既に
//   設定モーダルでCONFIG.GEMINI_API_KEYを一元管理しているため、素直にaskGemini()
//   (js/gemini.js)をそのまま呼べばよく、モジュール側で別のキー置き場を持つ必要がない。
// - 系譜(Historical Position)の参照点には、モックアップの解析結果と同様、実際の画像は
//   一切載せない(著作権状態の判定を都度行うのは非現実的なため、分析文+Google検索リンクの
//   みに統一。プロンプト自体もimageフィールドを要求しない)。
//
// 起動は2通り:
// 1. 写真カードの編集ガイド「Scope」ヘックス(画像カードのみ、js/app.js側でscopeHexとして
//    追加済み)を押すと、その写真の画像・メモ欄からの簡易的な作品名/作者名の推測を
//    あらかじめ読み込んだ状態でwindow.openAstrometryScope(card)が呼ばれる。
// 2. モジュール共通の起動基盤(js/module-launcher.js)経由、キーパッドで"258"
//    (電話キーパッドの中央列。123=WormGate・456=Crews・789=Mapping Storysで洛書の3行、
//    147=Flight Engineerで左列を使っているため、残る中央列を割り当てた)と入力すると、
//    対象の写真を持たない状態(window.openAstrometryScope())で開く。この場合は
//    モックアップ由来の「現地で撮った写真を読み込む」アップロード/ドラッグ&ドロップで
//    対象を手動で用意する(結果はどのカードにも紐付かないため保存されない)。
//
// 走査結果の保存・後日の見返し(2026年9月、ユーザー要望): 写真カードから起動した場合のみ、
// 1回の走査(=1回のGemini呼び出し)ごとの結果を card.astrometryScans(配列)へ追記し、
// 既存のconstellation-data.jsonへ通常のカードデータと同じくオートセーブされる。パネルを
// 再度開くと最新の走査結果を(APIを呼ばずに)自動表示し、「過去の走査」欄から過去の結果へ
// 何度でも遡って見返せる。件数はASTROMETRY_HISTORY_MAX件までで古い方から切り捨てる
// (コメント履歴等、このアプリの他の履歴データと同じ考え方)。

(function () {
  'use strict';

  const ASTROMETRY_HISTORY_MAX = 20;

  let stylesInjected = false;
  let asEls = null;
  let currentCard = null; // 起動元の写真カード(標準起動時はnull)
  let currentScanData = null; // 現在パネルに表示中の走査結果レコード
  let currentContexts = null; // 表示中レコードのcontexts(タブ切り替え用)
  let lineageByQuery = {};
  let currentCtx = 'jp';
  let typingTimer = null;
  let scanning = false;
  let ownedTargetUrl = null; // モジュール自身がURL.createObjectURL()したURL(閉じる/差し替え時に解放する)

  /* ==================== スタイル ==================== */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .asc-overlay {
        --asc-void: #04070c;
        --asc-void-2: #070d15;
        --asc-panel: rgba(12, 21, 30, 0.86);
        --asc-panel-solid: #0b1219;
        --asc-grid-line: #17303f;
        --asc-grid-line-soft: rgba(23, 48, 63, 0.55);
        --asc-phosphor: #5eead4;
        --asc-phosphor-dim: rgba(94, 234, 212, 0.35);
        --asc-amber: #f5a623;
        --asc-star: #eaf6f2;
        --asc-dim: #5f7d82;
        --asc-dim-2: #3d5259;
        position: fixed; inset: 0; z-index: 145;
        display: flex; align-items: center; justify-content: center;
        padding: clamp(10px, 3vw, 26px);
        overflow-y: auto;
        background: rgba(2, 4, 7, 0.72);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        opacity: 0; pointer-events: none;
        transition: opacity 0.2s ease-out;
      }
      .asc-overlay.open { opacity: 1; pointer-events: auto; }

      .asc-scope {
        width: 100%; max-width: 1180px; margin: auto;
        border: 1px solid var(--asc-phosphor-dim);
        border-radius: 14px;
        background: linear-gradient(180deg, rgba(255,255,255,0.02), transparent 12%), var(--asc-panel);
        box-shadow: 0 0 0 1px rgba(94,234,212,0.1), 0 0 32px -10px rgba(94,234,212,0.3), 0 40px 90px -40px rgba(0,0,0,0.85);
        overflow: hidden;
        position: relative;
        color: var(--asc-star);
        transform: scale(0.96) translateY(6px);
        transition: transform 0.2s ease-out;
      }
      .asc-overlay.open .asc-scope { transform: scale(1) translateY(0); }

      .asc-head {
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        padding: 16px 20px; border-bottom: 1px solid var(--asc-grid-line);
        cursor: grab;
      }
      .asc-head-id { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
      .asc-title {
        font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: clamp(15px, 2.2vw, 20px);
        letter-spacing: 0.05em; margin: 0; color: var(--asc-star);
      }
      .asc-title span { color: var(--asc-phosphor); text-shadow: 0 0 14px var(--asc-phosphor); }
      .asc-subtitle { font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.06em; color: var(--asc-dim); text-transform: uppercase; }
      .asc-status { display: flex; align-items: center; gap: 9px; font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.05em; color: var(--asc-dim); }
      .asc-led { width: 7px; height: 7px; border-radius: 50%; background: var(--asc-phosphor); box-shadow: 0 0 8px 1px var(--asc-phosphor); animation: asc-pulse 2.4s ease-in-out infinite; }
      @keyframes asc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      @media (prefers-reduced-motion: reduce) { .asc-led { animation: none; } }
      .asc-close {
        width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--asc-grid-line);
        background: rgba(255,255,255,0.03); color: var(--asc-dim); font-size: 13px; line-height: 1;
        cursor: pointer; display: grid; place-items: center; transition: color 0.15s, border-color 0.15s;
      }
      .asc-close:hover { color: var(--asc-star); border-color: var(--asc-phosphor-dim); }

      .asc-body { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); gap: 1px; background: var(--asc-grid-line); }
      @media (max-width: 760px) { .asc-body { grid-template-columns: 1fr; } }
      .asc-pane { background: var(--asc-void-2); padding: 16px 18px; }

      .asc-pane-label {
        display: flex; align-items: center; gap: 7px; font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.09em; color: var(--asc-phosphor); text-transform: uppercase; margin: 0 0 12px;
      }
      .asc-pane-label::before { content: '◈'; font-size: 9px; }
      .asc-pane-label small { font-family: 'Zen Kaku Gothic New', sans-serif; color: var(--asc-dim); letter-spacing: 0; text-transform: none; font-size: 10.5px; }

      .asc-target-meta { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: var(--asc-dim); display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin-bottom: 12px; }
      .asc-target-meta dt { color: var(--asc-dim-2); }
      .asc-target-meta dd { margin: 0; color: var(--asc-star); outline: none; border-bottom: 1px dashed var(--asc-phosphor-dim); cursor: text; min-height: 1.4em; }
      .asc-target-meta dd:empty::before { content: '(未入力・タップして編集)'; color: var(--asc-dim-2); }

      .asc-upload-btn {
        width: 100%; margin-bottom: 9px; padding: 7px; font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.03em; color: var(--asc-dim); background: rgba(255,255,255,0.02); border: 1px dashed var(--asc-grid-line);
        border-radius: 6px; cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s;
      }
      .asc-upload-btn:hover { color: var(--asc-star); border-color: var(--asc-phosphor-dim); background: rgba(94,234,212,0.05); }

      .asc-viewport-frame { position: relative; border: 1px solid var(--asc-grid-line); border-radius: 8px; aspect-ratio: 4 / 3; overflow: hidden; background: #030608; }
      .asc-viewport-frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; }
      .asc-viewport-frame.drag-over { border-color: var(--asc-phosphor); box-shadow: inset 0 0 0 2px var(--asc-phosphor-dim); }
      .asc-drop-hint {
        position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(4,7,12,0.78);
        color: var(--asc-phosphor); font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.05em; text-align: center;
        padding: 16px; opacity: 0; pointer-events: none; transition: opacity 0.15s; z-index: 5;
      }
      .asc-viewport-frame.drag-over .asc-drop-hint { opacity: 1; }
      .asc-corner { position: absolute; width: 14px; height: 14px; border: 2px solid var(--asc-phosphor-dim); pointer-events: none; }
      .asc-corner.tl { top: 6px; left: 6px; border-right: none; border-bottom: none; }
      .asc-corner.tr { top: 6px; right: 6px; border-left: none; border-bottom: none; }
      .asc-corner.bl { bottom: 6px; left: 6px; border-right: none; border-top: none; }
      .asc-corner.br { bottom: 6px; right: 6px; border-left: none; border-top: none; }
      .asc-scan-sweep {
        position: absolute; left: 0; right: 0; height: 2px; top: -5%; opacity: 0;
        background: linear-gradient(90deg, transparent, var(--asc-phosphor), transparent);
        box-shadow: 0 0 12px 2px var(--asc-phosphor-dim); pointer-events: none;
      }
      .asc-scan-sweep.scanning { animation: asc-sweep 1.4s linear infinite; opacity: 1; }
      @keyframes asc-sweep { 0% { top: -5%; } 100% { top: 104%; } }
      @media (prefers-reduced-motion: reduce) { .asc-scan-sweep.scanning { animation: none; opacity: 0.5; top: 50%; } }

      .asc-scan-btn {
        margin-top: 14px; width: 100%; padding: 10px; font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; letter-spacing: 0.1em;
        color: var(--asc-phosphor); background: linear-gradient(180deg, rgba(94,234,212,0.14), rgba(94,234,212,0.05));
        border: 1px solid var(--asc-phosphor-dim); border-radius: 6px; cursor: pointer; transition: background 0.15s, box-shadow 0.15s;
      }
      .asc-scan-btn:hover:not(:disabled) { background: rgba(94,234,212,0.22); box-shadow: 0 0 20px -4px var(--asc-phosphor); }
      .asc-scan-btn:disabled { opacity: 0.4; cursor: default; box-shadow: none; }
      .asc-scan-btn .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 7px; vertical-align: middle; }

      .asc-history { margin-top: 14px; }
      .asc-history-row { display: flex; flex-wrap: wrap; gap: 6px; }
      .asc-history-btn {
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.03em; color: var(--asc-dim);
        background: transparent; border: 1px solid var(--asc-grid-line); border-radius: 5px; padding: 5px 9px; cursor: pointer;
        transition: color 0.15s, border-color 0.15s, background 0.15s;
      }
      .asc-history-btn:hover { color: var(--asc-star); border-color: var(--asc-dim-2); }
      .asc-history-btn.active { color: var(--asc-void); background: var(--asc-phosphor); border-color: var(--asc-phosphor); }

      .asc-api-note { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: var(--asc-dim-2); letter-spacing: 0.02em; margin: 10px 0 0; line-height: 1.6; }

      .asc-data-section { border: 1px solid var(--asc-grid-line); border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
      .asc-data-section:last-child { margin-bottom: 0; }
      .asc-data-placeholder { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: var(--asc-dim-2); letter-spacing: 0.02em; }

      .asc-spectrum-row { display: flex; align-items: center; gap: 9px; margin-bottom: 7px; }
      .asc-spectrum-row:last-child { margin-bottom: 0; }
      .asc-swatch { width: 20px; height: 20px; border-radius: 4px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.15); }
      .asc-spectrum-info { flex: 1; min-width: 0; }
      .asc-spectrum-name { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; color: var(--asc-star); }
      .asc-spectrum-hex { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: var(--asc-dim); }
      .asc-spectrum-bar { width: 56px; height: 4px; border-radius: 2px; background: var(--asc-grid-line); overflow: hidden; flex-shrink: 0; }
      .asc-spectrum-bar i { display: block; height: 100%; background: var(--asc-phosphor); }

      .asc-material-tags { display: flex; flex-wrap: wrap; gap: 6px; }
      .asc-material-tag {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.02em; color: var(--asc-star);
        background: rgba(94,234,212,0.08); border: 1px solid var(--asc-phosphor-dim); border-radius: 4px; padding: 4px 7px;
      }
      .asc-material-tag small { display: block; font-family: 'Zen Kaku Gothic New', sans-serif; color: var(--asc-dim); font-size: 9px; margin-top: 1px; }

      .asc-plot-wrap { width: 100%; }
      .asc-plot-wrap svg { width: 100%; height: auto; display: block; }
      .asc-plot-axis-label { font-family: 'IBM Plex Mono', monospace; font-size: 8px; fill: var(--asc-dim); letter-spacing: 0.03em; }
      .asc-plot-point-label { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 9px; fill: var(--asc-star); }
      .asc-plot-legend { display: flex; gap: 12px; margin-top: 7px; flex-wrap: wrap; }
      .asc-plot-legend-item { display: flex; align-items: center; gap: 5px; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; color: var(--asc-dim); }
      .asc-plot-legend-dot { width: 7px; height: 7px; border-radius: 50%; }
      .asc-plot-node { cursor: pointer; }
      .asc-plot-node.asc-plot-node--self { cursor: default; }
      .asc-plot-node:not(.asc-plot-node--self):hover circle.dot { filter: drop-shadow(0 0 4px currentColor) brightness(1.4); }
      .asc-plot-node:not(.asc-plot-node--self):hover .asc-plot-point-label { fill: var(--asc-phosphor); }

      .asc-log-pane { grid-column: 1 / -1; background: var(--asc-void-2); border-top: 1px solid var(--asc-grid-line); padding: 16px 20px 18px; }
      .asc-log-tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
      .asc-log-tab {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.05em; color: var(--asc-dim); background: transparent;
        border: 1px solid var(--asc-grid-line); border-radius: 5px; padding: 6px 11px; cursor: pointer; transition: color 0.15s, border-color 0.15s, background 0.15s;
      }
      .asc-log-tab .jp { font-family: 'Zen Kaku Gothic New', sans-serif; margin-left: 4px; }
      .asc-log-tab.active { color: var(--asc-void); background: var(--asc-phosphor); border-color: var(--asc-phosphor); }
      .asc-log-tab:not(.active):hover { color: var(--asc-star); border-color: var(--asc-dim-2); }
      .asc-log-body { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 13.5px; line-height: 1.8; color: var(--asc-star); min-height: 90px; max-width: 68ch; }
      .asc-log-idle { color: var(--asc-dim); font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.02em; }

      .asc-plot-popup-overlay {
        position: fixed; inset: 0; background: rgba(2,4,7,0.72); backdrop-filter: blur(4px); display: flex; align-items: center;
        justify-content: center; z-index: 150; padding: 20px; opacity: 0; pointer-events: none; transition: opacity 0.18s ease;
      }
      .asc-plot-popup-overlay.open { opacity: 1; pointer-events: auto; }
      .asc-plot-popup {
        width: 100%; max-width: 400px; background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent 20%), var(--asc-panel-solid);
        border: 1px solid var(--asc-phosphor-dim); border-radius: 10px; box-shadow: 0 30px 70px -20px rgba(0,0,0,0.85), 0 0 30px -10px var(--asc-phosphor-dim);
        padding: 18px 20px; transform: scale(0.96) translateY(6px); transition: transform 0.18s ease; color: var(--asc-star);
      }
      .asc-plot-popup-overlay.open .asc-plot-popup { transform: scale(1) translateY(0); }
      .asc-plot-popup-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
      .asc-plot-popup-title { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 15px; font-weight: 700; color: var(--asc-star); margin: 0; }
      .asc-plot-popup-sub { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: var(--asc-dim); letter-spacing: 0.03em; margin-top: 3px; }
      .asc-plot-popup-close {
        width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--asc-grid-line); background: rgba(255,255,255,0.03);
        color: var(--asc-dim); cursor: pointer; display: grid; place-items: center; font-size: 13px; transition: color 0.15s, border-color 0.15s;
      }
      .asc-plot-popup-close:hover { color: var(--asc-star); border-color: var(--asc-phosphor-dim); }
      .asc-plot-popup-label { font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.07em; color: var(--asc-phosphor); text-transform: uppercase; margin: 12px 0 6px; }
      .asc-plot-popup-body { font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 13px; line-height: 1.8; color: var(--asc-star); }
      .asc-plot-popup-search {
        display: inline-flex; align-items: center; gap: 6px; margin-top: 14px; font-family: 'IBM Plex Mono', monospace; font-size: 10px;
        letter-spacing: 0.03em; color: var(--asc-phosphor); text-decoration: none; border: 1px solid var(--asc-phosphor-dim); border-radius: 6px;
        padding: 7px 12px; cursor: pointer; background: rgba(94,234,212,0.06); transition: background 0.15s;
      }
      .asc-plot-popup-search:hover { background: rgba(94,234,212,0.18); }
    `;
    document.head.appendChild(style);
  }

  /* ==================== DOM構築 ==================== */

  function buildDom() {
    const overlay = document.createElement('div');
    overlay.className = 'asc-overlay';
    overlay.innerHTML = `
      <div class="asc-scope">
        <div class="asc-head">
          <div class="asc-head-id">
            <h2 class="asc-title">ASTROMETRY <span>SCOPE</span></h2>
            <span class="asc-subtitle">位置天文学的美術鑑定システム</span>
          </div>
          <div class="asc-status">
            <span class="asc-led" aria-hidden="true"></span>
            <span class="asc-status-text">STANDBY</span>
            <button type="button" class="asc-close" title="閉じる" aria-label="閉じる">✕</button>
          </div>
        </div>
        <div class="asc-body">
          <div class="asc-pane">
            <p class="asc-pane-label">Target Acquisition <small>対象の捕捉</small></p>
            <dl class="asc-target-meta">
              <dt>OBJECT</dt><dd class="asc-field-object" contenteditable="true"></dd>
              <dt>ARTIST</dt><dd class="asc-field-artist" contenteditable="true"></dd>
              <dt>ERA</dt><dd class="asc-field-era" contenteditable="true"></dd>
              <dt>SERIES</dt><dd class="asc-field-series" contenteditable="true"></dd>
            </dl>
            <button type="button" class="asc-upload-btn">📷 写真を読み込んでスキャン対象を差し替える(この端末内だけで処理・非公開)</button>
            <input type="file" accept="image/*" class="asc-file-input" hidden>
            <div class="asc-viewport-frame">
              <img class="asc-target-image" alt="">
              <div class="asc-corner tl"></div><div class="asc-corner tr"></div>
              <div class="asc-corner bl"></div><div class="asc-corner br"></div>
              <div class="asc-scan-sweep"></div>
              <div class="asc-drop-hint">画像をドロップしてスキャン対象にする</div>
            </div>
            <button type="button" class="asc-scan-btn" disabled><span class="dot"></span>SCAN INITIATE — 走査開始</button>
            <div class="asc-history" hidden>
              <p class="asc-pane-label" style="margin:12px 0 8px;">Archive <small>過去の走査</small></p>
              <div class="asc-history-row"></div>
            </div>
            <p class="asc-api-note">1回の走査につきGemini API呼び出しは1回だけ(色彩・素材・系譜・文脈分析をまとめて1リクエストで受け取る設計)。他の機能と共有の無料枠(1日250回)を消費します。</p>
          </div>
          <div class="asc-pane">
            <p class="asc-pane-label">Composite Readout <small>複合解析</small></p>
            <div class="asc-data-section asc-section-color">
              <p class="asc-pane-label" style="margin-bottom:9px;">Color Spectrum <small>色彩</small></p>
              <div class="asc-data-placeholder">SCAN INITIATEで解析されます</div>
            </div>
            <div class="asc-data-section asc-section-material">
              <p class="asc-pane-label" style="margin-bottom:9px;">Material Composition <small>素材構成</small></p>
              <div class="asc-data-placeholder">SCAN INITIATEで解析されます</div>
            </div>
            <div class="asc-data-section asc-section-plot">
              <p class="asc-pane-label" style="margin-bottom:5px;">Historical Position <small>美術史上の位置(横軸=年代/縦軸=文化的伝播度)</small></p>
              <div class="asc-plot-wrap">
                <svg viewBox="0 0 320 170" class="asc-plot-svg">
                  <g stroke="#17303f" stroke-width="1">
                    <line x1="34" y1="10" x2="34" y2="140"/>
                    <line x1="34" y1="140" x2="308" y2="140"/>
                  </g>
                  <text x="34" y="155" class="asc-plot-axis-label asc-plot-year-min">—</text>
                  <text x="290" y="155" class="asc-plot-axis-label asc-plot-year-max">—</text>
                  <text x="4" y="14" class="asc-plot-axis-label">高</text>
                  <text x="4" y="144" class="asc-plot-axis-label">低</text>
                  <g class="asc-plot-points" opacity="0"></g>
                </svg>
              </div>
              <div class="asc-plot-legend">
                <span class="asc-plot-legend-item"><span class="asc-plot-legend-dot" style="background:#5eead4"></span>観測対象</span>
                <span class="asc-plot-legend-item"><span class="asc-plot-legend-dot" style="background:#f5a623"></span>系譜上の参照点</span>
                <span class="asc-plot-legend-item">🔍 クリックで影響関係を見る</span>
              </div>
            </div>
          </div>
          <div class="asc-log-pane">
            <p class="asc-pane-label">Contextual Analysis Log <small>文脈分析 — Gemini</small></p>
            <div class="asc-log-tabs">
              <button type="button" class="asc-log-tab active" data-ctx="jp">JP-ART<span class="jp">日本美術史</span></button>
              <button type="button" class="asc-log-tab" data-ctx="west">WEST-ART<span class="jp">西洋美術史</span></button>
              <button type="button" class="asc-log-tab" data-ctx="contemp">CONTEMP<span class="jp">現代美術史(〜2019)</span></button>
              <button type="button" class="asc-log-tab" data-ctx="contempNow">CONTEMP-NOW<span class="jp">現在の視点</span></button>
            </div>
            <div class="asc-log-body"><span class="asc-log-idle">SCAN INITIATE を押すと解析ログがここに出力されます —</span></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const popup = document.createElement('div');
    popup.className = 'asc-plot-popup-overlay';
    popup.innerHTML = `
      <div class="asc-plot-popup">
        <div class="asc-plot-popup-head">
          <div>
            <p class="asc-plot-popup-title">—</p>
            <p class="asc-plot-popup-sub">—</p>
          </div>
          <button type="button" class="asc-plot-popup-close" aria-label="閉じる">✕</button>
        </div>
        <p class="asc-plot-popup-label">Influence & Reinterpretation<span class="jp">影響を受けた部分・再解釈された部分</span></p>
        <p class="asc-plot-popup-body">—</p>
        <a class="asc-plot-popup-search" href="#" target="_blank" rel="noopener">🔍 Googleでさらに詳しく見る</a>
      </div>
    `;
    document.body.appendChild(popup);

    asEls = {
      overlay,
      scope: overlay.querySelector('.asc-scope'),
      head: overlay.querySelector('.asc-head'),
      statusText: overlay.querySelector('.asc-status-text'),
      closeBtn: overlay.querySelector('.asc-close'),
      fieldObject: overlay.querySelector('.asc-field-object'),
      fieldArtist: overlay.querySelector('.asc-field-artist'),
      fieldEra: overlay.querySelector('.asc-field-era'),
      fieldSeries: overlay.querySelector('.asc-field-series'),
      uploadBtn: overlay.querySelector('.asc-upload-btn'),
      fileInput: overlay.querySelector('.asc-file-input'),
      viewportFrame: overlay.querySelector('.asc-viewport-frame'),
      targetImage: overlay.querySelector('.asc-target-image'),
      scanSweep: overlay.querySelector('.asc-scan-sweep'),
      scanBtn: overlay.querySelector('.asc-scan-btn'),
      historyBlock: overlay.querySelector('.asc-history'),
      historyRow: overlay.querySelector('.asc-history-row'),
      colorSection: overlay.querySelector('.asc-section-color'),
      materialSection: overlay.querySelector('.asc-section-material'),
      plotSvg: overlay.querySelector('.asc-plot-svg'),
      plotPoints: overlay.querySelector('.asc-plot-points'),
      plotYearMin: overlay.querySelector('.asc-plot-year-min'),
      plotYearMax: overlay.querySelector('.asc-plot-year-max'),
      logTabs: Array.from(overlay.querySelectorAll('.asc-log-tab')),
      logBody: overlay.querySelector('.asc-log-body'),
      popupOverlay: popup,
      popupTitle: popup.querySelector('.asc-plot-popup-title'),
      popupSub: popup.querySelector('.asc-plot-popup-sub'),
      popupBody: popup.querySelector('.asc-plot-popup-body'),
      popupSearch: popup.querySelector('.asc-plot-popup-search'),
      popupClose: popup.querySelector('.asc-plot-popup-close'),
    };

    // 内部の操作がキャンバス側のジェスチャーに奪われないようにする
    overlay.querySelectorAll('button, input, [contenteditable]').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    asEls.closeBtn.addEventListener('click', closeAstrometryScope);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAstrometryScope(); });
    asEls.uploadBtn.addEventListener('click', () => asEls.fileInput.click());
    asEls.fileInput.addEventListener('change', () => {
      if (asEls.fileInput.files[0]) loadTargetImageFile(asEls.fileInput.files[0]);
    });
    asEls.targetImage.addEventListener('load', updateScanButtonState);
    asEls.scanBtn.addEventListener('click', runScan);

    ['dragenter', 'dragover'].forEach((type) => {
      asEls.viewportFrame.addEventListener(type, (e) => { e.preventDefault(); asEls.viewportFrame.classList.add('drag-over'); });
    });
    ['dragleave', 'dragend'].forEach((type) => {
      asEls.viewportFrame.addEventListener(type, () => asEls.viewportFrame.classList.remove('drag-over'));
    });
    asEls.viewportFrame.addEventListener('drop', (e) => {
      e.preventDefault();
      asEls.viewportFrame.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadTargetImageFile(file);
    });

    asEls.logTabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        asEls.logTabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        currentCtx = tab.dataset.ctx;
        typeLog(currentCtx);
      });
    });

    asEls.popupClose.addEventListener('click', closePlotPopup);
    asEls.popupOverlay.addEventListener('click', (e) => { if (e.target === asEls.popupOverlay) closePlotPopup(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (asEls.popupOverlay.classList.contains('open')) { closePlotPopup(); return; }
      if (asEls.overlay.classList.contains('open')) closeAstrometryScope();
    });

    // スワイプで左右に閉じる(モジュール共通デザイン言語)。ヘッダーの掴みバー部分から。
    let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
    asEls.head.addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX; swipeStartY = e.clientY; swipeStartT = performance.now();
    });
    overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX, dy = e.clientY - swipeStartY, dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeAstrometryScope();
    });
  }

  /* ==================== 開閉 ==================== */

  function openAstrometryScope(card) {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!asEls) buildDom();
    currentCard = card || null;
    resetPanelForCard();
    asEls.overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    playGuideRevealSound();
  }

  function closeAstrometryScope() {
    if (!asEls) return;
    asEls.overlay.classList.remove('open');
    document.body.style.overflow = '';
    closePlotPopup();
    if (ownedTargetUrl) { URL.revokeObjectURL(ownedTargetUrl); ownedTargetUrl = null; }
  }

  /* ==================== パネルのリセット・対象カードの読み込み ==================== */

  function resetPanelForCard() {
    clearInterval(typingTimer);
    currentContexts = null;
    lineageByQuery = {};
    currentScanData = null;
    currentCtx = 'jp';
    asEls.logTabs.forEach((t) => t.classList.toggle('active', t.dataset.ctx === 'jp'));
    resetResultsPanel();
    asEls.statusText.textContent = 'STANDBY';
    setTargetImage('', false);

    if (currentCard) {
      writeMetaFields(guessMetaFromMemo(currentCard.memo));
      loadCardTargetImage(currentCard);
      const scans = Array.isArray(currentCard.astrometryScans) ? currentCard.astrometryScans : [];
      renderHistoryList();
      if (scans.length > 0) showScanRecord(scans[scans.length - 1]);
    } else {
      writeMetaFields({ object: '', artist: '', era: '', series: '' });
      asEls.historyBlock.hidden = true;
    }
    updateScanButtonState();
  }

  function resetResultsPanel() {
    asEls.colorSection.innerHTML = '<p class="asc-pane-label" style="margin-bottom:9px;">Color Spectrum <small>色彩</small></p><div class="asc-data-placeholder">SCAN INITIATEで解析されます</div>';
    asEls.materialSection.innerHTML = '<p class="asc-pane-label" style="margin-bottom:9px;">Material Composition <small>素材構成</small></p><div class="asc-data-placeholder">SCAN INITIATEで解析されます</div>';
    asEls.plotPoints.innerHTML = '';
    asEls.plotPoints.style.opacity = 0;
    asEls.plotYearMin.textContent = '—';
    asEls.plotYearMax.textContent = '—';
    asEls.logBody.innerHTML = '<span class="asc-log-idle">SCAN INITIATE を押すと解析ログがここに出力されます —</span>';
  }

  /** 写真カードのキャプション(memo)から、作品名・作者名・年代・シリーズ名をベストエフォートで
   *  推測する(構造化されたキャプション欄がこのアプリに無いため)。あくまで初期値で、
   *  contenteditableなフィールドとしてユーザーが走査前に自由に修正できる。走査後は
   *  Geminiが画像を見た上での推測(resolvedMeta)で上書きされる。 */
  function guessMetaFromMemo(memo) {
    const lines = String(memo || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const result = { object: '', artist: '', era: '', series: '' };
    if (lines.length === 0) return result;
    const seriesLine = lines.find((l) => /^[「『].*[」』]$/.test(l));
    if (seriesLine) result.series = seriesLine.replace(/^[「『]/, '').replace(/[」』]$/, '');
    const eraLine = lines.find((l) => /\d{3,4}\s*年|\d{4}/.test(l));
    if (eraLine) result.era = eraLine;
    result.object = lines[0];
    const artistLine = lines.slice(1).find((l) => l !== eraLine && l !== seriesLine && l.length <= 24);
    if (artistLine) result.artist = artistLine;
    return result;
  }

  function readMetaFields() {
    return {
      object: asEls.fieldObject.textContent.trim(),
      artist: asEls.fieldArtist.textContent.trim(),
      era: asEls.fieldEra.textContent.trim(),
      series: asEls.fieldSeries.textContent.trim(),
    };
  }

  function writeMetaFields(meta) {
    meta = meta || {};
    asEls.fieldObject.textContent = meta.object || '';
    asEls.fieldArtist.textContent = meta.artist || '';
    asEls.fieldEra.textContent = meta.era || '';
    asEls.fieldSeries.textContent = meta.series || '';
  }

  /** 対象画像のURLを差し替える。ownedTargetUrl=trueなら、このモジュール自身が
   *  URL.createObjectURL()で作ったURLとして扱い、次に差し替える/閉じる時にrevokeする
   *  (getFileBlobUrlCached()が返す、アプリ全体でキャッシュ・共有されているURLは
   *  絶対にrevokeしない。他のカード表示を巻き添えに壊してしまうため)。 */
  function setTargetImage(url, owned) {
    if (ownedTargetUrl) { URL.revokeObjectURL(ownedTargetUrl); ownedTargetUrl = null; }
    if (owned && url) ownedTargetUrl = url;
    asEls.targetImage.src = url || '';
    if (url) asEls.statusText.textContent = 'TARGET LOADED';
    updateScanButtonState();
  }

  /** 写真カードの画像を読み込む。まずcard.thumbDataUrl(即表示)、次にDrive経由の本画像
   *  (card.imageFileId)またはDriveへ未送信ならアップロード待機列の実データ
   *  (card.uploadQueued、js/upload-queue.jsのgetQueuedEntryBlob())を取得できしだい
   *  差し替える。js/app.jsのloadFullMedia()と同じ「まず低解像度、届いたら差し替え」の考え方。 */
  function loadCardTargetImage(card) {
    if (card.thumbDataUrl) setTargetImage(card.thumbDataUrl, false);
    if (card.imageFileId) {
      getFileBlobUrlCached(card.imageFileId).then((url) => {
        if (currentCard === card) setTargetImage(url, false);
      }).catch(() => {});
    } else if (card.uploadQueued && typeof getQueuedEntryBlob === 'function') {
      getQueuedEntryBlob(card.id).then((blob) => {
        if (blob && currentCard === card) setTargetImage(URL.createObjectURL(blob), true);
      }).catch(() => {});
    }
  }

  /** ファイル選択・ドラッグ&ドロップ共通の読み込み(標準起動時の対象読み込み、または
   *  カード起動時に対象を差し替えたい場合の両方に使う)。ブラウザ内のObjectURLだけで
   *  完結し、どこにもアップロードしない。 */
  function loadTargetImageFile(file) {
    if (!file || file.type.indexOf('image/') !== 0) return;
    setTargetImage(URL.createObjectURL(file), true);
    if (!currentCard) {
      writeMetaFields({ object: file.name.replace(/\.[a-zA-Z0-9]+$/, ''), artist: '', era: '', series: '' });
    }
    resetResultsPanel();
    currentScanData = null;
  }

  function hasTargetImage() {
    return Boolean(asEls.targetImage.getAttribute('src'));
  }

  function updateScanButtonState() {
    asEls.scanBtn.disabled = scanning || !hasTargetImage();
  }

  /* ==================== 走査(Gemini呼び出し、1回) ==================== */

  function waitForImageReady(imgEl) {
    if (imgEl.complete && imgEl.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      imgEl.addEventListener('load', () => resolve(), { once: true });
      imgEl.addEventListener('error', () => reject(new Error('画像の読み込みに失敗しました')), { once: true });
    });
  }

  /** <img>要素の内容をJPEGのbase64へ変換する(長辺1024pxへ縮小)。ObjectURL/data URLは
   *  同一オリジン扱いのためcanvasが汚染されず変換できる(外部ホストのhttp(s)画像は
   *  このモジュールでは一切扱わない設計のため、CORS由来の失敗は起こらない)。 */
  function imageElementToBase64(imgEl) {
    const natW = imgEl.naturalWidth, natH = imgEl.naturalHeight;
    const maxSide = 1024;
    const scale = Math.min(1, maxSide / Math.max(natW, natH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(natW * scale));
    canvas.height = Math.max(1, Math.round(natH * scale));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' };
  }

  function buildAnalyzePrompt(meta) {
    return (
      'この画像は美術作品の写真です。参考情報(現地での簡易メモからの推測のため、不正確または空欄の場合があります):\n' +
      `タイトル: ${meta.object || '(不明)'}\n作者: ${meta.artist || '(不明)'}\n年代: ${meta.era || '(不明)'}\nシリーズ: ${meta.series || '(不明)'}\n\n` +
      'この作品を実際によく観察し、画像から判断できる範囲で上記の参考情報の誤りがあれば補正した上で、' +
      '次のJSON形式だけを出力してください(前置き・説明・コードブロックの記号は一切付けないこと)。\n' +
      '{\n' +
      '  "resolvedMeta": {"object":"作品名","artist":"作者名","era":"年代の表記","series":"シリーズ名(無ければ空文字)"},\n' +
      '  "colorSpectrum": [ {"name":"色名(顔料名など具体的に)","hex":"#RRGGBB","hsl":"H◯° S◯% L◯%","proportion":0から1の割合}, ... 画像に実際に写っている色を3〜4色 ],\n' +
      '  "material": [ {"code":"英語の短いコード名","label":"日本語での説明"}, ... 素材・技法の推定を3〜5個 ],\n' +
      '  "lineage": {\n' +
      '    "selfTitle": "対象作品のタイトル", "selfYear": 制作年(西暦の整数、不明なら妥当な推定値),\n' +
      '    "selfResonance": この作品自体が後世からどれだけ直接引用・言及されたかを表す0から1の指標(通常は低め),\n' +
      '    "points": [ {"title":"影響を受けた/与えた作品のタイトル","artist":"作者名","year":西暦年の整数,' +
      '"resonance":対象作品との文化的な結びつきの強さを表す0から1の値,"query":"Google検索用の文字列(作品名 作者名)",' +
      '"influence":"対象作品のどの部分が、どう影響し・再解釈されたかを100〜150字程度で"}, ... 確実に知られている関連のみ2〜4点。' +
      '不確かな場合は無理に数を埋めず少なくてよい ]\n' +
      '  },\n' +
      '  "contexts": {\n' +
      '    "jp": "日本美術史の文脈から見た分析(150〜250字)",\n' +
      '    "west": "西洋美術史の文脈から見た分析(150〜250字)",\n' +
      '    "contemp": "現代美術史(〜2019年、コロナ前)の文脈から見た分析(150〜250字)",\n' +
      '    "contempNow": "コロナ後・生成AIの台頭・各地の紛争や侵攻・脱ヨーロッパ中心主義といった現在の視点を踏まえた分析(150〜250字)"\n' +
      '  }\n' +
      '}'
    );
  }

  async function runScan() {
    if (scanning || !hasTargetImage()) return;
    scanning = true;
    updateScanButtonState();
    asEls.statusText.textContent = 'ANALYZING…';
    asEls.scanSweep.classList.add('scanning');
    playScopeScanSound();

    try {
      await waitForImageReady(asEls.targetImage);
      const meta = readMetaFields();
      const { base64, mimeType } = imageElementToBase64(asEls.targetImage);
      const raw = await askGemini({ prompt: buildAnalyzePrompt(meta), imageBase64: base64, mimeType });
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
      let data;
      try {
        data = JSON.parse(cleaned);
      } catch (err) {
        throw new Error('Geminiの応答をJSONとして解析できませんでした');
      }
      applyScanResult(data, meta);
    } catch (err) {
      console.error(err);
      asEls.statusText.textContent = 'ERROR';
      asEls.logBody.innerHTML = `<span class="asc-log-idle">解析に失敗しました: ${escapeHtml(err.message || String(err))}</span>`;
    } finally {
      scanning = false;
      asEls.scanSweep.classList.remove('scanning');
      updateScanButtonState();
    }
  }

  function applyScanResult(data, requestedMeta) {
    const resolvedMeta = data.resolvedMeta && typeof data.resolvedMeta === 'object' ? data.resolvedMeta : requestedMeta;
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      meta: {
        object: String(resolvedMeta.object || requestedMeta.object || ''),
        artist: String(resolvedMeta.artist || requestedMeta.artist || ''),
        era: String(resolvedMeta.era || requestedMeta.era || ''),
        series: String(resolvedMeta.series || requestedMeta.series || ''),
      },
      colorSpectrum: Array.isArray(data.colorSpectrum) ? data.colorSpectrum : [],
      material: Array.isArray(data.material) ? data.material : [],
      lineage: data.lineage || null,
      contexts: data.contexts && typeof data.contexts === 'object' ? data.contexts : {},
    };

    if (currentCard) {
      saveScanToCard(currentCard, record);
      renderHistoryList();
    }
    showScanRecord(record);
    asEls.statusText.textContent = 'SCAN COMPLETE';
    playScopeCompleteSound();
  }

  function saveScanToCard(card, record) {
    if (!Array.isArray(card.astrometryScans)) card.astrometryScans = [];
    card.astrometryScans.push(record);
    if (card.astrometryScans.length > ASTROMETRY_HISTORY_MAX) {
      card.astrometryScans.splice(0, card.astrometryScans.length - ASTROMETRY_HISTORY_MAX);
    }
    scheduleAutoSave();
  }

  /* ==================== 過去の走査結果の表示(履歴、APIを呼ばない) ==================== */

  function formatScanTimeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderHistoryList() {
    const scans = currentCard && Array.isArray(currentCard.astrometryScans) ? currentCard.astrometryScans : [];
    asEls.historyBlock.hidden = scans.length === 0;
    asEls.historyRow.innerHTML = '';
    scans.slice().reverse().forEach((rec) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'asc-history-btn' + (currentScanData && currentScanData.id === rec.id ? ' active' : '');
      btn.textContent = formatScanTimeLabel(rec.createdAt);
      btn.addEventListener('click', () => showScanRecord(rec));
      asEls.historyRow.appendChild(btn);
    });
  }

  /** 保存済みの走査結果(または直後の走査結果)を、APIを呼ばずにそのままパネルへ表示する。 */
  function showScanRecord(record) {
    currentScanData = record;
    writeMetaFields(record.meta || {});
    renderColorSpectrum(record.colorSpectrum || []);
    renderMaterialTags(record.material || []);
    renderLineagePlot(record.lineage);
    currentContexts = record.contexts || {};
    typeLog(currentCtx, true);
    asEls.statusText.textContent = 'ARCHIVED SCAN';
    renderHistoryList();
  }

  /* ==================== 結果の描画 ==================== */

  function renderColorSpectrum(list) {
    if (!list.length) {
      asEls.colorSection.innerHTML = '<p class="asc-pane-label" style="margin-bottom:9px;">Color Spectrum <small>色彩</small></p><div class="asc-data-placeholder">データがありません</div>';
      return;
    }
    const rows = list.map((c) => {
      const hex = /^#[0-9a-fA-F]{6}$/.test(c.hex || '') ? c.hex : '#5eead4';
      const proportion = Math.max(0, Math.min(1, Number(c.proportion) || 0));
      return (
        '<div class="asc-spectrum-row">' +
        `<span class="asc-swatch" style="background:${hex}"></span>` +
        `<span class="asc-spectrum-info"><span class="asc-spectrum-name">${escapeHtml(c.name || '')}</span><br>` +
        `<span class="asc-spectrum-hex">${hex.toUpperCase()} ・ ${escapeHtml(c.hsl || '')}</span></span>` +
        `<span class="asc-spectrum-bar"><i style="width:${Math.round(proportion * 100)}%"></i></span>` +
        '</div>'
      );
    }).join('');
    asEls.colorSection.innerHTML = '<p class="asc-pane-label" style="margin-bottom:9px;">Color Spectrum <small>色彩</small></p>' + rows;
  }

  function renderMaterialTags(list) {
    if (!list.length) {
      asEls.materialSection.innerHTML = '<p class="asc-pane-label" style="margin-bottom:9px;">Material Composition <small>素材構成</small></p><div class="asc-data-placeholder">データがありません</div>';
      return;
    }
    const tags = list.map((m) => `<span class="asc-material-tag">${escapeHtml(m.code || '')}<small>${escapeHtml(m.label || '')}</small></span>`).join('');
    asEls.materialSection.innerHTML = '<p class="asc-pane-label" style="margin-bottom:9px;">Material Composition <small>素材構成</small></p><div class="asc-material-tags">' + tags + '</div>';
  }

  /* Historical Position: 固定の参考点は持たず、APIが返した年代(year)と文化的伝播度
     (resonance、Geminiの見立て0-1)から都度SVG座標を計算する。系譜先には画像を載せない
     (著作権判定を都度行うのは非現実的なため、影響関係の分析文+Google検索リンクのみに統一)。 */
  const PLOT_SVG_NS = 'http://www.w3.org/2000/svg';
  const PLOT_X0 = 34, PLOT_X1 = 308, PLOT_Y0 = 140, PLOT_Y1 = 10;

  function buildPlotNode(opts) {
    const g = document.createElementNS(PLOT_SVG_NS, 'g');
    g.setAttribute('class', 'asc-plot-node' + (opts.query ? '' : ' asc-plot-node--self'));
    const hit = document.createElementNS(PLOT_SVG_NS, 'circle');
    hit.setAttribute('cx', opts.x); hit.setAttribute('cy', opts.y); hit.setAttribute('r', 10); hit.setAttribute('fill', 'transparent');
    g.appendChild(hit);
    const dot = document.createElementNS(PLOT_SVG_NS, 'circle');
    dot.setAttribute('class', 'dot');
    dot.setAttribute('cx', opts.x); dot.setAttribute('cy', opts.y); dot.setAttribute('r', opts.query ? 3.5 : 4.5);
    dot.setAttribute('fill', opts.color);
    if (!opts.query) { dot.setAttribute('stroke', '#04070c'); dot.setAttribute('stroke-width', '1.5'); }
    g.appendChild(dot);
    const nearRightEdge = opts.x > PLOT_X1 - 90;
    const label = document.createElementNS(PLOT_SVG_NS, 'text');
    label.setAttribute('x', nearRightEdge ? opts.x - 6 : opts.x + 6);
    label.setAttribute('y', opts.y + 3);
    if (nearRightEdge) label.setAttribute('text-anchor', 'end');
    label.setAttribute('class', 'asc-plot-point-label');
    label.textContent = opts.label;
    g.appendChild(label);
    if (opts.query) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => openPlotPopup(opts.query));
    }
    return g;
  }

  function renderLineagePlot(lineage) {
    asEls.plotPoints.innerHTML = '';
    asEls.plotPoints.style.opacity = 0;
    lineageByQuery = {};
    if (!lineage) {
      asEls.plotYearMin.textContent = '—';
      asEls.plotYearMax.textContent = '—';
      return;
    }

    const selfYear = Number.isFinite(Number(lineage.selfYear)) ? Number(lineage.selfYear) : new Date().getFullYear();
    const selfResonance = Math.max(0, Math.min(1, Number(lineage.selfResonance) || 0));
    const points = (Array.isArray(lineage.points) ? lineage.points : [])
      .map((p) => ({
        title: String(p.title || ''),
        artist: String(p.artist || ''),
        year: Number.isFinite(Number(p.year)) ? Number(p.year) : selfYear,
        resonance: Math.max(0, Math.min(1, Number(p.resonance) || 0)),
        query: String(p.query || `${p.title || ''} ${p.artist || ''}`).trim(),
        influence: String(p.influence || ''),
      }))
      .filter((p) => p.title);

    const years = points.map((p) => p.year).concat([selfYear]);
    const minYear = Math.min(...years) - 5;
    const maxYear = Math.max(new Date().getFullYear(), ...years);
    const span = Math.max(1, maxYear - minYear);
    const xFor = (year) => PLOT_X0 + ((year - minYear) / span) * (PLOT_X1 - PLOT_X0);
    const yFor = (res) => PLOT_Y0 - Math.max(0, Math.min(1, res)) * (PLOT_Y0 - PLOT_Y1);

    asEls.plotYearMin.textContent = String(minYear);
    asEls.plotYearMax.textContent = String(maxYear);

    const ordered = points.slice().sort((a, b) => a.year - b.year);
    const chain = [{ x: xFor(selfYear), y: yFor(selfResonance) }].concat(ordered.map((p) => ({ x: xFor(p.year), y: yFor(p.resonance) })));
    for (let i = 0; i < chain.length - 1; i++) {
      const line = document.createElementNS(PLOT_SVG_NS, 'line');
      line.setAttribute('x1', chain[i].x); line.setAttribute('y1', chain[i].y);
      line.setAttribute('x2', chain[i + 1].x); line.setAttribute('y2', chain[i + 1].y);
      line.setAttribute('stroke', '#5eead4'); line.setAttribute('stroke-width', '1');
      line.setAttribute('stroke-dasharray', '2 3'); line.setAttribute('opacity', '0.5');
      asEls.plotPoints.appendChild(line);
    }

    asEls.plotPoints.appendChild(buildPlotNode({
      x: xFor(selfYear), y: yFor(selfResonance), color: '#5eead4', label: `${lineage.selfTitle || ''} ${selfYear}`.trim(), query: null,
    }));
    ordered.forEach((p) => {
      const x = xFor(p.year), y = yFor(p.resonance);
      asEls.plotPoints.appendChild(buildPlotNode({ x, y, color: '#f5a623', label: `${p.title} ${p.year}`, query: p.query }));
      lineageByQuery[p.query] = { title: p.title, sub: `${p.artist} / ${p.year}年`, body: p.influence };
    });

    asEls.plotPoints.style.transition = 'opacity 0.4s ease';
    requestAnimationFrame(() => { asEls.plotPoints.style.opacity = 1; });
  }

  function openPlotPopup(query) {
    const info = lineageByQuery[query];
    if (!info) return;
    asEls.popupTitle.textContent = info.title;
    asEls.popupSub.textContent = info.sub;
    asEls.popupBody.textContent = info.body;
    asEls.popupSearch.href = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    asEls.popupOverlay.classList.add('open');
  }
  function closePlotPopup() {
    if (asEls) asEls.popupOverlay.classList.remove('open');
  }

  /** ctxのcontexts文をログ欄へ表示する。instant=trueなら(履歴を見返す時)タイプライター
   *  演出を省いて即座に表示する(走査するたびに毎回演出を見せられると煩わしいため、
   *  演出は「たった今解析が完了した」直後だけに限定する)。 */
  function typeLog(ctx, instant) {
    clearInterval(typingTimer);
    const str = (currentContexts && currentContexts[ctx]) || '';
    if (!str) {
      asEls.logBody.innerHTML = '<span class="asc-log-idle">この文脈のデータがありません</span>';
      return;
    }
    if (instant) {
      asEls.logBody.textContent = str;
      return;
    }
    let i = 0;
    asEls.logBody.innerHTML = '<span class="asc-log-cursor"></span>';
    typingTimer = setInterval(() => {
      i += 3;
      asEls.logBody.textContent = str.slice(0, i);
      if (i >= str.length) clearInterval(typingTimer);
    }, 16);
  }

  /* ==================== 起動登録 ==================== */

  if (window.registerModuleCode) {
    registerModuleCode('258', () => openAstrometryScope());
  }
  window.openAstrometryScope = openAstrometryScope;
})();
