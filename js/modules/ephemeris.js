// CONSTELLATION — Module: Ephemeris
//
// 「施行日」(展覧会の予定日)をカレンダーから登録しておくと、当日サインイン前の画面いっぱいに
// 花つる(装飾)とタイムテーブルが現れる、鑑賞予定の予告モジュール。CLAUDE.mdの「モジュール」
// 規約に従い、このファイル全体をIIFEで包んでトップレベルの名前をグローバルへ漏らさない。
// state / setStatus / escapeHtml / formatDateYMD / signIn / soundAudioCtx / registerModuleCode /
// findFileByName・loadNamedData・saveNamedData(js/drive.js) などの既存グローバルは直接参照する。
//
// 起動: js/module-launcher.js経由、コード"357"(電話キーパッドの右下。123=WormGate・
// 456=Crews・789=Mapping Storysで洛書の3行、147=Flight Engineer・258=Astrometry Scope・
// 369=Star Pencilで3列、159=Almagestで対角線の片方を使っているため、残るもう一方の対角線
// から採用した)。Almagestと同じく専用の軽量Driveファイル(constellation-ephemeris.json)
// だけで完結し、state.cards/sessions(メインデータ)を必要としない
// (js/module-launcher.jsのNO_MAIN_DATA_NEEDED_CODES参照)。
//
// 【設計(2026年9月、ユーザー指定)】
//   - スケジュール(施行日+ラベル+タイムテーブル+花つるの形状+スクリーンショット画像)は
//     このモジュールの小窓から登録・編集・削除する。手動で削除するまで(過去の日付になっても)
//     一覧に残り続ける。スクリーンショット(マップ・時刻表など)はタップ選択/ドラッグ&ドロップ/
//     貼り付けの3通りで添付でき、OCRなどの加工を挟まず画像そのまま(`generateThumbnail()`で
//     長辺1000px・quality0.8に縮小したdataURL)を保持する。フラッシュ画面にもそのまま表示される。
//   - 施行日当日、サインイン前の「ログイン前フラッシュ」(js/app.jsのDOMContentLoaded、
//     通常はゴールデンレコードのロード画面が出る場面)に、ゴールデンレコードの代わりに
//     画面全体を覆う花つる+タイムテーブルが現れる。誤タップ防止のため、この日は
//     画面のどこをタップしても自動サインインを試みる既存の仕組み
//     (js/app.jsのarmAutoSignInOnFirstGesture())をアームせず、花つる画面の専用の
//     「サインイン」ボタン(上部バー、花つる本体とは離れた場所)からのみサインインする。
//   - 花つるの形状は2種類、常にこのモジュール画面から変更できる:
//       - 霧に向かうつる(mist): 六甲ミーツ・アートのような、会場を歩き回って探索する日向け。
//         画面の奥(右上)の霧へ向かって伸びていく、横方向に開けたつる。
//       - 壁つる(wall): 国立国際美術館のような、一人の作家を掘り下げる日向け。
//         壁を上から下へ辿っていくような、縦方向に集中したつる。
//
// 【ログイン前フラッシュがDrive/認証を待たずに判定できる理由】
// サインイン前(js/app.jsのDOMContentLoaded、認証もDrive通信もまだ行っていない段階)に
// 「今日が施行日かどうか」を知る必要があるため、Almagest/年インデックスと同じ「専用の
// 軽量Driveファイル」方式に加えて、スケジュールが変更されるたび(保存・削除時)に
// 端末のlocalStorage(EPHEMERIS_CACHE_KEY)へも同期的にミラーする。js/app.js側は
// このlocalStorageだけを同期的に読んで判定する(getTodayEphemerisSchedules())。
// **既知の制約**: このミラーは端末(ブラウザ)ローカルのため、スケジュールを登録した端末とは
// 別の端末で花つるフラッシュを見るには、その端末でも一度サインインしてこのモジュールを
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
//   - ログイン前フラッシュはスマホ幅(680px以下)で「つる」/「タイムテーブル」をタブで
//     切り替える表示に変更した(それより広い画面では従来通り両方を並べて表示する)。
//   - UIの配色をMapping Storysの緑と被らないよう、より明るい緑(#6cf28a系)に変更した。

