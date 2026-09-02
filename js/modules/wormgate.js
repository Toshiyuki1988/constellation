// CONSTELLATION — Module: WormGate
//
// セッション内の写真をリングHUDで指ドラッグして探し、タップでキャンバス上の位置へ
// ジャンプする検索/ナビゲーション用モジュール。CLAUDE.mdの「モジュール」規約に従い、
// このファイル全体をIIFEで包んでトップレベルの名前をグローバルへ漏らさない。
// state / els / activeSessionId() / cardElById() / viewportState などの既存グローバルは
// 直接参照する(モジュールだからといって完全に独立させる必要はないため)。
//
// 起動: js/module-launcher.js(モジュール共通の起動基盤)経由。背景を2本指でダブルタップ
//       するとキーパッドHUDが開き、"123" と入力するとこのWormGateが起動する
//       (PCではCONSTELLATION PIEの「キーパッド」項目からも同じキーパッドを開ける)。
//       このモジュール自身は registerModuleCode('123', openWormgate) で登録するだけでよい。
//       (以前は1本指で円を描く/2本指でひねる、といった専用ジェスチャーを試したが、
//       既存のパン/ピンチ/長押しメニューと衝突を繰り返したため、起動ジェスチャーは
//       module-launcher.js に一本化した)
// 操作: リングをドラッグして回転(写真の上から掴んでも、動かせばドラッグと判定する)。
//       上のアクティブな写真をもう一度タップでジャンプ。左右スワイプで閉じる。

