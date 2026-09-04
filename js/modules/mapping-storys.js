// CONSTELLATION — Module: Mapping Storys
//
// 会場の地図(館内マップ、または現在地周辺の地形)を、建物・道路の輪郭だけを緑色の線として
// キャンバスの最背面に敷くモジュール。CLAUDE.mdの「モジュール」規約に従い、このファイル
// 全体をIIFEで包んでトップレベルの名前をグローバルへ漏らさない。
// state / els / activeSessionId() / getSessionById() / scheduleAutoSave() / renderAllCards() /
// setStatus() / openCamera()と同じ思想の自前カメラ実装などは既存グローバルを直接参照する。
//
// 起動: js/module-launcher.js経由。背景を2本指でダブルタップしてキーパッドHUDを開き、
//       "789"(電話キーパッドの下段。123=WormGate・456=Crewsに続き、洛書の3列を使い切る)
//       と入力すると起動する(PCではCONSTELLATION PIEの「キーパッド」項目からも開ける)。
//       このモジュール自身は registerModuleCode('789', openMappingStorys) で登録するだけ。
//
// 【設計上の重要な決定】
// - モジュールカラムは、WormGate/Crewsのような画面全体を覆う暗いオーバーレイではなく、
//   ユーザー指示どおり「小窓」(画面右上に浮かぶ、キャンバスを隠さない小さいパネル)にした。
//   地図を配置している間もキャンバス(展開済みの地図やカード)が見えている必要があるため。
// - 屋内(館内マップ)は紙のマップをカメラで撮るしかなく、Canvas 2Dでグレースケール化→
//   閾値二値化→白地を透明化(alpha 0)+線を緑色に、という画像処理を経る。ユーザーの指示
//   により文字(館名・部屋名)は一切残さない、輪郭だけの割り切った処理でよい。
// - 屋外は地図タイル画像のスキャンではなく、OpenStreetMapのOverpass APIから建物・道路の
//   形状そのものをベクターで取得する(APIキー不要・完全無料)。取得結果はそのまま緑の
//   線分になるため、画像処理も透明化も不要。GPS座標系なのでHaversine相当の簡易換算で
//   実距離(メートル)から正確なスケールが出せる。
// - ユーザー指示により、屋外の建物は「name タグを持つもの(=主要な建物名)だけ」を残す
//   フィルタをかける(全部の建物ではなく、名前のある主要施設だけ)。道路にはこのフィルタは
//   かけない(名前を持つ道路は少なく、フィルタすると輪郭の手がかりがほぼ消えてしまうため)。
// - 屋内マップには正確な縮尺情報が無いため、自動スケール推定はできない(見た目のデフォルト
//   サイズで仮置きし、以後は手動リサイズに委ねる)。屋外はGPS実距離を写真カードの既定幅
//   (約240px ≒ 人物2人分[目安3.4m]相当)に合わせた換算係数(PX_PER_METER)でスケールする。
// - 地図データは session.mapLayer に保存する(既存の cards/sessions と同じ constellation-data.json
//   へオートセーブされる)。屋内の画像はDriveのセッションmediaフォルダへ通常の写真と同じ経路
//   (resolveSessionMediaFolderId + uploadFile)でアップロードする。屋外はベクター(緯度経度から
//   換算したローカル座標の配列)なので画像アップロードは発生しない。
// - 地図レイヤーは js/app.js の renderAllCards() から呼ばれる window.renderMappingStorysLayer()
//   経由でキャンバスの最背面(カードより先にDOM挿入)に描画する。既定では pointer-events:none
//   でカードのタッチ判定を一切邪魔しない。この小窓を開いている間だけ地図に pointer-events:auto
//   を与え、ドラッグで移動、ハンドルでリサイズ・回転できるようにする。

