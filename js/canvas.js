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

// 背景ダブルタップ(俯瞰ズーム)関連の調整値
const DOUBLE_TAP_MS = 350; // 1回目・2回目のタップの間隔がこれ以内なら「ダブルタップ」とみなす
const DOUBLE_TAP_MOVE_TOLERANCE_PX = 10; // 指を離すまでにこれ以上動いたらパン操作とみなしタップ扱いしない
const DOUBLE_TAP_DISTANCE_TOLERANCE_PX = 40; // 1回目・2回目のタップ位置がこれ以内ならダブルタップとみなす

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

// 背景ダブルタップ検知用の状態
let viewportPressStart = null; // { x, y } (client座標)。背景でpointerdownした位置
let lastViewportTapAt = 0;
let lastViewportTapPos = null;

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
    if (event.target === viewportEl) {
      viewportPressStart = { x: event.clientX, y: event.clientY };
    } else {
      viewportPressStart = null;
    }
  });

  // 非ガイドモードで背景(カードのない部分)をダブルタップ/ダブルクリックすると、
  // 全カードが収まるまでズームアウトして俯瞰できるようにする。
  // ブラウザ標準の dblclick はスマホでの二本指操作やinteract.jsの介在で確実に発火しない
  // ことがあるため、長押し検知(上記)と同様に自前でpointerup同士の間隔/距離を見て判定する。
  viewportEl.addEventListener('pointerup', (event) => {
    if (editGuideCard) return;
    if (event.target !== viewportEl) return;
    if (!viewportPressStart) return;
    const moved = Math.hypot(event.clientX - viewportPressStart.x, event.clientY - viewportPressStart.y);
    viewportPressStart = null;
    if (moved > DOUBLE_TAP_MOVE_TOLERANCE_PX) return; // パン操作の指離しはタップとみなさない

    const now = Date.now();
    const pos = { x: event.clientX, y: event.clientY };
    if (
      lastViewportTapPos &&
      now - lastViewportTapAt < DOUBLE_TAP_MS &&
      Math.hypot(pos.x - lastViewportTapPos.x, pos.y - lastViewportTapPos.y) < DOUBLE_TAP_DISTANCE_TOLERANCE_PX
    ) {
      lastViewportTapAt = 0;
      lastViewportTapPos = null;
      fitAllCardsToScreen();
    } else {
      lastViewportTapAt = now;
      lastViewportTapPos = pos;
    }
  });
}

/** 現在編集ガイドが表示されているカード要素(なければnull)。js/app.js のコピペ機能から参照する。 */
function getEditGuideCard() {
  return editGuideCard;
}

function onViewportPan(event) {
  viewportState.x += event.dx;
  viewportState.y += event.dy;
  applyViewportTransform();
}

/**
 * 指/カーソルの真下にある1点を固定したままスケールだけを変える。
 * (clientX, clientY) はブラウザ座標(viewportEl.getBoundingClientRect()基準に変換して使う)。
 */
function zoomAroundPoint(clientX, clientY, newScale) {
  newScale = clamp(newScale, MIN_SCALE, MAX_SCALE);
  const rect = viewportEl.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  // ズーム前、その画面座標が指していたコンテンツ側の座標(不変点)
  const contentX = (px - viewportState.x) / viewportState.scale;
  const contentY = (py - viewportState.y) / viewportState.scale;
  viewportState.scale = newScale;
  viewportState.x = px - contentX * newScale;
  viewportState.y = py - contentY * newScale;
  applyViewportTransform();
}

/** ブラウザ座標(clientX/Y)を、カードと同じ座標系(.canvas-content の生px)に変換する */
function clientToContent(clientX, clientY) {
  const rect = viewportEl.getBoundingClientRect();
  return {
    x: (clientX - rect.left - viewportState.x) / viewportState.scale,
    y: (clientY - rect.top - viewportState.y) / viewportState.scale,
  };
}

/** カード要素の中心を、.canvas-content の生px座標(カードのdata-x/y/style.width/heightと同じ系)で返す */
function getCardCenterFromEl(el) {
  const x = parseFloat(el.dataset.x) || 0;
  const y = parseFloat(el.dataset.y) || 0;
  const w = parseFloat(el.style.width) || el.offsetWidth;
  const h = parseFloat(el.style.height) || el.offsetHeight;
  return { x: x + w / 2, y: y + h / 2 };
}

