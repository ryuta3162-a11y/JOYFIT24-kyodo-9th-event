const SPREADSHEET_ID = '1hQKe60-qL4NlEzA_bWEXt9M9kv8JURaGDRP4IhDBMEY';
const PARTICIPANTS_SHEET = '参加者';
const SESSIONS_SHEET = 'セッション';
const LEGACY_PARTICIPANTS_SHEET = 'participants';
const LEGACY_SESSIONS_SHEET = 'sessions';
const LEGACY_RECORDS_SHEET = 'records';
const TEST_WEEK_OVERRIDE = null;
const EVENT_ENDED = true;
const FINAL_REPORT_SHEET = '最終結果';

const EVENT_WEEKS = [
  { week: 1, event: '握力測定', sheet: '握力測定', unit: 'kg', start: '2026-08-03', end: '2026-08-08', higherIsBetter: true },
  { week: 2, event: '前屈', sheet: '前屈', unit: 'cm', start: '2026-08-09', end: '2026-08-15', higherIsBetter: true },
  { week: 3, event: 'プランク', sheet: 'プランク', unit: '秒', start: '2026-08-16', end: '2026-08-23', higherIsBetter: true },
  { week: 4, event: '腕立て伏せ', sheet: '腕立て伏せ', unit: '回', start: '2026-08-24', end: '2026-08-30', higherIsBetter: true },
];

// A〜O: E列=表示名, H/I/J列=1〜3回目スコア
const PARTICIPANT_HEADERS = ['participantId', 'nickname', 'pin', 'division', 'active', 'memo', 'createdAt', 'updatedAt'];
const SESSION_HEADERS = ['token', 'participantId', 'createdAt', 'expiresAt'];
const EVENT_HEADERS = [
  'participantId', // A
  'createdAt',     // B
  'updatedAt',     // C
  'division',      // D
  'displayName',   // E
  'unit',          // F
  'attempts',      // G
  'score1',        // H
  'score2',        // I
  'score3',        // J
  'date1',         // K
  'date2',         // L
  'date3',         // M
  'inputBy',       // N
  'userAgent',     // O
];

function doGet(e) {
  const params = e && e.parameter ? e.parameter : {};
  const action = String(params.action || 'list');
  try {
    if (action === 'health') return jsonResponse({ ok: true, message: 'ok' }, e);
    if (action === 'setup') return jsonResponse(setupSheets(), e);
    if (action === 'login') return jsonResponse(login(params.nickname, params.pin, params.mode), e);
    if (action === 'lookup') return jsonResponse(lookupParticipant(params.nickname, params.pin), e);
    if (action === 'report') return jsonResponse(buildFinalReportSheet(), e);
    if (action === 'submit') {
      if (EVENT_ENDED) return jsonResponse({ ok: false, message: 'イベントは終了しました。' }, e);
      const body = JSON.parse(String(params.payload || '{}'));
      return jsonResponse(upsertRecord(params.token, body, e), e);
    }
    return jsonResponse(readPublicState(), e);
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: humanizeServerError(error && error.message),
    }, e);
  }
}

function setupSheets() {
  const cache = CacheService.getScriptCache();
  if (cache.get('sheetsReady') === '1') {
    return { ok: true, message: 'シート準備済みです。' };
  }

  renameLegacySheetIfNeeded(LEGACY_PARTICIPANTS_SHEET, PARTICIPANTS_SHEET);
  renameLegacySheetIfNeeded(LEGACY_SESSIONS_SHEET, SESSIONS_SHEET);

  ensureSheet(PARTICIPANTS_SHEET, PARTICIPANT_HEADERS);
  ensureSheet(SESSIONS_SHEET, SESSION_HEADERS);
  EVENT_WEEKS.forEach(week => ensureSheet(week.sheet, EVENT_HEADERS));

  const now = new Date().toISOString();
  const participants = getSheet(PARTICIPANTS_SHEET);
  if (participants.getLastRow() < 2) {
    participants.appendRow([Utilities.getUuid(), 'テスト', '1111', 'member', true, '動作確認用', now, now]);
    participants.appendRow([Utilities.getUuid(), 'STAFF', '9999', 'staff', true, 'スタッフ確認用', now, now]);
  }

  migrateLegacyRecordsIfNeeded();
  cache.put('sheetsReady', '1', 21600);
  return { ok: true, message: 'シートを準備しました。' };
}

