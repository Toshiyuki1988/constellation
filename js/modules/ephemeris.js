// CONSTELLATION — Module: Ephemeris
//
// 「施行日」(展覧会の予定日)をカレンダーから登録しておくと、当日サインイン前の画面いっぱいに
// 植物で装飾された丸時計とタイムテーブルが現れる、鑑賞予定の予告モジュール。CLAUDE.mdの
// 「モジュール」規約に従い、このファイル全体をIIFEで包んでトップレベルの名前をグローバルへ
// 漏らさない。state / setStatus / escapeHtml / formatDateYMD / signIn / soundAudioCtx /
// registerModuleCode / findFileByName・loadNamedData・saveNamedData(js/drive.js) などの
// 既存グローバルは直接参照する。
//
// 起動: js/module-launcher.js経由、コード"357"(電話キーパッドの右下。123=WormGate・
// 456=Crews・789=Mapping Storysで洛書の3行、147=Flight Engineer・258=Astrometry Scope・
// 369=Star Pencilで3列、159=Almagestで対角線の片方を使っているため、残るもう一方の対角線
// から採用した)。Almagestと同じく専用の軽量Driveファイル(constellation-ephemeris.json)
// だけで完結し、state.cards/sessions(メインデータ)を必要としない
// (js/module-launcher.jsのNO_MAIN_DATA_NEEDED_CODES参照)。
//
// 【設計(2026年9月、ユーザー指定)】
//   - スケジュール(施行日+ラベル+タイムテーブル+スクリーンショット画像)はこのモジュールの
//     小窓から登録・編集・削除する。手動で削除するまで(過去の日付になっても)一覧に残り続ける。
//     スクリーンショット(マップ・時刻表など)はタイムテーブルのブロック単位で持ち、
//     タップ選択/ドラッグ&ドロップ/貼り付けの3通りで添付でき、OCRなどの加工を挟まず画像
//     そのまま(`generateThumbnail()`で長辺1000px・quality0.8に縮小したdataURL)を保持する。
//     フラッシュ画面にもそのまま表示される(画像はブロックごとに開閉できる、後述)。
//   - 施行日当日、サインイン前の「ログイン前フラッシュ」(js/app.jsのDOMContentLoaded、
//     通常はゴールデンレコードのロード画面が出る場面)に、ゴールデンレコードの代わりに
//     画面全体を覆う丸時計+タイムテーブルが現れる。誤タップ防止のため、この日は
//     画面のどこをタップしても自動サインインを試みる既存の仕組み
//     (js/app.jsのarmAutoSignInOnFirstGesture())をアームせず、フラッシュ画面の専用の
//     「サインイン」ボタン(上部バー、丸時計本体とは離れた場所)からのみサインインする。
//   - **丸時計はスケジュールの内容を一切反映しない、純粋に装飾の現在時刻表示**(ユーザー指定:
//     「これには予定を反映しなくても大丈夫です」)。植物のつる・花で縁を囲んだ意匠で、
//     実際の現在時刻(端末のローカル時刻)を指す時針・分針・秒針を持つ(`buildClockFace()`)。
//     当初あった「花つる」(mist/wall2形状、スケジュールごとに選べる成長アニメーション)は
//     2026年9月にユーザー判断で撤去し、この丸時計に置き換えた(下記「2026年9月の追加改修」参照)。
//
// 【ログイン前フラッシュがDrive/認証を待たずに判定できる理由】
// サインイン前(js/app.jsのDOMContentLoaded、認証もDrive通信もまだ行っていない段階)に
// 「今日が施行日かどうか」を知る必要があるため、Almagest/年インデックスと同じ「専用の
// 軽量Driveファイル」方式に加えて、スケジュールが変更されるたび(保存・削除時)に
// 端末のlocalStorage(EPHEMERIS_CACHE_KEY)へも同期的にミラーする。js/app.js側は
// このlocalStorageだけを同期的に読んで判定する(getTodayEphemerisSchedules())。
// **既知の制約**: このミラーは端末(ブラウザ)ローカルのため、スケジュールを登録した端末とは
// 別の端末でフラッシュを見るには、その端末でも一度サインインしてこのモジュールを
// 開く(=Driveから読み込んでミラーが作られる)必要がある。個人利用・単一主端末を前提にした
// 割り切りとして許容する(既存のアップロード待機列IndexedDB等、同種の割り切りが他にもある)。
//
// 【2026年9月の追加改修】
//   - 外部AI(旅程作成チャット等)が出力した「HH:MM 内容」形式のフリーテキストをそのまま
//     貼り付けて解析し、ブロック単位の入力行へ変換できるようにした(parseTimetableFreetext())。
//     手動のブロック編集自体は残しており、解析結果は既存の行へ追記される。
//   - スクリーンショット(マップ・時刻表など)はスケジュール単位ではなく、タイムテーブルの
//     ブロック単位(`row.images`)で複数枚持てるように変更した。旧形式(スケジュール単位の
//     `schedule.images`)は初回読み込み時にmigrateLegacyScheduleImages()で1回だけ移行する。
//   - 【同日中に撤回・作り直し】当初、ログイン前フラッシュはスマホ幅(680px以下)で「つる」/
//     「タイムテーブル」をタブで切り替える表示にしていたが、「『つる』は結局使わないかも、
//     モジュールから削除して」というユーザー判断により、花つる(VINE_SHAPES・buildVineSvg・
//     mist/wall選択UI)自体を丸ごと撤去した。代わりに「植物で装飾された丸時計」を常設で
//     表示する(`buildClockFace()`。スケジュールの内容とは無関係な純粋装飾、現在時刻を指す)。
//     つる/タイムテーブルの二者択一が無くなったことで、モバイル幅専用のタブ切り替えUI自体も
//     不要になった(丸時計は小さく、タイムテーブルと並べて`flex-wrap`で自然に縦積みになる)。
//   - タイムテーブルのブロックに添付したスクリーンショットは、フラッシュ画面上でブロックごとに
//     開閉トグル(📷ボタン)できるようにした(既定は閉じた状態、タップで開閉)。
//   - UIの配色は、最初にMapping Storysの緑と被らないよう明るめの緑(rgb(108,242,138))に
//     変更したが、「色がミッドグリーンのままなのでライトグリーンに修正して」との指摘を受け、
//     彩度を落とし明度をさらに上げた真の「ライトグリーン」(rgb(150,240,178)系)へ再調整した。

