// キャンバス操作:
// - 背景のパン(ドラッグ)とピンチズーム/ホイールズームは interact.js に任せる。
// - カード(.star-card)は既定では当たり判定を持たず、1指操作はキャンバスのパンとして扱われる。
//   カードを0.3秒ほど1指で長押しすると「移動可能モード」に入り、そのときだけカードが指に追従する。
//   カードを2本指で長押しすると「リサイズ可能モード」に入り、そのままピンチイン/アウトで
//   カード自体の大きさを変えられる(四隅の当たり判定によるリサイズは廃止)。
// - カード側の移動・リサイズは interact.js を使わず、Pointer Events(Pointer Capture)による
//   自前の実装。理由は、interact.js の resizable(端の当たり判定)がタッチ環境では既定20pxと
//   広く、小さいカードでは移動しようとした操作までリサイズに奪われてしまう問題があったため。

const viewportState = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

// カードジェスチャー関連の調整値
const CARD_LONG_PRESS_MS = 300; // 0.25〜0.35秒の範囲で現代的なバランスとされる値
const CARD_PRESS_TOLERANCE_PX = 10; // 長押し待機中、指が多少動いてもキャンセルしない許容半径
const AUTO_PAN_MARGIN = 48; // この距離より画面端に近づいたらキャンバスを自動でパンする
const AUTO_PAN_MAX_SPEED = 14; // 端にぴったり張り付いた場合の1フレームあたりの移動量(px)
const CARD_MIN_WIDTH = 120;
const CARD_MIN_HEIGHT = 140;
const CARD_MAX_SIZE = 900; // ピンチで際限なく巨大化しないための上限
const CARD_PINCH_RATIO_MIN = 0.3;
const CARD_PINCH_RATIO_MAX = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let contentEl = null;
let viewportEl = null;

function applyViewportTransform() {
  contentEl.style.transform =
    `translate(${viewportState.x}px, ${viewportState.y}px) scale(${viewportState.scale})`;
}

/** カードの位置(translate)を反映する。移動可能モード中はわずかな拡大も重ねて表示する */
function applyCardTransform(el) {
  const x = parseFloat(el.dataset.x) || 0;
  const y = parseFloat(el.dataset.y) || 0;
  const scale = el.classList.contains('star-card--lifted') ? ' scale(1.035)' : '';
  el.style.transform = `translate(${x}px, ${y}px)${scale}`;
}

/**
 * @param {HTMLElement} viewportElArg パン/ズームを受け付ける外枠
 * @param {HTMLElement} contentElArg 実際に transform をかける内側コンテナ
 */
function initCanvas(viewportElArg, contentElArg) {
  viewportEl = viewportElArg;
  contentEl = contentElArg;

  interact(viewportEl)
    .draggable({
      listeners: { move: onViewportPan },
      // カード上からの1指操作も既定ではキャンバスのパンとして扱う(長押しで移動モードに入るまで)
    })
    .gesturable({
      listeners: { move: onViewportPinch },
    });

  viewportEl.addEventListener('wheel', onViewportWheel, { passive: false });

  // 長押し(パイメニューのトリガー)でブラウザ標準のテキスト選択/コンテキストメニューが
  // 出てしまうのを防ぐ。CSS の user-select だけでは Android Chrome 等で防ぎきれないため
  // contextmenu 自体も止める。
  viewportEl.addEventListener('contextmenu', (event) => event.preventDefault());
}

function onViewportPan(event) {
  viewportState.x += event.dx;
  viewportState.y += event.dy;
  applyViewportTransform();
}

function onViewportPinch(event) {
  viewportState.scale = clamp(viewportState.scale * (1 + event.ds), MIN_SCALE, MAX_SCALE);
  applyViewportTransform();
}

function onViewportWheel(event) {
  event.preventDefault();
  const delta = -event.deltaY * 0.001;
  viewportState.scale = clamp(viewportState.scale + delta, MIN_SCALE, MAX_SCALE);
  applyViewportTransform();
}

/* ---------------- カードの自動パン(移動可能モードで画面端に近づいたらキャンバスが追従する) ---------------- */

let autoPanPointer = null; // { x, y } (client座標)。null の間は動かさない
let autoPanRAF = null;