function lookupParticipant(nickname, pin) {
  const cleanNickname = normalizeNickname(nickname);
  const cleanPin = normalizePin(pin);
  if (!cleanNickname && !cleanPin) {
    return { ok: false, message: 'ニックネームかパスワードのどちらかを入力してください。' };
  }
  const participants = getParticipants().filter(p => p.active);
  let found = null;
  if (cleanNickname) {
    found = participants.find(p => p.nicknameKey === nicknameKey(cleanNickname));
  } else if (/^[0-9]{4}$/.test(cleanPin)) {
    const matches = participants.filter(p => p.pin === cleanPin);
    if (matches.length === 1) found = matches[0];
    else if (matches.length > 1) return { ok: false, message: '同じパスワードの方が複数います。\nニックネームも入力してください。' };
  }
  if (!found) return { ok: false, message: '見つかりませんでした。\n新規登録してください。' };
  return {
    ok: true,
    nickname: found.nickname,
    pin: found.pin,
  };
}

function login(nickname, pin, mode) {
  if (EVENT_ENDED) {
    return { ok: false, message: 'イベントは終了しました。\nご参加ありがとうございました。' };
  }
  const cleanNickname = normalizeNickname(nickname);
  const cleanPin = normalizePin(pin);
  const modeName = String(mode || '').trim().toLowerCase();
  const loginError = {
    ok: false,
    message: 'ニックネームもしくはパスワードが違います。\n店舗スタッフまでお声かけください',
  };

  if (modeName !== 'register' && modeName !== 'login') {
    return { ok: false, message: '新規登録または再度ログインを選び直してください。' };
  }
  if (!cleanNickname) return { ok: false, message: 'ニックネームを入力してください。' };
  if (!/^[0-9]{4}$/.test(cleanPin)) return { ok: false, message: '4桁パスワードを入力してください。' };

  let participant = findParticipantByNickname(cleanNickname);

  if (modeName === 'register') {
    if (participant) {
      return {
        ok: false,
        message: 'このニックネームは既に登録されています。\n再度ログインからお進みください。',
      };
    }
    try {
      participant = createParticipant(cleanNickname, cleanPin);
    } catch (error) {
      return {
        ok: false,
        message: '登録処理に失敗しました。\n店舗スタッフまでお声かけください',
      };
    }
  } else {
    if (!participant) return loginError;
    if (!participant.active) {
      return {
        ok: false,
        message: 'このニックネームは停止されています。\nスタッフにお声がけください。',
      };
    }
    if (participant.pin !== cleanPin) return loginError;
  }

  if (!participant || !participant.participantId) {
    return {
      ok: false,
      message: '参加情報の確認に失敗しました。\n店舗スタッフまでお声かけください',
    };
  }

  const token = Utilities.getUuid() + Utilities.getUuid();
  const now = new Date();
  const expires = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30);
  getSheet(SESSIONS_SHEET).appendRow([token, participant.participantId, now.toISOString(), expires.toISOString()]);
  // 直後の記録送信で「まだ見えない」状態を防ぐ
  SpreadsheetApp.flush();

  return {
    ok: true,
    session: {
      token,
      participantId: participant.participantId,
      nickname: participant.nickname,
      division: participant.division,
      expiresAt: expires.toISOString(),
    },
  };
}