(function () {
  'use strict';

  const EPHEMERIS_CACHE_KEY = 'constellation-ephemeris-cache';

  let epEls = null;
  let stylesInjected = false;
  let editingId = null; // null = 新規登録フォーム
  // タイムテーブルの入力行。各要素は{time, text, images}で、そのままschedule.timetableへ保存する。
  // スクリーンショット(マップ・時刻表など)は2026年9月にスケジュール単位からブロック単位へ変更した
  // (「そのブロックごとにマップ、時刻表などのスクショを複数登録できるようにして」というユーザー要望)。
  let formTimetable = [];
  // フォーカス中(最後に触れた)行。クリップボード貼り付け(win全体のpasteイベント)がどの行の
  // 画像として追加されるかを決めるために使う(貼り付け自体には対象を選ぶUIが無いため)。
  let formTimetableFocusedIndex = 0;

  let ephemerisDataLoaded = false;
  let ephemerisDataLoadPromise = null;

  function escapeAttrLocal(str) {
    return escapeHtml(str || '').replace(/"/g, '&quot;');
  }

  /* ---------------- データアクセス ---------------- */

  function getSchedules() {
    return state.ephemerisSchedules || (state.ephemerisSchedules = []);
  }

  /** スケジュール変更のたび同期的に呼ぶ。ログイン前フラッシュ(js/app.js)が、Drive/認証を
   *  待たずにこの中身だけを見て「今日が施行日か」を判定する。 */
  function mirrorToLocalCache() {
    try {
      localStorage.setItem(EPHEMERIS_CACHE_KEY, JSON.stringify(getSchedules()));
    } catch (err) {
      // プライベートモード等でlocalStorageが使えない場合は諦める(この端末ではログイン前
      // フラッシュが出ないだけで、モジュール自体・Drive上のデータには影響しない)。
      console.warn('Ephemerisのローカルキャッシュ書き込みに失敗', err);
    }
  }

  /** js/app.jsのDOMContentLoaded(サインイン前、最も早いタイミング)から同期的に呼ばれる。
   *  localStorageだけを見て、今日(端末のローカル日時)が施行日のスケジュールを返す。 */
  function getTodayEphemerisSchedules() {
    let list;
    try {
      const raw = localStorage.getItem(EPHEMERIS_CACHE_KEY);
      list = raw ? JSON.parse(raw) : [];
    } catch (err) {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const today = formatDateYMD(new Date());
    return list.filter((s) => s && s.date === today);
  }

  async function initEphemerisData() {
    if (!state.folderId) { ephemerisDataLoaded = true; return; }
    try {
      const { fileId, data } = await loadNamedData(state.folderId, CONFIG.EPHEMERIS_FILE_NAME);
      state.ephemerisFileId = fileId || null;
      state.ephemerisSchedules = (data && Array.isArray(data.schedules)) ? data.schedules : [];
      // 旧形式(スケジュール単位の`images`)を読み込んだ場合、ブロック単位の`row.images`へ
      // 一度だけ移行する(下記migrateLegacyScheduleImages()参照)。次回保存時にDrive側にも反映される。
      state.ephemerisSchedules.forEach(migrateLegacyScheduleImages);
      // 他端末で登録・編集された分もこのタイミングで端末側キャッシュへ反映しておく
      // (このモジュールを開いた端末でだけ、以降のログイン前フラッシュが追従する)。
      mirrorToLocalCache();
    } catch (err) {
      console.error('Ephemerisのスケジュール読み込みに失敗', err);
      setStatus('スケジュールの読み込みに失敗しました(通信を確認してください)', { important: true });
    }
    ephemerisDataLoaded = true;
  }

  function ensureEphemerisDataLoaded() {
    if (ephemerisDataLoaded) return Promise.resolve();
    if (ephemerisDataLoadPromise) return ephemerisDataLoadPromise;
    ephemerisDataLoadPromise = initEphemerisData().finally(() => { ephemerisDataLoadPromise = null; });
    return ephemerisDataLoadPromise;
  }

  /** @returns {Promise<boolean>} Driveへの送信に成功したか */
  async function saveEphemerisDataNow() {
    mirrorToLocalCache(); // オフラインでもログイン前フラッシュの判定に使えるよう、Drive送信より先に更新する
    if (!state.folderId) return false;
    try {
      state.ephemerisFileId = await saveNamedData(
        state.folderId, state.ephemerisFileId,
        { schedules: getSchedules(), updatedAt: Date.now() },
        CONFIG.EPHEMERIS_FILE_NAME
      );
      return true;
    } catch (err) {
      console.error('Ephemerisのスケジュール保存に失敗', err);
      return false;
    }
  }

  /* ---------------- 植物で装飾された丸時計(装飾専用、スケジュールの内容は反映しない) ---------------- */

  // 時計の縁を囲む8方向の小さなつる+花(見た目のみ、角度で回転コピーする)。
  const CLOCK_WREATH_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];
  const CLOCK_TENDRIL_PATH = 'M 150 44 C 140 30 142 14 156 10';
  const CLOCK_TENDRIL_TIP = { x: 156, y: 10, r: 4.5 };

  /** 植物で装飾された丸時計(SVG)を1つ組み立てる。実際の現在時刻(端末のローカル時刻)を
   *  指す時針・分針・秒針を持つが、スケジュールの内容は一切参照しない、純粋な装飾。
   *  @returns {{svg: SVGSVGElement, update: () => void}} update()は針の角度を現在時刻へ合わせ直す */
  function buildClockFace() {
    const ns = 'http://www.w3.org/2000/svg';
    const cx = 150, cy = 150, r = 100;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 300 300');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'eph-clock-svg');

    const decorPaths = [];
    const decorBlossoms = [];
    CLOCK_WREATH_ANGLES.forEach((angle) => {
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('transform', `rotate(${angle} ${cx} ${cy})`);
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('class', 'eph-clock-tendril');
      p.setAttribute('d', CLOCK_TENDRIL_PATH);
      g.appendChild(p);
      const b = document.createElementNS(ns, 'circle');
      b.setAttribute('class', 'eph-clock-blossom');
      b.setAttribute('cx', String(CLOCK_TENDRIL_TIP.x));
      b.setAttribute('cy', String(CLOCK_TENDRIL_TIP.y));
      b.setAttribute('r', String(CLOCK_TENDRIL_TIP.r));
      g.appendChild(b);
      svg.appendChild(g);
      decorPaths.push(p);
      decorBlossoms.push(b);
    });

    const face = document.createElementNS(ns, 'circle');
    face.setAttribute('cx', String(cx)); face.setAttribute('cy', String(cy)); face.setAttribute('r', String(r));
    face.setAttribute('class', 'eph-clock-face');
    svg.appendChild(face);

    const ticks = document.createElementNS(ns, 'g');
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const major = i % 3 === 0;
      const outerR = r - 6;
      const innerR = r - (major ? 18 : 11);
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(cx + Math.cos(a) * outerR));
      line.setAttribute('y1', String(cy + Math.sin(a) * outerR));
      line.setAttribute('x2', String(cx + Math.cos(a) * innerR));
      line.setAttribute('y2', String(cy + Math.sin(a) * innerR));
      line.setAttribute('class', major ? 'eph-clock-tick eph-clock-tick--major' : 'eph-clock-tick');
      ticks.appendChild(line);
    }
    svg.appendChild(ticks);

    function makeHand(cls) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('class', `eph-clock-hand ${cls}`);
      line.setAttribute('x1', String(cx)); line.setAttribute('y1', String(cy));
      svg.appendChild(line);
      return line;
    }
    const hourHand = makeHand('eph-clock-hand--hour');
    const minuteHand = makeHand('eph-clock-hand--minute');
    const secondHand = makeHand('eph-clock-hand--second');

    const centerDot = document.createElementNS(ns, 'circle');
    centerDot.setAttribute('cx', String(cx)); centerDot.setAttribute('cy', String(cy)); centerDot.setAttribute('r', '5');
    centerDot.setAttribute('class', 'eph-clock-center');
    svg.appendChild(centerDot);

    function setHand(el, degrees, length) {
      const rad = (degrees - 90) * Math.PI / 180;
      el.setAttribute('x2', String(cx + Math.cos(rad) * length));
      el.setAttribute('y2', String(cy + Math.sin(rad) * length));
    }
    function update() {
      const now = new Date();
      const h = (now.getHours() % 12) + now.getMinutes() / 60;
      const m = now.getMinutes() + now.getSeconds() / 60;
      const s = now.getSeconds();
      setHand(hourHand, (h / 12) * 360, r * 0.5);
      setHand(minuteHand, (m / 60) * 360, r * 0.74);
      setHand(secondHand, (s / 60) * 360, r * 0.82);
    }
    update();

    // 一過性の一回きりの成長演出(常時アニメーションのパルスは使わない、CLAUDE.mdの
    // モジュール意匠の方針に沿う)。時針・分針・秒針は現在時刻を指し続けるため常時更新するが、
    // これは「パルス」ではなく本物の時計として当然必要な更新(update()を外側から定期的に呼ぶ)。
    requestAnimationFrame(() => {
      decorPaths.forEach((p) => {
        const len = p.getTotalLength();
        p.style.strokeDasharray = String(len);
        p.style.strokeDashoffset = String(len);
        requestAnimationFrame(() => {
          p.classList.add('grow');
          p.style.strokeDashoffset = '0';
        });
      });
      decorBlossoms.forEach((b, i) => {
        b.style.transitionDelay = `${0.4 + i * 0.08}s`;
        requestAnimationFrame(() => b.classList.add('bloom'));
      });
    });

    return { svg, update };
  }

  /* ---------------- ログイン前フラッシュ(js/app.jsから呼ばれる) ---------------- */

  let flashEls = null;
  // 丸時計の針を現在時刻へ合わせ続けるタイマー(フラッシュ表示中だけ動かす、非表示中は止める)。
  let clockIntervalId = null;

  /** injectStyles()は本来openEphemeris()(小窓を開いた時)だけ呼べば足りるが、ログイン前
   *  フラッシュ(showEphemerisFlash())はサインイン前、つまりユーザーが一度もこのセッション中に
   *  小窓を開いていない状態から呼ばれうる。そのため両方の入口で同じガード付きヘルパーを通す。 */
  function ensureStylesInjected() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
  }

  function buildFlashDom() {
    ensureStylesInjected();
    const overlay = document.createElement('div');
    overlay.className = 'eph-flash-overlay';
    overlay.innerHTML = `
      <div class="eph-flash-topbar">
        <span class="eph-flash-kicker">EPHEMERIS</span>
        <button class="eph-flash-signin-btn" type="button">サインイン</button>
      </div>
      <div class="eph-flash-stage">
        <div class="eph-flash-clock-wrap"></div>
        <div class="eph-flash-timetable"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    // 丸時計はスケジュールの内容と無関係な純粋装飾のため、表示のたび作り直さず一度だけ組み立てる。
    const clock = buildClockFace();
    overlay.querySelector('.eph-flash-clock-wrap').appendChild(clock.svg);
    flashEls = {
      overlay,
      signinBtn: overlay.querySelector('.eph-flash-signin-btn'),
      timetable: overlay.querySelector('.eph-flash-timetable'),
      clockUpdate: clock.update,
    };
    // 誤タップ防止の核心: サインインはこのボタン以外のどこをタップしても発生しない
    // (丸時計・タイムテーブル自体は装飾/読み取り専用で、サインインには一切反応しない)。
    flashEls.signinBtn.addEventListener('click', () => {
      flashEls.signinBtn.disabled = true;
      flashEls.signinBtn.textContent = 'サインイン中…';
      if (typeof soundAudioCtx === 'function') soundAudioCtx();
      if (typeof signIn === 'function') signIn();
    });
    // ブロックごとのスクリーンショット開閉トグル(再描画のたび要素が差し替わるため委譲にする)。
    flashEls.timetable.addEventListener('click', (e) => {
      const btn = e.target.closest('.eph-flash-tt-img-toggle');
      if (!btn) return;
      btn.closest('.eph-flash-tt-item').classList.toggle('eph-flash-tt-item--open');
    });
  }

  /** "HH:MM"を当日0時からの分数へ変換する。不正な形式はnullを返す。 */
  function timeStringToMinutes(time) {
    if (!time) return null;
    const parts = String(time).split(':');
    if (parts.length !== 2) return null;
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  }

  function renderFlashTimetable(schedules) {
    flashEls.timetable.innerHTML = '';
    // 「現在の時刻に最も近いブロック」のハイライトは、スケジュール(=展覧会)ごとに独立して
    // 判定する(複数のスケジュールが同日に並んでいても、互いの時刻を混ぜて比較しない)。
    flashEls.nowHighlightGroups = [];
    schedules.forEach((sch) => {
      const block = document.createElement('div');
      block.className = 'eph-flash-tt-block';
      const label = document.createElement('p');
      label.className = 'eph-flash-tt-label';
      label.textContent = sch.label || '(無題)';
      block.appendChild(label);

      const list = document.createElement('div');
      list.className = 'eph-flash-tt-list';
      const rows = sch.timetable || [];
      const group = [];
      rows.forEach((row, i) => {
        const item = document.createElement('div');
        item.className = 'eph-flash-tt-item';
        const timeHtml = row.time ? `<span class="eph-flash-tt-time">${escapeHtml(row.time)}</span>` : '';
        const images = resolveRowImages(sch, row, i === 0);
        // 添付画像は既定で閉じておき、📷ボタンで開閉できるようにする(スクリーンショットが
        // 多いとタイムテーブルが縦に長くなりすぎるための対応)。
        const toggleHtml = images.length
          ? `<button type="button" class="eph-flash-tt-img-toggle">📷 ${images.length}</button>`
          : '';
        const imagesHtml = images.length
          ? `<div class="eph-flash-tt-item-images">${images.map((src) => `<img class="eph-flash-img" src="${escapeAttrLocal(src)}" alt="">`).join('')}</div>`
          : '';
        item.innerHTML = `<div class="eph-flash-tt-item-main">${timeHtml}<span class="eph-flash-tt-text">${escapeHtml(row.text || '')}</span>${toggleHtml}</div>${imagesHtml}`;
        list.appendChild(item);
        const minutes = timeStringToMinutes(row.time);
        if (minutes !== null) group.push({ el: item, minutes });
      });
      if (rows.length === 0) {
        list.innerHTML = '<p class="eph-flash-tt-empty">タイムテーブル未登録</p>';
      }
      block.appendChild(list);
      flashEls.timetable.appendChild(block);
      if (group.length > 0) flashEls.nowHighlightGroups.push(group);
    });
  }

  /** 各スケジュールのタイムテーブルのうち、現在時刻(端末のローカル時刻)に最も近い時刻の
   *  ブロックだけを黄色系でハイライトする。DOMを再構築せずクラスの付け替えだけで行うため、
   *  ブロック画像の開閉状態(上記トグル)を保ったまま、1秒おきに呼んでも安全。 */
  function refreshNowHighlight() {
    if (!flashEls || !flashEls.nowHighlightGroups) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    flashEls.nowHighlightGroups.forEach((group) => {
      let bestIdx = -1;
      let bestDiff = Infinity;
      group.forEach((t, i) => {
        const diff = Math.abs(t.minutes - nowMin);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      });
      group.forEach((t, i) => t.el.classList.toggle('eph-flash-tt-item--now', i === bestIdx));
    });
  }

  function showEphemerisFlash(schedules) {
    if (!flashEls) buildFlashDom();
    flashEls.signinBtn.disabled = false;
    flashEls.signinBtn.textContent = 'サインイン';
    renderFlashTimetable(schedules);
    refreshNowHighlight();
    flashEls.overlay.classList.add('open');
    // 丸時計の針を現在時刻へ即座に合わせてから、表示中だけ1秒おきに更新する
    // (「現在に最も近いブロック」のハイライトも、日をまたがず表示し続けた場合に備え同じ頻度で追従させる)。
    if (clockIntervalId) clearInterval(clockIntervalId);
    flashEls.clockUpdate();
    clockIntervalId = setInterval(() => {
      flashEls.clockUpdate();
      refreshNowHighlight();
    }, 1000);
  }

  function hideEphemerisFlash() {
    if (flashEls) flashEls.overlay.classList.remove('open');
    if (clockIntervalId) { clearInterval(clockIntervalId); clockIntervalId = null; }
  }

  /* ---------------- モジュール小窓(スケジュール管理) ---------------- */

  function byDateAsc(a, b) {
    return (a.date || '').localeCompare(b.date || '');
  }

  /** 旧形式(`schedule.images`、スケジュール単位のスクリーンショット配列)を、ブロック単位の
   *  `row.images`へ一度だけ移行する。移行先が無い(タイムテーブルが空)場合は、画像だけを
   *  保持する無題のブロックを1つ作る。既に新形式のスケジュールには何もしない。 */
  function migrateLegacyScheduleImages(s) {
    if (!Array.isArray(s.timetable)) s.timetable = [];
    s.timetable.forEach((row) => { if (!Array.isArray(row.images)) row.images = []; });
    if (Array.isArray(s.images) && s.images.length) {
      if (s.timetable.length === 0) {
        s.timetable.push({ time: '', text: '', images: s.images.slice() });
      } else {
        s.timetable[0].images = (s.timetable[0].images || []).concat(s.images);
      }
    }
    delete s.images;
  }

  /** ログイン前フラッシュ(localStorageミラー経由)は、この更新より前に保存された旧形式の
   *  キャッシュを読む可能性があるため、表示側でも同じフォールバックを非破壊的に行う。 */
  function resolveRowImages(sch, row, isFirstRow) {
    const own = Array.isArray(row.images) ? row.images : [];
    if (own.length) return own;
    if (isFirstRow && Array.isArray(sch.images) && sch.images.length) return sch.images;
    return [];
  }

  /** 「HH:MM 内容」形式のフリーテキスト(外部AIが作った旅程・タイムテーブルのコピペを想定)を
   *  行ごとに解析し、ブロック(`{time, text}`)の配列へ変換する。時刻が見つからない行は
   *  時刻欄を空欄のまま内容として取り込む(丸ごと捨てない)。空行はスキップする。 */
  function parseTimetableFreetext(text) {
    const lines = String(text || '').split(/\r?\n/);
    const rows = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^[-・*●○]?\s*(\d{1,2}:\d{2})(?:\s*[~\-〜–—]\s*\d{1,2}:\d{2})?\s*[:：]?\s*(.*)$/);
      if (m) {
        const [h, mm] = m[1].split(':');
        rows.push({ time: `${h.padStart(2, '0')}:${mm}`, text: m[2].trim(), images: [] });
      } else {
        rows.push({ time: '', text: line, images: [] });
      }
    }
    return rows;
  }

  /** タイムテーブルの1行を「時刻(空欄可)+内容」のブロックとして描き直す(2026年9月、
   *  フリーテキスト入力からブロック単位の入力へ変更)。formTimetableの各要素を直接書き換える
   *  ため、input/changeイベントはコンテナへの委譲(buildDom()参照)で拾う。 */
  function renderTimetableRows() {
    if (!epEls) return;
    epEls.timetableRows.innerHTML = formTimetable.map((row, i) => `
      <div class="eph-tt-row" data-index="${i}">
        <div class="eph-tt-row-main">
          <input type="time" class="eph-tt-row-time" value="${escapeAttrLocal(row.time || '')}">
          <input type="text" class="eph-tt-row-text" placeholder="内容(例: 開館・受付)" value="${escapeAttrLocal(row.text || '')}">
          <button type="button" class="eph-tt-row-remove" title="この行を削除">✕</button>
        </div>
        <div class="eph-tt-row-images">
          <button type="button" class="eph-tt-row-img-add">📷 画像を追加</button>
          ${(row.images || []).map((src, j) => (
            `<div class="eph-tt-row-img-item">`
            + `<img src="${escapeAttrLocal(src)}" alt="">`
            + `<button type="button" class="eph-tt-row-img-remove" data-remove-image="${j}" title="削除">✕</button>`
            + '</div>'
          )).join('')}
        </div>
      </div>
    `).join('');
  }

  function addTimetableRow(focus) {
    formTimetable.push({ time: '', text: '', images: [] });
    renderTimetableRows();
    if (focus) {
      const rows = epEls.timetableRows.querySelectorAll('.eph-tt-row-text');
      const last = rows[rows.length - 1];
      if (last) last.focus();
    }
  }

  /** ドロップ/選択/貼り付けされた画像ファイル(複数可)を、OCRなどの加工を挟まず**そのまま**、
   *  指定したブロック(行)へ追加する(マップ・時刻表のスクリーンショットは文字が読めることが
   *  重要なため、Almagestの本文貼り付け画像と同じくgenerateThumbnail()で長辺を保ちつつ縮小するだけに留める)。 */
  async function applyRowImageFiles(rowIndex, files) {
    const row = formTimetable[rowIndex];
    if (!row) return;
    if (!Array.isArray(row.images)) row.images = [];
    for (const file of files) {
      if (!file.type || !file.type.startsWith('image/')) continue;
      const dataUrl = await generateThumbnail(file, 1000, 0.8);
      if (dataUrl) row.images.push(dataUrl);
    }
    renderTimetableRows();
  }

  function triggerRowImagePicker(rowIndex) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      if (files.length) applyRowImageFiles(rowIndex, files);
    });
    input.click();
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* ==================== 小窓(スケジュール管理) ==================== */
      .eph-window {
        position: fixed; top: 18px; right: 18px; z-index: 115;
        width: min(86vw, 290px); max-height: calc(100vh - 36px); overflow-y: auto;
        background: rgba(9, 13, 10, 0.95); border: 1px solid rgba(150, 240, 178, 0.4);
        border-radius: 14px; padding: 13px 13px 15px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        display: none; opacity: 0; transform: scale(0.92) translateY(-6px);
        transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .eph-window.open { display: block; opacity: 1; transform: scale(1) translateY(0); }
      .eph-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; cursor: grab; }
      .eph-top-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em;
        color: #d7fbe3; text-transform: uppercase;
      }
      .eph-close {
        width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(150, 240, 178, 0.4);
        color: rgba(255, 255, 255, 0.85); font-size: 11px; cursor: pointer; padding: 0;
      }
      .eph-close:hover { background: rgba(150, 240, 178, 0.28); }
      .eph-empty { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 255, 255, 0.4); margin: 4px 0 12px; }
      .eph-row {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 7px 9px; margin-bottom: 6px; border-radius: 8px;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .eph-row-main { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .eph-row-date { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #eef2e6; flex: none; }
      .eph-row-label {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 10.5px; color: rgba(255, 255, 255, 0.75);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .eph-row-btns { display: flex; gap: 4px; flex: none; }
      .eph-row-edit, .eph-row-delete {
        width: 20px; height: 20px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.18);
        background: transparent; color: rgba(255, 255, 255, 0.6); font-size: 10px; cursor: pointer; padding: 0;
      }
      .eph-row-edit:hover { border-color: rgba(150, 240, 178, 0.65); color: #fff; }
      .eph-row-delete:hover { border-color: #b3402b; color: #ff8a70; }
      .eph-form { margin-top: 6px; border-top: 1px dashed rgba(255, 255, 255, 0.14); padding-top: 10px; }
      .eph-form-label {
        margin: 8px 0 4px; font-family: 'IBM Plex Mono', monospace; font-size: 8.5px;
        letter-spacing: 0.1em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45);
      }
      .eph-date-input, .eph-label-input {
        width: 100%; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 6px;
        padding: 6px 8px; font-size: 11px; background: rgba(255, 255, 255, 0.06); color: #fff;
        font-family: 'Zen Kaku Gothic New', sans-serif;
      }
      .eph-date-input { color-scheme: dark; }
      /* 外部AIの旅程・タイムテーブルをそのまま貼り付けて解析する欄(2026年9月追加)。
         解析結果はブロック単位の入力行(下記)へ追記される。 */
      .eph-tt-paste-input {
        width: 100%; box-sizing: border-box; resize: vertical; min-height: 52px;
        border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 6px; padding: 6px 8px;
        font-size: 10.5px; background: rgba(255, 255, 255, 0.06); color: #fff;
        font-family: 'IBM Plex Mono', monospace; line-height: 1.5; margin-bottom: 6px;
      }
      .eph-tt-parse-btn {
        width: 100%; padding: 7px 8px; border-radius: 7px; border: 1px solid rgba(150, 240, 178, 0.45);
        background: rgba(150, 240, 178, 0.14); color: #d7fbe3; font-family: 'Zen Kaku Gothic New', sans-serif;
        font-size: 10.5px; font-weight: 700; cursor: pointer; margin-bottom: 12px;
      }
      .eph-tt-parse-btn:hover { background: rgba(150, 240, 178, 0.26); color: #fff; }
      /* タイムテーブルの入力行(1ブロック=時刻+内容+画像複数枚)。 */
      .eph-tt-rows { display: flex; flex-direction: column; gap: 10px; margin-bottom: 6px; }
      .eph-tt-row {
        padding: 7px; border-radius: 8px; background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .eph-tt-row.eph-tt-row-dragover { border-color: rgba(150, 240, 178, 0.9); background: rgba(150, 240, 178, 0.12); }
      .eph-tt-row-main { display: flex; align-items: center; gap: 6px; }
      .eph-tt-row-time {
        width: 92px; flex: none; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 6px;
        padding: 6px 6px; font-size: 10.5px; background: rgba(255, 255, 255, 0.06); color: #fff;
        font-family: 'IBM Plex Mono', monospace; color-scheme: dark;
      }
      .eph-tt-row-text {
        flex: 1; min-width: 0; box-sizing: border-box; border: 1px solid rgba(255, 255, 255, 0.16); border-radius: 6px;
        padding: 6px 8px; font-size: 11px; background: rgba(255, 255, 255, 0.06); color: #fff;
        font-family: 'Zen Kaku Gothic New', sans-serif;
      }
      .eph-tt-row-remove {
        width: 22px; height: 22px; border-radius: 50%; flex: none; border: 1px solid rgba(255, 255, 255, 0.18);
        background: transparent; color: rgba(255, 255, 255, 0.55); font-size: 10px; cursor: pointer; padding: 0;
      }
      .eph-tt-row-remove:hover { border-color: #b3402b; color: #ff8a70; }
      .eph-tt-row-images { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 7px; }
      .eph-tt-row-img-add {
        padding: 6px 8px; border-radius: 7px; border: 1px dashed rgba(255, 255, 255, 0.24);
        background: none; color: rgba(255, 255, 255, 0.55); font-family: 'Zen Kaku Gothic New', sans-serif;
        font-size: 10px; cursor: pointer;
      }
      .eph-tt-row-img-add:hover { border-color: rgba(150, 240, 178, 0.65); color: #fff; }
      .eph-tt-row-img-item {
        position: relative; width: 46px; height: 46px; border-radius: 6px; overflow: hidden;
        background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.16);
      }
      .eph-tt-row-img-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .eph-tt-row-img-remove {
        position: absolute; top: 1px; right: 1px; width: 15px; height: 15px; border-radius: 50%;
        border: none; background: rgba(0, 0, 0, 0.62); color: #fff; font-size: 9px; line-height: 1; cursor: pointer; padding: 0;
      }
      .eph-tt-row-img-remove:hover { background: rgba(0, 0, 0, 0.85); }
      .eph-tt-add-btn {
        width: 100%; padding: 7px 8px; border-radius: 7px; border: 1px dashed rgba(255, 255, 255, 0.22);
        background: none; color: rgba(255, 255, 255, 0.7); font-family: 'Zen Kaku Gothic New', sans-serif;
        font-size: 10.5px; cursor: pointer; margin-bottom: 4px;
      }
      .eph-tt-add-btn:hover { border-color: rgba(150, 240, 178, 0.6); color: #fff; }
      .eph-form-actions { display: flex; gap: 8px; margin-top: 10px; }
      .eph-save-btn {
        flex: 1; padding: 9px 8px; border-radius: 8px; border: none;
        background: #96f0b2; color: #0d2a18; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700;
        font-size: 11px; cursor: pointer;
      }
      .eph-save-btn:hover { background: #b8f7cb; }
      .eph-cancel-btn {
        padding: 9px 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.2);
        background: none; color: rgba(255, 255, 255, 0.7); font-family: 'Zen Kaku Gothic New', sans-serif;
        font-size: 11px; cursor: pointer;
      }
      .eph-hint { font-family: 'IBM Plex Mono', monospace; font-size: 8px; color: rgba(255, 255, 255, 0.35); margin: 10px 0 0; line-height: 1.6; }

      /* ==================== ログイン前フラッシュ ==================== */
      .eph-flash-overlay {
        position: fixed; inset: 0; z-index: 260;
        display: flex; flex-direction: column;
        background: radial-gradient(ellipse 90% 55% at 50% 78%, #13221a 0%, transparent 62%), #05100b;
        opacity: 0; pointer-events: none;
        transition: opacity 0.5s ease-out;
      }
      .eph-flash-overlay.open { opacity: 1; pointer-events: auto; }
      .eph-flash-topbar {
        flex: none; display: flex; align-items: center; justify-content: space-between;
        padding: calc(14px + env(safe-area-inset-top, 0px)) 18px 12px;
        border-bottom: 1px solid rgba(150, 240, 178, 0.26);
      }
      .eph-flash-kicker {
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.28em; text-indent: 0.28em;
        color: rgba(150, 240, 178, 0.85); text-transform: uppercase;
      }
      .eph-flash-signin-btn {
        padding: 9px 20px; border-radius: 999px; border: 1px solid rgba(150, 240, 178, 0.55);
        background: rgba(150, 240, 178, 0.16); color: #eef2e6; font-family: 'IBM Plex Mono', monospace;
        font-size: 11.5px; letter-spacing: 0.05em; cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }
      .eph-flash-signin-btn:hover { background: rgba(150, 240, 178, 0.3); border-color: rgba(150, 240, 178, 0.9); }
      .eph-flash-signin-btn:active { transform: scale(0.96); }
      .eph-flash-signin-btn:disabled { opacity: 0.6; cursor: default; }
      .eph-flash-stage {
        flex: 1; min-height: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
        gap: 22px; padding: 20px; overflow: auto;
      }
      /* 植物で装飾された丸時計(スケジュールの内容は反映しない、純粋な装飾)。 */
      .eph-flash-clock-wrap { width: min(46vw, 200px); flex: none; }
      .eph-clock-svg { width: 100%; height: auto; display: block; }
      .eph-clock-face { fill: none; stroke: rgba(150, 240, 178, 0.75); stroke-width: 2.4; }
      .eph-clock-tick { stroke: rgba(150, 240, 178, 0.5); stroke-width: 1.6; }
      .eph-clock-tick--major { stroke: rgba(150, 240, 178, 0.85); stroke-width: 2.4; }
      .eph-clock-hand { stroke-linecap: round; }
      .eph-clock-hand--hour { stroke: #eef2e6; stroke-width: 4.2; }
      .eph-clock-hand--minute { stroke: #eef2e6; stroke-width: 2.6; }
      .eph-clock-hand--second { stroke: #e2a7b6; stroke-width: 1.4; }
      .eph-clock-center { fill: #eef2e6; }
      .eph-clock-tendril {
        fill: none; stroke: rgba(150, 240, 178, 0.85); stroke-width: 2.4; stroke-linecap: round;
        filter: drop-shadow(0 0 4px rgba(150, 240, 178, 0.4));
      }
      .eph-clock-tendril.grow { transition: stroke-dashoffset 1.3s cubic-bezier(0.3, 0.7, 0.2, 1); }
      .eph-clock-blossom { fill: #e2a7b6; opacity: 0; transform-origin: center; transform: scale(0.3); }
      .eph-clock-blossom.bloom {
        transition: opacity 0.5s ease, transform 0.5s cubic-bezier(0.3, 1.4, 0.4, 1);
        opacity: 1; transform: scale(1);
      }
      @media (prefers-reduced-motion: reduce) {
        .eph-clock-tendril.grow, .eph-clock-blossom { transition: none !important; }
      }
      .eph-flash-timetable { width: min(88vw, 320px); display: flex; flex-direction: column; gap: 18px; }
      .eph-flash-tt-label {
        margin: 0 0 8px; font-family: 'Fraunces', serif; font-size: 15px; color: #eef2e6; letter-spacing: 0.02em;
      }
      .eph-flash-tt-list { display: flex; flex-direction: column; gap: 8px; }
      .eph-flash-tt-item {
        display: flex; flex-direction: column; gap: 8px;
        padding: 7px 10px; border-radius: 8px; background: rgba(150, 240, 178, 0.09); border: 1px solid rgba(150, 240, 178, 0.22);
        transition: background 0.3s ease, border-color 0.3s ease;
      }
      /* 「現在の時刻に最も近いブロック」のハイライト(2026年9月追加、黄色系)。 */
      .eph-flash-tt-item--now {
        background: rgba(255, 214, 84, 0.16); border-color: rgba(255, 214, 84, 0.7);
        box-shadow: 0 0 14px rgba(255, 214, 84, 0.18);
      }
      .eph-flash-tt-item--now .eph-flash-tt-time { color: #ffe066; }
      .eph-flash-tt-item-main {
        display: flex; gap: 10px; align-items: baseline;
        font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: rgba(238, 242, 230, 0.85);
      }
      .eph-flash-tt-time { color: #d7fbe3; flex: none; }
      .eph-flash-tt-text { flex: 1; font-family: 'Zen Kaku Gothic New', sans-serif; }
      .eph-flash-tt-empty { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 255, 255, 0.35); }
      /* ブロックごとのマップ・時刻表などのスクリーンショット。既定は閉じておき、📷ボタンで開閉する
         (2026年9月変更: 常時表示だとスクリーンショットが多い時にタイムテーブルが長くなりすぎるため)。 */
      .eph-flash-tt-img-toggle {
        margin-left: auto; flex: none; padding: 3px 10px; border-radius: 999px;
        border: 1px solid rgba(150, 240, 178, 0.45); background: rgba(150, 240, 178, 0.12);
        color: #d7fbe3; font-family: 'IBM Plex Mono', monospace; font-size: 10px; cursor: pointer;
      }
      .eph-flash-tt-img-toggle:hover { background: rgba(150, 240, 178, 0.24); }
      .eph-flash-tt-item-images { display: none; flex-direction: column; gap: 10px; }
      .eph-flash-tt-item--open .eph-flash-tt-item-images { display: flex; }
      .eph-flash-img {
        display: block; width: 100%; max-width: 340px; border-radius: 10px;
        border: 1px solid rgba(150, 240, 178, 0.32); box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
      }
    `;
    document.head.appendChild(style);
  }

  function resetForm() {
    editingId = null;
    epEls.dateInput.value = '';
    epEls.labelInput.value = '';
    epEls.timetablePasteInput.value = '';
    formTimetable = [{ time: '', text: '', images: [] }]; // 最初から1行出しておく(「+行を追加」を押す手間を省く)
    formTimetableFocusedIndex = 0;
    renderTimetableRows();
    epEls.saveBtn.textContent = '登録する';
    epEls.cancelBtn.hidden = true;
  }

  function startEdit(id) {
    const s = getSchedules().find((x) => x.id === id);
    if (!s) return;
    migrateLegacyScheduleImages(s);
    editingId = id;
    epEls.dateInput.value = s.date || '';
    epEls.labelInput.value = s.label || '';
    epEls.timetablePasteInput.value = '';
    formTimetable = (s.timetable && s.timetable.length)
      ? s.timetable.map((row) => ({ time: row.time || '', text: row.text || '', images: (row.images || []).slice() }))
      : [{ time: '', text: '', images: [] }];
    formTimetableFocusedIndex = 0;
    renderTimetableRows();
    epEls.saveBtn.textContent = '更新する';
    epEls.cancelBtn.hidden = false;
  }

  function renderList() {
    const schedules = getSchedules().slice().sort(byDateAsc);
    epEls.list.innerHTML = '';
    if (schedules.length === 0) {
      epEls.list.innerHTML = '<p class="eph-empty">まだスケジュールがありません</p>';
      return;
    }
    schedules.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'eph-row';
      row.innerHTML = `
        <div class="eph-row-main">
          <span class="eph-row-date">${escapeHtml(s.date || '')}</span>
          <span class="eph-row-label">${escapeHtml(s.label || '(無題)')}</span>
        </div>
        <div class="eph-row-btns">
          <button class="eph-row-edit" title="編集">✎</button>
          <button class="eph-row-delete" title="削除">🗑</button>
        </div>
      `;
      row.querySelector('.eph-row-edit').addEventListener('click', () => startEdit(s.id));
      row.querySelector('.eph-row-delete').addEventListener('click', () => deleteSchedule(s.id));
      epEls.list.appendChild(row);
    });
  }

  async function handleSaveClick() {
    const date = epEls.dateInput.value;
    if (!date) { setStatus('施行日を選択してください', { important: true }); return; }
    const label = epEls.labelInput.value.trim();
    // 時刻・内容・画像のいずれも無い行(未入力のまま残った追加行など)は保存しない。
    const timetable = formTimetable
      .map((row) => ({ time: (row.time || '').trim() || null, text: (row.text || '').trim(), images: (row.images || []).slice() }))
      .filter((row) => row.time || row.text || row.images.length);
    const schedules = getSchedules();
    if (editingId) {
      const s = schedules.find((x) => x.id === editingId);
      if (s) { s.date = date; s.label = label; s.timetable = timetable; delete s.images; delete s.vineShape; }
    } else {
      schedules.push({
        id: crypto.randomUUID(), date, label, timetable,
        createdAt: new Date().toISOString(),
      });
    }
    resetForm();
    renderList();
    const ok = await saveEphemerisDataNow();
    setStatus(ok ? 'スケジュールを保存しました' : 'スケジュールを端末に保存しました(Driveへの送信に失敗、次回開いた時に再試行します)', { important: !ok });
  }

  async function deleteSchedule(id) {
    const schedules = getSchedules();
    const idx = schedules.findIndex((x) => x.id === id);
    if (idx === -1) return;
    schedules.splice(idx, 1);
    if (editingId === id) resetForm();
    renderList();
    await saveEphemerisDataNow();
  }

  function buildDom() {
    const win = document.createElement('div');
    win.className = 'eph-window';
    win.innerHTML = `
      <div class="eph-top">
        <span class="eph-top-label">Ephemeris</span>
        <button class="eph-close" title="閉じる">✕</button>
      </div>
      <div class="eph-list"></div>
      <div class="eph-form">
        <p class="eph-form-label">施行日</p>
        <input type="date" class="eph-date-input">
        <p class="eph-form-label">ラベル(任意)</p>
        <input type="text" class="eph-label-input" placeholder="例: 六甲ミーツ・アート">
        <p class="eph-form-label">外部AIの旅程を貼り付けて解析(任意)</p>
        <textarea class="eph-tt-paste-input" placeholder="09:00 開館&#10;10:30 ギャラリートーク&#10;12:00 昼休憩"></textarea>
        <button type="button" class="eph-tt-parse-btn">解析してブロックに追加</button>
        <p class="eph-form-label">タイムテーブル(ブロックごとに時刻・内容・画像を持てます)</p>
        <div class="eph-tt-rows"></div>
        <button type="button" class="eph-tt-add-btn">+ 行を追加</button>
        <div class="eph-form-actions">
          <button class="eph-cancel-btn" hidden>キャンセル</button>
          <button class="eph-save-btn">登録する</button>
        </div>
      </div>
      <p class="eph-hint">
        施行日当日、サインイン前の画面いっぱいに丸時計とタイムテーブルが現れます(誤タップ防止のため、
        その日はサインインボタンを別途タップする必要があります)。スケジュールは手動で削除するまで
        (過去の日付になっても)一覧に残ります。
      </p>
    `;
    document.body.appendChild(win);

    epEls = {
      win,
      closeBtn: win.querySelector('.eph-close'),
      list: win.querySelector('.eph-list'),
      dateInput: win.querySelector('.eph-date-input'),
      labelInput: win.querySelector('.eph-label-input'),
      timetableRows: win.querySelector('.eph-tt-rows'),
      timetableAddBtn: win.querySelector('.eph-tt-add-btn'),
      timetablePasteInput: win.querySelector('.eph-tt-paste-input'),
      timetableParseBtn: win.querySelector('.eph-tt-parse-btn'),
      saveBtn: win.querySelector('.eph-save-btn'),
      cancelBtn: win.querySelector('.eph-cancel-btn'),
    };

    // 小窓内の操作が、下のキャンバスのパン/ジェスチャーに奪われないようにする。ギャラリーの
    // ✕ボタンは再描画のたびに要素が差し替わるため、個別バインドではなくwin全体で拾う。
    win.querySelectorAll('button, input, textarea').forEach((el) => {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });
    win.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.eph-tt-row-time, .eph-tt-row-text, .eph-tt-row-remove, .eph-tt-row-img-add, .eph-tt-row-img-remove')) {
        e.stopPropagation();
      }
    });

    epEls.closeBtn.addEventListener('click', closeEphemeris);
    epEls.saveBtn.addEventListener('click', handleSaveClick);
    epEls.cancelBtn.addEventListener('click', resetForm);

    // 外部AIが作った旅程・タイムテーブルのフリーテキストを解析してブロックへ追記する。
    epEls.timetableParseBtn.addEventListener('click', () => {
      const parsed = parseTimetableFreetext(epEls.timetablePasteInput.value);
      if (parsed.length === 0) return;
      // resetForm()直後の「最初から1行出しておく」空行は、解析結果で置き換える(残すと
      // 空のブロックが1つ紛れ込んでしまうため)。
      if (formTimetable.length === 1 && !formTimetable[0].time && !formTimetable[0].text && formTimetable[0].images.length === 0) {
        formTimetable = parsed;
      } else {
        formTimetable.push(...parsed);
      }
      renderTimetableRows();
      epEls.timetablePasteInput.value = '';
    });

    // タイムテーブルの行(再描画のたびに要素が差し替わるため、コンテナへのイベント委譲にする)。
    epEls.timetableAddBtn.addEventListener('click', () => addTimetableRow(true));
    epEls.timetableRows.addEventListener('input', (e) => {
      const row = e.target.closest('.eph-tt-row');
      if (!row) return;
      const i = Number(row.dataset.index);
      if (e.target.classList.contains('eph-tt-row-time')) formTimetable[i].time = e.target.value;
      if (e.target.classList.contains('eph-tt-row-text')) formTimetable[i].text = e.target.value;
    });
    // どの行に触れているか(貼り付けの対象)を追跡する。
    epEls.timetableRows.addEventListener('focusin', (e) => {
      const row = e.target.closest('.eph-tt-row');
      if (row) formTimetableFocusedIndex = Number(row.dataset.index);
    });
    epEls.timetableRows.addEventListener('click', (e) => {
      const removeRowBtn = e.target.closest('.eph-tt-row-remove');
      if (removeRowBtn) {
        const row = removeRowBtn.closest('.eph-tt-row');
        formTimetable.splice(Number(row.dataset.index), 1);
        renderTimetableRows();
        return;
      }
      const addImgBtn = e.target.closest('.eph-tt-row-img-add');
      if (addImgBtn) {
        const row = addImgBtn.closest('.eph-tt-row');
        formTimetableFocusedIndex = Number(row.dataset.index);
        triggerRowImagePicker(formTimetableFocusedIndex);
        return;
      }
      const removeImgBtn = e.target.closest('.eph-tt-row-img-remove');
      if (removeImgBtn) {
        const row = removeImgBtn.closest('.eph-tt-row');
        const rowIdx = Number(row.dataset.index);
        formTimetable[rowIdx].images.splice(Number(removeImgBtn.dataset.removeImage), 1);
        renderTimetableRows();
      }
    });
    // ブロック単位のドラッグ&ドロップ(PC向け、行の枠内にドロップした画像をその行へ追加する)。
    let dragoverRow = null;
    epEls.timetableRows.addEventListener('dragover', (e) => {
      const row = e.target.closest('.eph-tt-row');
      if (!row || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    epEls.timetableRows.addEventListener('dragenter', (e) => {
      const row = e.target.closest('.eph-tt-row');
      if (!row || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      if (dragoverRow && dragoverRow !== row) dragoverRow.classList.remove('eph-tt-row-dragover');
      dragoverRow = row;
      row.classList.add('eph-tt-row-dragover');
    });
    epEls.timetableRows.addEventListener('dragleave', (e) => {
      const row = e.target.closest('.eph-tt-row');
      if (row && !row.contains(e.relatedTarget)) row.classList.remove('eph-tt-row-dragover');
    });
    epEls.timetableRows.addEventListener('drop', (e) => {
      const row = e.target.closest('.eph-tt-row');
      if (!row) return;
      e.preventDefault();
      row.classList.remove('eph-tt-row-dragover');
      dragoverRow = null;
      const files = Array.from(e.dataTransfer.files || []).filter((f) => f.type.startsWith('image/'));
      if (files.length) applyRowImageFiles(Number(row.dataset.index), files);
    });
    // クリップボードからの画像ペースト(小窓が開いている間だけ)。最後にフォーカスしていた
    // ブロックへ追加する。画像アイテムが無ければ通常のテキスト貼り付けに譲る(e.preventDefault()しない)。
    win.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
      if (imageItems.length === 0) return;
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) applyRowImageFiles(formTimetableFocusedIndex, files);
    });

    // スワイプで左右に閉じる(モジュール共通デザイン言語)。上部バーから始まった場合だけ判定する。
    let swipeStartX = null;
    let swipeStartY = null;
    let swipeStartT = 0;
    win.querySelector('.eph-top').addEventListener('pointerdown', (e) => {
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
      if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeEphemeris();
    });
  }

  /* ==================== 開閉 ==================== */

  async function openEphemeris() {
    ensureStylesInjected();
    if (!epEls) buildDom();
    resetForm();
    epEls.win.classList.add('open');
    if (!ephemerisDataLoaded) {
      setStatus('スケジュールを読み込み中…', { busy: true });
      await ensureEphemerisDataLoaded();
      setStatus('スケジュールを読み込みました');
    }
    renderList();
  }

  function closeEphemeris() {
    if (epEls) epEls.win.classList.remove('open');
  }

  registerModuleCode('357', openEphemeris);

  window.openEphemeris = openEphemeris;
  window.getTodayEphemerisSchedules = getTodayEphemerisSchedules;
  window.showEphemerisFlash = showEphemerisFlash;
  window.hideEphemerisFlash = hideEphemerisFlash;
})();