(function () {
  'use strict';

  // 写真カードの既定幅(約240px)を「人物2人分(目安3.4m)」とみなした簡易換算値。
  // 屋外はGPS実距離(メートル)にこの係数を掛けるだけで、カードと釣り合うスケールになる…はずだったが、
  // 実際に70px/mで計算すると、半径150m(既定値)だけでキャンバス全体が約21000px四方という、
  // 既存アプリのズーム下限(MIN_SCALE=0.2、js/canvas.js)でも画面に収まらない巨大さになり、
  // 展開しても移動ハンドルだけが見えて肝心の建物・道路は画面のはるか外、という不具合が
  // 実機で見つかった(2026年9月)。既存の「全カードが収まるまでズームアウト」機能
  // (fitAllCardsToScreen、js/canvas.js)もMIN_SCALEでクランプする設計になっており、
  // アプリ全体でこの下限を尊重する方針のため、Mapping Storys側だけそれを無視するのではなく、
  // この係数を下げてMIN_SCALEの範囲内に収まるようにした。「写真カード基準の正確な実寸」より
  // 「展開したら必ず見える」ことを優先した判断。
  const PX_PER_METER = 12;
  // 屋内は実寸を推定できないため、見た目のデフォルト表示幅で仮置きする(手動リサイズ前提)。
  const DEFAULT_INDOOR_DISPLAY_WIDTH = 480;
  // 0-255。紙の白地と印刷線の濃淡を分ける閾値(紙質・照明でノイズが出ることは許容する)。
  const INDOOR_THRESHOLD = 150;
  const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
  const DEPLOY_ANIM_MS = 1100;

  let stylesInjected = false;
  let msEls = null;
  let scanCamEls = null;
  let mode = 'indoor'; // 'indoor' | 'outdoor'
  let editingOpen = false; // この小窓が開いている間だけ地図を編集可能にする

  let pendingIndoorCanvas = null; // 二値化・緑線化・透明化まで済ませた、展開待ちのcanvas
  let pendingOutdoor = null; // { shapes, bboxWidth, bboxHeight, buildingCount, roadCount }
  let scanStream = null;
  let radiusValue = 150;

  /* ==================== CSS注入 ==================== */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .ms-window {
        position: fixed; top: 18px; right: 18px; z-index: 115;
        width: min(84vw, 260px);
        background: rgba(7, 13, 9, 0.95);
        border: 1px solid rgba(47, 107, 70, 0.35);
        border-radius: 14px;
        padding: 13px 13px 15px;
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        display: none;
        opacity: 0; transform: scale(0.92) translateY(-6px);
        transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .ms-window.open { display: block; opacity: 1; transform: scale(1) translateY(0); }
      .ms-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; cursor: grab; }
      .ms-top-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em;
        color: #6fd48e; text-transform: uppercase;
      }
      .ms-close {
        width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(63, 174, 99, 0.35);
        color: rgba(255, 255, 255, 0.85); font-size: 11px; cursor: pointer;
      }
      .ms-close:hover { background: rgba(63, 174, 99, 0.25); }
      .ms-session-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.55);
        margin: 0 0 10px; padding: 6px 9px; border-radius: 6px;
        background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .ms-mode-seg { display: flex; gap: 5px; margin-bottom: 11px; }
      .ms-mode-opt {
        flex: 1; text-align: center; padding: 6px 4px; border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.12); background: none;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; color: rgba(255, 255, 255, 0.55); cursor: pointer;
      }
      .ms-mode-opt.sel { background: rgba(63, 174, 99, 0.2); border-color: rgba(47, 107, 70, 0.48); color: #fff; font-weight: 700; }
      .ms-block {
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px;
        padding: 10px 11px; margin-bottom: 9px;
      }
      .ms-block-label { font-family: 'IBM Plex Mono', monospace; font-size: 8.5px; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); margin: 0 0 8px; }
      .ms-scan-btn {
        width: 100%; display: flex; align-items: center; justify-content: center; gap: 7px;
        padding: 9px 8px; border-radius: 8px; border: 1px dashed rgba(255, 255, 255, 0.22);
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11.5px; color: rgba(255, 255, 255, 0.8);
        background: none; cursor: pointer;
      }
      .ms-scan-btn:hover { border-color: rgba(63, 174, 99, 0.5); color: #fff; }
      .ms-scan-btn svg { width: 14px; height: 14px; flex: none; }
      .ms-radius-row { display: flex; align-items: center; gap: 8px; }
      .ms-radius-row input[type=range] { flex: 1; accent-color: #3fae63; }
      .ms-radius-val { font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: #fff; width: 44px; text-align: right; }
      .ms-fetch-btn {
        width: 100%; margin-top: 9px; padding: 8px; border-radius: 7px; border: none;
        background: #3fae63; color: #06180d; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 11px; cursor: pointer;
      }
      .ms-fetch-btn:hover { background: #59c67c; }
      .ms-fetch-btn:disabled { opacity: 0.55; cursor: default; }
      .ms-fetch-status { margin-top: 7px; font-family: 'IBM Plex Mono', monospace; font-size: 9px; line-height: 1.6; color: rgba(255, 255, 255, 0.55); }
      .ms-fetch-status.error { color: #ff8a70; }
      .ms-preview {
        width: 100%; height: 90px; border-radius: 8px; overflow: hidden; position: relative;
        background: repeating-conic-gradient(rgba(255, 255, 255, 0.05) 0% 25%, rgba(255, 255, 255, 0.02) 0% 50%) 0 0 / 12px 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex; align-items: center; justify-content: center; margin-bottom: 9px;
      }
      .ms-preview canvas, .ms-preview svg { width: 100%; height: 100%; object-fit: contain; display: block; }
      .ms-preview.empty::after {
        content: 'まだ地図がありません'; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.3);
      }
      .ms-deploy-btn {
        width: 100%; padding: 9px 8px; border-radius: 8px; border: none;
        background: #fff; color: #0c2417; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 11.5px; cursor: pointer;
      }
      .ms-deploy-btn:disabled { opacity: 0.4; cursor: default; }
      .ms-remove-btn {
        width: 100%; padding: 8px; border-radius: 7px; border: 1px solid rgba(255, 255, 255, 0.18);
        background: transparent; color: rgba(255, 255, 255, 0.6); font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; cursor: pointer;
      }
      .ms-remove-btn:hover { border-color: #b3402b; color: #ff8a70; }
      .ms-hint { font-family: 'IBM Plex Mono', monospace; font-size: 8px; color: rgba(255, 255, 255, 0.35); margin: 2px 0 0; line-height: 1.6; }

      /* ---- 自前の簡易スキャンカメラ(js/camera.jsは既存モードが固定DOMなので流用せず、
              このモジュール専用に最小構成で実装する) ---- */
      .ms-scancam-overlay {
        position: fixed; inset: 0; z-index: 125; background: #000;
        display: none; align-items: center; justify-content: center;
      }
      .ms-scancam-overlay.open { display: flex; }
      .ms-scancam-video { width: 100%; height: 100%; object-fit: cover; }
      .ms-scancam-close {
        position: absolute; top: 20px; right: 20px; z-index: 2;
        font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: #fff;
        background: rgba(19, 19, 21, 0.6); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 3px;
        padding: 8px 12px; cursor: pointer;
      }
      .ms-scancam-hint {
        position: absolute; top: 22px; left: 50%; transform: translateX(-50%); z-index: 2;
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.04em; color: #6fd48e; text-align: center;
      }
      .ms-scancam-shutter {
        position: absolute; bottom: 36px; left: 50%; transform: translateX(-50%); z-index: 2;
        width: 66px; height: 66px; border-radius: 50%; background: transparent; border: 3px solid #3fae63; cursor: pointer; padding: 0;
      }
      .ms-scancam-shutter::after { content: ''; position: absolute; inset: 5px; border-radius: 50%; background: #3fae63; transition: transform 0.1s; }
      .ms-scancam-shutter:active::after { transform: scale(0.82); }

      /* ---- キャンバス背景としての地図レイヤー ---- */
      .ms-maplayer-container { position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible; pointer-events: none; }
      .ms-maplayer { position: absolute; top: 0; left: 0; pointer-events: none; transform-origin: center center; }
      /* 地図本体は常にpointer-events:noneのまま(展開直後のタップ/ダブルタップ/ピンチが誤って
         地図の移動と解釈され、画面外へ吹き飛んで「一瞬出てすぐ消える」ように見えたり、地図の
         広い当たり判定がキャンバスのピンチズーム/ダブルタップ俯瞰を奪ってしまう不具合が
         あったため、2026年9月に「本体を掴んで移動」から「専用ハンドルでのみ移動」に変更した。
         移動・リサイズ・回転はすべて.ms-handle系の小さな個別要素だけがpointer-events:autoを持つ。 */
      .ms-maplayer.ms-editable { outline: 1px dashed rgba(63, 174, 99, 0.55); outline-offset: 6px; }
      .ms-maplayer-img { width: 100%; height: 100%; display: block; user-select: none; -webkit-user-drag: none; }
      .ms-maplayer-error {
        display: flex; align-items: center; justify-content: center; text-align: center; padding: 16px;
        background: rgba(179, 64, 43, 0.12); border: 2px dashed rgba(179, 64, 43, 0.55); border-radius: 8px;
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: #b3402b; box-sizing: border-box;
      }
      .ms-maplayer-error .ms-maplayer-img { display: none; }
      .ms-maplayer-vector svg { width: 100%; height: 100%; display: block; overflow: visible; }
      /* vector-effect:non-scaling-strokeにより、地図が展開時に大きくズームアウトされても線幅は
         一定のCSS px幅を保つ(=描画自体は正しくても、ズームアウトすると相対的に細く見えて
         目立たない、という視認性の問題があったため、2026年9月に少し太くした)。 */
      .ms-shape { fill: none; stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke; }
      .ms-shape-building { stroke: #3fae63; stroke-width: 4; }
      .ms-shape-highway { stroke: rgba(63, 174, 99, 0.65); stroke-width: 3; }
      .ms-handle {
        position: absolute; width: 22px; height: 22px; border-radius: 50%;
        background: rgba(63, 174, 99, 0.92); border: 2px solid #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        display: flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; pointer-events: auto;
      }
      .ms-handle-resize { right: 0; bottom: 0; cursor: nwse-resize; }
      .ms-handle-rotate { left: 50%; top: 0; cursor: grab; }
      .ms-handle-move { left: 50%; top: 50%; cursor: grab; }
      .ms-handle-move:active { cursor: grabbing; }

      /* ---- 展開時の演出(スキャン反射のように左から右へ広がる) ---- */
      .ms-maplayer.ms-deploying { animation: ms-deploy-reveal ${DEPLOY_ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
      @keyframes ms-deploy-reveal {
        0% { clip-path: inset(0 100% 0 0); filter: brightness(2.2) saturate(0); opacity: 0; }
        30% { opacity: 1; }
        100% { clip-path: inset(0 0 0 0); filter: brightness(1) saturate(1); opacity: 1; }
      }
      .ms-maplayer.ms-deploying::after {
        content: ''; position: absolute; inset: 0; pointer-events: none; width: 6%;
        background: linear-gradient(90deg, transparent, rgba(111, 212, 142, 0.95), transparent);
        animation: ms-deploy-scanline ${DEPLOY_ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
      }
      @keyframes ms-deploy-scanline {
        0% { transform: translateX(-20%); opacity: 0; }
        12% { opacity: 1; }
        88% { opacity: 1; }
        100% { transform: translateX(1120%); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ms-maplayer.ms-deploying, .ms-maplayer.ms-deploying::after { animation: none; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ==================== 小窓UI ==================== */

  function buildDom() {
    const win = document.createElement('div');
    win.className = 'ms-window';
    win.innerHTML = `
      <div class="ms-top">
        <span class="ms-top-label">Mapping Storys</span>
        <button class="ms-close" title="閉じる">✕</button>
      </div>
      <p class="ms-session-label"></p>
      <div class="ms-mode-seg">
        <button class="ms-mode-opt" data-mode="indoor">屋内</button>
        <button class="ms-mode-opt" data-mode="outdoor">屋外</button>
      </div>
      <div class="ms-block ms-block-indoor">
        <p class="ms-block-label">館内マップスキャン</p>
        <button class="ms-scan-btn">${CAMERA_ICON_SVG}カメラを起動</button>
      </div>
      <div class="ms-block ms-block-outdoor" hidden>
        <p class="ms-block-label">現在地からスキャン</p>
        <div class="ms-radius-row">
          <span style="font-family:'IBM Plex Mono',monospace; font-size:9px; color:rgba(255,255,255,0.5);">半径</span>
          <input type="range" class="ms-radius-input" min="30" max="200" step="10" value="150">
          <span class="ms-radius-val">150m</span>
        </div>
        <button class="ms-fetch-btn">この範囲を取得</button>
        <p class="ms-fetch-status" hidden></p>
      </div>
      <div class="ms-block">
        <p class="ms-block-label">プレビュー</p>
        <div class="ms-preview empty"></div>
        <button class="ms-deploy-btn" disabled>キャンバスへ展開する</button>
      </div>
      <div class="ms-block ms-block-current" hidden>
        <p class="ms-block-label">このセッションの地図</p>
        <button class="ms-remove-btn">地図を削除</button>
      </div>
      <p class="ms-hint">この窓を開いている間だけ、展開済みの地図をドラッグ・ハンドルで動かせます。閉じると固定され、カードのタッチ判定を邪魔しません。</p>
    `;
    document.body.appendChild(win);

    msEls = {
      win,
      closeBtn: win.querySelector('.ms-close'),
      sessionLabel: win.querySelector('.ms-session-label'),
      modeOpts: Array.from(win.querySelectorAll('.ms-mode-opt')),
      indoorBlock: win.querySelector('.ms-block-indoor'),
      outdoorBlock: win.querySelector('.ms-block-outdoor'),
      scanBtn: win.querySelector('.ms-scan-btn'),
      radiusInput: win.querySelector('.ms-radius-input'),
      radiusVal: win.querySelector('.ms-radius-val'),
      fetchBtn: win.querySelector('.ms-fetch-btn'),
      fetchStatus: win.querySelector('.ms-fetch-status'),
      preview: win.querySelector('.ms-preview'),
      deployBtn: win.querySelector('.ms-deploy-btn'),
      currentBlock: win.querySelector('.ms-block-current'),
      removeBtn: win.querySelector('.ms-remove-btn'),
    };

    // このウィンドウ内の操作が、下のキャンバスのパン/ジェスチャーに奪われないようにする
    win.querySelectorAll('button, input').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    msEls.closeBtn.addEventListener('click', closeMappingStorys);
    msEls.modeOpts.forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
    msEls.scanBtn.addEventListener('click', openScanCamera);
    msEls.radiusInput.addEventListener('input', () => {
      radiusValue = Number(msEls.radiusInput.value);
      msEls.radiusVal.textContent = `${radiusValue}m`;
    });
    msEls.fetchBtn.addEventListener('click', fetchOutdoorMap);
    msEls.deployBtn.addEventListener('click', deployToCanvas);
    msEls.removeBtn.addEventListener('click', removeDeployedMap);

    // スワイプで左右に閉じる(モジュール共通デザイン言語)。ヘッダー(.ms-top)から
    // 始まった場合だけ判定し、プレビュー操作やスライダーのドラッグと紛れないようにする。
    let swipeStartX = null;
    let swipeStartY = null;
    let swipeStartT = 0;
    win.querySelector('.ms-top').addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX;
      swipeStartY = e.clientY;
      swipeStartT = performance.now();
    });
    win.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX;
      const dy = e.clientY - swipeStartY;
      const dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeMappingStorys();
    });
  }

  function setMode(next) {
    mode = next;
    msEls.modeOpts.forEach((btn) => btn.classList.toggle('sel', btn.dataset.mode === mode));
    msEls.indoorBlock.hidden = mode !== 'indoor';
    msEls.outdoorBlock.hidden = mode !== 'outdoor';
  }

  /**
   * 地図は「今操作しているセッション」に紐づくため、小窓を開いたまま(キャンバスの操作は
   * ブロックしていないので)別のセッションへ移動すると、保存先・表示対象が変わる。
   * 「展開したのに見当たらない」というユーザー報告(2026年9月)を受け、今どのセッションを
   * 見ているかを小窓に常時明示するようにした。renderMappingStorysLayer()からも呼ばれるため、
   * セッション移動のたびに追従して更新される。
   */
  function refreshCurrentMapBlock() {
    if (!msEls) return;
    const session = getSessionById(activeSessionId());
    msEls.sessionLabel.textContent = session ? `保存先セッション: ${session.name || '(無題)'}` : '保存先セッションが見つかりません';
    const hasMap = Boolean(session && session.mapLayer);
    msEls.currentBlock.hidden = !hasMap;
  }

  /* ==================== 開閉 ==================== */

  function openMappingStorys() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!msEls) buildDom();
    setMode(mode);
    editingOpen = true;
    refreshCurrentMapBlock();
    renderPendingPreview();
    msEls.win.classList.add('open');
    renderMappingStorysLayer();
  }

  function closeMappingStorys() {
    editingOpen = false;
    if (msEls) msEls.win.classList.remove('open');
    if (scanStream) closeScanCamera();
    renderMappingStorysLayer();
  }

  // 起動ジェスチャーはjs/module-launcher.js(背景2本指ダブルタップ→キーパッド)に一本化されている。
  registerModuleCode('789', openMappingStorys);

  /* ==================== 屋内: 自前の簡易スキャンカメラ ==================== */
  /* js/camera.jsは画面ごとにindex.html側へ固定DOMを持つ構成(モードを増やすには基本機能側の
     マークアップ変更が要る)なので、このモジュールでは自己完結する最小構成のカメラを別途用意する。
     シャッター音・傾きガイドのような凝った演出は持たず、映像表示とシャッターボタンのみ。 */

  function buildScanCameraDom() {
    const overlay = document.createElement('div');
    overlay.className = 'ms-scancam-overlay';
    overlay.innerHTML = `
      <div class="ms-scancam-hint">MAPPING STORYS · 館内マップをスキャン</div>
      <button class="ms-scancam-close" title="閉じる">✕</button>
      <video class="ms-scancam-video" autoplay playsinline muted></video>
      <button class="ms-scancam-shutter" title="撮影"></button>
    `;
    document.body.appendChild(overlay);
    scanCamEls = {
      overlay,
      video: overlay.querySelector('.ms-scancam-video'),
      shutter: overlay.querySelector('.ms-scancam-shutter'),
      closeBtn: overlay.querySelector('.ms-scancam-close'),
    };
    scanCamEls.closeBtn.addEventListener('click', closeScanCamera);
    scanCamEls.shutter.addEventListener('click', captureIndoorScan);
  }

  async function openScanCamera() {
    if (!scanCamEls) buildScanCameraDom();
    scanCamEls.overlay.classList.add('open');
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 2000 }, height: { ideal: 2000 } },
        audio: false,
      });
      scanCamEls.video.srcObject = scanStream;
      await scanCamEls.video.play().catch(() => {});
    } catch (err) {
      console.error(err);
      setStatus('カメラを起動できませんでした(ブラウザの権限設定を確認してください)', { important: true });
      closeScanCamera();
    }
  }

  function closeScanCamera() {
    if (scanStream) {
      scanStream.getTracks().forEach((t) => t.stop());
      scanStream = null;
    }
    if (scanCamEls) scanCamEls.overlay.classList.remove('open');
  }

  function captureIndoorScan() {
    if (!scanStream) return;
    const video = scanCamEls.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    const maxEdge = 1400;
    const longest = Math.max(vw, vh);
    const s = longest > maxEdge ? maxEdge / longest : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vw * s);
    canvas.height = Math.round(vh * s);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    processIndoorScan(canvas);
    pendingIndoorCanvas = canvas;
    pendingOutdoor = null;
    closeScanCamera();
    renderPendingPreview();
    setStatus('館内マップを取り込みました。プレビューを確認して展開してください');
  }

  /**
   * グレースケール化・閾値二値化・緑線化・白地の透明化を1パスで行う(輪郭のみ、文字は残さない
   * 前提の割り切った処理。文字も線と同じ濃さで拾われるため、あくまで「雰囲気を出す飾り」)。
   */
  function processIndoorScan(canvas) {
    const ctx = canvas.getContext('2d');
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray < INDOOR_THRESHOLD) {
        data[i] = 0x3f; data[i + 1] = 0xae; data[i + 2] = 0x63; data[i + 3] = 255;
      } else {
        data[i + 3] = 0;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  /* ==================== 屋外: Geolocation + Overpass ==================== */

  /**
   * 画面上部の小さい#status表示だけだと見落とされやすい(「押しても何も起きないように見える」
   * という報告があったため2026年9月に追加)。小窓のこのブロック内に、進捗・失敗を必ず表示する。
   */
  function showFetchStatus(text, isError) {
    if (!msEls || !msEls.fetchStatus) return;
    msEls.fetchStatus.textContent = text;
    msEls.fetchStatus.hidden = false;
    msEls.fetchStatus.classList.toggle('error', Boolean(isError));
  }

  /** Geolocation/Overpassの失敗理由を、原因ごとに分かりやすい日本語へ変換する。 */
  function describeOutdoorError(err) {
    if (err && err.name === 'AbortError') {
      return '地図サーバーの応答がありませんでした(混雑している可能性があります。時間をおいて試してください)';
    }
    if (err && typeof err.code === 'number') {
      if (err.code === 1) return '位置情報の利用が許可されませんでした(ブラウザ/端末の位置情報設定を確認してください)';
      if (err.code === 2) return '現在地を取得できませんでした(電波状況の良い場所でもう一度お試しください)';
      if (err.code === 3) return '現在地の取得がタイムアウトしました(位置情報の許可ダイアログが出ていないか確認してください)';
    }
    return err && err.message ? err.message : String(err);
  }

  // overpass-api.deは無料の公共サーバーで、実測(東京駅周辺・半径150m)で応答に20秒前後かかった
  // (混雑時はさらに長くなりうる)。fetch自体にはタイムアウトが無いため、AbortControllerで
  // 明示的に打ち切るが、正常なケースまで打ち切ってしまわないよう十分長く取る。
  const OVERPASS_TIMEOUT_MS = 40000;

  async function fetchOutdoorMap() {
    if (!navigator.geolocation) {
      showFetchStatus('この端末では位置情報が使えません', true);
      return;
    }
    msEls.fetchBtn.disabled = true;
    const originalLabel = msEls.fetchBtn.textContent;
    msEls.fetchBtn.textContent = '現在地を取得中…';
    showFetchStatus('現在地の許可ダイアログが出ていたら「許可」を選んでください…', false);
    setStatus('Mapping Storys: 現在地を取得中…', { busy: true });
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12000 });
      });
      const lat0 = pos.coords.latitude;
      const lon0 = pos.coords.longitude;

      msEls.fetchBtn.textContent = '地図データを取得中…';
      showFetchStatus('地図サーバーへ問い合わせ中…(無料の公共サーバーのため20〜40秒程度かかることがあります。気長にお待ちください)', false);
      setStatus('Mapping Storys: 地図サーバーへ問い合わせ中…', { busy: true });
      const query = buildOverpassQuery(lat0, lon0, radiusValue);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(OVERPASS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: query,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (!res.ok) throw new Error(`Overpass API error ${res.status}`);
      const json = await res.json();
      const built = buildShapesFromOverpass(json.elements || [], lat0, lon0);
      if (!built.shapes.length) {
        showFetchStatus('この範囲では建物・道路のデータが見つかりませんでした(半径を広げてみてください)', true);
        setStatus('Mapping Storys: この範囲では地図データが見つかりませんでした', { important: true });
        return;
      }
      pendingOutdoor = built;
      pendingIndoorCanvas = null;
      renderPendingPreview();
      const detail = built.buildingCount
        ? `主要建物 ${built.buildingCount}件・道路 ${built.roadCount}件`
        : `名前のある建物は見つかりませんでしたが、道路 ${built.roadCount}件を取得しました`;
      showFetchStatus(`取得しました(${detail})`, false);
      setStatus(`半径${radiusValue}mの地図データを取得しました(${detail})`);
    } catch (err) {
      console.error(err);
      const reason = describeOutdoorError(err);
      showFetchStatus('取得に失敗しました: ' + reason, true);
      setStatus('Mapping Storys: 地図データの取得に失敗しました: ' + reason, { important: true });
    } finally {
      msEls.fetchBtn.disabled = false;
      msEls.fetchBtn.textContent = originalLabel;
    }
  }

  function buildOverpassQuery(lat, lon, radius) {
    return `[out:json][timeout:25];(way["building"](around:${radius},${lat},${lon});way["highway"](around:${radius},${lat},${lon}););out geom;`;
  }

  /** 緯度経度を、現在地(lat0,lon0)を原点としたメートル→px換算のローカル座標へ変換する簡易等距円筒図法。 */
  function latLonToLocalPx(lat, lon, lat0, lon0) {
    const M_PER_DEG_LAT = 110540;
    const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const x = (lon - lon0) * mPerDegLon * PX_PER_METER;
    const y = -(lat - lat0) * M_PER_DEG_LAT * PX_PER_METER; // 北が上(-y方向)になるよう反転
    return [x, y];
  }

  /**
   * Overpassの応答から、緑線として描く形状の配列を組み立てる。
   * 【フィルタ】building タグを持つ要素は name タグを持つもの(=主要な建物名)だけを残す。
   * 道路(highway)には名前フィルタをかけない(名前を持つ道路は少なく、輪郭としての意味を
   * 優先するため)。座標は全形状のバウンディングボックスに合わせて0基点へ正規化する。
   */
  function buildShapesFromOverpass(elements, lat0, lon0) {
    const rawShapes = [];
    let buildingCount = 0;
    let roadCount = 0;
    elements.forEach((el) => {
      if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) return;
      const tags = el.tags || {};
      let type;
      if (tags.building) {
        if (!tags.name) return; // 主要建物名だけを残すフィルタ
        type = 'building';
        buildingCount++;
      } else if (tags.highway) {
        type = 'highway';
        roadCount++;
      } else {
        return;
      }
      const points = el.geometry
        .filter((g) => typeof g.lat === 'number' && typeof g.lon === 'number')
        .map((g) => latLonToLocalPx(g.lat, g.lon, lat0, lon0));
      if (points.length < 2) return;
      rawShapes.push({ type, name: tags.name || '', points });
    });

    if (!rawShapes.length) return { shapes: [], bboxWidth: 0, bboxHeight: 0, buildingCount, roadCount };

    const PADDING = 24;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    rawShapes.forEach((shape) => {
      shape.points.forEach(([x, y]) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
    });
    const shapes = rawShapes.map((shape) => ({
      type: shape.type,
      name: shape.name,
      points: shape.points.map(([x, y]) => [x - minX + PADDING, y - minY + PADDING]),
    }));
    return {
      shapes,
      bboxWidth: (maxX - minX) + PADDING * 2,
      bboxHeight: (maxY - minY) + PADDING * 2,
      buildingCount,
      roadCount,
    };
  }

  /* ==================== プレビュー ==================== */

  function renderPendingPreview() {
    msEls.preview.innerHTML = '';
    if (pendingIndoorCanvas) {
      msEls.preview.classList.remove('empty');
      msEls.preview.appendChild(pendingIndoorCanvas);
      msEls.deployBtn.disabled = false;
    } else if (pendingOutdoor && pendingOutdoor.shapes.length) {
      msEls.preview.classList.remove('empty');
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${pendingOutdoor.bboxWidth} ${pendingOutdoor.bboxHeight}`);
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      pendingOutdoor.shapes.forEach((shape) => {
        const poly = document.createElementNS(SVG_NS, 'polyline');
        poly.setAttribute('points', shape.points.map((p) => p.join(',')).join(' '));
        poly.setAttribute('class', `ms-shape ms-shape-${shape.type}`);
        svg.appendChild(poly);
      });
      msEls.preview.appendChild(svg);
      msEls.deployBtn.disabled = false;
    } else {
      msEls.preview.classList.add('empty');
      msEls.deployBtn.disabled = true;
    }
  }

  /* ==================== 展開(キャンバスへ反映) ==================== */

  function worldViewportCenter() {
    const rect = els.viewport.getBoundingClientRect();
    return {
      x: (rect.width / 2 - viewportState.x) / viewportState.scale,
      y: (rect.height / 2 - viewportState.y) / viewportState.scale,
    };
  }

  /**
   * 展開直後、地図全体が画面に収まるようキャンバスを自動でズーム・パンする。
   * 屋外は写真カード基準の換算係数(PX_PER_METER)のまま実距離どおりにスケールするため、
   * 半径150m(既定値)でも地図全体は約21000px四方という、通常の画面をはるかに超える
   * サイズになる。移動ハンドルは地図の中心に固定表示されるが、現在地からの相対座標である
   * 実際の建物・道路は中心付近にあるとは限らないため、展開してもハンドルだけが見え、
   * 肝心の輪郭線は画面のはるか外にある、という不具合(2026年9月、実機報告)への対策。
   */
  function fitViewportToMap(layer) {
    const w = (layer.kind === 'raster' ? layer.naturalWidth : layer.bboxWidth) * layer.scale;
    const h = (layer.kind === 'raster' ? layer.naturalHeight : layer.bboxHeight) * layer.scale;
    if (!w || !h) return;
    const rect = els.viewport.getBoundingClientRect();
    const margin = 0.85; // 端まで目一杯にせず、少し余白を持たせる
    const fitScale = Math.min((rect.width * margin) / w, (rect.height * margin) / h);
    // 小さい地図(屋内スキャンなど)まで無闇に拡大しないよう上限を設ける
    const newScale = Math.max(MIN_SCALE, Math.min(fitScale, 1.5));
    viewportState.scale = newScale;
    viewportState.x = rect.width / 2 - (layer.x + w / 2) * newScale;
    viewportState.y = rect.height / 2 - (layer.y + h / 2) * newScale;
    applyViewportTransform();
  }

  async function deployToCanvas() {
    const sessionId = activeSessionId();
    const session = getSessionById(sessionId);
    if (!session) {
      setStatus('セッションが見つかりません', { important: true });
      return;
    }
    if (session.mapLayer && !window.confirm('既にこのセッションに地図があります。置き換えますか?')) return;

    msEls.deployBtn.disabled = true;
    const originalLabel = msEls.deployBtn.textContent;
    msEls.deployBtn.textContent = '展開中…';
    setStatus('Mapping Storys: 地図を展開中…', { busy: true });
    try {
      const oldLayer = session.mapLayer;
      let newLayer;
      if (mode === 'indoor') {
        if (!pendingIndoorCanvas) return;
        const blob = await new Promise((resolve, reject) => {
          pendingIndoorCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画像の生成に失敗しました'))), 'image/png');
        });
        const folderId = await resolveSessionMediaFolderId(sessionId);
        const imageFileId = await uploadFile(folderId, blob, `mapping-storys-${Date.now()}.png`);
        newLayer = {
          kind: 'raster',
          imageFileId,
          naturalWidth: pendingIndoorCanvas.width,
          naturalHeight: pendingIndoorCanvas.height,
          scale: Math.min(1, DEFAULT_INDOOR_DISPLAY_WIDTH / pendingIndoorCanvas.width),
          rotation: 0,
          createdAt: new Date().toISOString(),
        };
      } else {
        if (!pendingOutdoor || !pendingOutdoor.shapes.length) return;
        newLayer = {
          kind: 'vector',
          shapes: pendingOutdoor.shapes,
          bboxWidth: pendingOutdoor.bboxWidth,
          bboxHeight: pendingOutdoor.bboxHeight,
          scale: 1,
          rotation: 0,
          createdAt: new Date().toISOString(),
        };
      }

      const center = worldViewportCenter();
      const w = newLayer.kind === 'raster' ? newLayer.naturalWidth : newLayer.bboxWidth;
      const h = newLayer.kind === 'raster' ? newLayer.naturalHeight : newLayer.bboxHeight;
      newLayer.x = center.x - (w * newLayer.scale) / 2;
      newLayer.y = center.y - (h * newLayer.scale) / 2;

      session.mapLayer = newLayer;
      scheduleAutoSave();

      // 置き換え前の屋内スキャン画像はベストエフォートで削除する(容量節約、失敗しても致命的ではない)
      if (oldLayer && oldLayer.kind === 'raster' && oldLayer.imageFileId) {
        deleteFile(oldLayer.imageFileId).catch((err) => console.warn('Mapping Storys: 旧地図画像の削除に失敗', err));
      }

      pendingIndoorCanvas = null;
      pendingOutdoor = null;
      renderPendingPreview();
      refreshCurrentMapBlock();

      fitViewportToMap(newLayer);
      playMappingStorysDeploySound();
      renderMappingStorysLayer({ animate: true });
      setStatus(`「${session.name || '(無題)'}」へ地図を展開しました`, { important: true });
    } catch (err) {
      console.error(err);
      setStatus('地図の展開に失敗しました: ' + (err.message || err), { important: true });
    } finally {
      msEls.deployBtn.disabled = false;
      msEls.deployBtn.textContent = originalLabel;
    }
  }

  function removeDeployedMap() {
    const session = getSessionById(activeSessionId());
    if (!session || !session.mapLayer) return;
    if (!window.confirm('このセッションの地図を削除しますか?')) return;
    const layer = session.mapLayer;
    session.mapLayer = null;
    scheduleAutoSave();
    if (layer.kind === 'raster' && layer.imageFileId) {
      deleteFile(layer.imageFileId).catch((err) => console.warn('Mapping Storys: 地図画像の削除に失敗', err));
    }
    refreshCurrentMapBlock();
    renderMappingStorysLayer();
    setStatus('地図を削除しました');
  }

  /* ==================== キャンバス背景としての描画(js/app.jsのrenderAllCards()から呼ばれる) ==================== */

  function applyMapLayerTransform(el, layer, moveHandle, resizeHandle, rotateHandle) {
    el.style.transform = `translate(${layer.x}px, ${layer.y}px) rotate(${layer.rotation}deg) scale(${layer.scale})`;
    // ハンドル自体は常に一定の見た目サイズ・向きに保つため、親のscale/rotationを打ち消す
    const counter = `scale(${1 / layer.scale}) rotate(${-layer.rotation}deg)`;
    if (moveHandle) moveHandle.style.transform = `translate(-50%, -50%) ${counter}`;
    if (resizeHandle) resizeHandle.style.transform = `translate(50%, 50%) ${counter}`;
    if (rotateHandle) rotateHandle.style.transform = `translate(-50%, -160%) ${counter}`;
  }

  function renderMappingStorysLayer(opts) {
    const animate = Boolean(opts && opts.animate);
    // 小窓を開いたままセッションを移動できるため(キャンバス操作をブロックしない設計)、
    // カード再描画のたびに呼ばれるこの関数を使って、小窓側の表示も追従させる。
    if (editingOpen && msEls) refreshCurrentMapBlock();

    // 【重要】renderAllCards()経由(els.content.innerHTML='')ならこの関数のcontainerも一緒に
    // 消えるが、deployToCanvas()/closeMappingStorys()/removeDeployedMap()はこの関数を直接
    // 呼ぶため、それを経由しない。以前は古いcontainerを消さずに新しいcontainerを追加するだけ
    // だったため、展開・開閉のたびに.ms-maplayer-containerが際限なく積み重なり、古い
    // ハンドル(pointer-events:auto)がキャンバス上に残り続けて、ダブルタップ俯瞰・ピンチズームを
    // 奪ったり、地図が一瞬しか見えないように見えたりする不具合の直接原因になっていた
    // (2026年9月、実機ログを元に特定)。必ず全部消してから作り直す。
    els.content.querySelectorAll('.ms-maplayer-container').forEach((node) => node.remove());

    const container = document.createElement('div');
    container.className = 'ms-maplayer-container';
    els.content.insertBefore(container, els.content.firstChild);

    const session = getSessionById(activeSessionId());
    const layer = session && session.mapLayer;
    if (!layer) return;

    const el = document.createElement('div');
    el.className = `ms-maplayer ms-maplayer-${layer.kind}${editingOpen ? ' ms-editable' : ''}`;
    const w = layer.kind === 'raster' ? layer.naturalWidth : layer.bboxWidth;
    const h = layer.kind === 'raster' ? layer.naturalHeight : layer.bboxHeight;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;

    if (layer.kind === 'raster') {
      const img = document.createElement('img');
      img.className = 'ms-maplayer-img';
      img.draggable = false;
      const errorText = document.createElement('span');
      errorText.className = 'ms-maplayer-error-text';
      errorText.hidden = true;
      errorText.textContent = '地図画像を読み込めませんでした(サインイン状態を確認してください)';
      getFileBlobUrlCached(layer.imageFileId)
        .then((url) => { img.src = url; })
        .catch((err) => {
          // サインイン切れなどで画像が取得できないと、以前は無言で何も表示されなかった
          // (「展開したのに見当たらない」報告の一因)。枠だけでも見えるようにする。
          // el.textContent で直接書き換えると、img やこの後追加される移動/リサイズ/回転の
          // ハンドルまで巻き添えで消えてしまうため、専用のテキスト要素だけを表示に切り替える。
          console.warn('Mapping Storys: 地図画像の取得に失敗', err);
          el.classList.add('ms-maplayer-error');
          errorText.hidden = false;
        });
      el.appendChild(img);
      el.appendChild(errorText);
    } else {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${layer.bboxWidth} ${layer.bboxHeight}`);
      layer.shapes.forEach((shape) => {
        const poly = document.createElementNS(SVG_NS, 'polyline');
        poly.setAttribute('points', shape.points.map((p) => p.join(',')).join(' '));
        poly.setAttribute('class', `ms-shape ms-shape-${shape.type}`);
        if (shape.name) {
          const title = document.createElementNS(SVG_NS, 'title');
          title.textContent = shape.name;
          poly.appendChild(title);
        }
        svg.appendChild(poly);
      });
      el.appendChild(svg);
    }

    let moveHandle = null;
    let resizeHandle = null;
    let rotateHandle = null;
    if (editingOpen) {
      moveHandle = document.createElement('div');
      moveHandle.className = 'ms-handle ms-handle-move';
      moveHandle.title = 'ドラッグで移動';
      moveHandle.textContent = '✥';
      el.appendChild(moveHandle);
      resizeHandle = document.createElement('div');
      resizeHandle.className = 'ms-handle ms-handle-resize';
      resizeHandle.title = 'ドラッグでリサイズ';
      el.appendChild(resizeHandle);
      rotateHandle = document.createElement('div');
      rotateHandle.className = 'ms-handle ms-handle-rotate';
      rotateHandle.title = 'ドラッグで回転';
      el.appendChild(rotateHandle);
      wireEditHandlers(el, layer, moveHandle, resizeHandle, rotateHandle);
    }

    applyMapLayerTransform(el, layer, moveHandle, resizeHandle, rotateHandle);
    container.appendChild(el);

    if (animate) {
      requestAnimationFrame(() => {
        el.classList.add('ms-deploying');
        setTimeout(() => el.classList.remove('ms-deploying'), DEPLOY_ANIM_MS + 60);
      });
    }
  }

  /* ==================== 移動・リサイズ・回転(小窓が開いている間だけ) ==================== */

  /**
   * 移動・リサイズ・回転は、それぞれ専用の小さなハンドルからのみ開始する(地図本体は常に
   * pointer-events:none)。以前は地図本体を直接ドラッグして移動できる設計だったが、展開直後の
   * タップ/ダブルタップ/ピンチが誤って「移動」と解釈されて地図が画面外へ飛んでしまい、かつ
   * 地図の広い当たり判定がキャンバスのピンチズーム・ダブルタップ俯瞰を奪ってしまう不具合が
   * あったため、2026年9月にハンドル方式へ変更した。
   */
  function wireEditHandlers(el, layer, moveHandle, resizeHandle, rotateHandle) {
    let dragging = false;
    let dragStart = { x: 0, y: 0 };
    let origPos = { x: 0, y: 0 };
    moveHandle.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      origPos = { x: layer.x, y: layer.y };
      moveHandle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    moveHandle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      layer.x = origPos.x + (e.clientX - dragStart.x) / viewportState.scale;
      layer.y = origPos.y + (e.clientY - dragStart.y) / viewportState.scale;
      applyMapLayerTransform(el, layer, moveHandle, resizeHandle, rotateHandle);
    });
    const endDrag = () => { if (dragging) { dragging = false; scheduleAutoSave(); } };
    moveHandle.addEventListener('pointerup', endDrag);
    moveHandle.addEventListener('pointercancel', endDrag);

    let resizing = false;
    let resizeStartX = 0;
    let origScale = 1;
    resizeHandle.addEventListener('pointerdown', (e) => {
      resizing = true;
      resizeStartX = e.clientX;
      origScale = layer.scale;
      resizeHandle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const dx = (e.clientX - resizeStartX) / viewportState.scale;
      const factor = 1 + dx / 200; // 200pxのドラッグでおよそ2倍、というざっくりした感度
      layer.scale = Math.max(0.05, Math.min(8, origScale * factor));
      applyMapLayerTransform(el, layer, moveHandle, resizeHandle, rotateHandle);
    });
    const endResize = () => { if (resizing) { resizing = false; scheduleAutoSave(); } };
    resizeHandle.addEventListener('pointerup', endResize);
    resizeHandle.addEventListener('pointercancel', endResize);

    let rotating = false;
    let rotateStartAngle = 0;
    let origRotation = 0;
    rotateHandle.addEventListener('pointerdown', (e) => {
      rotating = true;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      rotateStartAngle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
      origRotation = layer.rotation;
      rotateHandle.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    rotateHandle.addEventListener('pointermove', (e) => {
      if (!rotating) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angle = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
      layer.rotation = origRotation + (angle - rotateStartAngle);
      applyMapLayerTransform(el, layer, moveHandle, resizeHandle, rotateHandle);
    });
    const endRotate = () => { if (rotating) { rotating = false; scheduleAutoSave(); } };
    rotateHandle.addEventListener('pointerup', endRotate);
    rotateHandle.addEventListener('pointercancel', endRotate);
  }

  window.renderMappingStorysLayer = renderMappingStorysLayer;
})();
