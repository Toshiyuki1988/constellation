// Gemini API をブラウザから直接叩くラッパー(OCR・AIガイド用)。
// 2026年6月〜9月の移行により、Gemini APIキーは Google AI Studio 発行の
// "Auth Key" 形式が標準になった(旧 Standard Key は2026年9月に完全廃止)。
// Auth Key は既定で Gemini API に限定され、認証は ?key= クエリではなく
// x-goog-api-key ヘッダーで渡す。
// 課金設定をしないプロジェクトの Auth Key で呼ぶ想定 → 無料枠を超えると
// 課金される代わりにエラー(429など)になるだけなので、完全無料運用が保証される。

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

// 展覧会場は電波状況が悪いことがあり、fetch()自体には既定でタイムアウトが無いため、
// 圏外/極端な低速回線だと応答がいつまでも返らず、呼び出し元(OCRのPiP表示等)が
// 「読み取り中…」のまま永久に固まって見える不具合があった(2026年9月、実機報告)。
// 一定時間で必ずエラーとして諦め、呼び出し元がユーザーに知らせて再試行できるようにする。
const GEMINI_TIMEOUT_MS = 30000;

/**
 * 外部から渡されたsignal(ユーザーによる明示キャンセル用)と、内部のタイムアウトを
 * 1つのAbortSignalへ合成する。どちらが理由でabortしたかは、fetch失敗時に
 * `signal.aborted`(外部signal)を見て判別する。
 */
function withTimeoutSignal(externalSignal, ms) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort);
  }
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * @param {{prompt: string, imageBase64?: string, mimeType?: string,
 *   images?: {base64: string, mimeType?: string}[], tools?: object[], signal?: AbortSignal,
 *   maxOutputTokens?: number}} params
 *   imageBase64/mimeTypeは画像1枚だけの場合の簡易指定。複数枚送りたい場合はimagesを使う
 *   (両方指定した場合はimageBase64側が先に追加される)。
 *   signal: 呼び出し元が明示的にキャンセルしたい場合に渡す(例: OCRのPiP表示の✕ボタン)。
 *   maxOutputTokens: 既定(モデルのデフォルト)より長い応答を確実に返してほしい場合に指定する
 *   (例: 書籍1ページ分のような長文OCR)。
 * @returns {Promise<string>} 生成されたテキスト
 */
