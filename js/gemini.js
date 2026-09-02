// Gemini API をブラウザから直接叩くラッパー(OCR・AIガイド用)。
// 2026年6月〜9月の移行により、Gemini APIキーは Google AI Studio 発行の
// "Auth Key" 形式が標準になった(旧 Standard Key は2026年9月に完全廃止)。
// Auth Key は既定で Gemini API に限定され、認証は ?key= クエリではなく
// x-goog-api-key ヘッダーで渡す。
// 課金設定をしないプロジェクトの Auth Key で呼ぶ想定 → 無料枠を超えると
// 課金される代わりにエラー(429など)になるだけなので、完全無料運用が保証される。

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * @param {{prompt: string, imageBase64?: string, mimeType?: string, tools?: object[]}} params
 * @returns {Promise<string>} 生成されたテキスト
 */
async function askGemini({ prompt, imageBase64, mimeType, tools }) {
  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } });
  }

  const body = { contents: [{ parts }] };
  if (tools) body.tools = tools;

  const res = await fetch(`${GEMINI_API}/models/${CONFIG.GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': CONFIG.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

/** 画像内のキャプション文字(作品名・作者名など)をOCR的に抽出する */
async function ocrImage(blob) {
  const imageBase64 = await blobToBase64(blob);
  const raw = await askGemini({
    prompt:
      'この画像は美術館・展覧会のキャプションや作品の写真です。' +
      '写っている作品名・作者名・年代などのテキストを、書かれている通りに抜き出してください。' +
      '前置き・説明・「以下の通りです」のような一言も一切付けず、抽出した文字だけをそのまま返してください。' +
      'テキストが見当たらない場合は「(テキストなし)」とだけ返してください。',
    imageBase64,
    mimeType: blob.type,
  });
  return raw.trim();
}

/**
 * インフォメーションカードに貼り付けられた展覧会案内文(コピペテキスト)から、会期・開廊時間・
 * 休廊日を構造化データとして抽出する。一度パースすれば「今日は鑑賞可能か」は以降ローカルJS
 * だけで判定でき、APIを再度呼ぶ必要はない。祝日による休廊も、曜日パターン(closedWeekdays)
 * には含めず、具体的な日付のexceptionとして個別に列挙してもらう(実行時に祝日カレンダーを
 * 別途持たずに済ませるため)。
 * URL入力(url_contextツールでの取得)は、TOKYO ART BEATなどクライアントサイドレンダリング
 * のサイトで本文が取得できず解析に失敗するため廃止した。ウェブページからのコピペを想定。
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
    '重要: exceptionsはclosedWeekdaysだけでは表現できない「例外」だけを書く場所です。' +
    'ある期間が丸ごと開廊する例外を1つのopen exceptionとして書いたら、その期間に含まれる個々の日付について' +
    '(closedWeekdaysに該当する曜日だからといって)重複してclosed exceptionを追加しないでください。同じ日付に' +
    'open と closed の両方のexceptionを付けるのは矛盾なので禁止です。' +
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

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
