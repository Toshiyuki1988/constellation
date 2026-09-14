// CONSTELLATION — Module: Star Pencil
//
// キャンバスに直接ドローイングできる機能。もともとチャット上のモックアップで検証した
// ものをブラッシュアップして本実装した。CLAUDE.mdの「モジュール」規約に従い、この
// ファイル全体をIIFEで包んでトップレベルの名前をグローバルへ漏らさない。
// state / els / activeSessionId() / getCardById() / cardElById() / clientToContent() /
// applyCardTransform() / viewportState / applyViewportTransform() / clamp() / MIN_SCALE /
// MAX_SCALE / viewportEl / renderCard() / redrawAsterismLines() / scheduleAutoSave() /
// escapeHtml() / EDIT_GUIDE_HANDLES_HTML / editGuideHexHtml() / getEditGuideCard() /
// deactivateEditGuide() / soundAudioCtx() / playStarPencilBeginSound() /
// playStarPencilDrawTickSound() / playConstellationAddCardSound() / SVG_NS など、
// 既存のグローバルをそのまま参照する。
//
// 実装前に単体HTMLのモックアップ(star-pencil-mockup.html、2026年9月)で操作感・
// パン/ズームの実装方式・白背景での発光の見え方を検証してから本実装した。
//
// 【起動】
// 1. モジュール共通の起動基盤(js/module-launcher.js)経由、キーパッドで"369"
//    (電話キーパッドの右列。123=WormGate・789=Mapping Storysで洛書の上下段、
//    147=Flight Engineerで左列、258=Astrometry Scopeで中央列を使っているため、
//    残る右列を割り当てた)と入力すると、新規描画モードで開く。
// 2. イマジナリーカード(mediaType:'imaginary')の編集ガイド「Draw」ヘックスを押すと、
//    そのカードの既存ストロークを読み込んだ状態(描き足しモード)で開く。
//
// 【操作方式】Flight Engineerに次いで、キャンバス本体の既定ジェスチャー(背景ドラッグ=
// パン)を起動中だけ置き換える2つ目のモジュール。起動中は1本指のドラッグが「描く」に
// なるため、js/canvas.jsのinteract(viewportEl)のdraggable/gesturableを両方とも
// 無効化し、このファイル自身がviewportElへ直接付けたpointerイベントで全てを処理する
// (Flight Engineerと同様、canvas.js/app.js側にはwindow.isStarPencilActive()を見る
// だけの薄いガードを追加している)。
//   - 1本指ドラッグ: 描く
//   - 2本指ドラッグ(平行移動): パン
//   - ピンチ(2本指の間隔変化): ズーム(パンと同時に成立する)
//   - ホイール: ズーム(js/canvas.jsの既存のwheelリスナーがviewportStateを直接操作する
//     だけの実装のため、Star Pencil起動中でも無効化せずそのまま使える)
//   - PC限定: Shiftキーを押している間の1本指ドラッグ=パン(タッチにShiftは無いため
//     2本指ドラッグで代替する。Flight Engineerと同じ考え方)
//
// 【データモデル】1枚のイマジナリーカード(mediaType:'imaginary')は、パレットの
// 「✓ 完成」を押すまでに描いた全ストロークをまとめて1枚として保存する(ユーザー指定:
// 「完成」ボタンを押すまですべて同一カード、途中で線が途切れても新規カードにはならない)。
//   card.strokes: [{ color, width, points: [{x,y}, ...] }, ...] (カードローカル座標、
//     カード左上を原点とする。card.x/y/width/heightは他のカードと同じ意味)
//   card.thumbDataUrl: Commentモジュール(既存のfetchPersonaCommentOnCard())が
//     この絵を見てコメントできるよう、確定のたびにSVGをラスタライズして生成する
//     (画像カードと同じ扱いにするため、js/app.js側のfetchPersonaCommentOnCard()の
//     画像添付条件にmediaType==='imaginary'を追加した)。
//
// 【当たり判定・重なり順】「ドロー以外透過」の要求により、カードの背景・枠線は持たない
// (css/style.cssの.star-card--imaginary)。当たり判定はモックでの検討の結果、
// 他のカードと同じ「bounding box全体」を採用した(透明部分を挟んでも他のカードの
// 誤操作に繋がりうるが、シンプルさを優先するユーザー判断)。「イマジナリーカードは
// 全てのカードの上に置かれるように」というユーザー指示により、.star-card--imaginaryに
// 常に高いz-indexを与えている(css/style.css参照。「写真の上から視線の軌跡を描く」
// といった使い方を想定)。
//
// 【発光表現】ユーザー指定により全ストロークを発光するマーカーとして描く。ただし
// パルス(明滅)アニメーションは、多数のイマジナリーカードが同時に画面内にあると
// 常時repaintが発生し重くなる(2026年9月に別途対応したAsterism線の教訓と同じ)ため
// 実装しない。css/style.cssの.sp-stroke--glowは静的なdrop-shadowのみ。実アプリの
// キャンバス背景は白(#fff)+薄いドットグリッドのため、暗い背景を前提にした「色その
// ものをグローにするだけ」の発光は白背景ではただの色滲みにしか見えないことが
// モックアップでの実機検証で判明し、線の周りに極薄い白の縁取りを追加してコントラストを
// 作る設計にした。プリセットカラーも彩度高め・明度中〜やや暗めの色に調整している。
//
// 【効果音】(ユーザー要望、js/sound.js)
//   - ストローク開始(ペン先を置いた瞬間): playStarPencilBeginSound()「キラッ」
//   - 線を引いている間: 画面px換算で一定距離ごとに間引いてplayStarPencilDrawTickSound()
//     「ヒュウ」(カード移動音playCardMoveTickSoundと同じ間引きの考え方)
//   - 完成(カード確定): playConstellationAddCardSound()(Crews Constellationの
//     「キン☆」をそのまま流用、ユーザー指定)

