// CONSTELLATION — モジュール共通の起動基盤(コア機能。js/modules/ 配下の個々の
// モジュールではなく、それらをまとめて呼び出すための土台なのでここに置く)。
//
// 背景を2本指でダブルタップすると、1〜9のキーパッドHUDが開く。3桁のコードを
// 入力すると、対応するモジュールが起動する。モジュール側は registerModuleCode()
// で自分のコードを登録するだけでよく、モジュールが増えるたびに新しい非衝突
// ジェスチャーを考案する必要がない(以前はモジュールごとに専用ジェスチャーを
// 作っていたが、既存のパン/ピンチ/長押しと衝突を繰り返したためこの方式にした)。
//
// キーパッドの3x3配置は、電話のキーパッドと同じ並びだが、中国古代の洛書
// (らくしょ)や魔方陣に見られる「9マスで秩序を表す」意匠を借り、中央(5)を
// 特別な起点として扱い、マス同士を薄い線で結んでいる(このアプリの主星・伴星を
// つなぐ線と同じ視覚言語)。
//
// PC(マウス)は2本指ダブルタップができないため、CONSTELLATION PIE(長押し
// メニュー、js/app.js)に「キーパッド」項目を用意し、window.openModuleKeypad()
// を呼べば同じキーパッドを開ける。

