// CONSTELLATION — キャンバス操作音。
//
// js/camera.js の効果音(シャッター音など)と同じく、音声ファイルは一切使わず
// Web Audio API でその場合成する。展覧会場で他の来場者がいる中で使われることを
// 前提に、どの音も控えめな音量・穏やかなアタック・低域カットで作ってある
// (速いアタックは音の高さに関係なく低域を含む「クリック」成分を生みやすいため)。
//
// 呼び出し側(js/canvas.js, js/app.js, js/modules/*.js)は以下の関数を呼ぶだけでよい。
//   playGuideRevealSound()     編集ガイド展開時の「ピッ」
//   playAstrPressSound()       ASTR長押し確定(線を引き始めた)時の「フィヨン・・・」
//   playAstrConnectSound()     ASTRで線が繋がった時の「ピーン」
//   playCardMoveTickSound()    カード移動中の1回ぶんの「ピ」(呼ぶ間隔は呼び出し側が速度に応じて決める)
//   playWormGateOpenSound()    WormGate起動時の「パァーン」
//   playWormGateRingTickSound()WormGateのリング回転中の「ピルルル」(呼ぶ間隔は呼び出し側が決める)
//   playWormGateSelectSound()  WormGateで写真を選んでジャンプする時の「キュッ」
//   playMappingStorysDeploySound() Mapping Storysで地図をキャンバスへ展開する時の「シュワァーン…」
//   playFlightEngineerToggleSound(on) Flight EngineerのON/OFF切り替え時の「ピッ↑」「ポッ↓」
//   playFlightEngineerSelectSound()   矩形選択の開始/タップ選択時の軽い「チッ」
//   playFlightEngineerStowSound()     格納が完了した時の「シュン…」(吸い込まれる質感)
//   playFlightEngineerCutSound()      格納でASTR接続が切断される時の「パチッ」
//   playFlightEngineerDisbandSound()  解体で中身が展開される時の「パッ」(格納の逆再生的な質感)
//   playFlightEngineerTidySound()     整理(グリッド整列)完了時の3音の軽いチャイム
//   playFlightEngineerUndoSound()     元に戻す時の下降音
//   playFlightEngineerRedoSound()     やり直す時の上昇音
//   playChatReplySound()       座談会の自動返信が1件表示される直前の「シュコッ」
//   playConstellationAddCardSound()  Crews Constellationでカードを追加した時の「キン☆」
//   playConstellationMoveCardSound() Crews Constellationでカードのドラッグを始めた時の「ヒュウ…」

let soundCtx = null;
function soundAudioCtx() {
  if (!soundCtx) soundCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (soundCtx.state === 'suspended') soundCtx.resume();
  return soundCtx;
}

// カメラ起動・ファイル選択ダイアログなどでページが一時的にバックグラウンド化すると、
// スマホのブラウザはAudioContextを自動でsuspendする。soundAudioCtx()内のresume()は
// 非同期で完了を待たずに音を鳴らそうとするため、復帰直後の1回目の効果音だけが
// 「たまに無音になる」不具合があった。フォアグラウンド復帰のタイミングで先んじて
// resumeしておくことで、実際に音を鳴らす時点では既にrunning状態になっているようにする。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && soundCtx && soundCtx.state === 'suspended') {
    soundCtx.resume();
  }
});

// 合成リバーブ用のインパルス応答(白色ノイズの指数減衰)。初回だけ生成してキャッシュする。
let soundReverbBuffer = null;
function getSoundReverbImpulse(c) {
  if (soundReverbBuffer) return soundReverbBuffer;
  const duration = 1.6;
  const decay = 3.4;
  const length = Math.floor(c.sampleRate * duration);
  const impulse = c.createBuffer(2, length, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  soundReverbBuffer = impulse;
  return impulse;
}

/** 編集ガイド展開:「ピッ」 */
function playGuideRevealSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1760;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.26, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 700;
  osc.connect(gain).connect(highpass);

  const dryGain = c.createGain();
  dryGain.gain.value = 0.9;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.28;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  osc.start(now);
  osc.stop(now + 0.12);
}

