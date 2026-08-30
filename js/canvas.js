// interact.js によるキャンバス操作:
// - 背景のパン(ドラッグ)とピンチズーム/ホイールズーム
// - カード(.star-card)個別のドラッグ・リサイズ

const viewportState = { scale: 1, x: 0, y: 0 };
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let contentEl = null;

function applyViewportTransform() {
  contentEl.style.transform =
    `translate(${viewportState.x}px, ${viewportState.y}px) scale(${viewportState.scale})`;
}

/**
 * @param {HTMLElement} viewportEl パン/ズームを受け付ける外枠
 * @param {HTMLElement} contentElArg 実際に transform をかける内側コンテナ
 */
function initCanvas(viewportEl, contentElArg) {
  contentEl = contentElArg;

  interact(viewportEl)
    .draggable({
      listeners: { move: onViewportPan },
      // カード自体のドラッグとパンが競合しないようにする
      ignoreFrom: '.star-card',
    })
    .gesturable({
      listeners: { move: onViewportPinch },
    });

  viewportEl.addEventListener('wheel', onViewportWheel, { passive: false });
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

/** カード要素にドラッグ・リサイズを付与する */
function makeCardInteractive(el) {
  interact(el)
    .draggable({
      listeners: {
        move(event) {
          const x = (parseFloat(el.dataset.x) || 0) + event.dx / viewportState.scale;
          const y = (parseFloat(el.dataset.y) || 0) + event.dy / viewportState.scale;
          el.style.transform = `translate(${x}px, ${y}px)`;
          el.dataset.x = String(x);
          el.dataset.y = String(y);
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
            transform: `translate(${x}px, ${y}px)`,
          });
          el.dataset.x = String(x);
          el.dataset.y = String(y);
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
}