function upsertRecord(token, body, eventObject) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(8000)) {
      return {
        ok: false,
        message: '混み合っています。\n少し待ってからもう一度「記録を送信する」を押してください。',
      };
    }
  } catch (error) {
    return {
      ok: false,
      message: '混み合っています。\n少し待ってからもう一度「記録を送信する」を押してください。',
    };
  }

  try {
    const participant = resolveParticipantForRecord(token, body);
    if (!participant) {
      return {
        ok: false,
        message: 'ログイン情報が切れました。\n一度ログアウトして、再度ログインしてください。',
      };
    }
    if (!participant.active) {
      return {
        ok: false,
        message: 'このニックネームは停止されています。\nスタッフにお声がけください。',
      };
    }

    const week = getCurrentWeek();
    const score = Number(body.score);
    const inputBy = body.inputBy === 'staff' ? 'staff' : 'self';
    if (!Number.isFinite(score)) return { ok: false, message: '記録を数字で入力してください。' };
    if (week.week === 1) {
      if (!Number.isInteger(score) || score < 1 || score > 99) {
        return { ok: false, message: '握力は1〜99の数字で入力してください。' };
      }
    } else if (score < -1000 || score > 10000) {
      return { ok: false, message: '記録の数値を確認してください。' };
    }

    const now = new Date();
    const dateKey = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
    const sheet = getSheetByNameFast(week.sheet);
    const existing = findParticipantEventRow(sheet, participant.participantId);
    const dates = existing ? [existing.date1, existing.date2, existing.date3] : [];
    const scores = existing ? [existing.score1, existing.score2, existing.score3] : [];
    const filled = scores.filter(value => Number.isFinite(value)).length;

    if (filled >= 3) return { ok: false, message: 'この週のチャレンジはすでに3回分登録されています。' };
    if (dates.some(value => value === dateKey)) return { ok: false, message: '同じ日の登録は1回までです。' };

    const slot = filled; // 0,1,2
    const userAgent = eventObject && eventObject.parameter ? String(eventObject.parameter.userAgent || '') : '';
    const isoNow = now.toISOString();

    if (!existing) {
      sheet.appendRow([
        participant.participantId,
        isoNow,
        isoNow,
        participant.division,
        participant.nickname,
        week.unit,
        1,
        score, '', '',
        dateKey, '', '',
        inputBy,
        userAgent,
      ]);
    } else {
      // 2回目以降は必要セルだけ更新（行まるごと書き換えで落ちる対策）
      const attempts = filled + 1;
      sheet.getRange(existing.rowNumber, 3).setValue(isoNow); // updatedAt
      sheet.getRange(existing.rowNumber, 7).setValue(attempts); // attempts
      sheet.getRange(existing.rowNumber, 8 + slot).setValue(score); // score1/2/3
      sheet.getRange(existing.rowNumber, 11 + slot).setValue(dateKey); // date1/2/3
      if (userAgent) sheet.getRange(existing.rowNumber, 15).setValue(userAgent);
    }

    return {
      ok: true,
      message: '登録しました。',
      record: {
        createdAt: isoNow,
        dateKey,
        participantId: participant.participantId,
        displayName: participant.nickname,
        week: week.week,
        event: week.event,
        score,
        unit: week.unit,
        division: participant.division,
        attempt: slot + 1,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: humanizeServerError(error && error.message),
    };
  } finally {
    try { lock.releaseLock(); } catch (error) {}
  }
}

function getSheetByNameFast(name) {
  const sheet = getSpreadsheet().getSheetByName(name);
  if (!sheet) return getSheet(name);
  return sheet;
}

function findParticipantEventRow(sheet, participantId) {
  const id = String(participantId || '').trim();
  if (!id) return null;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const values = sheet.getRange(2, 1, lastRow, EVENT_HEADERS.length).getValues();
  for (let i = 0; i < values.length; i += 1) {
    if (String(values[i][0] || '').trim() !== id) continue;
    return {
      rowNumber: i + 2,
      score1: toOptionalNumber(values[i][7]),
      score2: toOptionalNumber(values[i][8]),
      score3: toOptionalNumber(values[i][9]),
      date1: normalizeDateKey(values[i][10]),
      date2: normalizeDateKey(values[i][11]),
      date3: normalizeDateKey(values[i][12]),
      userAgent: values[i][14],
    };
  }
  return null;
}