/** ASTR長押し確定(線を引き始めた):「フィヨン・・・」。ピッチは動かさず、
 *  わずかにデチューンした3層を重ねて光が瞬くようなシマーを出す。 */
function playAstrPressSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const master = c.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.22, now + 0.09);
  master.gain.exponentialRampToValueAtTime(0.08, now + 0.34);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 500;
  master.connect(highpass);

  const dryGain = c.createGain();
  dryGain.gain.value = 0.85;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.42;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  [
    { detune: 0, vibHz: 6, vibDepth: 10, level: 1 },
    { detune: 9, vibHz: 6.7, vibDepth: 9, level: 0.55 },
    { detune: -8, vibHz: 5.4, vibDepth: 11, level: 0.5 },
  ].forEach(({ detune, vibHz, vibDepth, level }) => {
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1500;
    osc.detune.value = detune;

    const vibrato = c.createOscillator();
    const vibratoGain = c.createGain();
    vibrato.frequency.value = vibHz;
    vibratoGain.gain.value = vibDepth;
    vibrato.connect(vibratoGain).connect(osc.frequency);

    const g = c.createGain();
    g.gain.value = level;
    osc.connect(g).connect(master);
    vibrato.start(now);
    osc.start(now);
    vibrato.stop(now + 0.68);
    osc.stop(now + 0.68);
  });
}

/** ASTRで線が繋がった:「ピーン」。高音の倍音構成+ハイパスで低域カット+リバーブで
 *  細い光の糸が張るような余韻を出す。 */
function playAstrConnectSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 1300;

  const dryGain = c.createGain();
  dryGain.gain.value = 0.75;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.55;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  // 1760Hz(A6)を基準に5度・オクターブ上の倍音だけを重ねる(低い基音を含めない構成)
  [[1, 0.22, 1.0], [1.5, 0.15, 0.85], [2, 0.09, 0.7]].forEach(([mult, peak, dur]) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = 1760 * mult;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(highpass);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  });
}

/** カード移動中の1回ぶんの「ピ」。ガイド展開音と同じ固定ピッチ・音量で、音階は変化しない。
 *  連続で鳴らす間隔(=移動速度に応じた緩急)はjs/canvas.js側で制御する。 */
function playCardMoveTickSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1760;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.22, now + 0.016);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 900;

  const dryGain = c.createGain();
  dryGain.gain.value = 0.85;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.2;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  osc.connect(gain).connect(highpass);
  osc.start(now);
  osc.stop(now + 0.08);
}

/** WormGate起動:「パァーン」。ノイズの息+急上昇する3声+広めのリバーブ。 */
function playWormGateOpenSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 400;
  const dryGain = c.createGain();
  dryGain.gain.value = 0.45;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.34;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  // ノイズの「息」
  const dur = 0.35;
  const n = Math.floor(c.sampleRate * dur);
  const buffer = c.createBuffer(1, n, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 0.7;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const bandpass = c.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 2600;
  bandpass.Q.value = 0.6;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.2;
  src.connect(bandpass).connect(noiseGain).connect(highpass);
  src.start(now);

  // 急上昇する3声
  [[900, 2000, 0.13], [1350, 3000, 0.08], [1800, 4000, 0.05]].forEach(([f0, f1, peak], i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + 0.22);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + 0.05 + i * 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
    osc.connect(gain).connect(highpass);
    osc.start(now);
    osc.stop(now + 0.95);
  });
}

/** WormGateのリング回転中の1回ぶんの「ピルルル」ティック(カード移動音と同系統)。 */
function playWormGateRingTickSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1760;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 900;
  osc.connect(gain).connect(highpass);

  const dryGain = c.createGain();
  dryGain.gain.value = 0.85;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.18;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  osc.start(now);
  osc.stop(now + 0.07);
}

