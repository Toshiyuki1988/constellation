// キャンバス操作:
// - 背景のパン(ドラッグ)とピンチズーム/ホイールズームは interact.js に任せる。
// - カード(.star-card)は既定では当たり判定を持たず、1指/マウスの操作はキャンバスの
//   パンとして扱われる。
// - カードを0.3秒ほど長押しすると「編集ガイド」が表示される(スマホ・PCで統一の操作)。
//   編集ガイドは緑のリング+四隅・四辺のハンドル(トンボ)で構成され、
//   - ボディをドラッグ → カードを移動
//   - 四隅のハンドルをドラッグ → 縦横同時の自由変形
//   - 四辺のハンドルをドラッグ → その軸だけの単独リサイズ
//   ができる。編集ガイドは指/マウスを離しても表示されたままになり、他のカードや
//   キャンバスを操作すると解除される。今後、編集ガイドにはさらに機能を追加していく想定。
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
const CARD_MAX_SIZE = 900; // ハンドルドラッグで際限なく巨大化しないための上限

// ハンドルの data-edge → どの辺を動かすか
const EDIT_GUIDE_HANDLE_EDGES = {
  nw: { left: true, top: true },
  n: { top: true },
  ne: { right: true, top: true },
  e: { right: true },
  se: { right: true, bottom: true },
  s: { bottom: true },
  sw: { left: true, bottom: true },
  w: { left: true },
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let contentEl = null;
let viewportEl = null;

function applyViewportTransform() {
  contentEl.style.transform =
    `translate(${viewportState.x}px, ${viewportState.y}px) scale(${viewportState.scale})`;
}

/** カードの位置(translate)を反映する */
function applyCardTransform(el) {
  const x = parseFloat(el.dataset.x) || 0;
  const y = parseFloat(el.dataset.y) || 0;
  el.style.transform = `translate(${x}px, ${y}px)`;
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
      // カード上からの操作も既定ではキャンバスのパンとして扱う(長押しで編集ガイドが出るまで)
    })
    .gesturable({
      listeners: { move: onViewportPinch },
    });

  viewportEl.addEventListener('wheel', onViewportWheel, { passive: false });

  // 長押し(パイメニュー/編集ガイドのトリガー)でブラウザ標準のテキスト選択/コンテキスト
  // メニューが出てしまうのを防ぐ。CSS の user-select だけでは Android Chrome 等で防ぎきれ
  // ないため contextmenu 自体も止める。
  viewportEl.addEventListener('contextmenu', (event) => event.preventDefault());

  // 編集ガイド表示中に他のカード/キャンバスを操作したら解除する
  viewportEl.addEventListener('pointerdown', (event) => {
    if (editGuideCard && !editGuideCard.contains(event.target)) {
      deactivateEditGuide(editGuideCard);
    }
  });
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

/* ---------------- カードの自動パン(移動中に画面端へ近づいたらキャンバスが追従する) ---------------- */

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

/** 写真・動画枠(.star-card-media)は syncCardHeight()(js/app.js)によって初回描画時に
 *  高さがpxで固定されている(flex:1のままだと auto 計測時に潰れてしまうため)。そのまま
 *  だとカード全体をリサイズしても写真枠の高さが追従できず、伸びた分がキャプション下の
 *  空白として残ってしまう。リサイズのたびに一度 flex:1 に戻して実際に確保できる高さを
 *  測り直し、その値で固定し直す。 */
function fitMediaToCardHeight(el) {
  const mediaEl = el.querySelector('.star-card-media');
  if (!mediaEl) return;
  mediaEl.style.flex = '1';
  mediaEl.style.height = '';
  const height = mediaEl.getBoundingClientRect().height;
  mediaEl.style.height = `${height}px`;
  mediaEl.style.flex = 'none';
}

/* ---------------- 編集ガイド(長押しで表示される緑のトンボ)の表示/解除 ---------------- */