(function () {
  'use strict';

  const EPHEMERIS_CACHE_KEY = 'constellation-ephemeris-cache';

  let epEls = null;
  let stylesInjected = false;
  let editingId = null; // null = 新規登録フォーム
  let selectedShape = 'mist';
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

  /* ---------------- 花つる(2形状) ---------------- */

  const VINE_SHAPES = {
    mist: {
      label: '霧に向かうつる',
      // 画面の下から右上の霧(mist:true)へ向かって伸びる、横方向に開けたカーブ。
      path: 'M 40 560 C 78 522 48 472 96 440 C 144 408 116 358 170 332 C 224 306 214 254 282 228 C 332 209 344 174 382 148',
      blossoms: [
        { x: 80, y: 500, r: 6 }, { x: 112, y: 430, r: 5 }, { x: 162, y: 370, r: 6.5 },
        { x: 216, y: 298, r: 5 }, { x: 278, y: 244, r: 6 }, { x: 340, y: 188, r: 5 },
      ],
      mist: true,
    },
    wall: {
      label: '壁つる',
      // 画面上から下へ、壁を辿るように蛇行しながら降りていく縦方向のカーブ。
      path: 'M 200 26 C 150 78 250 128 194 184 C 138 240 248 290 190 346 C 132 402 242 452 196 506 C 168 538 208 558 198 582',
      blossoms: [
        { x: 170, y: 74 }, { x: 228, y: 150 }, { x: 156, y: 216 },
        { x: 236, y: 300 }, { x: 148, y: 372 }, { x: 228, y: 452 },
      ],
      mist: false,
    },
  };

  function buildVineSvg(shape) {
    const spec = VINE_SHAPES[shape] || VINE_SHAPES.mist;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 400 610');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', `eph-vine-svg eph-vine-svg--${shape}`);

    if (spec.mist) {
      const defs = document.createElementNS(ns, 'defs');
      defs.innerHTML = '<radialGradient id="eph-mist-grad" cx="82%" cy="28%" r="52%">'
        + '<stop offset="0%" stop-color="#cdd9d2" stop-opacity="0.55"/>'
        + '<stop offset="100%" stop-color="#cdd9d2" stop-opacity="0"/>'
        + '</radialGradient>';
      svg.appendChild(defs);
      const mistRect = document.createElementNS(ns, 'rect');
      mistRect.setAttribute('x', '0'); mistRect.setAttribute('y', '0');
      mistRect.setAttribute('width', '400'); mistRect.setAttribute('height', '610');
      mistRect.setAttribute('fill', 'url(#eph-mist-grad)');
      svg.appendChild(mistRect);
    }

    const path = document.createElementNS(ns, 'path');
    path.setAttribute('class', 'eph-vine-path');
    path.setAttribute('d', spec.path);
    svg.appendChild(path);

    spec.blossoms.forEach((b, i) => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('class', 'eph-vine-blossom');
      c.setAttribute('cx', String(b.x));
      c.setAttribute('cy', String(b.y));
      c.setAttribute('r', String(b.r || 6));
      c.style.transitionDelay = `${1.1 + i * 0.22}s`;
      svg.appendChild(c);
    });

    // 一過性の一回きりの成長演出(常時アニメーションのパルスは使わない、CLAUDE.mdの
    // モジュール意匠の方針に沿う)。stroke-dasharray/dashoffsetで手前から奥へ伸ばし、
    // 終わったら静止した「咲いた」状態のまま残す。
    requestAnimationFrame(() => {
      const len = path.getTotalLength();
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(len);
      requestAnimationFrame(() => {
        path.classList.add('grow');
        path.style.strokeDashoffset = '0';
        svg.querySelectorAll('.eph-vine-blossom').forEach((el) => el.classList.add('bloom'));
      });
    });

    return svg;
  }

  /* ---------------- ログイン前フラッシュ(js/app.jsから呼ばれる) ---------------- */

  let flashEls = null;

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
      <div class="eph-flash-mobile-tabs">
        <button type="button" class="eph-flash-tab sel" data-tab="vine">つる</button>
        <button type="button" class="eph-flash-tab" data-tab="timetable">タイムテーブル</button>
      </div>
      <div class="eph-flash-stage" data-active-tab="vine">
        <div class="eph-flash-vine-wrap"></div>
        <div class="eph-flash-timetable"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    flashEls = {
      overlay,
      signinBtn: overlay.querySelector('.eph-flash-signin-btn'),
      stage: overlay.querySelector('.eph-flash-stage'),
      tabs: Array.from(overlay.querySelectorAll('.eph-flash-tab')),
      vineWrap: overlay.querySelector('.eph-flash-vine-wrap'),
      timetable: overlay.querySelector('.eph-flash-timetable'),
    };
    // 誤タップ防止の核心: サインインはこのボタン以外のどこをタップしても発生しない
    // (花つる・タイムテーブル自体は装飾/読み取り専用で、クリックに一切反応しない)。
    flashEls.signinBtn.addEventListener('click', () => {
      flashEls.signinBtn.disabled = true;
      flashEls.signinBtn.textContent = 'サインイン中…';
      if (typeof soundAudioCtx === 'function') soundAudioCtx();
      if (typeof signIn === 'function') signIn();
    });
    // スマホ幅専用の「つる」/「タイムテーブル」切り替えタブ(広い画面ではCSS側で常に非表示)。
    flashEls.tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        flashEls.stage.dataset.activeTab = btn.dataset.tab;
        flashEls.tabs.forEach((b) => b.classList.toggle('sel', b === btn));
      });
    });
  }

  function renderFlashVine(schedules) {
    flashEls.vineWrap.innerHTML = '';
    // 同じ日に複数のスケジュールが登録されている稀なケースでは、先頭(一覧のソート順)の
    // 花つる形状だけを表示する(タイムテーブルは全件並べて表示する、下記参照)。
    const shape = (schedules[0] && schedules[0].vineShape) || 'mist';
    flashEls.vineWrap.appendChild(buildVineSvg(shape));
  }

  function renderFlashTimetable(schedules) {
    flashEls.timetable.innerHTML = '';
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
      rows.forEach((row, i) => {
        const item = document.createElement('div');
        item.className = 'eph-flash-tt-item';
        const timeHtml = row.time ? `<span class="eph-flash-tt-time">${escapeHtml(row.time)}</span>` : '';
        const images = resolveRowImages(sch, row, i === 0);
        const imagesHtml = images.length
          ? `<div class="eph-flash-tt-item-images">${images.map((src) => `<img class="eph-flash-img" src="${escapeAttrLocal(src)}" alt="">`).join('')}</div>`
          : '';
        item.innerHTML = `<div class="eph-flash-tt-item-main">${timeHtml}<span class="eph-flash-tt-text">${escapeHtml(row.text || '')}</span></div>${imagesHtml}`;
        list.appendChild(item);
      });
      if (rows.length === 0) {
        list.innerHTML = '<p class="eph-flash-tt-empty">タイムテーブル未登録</p>';
      }
      block.appendChild(list);
      flashEls.timetable.appendChild(block);
    });
  }

  function showEphemerisFlash(schedules) {
    if (!flashEls) buildFlashDom();
    flashEls.signinBtn.disabled = false;
    flashEls.signinBtn.textContent = 'サインイン';
    // 表示のたび「つる」タブへ戻す(前回タイムテーブル側を見ていた状態のまま次の表示に
    // 持ち越さない、常に花つるの成長演出から始まる元々の体験を優先する)。
    flashEls.stage.dataset.activeTab = 'vine';
    flashEls.tabs.forEach((b) => b.classList.toggle('sel', b.dataset.tab === 'vine'));
    renderFlashVine(schedules);
    renderFlashTimetable(schedules);
    flashEls.overlay.classList.add('open');
  }

  function hideEphemerisFlash() {
    if (flashEls) flashEls.overlay.classList.remove('open');
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
        background: rgba(9, 13, 10, 0.95); border: 1px solid rgba(108, 242, 138, 0.35);
        border-radius: 14px; padding: 13px 13px 15px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        display: none; opacity: 0; transform: scale(0.92) translateY(-6px);
        transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .eph-window.open { display: block; opacity: 1; transform: scale(1) translateY(0); }
      .eph-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; cursor: grab; }
      .eph-top-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 10px; letter-spacing: 0.1em;
        color: #b3f7c4; text-transform: uppercase;
      }
      .eph-close {
        width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(108, 242, 138, 0.35);
        color: rgba(255, 255, 255, 0.85); font-size: 11px; cursor: pointer; padding: 0;
      }
      .eph-close:hover { background: rgba(108, 242, 138, 0.25); }
      .eph-empty { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 255, 255, 0.4); margin: 4px 0 12px; }
      .eph-row {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 7px 9px; margin-bottom: 6px; border-radius: 8px;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08);
      }
      .eph-row-main { display: flex; align-items: center; gap: 7px; min-width: 0; }
      .eph-row-date { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: #eef2e6; flex: none; }
      .eph-row-shape { flex: none; }
      .eph-row-label {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 10.5px; color: rgba(255, 255, 255, 0.75);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .eph-row-btns { display: flex; gap: 4px; flex: none; }
      .eph-row-edit, .eph-row-delete {
        width: 20px; height: 20px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.18);
        background: transparent; color: rgba(255, 255, 255, 0.6); font-size: 10px; cursor: pointer; padding: 0;
      }
      .eph-row-edit:hover { border-color: rgba(108, 242, 138, 0.6); color: #fff; }
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
        width: 100%; padding: 7px 8px; border-radius: 7px; border: 1px solid rgba(108, 242, 138, 0.4);
        background: rgba(108, 242, 138, 0.12); color: #b3f7c4; font-family: 'Zen Kaku Gothic New', sans-serif;
        font-size: 10.5px; font-weight: 700; cursor: pointer; margin-bottom: 12px;
      }
      .eph-tt-parse-btn:hover { background: rgba(108, 242, 138, 0.24); color: #fff; }
      /* タイムテーブルの入力行(1ブロック=時刻+内容+画像複数枚)。 */
      .eph-tt-rows { display: flex; flex-direction: column; gap: 10px; margin-bottom: 6px; }
      .eph-tt-row {
        padding: 7px; border-radius: 8px; background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .eph-tt-row.eph-tt-row-dragover { border-color: rgba(108, 242, 138, 0.85); background: rgba(108, 242, 138, 0.1); }
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
      .eph-tt-row-img-add:hover { border-color: rgba(108, 242, 138, 0.6); color: #fff; }
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
      .eph-tt-add-btn:hover { border-color: rgba(108, 242, 138, 0.55); color: #fff; }
      .eph-shape-row { display: flex; gap: 6px; }
      .eph-shape-btn {
        flex: 1; padding: 8px 4px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.16);
        background: none; color: rgba(255, 255, 255, 0.65); font-family: 'Zen Kaku Gothic New', sans-serif;
        font-size: 10.5px; cursor: pointer; text-align: center;
      }
      .eph-shape-btn.sel { background: rgba(226, 167, 182, 0.22); border-color: rgba(226, 167, 182, 0.65); color: #fff; font-weight: 700; }
      .eph-form-actions { display: flex; gap: 8px; margin-top: 10px; }
      .eph-save-btn {
        flex: 1; padding: 9px 8px; border-radius: 8px; border: none;
        background: #6cf28a; color: #06210f; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700;
        font-size: 11px; cursor: pointer;
      }
      .eph-save-btn:hover { background: #8ff7a8; }
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
        border-bottom: 1px solid rgba(108, 242, 138, 0.22);
      }
      .eph-flash-kicker {
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.28em; text-indent: 0.28em;
        color: rgba(108, 242, 138, 0.8); text-transform: uppercase;
      }
      .eph-flash-signin-btn {
        padding: 9px 20px; border-radius: 999px; border: 1px solid rgba(108, 242, 138, 0.5);
        background: rgba(108, 242, 138, 0.14); color: #eef2e6; font-family: 'IBM Plex Mono', monospace;
        font-size: 11.5px; letter-spacing: 0.05em; cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
      }
      .eph-flash-signin-btn:hover { background: rgba(108, 242, 138, 0.26); border-color: rgba(108, 242, 138, 0.85); }
      .eph-flash-signin-btn:active { transform: scale(0.96); }
      .eph-flash-signin-btn:disabled { opacity: 0.6; cursor: default; }
      /* スマホ画面での「つる」/「タイムテーブル」切り替えタブ(2026年9月追加)。
         広い画面では常に両方並べて表示するため、このタブ自体を非表示にする(下記メディアクエリ参照)。 */
      .eph-flash-mobile-tabs { display: none; justify-content: center; gap: 10px; padding: 10px 18px 0; }
      .eph-flash-tab {
        padding: 6px 16px; border-radius: 999px; border: 1px solid rgba(108, 242, 138, 0.3);
        background: rgba(108, 242, 138, 0.06); color: rgba(238, 242, 230, 0.55);
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; letter-spacing: 0.04em; cursor: pointer;
      }
      .eph-flash-tab.sel { background: rgba(108, 242, 138, 0.26); color: #eef2e6; border-color: rgba(108, 242, 138, 0.75); }
      .eph-flash-stage {
        flex: 1; min-height: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
        gap: 22px; padding: 20px; overflow: auto;
      }
      .eph-flash-vine-wrap { width: min(66vw, 320px); flex: none; }
      .eph-vine-svg { width: 100%; height: auto; display: block; }
      .eph-flash-timetable { width: min(88vw, 320px); display: flex; flex-direction: column; gap: 18px; }
      .eph-flash-tt-label {
        margin: 0 0 8px; font-family: 'Fraunces', serif; font-size: 15px; color: #eef2e6; letter-spacing: 0.02em;
      }
      .eph-flash-tt-list { display: flex; flex-direction: column; gap: 8px; }
      .eph-flash-tt-item {
        display: flex; flex-direction: column; gap: 8px;
        padding: 7px 10px; border-radius: 8px; background: rgba(108, 242, 138, 0.08); border: 1px solid rgba(108, 242, 138, 0.18);
      }
      .eph-flash-tt-item-main {
        display: flex; gap: 10px; align-items: baseline;
        font-family: 'IBM Plex Mono', monospace; font-size: 11.5px; color: rgba(238, 242, 230, 0.85);
      }
      .eph-flash-tt-time { color: #b3f7c4; flex: none; }
      .eph-flash-tt-text { flex: 1; font-family: 'Zen Kaku Gothic New', sans-serif; }
      .eph-flash-tt-empty { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 255, 255, 0.35); }
      /* ブロックごとのマップ・時刻表などのスクリーンショット。文字が読めることを優先し、
         小さいサムネイルではなく画面幅に近い大きさで並べる。 */
      .eph-flash-tt-item-images { display: flex; flex-direction: column; gap: 10px; }
      .eph-flash-img {
        display: block; width: 100%; max-width: 340px; border-radius: 10px;
        border: 1px solid rgba(108, 242, 138, 0.28); box-shadow: 0 10px 26px rgba(0, 0, 0, 0.35);
      }

      /* ---- 花つる本体(一過性の成長演出、常時パルスなし) ---- */
      .eph-vine-path {
        fill: none; stroke: #6cf28a; stroke-width: 3.2; stroke-linecap: round;
        filter: drop-shadow(0 0 6px rgba(108, 242, 138, 0.4));
      }
      .eph-vine-path.grow { transition: stroke-dashoffset 2.4s cubic-bezier(0.3, 0.7, 0.2, 1); }
      .eph-vine-blossom { fill: #e2a7b6; opacity: 0; transform-origin: center; transform: scale(0.3); }
      .eph-vine-blossom.bloom {
        transition: opacity 0.6s ease, transform 0.6s cubic-bezier(0.3, 1.4, 0.4, 1);
        opacity: 1; transform: scale(1);
      }
      @media (prefers-reduced-motion: reduce) {
        .eph-vine-path.grow, .eph-vine-blossom { transition: none !important; }
      }

      /* スマホ幅: 「つる」「タイムテーブル」を同時表示せず、タブで切り替える
         (ユーザー要望: 狭い画面では両方並べると窮屈になるため)。 */
      @media (max-width: 680px) {
        .eph-flash-mobile-tabs { display: flex; }
        .eph-flash-stage { flex-direction: column; }
        .eph-flash-vine-wrap, .eph-flash-timetable { display: none; width: 100%; }
        .eph-flash-stage[data-active-tab="vine"] .eph-flash-vine-wrap { display: block; }
        .eph-flash-stage[data-active-tab="timetable"] .eph-flash-timetable { display: flex; }
      }
    `;
    document.head.appendChild(style);
  }

  function setShapeSelection(shape) {
    selectedShape = shape;
    if (!epEls) return;
    epEls.shapeBtns.forEach((b) => b.classList.toggle('sel', b.dataset.shape === shape));
  }

  function resetForm() {
    editingId = null;
    epEls.dateInput.value = '';
    epEls.labelInput.value = '';
    epEls.timetablePasteInput.value = '';
    formTimetable = [{ time: '', text: '', images: [] }]; // 最初から1行出しておく(「+行を追加」を押す手間を省く)
    formTimetableFocusedIndex = 0;
    renderTimetableRows();
    setShapeSelection('mist');
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
    setShapeSelection(s.vineShape || 'mist');
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
      const shapeIcon = s.vineShape === 'wall' ? '🧱' : '🌫';
      const shapeTitle = s.vineShape === 'wall' ? '壁つる' : '霧に向かうつる';
      row.innerHTML = `
        <div class="eph-row-main">
          <span class="eph-row-date">${escapeHtml(s.date || '')}</span>
          <span class="eph-row-shape" title="${shapeTitle}">${shapeIcon}</span>
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
      if (s) { s.date = date; s.label = label; s.timetable = timetable; s.vineShape = selectedShape; delete s.images; }
    } else {
      schedules.push({
        id: crypto.randomUUID(), date, label, timetable, vineShape: selectedShape,
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
        <p class="eph-form-label">花つるの形状</p>
        <div class="eph-shape-row">
          <button class="eph-shape-btn" data-shape="mist">🌫 霧に向かうつる</button>
          <button class="eph-shape-btn" data-shape="wall">🧱 壁つる</button>
        </div>
        <div class="eph-form-actions">
          <button class="eph-cancel-btn" hidden>キャンセル</button>
          <button class="eph-save-btn">登録する</button>
        </div>
      </div>
      <p class="eph-hint">
        施行日当日、サインイン前の画面いっぱいに花つるとタイムテーブルが現れます(誤タップ防止のため、
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
      shapeBtns: Array.from(win.querySelectorAll('.eph-shape-btn')),
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
    epEls.shapeBtns.forEach((b) => b.addEventListener('click', () => setShapeSelection(b.dataset.shape)));
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