/** WormGateで写真を選んでジャンプする:「キュッ」。短く鋭い下降チャープ、タイトでドライ。 */
function playWormGateSelectSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(2200, now);
  osc.frequency.exponentialRampToValueAtTime(1100, now + 0.045);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 700;
  osc.connect(gain).connect(highpass).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.06);
}

/** Mapping Storysで地図をキャンバスへ展開する:「シュワァーン…」。地面が広がるように包み込む
 *  低めのパッド(2声デチューン)+ 遅れて立ち上がる高音のきらめき(広いリバーブ)。WormGateの
 *  弾けるような開始音とは対照的に、ゆっくり満ちていく持続音にして「地図が広がる」感触を出す。 */
function playMappingStorysDeploySound() {
  const c = soundAudioCtx();
  const now = c.currentTime;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1100;
  filter.connect(c.destination);

  const padGain = c.createGain();
  padGain.gain.setValueAtTime(0.0001, now);
  padGain.gain.exponentialRampToValueAtTime(0.1, now + 0.4);
  padGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
  padGain.connect(filter);
  [196, 198.5].forEach((freq) => { // わずかにデチューンした2声でうねりを作る
    const osc = c.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.connect(padGain);
    osc.start(now);
    osc.stop(now + 1.2);
  });

  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  const wetGain = c.createGain();
  wetGain.gain.value = 0.3;
  convolver.connect(wetGain).connect(c.destination);

  const shimmerGain = c.createGain();
  shimmerGain.gain.setValueAtTime(0.0001, now + 0.18);
  shimmerGain.gain.exponentialRampToValueAtTime(0.05, now + 0.55);
  shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
  shimmerGain.connect(convolver);
  const shimmerOsc = c.createOscillator();
  shimmerOsc.type = 'sine';
  shimmerOsc.frequency.setValueAtTime(1500, now + 0.18);
  shimmerOsc.frequency.exponentialRampToValueAtTime(2500, now + 1.0);
  shimmerOsc.connect(shimmerGain);
  shimmerOsc.start(now + 0.18);
  shimmerOsc.stop(now + 1.35);
}

/** Flight EngineerのON/OFF切り替え:「ピッ↑」(ON)/「ポッ↓」(OFF)。短い単発のスイープ。 */
function playFlightEngineerToggleSound(on) {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(on ? 620 : 520, now);
  osc.frequency.linearRampToValueAtTime(on ? 900 : 300, now + 0.1);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 400;
  osc.connect(gain).connect(highpass).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.16);
}

/** 矩形選択の開始/タップ選択:軽い「チッ」。連打されても耳障りにならないよう極短・低音量。 */
function playFlightEngineerSelectSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1500;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.09, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 900;
  osc.connect(gain).connect(highpass).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.05);
}

/** 格納完了:「シュン…」。周波数が急上昇しながら音量が減衰し、吸い込まれる質感を出す。 */
function playFlightEngineerStowSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(1100, now + 0.34);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.14, now + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 300;
  const dryGain = c.createGain();
  dryGain.gain.value = 0.85;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.3;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  osc.connect(gain).connect(highpass);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.42);
}

/** 格納でASTR接続が切れる:「パチッ」。短く鋭い下降チャープ。 */
function playFlightEngineerCutSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(700, now);
  osc.frequency.exponentialRampToValueAtTime(130, now + 0.12);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.13, now + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 500;
  osc.connect(gain).connect(highpass).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.14);
}

/** 解体で中身が展開される:「パッ」。格納音の逆再生的な、短く開放的な質感。 */
function playFlightEngineerDisbandSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(1100, now);
  osc.frequency.exponentialRampToValueAtTime(360, now + 0.28);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.15, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 300;
  const dryGain = c.createGain();
  dryGain.gain.value = 0.85;
  const wetGain = c.createGain();
  wetGain.gain.value = 0.28;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  osc.connect(gain).connect(highpass);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.34);
}