(function () {
  'use strict';

  const moduleCodes = new Map(); // code(文字列) -> callback

  /** モジュール側から呼ぶ。例: registerModuleCode('123', openWormgate); */
  function registerModuleCode(code, callback) {
    moduleCodes.set(String(code), callback);
  }

  let kpEls = null;
  let enteredDigits = '';

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .module-keypad-overlay {
        position: fixed; inset: 0; z-index: 140;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none;
        transition: opacity 0.2s ease-out;
      }
      .module-keypad-overlay.open { opacity: 1; pointer-events: auto; }
      .module-keypad-backdrop {
        position: absolute; inset: 0;
        background: rgba(5, 8, 10, 0.55);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      }
      .module-keypad-panel {
        position: relative;
        width: min(78vw, 300px);
        background: rgba(14, 22, 26, 0.68);
        border: 1px solid rgba(85, 230, 247, 0.28);
        border-radius: 18px;
        padding: 22px 22px 20px;
        box-shadow: 0 0 40px rgba(85, 230, 247, 0.14), 0 24px 60px rgba(0, 0, 0, 0.4);
        transform: scale(0.9);
        transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .module-keypad-overlay.open .module-keypad-panel { transform: scale(1); }
      .module-keypad-eyebrow {
        text-align: center; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px;
        letter-spacing: 0.12em; color: rgba(85, 230, 247, 0.55); text-transform: uppercase;
        margin-bottom: 10px;
      }
      .module-keypad-display {
        display: flex; justify-content: center; gap: 16px; margin-bottom: 18px;
        font-family: 'IBM Plex Mono', monospace; font-size: 22px; color: #55e6f7; letter-spacing: 0.05em;
      }
      .module-keypad-slot {
        width: 30px; height: 38px; border-bottom: 2px solid rgba(85, 230, 247, 0.3);
        display: flex; align-items: center; justify-content: center;
      }
      .module-keypad-slot.filled { border-color: #55e6f7; }
      .module-keypad-grid-wrap { position: relative; }
      .module-keypad-lines {
        position: absolute; inset: 0; pointer-events: none;
      }
      .module-keypad-lines line {
        stroke: rgba(85, 230, 247, 0.16); stroke-width: 1; stroke-dasharray: 2 5;
      }
      .module-keypad-grid {
        position: relative;
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px;
      }
      .module-keypad-btn {
        aspect-ratio: 1; border-radius: 50%;
        background: rgba(85, 230, 247, 0.07); border: 1px solid rgba(85, 230, 247, 0.28);
        color: #eafcff; font-family: 'IBM Plex Mono', monospace; font-size: 17px;
        cursor: pointer; transition: background 0.1s, box-shadow 0.15s;
      }
      .module-keypad-btn:hover { background: rgba(85, 230, 247, 0.16); }
      .module-keypad-btn:active { background: rgba(85, 230, 247, 0.32); }
      .module-keypad-btn--center {
        box-shadow: 0 0 16px rgba(85, 230, 247, 0.35);
        border-color: rgba(85, 230, 247, 0.5);
      }
      .module-keypad-panel.shake { animation: module-keypad-shake 0.35s; }
      @keyframes module-keypad-shake {
        0%, 100% { transform: translateX(0) scale(1); }
        25% { transform: translateX(-8px) scale(1); }
        75% { transform: translateX(8px) scale(1); }
      }
      .module-keypad-hint {
        text-align: center; margin-top: 16px;
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; color: rgba(255, 255, 255, 0.4);
      }
    `;
    document.head.appendChild(style);
  }

  function buildDom() {
    const overlay = document.createElement('div');
    overlay.className = 'module-keypad-overlay';
    overlay.innerHTML = `
      <div class="module-keypad-backdrop"></div>
      <div class="module-keypad-panel">
        <div class="module-keypad-eyebrow">Module Access — 九宮</div>
        <div class="module-keypad-display">
          <div class="module-keypad-slot"></div>
          <div class="module-keypad-slot"></div>
          <div class="module-keypad-slot"></div>
        </div>
        <div class="module-keypad-grid-wrap">
          <svg class="module-keypad-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line x1="0" y1="50" x2="100" y2="50" />
            <line x1="50" y1="0" x2="50" y2="100" />
            <line x1="0" y1="0" x2="100" y2="100" />
            <line x1="100" y1="0" x2="0" y2="100" />
          </svg>
          <div class="module-keypad-grid">
            ${[7, 8, 9, 4, 5, 6, 1, 2, 3]
              .map((n) => `<button class="module-keypad-btn${n === 5 ? ' module-keypad-btn--center' : ''}" data-digit="${n}">${n}</button>`)
              .join('')}
          </div>
        </div>
        <div class="module-keypad-hint">コードを入力・背景タップで閉じる</div>
      </div>
    `;
    document.body.appendChild(overlay);

    kpEls = {
      overlay,
      panel: overlay.querySelector('.module-keypad-panel'),
      slots: overlay.querySelectorAll('.module-keypad-slot'),
    };

    overlay.querySelectorAll('.module-keypad-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onDigit(btn.dataset.digit);
      });
    });
    overlay.querySelector('.module-keypad-backdrop').addEventListener('click', closeModuleKeypad);
  }

  function updateSlots() {
    kpEls.slots.forEach((slot, i) => {
      slot.textContent = enteredDigits[i] || '';
      slot.classList.toggle('filled', Boolean(enteredDigits[i]));
    });
  }

  function onDigit(d) {
    soundAudioCtx();
    playGuideRevealSound(); // 既存の「ピッ」を流用(押すたびの確認音)
    enteredDigits += d;
    updateSlots();
    if (enteredDigits.length < 3) return;

    const callback = moduleCodes.get(enteredDigits);
    if (callback) {
      closeModuleKeypad();
      callback();
    } else {
      kpEls.panel.classList.add('shake');
      setTimeout(() => {
        kpEls.panel.classList.remove('shake');
        enteredDigits = '';
        updateSlots();
      }, 380);
    }
  }

  /** PCではマウスクリックだけでなく、キーボードの数字キー(テンキー含む)でも入力できる。
   *  event.key はテンキーの数字でも通常の数字キーと同じ "1"〜"9" になるため、
   *  Numpad用に特別な分岐をする必要はない。 */
  function onKeypadKeydown(event) {
    if (event.key === 'Escape') {
      closeModuleKeypad();
      return;
    }
    if (event.key >= '1' && event.key <= '9') {
      onDigit(event.key);
    }
  }

  function openModuleKeypad() {
    soundAudioCtx();
    if (!kpEls) {
      injectStyles();
      buildDom();
    }
    enteredDigits = '';
    updateSlots();
    kpEls.overlay.classList.add('open');
    document.addEventListener('keydown', onKeypadKeydown);
  }

  function closeModuleKeypad() {
    if (!kpEls) return;
    document.removeEventListener('keydown', onKeypadKeydown);
    kpEls.overlay.classList.remove('open');
  }

  /* ---------------- 背景を2本指でダブルタップすると起動 ----------------
   * 「2本指で同時に押して、すぐ離す」を1回のタップ単位とみなし、それが短い間隔で
   * 2回続いたら起動する。1本指パン・2本指ピンチ・長押し(パイメニュー)のいずれとも
   * 動きの質(本数・保持時間・移動量)が異なるため、既存のinteract.js/pie-menu.jsには
   * 一切手を触れず、ただポインタイベントを観測するだけで判定できる。 */

  const TAP_MOVE_TOLERANCE_PX = 14;
  const TAP_MAX_HOLD_MS = 350;
  const DOUBLE_GAP_MAX_MS = 600;
  const DOUBLE_POS_TOLERANCE_PX = 90;

  let activeCount = 0;
  let episodeActive = false;
  let episodeStartAt = 0;
  let episodePeakCount = 0;
  let episodeMoved = false;
  let episodePositions = []; // { id, x, y, startX, startY }
  let lastTwoTapAt = 0;
  let lastTwoTapPos = null;

  function onLauncherPointerDown(e) {
    if (e.target !== els.viewport) return;
    activeCount++;
    if (activeCount === 1) {
      episodeActive = true;
      episodeStartAt = performance.now();
      episodePeakCount = 1;
      episodeMoved = false;
      episodePositions = [{ id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY }];
    } else if (episodeActive) {
      episodePeakCount = Math.max(episodePeakCount, activeCount);
      episodePositions.push({ id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY });
      if (episodePeakCount === 2) {
        // 2本目の指が乗った = 1本指ダブルタップ(俯瞰ズーム、canvas.js)の判定と紛れないよう、
        // そちらの状態をリセットしておく(canvas.jsのグローバル変数を直接触る)。
        viewportPressStart = null;
        lastViewportTapAt = 0;
        lastViewportTapPos = null;
      }
    }
  }

  function onLauncherPointerMove(e) {
    if (!episodeActive) return;
    const entry = episodePositions.find((p) => p.id === e.pointerId);
    if (!entry) return;
    entry.x = e.clientX;
    entry.y = e.clientY;
    if (Math.hypot(e.clientX - entry.startX, e.clientY - entry.startY) > TAP_MOVE_TOLERANCE_PX) {
      episodeMoved = true;
    }
  }

  function onLauncherPointerUp(e) {
    if (activeCount > 0) activeCount--;
    if (!episodeActive) return;
    if (activeCount === 0) {
      episodeActive = false;
      const duration = performance.now() - episodeStartAt;
      if (episodePeakCount === 2 && !episodeMoved && duration < TAP_MAX_HOLD_MS) {
        registerTwoFingerTap(episodePositions);
      }
      episodePositions = [];
    }
  }

  function registerTwoFingerTap(positions) {
    if (positions.length < 2) return;
    const midX = (positions[0].x + positions[1].x) / 2;
    const midY = (positions[0].y + positions[1].y) / 2;
    const now = performance.now();
    if (
      lastTwoTapAt &&
      now - lastTwoTapAt < DOUBLE_GAP_MAX_MS &&
      Math.hypot(midX - lastTwoTapPos.x, midY - lastTwoTapPos.y) < DOUBLE_POS_TOLERANCE_PX
    ) {
      lastTwoTapAt = 0;
      lastTwoTapPos = null;
      openModuleKeypad();
    } else {
      lastTwoTapAt = now;
      lastTwoTapPos = { x: midX, y: midY };
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    els.viewport.addEventListener('pointerdown', onLauncherPointerDown);
    els.viewport.addEventListener('pointermove', onLauncherPointerMove);
    els.viewport.addEventListener('pointerup', onLauncherPointerUp);
    els.viewport.addEventListener('pointercancel', onLauncherPointerUp);
  });

  window.registerModuleCode = registerModuleCode;
  window.openModuleKeypad = openModuleKeypad;
})();