function resolveParticipantForRecord(token, body) {
  // 1) ニックネーム＋PINを最優先（新規登録直後でも確実）
  const cleanNickname = normalizeNickname(body && body.nickname);
  const cleanPin = normalizePin(body && body.pin);
  if (cleanNickname && /^[0-9]{4}$/.test(cleanPin)) {
    const byName = findParticipantByNickname(cleanNickname);
    if (byName && byName.active && byName.pin === cleanPin) return byName;
  }

  // 2) セッショントークン
  const session = findSession(token);
  if (session) {
    const byId = findParticipant(session.participantId);
    if (byId && byId.active) return byId;
  }

  // 3) 端末の participantId ＋ PIN
  const bodyId = String(body && body.participantId || '').trim();
  if (bodyId && cleanNickname && /^[0-9]{4}$/.test(cleanPin)) {
    const byBodyId = findParticipant(bodyId);
    if (byBodyId && byBodyId.active && byBodyId.nicknameKey === nicknameKey(cleanNickname) && byBodyId.pin === cleanPin) {
      return byBodyId;
    }
  }

  return null;
}

function readPublicState() {
  setupSheets();
  return {
    ok: true,
    eventEnded: EVENT_ENDED,
    weeks: EVENT_WEEKS,
    currentWeek: getCurrentWeek(),
    records: publicRecords(),
    rankings: buildAllRankings(),
    stats: buildStats(),
  };
}

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function renameLegacySheetIfNeeded(legacyName, nextName) {
  const ss = getSpreadsheet();
  const legacy = ss.getSheetByName(legacyName);
  const next = ss.getSheetByName(nextName);
  if (legacy && !next) legacy.setName(nextName);
}

function getSheet(name) {
  if (name === PARTICIPANTS_SHEET) return ensureSheet(PARTICIPANTS_SHEET, PARTICIPANT_HEADERS);
  if (name === SESSIONS_SHEET) return ensureSheet(SESSIONS_SHEET, SESSION_HEADERS);
  const week = EVENT_WEEKS.find(item => item.sheet === name);
  if (week) return ensureSheet(week.sheet, EVENT_HEADERS);
  throw new Error('Unknown sheet');
}

