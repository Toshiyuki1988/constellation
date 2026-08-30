// Gemini API をブラウザから直接叩くラッパー(OCR・AIガイド用)。
// 2026年6月〜9月の移行により、Gemini APIキーは Google AI Studio 発行の
// "Auth Key" 形式が標準になった(旧 Standard Key は2026年9月に完全廃止)。
// Auth Key は既定で Gemini API に限定され、認証は ?key= クエリではなく
// x-goog-api-key ヘッダーで渡す。
// 課金設定をしないプロジェクトの Auth Key で呼ぶ想定 → 無料枠を超えると
// 課金される代わりにエラー(429など)になるだけなので、完全無料運用が保証される。

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * @param {{prompt: string, imageBase64?: string, mimeType?: string}} params
 * @returns {Promise<string>} 生成されたテキスト
 */
async function askGemini({ prompt, imageBase64, mimeType }) {
  const parts = [{ text: prompt }];
  if (imageBase64) {
    parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } });
  }

  const res = await fetch(`${GEMINI_API}/models/${CONFIG.GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': CONFIG.GEMINI_API_KEY,
    },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
}

/** 画像内のキャプション文字(作品名・作者名など)をOCR的に抽出する */
async function ocrImage(blob) {
  const imageBase64 = await blobToBase64(blob);
  return askGemini({
    prompt:
      'この画像は美術館・展覧会のキャプションや作品の写真です。' +
      '写っている作品名・作者名・年代などのテキストがあれば、簡潔に抜き出してください。' +
      'テキストが見当たらない場合は「(テキストなし)」とだけ返してください。',
    imageBase64,
    mimeType: blob.type,
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
