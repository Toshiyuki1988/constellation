// CONSTELLATION PIE: キャンバスの空白部分を長押しすると開く、制作ツールへの追加アクセス手段。
// 既存のボトムツールバーを置き換えるものではなく、素早く呼び出すためのショートカット。
//
// 見た目・線のスタイル(細線+両端ドット、#000ベース、破線)は、主星・伴星を結ぶ軌跡線と
// 同じ視覚言語を使う。

const PIE_LONG_PRESS_MS = 400;
const PIE_MOVE_CANCEL_PX = 8;
const PIE_MIN_RADIUS = 70;
const PIE_MAX_RADIUS = 130;
const PIE_HIT_RADIUS = 46; // 指を離した位置がこの距離以内のツールだけ実行対象になる
const PIE_MAGNET_RADIUS = 120; // この距離より近いツールほど拡大する
const PIE_EDGE_MARGIN = 40; // 画面端からの最低マージン

let pieLongPressTimer = null;
let pieLongPressStart = null; // { x, y, pointerId }
let pieState = null; // 開いている間だけ存在する

/**
 * @param {HTMLElement} viewportEl 長押しを検知する対象(キャンバスのビューポート)
 * @param {() => Array<{label: string, icon: string, action: () => void}>} getTools
 *        呼び出すたびに現在のツール一覧を返す関数(サインイン状態などを反映するため遅延評価する)
 * @param {() => boolean} isEnabled 長押しメニューを起動してよい状態かどうか
 */
function initPieMenu(viewportEl, getTools, isEnabled) {
  viewportEl.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!isEnabled() || pieState) return;
    if (event.target.closest('.star-card')) return; // 既存カード上の長押しは対象外

    pieLongPressStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    pieLongPressTimer = setTimeout(() => {
      pieLongPressTimer = null;
      const tools = getTools();
      if (tools.length > 0) openPieMenu(pieLongPressStart.x, pieLongPressStart.y, tools, pieLongPressStart.pointerId);
    }, PIE_LONG_PRESS_MS);
  });

  viewportEl.addEventListener('pointermove', (event) => {
    if (!pieLongPressTimer || !pieLongPressStart || event.pointerId !== pieLongPressStart.pointerId) return;
    const moved = Math.hypot(event.clientX - pieLongPressStart.x, event.clientY - pieLongPressStart.y);
    if (moved > PIE_MOVE_CANCEL_PX) cancelPieLongPress();
  });

  ['pointerup', 'pointercancel'].forEach((type) => {
    viewportEl.addEventListener(type, cancelPieLongPress);
  });
}

function cancelPieLongPress() {
  if (pieLongPressTimer) {
    clearTimeout(pieLongPressTimer);
    pieLongPressTimer = null;
  }
  pieLongPressStart = null;
}

/** 起点を中心に、均等角度+ランダムなジッター/半径でツールを配置する(星座らしい不揃いさを出す) */
function computePiePositions(originX, originY, count) {
  const angleStep = (Math.PI * 2) / count;
  const positions = [];
  for (let i = 0; i < count; i++) {
    const jitter = (Math.random() - 0.5) * angleStep * 0.7;
    const angle = angleStep * i + jitter - Math.PI / 2;
    const radius = PIE_MIN_RADIUS + Math.random() * (PIE_MAX_RADIUS - PIE_MIN_RADIUS);
    positions.push({
      x: originX + Math.cos(angle) * radius,
      y: originY + Math.sin(angle) * radius,
    });
  }
  return positions;
}