(function () {
  'use strict';

  // 以下は .wg-rig の基準サイズ(560px, デスクトップ想定)における値。実際のサイズは
  // .wg-rig がCSSの min(vw, vh, 560px) で画面に応じて縮むため、リング半径・写真サイズも
  // computeGeometry() でその都度スケールし直す(固定pxのままだと、リグ自体は縮んでいても
  // リング/写真は縮まず、スマホで画面外にはみ出て見切れてしまう)。
  const RIG_BASE_SIZE = 560;
  const RING_R_BASE = 205; // ring半径(px, リグ中心からの距離)
  const CHIP_W_BASE = 150;
  const CHIP_H_BASE = 104;
  let ringR = RING_R_BASE;
  let chipW = CHIP_W_BASE;
  let chipH = CHIP_H_BASE;

  const TICK_STEP_DEG = 6.5;
  const DRAG_START_TOLERANCE_PX = 9;

  let wgEls = null; // このモジュール自身のDOM参照
  let photos = [];
  let rotation = 0;
  let activeIndex = 0;

  /* ---------------- DOM / CSS をこのファイルだけで自己完結させて注入する ---------------- */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .wormgate-overlay {
        position: fixed; inset: 0; z-index: 120;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none;
        transition: opacity 0.25s ease-out;
      }
      .wormgate-overlay.open { opacity: 1; pointer-events: auto; }
      .wg-backdrop {
        /* 写真プレビュー特化のため、ぼかし(backdrop-filter)ではなく暗い単色オーバーレイで
           背後のキャンバスを退かせる。リング上の写真そのものが主役になるようにする。 */
        position: absolute; inset: 0;
        background: rgba(6, 10, 12, 0.88);
      }
      .wg-rig {
        position: relative;
        /* 幅だけでなく高さも制約しないと、横は収まっていても縦が短い画面(スマホの実効
           高さや横向き)で見切れる。バッジ・ヒント文言がリングの外側にはみ出る分の
           余白も見込んで、86vwよりやや控えめな78%を基準にする。 */
        width: min(78vw, 78vh, 560px); height: min(78vw, 78vh, 560px);
        transform: scale(0.86);
        transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .wormgate-overlay.open .wg-rig { transform: scale(1); }
      .wg-ring-outer {
        position: absolute; inset: 0; border-radius: 50%;
        border: 1px solid rgba(85, 230, 247, 0.35);
      }
      .wg-ring-inner {
        position: absolute; inset: 13%; border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }
      .wg-ring-core {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center; text-align: center;
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.06em;
        color: #55e6f7; text-transform: uppercase; line-height: 1.9; opacity: 0.85;
      }
      .wg-tick {
        position: absolute; left: 50%; top: 50%; width: 1px; height: 50%;
        transform-origin: top center;
      }
      .wg-tick::after {
        content: ''; position: absolute; top: 0; left: -0.5px; width: 1px; height: 8px;
        background: rgba(85, 230, 247, 0.35);
      }
      .wg-tick.major::after { height: 13px; background: #55e6f7; opacity: 0.8; }
      .wg-track { position: absolute; inset: 0; touch-action: none; cursor: grab; }
      .wg-track.grabbing { cursor: grabbing; }
      .wg-chip {
        /* width/height/marginはリグの実サイズに応じてcomputeGeometry()がインラインで
           設定する(画面サイズごとに変わるため、ここでは固定値を持たない)。 */
        position: absolute; left: 50%; top: 50%;
        will-change: transform, opacity;
      }
      .wg-chip-photo {
        width: 100%; height: 100%; border-radius: 6px;
        background-color: rgba(85, 230, 247, 0.12);
        background-size: cover; background-position: center;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
        border: 1px solid rgba(255, 255, 255, 0.14);
        position: relative;
        filter: grayscale(0.6) brightness(0.65) saturate(0.7);
        transition: filter 0.25s ease-out, box-shadow 0.25s ease-out;
      }
      .wg-chip-photo::after {
        content: ''; position: absolute; inset: 0; border-radius: inherit;
        background: linear-gradient(180deg, rgba(255,255,255,0.14), rgba(0,0,0,0.18) 70%);
        pointer-events: none;
      }
      .wg-chip--active .wg-chip-photo {
        filter: none;
        box-shadow: 0 0 0 2px #55e6f7, 0 0 30px rgba(85,230,247,0.55), 0 10px 26px rgba(0,0,0,0.55);
      }
      .wg-reticle { position: absolute; inset: -14px; pointer-events: none; opacity: 0; transition: opacity 0.25s ease-out; }
      .wg-chip--active .wg-reticle { opacity: 1; }
      .wg-reticle span { position: absolute; width: 14px; height: 14px; border: 1.5px solid #55e6f7; opacity: 0.9; }
      .wg-reticle span:nth-child(1) { top: 0; left: 0; border-right: none; border-bottom: none; }
      .wg-reticle span:nth-child(2) { top: 0; right: 0; border-left: none; border-bottom: none; }
      .wg-reticle span:nth-child(3) { bottom: 0; left: 0; border-right: none; border-top: none; }
      .wg-reticle span:nth-child(4) { bottom: 0; right: 0; border-left: none; border-top: none; }
      .wg-caption {
        position: absolute; left: 50%; bottom: -26px; transform: translateX(-50%);
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #55e6f7;
        white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis;
        opacity: 0; transition: opacity 0.2s ease-out; text-align: center;
      }
      .wg-chip--active .wg-caption { opacity: 0.9; }
      .wg-select-hint {
        position: absolute; left: 50%; top: 6%; transform: translateX(-50%);
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.08em;
        color: rgba(85,230,247,0.5); text-transform: uppercase; opacity: 0; transition: opacity 0.2s;
      }
      .wormgate-overlay.open .wg-select-hint { opacity: 0.8; }
      .wg-footer-hint {
        position: absolute; left: 50%; bottom: -46px; transform: translateX(-50%);
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.02em;
        color: rgba(255,255,255,0.5); white-space: nowrap;
      }
      /* スワイプでの終了操作とは別に、確実に閉じられる手段(全モジュール共通の意匠にする予定)。
         PCのマウスドラッグはスワイプ判定に乗りにくいことがあるため、押せば必ず閉じる。 */
      .wg-close-btn {
        position: absolute; top: 18px; right: 18px; z-index: 5;
        width: 34px; height: 34px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: rgba(20, 30, 34, 0.45);
        backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(85, 230, 247, 0.3);
        color: rgba(255, 255, 255, 0.85);
        font-size: 15px; line-height: 1; cursor: pointer;
        transition: background 0.15s ease-out, transform 0.15s ease-out;
      }
      .wg-close-btn:hover { background: rgba(85, 230, 247, 0.25); transform: scale(1.06); }
      .wg-empty {
        position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 13px; color: rgba(255,255,255,0.7);
        text-align: center; white-space: nowrap;
      }
      .wg-jump-flash {
        position: fixed; inset: 0; z-index: 130;
        background: radial-gradient(circle, rgba(85,230,247,0.9), rgba(85,230,247,0));
        opacity: 0; pointer-events: none;
      }
      .wg-jump-flash.fire { animation: wg-flash 0.5s ease-out; }
      @keyframes wg-flash { 0% { opacity: 0.9; } 100% { opacity: 0; } }
      .star-card--wormgate-landed {
        box-shadow: 0 0 0 3px #55e6f7, 0 20px 44px rgba(0, 0, 0, 0.3) !important;
        transition: box-shadow 0.15s ease-out;
      }
    `;
    document.head.appendChild(style);
  }

  function buildDom() {
    const overlay = document.createElement('div');
    overlay.className = 'wormgate-overlay';
    overlay.innerHTML = `
      <div class="wg-backdrop"></div>
      <button class="wg-close-btn" title="閉じる">✕</button>
      <div class="wg-rig">
        <div class="wg-ring-outer"></div>
        <div class="wg-ring-inner"></div>
        <div class="wg-ring-core"></div>
        <div class="wg-select-hint">もう一度タップでジャンプ</div>
        <div class="wg-ticks"></div>
        <div class="wg-track"><div class="wg-chips"></div></div>
        <div class="wg-empty" hidden>このセッションには写真がありません</div>
        <div class="wg-footer-hint">ドラッグで回転・スワイプ、または✕で閉じる</div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('.wg-close-btn').addEventListener('pointerdown', (e) => e.stopPropagation());
    overlay.querySelector('.wg-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeWormgate();
    });

    const flash = document.createElement('div');
    flash.className = 'wg-jump-flash';
    document.body.appendChild(flash);

    wgEls = {
      overlay,
      rig: overlay.querySelector('.wg-rig'),
      ringCore: overlay.querySelector('.wg-ring-core'),
      ticks: overlay.querySelector('.wg-ticks'),
      track: overlay.querySelector('.wg-track'),
      chips: overlay.querySelector('.wg-chips'),
      empty: overlay.querySelector('.wg-empty'),
      flash,
    };
  }

  function buildTicks() {
    for (let i = 0; i < 24; i++) {
      const tick = document.createElement('div');
      tick.className = 'wg-tick' + (i % 2 === 0 ? ' major' : '');
      tick.style.transform = `rotate(${i * 15}deg)`;
      wgEls.ticks.appendChild(tick);
    }
  }

  /* ---------------- セッション内の写真を集める ---------------- */

  function collectSessionPhotos() {
    const sessionId = activeSessionId();
    return state.cards.filter((c) => c.sessionId === sessionId && c.mediaType === 'image');
  }

  /* ---------------- リングの構築・配置 ---------------- */

  /** .wg-rig の実サイズ(画面幅/高さに応じて変わる)に合わせて、リング半径・写真サイズを
   *  スケールし直す。開いた時と、開いている間にリサイズ/画面回転された時に呼ぶ。 */
  function computeGeometry() {
    // offsetWidth/Heightを使う(getBoundingClientRectだと開閉アニメーションのtransform:scale
    // の影響を受け、開く途中の縮んだ状態で測ってしまうことがあるため)
    const size = Math.min(wgEls.rig.offsetWidth, wgEls.rig.offsetHeight) || RIG_BASE_SIZE;
    const scale = size / RIG_BASE_SIZE;
    ringR = RING_R_BASE * scale;
    chipW = CHIP_W_BASE * scale;
    chipH = CHIP_H_BASE * scale;
    Array.from(wgEls.chips.children).forEach((chip) => {
      chip.style.width = `${chipW}px`;
      chip.style.height = `${chipH}px`;
      chip.style.marginLeft = `${-chipW / 2}px`;
      chip.style.marginTop = `${-chipH / 2}px`;
    });
  }

  function buildChips() {
    wgEls.chips.innerHTML = '';
    photos.forEach((card, i) => {
      const chip = document.createElement('div');
      chip.className = 'wg-chip';
      chip.dataset.index = i;
      chip.style.width = `${chipW}px`;
      chip.style.height = `${chipH}px`;
      chip.style.marginLeft = `${-chipW / 2}px`;
      chip.style.marginTop = `${-chipH / 2}px`;
      const caption = (card.memo || '').trim().replace(/\s+/g, ' ').slice(0, 26);
      const bg = card.thumbDataUrl ? `background-image:url(${card.thumbDataUrl})` : '';
      chip.innerHTML = `
        <div class="wg-chip-photo" style="${bg}"></div>
        <div class="wg-reticle"><span></span><span></span><span></span><span></span></div>
        ${caption ? `<div class="wg-caption">${escapeHtml(caption)}</div>` : ''}
      `;
      wgEls.chips.appendChild(chip);
    });
    wgEls.ringCore.innerHTML = photos.length ? `SESSION<br>${photos.length} PHOTOS` : '';
    wgEls.empty.hidden = photos.length > 0;
  }

  function angleOf(i) {
    let a = (i * (360 / photos.length) + rotation) % 360;
    if (a < 0) a += 360;
    return a;
  }

  function distFromTop(a) {
    return Math.min(a, 360 - a);
  }

  function layoutRing() {
    if (!photos.length) return;
    let nearest = 0;
    let nearestDist = 999;
    const chips = wgEls.chips.children;
    for (let i = 0; i < photos.length; i++) {
      const a = angleOf(i);
      const d = distFromTop(a);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
      const rad = (a - 90) * Math.PI / 180;
      const x = Math.cos(rad) * ringR;
      const y = Math.sin(rad) * ringR;
      const t = d / 180;
      const scale = 2.3 - t * 1.55;
      const opacity = 1 - t * 0.45;
      const chip = chips[i];
      chip.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      chip.style.opacity = opacity;
      chip.style.zIndex = Math.round((1 - t) * 100);
    }
    if (nearest !== activeIndex) {
      const prevChip = chips[activeIndex];
      if (prevChip) {
        prevChip.classList.remove('wg-chip--active');
        // 非アクティブに戻す時は元画質を手放し、サムネイルに戻して軽量に保つ
        const prevCard = photos[activeIndex];
        const prevPhotoEl = prevChip.querySelector('.wg-chip-photo');
        if (prevPhotoEl && prevCard && prevCard.thumbDataUrl) {
          prevPhotoEl.style.backgroundImage = `url(${prevCard.thumbDataUrl})`;
        }
      }
      activeIndex = nearest;
    }
    chips[activeIndex].classList.add('wg-chip--active');
  }

  // 12時位置(アクティブ)のチップだけ、回転が止まったタイミングで元画質(またはそれに
  // 近い画質)に差し替える。ドラッグ中は毎フレームactiveIndexが動くためここでは呼ばず、
  // スナップアニメーション完了時・初期表示時にのみ呼ぶことで、通信は都度1枚に抑える。
  // getFileBlobUrlCached()はDrive取得結果をBlobURLとしてキャッシュするため、一度見た
  // 写真を再度アクティブにした時は通信なしで即座に差し替わる。
  let activeFullImageToken = 0;
  function refreshActiveFullImage() {
    const card = photos[activeIndex];
    const chip = wgEls.chips.children[activeIndex];
    if (!chip || !card || !card.imageFileId) return;
    const token = ++activeFullImageToken;
    getFileBlobUrlCached(card.imageFileId).then((url) => {
      if (token !== activeFullImageToken) return; // 古い読み込みが遅れて返ってきた場合は無視
      if (Number(chip.dataset.index) !== activeIndex) return;
      const photoEl = chip.querySelector('.wg-chip-photo');
      if (photoEl) photoEl.style.backgroundImage = `url(${url})`;
    }).catch((err) => console.warn('WormGate: 元画質の取得に失敗', err));
  }

  function angleTo(targetIndex) {
    const base = targetIndex * (360 / photos.length);
    let delta = (-base) - rotation;
    delta = ((delta % 360) + 540) % 360 - 180;
    return rotation + delta;
  }

  function animateRotationTo(target, duration, onDone) {
    const start = rotation;
    const diff = target - start;
    const t0 = performance.now();
    function step(now) {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      rotation = start + diff * eased;
      layoutRing();
      if (t < 1) requestAnimationFrame(step);
      else if (onDone) onDone();
    }
    requestAnimationFrame(step);
  }

  /* ---------------- ドラッグで回転 / タップで選択(移動量で判定) ---------------- */

  let pointerActive = false;
  let hasDragged = false;
  let pointerDownClient = null;
  let pointerDownAngle = 0;
  let pointerDownRotation = 0;
  let pointerDownChipIndex = null;
  let tickAccum = 0;

  function pointerAngle(clientX, clientY) {
    const rect = wgEls.track.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
  }

  function onTrackPointerDown(e) {
    if (!photos.length) return;
    soundAudioCtx();
    pointerActive = true;
    hasDragged = false;
    tickAccum = 0;
    pointerDownClient = { x: e.clientX, y: e.clientY };
    pointerDownAngle = pointerAngle(e.clientX, e.clientY);
    pointerDownRotation = rotation;
    const chipEl = e.target.closest('.wg-chip');
    pointerDownChipIndex = chipEl ? Number(chipEl.dataset.index) : null;
    wgEls.track.setPointerCapture(e.pointerId);
  }

  function onTrackPointerMove(e) {
    if (!pointerActive) return;
    const moved = Math.hypot(e.clientX - pointerDownClient.x, e.clientY - pointerDownClient.y);
    if (!hasDragged && moved < DRAG_START_TOLERANCE_PX) return;
    if (!hasDragged) {
      hasDragged = true;
      wgEls.track.classList.add('grabbing');
    }
    const a = pointerAngle(e.clientX, e.clientY);
    const prevRotation = rotation;
    rotation = pointerDownRotation + (a - pointerDownAngle);
    layoutRing();
    tickAccum += Math.abs(rotation - prevRotation);
    if (tickAccum >= TICK_STEP_DEG) {
      tickAccum = 0;
      playWormGateRingTickSound();
    }
  }

  function onTrackPointerEnd() {
    if (!pointerActive) return;
    pointerActive = false;
    wgEls.track.classList.remove('grabbing');
    if (hasDragged) {
      animateRotationTo(angleTo(activeIndex), 260, refreshActiveFullImage);
    } else if (pointerDownChipIndex !== null) {
      onChipTap(pointerDownChipIndex);
    }
    pointerDownChipIndex = null;
  }

  function onChipTap(i) {
    if (i === activeIndex) {
      playWormGateSelectSound();
      jumpToCard(photos[i]);
    } else {
      animateRotationTo(angleTo(i), 320, refreshActiveFullImage);
    }
  }

  /* ---------------- 選んだ写真のカードへキャンバスをジャンプさせる ---------------- */

  function jumpToCard(card) {
    const rect = els.viewport.getBoundingClientRect();
    els.content.classList.add('canvas-content--animated');
    viewportState.x = rect.width / 2 - (card.x + card.width / 2) * viewportState.scale;
    viewportState.y = rect.height / 2 - (card.y + card.height / 2) * viewportState.scale;
    applyViewportTransform();
    setTimeout(() => els.content.classList.remove('canvas-content--animated'), 400);

    wgEls.flash.classList.remove('fire');
    void wgEls.flash.offsetWidth;
    wgEls.flash.classList.add('fire');

    const el = cardElById(card.id);
    if (el) {
      el.classList.add('star-card--wormgate-landed');
      setTimeout(() => el.classList.remove('star-card--wormgate-landed'), 1600);
    }
    setStatus('WormGate: 写真の位置へジャンプしました');
    closeWormgate();
  }

  /* ---------------- スワイプで左右に閉じる(モジュール共通デザイン言語) ---------------- */

  let swipeStartX = null;
  let swipeStartY = null;
  let swipeStartT = 0;

  function onOverlayPointerDown(e) {
    if (e.target.closest('.wg-chip')) return;
    swipeStartX = e.clientX;
    swipeStartY = e.clientY;
    swipeStartT = performance.now();
  }

  function onOverlayPointerUp(e) {
    if (swipeStartX === null) return;
    const dx = e.clientX - swipeStartX;
    const dy = e.clientY - swipeStartY;
    const dt = performance.now() - swipeStartT;
    swipeStartX = null;
    if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) {
      flingClose(dx > 0 ? 1 : -1);
    }
  }

  function flingClose(dir) {
    const rig = wgEls.rig;
    rig.style.transition = 'transform 0.35s ease-in, opacity 0.35s ease-in';
    rig.style.transform = `translateX(${dir * 900}px) rotate(${dir * 24}deg) scale(0.7)`;
    rig.style.opacity = '0';
    setTimeout(() => {
      closeWormgate();
      rig.style.transition = '';
      rig.style.transform = '';
      rig.style.opacity = '';
    }, 340);
  }

  /* ---------------- 開閉 ---------------- */

  function openWormgate() {
    photos = collectSessionPhotos();
    rotation = 0;
    activeIndex = 0;
    computeGeometry();
    buildChips();
    layoutRing();
    refreshActiveFullImage();
    playWormGateOpenSound();
    wgEls.overlay.classList.add('open');
  }

  // 起動ジェスチャーはjs/module-launcher.js(背景2本指ダブルタップ→キーパッド)に一本化した。
  // このモジュールはコード("123")を登録するだけでよい。
  registerModuleCode('123', openWormgate);

  // 開いている間に画面サイズが変わったら(スマホの画面回転など)、リング半径・写真サイズを
  // 測り直して再配置する
  window.addEventListener('resize', () => {
    if (!wgEls || !wgEls.overlay.classList.contains('open')) return;
    computeGeometry();
    layoutRing();
  });

  function closeWormgate() {
    wgEls.overlay.classList.remove('open');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------------- 初期化 ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    buildDom();
    buildTicks();

    wgEls.track.addEventListener('pointerdown', onTrackPointerDown);
    wgEls.track.addEventListener('pointermove', onTrackPointerMove);
    wgEls.track.addEventListener('pointerup', onTrackPointerEnd);
    wgEls.track.addEventListener('pointercancel', onTrackPointerEnd);

    wgEls.overlay.addEventListener('pointerdown', onOverlayPointerDown);
    wgEls.overlay.addEventListener('pointerup', onOverlayPointerUp);
  });
})();
