// CONSTELLATION — Module: Flight Engineer
//
// キャンバスの既定操作(背景ドラッグ=パン)を、モジュール起動中だけ「矩形選択」へ切り替える
// 一括編成モジュール。選択したカード群を新規セッションへ格納/その場で整列/セッションを
// 解体できる。CLAUDE.mdの「モジュール」規約に従い、このファイル全体をIIFEで包んで
// トップレベルの名前をグローバルへ漏らさない。state / els / activeSessionId() /
// getSessionById() / getCardById() / cardElById() / clientToContent() / applyCardTransform() /
// redrawAsterismLines() / renderAllCards() / scheduleAutoSave() / setStatus() / escapeHtml() /
// viewportState などの既存グローバルは直接参照する。
//
// 起動: js/module-launcher.js経由。背景を2本指でダブルタップしてキーパッドHUDを開き、
//       "147"(電話キーパッドの左列。123=WormGate・456=Crews・789=Mapping Storysで
//       洛書の3行を使い切っているため、左の3列目にあたるこの並びを割り当てた)と入力すると
//       起動する(PCではCONSTELLATION PIEの「キーパッド」項目からも開ける)。
//       このモジュール自身は registerModuleCode('147', openFlightEngineer) で登録するだけ。
//
// 【他の3モジュールとの違い・設計上の要点(2026年9月、モックアップでの検証を経て決定)】
// - WormGate/Crews/Mapping Storysは全て「独立したオーバーレイ/小窓を被せるだけ」で完結して
//   いたが、Flight Engineerはキャンバス本体の既定ジェスチャー(背景ドラッグ=パン)そのものを
//   置き換える初めてのモジュール。そのため、他のモジュールにはない小さな例外として
//   js/canvas.js(カード個別の長押し/移動、俯瞰ズームのダブルタップ判定)と js/app.js
//   (セッションカードのタップで開く処理)にごく薄いガード(window.isFlightEngineerActive()の
//   チェック)を追加している。キャンバス背景のパン自体は、interact.jsが要素をキーに
//   Interactableを使い回す性質を利用し、このファイルから直接
//   interact(els.viewport).draggable({ enabled }) を呼んで止める/戻すだけで済んでいる
//   (canvas.js側の viewportEl と els.viewport は同一要素のため、新しいフック関数は不要)。
// - 矩形選択は交差判定(カードの一部でも矩形に触れていれば選択対象)。
// - ASTR接続の「またぐ」判定は、見た目の交差ではなく、接続している2枚が操作後に別セッション
//   所属になるかどうかで切る。格納で両方とも新セッションへ移る接続はsessionIdを付け替えて
//   保持し、片方だけ移る接続だけを切断する。
// - 「排出」(セッションの外へ出す)は、実装を検討した結果ユーザー判断で見送った。セッション内の
//   中身を見るには「解体」(元に戻せる)で十分に用が足りるため。
// - 一括移動は、確定後に残る選択枠そのものを掴んでドラッグする(カード個別のドラッグとは
//   別動作として分離)。
// - 履歴を持つのは「格納」「解体」のみ(整理・単発の移動は対象外)。Undo/Redoの2本の
//   ボタンではなく、時系列の1本の配列(state.feHistory)+現在位置(state.feHistoryIndex)で
//   管理し、バーの「履歴」パネルの行を直接タップして任意の時点へジャンプする(ユーザー指示、
//   2026年9月)。エントリはクロージャではなくプレーンなデータ(カードID・座標・接続の断片)
//   として持つため、既存のcards/sessions/connectionsと同じ constellation-data.json へ
//   そのままオートセーブでき、アプリやPCのシャットダウンを挟んでも履歴からの復帰が
//   有効なまま残る(直近10件、超えた分は古い方から破棄)。
// - セッションカードをダブルクリックすると、パンくずを移動せずに中身を軽くプレビューできる
//   (読み取り専用のポップアップ、Crewsの人物情報ポップアップと同じ位置づけ)。
// - モジュール起動中にセッションカードをタップ(ドラッグなしで選択)すると、それだけで
//   1枚選択の状態になり、「セッションを解体」を含むコマンドパネルがすぐ出る
//   (矩形選択で1枚だけ囲む必要はない)。
// - PC限定: Shiftキーを押している間は、Flight Engineer起動中でも背景ドラッグ=通常のパン、
//   カードのドラッグ=そのカード単体の移動(既存の長押し編集ガイド)に一時的に戻る。
//   タッチ操作にShiftキーは無いため、この上書きはPCのみでよい。