let editGuideCard = null; // 現在編集ガイドが表示されているカード要素(同時に1枚のみ)

function activateEditGuide(el) {
  if (editGuideCard === el) return;
  if (editGuideCard) deactivateEditGuide(editGuideCard);
  editGuideCard = el;
  el.classList.add('star-card--edit-guide');
  el.dataset.justLifted = '1'; // タップで開くカード種別が、直後のタップで誤って開かないようにする
  if (navigator.vibrate) navigator.vibrate(8);
}

function deactivateEditGuide(el) {
  el.classList.remove('star-card--edit-guide');
  if (editGuideCard === el) editGuideCard = null;
}

/* ---------------- カードのジェスチャー(長押し=編集ガイド表示、以後ボディ/ハンドルを操作) ---------------- */

/**
 * カード1枚ぶんのジェスチャーを管理する:
 * - 未表示の状態で1点(指/マウス/ペン)がボディを押すと、0.3秒長押しで編集ガイドを表示する
 *   (待っている間に指が大きく動いたらキャンセルし、既定のキャンバスパンに委ねる)。
 * - 編集ガイド表示中にボディを押すと、長押し不要ですぐカードの移動を開始する。
 * - 編集ガイドのハンドル(緑のトンボ)を押すと、長押し不要ですぐそのハンドルに応じた
 *   リサイズ(四隅=自由変形、四辺=単独軸)を開始する。
 * どちらも Pointer Capture を使い、ポインタがカードの外まで大きく動いても
 * このカード自身でイベントを受け続けられるようにしている。
 */