function ensureSheet(name, headers) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const width = Math.max(sheet.getLastColumn(), headers.length);
  const values = sheet.getRange(1, 1, 1, width).getValues()[0];
  const needsHeader = headers.some((header, index) => values[index] !== header);
  if (needsHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getParticipants() {
  if (typeof getParticipants._cache !== 'undefined' && getParticipants._cache) {
    return getParticipants._cache;
  }
  const rows = readRows(getSheet(PARTICIPANTS_SHEET), PARTICIPANT_HEADERS)
    .map(r => ({
      participantId: String(r.participantId || '').trim(),
      nickname: normalizeNickname(r.nickname),
      nicknameKey: nicknameKey(r.nickname),
      pin: normalizePin(r.pin),
      division: String(r.division || '').trim().toLowerCase() === 'staff' ? 'staff' : 'member',
      active: isParticipantActive(r.active),
    }))
    .filter(r => r.participantId && r.nickname);
  getParticipants._cache = rows;
  return rows;
}

function findParticipant(participantId) {
  const id = String(participantId || '').trim();
  return getParticipants().find(p => p.participantId === id);
}

function findParticipantByNickname(nickname) {
  const key = nicknameKey(nickname);
  if (!key) return null;
  return getParticipants().find(p => p.nicknameKey === key);
}

function createParticipant(nickname, pin) {
  const now = new Date().toISOString();
  const cleanNickname = normalizeNickname(nickname);
  const cleanPin = normalizePin(pin);
  const participant = {
    participantId: Utilities.getUuid(),
    nickname: cleanNickname,
    pin: cleanPin,
    division: 'member',
    active: true,
  };
  const sheet = getSheet(PARTICIPANTS_SHEET);
  sheet.appendRow([
    participant.participantId,
    participant.nickname,
    participant.pin,
    'member',
    true,
    '自動登録',
    now,
    now,
  ]);
  // PINが数値化されて先頭0落ちしないようテキスト書式で固定
  const row = sheet.getLastRow();
  sheet.getRange(row, 3).setNumberFormat('@').setValue(cleanPin);
  SpreadsheetApp.flush();
  return participant;
}

function findSession(token) {
  const value = String(token || '').trim();
  if (!value) return null;
  const sheet = getSheet(SESSIONS_SHEET);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const rowCount = lastRow - 1;
  const values = sheet.getRange(2, 1, rowCount, SESSION_HEADERS.length).getValues();
  const now = new Date();

  for (let i = values.length - 1; i >= 0; i -= 1) {
    const row = values[i];
    if (String(row[0] || '').trim() !== value) continue;
    const expiresAt = row[3];
    if (expiresAt && new Date(expiresAt) < now) return null;
    return {
      token: String(row[0] || '').trim(),
      participantId: String(row[1] || '').trim(),
      createdAt: row[2],
      expiresAt: row[3],
    };
  }
  return null;
}

function readEventRows(week) {
  const sheet = getSheet(week.sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow, EVENT_HEADERS.length).getValues().map((row, index) => {
    const item = {};
    EVENT_HEADERS.forEach((header, col) => item[header] = row[col]);
    return {
      rowNumber: index + 2,
      participantId: String(item.participantId || '').trim(),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      division: item.division === 'staff' ? 'staff' : 'member',
      displayName: String(item.displayName || '').trim(),
      unit: item.unit || week.unit,
      attempts: Number(item.attempts) || 0,
      score1: toOptionalNumber(item.score1),
      score2: toOptionalNumber(item.score2),
      score3: toOptionalNumber(item.score3),
      date1: normalizeDateKey(item.date1),
      date2: normalizeDateKey(item.date2),
      date3: normalizeDateKey(item.date3),
      inputBy: item.inputBy,
      userAgent: item.userAgent,
      week: week.week,
      event: week.event,
    };
  }).filter(row => row.participantId);
}

function getAllEventRows() {
  return EVENT_WEEKS.reduce((all, week) => all.concat(readEventRows(week)), []);
}

function flattenRecords(rows) {
  const records = [];
  rows.forEach(row => {
    [
      { score: row.score1, dateKey: row.date1, attempt: 1 },
      { score: row.score2, dateKey: row.date2, attempt: 2 },
      { score: row.score3, dateKey: row.date3, attempt: 3 },
    ].forEach(slot => {
      if (!Number.isFinite(slot.score)) return;
      records.push({
        createdAt: row.updatedAt || row.createdAt,
        dateKey: slot.dateKey,
        participantId: row.participantId,
        displayName: row.displayName,
        week: row.week,
        event: row.event,
        score: slot.score,
        unit: row.unit,
        division: row.division,
        attempt: slot.attempt,
      });
    });
  });
  return records;
}

function publicRecords() {
  return flattenRecords(getAllEventRows());
}

function readRows(sheet, headers) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow, headers.length).getValues().map(row => {
    const item = {};
    headers.forEach((header, index) => item[header] = row[index]);
    return item;
  });
}

function buildStats() {
  const records = publicRecords();
  const current = getCurrentWeek();
  const currentRecords = records.filter(r => Number(r.week) === current.week);
  const participants = {};
  currentRecords.forEach(r => participants[r.participantId] = true);
  return {
    currentWeek: current.week,
    participants: Object.keys(participants).length,
    attempts: currentRecords.length,
    tickets: records.length,
  };
}

function buildAllRankings() {
  return EVENT_WEEKS.reduce((all, week) => {
    all[week.week] = buildRanking(readEventRows(week), week);
    return all;
  }, {});
}

function buildRanking(rows, week) {
  const ranked = rows.map(row => {
    const scores = [row.score1, row.score2, row.score3].filter(value => Number.isFinite(value));
    const best = scores.length ? Math.max.apply(null, scores) : 0;
    return {
      displayName: row.displayName,
      week: week.week,
      event: week.event,
      unit: week.unit,
      division: row.division,
      attempts: scores.length,
      best,
      // 互換のため total にも最高記録を入れる（合計ではない）
      total: best,
      score1: row.score1,
      score2: row.score2,
      score3: row.score3,
    };
  }).filter(row => row.attempts > 0);

  ranked.sort((a, b) => week.higherIsBetter ? b.best - a.best : a.best - b.best);
  return ranked.slice(0, 10).map((row, index) => ({ ...row, rank: index + 1 }));
}

