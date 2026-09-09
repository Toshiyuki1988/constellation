// CONSTELLATION — Module: Crews
//
// 文献・記録に登場する人物の言葉を借りて、サマリーカードをその人格の声で語らせる
// モジュール。CLAUDE.mdの「モジュール」規約に従い、このファイル全体をIIFEで包んで
// トップレベルの名前をグローバルへ漏らさない。
// state / els / scheduleAutoSave() / renderAllCards() / openCamera() などの既存グローバルは
// 直接参照する(モジュールだからといって完全に独立させる必要はないため)。
//
// 起動: js/module-launcher.js(モジュール共通の起動基盤)経由。背景を2本指でダブルタップ
//       するとキーパッドHUDが開き、"456"と入力すると起動する(PCではCONSTELLATION PIEの
//       「キーパッド」項目からも同じキーパッドを開ける)。
//
// 【2026年9月、Constellation化】ペルソナの人物像を【人物情報】【その言葉】という単一2欄の
// 自由記述から、「Constellation」——プロフィール・言葉・好きな作品の3種のカードをキャンバス
// (夜空)の上に自由配置する小さな星座——へ作り替えた。きっかけは「ペルソナの解像度を上げる
// ために入力欄を大きなポップアップへ広げた」延長として、いっそCrewsの召喚元の人物自身にも
// Constellation形式を持たせよう、というユーザーの発想。展覧会だけでなく、Crewsのモデルと
// なった人物そのものを掘り下げていく行為という位置づけ。
//   - データモデル: state.crews[].constellationCards (配列、{id, type:'profile'|'words'|'photo',
//     text?, title?, x, y})。旧personInfo/theirWords(単一2欄)は初回アクセス時に
//     migrateLegacyCrews() が自動でプロフィールカード1枚・言葉カード1枚へ変換する。
//   - ロスターへの保存は、プロフィールカード1枚・言葉カード1枚が揃うまでできない
//     (空のConstellationのままなりきり生成を呼ぶ事態が構造的に起きないようにするため)。
//   - アステリズム(手動接続線)は実装しない。カードはドラッグで自由配置できるだけ
//     (重くなるので接続線は見送り、というユーザー判断)。傾き・浮遊アニメーションも
//     同様の理由(実装が軽い方を優先)で持たない。
//   - プロフィール・言葉カードはスクロールなしで全文表示し、文字量に応じてカード自体が
//     なるべく正方形に近い形へ自動リサイズされる(computeSquareWidth())。
//   - なりきり生成(personaVoiceInstruction()/summarizeSession())には、Constellation内の
//     全プロフィールカード・全言葉カードのテキストを連結して渡す。写真カードは
//     タイトル文字列だけを渡し、画像そのものは一切送らない(API使用最小化のご要望)。
//     この集約はgetCrewNarrativeParts()が行い、window経由でjs/app.jsから参照される。
//   - 起動時は画面いっぱいに広がるフルスクリーンオーバーレイ(Crewsのペルソナ管理パネル
//     よりもさらに一段大きく展開する)。効果音はカード追加時に「キン☆」
//     (playConstellationAddCardSound())、カードのドラッグ移動を始めた瞬間に「ヒュウ…」
//     (playConstellationMoveCardSound())をjs/sound.jsから鳴らす。
//
// 【設計上の重要な決定】ペルソナの「形成」(=人格になりきった実際の生成)は、登録・保存の
// 時点ではGeminiを一切呼ばない(Constellation化後も変更なし)。実際にGeminiが呼ばれるのは、
// ユーザーがサマリーカード上でそのペルソナのヘックスを押した瞬間だけ。
//
// 統合ポイント(js/app.js側):
//   - summaryCardInnerHtml() が window.crewsSummaryHexButtonsHtml() を呼び、ONのペルソナ数ぶん
//     ヘックスボタンを追加で描画する。
//   - wireSummaryCard() が各ヘックスにタップ(=生成)と長押し(=window.showCrewInfoPopup()で
//     Constellationの集約テキストをコピー可能な形で見返す)の両方を割り当てる。
//   - handleSummaryGenerate() が window.getCrewById() でmodeOrCrewIdがペルソナIDかどうかを判定し、
//     ペルソナなら summarizeSession() に window.getCrewNarrativeParts(crew) の結果を渡す。
//   - buildRoundtableParticipants() も同様に window.getCrewNarrativeParts() を使う。
//   - renderCard() が card.crewPersonaId を見て、水色グラスモーフ(.star-card--crew)と
//     ペルソナの名前・絵文字ヘッダー(.star-card-crew-head)を付ける。
//   - onSignedIn() が state.crews 読み込み直後に window.migrateLegacyCrews() を1回呼ぶ。