function onViewportPinch(event) {
  zoomAroundPoint(event.clientX, event.clientY, viewportState.scale * (1 + event.ds));
}

function onViewportWheel(event) {
  event.preventDefault();
  const delta = -event.deltaY * 0.001;
  zoomAroundPoint(event.clientX, event.clientY, viewportState.scale + delta);
}

/* ---------------- 非ガイドモードでのダブルタップ: 全カードが収まるまでズームアウト ---------------- */

function fitAllCardsToScreen() {
  const cardEls = contentEl.querySelectorAll('.star-card');
  if (cardEls.length === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  cardEls.forEach((el) => {
    const x = parseFloat(el.dataset.x) || 0;
    const y = parseFloat(el.dataset.y) || 0;
    const w = parseFloat(el.style.width) || el.offsetWidth;
    const h = parseFloat(el.style.height) || el.offsetHeight;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  });

  const PADDING = 60; // 画面端に残す余白(px)
  const rect = viewportEl.getBoundingClientRect();
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const scaleX = (rect.width - PADDING * 2) / contentWidth;
  const scaleY = (rect.height - PADDING * 2) / contentHeight;
  const newScale = clamp(Math.min(scaleX, scaleY), MIN_SCALE, MAX_SCALE);
  const centerX = minX + contentWidth / 2;
  const centerY = minY + contentHeight / 2;

  contentEl.classList.add('canvas-content--animated');
  viewportState.scale = newScale;
  viewportState.x = rect.width / 2 - centerX * newScale;
  viewportState.y = rect.height / 2 - centerY * newScale;
  applyViewportTransform();
  setTimeout(() => contentEl.classList.remove('canvas-content--animated'), 400);
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
  // getBoundingClientRect() は画面上の(キャンバスのズームがかかった後の)pxを返すため、
  // カード自身のCSS px(ズーム前の論理値)に戻してから style.height に反映する
  const height = mediaEl.getBoundingClientRect().height / viewportState.scale;
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
  playGuideRevealSound();
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
// カード移動音: これだけ動くたびに1回鳴らす。速く動かすほど短時間で閾値に達するため、
// 自然に「ピッ・・ピ」(遅い)〜「ピルルルル」(速い)の緩急がついた連続音になる。
const MOVE_TICK_DISTANCE_PX = 42;

function attachCardGestures(el) {
  let pointerId = null; // 現在追跡中の唯一のポインタ(ボディの長押し待ち/移動)
  let pressStart = null; // { x, y }
  let moving = false;
  let lastPos = null;
  let moveTickAccumDist = 0;

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
    moveTickAccumDist = 0;
    interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
  }

  function updateMove(clientX, clientY) {
    const dx = (clientX - lastPos.x) / viewportState.scale;
    const dy = (clientY - lastPos.y) / viewportState.scale;
    const rawDist = Math.hypot(clientX - lastPos.x, clientY - lastPos.y);
    lastPos = { x: clientX, y: clientY };
    const x = (parseFloat(el.dataset.x) || 0) + dx;
    const y = (parseFloat(el.dataset.y) || 0) + dy;
    el.dataset.x = String(x);
    el.dataset.y = String(y);
    applyCardTransform(el);
    updateAutoPanPointer(clientX, clientY);
    redrawAsterismLines(); // 繋がっている線をカードの移動に追従させる

    moveTickAccumDist += rawDist;
    if (moveTickAccumDist >= MOVE_TICK_DISTANCE_PX) {
      moveTickAccumDist = 0;
      playCardMoveTickSound();
    }
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
    scheduleAutoSave();
  }

  el.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.star-card-handle, .star-card-hex')) return; // ハンドル/編集ガイドのボタンは専用処理
    if (event.target.closest('button, textarea, input')) return;
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
    redrawAsterismLines(); // 繋がっている線をカードのリサイズに追従させる
  }

  function commitHandleResize() {
    const card = getCardById(el.dataset.id);
    if (card) {
      card.width = parseFloat(el.style.width);
      card.height = parseFloat(el.style.height);
      card.x = parseFloat(el.dataset.x) || 0;
      card.y = parseFloat(el.dataset.y) || 0;
    }
    scheduleAutoSave();
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

/* ---------------- Asterism: 編集ガイドのASTRを長押し→ドラッグでカード同士を線でつなぐ ---------------- */

const ASTR_LONG_PRESS_MS = 280;
const ASTR_PRESS_TOLERANCE_PX = 10;

/**
 * ASTRヘックス(緑バッジ)1つぶんのジェスチャー。カード長押し(attachCardGestures)と同じ
 * Pointer Captureパターンで、「長押し確定→ドラッグ中は仮の線と対象カードの緑枠を表示→
 * 指を離した位置のカードへ接続」を行う。js/app.js の createAstrConnection() へ最終的な
 * データ更新を委譲する(このファイルは座標計算とジェスチャーだけを担当する)。
 */
function attachAstrGesture(el) {
  const hexEl = el.querySelector('.star-card-hex--astr');
  if (!hexEl) return;

  let pointerId = null;
  let pressStart = null;
  let pressTimer = null;
  let dragging = false;
  let tempLine = null;
  let targetEl = null;

  function clearPressTimer() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  }

  function updateTempLine(clientX, clientY) {
    if (!asterismSvg) return;
    if (!tempLine) {
      tempLine = document.createElementNS(SVG_NS, 'line');
      tempLine.setAttribute('class', 'asterism-line asterism-line--drag');
      asterismSvg.appendChild(tempLine);
    }
    const source = getCardCenterFromEl(el);
    const p = clientToContent(clientX, clientY);
    tempLine.setAttribute('x1', source.x);
    tempLine.setAttribute('y1', source.y);
    tempLine.setAttribute('x2', p.x);
    tempLine.setAttribute('y2', p.y);
  }

  function setTarget(newTargetEl) {
    if (targetEl === newTargetEl) return;
    if (targetEl) targetEl.classList.remove('star-card--astr-glow');
    targetEl = newTargetEl;
    if (targetEl) targetEl.classList.add('star-card--astr-glow');
  }

  function updateHoverTarget(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY);
    const cardUnder = under ? under.closest('.star-card') : null;
    setTarget(cardUnder && cardUnder !== el ? cardUnder : null);
  }

  function endDrag(commit) {
    dragging = false;
    el.classList.remove('star-card--astr-glow');
    if (tempLine) {
      tempLine.remove();
      tempLine = null;
    }
    if (commit && targetEl) {
      hexEl.dataset.justDragged = '1'; // 直後に発火するclickでヒントメッセージを出さないようにする
      createAstrConnection(el.dataset.id, targetEl.dataset.id);
    }
    setTarget(null);
    stopAutoPan();
    interact(viewportEl).draggable({ enabled: true }).gesturable({ enabled: true });
  }

  hexEl.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    if (pointerId !== null) return;
    pointerId = event.pointerId;
    pressStart = { x: event.clientX, y: event.clientY };
    try {
      hexEl.setPointerCapture(event.pointerId);
    } catch (err) {
      /* no-op */
    }
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      dragging = true;
      el.classList.add('star-card--astr-glow'); // 押し込んだ元のカードも同じ緑発光にする
      if (navigator.vibrate) navigator.vibrate(8);
      playAstrPressSound();
      interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
      updateTempLine(pressStart.x, pressStart.y);
    }, ASTR_LONG_PRESS_MS);
  });

  hexEl.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    if (dragging) {
      updateTempLine(event.clientX, event.clientY);
      updateHoverTarget(event.clientX, event.clientY);
      updateAutoPanPointer(event.clientX, event.clientY);
      return;
    }
    if (pressStart) {
      const moved = Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y);
      if (moved > ASTR_PRESS_TOLERANCE_PX) {
        clearPressTimer();
        pointerId = null;
        pressStart = null;
      }
    }
  });

  function handleEnd(event) {
    if (event.pointerId !== pointerId) return;
    clearPressTimer();
    if (dragging) endDrag(true);
    pointerId = null;
    pressStart = null;
  }

  ['pointerup', 'pointercancel'].forEach((type) => hexEl.addEventListener(type, handleEnd));
}

/** カード要素にジェスチャー(長押し編集ガイド表示・移動・ハンドルリサイズ)を付与する */
function makeCardInteractive(el) {
  attachCardGestures(el);
  attachAstrGesture(el);
}