function buildFullRanking(rows, week) {
  const ranked = rows.map(row => {
    const scores = [row.score1, row.score2, row.score3].filter(value => Number.isFinite(value));
    const best = scores.length ? Math.max.apply(null, scores) : 0;
    return {
      displayName: row.displayName,
      week: week.week,
      event: week.event,
      unit: week.unit,
      division: row.division,
      attempts: scores.length,
      best,
      score1: row.score1,
      score2: row.score2,
      score3: row.score3,
      date1: row.date1,
      date2: row.date2,
      date3: row.date3,
    };
  }).filter(row => row.attempts > 0);

  ranked.sort((a, b) => week.higherIsBetter ? b.best - a.best : a.best - b.best);
  return ranked.map((row, index) => ({ ...row, rank: index + 1 }));
}

function migrateLegacyRecordsIfNeeded() {
  const ss = getSpreadsheet();
  const legacy = ss.getSheetByName(LEGACY_RECORDS_SHEET);
  if (!legacy || legacy.getLastRow() < 2) return;

  const hasAnyEventData = EVENT_WEEKS.some(week => getSheet(week.sheet).getLastRow() >= 2);
  if (hasAnyEventData) return;

  const legacyHeaders = ['id', 'createdAt', 'dateKey', 'participantId', 'displayName', 'week', 'event', 'score', 'unit', 'division', 'inputBy', 'userAgent'];
  const legacyRows = readRows(legacy, legacyHeaders).filter(row => row.participantId && Number.isFinite(Number(row.score)));
  if (!legacyRows.length) return;

  const grouped = {};
  legacyRows.forEach(row => {
    const weekNo = Number(row.week);
    const week = EVENT_WEEKS.find(item => item.week === weekNo);
    if (!week) return;
    const key = `${weekNo}::${row.participantId}`;
    if (!grouped[key]) {
      grouped[key] = {
        week,
        participantId: String(row.participantId).trim(),
        displayName: String(row.displayName || '').trim(),
        division: row.division === 'staff' ? 'staff' : 'member',
        unit: row.unit || week.unit,
        createdAt: row.createdAt || new Date().toISOString(),
        scores: [],
        dates: [],
        inputBy: row.inputBy || 'self',
        userAgent: row.userAgent || '',
      };
    }
    if (grouped[key].scores.length >= 3) return;
    grouped[key].scores.push(Number(row.score));
    grouped[key].dates.push(normalizeDateKey(row.dateKey));
  });

  Object.keys(grouped).forEach(key => {
    const item = grouped[key];
    const sheet = getSheet(item.week.sheet);
    sheet.appendRow([
      item.participantId,
      item.createdAt,
      item.createdAt,
      item.division,
      item.displayName,
      item.unit,
      item.scores.length,
      item.scores[0] != null ? item.scores[0] : '',
      item.scores[1] != null ? item.scores[1] : '',
      item.scores[2] != null ? item.scores[2] : '',
      item.dates[0] || '',
      item.dates[1] || '',
      item.dates[2] || '',
      item.inputBy,
      item.userAgent,
    ]);
  });
}

function getCurrentWeek() {
  if (TEST_WEEK_OVERRIDE) {
    return EVENT_WEEKS.find(week => week.week === TEST_WEEK_OVERRIDE) || EVENT_WEEKS[0];
  }
  const now = new Date();
  const active = EVENT_WEEKS.find(week => {
    const start = new Date(`${week.start}T00:00:00+09:00`);
    const end = new Date(`${week.end}T23:59:59+09:00`);
    return now >= start && now <= end;
  });
  if (active) return active;
  if (now < new Date(`${EVENT_WEEKS[0].start}T00:00:00+09:00`)) return EVENT_WEEKS[0];
  return EVENT_WEEKS[EVENT_WEEKS.length - 1];
}