(function () {
  'use strict';

  // 固定の絵文字パレットから選ぶだけ(生成しない、APIを使わない)。
  const AVATAR_PALETTE = [
    '👤',
    '👩🏿', '👨🏿', '👩🏾', '👨🏾', '👩🏽', '👨🏽', '🧑🏽', '👩🏼', '👨🏼', '👩🏻', '👨🏻',
    '🧕🏾', '👳🏽',
    '🧓🏿', '👵🏽', '👴🏻',
    '🧒🏿', '👧🏽', '👦🏻',
    '🦽',
    '🌳', '🕊️', '🖋️',
  ];

  const CST_KIND_META = {
    profile: { icon: '📇', label: 'プロフィール', placeholder: '誰か・どういう人物か' },
    words: { icon: '🗨️', label: '言葉', placeholder: '本人の言葉をそのまま引用' },
    photo: { icon: '🖼️', label: '写真', placeholder: '作品タイトル' },
  };
  const CST_PHOTO_WIDTH = 150;
  const CST_TEXT_MIN_WIDTH = 140; // ヘッダー行(アイコン+ラベル+✕)が折り返さずに収まる最小幅
  const CST_TEXT_MAX_WIDTH = 280;

  let crEls = null;
  let editingId = null; // 編集中のペルソナID。null なら「新規」
  let pendingAvatar = AVATAR_PALETTE[0];
  let stylesInjected = false;
  let infoPopupEls = null;

  // Constellationオーバーレイの状態(編集中の一時ドラフト。「ロスターに保存する」を
  // 押すまではcrewオブジェクトへ反映しない)。
  let cstEls = null;
  let cstCards = [];
  let cstIdSeq = 1;
  let cstDragCard = null, cstDragOffsetX = 0, cstDragOffsetY = 0;

  /* ---------------- DOM / CSS をこのファイルだけで自己完結させて注入する ---------------- */

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .crews-overlay {
        position: fixed; inset: 0; z-index: 120;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none;
        transition: opacity 0.25s ease-out;
        padding: 16px;
      }
      .crews-overlay.open { opacity: 1; pointer-events: auto; }
      .crews-backdrop { position: absolute; inset: 0; background: rgba(6, 10, 12, 0.88); }
      .crews-panel {
        position: relative;
        width: min(92vw, 760px);
        max-height: 88vh;
        overflow-y: auto;
        background: rgba(9, 15, 18, 0.96);
        border: 1px solid rgba(85, 230, 247, 0.28);
        border-radius: 16px;
        padding: 22px 22px 26px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
        transform: scale(0.92); transition: transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .crews-overlay.open .crews-panel { transform: scale(1); }
      .crews-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
      .crews-top-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.14em;
        color: #55e6f7; text-transform: uppercase;
      }
      .crews-close-btn {
        width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(85, 230, 247, 0.3);
        color: rgba(255, 255, 255, 0.85); font-size: 14px; cursor: pointer;
      }
      .crews-close-btn:hover { background: rgba(85, 230, 247, 0.25); }

      .crews-settings-row {
        display: flex; align-items: center; gap: 8px; margin: 0 0 16px; padding: 9px 12px;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 9px;
      }
      .crews-settings-label {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; color: rgba(255, 255, 255, 0.75); flex: 1;
      }
      .crews-group-viewing-interval {
        width: 64px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; text-align: right;
        padding: 5px 7px; border-radius: 5px; border: 1px solid rgba(85, 230, 247, 0.3);
        background: rgba(255, 255, 255, 0.05); color: #fff;
      }
      .crews-settings-unit { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 255, 255, 0.5); }

      .crews-body { display: grid; grid-template-columns: 1fr 1.15fr; gap: 22px; }
      @media (max-width: 640px) { .crews-body { grid-template-columns: 1fr; } }

      .crews-col-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; letter-spacing: 0.1em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45); margin: 0 0 10px;
      }
      .crews-roster { display: flex; flex-direction: column; gap: 7px; }
      .crews-roster-empty {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11.5px; color: rgba(255, 255, 255, 0.4);
        line-height: 1.7; padding: 6px 2px;
      }
      .crews-chip {
        display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer;
        background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 9px;
      }
      .crews-chip.on { background: rgba(85, 230, 247, 0.13); border-color: rgba(85, 230, 247, 0.5); }
      .crews-chip.editing { box-shadow: 0 0 0 1px #55e6f7; }
      .crews-chip-avatar {
        width: 32px; height: 32px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        font-size: 15px; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.1);
      }
      .crews-chip.on .crews-chip-avatar { background: rgba(85, 230, 247, 0.22); border-color: rgba(85, 230, 247, 0.5); }
      .crews-chip-meta { flex: 1; min-width: 0; }
      .crews-chip-name {
        font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 11.5px; color: #fff;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .crews-chip-src {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.4); margin-top: 2px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .crews-chip-toggle {
        width: 18px; height: 18px; border-radius: 50%; flex: none; border: 1px solid rgba(255, 255, 255, 0.25);
        display: flex; align-items: center; justify-content: center; font-size: 10px; color: transparent;
      }
      .crews-chip.on .crews-chip-toggle { background: #55e6f7; border-color: #55e6f7; color: #06282c; }
      .crews-add {
        margin-top: 4px; padding: 9px 12px; border: 1px dashed rgba(255, 255, 255, 0.18); border-radius: 10px;
        font-family: 'IBM Plex Mono', monospace; font-size: 10.5px; color: rgba(255, 255, 255, 0.45);
        text-align: center; cursor: pointer;
      }
      .crews-add:hover { color: #55e6f7; border-color: rgba(85, 230, 247, 0.4); }

      .crews-editor {
        background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px; padding: 15px 15px 17px;
      }
      .crews-field { margin-bottom: 13px; }
      .crews-field-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .crews-field-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
      }
      .crews-ocr-btn {
        width: 24px; height: 24px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(85, 230, 247, 0.12); border: 1px solid rgba(85, 230, 247, 0.35); color: #55e6f7; cursor: pointer;
        font-size: 12px;
      }
      .crews-ocr-btn:hover { background: rgba(85, 230, 247, 0.25); }
      .crews-ocr-btn:disabled { opacity: 0.5; cursor: default; }
      .crews-field-input {
        width: 100%; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 6px;
        padding: 8px 10px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12.5px; color: #fff;
        line-height: 1.6;
      }
      .crews-field-input::placeholder { color: rgba(255, 255, 255, 0.3); }
      .crews-field-hint { font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.35); margin: 5px 0 0; line-height: 1.6; }

      .crews-avatar-grid { display: flex; gap: 6px; flex-wrap: wrap; }
      .crews-avatar-opt {
        width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-size: 14px; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer;
      }
      .crews-avatar-opt.sel { background: rgba(85, 230, 247, 0.22); border-color: #55e6f7; }

      .crews-open-constellation-btn {
        display: flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 14px; border-radius: 8px; border: none;
        background: #55e6f7; color: #06282c; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 12.5px;
        cursor: pointer; width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .crews-open-constellation-btn:hover { background: #83eefb; }
      .crews-open-constellation-btn .star { font-size: 15px; }

      .crews-actions { display: flex; gap: 8px; margin-top: 4px; }
      .crews-delete-btn {
        padding: 10px 14px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.18); background: transparent;
        color: rgba(255, 255, 255, 0.6); font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer; width: 100%;
      }
      .crews-delete-btn:hover { border-color: #b3402b; color: #ff8a70; }

      .crews-rationale {
        margin-top: 16px; padding: 11px 13px; border-radius: 9px;
        background: rgba(85, 230, 247, 0.08); border: 1px solid rgba(85, 230, 247, 0.22);
        font-family: 'IBM Plex Mono', monospace; font-size: 9.5px; line-height: 1.8; color: rgba(255, 255, 255, 0.55);
      }

      /* サマリーカードのペルソナのヘックスを長押しすると出る、Constellation集約の閲覧/コピー用ポップアップ */
      .crews-info-overlay {
        position: fixed; inset: 0; z-index: 130;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; pointer-events: none; transition: opacity 0.18s ease-out; padding: 16px;
      }
      .crews-info-overlay.open { opacity: 1; pointer-events: auto; }
      .crews-info-backdrop { position: absolute; inset: 0; background: rgba(6, 10, 12, 0.72); }
      .crews-info-modal {
        position: relative; width: min(92vw, 420px); max-height: 82vh; overflow-y: auto;
        background: rgba(9, 15, 18, 0.97); border: 1px solid rgba(85, 230, 247, 0.3); border-radius: 14px;
        padding: 18px 18px 20px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
        transform: scale(0.94); transition: transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2);
      }
      .crews-info-overlay.open .crews-info-modal { transform: scale(1); }
      .crews-info-head { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }
      .crews-info-avatar {
        width: 30px; height: 30px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        font-size: 15px; background: rgba(85, 230, 247, 0.14); border: 1px solid rgba(85, 230, 247, 0.4);
      }
      .crews-info-name {
        flex: 1; font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 13px; color: #fff;
      }
      .crews-info-close {
        width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(85, 230, 247, 0.3); color: rgba(255, 255, 255, 0.85);
        font-size: 12px; cursor: pointer;
      }
      .crews-info-close:hover { background: rgba(85, 230, 247, 0.25); }
      .crews-info-field { margin-bottom: 14px; }
      .crews-info-field:last-child { margin-bottom: 0; }
      .crews-info-label-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
      .crews-info-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
        color: rgba(255, 255, 255, 0.45);
      }
      .crews-info-copy {
        padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(85, 230, 247, 0.35);
        background: rgba(85, 230, 247, 0.1); color: #55e6f7; font-family: 'IBM Plex Mono', monospace; font-size: 9.5px;
        cursor: pointer;
      }
      .crews-info-copy:hover { background: rgba(85, 230, 247, 0.22); }
      .crews-info-text {
        margin: 0; padding: 9px 10px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 7px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 12px; line-height: 1.7;
        color: rgba(255, 255, 255, 0.88); white-space: pre-wrap; word-break: break-word;
      }

      /* ---------------- Constellation(フルスクリーンオーバーレイ、2026年9月追加) ---------------- */
      .cst-overlay {
        position: fixed; inset: 0; z-index: 150;
        display: flex; flex-direction: column;
        background: #05080a;
        opacity: 0; pointer-events: none;
        transform: scale(0.98);
        transition: opacity 0.22s ease-out, transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.1);
      }
      .cst-overlay.open { opacity: 1; pointer-events: auto; }
      .cst-topbar {
        display: flex; align-items: center; gap: 10px; padding: 12px 16px; flex: none;
        background: #0a1114; border-bottom: 1px solid rgba(85, 230, 247, 0.22);
      }
      .cst-topbar-avatar {
        width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
        font-size: 15px; background: rgba(85, 230, 247, 0.16); border: 1px solid rgba(85, 230, 247, 0.4); flex: none;
      }
      .cst-name-input {
        flex: 1; background: transparent; border: none; outline: none; color: #fff;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 14px; min-width: 0;
      }
      .cst-name-input::placeholder { color: rgba(255, 255, 255, 0.35); }
      .cst-topbar-label {
        font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(85, 230, 247, 0.75);
      }
      .cst-close {
        width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
        background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(85, 230, 247, 0.3); color: rgba(255, 255, 255, 0.85);
        font-size: 12px; cursor: pointer;
      }
      .cst-close:hover { background: rgba(85, 230, 247, 0.25); }

      .cst-stage {
        position: relative; flex: 1; min-height: 0; overflow: hidden;
        background:
          radial-gradient(ellipse at 30% 20%, rgba(85, 230, 247, 0.10), transparent 55%),
          radial-gradient(ellipse at 80% 80%, rgba(85, 230, 247, 0.06), transparent 50%),
          #05080a;
      }
      .cst-starfield { position: absolute; inset: 0; opacity: 0.9; pointer-events: none; }
      .cst-board { position: relative; z-index: 1; width: 100%; height: 100%; }

      .cst-card {
        position: absolute;
        border-radius: 10px; padding: 9px 10px 10px;
        background: rgba(12, 20, 24, 0.92); border: 1px solid rgba(85, 230, 247, 0.3);
        box-shadow: 0 10px 26px rgba(0, 0, 0, 0.4);
        color: #fff; user-select: none;
      }
      .cst-card.profile { border-color: rgba(85, 230, 247, 0.5); }
      .cst-card.words { border-color: rgba(255, 255, 255, 0.28); }
      .cst-card.photo { border-color: rgba(255, 209, 102, 0.4); }
      .cst-card-head { display: flex; align-items: center; gap: 5px; margin-bottom: 6px; cursor: grab; }
      .cst-card-head:active { cursor: grabbing; }
      .cst-card-icon { font-size: 12px; flex: none; }
      .cst-card-kind {
        font-family: 'IBM Plex Mono', monospace; font-size: 8px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5);
        flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
      }
      .cst-card-ocr-btn {
        width: 16px; height: 16px; border-radius: 50%; flex: none; border: none;
        background: rgba(85, 230, 247, 0.15); color: #55e6f7; font-size: 8px; cursor: pointer; padding: 0;
        display: flex; align-items: center; justify-content: center;
      }
      .cst-card-ocr-btn:hover { background: rgba(85, 230, 247, 0.3); }
      .cst-card-ocr-btn:disabled { opacity: 0.5; cursor: default; }
      .cst-card-del {
        width: 15px; height: 15px; border-radius: 50%; border: none; background: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.6);
        font-size: 9px; cursor: pointer; flex: none; line-height: 15px; padding: 0;
      }
      .cst-card-del:hover { background: rgba(179, 64, 43, 0.5); color: #fff; }
      .cst-card-text {
        display: block; width: 100%; min-height: 44px; resize: none; overflow: hidden;
        background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 5px; padding: 5px 6px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 10px; line-height: 1.55; color: #fff;
      }
      .cst-card-text::placeholder { color: rgba(255, 255, 255, 0.32); }
      .cst-card.words .cst-card-text { font-style: italic; }
      .cst-card-photo-box {
        width: 100%; height: 64px; border-radius: 6px; background: rgba(255, 255, 255, 0.05); border: 1px dashed rgba(255, 255, 255, 0.18);
        display: flex; align-items: center; justify-content: center; font-size: 20px; color: rgba(255, 255, 255, 0.35); margin-bottom: 5px;
      }
      .cst-card-title-input {
        width: 100%; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 5px;
        padding: 5px 6px; font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 10px; color: #fff;
      }

      .cst-toolbar {
        display: flex; align-items: center; gap: 8px; padding: 11px 16px; flex-wrap: wrap; flex: none;
        background: #0a1114; border-top: 1px solid rgba(85, 230, 247, 0.18);
      }
      .cst-add-btn {
        display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 999px;
        background: rgba(85, 230, 247, 0.1); border: 1px solid rgba(85, 230, 247, 0.35); color: #55e6f7;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-size: 11px; font-weight: 700; cursor: pointer;
      }
      .cst-add-btn:hover { background: rgba(85, 230, 247, 0.22); }
      .cst-toolbar-hint {
        margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 9px; color: rgba(255, 255, 255, 0.4); text-align: right;
      }
      .cst-req-row {
        display: flex; align-items: center; gap: 10px; padding: 9px 16px; flex-wrap: wrap; flex: none;
        background: #0a1114; border-top: 1px solid rgba(85, 230, 247, 0.12);
      }
      .cst-save-btn {
        padding: 8px 16px; border-radius: 8px; border: none; background: #55e6f7; color: #06282c;
        font-family: 'Zen Kaku Gothic New', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer;
      }
      .cst-save-btn:hover { background: #83eefb; }
      .cst-save-btn:disabled { background: rgba(255, 255, 255, 0.1); color: rgba(255, 255, 255, 0.35); cursor: not-allowed; }
      .cst-req-msg { font-family: 'IBM Plex Mono', monospace; font-size: 10px; color: rgba(255, 138, 112, 0.9); }
      .cst-req-msg.ok { color: rgba(140, 255, 180, 0.85); }
    `;
    document.head.appendChild(style);
  }

  function buildDom() {
    const overlay = document.createElement('div');
    overlay.className = 'crews-overlay';
    overlay.innerHTML = `
      <div class="crews-backdrop"></div>
      <div class="crews-panel">
        <div class="crews-top">
          <span class="crews-top-label">Crews — ペルソナ管理</span>
          <button class="crews-close-btn" title="閉じる">✕</button>
        </div>
        <div class="crews-settings-row">
          <label class="crews-settings-label" for="crews-group-viewing-interval">グループビューイングの間隔</label>
          <input type="number" id="crews-group-viewing-interval" class="crews-group-viewing-interval" min="10" step="5" value="60">
          <span class="crews-settings-unit">秒</span>
        </div>
        <div class="crews-body">
          <div>
            <p class="crews-col-label">登録済み — ONのペルソナがサマリーの話し手候補になる</p>
            <div class="crews-roster"></div>
          </div>
          <div class="crews-editor">
            <p class="crews-col-label crews-editor-title">召喚フォーム — 新規</p>
            <div class="crews-field">
              <div class="crews-field-label-row"><span class="crews-field-label">名前</span></div>
              <input type="text" class="crews-field-input crews-name-input" placeholder="例: つぼみの番人">
            </div>
            <div class="crews-field">
              <div class="crews-field-label-row"><span class="crews-field-label">似顔絵(任意・APIは使わない)</span></div>
              <div class="crews-avatar-grid"></div>
            </div>
            <div class="crews-field">
              <div class="crews-field-label-row"><span class="crews-field-label">Constellation</span></div>
              <button class="crews-open-constellation-btn" type="button">
                <span class="star">⭐</span>Constellationをひらく(<span class="crews-cst-badge">0</span>枚)
              </button>
              <p class="crews-field-hint">プロフィール・言葉のカードを1枚ずつ以上置くと、ロスターに保存できるようになります。</p>
            </div>
            <div class="crews-actions">
              <button class="crews-delete-btn" hidden>削除</button>
            </div>
          </div>
        </div>
        <p class="crews-rationale">Constellationの編集・保存時にGeminiは呼びません。実際にこの人格になりきって語らせるのは、サマリーカード上でこのペルソナのヘックスを押した瞬間だけです(Education/Academicと同じ1回のAPI呼び出し)。長押しすると、Constellationの内容をいつでも見返せます(コピーも可能)。</p>
      </div>
    `;
    document.body.appendChild(overlay);

    crEls = {
      overlay,
      panel: overlay.querySelector('.crews-panel'),
      roster: overlay.querySelector('.crews-roster'),
      editorTitle: overlay.querySelector('.crews-editor-title'),
      nameInput: overlay.querySelector('.crews-name-input'),
      avatarGrid: overlay.querySelector('.crews-avatar-grid'),
      openConstellationBtn: overlay.querySelector('.crews-open-constellation-btn'),
      cstBadge: overlay.querySelector('.crews-cst-badge'),
      deleteBtn: overlay.querySelector('.crews-delete-btn'),
      groupViewingInterval: overlay.querySelector('.crews-group-viewing-interval'),
    };

    crEls.nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());

    // グループビューイングモード(js/app.js)のコメント間隔。実行中に変更した場合は
    // 即座に新しい間隔でタイマーを張り直す(止まっていれば次回起動時に反映されるだけ)。
    crEls.groupViewingInterval.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.groupViewingInterval.addEventListener('change', () => {
      const sec = Math.max(10, parseInt(crEls.groupViewingInterval.value, 10) || 60);
      crEls.groupViewingInterval.value = sec;
      state.groupViewingIntervalSec = sec;
      scheduleAutoSave();
      applyGroupViewingIntervalChange();
    });

    crEls.overlay.querySelector('.crews-close-btn').addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.overlay.querySelector('.crews-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeCrews();
    });
    crEls.overlay.querySelector('.crews-backdrop').addEventListener('click', closeCrews);

    crEls.openConstellationBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.openConstellationBtn.addEventListener('click', (e) => { e.stopPropagation(); openConstellation(); });

    crEls.deleteBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    crEls.deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deletePersona(); });

    // スワイプで閉じる(モジュール共通デザイン言語)。パネル内部からのスワイプはテキスト選択・
    // スクロール操作と紛れるため、背景(バックドロップ)から始まった場合だけ判定する。
    let swipeStartX = null;
    let swipeStartY = null;
    let swipeStartT = 0;
    overlay.querySelector('.crews-backdrop').addEventListener('pointerdown', (e) => {
      swipeStartX = e.clientX;
      swipeStartY = e.clientY;
      swipeStartT = performance.now();
    });
    overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX;
      const dy = e.clientY - swipeStartY;
      const dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeCrews();
    });
  }

  /* ---------------- データアクセス(app.js側から window 経由で参照される) ---------------- */

  function getEnabledCrews() {
    return (state.crews || []).filter((c) => c.enabled);
  }

  function getCrewById(id) {
    return (state.crews || []).find((c) => c.id === id) || null;
  }

  /**
   * 旧【人物情報】【その言葉】(単一2欄)形式のペルソナを、Constellation形式
   * (constellationCards配列)へ一度きりで変換する。personInfoがあればプロフィールカード1枚、
   * theirWordsがあれば言葉カード1枚として持たせ、旧プロパティは削除する。
   * js/app.jsのonSignedIn()がstate.crews読み込み直後に window.migrateLegacyCrews() を1回呼ぶ。
   */
  function migrateLegacyCrews() {
    (state.crews || []).forEach((crew) => {
      if (Array.isArray(crew.constellationCards)) return; // 既に新形式
      const cards = [];
      if (crew.personInfo && crew.personInfo.trim()) {
        cards.push({ id: crypto.randomUUID(), type: 'profile', text: crew.personInfo.trim(), x: 30, y: 30 });
      }
      if (crew.theirWords && crew.theirWords.trim()) {
        cards.push({ id: crypto.randomUUID(), type: 'words', text: crew.theirWords.trim(), x: 220, y: 60 });
      }
      crew.constellationCards = cards;
      delete crew.personInfo;
      delete crew.theirWords;
    });
  }

  /**
   * Constellation内の全プロフィールカード・全言葉カードのテキストを連結し、なりきり生成用の
   * {personInfo, theirWords, photoTitles}を組み立てる(js/app.jsのpersonaVoiceInstruction()、
   * js/gemini.jsのsummarizeSession()から参照される)。写真カードはタイトル文字列のみを渡す
   * (画像は一切送らない、API使用最小化のご要望)。
   */
  function getCrewNarrativeParts(crew) {
    const cards = crew.constellationCards || [];
    const profileTexts = cards.filter((c) => c.type === 'profile' && c.text && c.text.trim()).map((c) => c.text.trim());
    const wordsTexts = cards.filter((c) => c.type === 'words' && c.text && c.text.trim()).map((c) => c.text.trim());
    const photoTitles = cards.filter((c) => c.type === 'photo' && c.title && c.title.trim()).map((c) => c.title.trim());
    return {
      personInfo: profileTexts.join('\n\n'),
      theirWords: wordsTexts.join('\n\n'),
      photoTitles,
    };
  }

  /**
   * サマリーカードのヘックス行に追加するHTML(js/app.js の summaryCardInnerHtml() から呼ばれる)。
   */
  function crewsSummaryHexButtonsHtml() {
    return getEnabledCrews()
      .map((c) => {
        const narrative = getCrewNarrativeParts(c);
        return (
          `<button class="star-card-summary-crew-btn" data-crew-id="${c.id}" title="${escapeAttr(narrative.personInfo)}">` +
          `<span class="emoji">${escapeHtmlLocal(c.avatar || '👤')}</span>` +
          `<span class="name">${escapeHtmlLocal(c.name || '(無名)')}</span></button>`
        );
      })
      .join('');
  }

  function escapeHtmlLocal(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }
  function escapeAttr(str) {
    return escapeHtmlLocal(str).replace(/"/g, '&quot;');
  }

  /* ---------------- ロスター / 編集フォーム ---------------- */

  function renderRoster() {
    const list = crEls.roster;
    list.innerHTML = '';
    const crews = state.crews || [];
    if (!crews.length) {
      const empty = document.createElement('p');
      empty.className = 'crews-roster-empty';
      empty.textContent = 'まだペルソナがいません。右のフォームから召喚してください。';
      list.appendChild(empty);
    }
    crews.forEach((crew) => {
      const narrative = getCrewNarrativeParts(crew);
      const chip = document.createElement('div');
      chip.className = 'crews-chip' + (crew.enabled ? ' on' : '') + (crew.id === editingId ? ' editing' : '');
      chip.innerHTML = `
        <div class="crews-chip-avatar">${escapeHtmlLocal(crew.avatar || '👤')}</div>
        <div class="crews-chip-meta">
          <div class="crews-chip-name">${escapeHtmlLocal(crew.name || '(無名)')}</div>
          <div class="crews-chip-src">${escapeHtmlLocal(narrative.personInfo.slice(0, 28))}</div>
        </div>
        <div class="crews-chip-toggle">${crew.enabled ? '✓' : ''}</div>
      `;
      const toggleEl = chip.querySelector('.crews-chip-toggle');
      toggleEl.addEventListener('click', (e) => {
        e.stopPropagation();
        crew.enabled = !crew.enabled;
        scheduleAutoSave();
        renderRoster();
        renderAllCards();
      });
      chip.addEventListener('click', () => loadPersonaIntoEditor(crew.id));
      list.appendChild(chip);
    });
    const addBtn = document.createElement('div');
    addBtn.className = 'crews-add';
    addBtn.textContent = '+ 新しいペルソナを召喚';
    addBtn.addEventListener('click', startNewPersona);
    list.appendChild(addBtn);
  }

  function renderAvatarGrid() {
    crEls.avatarGrid.innerHTML = AVATAR_PALETTE
      .map((em) => `<div class="crews-avatar-opt${em === pendingAvatar ? ' sel' : ''}" data-em="${escapeAttr(em)}">${em}</div>`)
      .join('');
    crEls.avatarGrid.querySelectorAll('.crews-avatar-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        pendingAvatar = opt.dataset.em;
        renderAvatarGrid();
      });
    });
  }

  function startNewPersona() {
    editingId = null;
    pendingAvatar = AVATAR_PALETTE[0];
    crEls.editorTitle.textContent = '召喚フォーム — 新規';
    crEls.nameInput.value = '';
    crEls.deleteBtn.hidden = true;
    crEls.cstBadge.textContent = '0';
    renderAvatarGrid();
    renderRoster();
  }

  function loadPersonaIntoEditor(id) {
    const crew = getCrewById(id);
    if (!crew) return;
    editingId = id;
    pendingAvatar = crew.avatar || AVATAR_PALETTE[0];
    crEls.editorTitle.textContent = `召喚フォーム — 編集中「${crew.name || '(無名)'}」`;
    crEls.nameInput.value = crew.name || '';
    crEls.deleteBtn.hidden = false;
    crEls.cstBadge.textContent = String((crew.constellationCards || []).length);
    renderAvatarGrid();
    renderRoster();
  }

  async function deletePersona() {
    if (!editingId) return;
    const crew = getCrewById(editingId);
    if (!crew) return;
    const choice = await showChoiceDialog({
      title: `「${crew.name || '(無名)'}」を削除しますか?`,
      message: 'このペルソナが既に生成したカードは残ります。',
      options: [
        { label: 'このまま残す', value: 'keep', secondary: true },
        { label: '削除する', value: 'delete', danger: true },
      ],
    });
    if (choice !== 'delete') return;
    state.crews = (state.crews || []).filter((c) => c.id !== editingId);
    scheduleAutoSave();
    startNewPersona();
    renderAllCards();
    setStatus('ペルソナを削除しました');
  }

  /* ---------------- OCR(カメラでキャプション読み取る、js/camera.js を流用) ---------------- */
  async function ocrIntoTextarea(textareaEl, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      const result = await openCamera('caption');
      if (!result || result.kind !== 'text' || !result.text.trim()) return;
      // js/camera.jsのOCRはバックグラウンド実行のため、結果が届く頃にはこのパネル自体が
      // 既に閉じられ、textareaがDOMから外れている可能性がある。その場合は読み取った文字を
      // 失わないよう新規テクストカードとして残す。
      if (!textareaEl.isConnected) {
        createTextCard(result.text.trim());
        setStatus('Constellationのパネルが閉じられていたため、読み取った文字は新しいテクストカードに残しました');
        return;
      }
      const existing = textareaEl.value.trim();
      textareaEl.value = existing ? `${existing}\n${result.text.trim()}` : result.text.trim();
      textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      if (btnEl) btnEl.disabled = false;
    }
  }

  /* ---------------- 開閉(ペルソナ管理パネル) ---------------- */

  function openCrews() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!crEls) buildDom();
    crEls.groupViewingInterval.value = state.groupViewingIntervalSec || 60;
    renderRoster();
    if (editingId && getCrewById(editingId)) {
      loadPersonaIntoEditor(editingId);
    } else {
      startNewPersona();
    }
    crEls.overlay.classList.add('open');
  }

  function closeCrews() {
    if (crEls) crEls.overlay.classList.remove('open');
  }

  /* ==================================================================================
     Constellation(フルスクリーンオーバーレイ、2026年9月追加)
     ================================================================================== */

  function buildConstellationDom() {
    const overlay = document.createElement('div');
    overlay.className = 'cst-overlay';
    overlay.innerHTML = `
      <div class="cst-topbar">
        <div class="cst-topbar-avatar"></div>
        <input class="cst-name-input" placeholder="名前(例: つぼみの番人)">
        <span class="cst-topbar-label">Constellation</span>
        <button class="cst-close" title="閉じる">✕</button>
      </div>
      <div class="cst-stage">
        <canvas class="cst-starfield"></canvas>
        <div class="cst-board"></div>
      </div>
      <div class="cst-toolbar">
        <button class="cst-add-btn" data-add="profile">📇 + プロフィール</button>
        <button class="cst-add-btn" data-add="words">🗨️ + 言葉</button>
        <button class="cst-add-btn" data-add="photo">🖼️ + 写真</button>
        <span class="cst-toolbar-hint"></span>
      </div>
      <div class="cst-req-row">
        <button class="cst-save-btn">ロスターに保存する</button>
        <span class="cst-req-msg"></span>
      </div>
    `;
    document.body.appendChild(overlay);

    cstEls = {
      overlay,
      topbarAvatar: overlay.querySelector('.cst-topbar-avatar'),
      nameInput: overlay.querySelector('.cst-name-input'),
      closeBtn: overlay.querySelector('.cst-close'),
      stage: overlay.querySelector('.cst-stage'),
      stars: overlay.querySelector('.cst-starfield'),
      board: overlay.querySelector('.cst-board'),
      countEl: overlay.querySelector('.cst-toolbar-hint'),
      saveBtn: overlay.querySelector('.cst-save-btn'),
      reqMsg: overlay.querySelector('.cst-req-msg'),
    };

    cstEls.nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    cstEls.nameInput.addEventListener('input', () => {
      crEls.nameInput.value = cstEls.nameInput.value; // 召喚フォーム側と一方向同期
    });

    cstEls.closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    cstEls.closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeConstellation(); });

    overlay.querySelectorAll('.cst-add-btn').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        addConstellationCard(btn.dataset.add);
      });
    });

    cstEls.saveBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    cstEls.saveBtn.addEventListener('click', (e) => { e.stopPropagation(); commitConstellationSave(); });

    // スワイプで閉じる(モジュール共通デザイン言語)。トップバーの掴みバー部分から。
    let swipeStartX = null, swipeStartY = null, swipeStartT = 0;
    cstEls.overlay.querySelector('.cst-topbar').addEventListener('pointerdown', (e) => {
      if (e.target === cstEls.nameInput) return;
      swipeStartX = e.clientX; swipeStartY = e.clientY; swipeStartT = performance.now();
    });
    cstEls.overlay.addEventListener('pointerup', (e) => {
      if (swipeStartX === null) return;
      const dx = e.clientX - swipeStartX, dy = e.clientY - swipeStartY, dt = performance.now() - swipeStartT;
      swipeStartX = null;
      if (Math.abs(dx) > 90 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 500) closeConstellation();
    });

    window.addEventListener('resize', () => { if (cstEls.overlay.classList.contains('open')) drawConstellationStars(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && cstEls.overlay.classList.contains('open')) closeConstellation();
    });
  }

  function openConstellation() {
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!cstEls) buildConstellationDom();
    const crew = editingId ? getCrewById(editingId) : null;
    cstCards = crew ? (crew.constellationCards || []).map((c) => ({ ...c })) : cstCards;
    cstIdSeq = 1;
    cstEls.nameInput.value = crEls.nameInput.value || '';
    cstEls.topbarAvatar.textContent = pendingAvatar;
    renderConstellationBoard();
    cstEls.overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(drawConstellationStars);
  }

  function closeConstellation() {
    if (cstEls) cstEls.overlay.classList.remove('open');
    document.body.style.overflow = '';
  }

  /** 指定した幅でtextareaを折り返した時のカード全体の高さを概算する(正方形化のための下見積もり)。 */
  function estimateCstCardHeightForWidth(text, width) {
    const innerWidth = width - 20 /* カードpadding */ - 12 /* textarea左右padding */;
    const avgCharPx = 7.4; // フォントサイズ10px、日本語/半角混在を想定した経験的な平均文字幅
    const charsPerLine = Math.max(3, Math.floor(innerWidth / avgCharPx));
    const lineHeight = 15.5; // font-size 10px * line-height 1.55
    let totalLines = 0;
    (text || '').split('\n').forEach((line) => {
      totalLines += Math.max(1, Math.ceil((line.length || 1) / charsPerLine));
    });
    const headRowHeight = 24;
    const cardPaddingV = 19;
    const textareaPaddingV = 10;
    return headRowHeight + cardPaddingV + textareaPaddingV + totalLines * lineHeight;
  }

  /** 「幅 ≈ 高さ」になる幅を二分探索で求める(なるべく正方形に近いカードにする)。 */
  function computeCstSquareWidth(text) {
    let lo = CST_TEXT_MIN_WIDTH, hi = CST_TEXT_MAX_WIDTH;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const h = estimateCstCardHeightForWidth(text, mid);
      if (h > mid) lo = mid; else hi = mid;
    }
    return Math.round((lo + hi) / 2);
  }

  /** textareaをスクロール無し・全文表示にするauto-grow。 */
  function autoGrowCstTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function cstCardHtml(card) {
    const meta = CST_KIND_META[card.type];
    let width = CST_PHOTO_WIDTH;
    let body = '';
    let ocrBtnHtml = '';
    if (card.type === 'photo') {
      body = `
        <div class="cst-card-photo-box">🖼️</div>
        <input class="cst-card-title-input" value="${escapeAttr(card.title || '')}" placeholder="作品タイトル">
      `;
    } else {
      width = computeCstSquareWidth(card.text || '');
      body = `<textarea class="cst-card-text" placeholder="${escapeAttr(meta.placeholder)}">${escapeHtmlLocal(card.text || '')}</textarea>`;
      ocrBtnHtml = `<button class="cst-card-ocr-btn" data-ocr="${card.id}" title="カメラでOCR読み取り">📷</button>`;
    }
    return `
      <div class="cst-card ${card.type}" id="cst-card-${card.id}" style="left:${card.x}px; top:${card.y}px; width:${width}px;">
        <div class="cst-card-head" data-drag="${card.id}">
          <span class="cst-card-icon">${meta.icon}</span>
          <span class="cst-card-kind">${meta.label}</span>
          ${ocrBtnHtml}
          <button class="cst-card-del" data-del="${card.id}">✕</button>
        </div>
        ${body}
      </div>
    `;
  }

  function updateConstellationRequirement() {
    const profileCount = cstCards.filter((c) => c.type === 'profile').length;
    const wordsCount = cstCards.filter((c) => c.type === 'words').length;
    const photoCount = cstCards.length - profileCount - wordsCount;
    cstEls.countEl.textContent = `${cstCards.length}枚のカード(プロフィール${profileCount}・言葉${wordsCount}・写真${photoCount})`;
    const ok = profileCount >= 1 && wordsCount >= 1;
    cstEls.saveBtn.disabled = !ok;
    cstEls.reqMsg.classList.toggle('ok', ok);
    cstEls.reqMsg.textContent = ok
      ? '保存できます'
      : `保存にはプロフィール1枚・言葉1枚が必要です(現在 プロフィール${profileCount}・言葉${wordsCount})`;
    if (crEls && crEls.cstBadge) crEls.cstBadge.textContent = String(cstCards.length);
  }

  function renderConstellationBoard() {
    cstEls.board.innerHTML = cstCards.map(cstCardHtml).join('');

    cstEls.board.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        cstCards = cstCards.filter((c) => c.id !== btn.dataset.del);
        renderConstellationBoard();
      });
    });
    cstEls.board.querySelectorAll('[data-drag]').forEach((head) => {
      head.addEventListener('pointerdown', onCstCardDragStart);
    });
    cstEls.board.querySelectorAll('[data-ocr]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const card = cstCards.find((c) => c.id === btn.dataset.ocr);
        if (!card) return;
        const ta = btn.closest('.cst-card').querySelector('.cst-card-text');
        await ocrIntoTextarea(ta, btn);
      });
    });
    cstEls.board.querySelectorAll('.cst-card-text').forEach((ta) => {
      ta.addEventListener('pointerdown', (e) => e.stopPropagation());
      ta.addEventListener('input', () => {
        const cardEl = ta.closest('.cst-card');
        const card = cstCards.find((c) => 'cst-card-' + c.id === cardEl.id);
        if (card) {
          card.text = ta.value;
          cardEl.style.width = computeCstSquareWidth(card.text) + 'px';
        }
        autoGrowCstTextarea(ta);
      });
      autoGrowCstTextarea(ta); // 初期表示時にも一度、全文が見えるよう高さを合わせる
    });
    cstEls.board.querySelectorAll('.cst-card-title-input').forEach((input) => {
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('input', () => {
        const card = cstCards.find((c) => 'cst-card-' + c.id === input.closest('.cst-card').id);
        if (card) card.title = input.value;
      });
    });

    updateConstellationRequirement();
    requestAnimationFrame(drawConstellationStars);
  }

  function onCstCardDragStart(e) {
    e.preventDefault();
    const id = e.currentTarget.dataset.drag;
    cstDragCard = cstCards.find((c) => c.id === id);
    if (!cstDragCard) return;
    const stageRect = cstEls.stage.getBoundingClientRect();
    cstDragOffsetX = e.clientX - stageRect.left - cstDragCard.x;
    cstDragOffsetY = e.clientY - stageRect.top - cstDragCard.y;
    playConstellationMoveCardSound();
    window.addEventListener('pointermove', onCstCardDragMove);
    window.addEventListener('pointerup', onCstCardDragEnd);
  }
  function onCstCardDragMove(e) {
    if (!cstDragCard) return;
    const stageRect = cstEls.stage.getBoundingClientRect();
    const el = document.getElementById('cst-card-' + cstDragCard.id);
    const w = el ? el.offsetWidth : 150;
    const h = el ? el.offsetHeight : 80;
    cstDragCard.x = Math.max(0, Math.min(stageRect.width - w, e.clientX - stageRect.left - cstDragOffsetX));
    cstDragCard.y = Math.max(0, Math.min(stageRect.height - h, e.clientY - stageRect.top - cstDragOffsetY));
    if (el) { el.style.left = cstDragCard.x + 'px'; el.style.top = cstDragCard.y + 'px'; }
  }
  function onCstCardDragEnd() {
    cstDragCard = null;
    window.removeEventListener('pointermove', onCstCardDragMove);
    window.removeEventListener('pointerup', onCstCardDragEnd);
  }

  function addConstellationCard(type) {
    const id = 'n' + (cstIdSeq++);
    const stageRect = cstEls.stage.getBoundingClientRect();
    const x = 30 + Math.random() * Math.max(40, stageRect.width - 220);
    const y = 30 + Math.random() * Math.max(40, stageRect.height - 160);
    cstCards.push(type === 'photo' ? { id, type, x, y, title: '' } : { id, type, x, y, text: '' });
    playConstellationAddCardSound();
    renderConstellationBoard();
  }

  function commitConstellationSave() {
    const profileCount = cstCards.filter((c) => c.type === 'profile').length;
    const wordsCount = cstCards.filter((c) => c.type === 'words').length;
    if (profileCount < 1 || wordsCount < 1) return; // 保存ボタンはdisabledのはずだが念のため
    const name = cstEls.nameInput.value.trim() || '(無名)';
    if (!state.crews) state.crews = [];
    let crew = editingId ? getCrewById(editingId) : null;
    if (crew) {
      crew.name = name;
      crew.avatar = pendingAvatar;
      crew.constellationCards = cstCards.map((c) => ({ ...c }));
    } else {
      crew = {
        id: crypto.randomUUID(),
        name,
        avatar: pendingAvatar,
        constellationCards: cstCards.map((c) => ({ ...c })),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      state.crews.push(crew);
      editingId = crew.id;
    }
    scheduleAutoSave();
    closeConstellation();
    loadPersonaIntoEditor(crew.id);
    renderAllCards(); // サマリーカードのヘックス行へ即座に反映する
    setStatus(`ペルソナ「${crew.name}」を保存しました`);
  }

  function drawConstellationStars() {
    if (!cstEls) return;
    const stage = cstEls.stage;
    const canvas = cstEls.stars;
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    let seed = 42;
    function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    const count = Math.round((w * h) / 2600);
    for (let i = 0; i < count; i++) {
      const x = rnd() * w, y = rnd() * h, r = rnd() * 1.2 + 0.3;
      ctx.globalAlpha = rnd() * 0.6 + 0.25;
      ctx.fillStyle = '#bff6ff';
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------- 情報ポップアップ(サマリーカードのヘックスを長押しすると開く) ----------------
   * ニックネーム(表示名)だけでは元のConstellationの内容を思い出せない、というユーザー要望を
   * 受けて追加。プロフィール・言葉の集約テキストを表示し、それぞれコピーボタンを付ける。
   * 生成(=summarizeSession()の呼び出し)は一切行わない、完全にローカルな閲覧機能。 */

  function buildInfoPopupDom() {
    const overlay = document.createElement('div');
    overlay.className = 'crews-info-overlay';
    overlay.innerHTML = `
      <div class="crews-info-backdrop"></div>
      <div class="crews-info-modal">
        <div class="crews-info-head">
          <span class="crews-info-avatar"></span>
          <span class="crews-info-name"></span>
          <button class="crews-info-close" title="閉じる">✕</button>
        </div>
        <div class="crews-info-field">
          <div class="crews-info-label-row">
            <span class="crews-info-label">【プロフィール】</span>
            <button class="crews-info-copy" data-target="person">コピー</button>
          </div>
          <p class="crews-info-text crews-info-text-person"></p>
        </div>
        <div class="crews-info-field">
          <div class="crews-info-label-row">
            <span class="crews-info-label">【言葉】</span>
            <button class="crews-info-copy" data-target="words">コピー</button>
          </div>
          <p class="crews-info-text crews-info-text-words"></p>
        </div>
        <div class="crews-info-field">
          <div class="crews-info-label-row">
            <span class="crews-info-label">【好きな作品】</span>
          </div>
          <p class="crews-info-text crews-info-text-photos"></p>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    infoPopupEls = {
      overlay,
      avatar: overlay.querySelector('.crews-info-avatar'),
      name: overlay.querySelector('.crews-info-name'),
      personText: overlay.querySelector('.crews-info-text-person'),
      wordsText: overlay.querySelector('.crews-info-text-words'),
      photosText: overlay.querySelector('.crews-info-text-photos'),
    };

    overlay.querySelector('.crews-info-close').addEventListener('click', hideCrewInfoPopup);
    overlay.querySelector('.crews-info-backdrop').addEventListener('click', hideCrewInfoPopup);
    overlay.querySelectorAll('.crews-info-copy').forEach((btn) => {
      btn.addEventListener('click', () => copyInfoPopupField(btn));
    });
  }

  async function copyInfoPopupField(btn) {
    const text = btn.dataset.target === 'person' ? infoPopupEls.personText.textContent : infoPopupEls.wordsText.textContent;
    const original = btn.textContent;
    const ok = await copyTextToClipboard(text || '');
    btn.textContent = ok ? 'コピーしました' : 'コピーできません';
    if (!ok) setStatus('コピーに失敗しました(ブラウザの権限を確認してください)', { important: true });
    setTimeout(() => { btn.textContent = original; }, 1200);
  }

  /**
   * navigator.clipboard.writeText()はモバイルブラウザによって権限まわりの挙動が揺れる
   * (許可プロンプトへの応答待ちのままpromiseがresolve/rejectどちらもせず固まる、等)。
   * 一定時間で諦めてdocument.execCommand('copy')にフォールバックし、ボタンが「コピー」の
   * まま無反応になり続けることのないようにする。
   * @returns {Promise<boolean>} コピーできたか
   */
  function copyTextToClipboard(text) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => finish(execCommandCopy(text)));
        setTimeout(() => finish(execCommandCopy(text)), 1500);
      } else {
        finish(execCommandCopy(text));
      }
    });
  }

  function execCommandCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  /** @param {string} crewId js/app.jsのwireSummaryCard()から、ヘックスの長押しで呼ばれる */
  function showCrewInfoPopup(crewId) {
    const crew = getCrewById(crewId);
    if (!crew) return;
    if (!stylesInjected) { injectStyles(); stylesInjected = true; }
    if (!infoPopupEls) buildInfoPopupDom();
    const narrative = getCrewNarrativeParts(crew);
    infoPopupEls.avatar.textContent = crew.avatar || '👤';
    infoPopupEls.name.textContent = crew.name || '(無名)';
    infoPopupEls.personText.textContent = narrative.personInfo || '(未入力)';
    infoPopupEls.wordsText.textContent = narrative.theirWords || '(未入力)';
    infoPopupEls.photosText.textContent = narrative.photoTitles.length
      ? narrative.photoTitles.map((t) => `・${t}`).join('\n')
      : '(未登録)';
    infoPopupEls.overlay.classList.add('open');
  }

  function hideCrewInfoPopup() {
    if (infoPopupEls) infoPopupEls.overlay.classList.remove('open');
  }

  // 起動ジェスチャーはjs/module-launcher.js(背景2本指ダブルタップ→キーパッド)に一本化されている。
  // このモジュールはコード("456")を登録するだけでよい。
  registerModuleCode('456', openCrews);

  // js/app.js側からの参照口(要約カードのヘックス描画・生成・長押し閲覧・なりきり文脈集約で使う)。
  window.getCrewById = getCrewById;
  window.getCrewNarrativeParts = getCrewNarrativeParts;
  window.migrateLegacyCrews = migrateLegacyCrews;
  window.crewsSummaryHexButtonsHtml = crewsSummaryHexButtonsHtml;
  window.showCrewInfoPopup = showCrewInfoPopup;
  window.openCrews = openCrews;
})();