async function askGemini({ prompt, imageBase64, mimeType, images, tools, signal, maxOutputTokens }) {
  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } });
  }
  (images || []).forEach((img) => {
    if (img && img.base64) parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.base64 } });
  });

  const body = { contents: [{ parts }] };
  if (tools) body.tools = tools;
  if (maxOutputTokens) body.generationConfig = { maxOutputTokens };

  const { signal: fetchSignal, cleanup } = withTimeoutSignal(signal, GEMINI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${GEMINI_API}/models/${CONFIG.GEMINI_MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': CONFIG.GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const wasUserCancel = Boolean(signal && signal.aborted);
      const e = new Error(
        wasUserCancel
          ? 'キャンセルされました'
          : `Gemini APIの応答がありません(${GEMINI_TIMEOUT_MS / 1000}秒でタイムアウトしました)。電波状況をご確認のうえもう一度お試しください`
      );
      e.cancelled = wasUserCancel;
      e.timedOut = !wasUserCancel;
      throw e;
    }
    throw err;
  } finally {
    cleanup();
  }
  if (!res.ok) {
    const bodyText = await res.text();
    // 「続けて選択」モードのように短時間に複数回OCRを呼ぶ運用では、無料枠の分あたりの
    // リクエスト数上限(RPM)に触れて429になることがある(日あたりの上限とは別の枠、
    // 2026年9月追加)。「読み取りに失敗しました」とだけ表示されると原因が分かりにくいため、
    // 429の場合は待って再試行するよう明示する。
    if (res.status === 429) {
      throw new Error(
        `Gemini APIの利用上限(429)に達しました。無料枠は1分あたり・1日あたりそれぞれ上限があるため、` +
        `短時間に連続で読み取ると起きることがあります。少し間隔を空けてから再試行してください。詳細: ${bodyText}`
      );
    }
    throw new Error(`Gemini API error ${res.status}: ${bodyText}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

/**
 * 画像内の文字をOCR的に書き写す。展覧会キャプション(作品名・作者名・年代程度の短文)にも、
 * Almagest(書物モジュール)向けに書籍・記事のページ全体を撮影/アップロードした長文にも
 * 同じ関数を使う。**2026年9月修正**: 以前のプロンプトが「作品名・作者名・年代などのテキストを
 * 抜き出す」という特定の短い項目の抽出を想定した書き方だったため、長文の本文ページを渡すと
 * Geminiが(明示的な要約指示は無いにもかかわらず)重要そうな断片だけを拾って残りを省略して
 * しまい、「長文だと一部しか読み取れない」という実機報告があった。「抜き出す」ではなく
 * 「一字一句省略せず書き写す」という指示に変更し、短文/長文どちらのケースも同じ言い回しで
 * カバーできるようにした。あわせて、長文でも応答が途中で切れないようmaxOutputTokensを
 * 明示的に大きく確保している。
 */
async function ocrImage(blob, { signal } = {}) {
  const imageBase64 = await blobToBase64(blob);
  const raw = await askGemini({
    prompt:
      'この画像に写っている文字を、一字一句省略せず、書かれている通りに全て書き写してください。' +
      '展覧会のキャプション(作品名・作者名・年代など)のような短い文章のこともあれば、' +
      '書籍・記事のページのような長い文章のこともあります。どちらの場合も、要約したり' +
      '重要そうな部分だけを選んで抜き出したりせず、視認できる文字を最初から最後まで漏れなく' +
      '書き写してください。' +
      '前置き・説明・「以下の通りです」のような一言も一切付けず、書き写した文字だけをそのまま返してください。' +
      'テキストが見当たらない場合は「(テキストなし)」とだけ返してください。',
    imageBase64,
    mimeType: blob.type,
    maxOutputTokens: 8192,
    signal,
  });
  return raw.trim();
}

/**
 * 範囲選択OCRの「AI解析」ボタン(2026年9月追加、js/camera.jsの handleAiAnalyzeClick()から
 * 呼ばれる)。書籍・雑誌の複数段組みページを想定し、**本文そのもののOCRはさせず**、
 * 「どこからどこまでが1つの読み取り単位(段・見出し等)か」「どの順番で読むべきか」だけを
 * Geminiに判定させる。実際の文字の書き写しは、この関数が返した各矩形をユーザーが確認・
 * 修正した上で、従来通りocrImage()を矩形ごとに呼んで行う(=このアプリのOCRエンジン自体は
 * 一切変更しない、レイアウト解析だけを追加する)。
 *
 * responseSchema(構造化出力)は使わず、parseExhibitionInfo()と同じ「プロンプトでJSON形式を
 * 指定→```json フェンスを剥がしてJSON.parse」という既存パターンを踏襲する(このアプリの
 * askGemini()はresponseSchemaに対応していないため、新しい仕組みを増やさず済ませる)。
 *
 * @param {Blob} blob 解析対象の画像(page全体。呼び出し側で軽く縮小してから渡す想定)
 * @returns {Promise<{regions: {order:number, type:string, box:[number,number,number,number]}[],
 *   readingDirection: string}>} box は [ymin, xmin, ymax, xmax]、0〜1000正規化整数。
 *   regionsが1件も検出できなかった場合はエラーを投げる(呼び出し側で手動選択への案内に使う)。
 */
async function analyzeCaptionLayout(blob) {
  const imageBase64 = await blobToBase64(blob);
  const prompt =
    'あなたは書籍・雑誌ページ画像のレイアウト解析器です。目的はOCR(文字の書き写し)を' +
    '別のエンジンへ渡すための「読み取り単位の矩形」と「読む順番」を決めることだけです。' +
    '本文の文字を書き写す必要は一切ありません。\n\n' +
    '手順:\n' +
    '1. OCRへ個別に渡すべき文字領域(段組みの各段、キャプション、脚注など)を検出する。\n' +
    '2. 日本語の縦書きでは、意味のある余白(ノド・段間)で区切られた1つの縦の段を1領域とする。' +
    '1つの段を行ごとに細分化しない。逆に、余白で明確に分かれた別々の段を1つにまとめない。\n' +
    '3. Kindle等のUI要素、ページ送りボタン、ステータスバー、装飾的な枠線、余白だけの領域、' +
    '文字を含まない挿絵・写真は領域に含めない。\n' +
    '4. 各領域の自然な読み順を決める。日本語の縦書きは通常、右の段から左の段へ、' +
    '各段の中は上から下へ読む。横書きの場合は左から右、上から下。\n' +
    '5. 矩形は文字がすべて収まるように、かつ隣の段を含まないようにする。\n\n' +
    '出力は次のJSON形式だけにしてください(前置き・説明・コードブロックの記号は一切付けないこと)。\n' +
    '{\n' +
    '  "reading_direction": "vertical-rtl" または "horizontal-ltr" または "mixed" または "unknown",\n' +
    '  "regions": [\n' +
    '    { "order": 読み順(1始まりの整数), "type": "body" または "caption" または "footnote" または "unknown", ' +
    '"box_2d": [ymin, xmin, ymax, xmax] }\n' +
    '  ]\n' +
    '}\n' +
    'box_2dの4つの整数は画像全体を0〜1000に正規化した座標で、[x,y,width,height]ではなく' +
    '[ymin, xmin, ymax, xmax]の順です。信頼できる文字領域が無ければ regions を空配列にしてください。';

  const raw = await askGemini({ prompt, imageBase64, mimeType: blob.type, maxOutputTokens: 3072 });
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error('AI解析の応答をJSONとして解析できませんでした');
  }
  const rawRegions = Array.isArray(parsed.regions) ? parsed.regions : [];
  // 防御的に検証・正規化する(CLAUDE_CODE_SPEC.md 10節相当): box_2dが不正な要素は除外し、
  // orderは欠番/重複があっても常に1始まりの連番へ振り直す(Geminiの意図した相対順序自体は
  // 元のorder値でソートすることで尊重する)。
  const regions = rawRegions
    .map((r) => {
      const box = Array.isArray(r && r.box_2d) ? r.box_2d.slice(0, 4).map((v) => Number(v)) : null;
      if (!box || box.length !== 4 || box.some((v) => !Number.isFinite(v))) return null;
      const clamped = box.map((v) => Math.max(0, Math.min(1000, v)));
      const [ymin, xmin, ymax, xmax] = clamped;
      if (ymax - ymin < 4 || xmax - xmin < 4) return null; // 潰れた矩形は除外
      const order = Number.isFinite(Number(r.order)) ? Number(r.order) : Infinity;
      const type = typeof r.type === 'string' ? r.type : 'unknown';
      return { order, type, box: clamped };
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .map((r, i) => ({ ...r, order: i + 1 }));

  if (regions.length === 0) {
    throw new Error('文字の範囲を検出できませんでした');
  }
  const readingDirection = typeof parsed.reading_direction === 'string' ? parsed.reading_direction : 'unknown';
  return { regions, readingDirection };
}

/**
 * インフォメーションカードに貼り付けられた展覧会案内文(コピペテキスト)から、会期・開廊時間・
 * 休廊日を構造化データとして抽出する。一度パースすれば「今日は鑑賞可能か」は以降ローカルJS
 * だけで判定でき、APIを再度呼ぶ必要はない。祝日による休廊も、曜日パターン(closedWeekdays)
 * には含めず、具体的な日付のexceptionとして個別に列挙してもらう(実行時に祝日カレンダーを
 * 別途持たずに済ませるため)。
 * URL入力(url_contextツールでの取得)は、TOKYO ART BEATなどクライアントサイドレンダリング
 * のサイトで本文が取得できず解析に失敗するため廃止した。ウェブページからのコピペを想定。
 * 2026年9月: 一時的にgoogle_searchツール(検索グラウンディング)を追加し、公式ページURLも
 * 同じ呼び出しで探させる案を試したが、実機で429 RESOURCE_EXHAUSTED(検索グラウンディングは
 * 請求先アカウント非紐付けの無料キーでは割り当てがゼロ)が即座に発生し、解析自体が丸ごと
 * 失敗するようになったため撤回した。完全無料運用の絶対条件と両立しないため、tools無しの
 * プレーンなテキストプロンプトに戻している。展覧会リンクは、代わりにapp.js側でGemini APIを
 * 呼ばずクライアントサイドだけでGoogle検索結果ページのURLを組み立てる方式にした
 * (exhibitionSearchUrl()、無料枠を一切消費しない)。
 * @param {string} text 案内文(展覧会ページ本文のコピペ、または手入力)
 * @returns {Promise<object>} 成功時は {title, venue, startDate, endDate, openTime, closeTime,
 *   closedWeekdays, exceptions}。会期を読み取れなかった場合は {error, partial} を返す
 *   (partialは読み取れた項目だけを含む)。ネットワーク/APIエラー自体は例外として投げる。
 */
async function parseExhibitionInfo(text) {
  const prompt =
    '以下は美術展覧会・ギャラリーの案内文です。' +
    '次のJSON形式だけを出力してください(前置き・説明・コードブロックの記号は一切付けないこと)。\n' +
    '{\n' +
    '  "title": "展覧会名(アーティスト名を含む)",\n' +
    '  "venue": "会場名",\n' +
    '  "startDate": "YYYY-MM-DD",\n' +
    '  "endDate": "YYYY-MM-DD",\n' +
    '  "openTime": "HH:MM",\n' +
    '  "closeTime": "HH:MM",\n' +
    '  "closedWeekdays": [0=日曜〜6=土曜の整数の配列。定休の曜日だけを入れる],\n' +
    '  "exceptions": [{"type": "open または closed", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "note": "補足(任意)"}]\n' +
    '}\n' +
    'closedWeekdaysには「毎週◯曜日定休」のような曜日パターンだけを入れ、それ以外の例外は全てexceptionsで表現してください。' +
    '具体的には次のような記載を、本文全体から見落とさず探して反映してください。\n' +
    '- 「祝日は休廊」→ 該当する具体的な祝日の日付をexceptionsにtype:"closed"として個別に列挙(日本の祝日カレンダーの知識を使って構いません)\n' +
    '- 「◯月◯日〜◯日は開廊/特別開館」のような期間指定 → その期間**全体をまとめて1つ**のexceptionにtype:"open"として列挙\n' +
    '- 「◯月◯日は開館」のような単発1日だけの例外 → startDateとendDateを同じ日付にしてexceptionsへ列挙\n' +
    '- 「臨時休館」「特別休館日」のような単発の休みの記載も同様にtype:"closed"で列挙\n' +
    '重要: exceptionsは「closedWeekdaysや会期だけからは判断できない、状態が変わる日」だけを書く場所です。' +
    'ある期間が丸ごと開廊する例外を1つのopen exceptionとして書いたら、その期間に含まれる個々の日付について' +
    '(closedWeekdaysに該当する曜日だからといって)重複してclosed exceptionを追加しないでください。同じ日付に' +
    'open と closed の両方のexceptionを付けるのは矛盾なので禁止です。' +
    'また、定休日の記載が無い(closedWeekdaysが空)のに会期全体をまるごと1つのopen exceptionにする、' +
    'といった「休廊日パターンを何も上書きしていない」exceptionsも書かないでください。本文に例外的な' +
    '開閉の記載が無ければ、exceptionsは空配列のままにしてください。' +
    '読み取れない項目はnullにしてください。案内文:\n\n' + text;

  const raw = await askGemini({ prompt });
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { error: '応答をJSONとして解析できませんでした' };
  }
  if (!parsed.startDate || !parsed.endDate) {
    return { error: '会期(開始日・終了日)を読み取れませんでした', partial: parsed };
  }
  return parsed;
}

/**
 * サマリーカード用: セッション全体のテキスト情報(collectSessionTextContext()で組み立てた文章、
 * 本文中に[出典N]タグが埋め込まれている)から、視点(mode)と任意の傾向指示(direction)に沿って
 * 要約を1本書かせる。既定では画像は送らない(枚数の多いセッションで無料枠をすぐ消費してしまう
 * ため)。サマリーカードにASTRで手動接続された写真カードがある場合だけ、その写真(imagesで
 * 渡す)も見て要約させる(動画・音声は呼び出し側で除外済みの前提)。
 * 回答と同時に、本文中の[出典N]タグのうち最も参考にした番号(mostRelevantSource、1始まり)も
 * 答えさせる(呼び出し側でsources[mostRelevantSource-1]から実際のcard.idへ引き当て、その
 * カードへASTR接続する用途)。特に無ければnull。
 * personaを渡すとmodeは無視し、Crewsモジュール(js/modules/crews.js)が持つ人格(【人物情報】
 * 【その言葉】)になりきらせた一人称の語りを書かせる。Education/Academicと呼び出し方は同じ
 * (=既存の1回のgenerateContent呼び出しパターンのまま、ペルソナ登録時に別途Geminiは呼ばない)。
 * @param {{context: string, mode?: 'education'|'academic',
 *   persona?: {personInfo: string, theirWords: string}, direction?: string,
 *   images?: {base64: string, mimeType?: string}[]}} params
 * @returns {Promise<{answer: string, mostRelevantSource: number|null}>}
 */
async function summarizeSession({ context, mode, persona, direction, images }) {
  const styleInstruction = persona
    ? 'あなたは今、次の人物になりきって書いてください。あなた自身の言葉ではなく、必ずこの人物の一人称の語りとして書くこと。\n' +
      `【人物情報】\n${persona.personInfo}\n\n` +
      '【その言葉(この人物の語彙・言い回し・ものの見方を、以下の引用から読み取って声を似せること。引用をそのまま繰り返す必要はない)】\n' +
      `${persona.theirWords}` +
      (persona.photoTitles && persona.photoTitles.length
        ? '\n\n【好きな作品】\n' + persona.photoTitles.map((t) => `・${t}`).join('\n')
        : '')
    : mode === 'education'
      ? '小学生・中学生にも分かるように、やさしい言葉と短い文で説明してください。専門用語はできるだけ避け、使う場合は簡単な説明を添えてください。'
      : '学術的な文体で、批評・美術史的な視点を踏まえて記述してください。必要に応じて専門用語を使って構いません。';
  const hasDirection = Boolean(direction && direction.trim());
  const hasImages = Boolean(images && images.length > 0);

  // 「展覧会全体の要約」を常に主題にしてdirection/imagesを付け足しにすると、Geminiが前置きの
  // 総括を書いてから付け足しに軽く触れるだけになりがちだった(ユーザー報告: 出力の8割が前置き)。
  // 「前置きとして総括しないでください」程度の指示では弱く、依然として最初の1〜2文で展覧会全体
  // の説明から書き始めてしまっていたため、「最初の一文から本題そのものを書き始める」ところまで
  // 明示的に指定するよう強化した。展覧会全体の総括はユーザー自身が別途(directionなしで)
  // 生成する運用のため、direction/imagesがある時点で前置きは完全に不要という判断。
  const noPreamble =
    'この展覧会が全体として何についてのものかは、話を組み立てる上であなたの理解の中だけで' +
    '踏まえておいてください。ただし文章としては書かないでください。「この展覧会は〜」のような' +
    '展覧会全体の説明・背景の前置きを一切書かず、最初の一文から本題そのものについて書き始めてください。';
  let taskInstruction;
  if (hasDirection && hasImages) {
    taskInstruction =
      `添付した写真に写っている作品を中心に取り上げながら、次の問い・視点に直接答える形で書いてください: 「${direction.trim()}」\n${noPreamble}`;
  } else if (hasImages) {
    taskInstruction = `添付した写真に写っている作品そのものを中心に取り上げて書いてください。${noPreamble}`;
  } else if (hasDirection) {
    taskInstruction = `次の問い・視点に直接答える形で書いてください: 「${direction.trim()}」\n${noPreamble}`;
  } else {
    taskInstruction = '展覧会全体の要約を書いてください。';
  }

  const prompt =
    '以下は、ある美術展覧会・セッションの記録(タイトルと、鑑賞メモ・キャプションなどのテキスト)です。' +
    '各行の[出典N]は、後で参照するための番号です。\n\n' +
    `${context}\n\n` +
    `${taskInstruction}\n${styleInstruction}\n` +
    '本文は前置き・見出し・箇条書き記号は使わず、自然な文章で200〜400字程度にまとめてください。\n\n' +
    '出力は次のJSON形式だけにしてください(前置き・説明・コードブロックの記号は一切付けないこと)。\n' +
    '{\n' +
    '  "answer": "本文",\n' +
    '  "mostRelevantSource": 本文を書く上で最も参考にした[出典N]の番号(整数)。特に無ければnull\n' +
    '}';

  const raw = await askGemini({ prompt, images });
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.answer === 'string') {
      const idx = Number.isInteger(parsed.mostRelevantSource) ? parsed.mostRelevantSource : null;
      return { answer: parsed.answer.trim(), mostRelevantSource: idx };
    }
  } catch (err) {
    // JSONとして解析できなかった場合は、生のテキストをそのまま本文として使う(出典の紐付けは諦める)
  }
  return { answer: cleaned, mostRelevantSource: null };
}