(function () {
  'use strict';

  const HISTORY_CAP = 10;
  const TAP_MOVE_TOLERANCE_PX = 8;
  const SESSION_CARD_DEFAULT = { width: 190, height: 150 };

  let stylesInjected = false;
  let feEls = null;

  let feActive = false; // 矩形選択モードがONか
  let shiftHeld = false;

  let selection = new Set();
  let marqueeDrag = null; // { x0, y0, x1, y1, pointerId } (viewport-local px)
  let cardTapTrack = null; // { pointerId, startX, startY, cardEl }
  let groupDragState = null;
  let rectEl = null;
  let countEl = null;
  let panelEl = null;

  /* ---------------- スタイル注入 ---------------- */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .fe-bar {
        position: absolute; top: 10px; left: 50%; transform: translateX(-50%) translateY(-140%);
        z-index: 60; display: flex; flex-direction: column; gap: 0;
        min-width: 260px; max-width: min(92vw, 420px);
        background: rgba(255, 255, 255, 0.7); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
        border: 1px solid rgba(28, 95, 214, 0.5); border-radius: 16px;
        box-shadow: 0 14px 34px rgba(11, 35, 84, 0.18), 0 0 0 1px rgba(28, 95, 214, 0.14);
        opacity: 0; pointer-events: none;
        transition: opacity 0.2s ease-out, transform 0.24s cubic-bezier(0.2, 0.9, 0.3, 1.2);
        touch-action: none;
      }
      .fe-bar.open { opacity: 1; pointer-events: auto; transform: translateX(-50%) translateY(0); }
      .fe-bar-drag { flex: none; height: 14px; margin: 4px auto 0; width: 40px; border-radius: 3px; background: rgba(28, 95, 214, 0.25); cursor: grab; }
      .fe-close-btn {
        position: absolute; top: -8px; right: -8px; width: 24px; height: 24px; border-radius: 50%;
        border: 1px solid rgba(28, 95, 214, 0.5); background: rgba(255, 255, 255, 0.9); color: #0b2354;
        font-size: 12px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
      }
      .fe-bar-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 12px 10px; flex-wrap: wrap; }
      .fe-toggle {
        font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; letter-spacing: 0.02em; color: #737373;
        display: flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(0, 0, 0, 0.14); background: rgba(255, 255, 255, 0.6); user-select: none;
      }
      .fe-toggle.on { color: #0b2354; border-color: rgba(28, 95, 214, 0.55); background: rgba(28, 95, 214, 0.14); }
      .fe-toggle-dot { width: 7px; height: 7px; border-radius: 50%; background: #999; }
      .fe-toggle.on .fe-toggle-dot { background: #1c5fd6; box-shadow: 0 0 8px 1px rgba(28, 95, 214, 0.7); animation: fe-dot-pulse 1.6s ease-in-out infinite; }
      @keyframes fe-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
      .fe-bar-group { display: flex; align-items: center; gap: 6px; }
      .fe-bar-btn {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer; border: 1px solid rgba(28, 95, 214, 0.4);
        background: rgba(255, 255, 255, 0.5); color: #0b2354; border-radius: 999px; padding: 5px 10px;
        display: inline-flex; align-items: center; gap: 4px;
      }
      .fe-bar-btn:hover:not(:disabled) { background: rgba(28, 95, 214, 0.16); }
      .fe-bar-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .fe-hist-wrap { position: relative; }
      .fe-badge { background: #1c5fd6; color: #fff; font-size: 9px; border-radius: 999px; padding: 1px 6px; min-width: 14px; text-align: center; font-family: 'IBM Plex Mono', monospace; }
      .fe-history-panel {
        display: none; position: absolute; top: calc(100% + 8px); right: 0; z-index: 61; width: 250px; max-height: 260px; overflow-y: auto;
        background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(12px); border: 1px solid rgba(28, 95, 214, 0.4);
        border-radius: 10px; box-shadow: 0 14px 30px rgba(11, 35, 84, 0.2); padding: 8px;
      }
      .fe-history-panel.open { display: block; }
      .fe-hist-row { display: flex; align-items: center; gap: 7px; font-family: 'IBM Plex Mono', monospace; font-size: 10px; padding: 6px; border-radius: 6px; cursor: pointer; }
      .fe-hist-row:hover { background: rgba(28, 95, 214, 0.1); }
      .fe-hist-row.current { background: rgba(28, 95, 214, 0.16); }
      .fe-hist-row.future { opacity: 0.5; }
      .fe-hist-ico { flex: none; color: #0b2354; }
      .fe-hist-label { flex: 1; color: #000; word-break: break-word; }
      .fe-hist-time { color: #737373; font-size: 8.5px; flex: none; }
      .fe-hist-empty { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #737373; padding: 10px 4px; line-height: 1.7; }

      .fe-rect {
        position: absolute; z-index: 55; border-radius: 4px; pointer-events: none;
        background: rgba(28, 95, 214, 0.14); border: 1.5px solid #4f8cff;
        box-shadow: 0 0 0 1px rgba(28, 95, 214, 0.24), 0 0 22px 2px rgba(28, 95, 214, 0.24);
      }
      .fe-rect--handle { pointer-events: auto; cursor: move; background: rgba(28, 95, 214, 0.2); }
      .fe-rect-count {
        position: absolute; z-index: 56; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #fff; background: #1c5fd6;
        padding: 3px 8px; border-radius: 999px; box-shadow: 0 3px 10px rgba(28, 95, 214, 0.4); white-space: nowrap; pointer-events: none;
      }
      .fe-panel {
        position: absolute; z-index: 57; min-width: 200px; border-radius: 12px; padding: 10px 12px 11px;
        background: rgba(255, 255, 255, 0.85); backdrop-filter: blur(14px); border: 1px solid rgba(28, 95, 214, 0.4);
        box-shadow: 0 12px 30px rgba(11, 35, 84, 0.18), 0 0 0 1px rgba(28, 95, 214, 0.12);
      }
      .fe-panel-head { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #0b2354; font-weight: 600; margin-bottom: 8px; }
      .fe-panel-actions { display: flex; flex-direction: column; gap: 6px; }
      .fe-btn {
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; text-align: left; cursor: pointer;
        border: 1px solid rgba(28, 95, 214, 0.4); background: rgba(255, 255, 255, 0.6); color: #0b2354;
        border-radius: 7px; padding: 7px 10px;
      }
      .fe-btn:hover:not(:disabled) { background: rgba(28, 95, 214, 0.16); }
      .fe-btn:disabled { opacity: 0.35; cursor: not-allowed; }
      .fe-btn--ghost { border-color: rgba(0, 0, 0, 0.14); color: #737373; background: transparent; }
      .fe-btn--danger { border-color: rgba(179, 64, 43, 0.5); color: #b3402b; }
      .fe-btn--danger:hover:not(:disabled) { background: rgba(179, 64, 43, 0.1); }

      .star-card.fe-selected { outline: 2px solid #4f8cff; outline-offset: 2px; box-shadow: 0 0 0 5px rgba(28, 95, 214, 0.16); }

      .fe-preview-overlay {
        position: fixed; inset: 0; z-index: 130; display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity 0.2s ease-out;
      }
      .fe-preview-overlay.open { opacity: 1; pointer-events: auto; }
      .fe-preview-backdrop { position: absolute; inset: 0; background: rgba(6, 10, 20, 0.55); backdrop-filter: blur(6px); }
      .fe-preview-modal {
        position: relative; width: min(86vw, 480px); max-height: 78vh; overflow-y: auto;
        background: rgba(255, 255, 255, 0.92); backdrop-filter: blur(16px); border: 1px solid rgba(28, 95, 214, 0.4);
        border-radius: 16px; padding: 18px 20px 20px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.3);
      }
      .fe-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 4px; }
      .fe-preview-title { font-family: 'Fraunces', serif; font-size: 17px; font-weight: 500; color: #000; }
      .fe-preview-close { flex: none; width: 26px; height: 26px; border-radius: 50%; border: 1px solid rgba(28, 95, 214, 0.4); background: rgba(255,255,255,0.8); cursor: pointer; font-size: 12px; }
      .fe-preview-count { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #737373; margin-bottom: 14px; }
      .fe-preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; }
      .fe-preview-tile {
        aspect-ratio: 1; border-radius: 8px; background-color: #f0f0f0; background-size: cover; background-position: center;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
        border: 1px solid rgba(0, 0, 0, 0.1); padding: 4px; overflow: hidden;
      }
      .fe-preview-tile--photo { color: transparent; }
      .fe-preview-tile-icon { font-size: 18px; }
      .fe-preview-tile-label { font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; color: #737373; text-align: center; line-height: 1.3; word-break: break-word; }
      .fe-preview-empty { font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #737373; }
    `;
    document.head.appendChild(style);
  }

  /* ---------------- パンの一時無効化(interact.jsのInteractableは要素キーで共有される) ---------------- */

  function syncPanningEnabled() {
    interact(els.viewport).draggable({ enabled: !feActive || shiftHeld });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Shift' && !shiftHeld) {
      shiftHeld = true;
      syncPanningEnabled();
    }
    // 非常口(2026年9月追加)。バーが何らかの理由で見えなくなった/操作できなくなった状態で
    // 矩形選択モードだけがONのまま残り、パンもできず抜け出せない、という実機報告があった
    // (原因はバーのDOM detachなど未特定だが、再発時に確実に復帰できる手段を優先して用意する)。
    // バーの状態に関係なく、feActive中はEscapeキーで必ず終了できるようにする。
    if (event.key === 'Escape' && feActive) closeFlightEngineer();
  });
  document.addEventListener('keyup', (event) => {
    if (event.key === 'Shift') {
      shiftHeld = false;
      syncPanningEnabled();
    }
  });
  window.addEventListener('blur', () => {
    shiftHeld = false;
    syncPanningEnabled();
  });

  /* ---------------- バーのDOM構築 ---------------- */

  function ensureBarDom() {
    if (feEls) return;
    const bar = document.createElement('div');
    bar.className = 'fe-bar';
    bar.title = 'PC限定: Shiftキーを押している間は通常のパン/カード移動に一時的に戻る';
    bar.innerHTML = `
      <div class="fe-bar-drag"></div>
      <button class="fe-close-btn" title="Flight Engineerを終了">✕</button>
      <div class="fe-bar-row">
        <div class="fe-toggle"><span class="fe-toggle-dot"></span><span class="fe-toggle-label">Flight Engineer</span></div>
        <div class="fe-bar-group">
          <div class="fe-hist-wrap">
            <button class="fe-bar-btn fe-history-btn">履歴 <span class="fe-badge">0</span></button>
            <div class="fe-history-panel"></div>
          </div>
        </div>
      </div>
    `;
    els.viewport.appendChild(bar);

    feEls = {
      bar,
      toggle: bar.querySelector('.fe-toggle'),
      closeBtn: bar.querySelector('.fe-close-btn'),
      historyBtn: bar.querySelector('.fe-history-btn'),
      historyList: bar.querySelector('.fe-history-panel'),
      badge: bar.querySelector('.fe-badge'),
    };

    bar.addEventListener('pointerdown', (e) => e.stopPropagation());

    feEls.toggle.addEventListener('click', () => toggleFeActive());
    feEls.closeBtn.addEventListener('click', closeFlightEngineer);
    feEls.historyBtn.addEventListener('click', () => {
      feEls.historyList.classList.toggle('open');
      renderHistoryUI();
    });
    document.addEventListener('pointerdown', (e) => {
      if (feEls.historyList.classList.contains('open') && !bar.contains(e.target)) {
        feEls.historyList.classList.remove('open');
      }
    });

    // スワイプで閉じる(モジュール共通デザイン言語)。上部の掴みバーから始まった場合だけ判定する。
    let swipeStartX = null;
    let swipeStartY = null;
    let swipeStartT = 0;
    const dragHandle = bar.querySelector('.fe-bar-drag');
    dragHandle.addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX;
      swipeStartY = e.clientY;
      swipeStartT = performance.now();
    });
    bar.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX;
      const dy = e.clientY - swipeStartY;
      const dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeFlightEngineer();
    });

    ensurePreviewDom();
  }

  function ensurePreviewDom() {
    if (feEls.previewOverlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'fe-preview-overlay';
    overlay.innerHTML = `
      <div class="fe-preview-backdrop"></div>
      <div class="fe-preview-modal">
        <div class="fe-preview-head">
          <span class="fe-preview-title"></span>
          <button class="fe-preview-close" title="閉じる">✕</button>
        </div>
        <p class="fe-preview-count"></p>
        <div class="fe-preview-grid"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    feEls.previewOverlay = overlay;
    feEls.previewTitle = overlay.querySelector('.fe-preview-title');
    feEls.previewCount = overlay.querySelector('.fe-preview-count');
    feEls.previewGrid = overlay.querySelector('.fe-preview-grid');
    overlay.querySelector('.fe-preview-backdrop').addEventListener('click', closeSessionPreview);
    overlay.querySelector('.fe-preview-close').addEventListener('click', closeSessionPreview);
  }

  function closeSessionPreview() {
    if (feEls && feEls.previewOverlay) feEls.previewOverlay.classList.remove('open');
  }

  /* ---------------- 起動/終了/ON-OFF ---------------- */

  function updateToggleUI() {
    if (!feEls) return;
    feEls.toggle.classList.toggle('on', feActive);
  }

  function toggleFeActive(next) {
    feActive = typeof next === 'boolean' ? next : !feActive;
    syncPanningEnabled();
    if (!feActive) clearSelectionAndPanel();
    updateToggleUI();
    playFlightEngineerToggleSound(feActive);
    setStatus(feActive ? 'Flight Engineer: 背景ドラッグが矩形選択になります' : 'Flight Engineer: 通常のパン操作に戻りました');
  }

  function openFlightEngineer() {
    if (!stylesInjected) {
      injectStyles();
      stylesInjected = true;
    }
    ensureBarDom();
    // 稀にバーの要素がDOMから外れた状態でfeEls参照だけ残ってしまうケースへの保険
    // (2026年9月、実機で「バーが出てこない」報告があったが根本原因は未特定のまま)。
    // 外れていたら同じ要素を作り直さず、そのまま挿し直すだけで復旧できる。
    if (!els.viewport.contains(feEls.bar)) els.viewport.appendChild(feEls.bar);
    feEls.bar.classList.add('open');
    if (!feActive) toggleFeActive(true);
    renderHistoryUI();
  }

  function closeFlightEngineer() {
    if (!feEls) return;
    feEls.bar.classList.remove('open');
    feEls.historyList.classList.remove('open');
    if (feActive) toggleFeActive(false);
  }

  window.isFlightEngineerActive = () => feActive;

  /* ---------------- 選択状態の管理 ---------------- */

  function applySelectionSet(newSel) {
    selection.forEach((id) => {
      if (!newSel.has(id)) {
        const el = cardElById(id);
        if (el) el.classList.remove('fe-selected');
      }
    });
    newSel.forEach((id) => {
      if (!selection.has(id)) {
        const el = cardElById(id);
        if (el) el.classList.add('fe-selected');
      }
    });
    selection = newSel;
  }

  function clearSelectionAndPanel() {
    applySelectionSet(new Set());
    if (rectEl) { rectEl.remove(); rectEl = null; }
    if (countEl) { countEl.remove(); countEl = null; }
    if (panelEl) { panelEl.remove(); panelEl = null; }
  }

  function viewportLocalPoint(clientX, clientY) {
    const rect = els.viewport.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /* ---------------- 矩形選択 ---------------- */

  function beginMarquee(event) {
    clearSelectionAndPanel();
    const p = viewportLocalPoint(event.clientX, event.clientY);
    marqueeDrag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, pointerId: event.pointerId };
    try { els.viewport.setPointerCapture(event.pointerId); } catch (err) { /* no-op */ }
    playFlightEngineerSelectSound();
  }

  function updateMarqueeVisual() {
    const left = Math.min(marqueeDrag.x0, marqueeDrag.x1);
    const top = Math.min(marqueeDrag.y0, marqueeDrag.y1);
    const w = Math.abs(marqueeDrag.x1 - marqueeDrag.x0);
    const h = Math.abs(marqueeDrag.y1 - marqueeDrag.y0);
    if (!rectEl) {
      rectEl = document.createElement('div');
      rectEl.className = 'fe-rect';
      els.viewport.appendChild(rectEl);
      countEl = document.createElement('div');
      countEl.className = 'fe-rect-count';
      els.viewport.appendChild(countEl);
    }
    rectEl.style.left = `${left}px`;
    rectEl.style.top = `${top}px`;
    rectEl.style.width = `${w}px`;
    rectEl.style.height = `${h}px`;

    const vpRect = els.viewport.getBoundingClientRect();
    const p0 = clientToContent(vpRect.left + left, vpRect.top + top);
    const p1 = clientToContent(vpRect.left + left + w, vpRect.top + top + h);
    const currentId = activeSessionId();
    const newSel = new Set();
    state.cards
      .filter((c) => c.sessionId === currentId)
      .forEach((c) => {
        if (c.x < p1.x && c.x + c.width > p0.x && c.y < p1.y && c.y + c.height > p0.y) newSel.add(c.id);
      });
    applySelectionSet(newSel);
    countEl.textContent = `${newSel.size}枚選択中`;
    countEl.style.left = `${left + w + 8}px`;
    countEl.style.top = `${Math.max(4, top - 2)}px`;
  }

  function finalizeMarquee() {
    marqueeDrag = null;
    if (selection.size === 0) {
      if (rectEl) { rectEl.remove(); rectEl = null; }
      if (countEl) { countEl.remove(); countEl = null; }
      return;
    }
    convertRectToGroupHandle();
    showCommandPanel();
  }

  function convertRectToGroupHandle() {
    if (!rectEl) return;
    rectEl.classList.add('fe-rect--handle');
    rectEl.onpointerdown = (event) => {
      event.stopPropagation();
      const cards = Array.from(selection).map(getCardById).filter(Boolean);
      groupDragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origins: cards.map((c) => ({ card: c, x: c.x, y: c.y })),
        rectStart: { left: parseFloat(rectEl.style.left) || 0, top: parseFloat(rectEl.style.top) || 0 },
        countStart: countEl ? { left: parseFloat(countEl.style.left) || 0, top: parseFloat(countEl.style.top) || 0 } : null,
        panelStart: panelEl ? { left: parseFloat(panelEl.style.left) || 0, top: parseFloat(panelEl.style.top) || 0 } : null,
      };
      try { rectEl.setPointerCapture(event.pointerId); } catch (err) { /* no-op */ }
    };
    rectEl.onpointermove = (event) => {
      if (groupDragState && event.pointerId === groupDragState.pointerId) updateGroupDrag(event);
    };
    rectEl.onpointerup = (event) => {
      if (groupDragState && event.pointerId === groupDragState.pointerId) finalizeGroupDrag();
    };
  }

  function updateGroupDrag(event) {
    const g = groupDragState;
    const dxScreen = event.clientX - g.startX;
    const dyScreen = event.clientY - g.startY;
    const dx = dxScreen / viewportState.scale;
    const dy = dyScreen / viewportState.scale;
    g.origins.forEach((o) => {
      o.card.x = o.x + dx;
      o.card.y = o.y + dy;
      const el = cardElById(o.card.id);
      if (el) {
        el.dataset.x = String(o.card.x);
        el.dataset.y = String(o.card.y);
        applyCardTransform(el);
      }
    });
    rectEl.style.left = `${g.rectStart.left + dxScreen}px`;
    rectEl.style.top = `${g.rectStart.top + dyScreen}px`;
    if (countEl && g.countStart) {
      countEl.style.left = `${g.countStart.left + dxScreen}px`;
      countEl.style.top = `${g.countStart.top + dyScreen}px`;
    }
    if (panelEl && g.panelStart) {
      panelEl.style.left = `${g.panelStart.left + dxScreen}px`;
      panelEl.style.top = `${g.panelStart.top + dyScreen}px`;
    }
    redrawAsterismLines();
  }

  function finalizeGroupDrag() {
    groupDragState = null;
    scheduleAutoSave();
  }

  /* ---------------- タップでの単体選択(セッションカードの解体メニュー等) ---------------- */

  function finalizeCardTap(event) {
    const track = cardTapTrack;
    cardTapTrack = null;
    const moved = Math.hypot(event.clientX - track.startX, event.clientY - track.startY);
    if (moved > TAP_MOVE_TOLERANCE_PX) return; // ドラッグとみなし、選択はしない
    const card = getCardById(track.cardEl.dataset.id);
    if (!card) return;
    clearSelectionAndPanel();
    applySelectionSet(new Set([card.id]));
    playFlightEngineerSelectSound();
    const vpRect = els.viewport.getBoundingClientRect();
    const cardRect = track.cardEl.getBoundingClientRect();
    showCommandPanelAt(cardRect.left - vpRect.left, cardRect.bottom - vpRect.top + 10);
  }

  /* ---------------- コマンドパネル(格納/整理/解体) ---------------- */

  function showCommandPanel() {
    const left = parseFloat(rectEl.style.left) || 0;
    const top = parseFloat(rectEl.style.top) || 0;
    const h = parseFloat(rectEl.style.height) || 0;
    showCommandPanelAt(left, top + h + 12);
  }

  // 「統合」の対象になる写真の種別(2026年9月追加)。ユーザー要望は「1つの写真と1つの
  // テキストを選択時」と明示的に「写真」限定だったため、動画は対象に含めない
  // (Summonなど他の写真限定機能と同じ絞り方)。
  const MERGE_PHOTO_MEDIA_TYPES = ['image'];

  function mergeTargets(cards) {
    if (cards.length !== 2) return null;
    const photo = cards.find((c) => MERGE_PHOTO_MEDIA_TYPES.includes(c.mediaType));
    const text = cards.find((c) => c.mediaType === 'text');
    if (!photo || !text || photo === text) return null;
    return { photo, text };
  }

  function showCommandPanelAt(left, top) {
    if (panelEl) panelEl.remove();
    const cards = Array.from(selection).map(getCardById).filter(Boolean);
    const soloSession = cards.length === 1 && cards[0].mediaType === 'session';
    const mergeable = Boolean(mergeTargets(cards));

    panelEl = document.createElement('div');
    panelEl.className = 'fe-panel';
    const vpRect = els.viewport.getBoundingClientRect();
    const maxLeft = Math.max(8, vpRect.width - 216);
    panelEl.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
    panelEl.style.top = `${top}px`;
    panelEl.innerHTML = `
      <div class="fe-panel-head">🔷 ${cards.length}枚を選択中</div>
      <div class="fe-panel-actions">
        <button class="fe-btn" data-fe-action="stow">⇲ 新規セッションに格納</button>
        <button class="fe-btn" data-fe-action="tidy" ${cards.length < 2 ? 'disabled' : ''}>≋ その場で整理</button>
        <button class="fe-btn" data-fe-action="merge" ${mergeable ? '' : 'disabled'}>🖇 テキストを写真へ統合</button>
        <button class="fe-btn fe-btn--danger" data-fe-action="disband" ${soloSession ? '' : 'disabled'}>⌁ セッションを解体</button>
        <button class="fe-btn fe-btn--ghost" data-fe-action="cancel">✕ キャンセル</button>
      </div>
    `;
    panelEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    panelEl.querySelector('[data-fe-action="stow"]').addEventListener('click', doStow);
    panelEl.querySelector('[data-fe-action="tidy"]').addEventListener('click', doTidy);
    panelEl.querySelector('[data-fe-action="merge"]').addEventListener('click', doMerge);
    panelEl.querySelector('[data-fe-action="disband"]').addEventListener('click', doDisband);
    panelEl.querySelector('[data-fe-action="cancel"]').addEventListener('click', clearSelectionAndPanel);
    els.viewport.appendChild(panelEl);

    // 画面下端で見切れないよう、実際の高さを測ってから必要な分だけ上に押し上げる
    // (選択位置の下に置くのが既定だが、下端に収まらない場合は選択位置の上に出す)。
    const panelHeight = panelEl.offsetHeight;
    const maxTop = Math.max(8, vpRect.height - panelHeight - 8);
    if (parseFloat(panelEl.style.top) > maxTop) {
      panelEl.style.top = `${maxTop}px`;
    }
  }

  /* ---------------- 実行: 新規セッションに格納(履歴に残る) ---------------- */

  function nextUntitledSessionName() {
    let maxN = 0;
    state.sessions.forEach((s) => {
      const m = /^無題セッション(\d+)$/.exec(s.name || '');
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    });
    return `無題セッション${maxN + 1}`;
  }

  function applyStowForward(entry) {
    state.sessions.push({
      id: entry.newSessionId,
      type: 'session',
      parentId: entry.parentSessionId,
      name: entry.sessionName,
      createdAt: entry.sessionCreatedAt,
    });
    state.cards.push({
      id: entry.sessionCardId,
      x: entry.sessionCardPosition.x,
      y: entry.sessionCardPosition.y,
      width: entry.sessionCardPosition.width,
      height: entry.sessionCardPosition.height,
      memo: '',
      tags: [],
      mediaType: 'session',
      refSessionId: entry.newSessionId,
      imageFileId: null,
      sessionId: entry.parentSessionId,
      createdAt: entry.sessionCardCreatedAt,
    });
    entry.cardIds.forEach((id) => {
      const card = getCardById(id);
      if (!card) return;
      card.sessionId = entry.newSessionId;
      const pos = entry.newPositions.find((p) => p.id === id);
      if (pos) { card.x = pos.x; card.y = pos.y; }
    });
    entry.crossingConnections.forEach((snap) => {
      const idx = state.connections.findIndex((c) => c.id === snap.id);
      if (idx !== -1) state.connections.splice(idx, 1);
    });
    entry.internalConnectionIds.forEach((id) => {
      const conn = state.connections.find((c) => c.id === id);
      if (conn) conn.sessionId = entry.newSessionId;
    });
  }

  function applyStowReverse(entry) {
    entry.cardIds.forEach((id) => {
      const card = getCardById(id);
      if (!card) return;
      card.sessionId = entry.parentSessionId;
      const pos = entry.originalPositions.find((p) => p.id === id);
      if (pos) { card.x = pos.x; card.y = pos.y; }
    });
    entry.internalConnectionIds.forEach((id) => {
      const conn = state.connections.find((c) => c.id === id);
      if (conn) conn.sessionId = entry.parentSessionId;
    });
    entry.crossingConnections.forEach((snap) => {
      if (!state.connections.some((c) => c.id === snap.id)) state.connections.push({ ...snap });
    });
    const cardIdx = state.cards.findIndex((c) => c.id === entry.sessionCardId);
    if (cardIdx !== -1) state.cards.splice(cardIdx, 1);
    const sessIdx = state.sessions.findIndex((s) => s.id === entry.newSessionId);
    if (sessIdx !== -1) state.sessions.splice(sessIdx, 1);
  }

  function doStow() {
    const currentId = activeSessionId();
    const ids = Array.from(selection);
    const selCards = ids.map(getCardById).filter(Boolean);
    if (selCards.length === 0) return;

    const minX = Math.min(...selCards.map((c) => c.x));
    const minY = Math.min(...selCards.map((c) => c.y));
    const maxX = Math.max(...selCards.map((c) => c.x + c.width));
    const maxY = Math.max(...selCards.map((c) => c.y + c.height));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const originalPositions = selCards.map((c) => ({ id: c.id, x: c.x, y: c.y }));
    const offsetX = 60 - minX;
    const offsetY = 60 - minY;
    const newPositions = selCards.map((c) => ({ id: c.id, x: c.x + offsetX, y: c.y + offsetY }));

    const idSet = new Set(ids);
    const sessionConns = state.connections.filter((c) => c.sessionId === currentId);
    const crossing = sessionConns.filter((c) => idSet.has(c.cardIdA) !== idSet.has(c.cardIdB));
    const internal = sessionConns.filter((c) => idSet.has(c.cardIdA) && idSet.has(c.cardIdB));

    const now = new Date().toISOString();
    const sessionName = nextUntitledSessionName();
    const entry = {
      id: crypto.randomUUID(),
      type: 'stow',
      at: Date.now(),
      label: `『${sessionName}』に${selCards.length}枚を格納`,
      parentSessionId: currentId,
      newSessionId: crypto.randomUUID(),
      sessionCardId: crypto.randomUUID(),
      sessionName,
      sessionCreatedAt: now,
      sessionCardCreatedAt: now,
      sessionCardPosition: { x: cx - 95, y: cy - 65, width: SESSION_CARD_DEFAULT.width, height: SESSION_CARD_DEFAULT.height },
      cardIds: ids,
      originalPositions,
      newPositions,
      crossingConnections: crossing.map((c) => ({ ...c })),
      internalConnectionIds: internal.map((c) => c.id),
    };

    applyStowForward(entry);
    clearSelectionAndPanel();
    renderAllCards();
    pushFeHistory(entry);
    if (crossing.length > 0) playFlightEngineerCutSound();
    playFlightEngineerStowSound();
    setStatus(`『${sessionName}』に${selCards.length}枚を格納しました`);
  }

  /* ---------------- 実行: セッションを解体(履歴に残る) ---------------- */

  function applyDisbandForward(entry) {
    const cardIdx = state.cards.findIndex((c) => c.id === entry.sessionCard.id);
    if (cardIdx !== -1) state.cards.splice(cardIdx, 1);
    const sessIdx = state.sessions.findIndex((s) => s.id === entry.session.id);
    if (sessIdx !== -1) state.sessions.splice(sessIdx, 1);

    entry.childCardIds.forEach((id) => {
      const card = getCardById(id);
      if (!card) return;
      card.sessionId = entry.parentSessionId;
      const pos = entry.newPositions.find((p) => p.id === id);
      if (pos) { card.x = pos.x; card.y = pos.y; }
    });
    entry.internalConnectionIds.forEach((id) => {
      const conn = state.connections.find((c) => c.id === id);
      if (conn) conn.sessionId = entry.parentSessionId;
    });
  }

  function applyDisbandReverse(entry) {
    state.sessions.push({ ...entry.session });
    state.cards.push({ ...entry.sessionCard });
    entry.childCardIds.forEach((id) => {
      const card = getCardById(id);
      if (!card) return;
      card.sessionId = entry.session.id;
      const pos = entry.originalPositions.find((p) => p.id === id);
      if (pos) { card.x = pos.x; card.y = pos.y; }
    });
    entry.internalConnectionIds.forEach((id) => {
      const conn = state.connections.find((c) => c.id === id);
      if (conn) conn.sessionId = entry.session.id;
    });
  }

  function doDisband() {
    const ids = Array.from(selection);
    if (ids.length !== 1) return;
    const card = getCardById(ids[0]);
    if (!card || card.mediaType !== 'session') return;
    const session = getSessionById(card.refSessionId);
    if (!session) return;
    const currentId = activeSessionId();
    const children = state.cards.filter((c) => c.sessionId === session.id);
    const childIds = children.map((c) => c.id);

    const originalPositions = children.map((c) => ({ id: c.id, x: c.x, y: c.y }));
    const baseX = card.x;
    const baseY = card.y + card.height + 30;
    const newPositions = children.map((c, i) => ({
      id: c.id,
      x: baseX + (i % 3) * (c.width + 16),
      y: baseY + Math.floor(i / 3) * (c.height + 16),
    }));

    const internal = state.connections.filter((c) => c.sessionId === session.id);

    const entry = {
      id: crypto.randomUUID(),
      type: 'disband',
      at: Date.now(),
      label: `『${session.name}』を解体(${children.length}枚)`,
      parentSessionId: currentId,
      session: JSON.parse(JSON.stringify(session)),
      sessionCard: JSON.parse(JSON.stringify(card)),
      childCardIds: childIds,
      originalPositions,
      newPositions,
      internalConnectionIds: internal.map((c) => c.id),
    };

    applyDisbandForward(entry);
    clearSelectionAndPanel();
    renderAllCards();
    pushFeHistory(entry);
    playFlightEngineerDisbandSound();
    setStatus(`『${session.name}』を解体しました(${children.length}枚)`);
  }

  /* ---------------- 実行: その場で整理(履歴に残らない) ---------------- */

  function doTidy() {
    const ids = Array.from(selection);
    if (ids.length < 2) return;
    const selCards = ids.map(getCardById).filter(Boolean);
    const minX = Math.min(...selCards.map((c) => c.x));
    const minY = Math.min(...selCards.map((c) => c.y));
    const cols = Math.ceil(Math.sqrt(selCards.length));
    const gap = 20;
    let x = minX;
    let y = minY;
    let rowH = 0;
    let col = 0;
    selCards.forEach((c) => {
      c.x = x;
      c.y = y;
      const el = cardElById(c.id);
      if (el) {
        el.dataset.x = String(c.x);
        el.dataset.y = String(c.y);
        applyCardTransform(el);
      }
      rowH = Math.max(rowH, c.height);
      col++;
      if (col >= cols) {
        col = 0;
        x = minX;
        y += rowH + gap;
        rowH = 0;
      } else {
        x += c.width + gap;
      }
    });
    redrawAsterismLines();
    clearSelectionAndPanel();
    scheduleAutoSave();
    playFlightEngineerTidySound();
    setStatus(`${selCards.length}枚を整列しました`);
  }

  /* ---------------- 実行: テキストを写真へ統合(履歴に残らない) ---------------- */

  /**
   * 1枚の写真+1枚のテキストを選択している時だけ有効になるコマンド(2026年9月追加)。
   * テキストカードの本文を写真カードのキャプション(メモ欄)へ追記し、テキストカード自体は
   * 削除する。文字は写真側のメモへ移るだけで内容は失われないため、格納・解体のような
   * 履歴(Undo)は持たせていない(「整理」と同じ扱い)。テキストカード自体を消す操作なので、
   * 押し間違いの取り返しがつくよう実行前に一度だけ確認する。
   */
  function doMerge() {
    const cards = Array.from(selection).map(getCardById).filter(Boolean);
    const targets = mergeTargets(cards);
    if (!targets) return;
    const { photo, text } = targets;

    const addition = (text.memo || '').trim();
    if (!addition) {
      // テキストカードが空なら統合する内容が無い。確認なしでそのままテキストカードだけ消す。
      const textEl = cardElById(text.id);
      if (textEl) removeCardFromState(text, textEl);
      clearSelectionAndPanel();
      setStatus('空のテキストカードを削除しました(統合する内容がありませんでした)');
      return;
    }
    if (!window.confirm(`このテキストを写真のキャプションへ統合しますか?\nテキストカード自体は削除されます(内容は写真のメモへ移ります)。\n\n${addition}`)) {
      return;
    }

    photo.memo = photo.memo && photo.memo.trim() ? `${photo.memo}\n${addition}` : addition;

    const photoEl = cardElById(photo.id);
    if (photoEl) {
      const memoEl = photoEl.querySelector('.star-card-memo');
      const memoViewEl = photoEl.querySelector('.star-card-memo-view');
      if (memoEl) memoEl.value = photo.memo;
      if (memoViewEl) {
        memoViewEl.innerHTML = linkifyMemoHtml(photo.memo);
        memoViewEl.hidden = !photo.memo.trim();
      }
      if (typeof syncCardHeight === 'function') syncCardHeight(photoEl);
      if (typeof updateMemoExpandState === 'function') updateMemoExpandState(photoEl);
    }

    const textEl = cardElById(text.id);
    if (textEl) removeCardFromState(text, textEl); // ASTR接続・アップロード待機列の後始末も込み

    clearSelectionAndPanel();
    scheduleAutoSave();
    playFlightEngineerStowSound(); // 「吸い込まれる」質感の音を流用(テキストが写真へ取り込まれるイメージ)
    setStatus('テキストを写真のキャプションへ統合しました');
  }

  /* ---------------- 編集履歴(格納/解体のみ、最大10件、constellation-data.jsonへ永続化) ---------------- */

  /**
   * 履歴は時系列の1本の配列(state.feHistory)+現在位置(state.feHistoryIndex、
   * 「先頭からこの件数ぶんが適用済み」)で管理する。Undo/Redoの2本のボタンではなく、
   * 履歴の行を直接タップして任意の時点へジャンプする(ユーザー指示、2026年9月)。
   */
  function applyEntryForward(entry) {
    if (entry.type === 'stow') applyStowForward(entry);
    else if (entry.type === 'disband') applyDisbandForward(entry);
  }

  function applyEntryReverse(entry) {
    if (entry.type === 'stow') applyStowReverse(entry);
    else if (entry.type === 'disband') applyDisbandReverse(entry);
  }

  function pushFeHistory(entry) {
    if (state.feHistoryIndex < state.feHistory.length) {
      state.feHistory = state.feHistory.slice(0, state.feHistoryIndex); // 未来の分岐(やり直せた分)は破棄する
    }
    state.feHistory.push(entry);
    state.feHistoryIndex++;
    if (state.feHistory.length > HISTORY_CAP) {
      state.feHistory.shift();
      state.feHistoryIndex--;
    }
    renderHistoryUI();
    scheduleAutoSave();
  }

  /** カード/セッションのIDが解決できないセッションを指したまま(操作でその場が消えた等)に
   *  ならないよう、パンくずの無効な末尾を切り詰める。 */
  function ensureBreadcrumbValid() {
    let cutAt = -1;
    for (let i = 0; i < state.breadcrumb.length; i++) {
      if (!getSessionById(state.breadcrumb[i])) { cutAt = i; break; }
    }
    if (cutAt === -1) return;
    state.breadcrumb = state.breadcrumb.slice(0, cutAt);
    if (state.breadcrumb.length === 0) state.breadcrumb = [getCurrentYearSessionId()];
    renderYearTabs();
    renderBreadcrumb();
  }

  /** 履歴上の任意の位置(targetIndex件ぶんが適用済みの状態)へジャンプする。 */
  function jumpToHistoryIndex(targetIndex) {
    targetIndex = Math.max(0, Math.min(state.feHistory.length, targetIndex));
    const from = state.feHistoryIndex;
    if (targetIndex === from) return;
    if (targetIndex < from) {
      for (let i = from - 1; i >= targetIndex; i--) applyEntryReverse(state.feHistory[i]);
    } else {
      for (let i = from; i < targetIndex; i++) applyEntryForward(state.feHistory[i]);
    }
    state.feHistoryIndex = targetIndex;
    ensureBreadcrumbValid();
    clearSelectionAndPanel();
    renderAllCards();
    renderHistoryUI();
    if (targetIndex < from) playFlightEngineerUndoSound();
    else playFlightEngineerRedoSound();
    const entry = targetIndex > 0 ? state.feHistory[targetIndex - 1] : null;
    setStatus(entry ? `履歴を移動しました: ${entry.label}` : '履歴を操作前の状態に戻しました');
    scheduleAutoSave();
  }

  function feTimeAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}秒前`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}分前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}時間前`;
    return `${Math.round(h / 24)}日前`;
  }

  function historyRowHtml(label, icon, at, jumpIndex, isCurrent, isFuture) {
    const timeHtml = at ? `<span class="fe-hist-time">${feTimeAgo(at)}</span>` : '';
    return `<div class="fe-hist-row${isCurrent ? ' current' : ''}${isFuture ? ' future' : ''}" data-fe-jump="${jumpIndex}">` +
      `<span class="fe-hist-ico">${icon}</span><span class="fe-hist-label">${escapeHtml(label)}</span>${timeHtml}</div>`;
  }

  function renderHistoryUI() {
    if (!feEls) return;
    const history = state.feHistory || [];
    feEls.badge.textContent = String(state.feHistoryIndex);
    if (!feEls.historyList.classList.contains('open')) return;
    if (history.length === 0) {
      feEls.historyList.innerHTML = '<div class="fe-hist-empty">まだ操作履歴がありません。格納・解体のみここに記録されます(整理・単発の移動は対象外)。タップでその時点へ戻れます。</div>';
      return;
    }
    const rows = [historyRowHtml('(操作前の状態)', '⟲', null, 0, state.feHistoryIndex === 0, false)];
    history.forEach((entry, i) => {
      const icon = entry.type === 'stow' ? '⇲' : '⌁';
      rows.push(historyRowHtml(entry.label, icon, entry.at, i + 1, i + 1 === state.feHistoryIndex, i >= state.feHistoryIndex));
    });
    feEls.historyList.innerHTML = rows.join('');
    feEls.historyList.querySelectorAll('[data-fe-jump]').forEach((row) => {
      row.addEventListener('click', () => jumpToHistoryIndex(parseInt(row.dataset.feJump, 10)));
    });
  }

  /* ---------------- セッションのプレビュー(ダブルクリック、読み取り専用) ---------------- */

  function previewTileHtml(card) {
    if (card.mediaType === 'image' && card.thumbDataUrl) {
      return `<div class="fe-preview-tile fe-preview-tile--photo" style="background-image:url(${card.thumbDataUrl})"></div>`;
    }
    const icons = { video: '🎞', audio: '🎙', text: '✎', session: '📁', info: 'ⓘ', summary: '❋', streetview: '📍' };
    const icon = icons[card.mediaType] || '❖';
    let label;
    if (card.mediaType === 'session') {
      const sub = getSessionById(card.refSessionId);
      label = sub ? sub.name : '(不明なセッション)';
    } else {
      label = (card.memo || '').slice(0, 22) || (card.mediaType === 'image' ? '写真' : '');
    }
    return `<div class="fe-preview-tile"><span class="fe-preview-tile-icon">${icon}</span><span class="fe-preview-tile-label">${escapeHtml(label)}</span></div>`;
  }

  function showSessionPreview(refSessionId) {
    const session = getSessionById(refSessionId);
    if (!session) return;
    ensureBarDom(); // previewOverlayを確実に用意する
    const children = state.cards.filter((c) => c.sessionId === refSessionId);
    feEls.previewTitle.textContent = session.name;
    feEls.previewCount.textContent = `${children.length}件`;
    feEls.previewGrid.innerHTML = children.length
      ? children.map((c) => previewTileHtml(c)).join('')
      : '<p class="fe-preview-empty">中身は空です。</p>';
    feEls.previewOverlay.classList.add('open');
  }

  /* ---------------- キャンバス背景/カードへのポインタ配線 ---------------- */

  function onViewportPointerDown(event) {
    if (!feActive) return;
    if (marqueeDrag || cardTapTrack) return; // 既に別の指(pointerId)で矩形選択/単体タップ判定中なら、2本目は無視する
    if (event.shiftKey) return; // Shift中は通常操作(パン/カード移動)に譲る
    if (event.target.closest('.fe-bar, .fe-panel, .fe-history-panel, .fe-preview-overlay')) return;
    if (event.target.closest('.star-card-handle, .star-card-hex, button, textarea, input, a')) return;

    const cardEl = event.target.closest('.star-card');
    if (cardEl) {
      cardTapTrack = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, cardEl };
      return;
    }
    if (event.target === els.viewport) {
      beginMarquee(event);
    }
  }

  function onViewportPointerMove(event) {
    if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
      const p = viewportLocalPoint(event.clientX, event.clientY);
      marqueeDrag.x1 = p.x;
      marqueeDrag.y1 = p.y;
      updateMarqueeVisual();
    }
  }

  function onViewportPointerUp(event) {
    if (marqueeDrag && event.pointerId === marqueeDrag.pointerId) {
      finalizeMarquee();
    } else if (cardTapTrack && event.pointerId === cardTapTrack.pointerId) {
      finalizeCardTap(event);
    }
  }

  function onViewportDblClick(event) {
    if (!feActive) return;
    const sessionBody = event.target.closest('.star-card-session-body');
    if (!sessionBody) return;
    const cardEl = sessionBody.closest('.star-card');
    if (!cardEl) return;
    event.stopPropagation();
    const card = getCardById(cardEl.dataset.id);
    if (!card || card.mediaType !== 'session') return;
    showSessionPreview(card.refSessionId);
  }

  document.addEventListener('DOMContentLoaded', () => {
    els.viewport.addEventListener('pointerdown', onViewportPointerDown);
    els.viewport.addEventListener('pointermove', onViewportPointerMove);
    els.viewport.addEventListener('pointerup', onViewportPointerUp);
    els.viewport.addEventListener('dblclick', onViewportDblClick);
  });

  registerModuleCode('147', openFlightEngineer);
})();