function autoPanStep() {
  if (!autoPanPointer) {
    autoPanRAF = null;
    return;
  }
  const rect = viewportEl.getBoundingClientRect();
  const { x, y } = autoPanPointer;
  let dx = 0;
  let dy = 0;
  if (x - rect.left < AUTO_PAN_MARGIN) {
    dx = AUTO_PAN_MAX_SPEED * (1 - Math.max(0, x - rect.left) / AUTO_PAN_MARGIN);
  } else if (rect.right - x < AUTO_PAN_MARGIN) {
    dx = -AUTO_PAN_MAX_SPEED * (1 - Math.max(0, rect.right - x) / AUTO_PAN_MARGIN);
  }
  if (y - rect.top < AUTO_PAN_MARGIN) {
    dy = AUTO_PAN_MAX_SPEED * (1 - Math.max(0, y - rect.top) / AUTO_PAN_MARGIN);
  } else if (rect.bottom - y < AUTO_PAN_MARGIN) {
    dy = -AUTO_PAN_MAX_SPEED * (1 - Math.max(0, rect.bottom - y) / AUTO_PAN_MARGIN);
  }
  if (dx || dy) {
    viewportState.x += dx;
    viewportState.y += dy;
    applyViewportTransform();
  }
  autoPanRAF = requestAnimationFrame(autoPanStep);
}

function updateAutoPanPointer(clientX, clientY) {
  autoPanPointer = { x: clientX, y: clientY };
  if (!autoPanRAF) autoPanRAF = requestAnimationFrame(autoPanStep);
}

function stopAutoPan() {
  autoPanPointer = null;
}

/* ---------------- カードのジェスチャー(1指長押し=移動 / 2指長押し=リサイズ) ---------------- */

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * カード1枚ぶんのジェスチャーを管理する。指の本数で役割が変わる:
 * - 1指: 既定ではそのままキャンバスのパンとしてバブリングさせる。0.3秒長押しすると
 *   「移動可能モード」に入り、そのまま指に追従して移動する。
 * - 2指: 両方の指が0.3秒ほど静止したら「リサイズ可能モード」に入り、以降は2指の間の
 *   距離の変化(ピンチイン/アウト)に合わせてカード自身の大きさを変える。
 *
 * どちらのモードも Pointer Capture を使い、指がカードの外まで大きく動いても
 * このカード自身でイベントを受け続けられるようにしている。
 */
