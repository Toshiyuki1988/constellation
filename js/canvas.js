// interact.js によるキャンバス操作:
// - 背景のパン(ドラッグ)とピンチズーム/ホイールズーム
// - カード(.star-card)は既定では当たり判定を持たず、1指操作はキャンバスのパンとして扱われる。
//   カードを0.3秒ほど長押しすると「移動可能モード」に入り、そのときだけカード自体がドラッグ対象になる。
// - カードのリサイズ(端のハンドル)は従来通り常時有効。

const viewportState = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

// カード長押し関連の調整値
const CARD_LONG_PRESS_MS = 300; // 0.25〜0.35秒の範囲で現代的なバランスとされる値
const CARD_PRESS_TOLERANCE_PX = 10; // 長押し待機中、指が多少動いてもキャンセルしない許容半径
const AUTO_PAN_MARGIN = 48; // この距離より画面端に近づいたらキャンバスを自動でパンする
const AUTO_PAN_MAX_SPEED = 14; // 端にぴったり張り付いた場合の1フレームあたりの移動量(px)

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

/* ---------------- カードの長押し→移動可能モード ---------------- */

/**
 * カードを0.3秒ほど長押しすると「移動可能モード」に入る。それ以外の1指操作は
 * (このカードでは何もせず)そのままキャンバスのパンとしてバブリングさせる。
 */
function attachCardLongPress(el) {
  let timer = null;
  let start = null; // { x, y, pointerId }
  let lifted = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function liftCard() {
    lifted = true;
    el.dataset.justLifted = '1';
    el.classList.remove('star-card--pressing');
    el.classList.add('star-card--lifted');
    applyCardTransform(el);
    interact(el).draggable({ enabled: true });
    // 移動可能モード中はキャンバス側のパン/ピンチと競合しないよう無効化する
    interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
    if (navigator.vibrate) navigator.vibrate(8);
  }

  function dropCard() {
    lifted = false;
    el.classList.remove('star-card--lifted', 'star-card--pressing');
    applyCardTransform(el);
    interact(el).draggable({ enabled: false });
    interact(viewportEl).draggable({ enabled: true }).gesturable({ enabled: true });
    stopAutoPan();
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, textarea')) return;
    start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    el.classList.add('star-card--pressing');
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      liftCard();
    }, CARD_LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.pointerId) return;
    if (lifted) {
      updateAutoPanPointer(event.clientX, event.clientY);
      return;
    }
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (moved > CARD_PRESS_TOLERANCE_PX) {
      clearTimer();
      el.classList.remove('star-card--pressing');
      start = null;
    }
  });

  ['pointerup', 'pointercancel'].forEach((type) => {
    el.addEventListener(type, () => {
      clearTimer();
      el.classList.remove('star-card--pressing');
      start = null;
      if (lifted) dropCard();
    });
  });
}

/** カード要素にドラッグ・リサイズを付与する(ドラッグは長押し確定まで無効) */
function makeCardInteractive(el) {
  interact(el)
    .draggable({
      enabled: false,
      ignoreFrom: 'button, textarea',
      listeners: {
        move(event) {
          const x = (parseFloat(el.dataset.x) || 0) + event.dx / viewportState.scale;
          const y = (parseFloat(el.dataset.y) || 0) + event.dy / viewportState.scale;
          el.dataset.x = String(x);
          el.dataset.y = String(y);
          applyCardTransform(el);
          updateAutoPanPointer(event.client.x, event.client.y);
        },
        end(event) {
          const card = getCardById(event.target.dataset.id);
          if (!card) return;
          card.x = parseFloat(event.target.dataset.x) || 0;
          card.y = parseFloat(event.target.dataset.y) || 0;
        },
      },
    })
    .resizable({
      edges: { left: true, right: true, top: true, bottom: true },
      listeners: {
        move(event) {
          let x = parseFloat(el.dataset.x) || 0;
          let y = parseFloat(el.dataset.y) || 0;
          x += event.deltaRect.left / viewportState.scale;
          y += event.deltaRect.top / viewportState.scale;

          Object.assign(el.style, {
            width: `${event.rect.width / viewportState.scale}px`,
            height: `${event.rect.height / viewportState.scale}px`,
          });
          el.dataset.x = String(x);
          el.dataset.y = String(y);
          applyCardTransform(el);
        },
        end(event) {
          const card = getCardById(event.target.dataset.id);
          if (!card) return;
          card.width = parseFloat(event.target.style.width);
          card.height = parseFloat(event.target.style.height);
          card.x = parseFloat(event.target.dataset.x) || 0;
          card.y = parseFloat(event.target.dataset.y) || 0;
        },
      },
      modifiers: [
        interact.modifiers.restrictSize({ min: { width: 120, height: 140 } }),
      ],
    });

  attachCardLongPress(el);
}