/**
 * Almagest(書物モジュール、js/modules/almagest.js)の書庫エントリの本文を、Boy(やさしく)/
 * Professor(学術的)の口調で要約する。summarizeSession()と同じ口調プリセットを流用するが、
 * 対象は展覧会セッションではなく1冊の本文そのものなので、セッション固有の仕組み([出典N]タグ・
 * mostRelevantSourceによる自動ASTR接続・「展覧会」という前提)は持たない、テンプレート無しの
 * 単純な1回のGemini呼び出し。
 * @param {{text: string, mode: 'education'|'academic'}} params
 * @returns {Promise<string>}
 */
async function summarizeAlmagestText({ text, mode }) {
  const styleInstruction = mode === 'education'
    ? '小学生・中学生にも分かるように、やさしい言葉と短い文で説明してください。専門用語はできるだけ避け、使う場合は簡単な説明を添えてください。'
    : '学術的な文体で、批評・美術史的な視点を踏まえて記述してください。必要に応じて専門用語を使って構いません。';
  const prompt =
    '以下は書物・記事などの本文です。この内容を噛み砕いて要約してください。\n\n' +
    `${text}\n\n` +
    `${styleInstruction}\n` +
    '単に短くまとめるのではなく、本文に含まれる具体的な固有名詞・数値・事例・論の展開を' +
    'できるだけ拾い、背景や含意にも踏み込んだ、解像度の高い内容にしてください。' +
    '前置き・見出し・箇条書き記号は使わず、自然な文章で600〜1200字程度にまとめてください。';
  const raw = await askGemini({ prompt });
  return raw.trim();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
