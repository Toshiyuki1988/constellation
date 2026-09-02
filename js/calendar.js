// Google Calendar API v3 をブラウザから直接叩くラッパー。
// calendar.app.created スコープのため、このアプリが作成した二次カレンダー(と、そのイベント)
// にのみアクセス可能(drive.file と同じ「アプリが作ったものだけ見える」最小権限スコープ)。

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

async function calendarFetch(path, options = {}) {
  const token = await ensureAccessToken();
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Calendar API error ${res.status}: ${await res.text()}`);
  }
  return res;
}

/**
 * 「展覧会」カレンダー(CONFIG.EXHIBITION_CALENDAR_NAME)のIDを返す。
 * existingId が渡され、かつ実在が確認できればそれを再利用する。存在しない(ユーザーが
 * Googleカレンダー側で削除した等)場合や未作成の場合は新規作成して返す。
 * @param {string|null} existingId
 * @returns {Promise<string>} カレンダーID
 */
async function ensureExhibitionCalendar(existingId) {
  if (existingId) {
    try {
      const res = await calendarFetch(`/calendars/${encodeURIComponent(existingId)}`);
      const cal = await res.json();
      return cal.id;
    } catch (err) {
      // 見つからない場合は下の新規作成にフォールスルー
    }
  }
  const createRes = await calendarFetch('/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: CONFIG.EXHIBITION_CALENDAR_NAME }),
  });
  const created = await createRes.json();
  return created.id;
}

/** 指定したインフォメーションカードに紐づく既存イベントを全て取得する(ページング対応) */
async function listCardCalendarEvents(calendarId, cardId) {
  const events = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      privateExtendedProperty: `constellationCardId=${cardId}`,
      showDeleted: 'false',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await calendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    const data = await res.json();
    events.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return events;
}

async function insertCalendarEvent(calendarId, event) {
  await calendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function deleteCalendarEvent(calendarId, eventId) {
  await calendarFetch(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}