(function () {
  'use strict';

  const MIN_POINT_DIST = 3; // キャンバス座標px。ストローク点の間引き(データ量・描画コスト対策)
  const DRAW_TICK_DISTANCE_PX = 50; // 画面px換算。「ヒュウ」音を鳴らす間引き距離(カード移動音のMOVE_TICK_DISTANCE_PXに準拠)
  const BOUNDING_PAD = 24; // イマジナリーカードのbounding boxに持たせる余白(px、キャンバス座標)
  const MIN_CARD_SIZE = 60;

  // 白背景(実アプリのキャンバス地色)向けに彩度高め・明度中〜やや暗めにした色。
  // 暗い背景を前提にしたパステル/ネオン調は白背景でほぼ発光して見えなかったため
  // (star-pencil-mockup.htmlで実機検証済み)、コントラストの効く濃色にしている。
  const COLORS = ['#2563eb', '#c026d3', '#e11d48', '#059669', '#d97706', '#1e293b'];
  const SHAPES = [
    { id: 'fine', label: '細', width: 2.5 },
    { id: 'marker', label: 'マーカー', width: 6 },
    { id: 'bold', label: '極太', width: 12 },
  ];

  let stylesInjected = false;
  let spEls = null;
  let spActive = false;
  let currentTargetCard = null; // Draw(描き足し)モードの対象カード。新規モードならnull
  let currentStrokes = []; // { color, width, points:[{x,y}] } (キャンバス座標系)
  let activeStroke = null;
  let previewPathEls = new Map(); // stroke -> SVG <path>
  let currentColor = COLORS[0];
  let currentShape = SHAPES[1];

  const pointers = new Map(); // pointerId -> {x, y} (client座標)
  let panState = null; // PC: Shift+1本指ドラッグ用
  let twoFingerState = null; // 2本指: パン+ズーム用
  let drawTickAccumDist = 0;

  /* ==================== スタイル ==================== */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .sp-mode-badge {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 160;
        font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.08em; color: #eef3f7;
        background: rgba(12, 20, 28, 0.82); border: 1px solid rgba(37, 99, 235, 0.5);
        padding: 6px 14px; border-radius: 20px;
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        opacity: 0; pointer-events: none; transition: opacity 0.2s ease;
      }
      .sp-mode-badge.open { opacity: 1; }

      .sp-palette {
        position: fixed; top: 16px; right: 16px; z-index: 160;
        width: 230px;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 20%), rgba(14, 20, 30, 0.88);
        border: 1px solid rgba(37, 99, 235, 0.4); border-radius: 14px;
        box-shadow: 0 30px 60px -25px rgba(0, 0, 0, 0.55), 0 0 24px -8px rgba(37, 99, 235, 0.3);
        backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        padding: 12px 14px 14px; color: #eef3f7;
        transform: translateY(-8px); opacity: 0; pointer-events: none;
        transition: transform 0.18s ease, opacity 0.18s ease;
      }
      .sp-palette.open { transform: translateY(0); opacity: 1; pointer-events: auto; }
      .sp-palette-head { display: flex; align-items: center; justify-content: space-between; cursor: grab; margin-bottom: 10px; }
      .sp-title { font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em; font-weight: 700; color: #eef3f7; }
      .sp-title small { display: block; font-family: var(--sans); font-size: 9.5px; font-weight: 400; color: #8a97a6; letter-spacing: 0.04em; margin-top: 2px; }
      .sp-close {
        width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.03); color: #8a97a6; cursor: pointer; font-size: 11px;
        display: grid; place-items: center;
      }
      .sp-close:hover { color: #eef3f7; }
      .sp-section-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.08em; color: #8a97a6; margin: 10px 0 6px; text-transform: uppercase; }

      .sp-colors { display: flex; flex-wrap: wrap; gap: 7px; }
      .sp-color-swatch {
        width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
        border: 2px solid transparent; position: relative;
        box-shadow: 0 0 6px -1px currentColor;
      }
      .sp-color-swatch.active { border-color: #fff; }
      .sp-color-swatch.active::after {
        content: ''; position: absolute; inset: -4px; border-radius: 50%;
        border: 1px solid currentColor; opacity: 0.6;
      }

      .sp-shapes { display: flex; gap: 6px; }
      .sp-shape-btn {
        flex: 1; padding: 7px 0; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.02); color: #8a97a6; font-family: var(--mono); font-size: 9.5px; cursor: pointer;
        display: flex; flex-direction: column; align-items: center; gap: 4px;
      }
      .sp-shape-btn .dot { border-radius: 50%; background: currentColor; }
      .sp-shape-btn.active { color: #eef3f7; border-color: #2563eb; background: rgba(37, 99, 235, 0.15); }

      .sp-actions { display: flex; gap: 8px; margin-top: 12px; }
      .sp-btn {
        flex: 1; padding: 8px 0; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.02); color: #eef3f7; font-family: var(--mono); font-size: 11px; cursor: pointer;
        letter-spacing: 0.02em;
      }
      .sp-btn:hover { background: rgba(255, 255, 255, 0.07); }
      .sp-btn--done {
        border-color: #2563eb; color: #04202b;
        background: linear-gradient(180deg, #93c5fd, #60a5fa);
        font-weight: 700;
      }
      .sp-btn--done:hover { filter: brightness(1.08); }
      .sp-btn:disabled { opacity: 0.35; cursor: default; }

      .sp-hint { font-family: var(--sans); font-size: 9.5px; color: #8a97a6; line-height: 1.6; margin: 10px 0 0; letter-spacing: 0.01em; }
      .sp-hint b { color: #93c5fd; font-weight: 600; }

      /* 描画中(未確定)のプレビュー線を乗せるSVG。キャンバス内容と同じ座標系(canvas-content
         の子)に置き、パン/ズームに自動追従させる。 */
      .sp-preview-svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }

      .sp-layers-open-btn { width: 100%; margin-top: 8px; text-align: left; }

      .sp-layers-overlay {
        position: fixed; inset: 0; z-index: 165;
        display: flex; align-items: center; justify-content: center;
        padding: clamp(10px, 3vw, 26px);
        background: rgba(2, 4, 7, 0.72);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
        opacity: 0; pointer-events: none; transition: opacity 0.2s ease-out;
      }
      .sp-layers-overlay.open { opacity: 1; pointer-events: auto; }
      .sp-layers-panel {
        width: 100%; max-width: 460px; max-height: 78vh; margin: auto; display: flex; flex-direction: column;
        border: 1px solid rgba(37, 99, 235, 0.4); border-radius: 14px; background: rgba(14, 20, 30, 0.92);
        box-shadow: 0 0 0 1px rgba(37,99,235,0.1), 0 40px 90px -40px rgba(0, 0, 0, 0.85);
        color: #eef3f7; overflow: hidden;
        transform: scale(0.96) translateY(6px); transition: transform 0.2s ease-out;
      }
      .sp-layers-overlay.open .sp-layers-panel { transform: scale(1) translateY(0); }
      .sp-layers-head {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
        padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.12); cursor: grab; flex-shrink: 0;
      }
      .sp-layers-title { font-family: var(--mono); font-weight: 700; font-size: 15px; letter-spacing: 0.05em; margin: 0; color: #eef3f7; }
      .sp-layers-title span { font-family: var(--sans); font-weight: 400; font-size: 11px; color: #8a97a6; margin-left: 8px; }
      .sp-layers-subtitle { font-family: var(--mono); font-size: 9.5px; color: #8a97a6; letter-spacing: 0.03em; margin: 4px 0 0; }
      .sp-layers-close {
        width: 28px; height: 28px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.03);
        color: #8a97a6; font-size: 13px; line-height: 1; cursor: pointer; display: grid; place-items: center; flex-shrink: 0;
      }
      .sp-layers-close:hover { color: #eef3f7; }
      .sp-layers-list { overflow-y: auto; padding: 10px 14px 16px; }
      .sp-layers-empty { font-family: var(--mono); font-size: 11px; color: #8a97a6; letter-spacing: 0.02em; line-height: 1.7; padding: 20px 20px 26px; }
      .sp-layer-row {
        display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; margin-bottom: 6px;
        border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; background: rgba(255,255,255,0.015);
      }
      .sp-layer-thumb { width: 44px; height: 44px; border-radius: 6px; object-fit: contain; flex-shrink: 0; background: #fff; }
      .sp-layer-thumb--empty { display: block; background: rgba(255,255,255,0.06); }
      .sp-layer-info { min-width: 0; flex: 1; }
      .sp-layer-title { display: block; font-family: var(--sans); font-size: 12.5px; color: #eef3f7; }
      .sp-layer-sub { display: block; font-family: var(--mono); font-size: 9px; color: #8a97a6; margin-top: 2px; }
      .sp-layer-jump, .sp-layer-delete {
        width: 30px; height: 30px; border-radius: 7px; border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.03); color: #eef3f7; font-size: 13px; cursor: pointer;
        display: grid; place-items: center; flex-shrink: 0;
      }
      .sp-layer-jump:hover { border-color: #2563eb; background: rgba(37,99,235,0.15); }
      .sp-layer-delete:hover { border-color: #e11d48; background: rgba(225,29,72,0.15); }
    `;
    document.head.appendChild(style);
  }

  /* ==================== DOM構築 ==================== */

  function buildDom() {
    spEls = {};
    const palette = document.createElement('div');
    palette.className = 'sp-palette';
    palette.innerHTML = `
      <div class="sp-palette-head">
        <div class="sp-title">STAR PENCIL<small>星をなぞる筆</small></div>
        <button type="button" class="sp-close" title="閉じる" aria-label="閉じる">✕</button>
      </div>
      <p class="sp-section-label">Color</p>
      <div class="sp-colors"></div>
      <p class="sp-section-label">Shape</p>
      <div class="sp-shapes"></div>
      <div class="sp-actions">
        <button type="button" class="sp-btn" id="sp-clear-btn">クリア</button>
        <button type="button" class="sp-btn sp-btn--done" id="sp-done-btn">✓ 完成</button>
      </div>
      <button type="button" class="sp-btn sp-layers-open-btn" id="sp-layers-open-btn">📋 レイヤー一覧</button>
      <p class="sp-hint"><b>完成</b>を押すまで、描いた線は全部同じ1枚のイマジナリーカードにまとまります。</p>
    `;
    document.body.appendChild(palette);

    const modeBadge = document.createElement('div');
    modeBadge.className = 'sp-mode-badge';
    modeBadge.textContent = 'DRAW MODE';
    document.body.appendChild(modeBadge);

    const previewSvg = document.createElementNS(SVG_NS, 'svg');
    previewSvg.setAttribute('class', 'sp-preview-svg');
    els.content.appendChild(previewSvg);

    buildLayerViewerDom();

    spEls.palette = palette;
    spEls.head = palette.querySelector('.sp-palette-head');
    spEls.closeBtn = palette.querySelector('.sp-close');
    spEls.colorsEl = palette.querySelector('.sp-colors');
    spEls.shapesEl = palette.querySelector('.sp-shapes');
    spEls.clearBtn = palette.querySelector('#sp-clear-btn');
    spEls.doneBtn = palette.querySelector('#sp-done-btn');
    spEls.layersOpenBtn = palette.querySelector('#sp-layers-open-btn');
    spEls.modeBadge = modeBadge;
    spEls.previewSvg = previewSvg;

    COLORS.forEach((c) => {
      const sw = document.createElement('div');
      sw.className = 'sp-color-swatch' + (c === currentColor ? ' active' : '');
      sw.style.background = c;
      sw.style.color = c;
      sw.addEventListener('pointerdown', (e) => e.stopPropagation());
      sw.addEventListener('click', () => {
        currentColor = c;
        spEls.colorsEl.querySelectorAll('.sp-color-swatch').forEach((el) => el.classList.remove('active'));
        sw.classList.add('active');
      });
      spEls.colorsEl.appendChild(sw);
    });

    SHAPES.forEach((s) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sp-shape-btn' + (s === currentShape ? ' active' : '');
      btn.innerHTML = `<span class="dot" style="width:${Math.max(4, s.width)}px; height:${Math.max(4, s.width)}px;"></span><span>${s.label}</span>`;
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', () => {
        currentShape = s;
        spEls.shapesEl.querySelectorAll('.sp-shape-btn').forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
      });
      spEls.shapesEl.appendChild(btn);
    });

    palette.querySelectorAll('button').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });
    spEls.closeBtn.addEventListener('click', closeStarPencil);
    spEls.clearBtn.addEventListener('click', clearCurrentDrawing);
    spEls.doneBtn.addEventListener('click', commitDrawing);
    spEls.layersOpenBtn.addEventListener('click', openLayerViewer);

    // スワイプで左右に閉じる(モジュール共通デザイン言語)。パレット上部の掴みバーから。
    let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
    spEls.head.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      swipeStartX = e.clientX; swipeStartY = e.clientY; swipeStartT = performance.now();
    });
    palette.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX, dy = e.clientY - swipeStartY, dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeStarPencil();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (spEls.layersOverlay.classList.contains('open')) { closeLayerViewer(); return; }
        if (spActive) closeStarPencil();
      }
    });
  }

  /* ==================== レイヤービューア(一覧・削除・ジャンプ) ====================
   * 「線は見えるのに長押しできず移動・削除できない」実機報告(高さ破損の既存データが
   * 復旧しきれないケースへの保険、および単純に「イマジナリーが増えて画面が探しにくい」
   * ケース双方への対応)を受け、キャンバス上を直接操作しなくてもイマジナリーカードを
   * 一覧から削除・ジャンプできる入口を追加した(2026年9月)。Astrometry Scopeの
   * Archive一覧と同じ「別階層のオーバーレイ」パターンを踏襲している。 */

  function buildLayerViewerDom() {
    const overlay = document.createElement('div');
    overlay.className = 'sp-layers-overlay';
    overlay.innerHTML = `
      <div class="sp-layers-panel">
        <div class="sp-layers-head">
          <div>
            <h3 class="sp-layers-title">LAYERS<span>イマジナリーカード一覧</span></h3>
            <p class="sp-layers-subtitle">—</p>
          </div>
          <button type="button" class="sp-layers-close" aria-label="閉じる">✕</button>
        </div>
        <div class="sp-layers-list"></div>
        <p class="sp-layers-empty" hidden>このセッションにイマジナリーカードはまだありません。</p>
      </div>
    `;
    document.body.appendChild(overlay);

    spEls.layersOverlay = overlay;
    spEls.layersHead = overlay.querySelector('.sp-layers-head');
    spEls.layersSubtitle = overlay.querySelector('.sp-layers-subtitle');
    spEls.layersList = overlay.querySelector('.sp-layers-list');
    spEls.layersEmpty = overlay.querySelector('.sp-layers-empty');
    spEls.layersCloseBtn = overlay.querySelector('.sp-layers-close');

    overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
    spEls.layersCloseBtn.addEventListener('click', closeLayerViewer);
    // 単純なclickでの背景タップ判定はスマホで誤って閉じやすいため(2026年9月、Astrometry
    // Scopeでの実機報告を受けて他のオーバーレイも横断的に対応)、app.jsのグローバル
    // ヘルパーattachBackgroundTapToClose()に統一。
    attachBackgroundTapToClose(overlay, closeLayerViewer);

    let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
    spEls.layersHead.addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX; swipeStartY = e.clientY; swipeStartT = performance.now();
    });
    overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX, dy = e.clientY - swipeStartY, dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeLayerViewer();
    });
  }

  function formatLayerTimeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderLayerList() {
    const currentId = activeSessionId();
    const cards = state.cards.filter((c) => c.mediaType === 'imaginary' && c.sessionId === currentId);
    spEls.layersList.innerHTML = '';
    spEls.layersEmpty.hidden = cards.length > 0;
    spEls.layersSubtitle.textContent = `このセッション ・ 全${cards.length}件`;

    cards.slice().reverse().forEach((card) => {
      const row = document.createElement('div');
      row.className = 'sp-layer-row';
      const strokeCount = Array.isArray(card.strokes) ? card.strokes.length : 0;
      const thumbHtml = card.thumbDataUrl
        ? `<img class="sp-layer-thumb" src="${card.thumbDataUrl}" alt="">`
        : '<span class="sp-layer-thumb sp-layer-thumb--empty"></span>';
      row.innerHTML = (
        thumbHtml +
        '<span class="sp-layer-info">' +
        `<span class="sp-layer-title">${formatLayerTimeLabel(card.createdAt)}</span>` +
        `<span class="sp-layer-sub">${strokeCount}本のストローク ・ ${Math.round(card.width)}×${Math.round(card.height)}px</span>` +
        '</span>' +
        '<button type="button" class="sp-layer-jump" title="ここへ移動">📍</button>' +
        '<button type="button" class="sp-layer-delete" title="削除">🗑</button>'
      );
      row.querySelector('.sp-layer-jump').addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToImaginaryCard(card);
      });
      row.querySelector('.sp-layer-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteImaginaryCardFromViewer(card);
      });
      spEls.layersList.appendChild(row);
    });
  }

  function jumpToImaginaryCard(card) {
    const rect = viewportEl.getBoundingClientRect();
    const centerX = card.x + card.width / 2;
    const centerY = card.y + card.height / 2;
    viewportState.x = rect.width / 2 - centerX * viewportState.scale;
    viewportState.y = rect.height / 2 - centerY * viewportState.scale;
    applyViewportTransform();
  }

  function deleteImaginaryCardFromViewer(card) {
    const el = cardElById(card.id) || document.createElement('div'); // DOM上に見当たらなくても安全に削除できるよう保険
    deleteCard(card, el);
    renderLayerList();
  }

  function openLayerViewer() {
    renderLayerList();
    spEls.layersOverlay.classList.add('open');
  }

  function closeLayerViewer() {
    if (spEls) spEls.layersOverlay.classList.remove('open');
  }

  /* ==================== 起動/終了 ==================== */

  function isStarPencilActive() {
    return spActive;
  }

  function openStarPencil(targetCard) {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!spEls) buildDom();
    attachViewportGestures();

    // 既に編集ガイドが表示されていれば解除する(Star Pencil起動中はカード個別の操作を
    // 止めるため、ASTRヘックス等が画面に残ったままにならないようにする)。
    const eg = typeof getEditGuideCard === 'function' ? getEditGuideCard() : null;
    if (eg && typeof deactivateEditGuide === 'function') deactivateEditGuide(eg);

    currentTargetCard = targetCard || null;
    currentStrokes = [];
    if (currentTargetCard) {
      // 描き足しモード: 既存ストローク(カードローカル座標)をキャンバス座標へ戻して読み込む
      (currentTargetCard.strokes || []).forEach((s) => {
        currentStrokes.push({
          color: s.color,
          width: s.width,
          points: s.points.map((p) => ({ x: p.x + currentTargetCard.x, y: p.y + currentTargetCard.y })),
        });
      });
    }
    renderAllPreviewStrokes();
    updateDoneButtonState();

    spActive = true;
    spEls.palette.classList.add('open');
    spEls.modeBadge.classList.add('open');
    pointers.clear();
    panState = null;
    twoFingerState = null;
    activeStroke = null;
    interact(viewportEl).draggable({ enabled: false }).gesturable({ enabled: false });
    playGuideRevealSound();
  }

  function closeStarPencil() {
    if (!spActive) return;
    spActive = false;
    if (activeStroke) endStroke();
    spEls.palette.classList.remove('open');
    spEls.modeBadge.classList.remove('open');
    clearPreviewSvg();
    currentStrokes = [];
    currentTargetCard = null;
    pointers.clear();
    panState = null;
    twoFingerState = null;
    // Flight Engineer起動中はそちらが背景パンを占有しているため、無条件に有効化しない
    // (既存の他モジュールと同じ配慮)。
    const feActive = window.isFlightEngineerActive && window.isFlightEngineerActive();
    interact(viewportEl).draggable({ enabled: !feActive }).gesturable({ enabled: true });
  }

  /* ==================== パレット状態に応じた描画 ==================== */

  function pointsToPathD(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) {
      const p = points[0];
      return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + 0.01).toFixed(2)} ${p.y.toFixed(1)}`;
    }
    return 'M ' + points.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ');
  }

  function clearPreviewSvg() {
    spEls.previewSvg.innerHTML = '';
    previewPathEls.clear();
  }

  function renderPreviewStroke(stroke) {
    let pathEl = previewPathEls.get(stroke);
    if (!pathEl) {
      pathEl = document.createElementNS(SVG_NS, 'path');
      pathEl.setAttribute('class', 'sp-stroke sp-stroke--glow');
      spEls.previewSvg.appendChild(pathEl);
      previewPathEls.set(stroke, pathEl);
    }
    pathEl.setAttribute('d', pointsToPathD(stroke.points));
    pathEl.setAttribute('stroke', stroke.color);
    pathEl.setAttribute('stroke-width', stroke.width);
    pathEl.style.color = stroke.color;
  }

  function renderAllPreviewStrokes() {
    clearPreviewSvg();
    currentStrokes.forEach(renderPreviewStroke);
  }

  function beginStroke(pt) {
    activeStroke = { color: currentColor, width: currentShape.width, points: [pt] };
    currentStrokes.push(activeStroke);
    renderPreviewStroke(activeStroke);
    updateDoneButtonState();
  }

  function extendStroke(pt) {
    if (!activeStroke) return;
    const last = activeStroke.points[activeStroke.points.length - 1];
    const dist = Math.hypot(pt.x - last.x, pt.y - last.y);
    if (dist * viewportState.scale < MIN_POINT_DIST) return; // 画面px換算で間引く
    activeStroke.points.push(pt);
    renderPreviewStroke(activeStroke);
  }

  function endStroke() {
    activeStroke = null;
  }

  function clearCurrentDrawing() {
    currentStrokes = [];
    activeStroke = null;
    clearPreviewSvg();
    updateDoneButtonState();
  }

  function updateDoneButtonState() {
    if (spEls) spEls.doneBtn.disabled = currentStrokes.length === 0;
  }

  /* ==================== 確定(「完成」ボタン) ==================== */

  /** カード表示用のSVGマークアップ(CSSクラス経由で発光フィルタが効く、DOM挿入用)。 */
  function imaginarySvgHtml(card) {
    const paths = (card.strokes || []).map((s) => {
      const d = pointsToPathD(s.points);
      return `<path class="sp-stroke sp-stroke--glow" d="${d}" stroke="${s.color}" stroke-width="${s.width}" style="color:${s.color}"></path>`;
    }).join('');
    return `<svg class="star-card-svg" viewBox="0 0 ${card.width} ${card.height}" preserveAspectRatio="none">${paths}</svg>`;
  }

  /** Comment機能(既存のfetchPersonaCommentOnCard())へ渡すサムネイル。発光フィルタは
   *  ラスタライズの確実性を優先して掛けず、線の形状だけのシンプルな描画にする。 */
  function generateImaginaryThumbnail(strokes, w, h) {
    return new Promise((resolve) => {
      const maxSize = 240;
      const scale = Math.min(1, maxSize / Math.max(w, h, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const paths = strokes.map((s) =>
        `<path d="${pointsToPathD(s.points)}" stroke="${s.color}" stroke-width="${s.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      ).join('');
      const svgMarkup = `<svg xmlns="${SVG_NS}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${paths}</svg>`;
      const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  async function commitDrawing() {
    if (currentStrokes.length === 0) return;
    if (activeStroke) endStroke();

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    currentStrokes.forEach((s) => s.points.forEach((p) => {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }));
    minX -= BOUNDING_PAD; minY -= BOUNDING_PAD; maxX += BOUNDING_PAD; maxY += BOUNDING_PAD;
    const width = Math.max(MIN_CARD_SIZE, maxX - minX);
    const height = Math.max(MIN_CARD_SIZE, maxY - minY);

    const localStrokes = currentStrokes.map((s) => ({
      color: s.color,
      width: s.width,
      points: s.points.map((p) => ({ x: p.x - minX, y: p.y - minY })),
    }));

    const wasTargetCard = currentTargetCard;
    let card;
    if (wasTargetCard) {
      card = wasTargetCard;
      card.x = minX; card.y = minY; card.width = width; card.height = height;
      card.strokes = localStrokes;
    } else {
      card = {
        id: crypto.randomUUID(),
        mediaType: 'imaginary',
        sessionId: activeSessionId(),
        x: minX, y: minY, width, height,
        strokes: localStrokes,
        createdAt: new Date().toISOString(),
      };
      state.cards.push(card);
    }

    card.thumbDataUrl = await generateImaginaryThumbnail(localStrokes, width, height);

    const oldEl = cardElById(card.id);
    if (oldEl) oldEl.remove();
    renderCard(card);
    redrawAsterismLines();
    scheduleAutoSave();
    playConstellationAddCardSound();

    clearCurrentDrawing();
    if (wasTargetCard) {
      // 描き足しは編集ガイド「Draw」からの1回限りの操作。確定したらモジュール自体を閉じ、
      // 通常のカード操作に戻す。
      currentTargetCard = null;
      closeStarPencil();
    }
    // 新規モードは続けて次のイマジナリーカードを描けるよう、パレットは開いたままにする。
  }

  /* ==================== ポインタ処理: 1本指=描く・2本指=パン+ズーム・Shift+1本指=パン(PC) ==================== */

  function pointersArray() {
    return Array.from(pointers.values());
  }

  function onPointerDown(e) {
    if (!spActive) return;
    if (e.target.closest('.sp-palette')) return; // パレット自体の操作はここでは扱わない
    try { viewportEl.setPointerCapture(e.pointerId); } catch (err) { /* no-op */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1 && e.shiftKey) {
      if (activeStroke) endStroke();
      panState = { anchorX: e.clientX, anchorY: e.clientY, startX: viewportState.x, startY: viewportState.y };
    } else if (pointers.size === 1) {
      panState = null;
      twoFingerState = null;
      const pt = clientToContent(e.clientX, e.clientY);
      beginStroke(pt);
      drawTickAccumDist = 0;
      playStarPencilBeginSound();
    } else if (pointers.size >= 2) {
      if (activeStroke) endStroke();
      panState = null;
      const [p1, p2] = pointersArray();
      twoFingerState = {
        dist: Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y)),
        mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        startScale: viewportState.scale,
        startX: viewportState.x,
        startY: viewportState.y,
      };
    }
  }

  function onPointerMove(e) {
    if (!spActive || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const rawDist = Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (panState && pointers.size === 1) {
      viewportState.x = panState.startX + (e.clientX - panState.anchorX);
      viewportState.y = panState.startY + (e.clientY - panState.anchorY);
      applyViewportTransform();
      return;
    }
    if (pointers.size === 1 && activeStroke) {
      extendStroke(clientToContent(e.clientX, e.clientY));
      drawTickAccumDist += rawDist;
      if (drawTickAccumDist >= DRAW_TICK_DISTANCE_PX) {
        drawTickAccumDist = 0;
        playStarPencilDrawTickSound();
      }
      return;
    }
    if (pointers.size >= 2 && twoFingerState) {
      const [p1, p2] = pointersArray();
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const newDist = Math.max(1, Math.hypot(p1.x - p2.x, p1.y - p2.y));
      const newScale = clamp(twoFingerState.startScale * (newDist / twoFingerState.dist), MIN_SCALE, MAX_SCALE);
      const contentAnchor = {
        x: (twoFingerState.mid.x - twoFingerState.startX) / twoFingerState.startScale,
        y: (twoFingerState.mid.y - twoFingerState.startY) / twoFingerState.startScale,
      };
      viewportState.scale = newScale;
      viewportState.x = mid.x - contentAnchor.x * newScale;
      viewportState.y = mid.y - contentAnchor.y * newScale;
      applyViewportTransform();
    }
  }

  function onPointerEnd(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (!spActive) return;
    if (pointers.size === 0) {
      endStroke();
      panState = null;
      twoFingerState = null;
    } else {
      // 3本→2本、2本→1本等、途中で本数が変わった場合は一旦仕切り直す
      // (誤ったジェスチャー継続を避けるため、次のpointerdownまで何もしない)。
      panState = null;
      twoFingerState = null;
    }
  }

  // js/canvas.jsのviewportElは、initCanvas()が呼ばれるまでnullのまま(スクリプト読み込み
  // 順ではapp.js側のサインイン処理の中で初期化される)。このファイルのトップレベルで
  // 即座にaddEventListenerすると「Cannot read properties of null」で例外になるため、
  // Star Pencilが実際に初めて起動される時点(viewportElが確実に設定済み)まで遅延する。
  let gesturesAttached = false;
  function attachViewportGestures() {
    if (gesturesAttached) return;
    gesturesAttached = true;
    viewportEl.addEventListener('pointerdown', onPointerDown);
    viewportEl.addEventListener('pointermove', onPointerMove);
    viewportEl.addEventListener('pointerup', onPointerEnd);
    viewportEl.addEventListener('pointercancel', onPointerEnd);
  }

  /* ==================== renderCard()統合: イマジナリーカードのHTML ==================== */

  function imaginaryCardInnerHtml(card) {
    return imaginarySvgHtml(card) + EDIT_GUIDE_HANDLES_HTML + editGuideHexHtml('imaginary');
  }

  /** 編集ガイドの「Draw」ヘックス(js/app.jsのクリックディスパッチャから呼ばれる)。 */
  function openStarPencilForCard(card) {
    openStarPencil(card);
  }

  /* ==================== 起動登録 ==================== */

  if (window.registerModuleCode) {
    registerModuleCode('369', () => openStarPencil(null));
  }
  window.isStarPencilActive = isStarPencilActive;
  window.openStarPencilForCard = openStarPencilForCard;
  window.imaginaryCardInnerHtml = imaginaryCardInnerHtml;
})();