/** 整理(グリッド整列)完了: 3音の軽いチャイムが駆け上がる。 */
function playFlightEngineerTidySound() {
  const c = soundAudioCtx();
  [0, 80, 160].forEach((delayMs, i) => {
    setTimeout(() => {
      const now = c.currentTime;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 520 + i * 140;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.11, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
      osc.connect(gain).connect(c.destination);
      osc.start(now);
      osc.stop(now + 0.11);
    }, delayMs);
  });
}

/** 元に戻す: 下降スイープ。 */
function playFlightEngineerUndoSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(720, now);
  osc.frequency.exponentialRampToValueAtTime(340, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.15, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.2);
}

/** やり直す: 上昇スイープ(元に戻すの逆)。 */
function playFlightEngineerRedoSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(340, now);
  osc.frequency.exponentialRampToValueAtTime(720, now + 0.16);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.15, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
  osc.connect(gain).connect(c.destination);
  osc.start(now);
  osc.stop(now + 0.2);
}

/**
 * 座談会の自動カスケード返信(js/app.jsのrunChatCascade())が1件表示される直前の「シュコッ」。
 * 「シュ」(ノイズバーストをバンドパスで絞りながら下降させる)+「コッ」(ごく短いクリック)の
 * 2要素で擬音を再現する。LINEのメッセージ受信音のような軽い通知感を狙いつつ、
 * 他の効果音と同じく控えめな音量に留めている。
 */
function playChatReplySound() {
  const c = soundAudioCtx();
  const now = c.currentTime;
  const n = Math.floor(c.sampleRate * 0.05);
  const buffer = c.createBuffer(1, n, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 1.4;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(2400, now);
  filter.frequency.exponentialRampToValueAtTime(850, now + 0.05);
  filter.Q.value = 0.9;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.1;
  src.connect(filter).connect(noiseGain).connect(c.destination);
  src.start(now);

  const osc = c.createOscillator();
  const clickGain = c.createGain();
  osc.type = 'square';
  osc.frequency.value = 320;
  clickGain.gain.setValueAtTime(0.0001, now + 0.045);
  clickGain.gain.exponentialRampToValueAtTime(0.07, now + 0.05);
  clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  osc.connect(clickGain).connect(c.destination);
  osc.start(now + 0.045);
  osc.stop(now + 0.1);
}

/** Crews Constellation: カード追加時「キン☆」。高い倍音の短いピークを2つ重ねる
 *  (playAstrConnectSound()と近い質感だが、より短く軽い)。 */
function playConstellationAddCardSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 900;
  const dryGain = c.createGain(); dryGain.gain.value = 0.85;
  const wetGain = c.createGain(); wetGain.gain.value = 0.3;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  [2600, 3800].forEach((freq, i) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = now + i * 0.03;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    osc.connect(gain).connect(highpass);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  });
}

/** Crews Constellation: カードのドラッグ移動を始めた瞬間「ヒュウ…」(高いピッチから
 *  スッと下降するスイープ)。ドラッグ中ずっと鳴らすのではなく、開始時に1回だけ鳴らす。 */
function playConstellationMoveCardSound() {
  const c = soundAudioCtx();
  const now = c.currentTime;

  const highpass = c.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 500;
  const dryGain = c.createGain(); dryGain.gain.value = 0.8;
  const wetGain = c.createGain(); wetGain.gain.value = 0.25;
  const convolver = c.createConvolver();
  convolver.buffer = getSoundReverbImpulse(c);
  highpass.connect(dryGain).connect(c.destination);
  highpass.connect(wetGain).connect(convolver).connect(c.destination);

  const sweep = c.createOscillator();
  const sweepGain = c.createGain();
  sweep.type = 'sine';
  sweep.frequency.setValueAtTime(2000, now);
  sweep.frequency.exponentialRampToValueAtTime(650, now + 0.32);
  sweepGain.gain.setValueAtTime(0.0001, now);
  sweepGain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
  sweep.connect(sweepGain).connect(highpass);
  sweep.start(now);
  sweep.stop(now + 0.38);
}
