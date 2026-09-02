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

let soundCtx = null;
function soundAudioCtx() {
  if (!soundCtx) soundCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (soundCtx.state === 'suspended') soundCtx.resume();
  return soundCtx;
}

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