function attachCardGestures(el) {
  const pointers = new Map(); // pointerId -> { x, y }(このカード上でいま押されている指)

  // 1指(移動)の状態
  let moveTimer = null;
  let moveStart = null; // { x, y, pointerId }
  let moveLastPos = null;
  let moveLifted = false;

  // 2指(リサイズ)の状態
  let resizeTimer = null;
  let resizePending = null; // { ids: [id1, id2], starts: {id: {x,y}} } (長押し待機中)
  let resizeActive = false;
  let resizeStart = null; // { dist, width, height, centerX, centerY }

  function clearMoveTimer() {
    if (moveTimer) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
  }

  function clearResizeTimer() {
    if (resizeTimer) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
  }

  function liftMove() {
    moveLifted = true;
    el.dataset.justLifted = '1';
    el.classList.remove('star-card--pressing');
    el.classList.add('star-card--lifted');
    applyCardTransform(el);
    interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function dropMove() {
    moveLifted = false;
    const card = getCardById(el.dataset.id);
    if (card) {
      card.x = parseFloat(el.dataset.x) || 0;
      card.y = parseFloat(el.dataset.y) || 0;
    }
    el.classList.remove('star-card--lifted');
    applyCardTransform(el);
    interact(viewportEl).draggable({ enabled: true }).gesturable({ enabled: true });
    stopAutoPan();
  }

  /** 単指フローを中断する(2本目の指が触れた/指が離れた等)。移動可能モード中なら位置を確定して戻す */
  function cancelMove() {
    clearMoveTimer();
    el.classList.remove('star-card--pressing');
    moveStart = null;
    moveLastPos = null;
    if (moveLifted) dropMove();
  }

  function beginResizePending() {
    const ids = Array.from(pointers.keys());
    const starts = {};
    ids.forEach((id) => { starts[id] = { ...pointers.get(id) }; });
    resizePending = { ids, starts };
    clearResizeTimer();
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      startResizeActive();
    }, CARD_LONG_PRESS_MS);
  }

  function startResizeActive() {
    if (!resizePending) return;
    resizeActive = true;
    el.classList.remove('star-card--pressing');
    el.classList.add('star-card--resize-ready');
    const [idA, idB] = resizePending.ids;
    const a = pointers.get(idA);
    const b = pointers.get(idB);
    const width = parseFloat(el.style.width) || el.getBoundingClientRect().width;
    const height = parseFloat(el.style.height) || el.getBoundingClientRect().height;
    const x = parseFloat(el.dataset.x) || 0;
    const y = parseFloat(el.dataset.y) || 0;
    resizeStart = {
      dist: distanceBetween(a, b),
      width,
      height,
      centerX: x + width / 2,
      centerY: y + height / 2,
    };
    interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function updateResizeActive() {
    if (!resizeActive || !resizeStart || !resizePending) return;
    const [idA, idB] = resizePending.ids;
    const a = pointers.get(idA);
    const b = pointers.get(idB);
    if (!a || !b) return;
    const ratio = clamp(distanceBetween(a, b) / resizeStart.dist, CARD_PINCH_RATIO_MIN, CARD_PINCH_RATIO_MAX);
    const width = clamp(resizeStart.width * ratio, CARD_MIN_WIDTH, CARD_MAX_SIZE);
    const height = clamp(resizeStart.height * ratio, CARD_MIN_HEIGHT, CARD_MAX_SIZE);
    const x = resizeStart.centerX - width / 2;
    const y = resizeStart.centerY - height / 2;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.dataset.x = String(x);
    el.dataset.y = String(y);
    applyCardTransform(el);
  }

  function endResizeActive() {
    resizeActive = false;
    resizeStart = null;
    el.classList.remove('star-card--resize-ready');
    const card = getCardById(el.dataset.id);
    if (card) {
      card.width = parseFloat(el.style.width);
      card.height = parseFloat(el.style.height);
      card.x = parseFloat(el.dataset.x) || 0;
      card.y = parseFloat(el.dataset.y) || 0;
    }
    interact(viewportEl).draggable({ enabled: true }).gesturable({ enabled: true });
  }

  function cancelResizePending() {
    clearResizeTimer();
    el.classList.remove('star-card--pressing');
    resizePending = null;
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, textarea')) return;
    if (pointers.size >= 2) return; // 3本目以降は無視

    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      el.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ブラウザによっては無効な pointerId で例外を投げることがあるため無視する */
    }

    if (pointers.size === 1) {
      moveStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
      moveLastPos = { x: event.clientX, y: event.clientY };
      el.classList.add('star-card--pressing');
      clearMoveTimer();
      moveTimer = setTimeout(() => {
        moveTimer = null;
        liftMove();
      }, CARD_LONG_PRESS_MS);
    } else if (pointers.size === 2) {
      // 2本目が触れたら単指の移動フローは中断し、2本指リサイズの長押し待機に切り替える
      cancelMove();
      el.classList.add('star-card--pressing');
      beginResizePending();
    }
  });

  el.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (resizeActive) {
      updateResizeActive();
      return;
    }

    if (resizePending) {
      const stillWithinTolerance = resizePending.ids.every((id) => {
        const now = pointers.get(id);
        const start = resizePending.starts[id];
        return distanceBetween(now, start) <= CARD_PRESS_TOLERANCE_PX;
      });
      if (!stillWithinTolerance) cancelResizePending();
      return;
    }

    if (moveStart && event.pointerId === moveStart.pointerId) {
      if (moveLifted) {
        const dx = (event.clientX - moveLastPos.x) / viewportState.scale;
        const dy = (event.clientY - moveLastPos.y) / viewportState.scale;
        moveLastPos = { x: event.clientX, y: event.clientY };
        const x = (parseFloat(el.dataset.x) || 0) + dx;
        const y = (parseFloat(el.dataset.y) || 0) + dy;
        el.dataset.x = String(x);
        el.dataset.y = String(y);
        applyCardTransform(el);
        updateAutoPanPointer(event.clientX, event.clientY);
        return;
      }
      const moved = Math.hypot(event.clientX - moveStart.x, event.clientY - moveStart.y);
      if (moved > CARD_PRESS_TOLERANCE_PX) {
        clearMoveTimer();
        el.classList.remove('star-card--pressing');
        moveStart = null;
      }
    }
  });

  function handlePointerEnd(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);

    if (resizeActive) {
      if (pointers.size < 2) endResizeActive();
      return;
    }
    if (resizePending) {
      cancelResizePending();
      return;
    }
    if (moveStart && event.pointerId === moveStart.pointerId) {
      clearMoveTimer();
      el.classList.remove('star-card--pressing');
      const wasLifted = moveLifted;
      moveStart = null;
      if (wasLifted) dropMove();
    }
  }

  ['pointerup', 'pointercancel'].forEach((type) => {
    el.addEventListener(type, handlePointerEnd);
  });
}

/** カード要素にジェスチャー(1指長押し移動・2指長押しリサイズ)を付与する */
function makeCardInteractive(el) {
  attachCardGestures(el);
}