function toOptionalNumber(value) {
  if (value === '' || value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeDateKey(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return String(value).slice(0, 10);
}

function jsonResponse(payload, e) {
  const callback = e && e.parameter ? cleanCallbackName(e.parameter.callback) : '';
  const body = callback ? `${callback}(${JSON.stringify(payload)});` : JSON.stringify(payload);
  const mimeType = callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON;
  return ContentService.createTextOutput(body).setMimeType(mimeType);
}

function cleanCallbackName(value) {
  const callback = String(value || '');
  return /^[a-zA-Z_$][0-9a-zA-Z_$]*$/.test(callback) ? callback : '';
}

function cleanText(value, maxLength) {
  return String(value || '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function normalizeNickname(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 16);
}

function nicknameKey(value) {
  return normalizeNickname(value).toLowerCase();
}

function isParticipantActive(value) {
  // 空欄は有効扱い。明示的な停止だけ無効にする（誤判定防止）
  if (value === '' || value == null) return true;
  if (value === true || value === 1) return true;
  const raw = String(value).trim().toUpperCase();
  if (!raw) return true;
  if (raw === 'FALSE' || raw === '0' || raw === 'NG' || raw === 'NO' || raw === '停止') return false;
  return raw === 'TRUE' || raw === '1' || raw === 'YES' || raw === '有効';
}

function humanizeServerError(message) {
  const raw = String(message || '');
  if (/lock|timeout|timed out|exceeded maximum|service invoked too many|quota/i.test(raw)) {
    return '混み合っています。\n少し待ってからもう一度お試しください。';
  }
  if (/Unknown sheet/i.test(raw)) {
    return 'システム準備中です。\nスタッフにお声がけください。';
  }
  if (!raw) return '処理に失敗しました。\nもう一度お試しください。';
  // すでに日本語の案内はそのまま使う
  if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(raw)) return raw;
  return '通信に失敗しました。\nもう一度お試しください。';
}

function buildFinalReportSheet() {
  setupSheets();
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(FINAL_REPORT_SHEET);
  if (sheet) ss.deleteSheet(sheet);
  sheet = ss.insertSheet(FINAL_REPORT_SHEET, 0);

  const generatedAt = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  const memberRows = getAllEventRows().filter(row => row.division !== 'staff');
  const registered = getParticipants().filter(p => p.active && p.division !== 'staff');
  const participantMap = {};

  registered.forEach(p => {
    participantMap[p.participantId] = {
      nickname: p.nickname,
      division: p.division,
      weeks: {},
      totalAttempts: 0,
    };
  });

  memberRows.forEach(row => {
    const scores = [row.score1, row.score2, row.score3].filter(value => Number.isFinite(value));
    if (!scores.length) return;
    if (!participantMap[row.participantId]) {
      participantMap[row.participantId] = {
        nickname: row.displayName,
        division: row.division,
        weeks: {},
        totalAttempts: 0,
      };
    }
    const item = participantMap[row.participantId];
    item.weeks[row.week] = {
      event: row.event,
      unit: row.unit,
      best: Math.max.apply(null, scores),
      attempts: scores.length,
      score1: row.score1,
      score2: row.score2,
      score3: row.score3,
      date1: row.date1,
      date2: row.date2,
      date3: row.date3,
    };
    item.totalAttempts += scores.length;
  });

  const participants = Object.keys(participantMap).map(id => ({ id, ...participantMap[id] }));
  const recorded = participants.filter(p => p.totalAttempts > 0);
  const totalAttempts = recorded.reduce((sum, p) => sum + p.totalAttempts, 0);
  const values = [];

  function pushRow(cells) {
    values.push(cells);
  }

  pushRow(['JOYFIT24 経堂 9周年チャレンジ 最終結果']);
  pushRow(['集計日時', generatedAt]);
  pushRow(['イベント期間', '2026/08/03 〜 2026/08/30']);
  pushRow([]);
  pushRow(['■ サマリー']);
  pushRow(['登録参加者数', registered.length]);
  pushRow(['記録のある参加者数', recorded.length]);
  pushRow(['総チャレンジ回数（くじ口数）', totalAttempts]);
  EVENT_WEEKS.forEach(week => {
    const count = memberRows.filter(r => r.week === week.week && [r.score1, r.score2, r.score3].some(Number.isFinite)).length;
    pushRow([`第${week.week}週 ${week.event} 参加者`, count]);
  });
  pushRow([]);

  EVENT_WEEKS.forEach(week => {
    pushRow([`■ 第${week.week}週 ${week.event}（${week.unit}）ランキング`]);
    pushRow(['順位', 'ニックネーム', '最高記録', '挑戦回数', '1回目', '2回目', '3回目', '1回目日付', '2回目日付', '3回目日付']);
    const ranked = buildFullRanking(readEventRows(week).filter(r => r.division !== 'staff'), week);
    if (!ranked.length) {
      pushRow(['-', '記録なし', '', '', '', '', '', '', '', '']);
    } else {
      ranked.forEach(item => {
        pushRow([
          item.rank,
          item.displayName,
          item.best,
          item.attempts,
          item.score1 === null || item.score1 === '' ? '' : item.score1,
          item.score2 === null || item.score2 === '' ? '' : item.score2,
          item.score3 === null || item.score3 === '' ? '' : item.score3,
          item.date1 || '',
          item.date2 || '',
          item.date3 || '',
        ]);
      });
    }
    pushRow([]);
  });

  pushRow(['■ 参加者一覧（週別最高記録）']);
  pushRow(['ニックネーム', '第1週 握力(kg)', '第2週 前屈(cm)', '第3週 プランク(秒)', '第4週 腕立て(回)', '合計挑戦回数', 'くじ口数']);
  participants
    .sort((a, b) => a.nickname.localeCompare(b.nickname, 'ja'))
    .forEach(p => {
      pushRow([
        p.nickname,
        p.weeks[1] ? p.weeks[1].best : '',
        p.weeks[2] ? p.weeks[2].best : '',
        p.weeks[3] ? p.weeks[3].best : '',
        p.weeks[4] ? p.weeks[4].best : '',
        p.totalAttempts,
        p.totalAttempts,
      ]);
    });
  pushRow([]);

  pushRow(['■ くじ抽選用（挑戦回数＝口数）']);
  pushRow(['ニックネーム', '口数']);
  recorded
    .sort((a, b) => b.totalAttempts - a.totalAttempts || a.nickname.localeCompare(b.nickname, 'ja'))
    .forEach(p => pushRow([p.nickname, p.totalAttempts]));

  const width = Math.max.apply(null, values.map(cells => cells.length));
  const normalized = values.map(cells => {
    const rowValues = cells.slice();
    while (rowValues.length < width) rowValues.push('');
    return rowValues;
  });
  sheet.getRange(1, 1, normalized.length, width).setValues(normalized);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, width).merge().setFontSize(16).setFontWeight('bold').setBackground('#bd0e2b').setFontColor('#ffffff');
  sheet.getRange(2, 1, 3, 2).setFontWeight('bold');

  normalized.forEach((cells, index) => {
    const label = String(cells[0] || '');
    const rowNo = index + 1;
    if (/^■/.test(label)) sheet.getRange(rowNo, 1, rowNo, width).setBackground('#f4e8eb').setFontWeight('bold');
    if (label === '順位' || (label === 'ニックネーム' && cells[1] === '口数')) {
      sheet.getRange(rowNo, 1, rowNo, width).setBackground('#f4e8eb').setFontWeight('bold');
    }
    if (label === 'ニックネーム' && cells[1] === '第1週 握力(kg)') {
      sheet.getRange(rowNo, 1, rowNo, width).setBackground('#f4e8eb').setFontWeight('bold');
    }
  });

  sheet.autoResizeColumns(1, width);

  return {
    ok: true,
    message: `「${FINAL_REPORT_SHEET}」シートを作成しました。`,
    summary: {
      registered: registered.length,
      recorded: recorded.length,
      totalAttempts,
    },
  };
}

function normalizePin(value) {
  if (value === '' || value == null) return '';

  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n < 0 || n > 9999) return '';
    return String(n).padStart(4, '0');
  }

  if (Object.prototype.toString.call(value) === '[object Date]') return '';

  let raw = String(value).trim();
  // 全角数字 → 半角
  raw = raw.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  // 数字以外を除去（スペースや記号混入対策）
  raw = raw.replace(/[^\d]/g, '');
  if (!raw) return '';
  if (raw.length > 4) raw = raw.slice(0, 4);
  return raw.padStart(4, '0');
}