function clampToScreen(pos) {
  return {
    x: Math.min(Math.max(pos.x, PIE_EDGE_MARGIN), window.innerWidth - PIE_EDGE_MARGIN),
    y: Math.min(Math.max(pos.y, PIE_EDGE_MARGIN), window.innerHeight - PIE_EDGE_MARGIN),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 主星・伴星を結ぶ軌跡線と同じ視覚言語(細線+破線+両端ドット、#000ベース)で1本描く */
function drawPieLine(svg, x1, y1, x2, y2) {
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', x1);
  line.setAttribute('y1', y1);
  line.setAttribute('x2', x2);
  line.setAttribute('y2', y2);
  line.setAttribute('stroke', '#000000');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-opacity', '0.6');
  line.setAttribute('stroke-dasharray', '2 5');
  line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);

  [[x1, y1], [x2, y2]].forEach(([cx, cy]) => {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '2.6');
    dot.setAttribute('fill', '#000000');
    svg.appendChild(dot);
  });
}

function openPieMenu(originX, originY, tools, pointerId) {
  // ビューポートのパン/ピンチと長押し操作が競合しないよう、開いている間は無効化する
  interact(els.viewport).draggable({ enabled: false }).gesturable({ enabled: false });

  const overlay = document.createElement('div');
  overlay.id = 'pie-menu';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'pie-svg');
  overlay.appendChild(svg);

  const originDot = document.createElement('div');
  originDot.className = 'pie-origin-dot';
  originDot.style.left = `${originX}px`;
  originDot.style.top = `${originY}px`;
  overlay.appendChild(originDot);

  const positions = computePiePositions(originX, originY, tools.length).map(clampToScreen);

  const items = tools.map((tool, i) => {
    const pos = positions[i];
    drawPieLine(svg, originX, originY, pos.x, pos.y);

    const el = document.createElement('div');
    el.className = 'pie-item';
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
    el.innerHTML = `${tool.icon}<span class="pie-item-label">${tool.label}</span>`;
    overlay.appendChild(el);

    return { tool, pos, el };
  });

  document.body.appendChild(overlay);

  pieState = { items, overlay, pointerId, activeIndex: -1 };

  document.addEventListener('pointermove', onPiePointerMove);
  document.addEventListener('pointerup', onPiePointerUp);
  document.addEventListener('pointercancel', onPiePointerCancel);

  updatePieMagnification(originX, originY);
}

function onPiePointerMove(event) {
  if (!pieState || event.pointerId !== pieState.pointerId) return;
  updatePieMagnification(event.clientX, event.clientY);
}

function onPiePointerUp(event) {
  if (!pieState || event.pointerId !== pieState.pointerId) return;
  updatePieMagnification(event.clientX, event.clientY);
  const { activeIndex, items } = pieState;
  closePieMenu();
  if (activeIndex >= 0) items[activeIndex].tool.action();
}

function onPiePointerCancel(event) {
  if (!pieState || event.pointerId !== pieState.pointerId) return;
  closePieMenu();
}

/** macOSのDockに似た近接拡大: 指に一番近いツールだけを強調し、選択候補として扱う */
function updatePieMagnification(x, y) {
  if (!pieState) return;
  let nearestIndex = -1;
  let nearestDist = Infinity;
  pieState.items.forEach((item, i) => {
    const dist = Math.hypot(x - item.pos.x, y - item.pos.y);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  });

  pieState.activeIndex = nearestDist <= PIE_HIT_RADIUS ? nearestIndex : -1;

  pieState.items.forEach((item, i) => {
    const dist = Math.hypot(x - item.pos.x, y - item.pos.y);
    const scale = dist < PIE_MAGNET_RADIUS ? 1 + (1 - dist / PIE_MAGNET_RADIUS) * 0.7 : 1;
    item.el.style.transform = `scale(${scale})`;
    item.el.classList.toggle('pie-item--active', i === pieState.activeIndex);
  });
}

function closePieMenu() {
  if (!pieState) return;
  document.removeEventListener('pointermove', onPiePointerMove);
  document.removeEventListener('pointerup', onPiePointerUp);
  document.removeEventListener('pointercancel', onPiePointerCancel);
  pieState.overlay.remove();
  pieState = null;
  interact(els.viewport).draggable({ enabled: true }).gesturable({ enabled: true });
}