function attachCardGestures(el) {
  let pointerId = null; // 現在追跡中の唯一のポインタ(ボディの長押し待ち/移動)
  let pressStart = null; // { x, y }
  let moving = false;
  let lastPos = null;

  let handleResize = null; // { pointerId, edges, startClientX, startClientY, startWidth, startHeight, startCardX, startCardY }
  let pressTimer = null;

  function clearPressTimer() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function beginMove(clientX, clientY) {
    moving = true;
    lastPos = { x: clientX, y: clientY };
    interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
  }

  function updateMove(clientX, clientY) {
    const dx = (clientX - lastPos.x) / viewportState.scale;
    const dy = (clientY - lastPos.y) / viewportState.scale;
    lastPos = { x: clientX, y: clientY };
    const x = (parseFloat(el.dataset.x) || 0) + dx;
    const y = (parseFloat(el.dataset.y) || 0) + dy;
    el.dataset.x = String(x);
    el.dataset.y = String(y);
    applyCardTransform(el);
    updateAutoPanPointer(clientX, clientY);
  }

  function endMove() {
    moving = false;
    const card = getCardById(el.dataset.id);
    if (card) {
      card.x = parseFloat(el.dataset.x) || 0;
      card.y = parseFloat(el.dataset.y) || 0;
    }
    interact(viewportEl).draggable({ enabled: true }).gesturable({ enabled: true });
    stopAutoPan();
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.star-card-handle')) return; // ハンドルは専用リスナーで処理
    if (event.target.closest('button, textarea')) return;
    if (pointerId !== null) return; // 既に1点を追跡中なら追加のポインタは無視

    pointerId = event.pointerId;
    pressStart = { x: event.clientX, y: event.clientY };
    try {
      el.setPointerCapture(event.pointerId);
    } catch (err) {
      /* ブラウザによっては無効な pointerId で例外を投げることがあるため無視する */
    }

    if (el.classList.contains('star-card--edit-guide')) {
      // 既に編集ガイド表示中: ボディを掴んだので長押し不要ですぐ移動を開始する
      beginMove(event.clientX, event.clientY);
      return;
    }

    // 未表示: 長押しで編集ガイドを表示する
    el.classList.add('star-card--pressing');
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      el.classList.remove('star-card--pressing');
      activateEditGuide(el);
      beginMove(event.clientX, event.clientY);
    }, CARD_LONG_PRESS_MS);
  });

  el.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;

    if (moving) {
      updateMove(event.clientX, event.clientY);
      return;
    }

    if (pressStart) {
      const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y);
      if (moved > CARD_PRESS_TOLERANCE_PX) {
        clearPressTimer();
        el.classList.remove('star-card--pressing');
        pointerId = null;
        pressStart = null;
      }
    }
  });

  function handlePointerEnd(event) {
    if (event.pointerId !== pointerId) return;
    clearPressTimer();
    el.classList.remove('star-card--pressing');
    if (moving) endMove();
    pointerId = null;
    pressStart = null;
  }

  ['pointerup', 'pointercancel'].forEach((type) => {
    el.addEventListener(type, handlePointerEnd);
  });

  /* ---- 編集ガイドのハンドル(四隅=自由変形、四辺=単独軸リサイズ) ---- */

  function updateHandleResize(event) {
    const dx = (event.clientX - handleResize.startClientX) / viewportState.scale;
    const dy = (event.clientY - handleResize.startClientY) / viewportState.scale;
    let width = handleResize.startWidth;
    let height = handleResize.startHeight;

    if (handleResize.edges.right) width = handleResize.startWidth + dx;
    if (handleResize.edges.left) width = handleResize.startWidth - dx;
    if (handleResize.edges.bottom) height = handleResize.startHeight + dy;
    if (handleResize.edges.top) height = handleResize.startHeight - dy;

    width = clamp(width, CARD_MIN_WIDTH, CARD_MAX_SIZE);
    height = clamp(height, CARD_MIN_HEIGHT, CARD_MAX_SIZE);

    // 右端/下端は左上を固定点にすればよいが、左端/上端は反対側(右/下)が固定点になるため、
    // クランプ後の幅・高さから x/y を逆算する
    const x = handleResize.edges.left
      ? handleResize.startCardX + (handleResize.startWidth - width)
      : handleResize.startCardX;
    const y = handleResize.edges.top
      ? handleResize.startCardY + (handleResize.startHeight - height)
      : handleResize.startCardY;

    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.dataset.x = String(x);
    el.dataset.y = String(y);
    applyCardTransform(el);
    fitMediaToCardHeight(el);
  }

  function commitHandleResize() {
    const card = getCardById(el.dataset.id);
    if (card) {
      card.width = parseFloat(el.style.width);
      card.height = parseFloat(el.style.height);
      card.x = parseFloat(el.dataset.x) || 0;
      card.y = parseFloat(el.dataset.y) || 0;
    }
  }

  el.querySelectorAll('.star-card-handle').forEach((handleEl) => {
    const edges = EDIT_GUIDE_HANDLE_EDGES[handleEl.dataset.edge];

    handleEl.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      handleResize = {
        pointerId: event.pointerId,
        edges,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: parseFloat(el.style.width) || el.getBoundingClientRect().width,
        startHeight: parseFloat(el.style.height) || el.getBoundingClientRect().height,
        startCardX: parseFloat(el.dataset.x) || 0,
        startCardY: parseFloat(el.dataset.y) || 0,
      };
      try {
        handleEl.setPointerCapture(event.pointerId);
      } catch (err) {
        /* no-op */
      }
      interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
    });

    handleEl.addEventListener('pointermove', (event) => {
      if (!handleResize || event.pointerId !== handleResize.pointerId) return;
      updateHandleResize(event);
    });

    ['pointerup', 'pointercancel'].forEach((type) => {
      handleEl.addEventListener(type, (event) => {
        if (!handleResize || event.pointerId !== handleResize.pointerId) return;
        commitHandleResize();
        handleResize = null;
        interact(viewportEl).draggable({ enabled: true }).gesturable({ enabled: true });
      });
    });
  });
}

/** カード要素にジェスチャー(長押し編集ガイド表示・移動・ハンドルリサイズ)を付与する */
function makeCardInteractive(el) {
  attachCardGestures(el);
}
