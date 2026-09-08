/**
 * 大運動会 スポーツの日 2026 ─ 申込受付 API（doPost）
 *
 * このファイルは 9周年イベントのスクリプトに同居しているが、既存の処理には一切触れない。
 * 既存APIは doGet（action パラメータ方式）のみを使っており、doPost は未使用だったため
 * ここで新規に定義している。識別子はすべて UNDOKAI_ / undokai で始めて衝突を防いでいる。
 *
 * 同居させている理由:
 *   新規に作った専用スクリプトは、ウェブアプリの「アクセスできるユーザー＝全員」を
 *   コマンドから設定できず匿名アクセスが403になる（Google の仕様。UIでしか変更できない）。
 *   このスクリプトは既に公開設定・権限承認が済んでいるため、ここに追加すれば即座に動く。
 *
 * 保存先: https://docs.google.com/spreadsheets/d/12RWV1AuzciT1YCR_obAi2iwZuVF36Hhq8XNMhLh2V8Y/edit
 * フォーム: https://24kyodo-undokai.vercel.app
 */

const UNDOKAI_SPREADSHEET_ID = '12RWV1AuzciT1YCR_obAi2iwZuVF36Hhq8XNMhLh2V8Y';
const UNDOKAI_SHEET_NAME = '大運動会2026 申込';

/** 申込締切（ISO8601・JST）。空文字なら締切チェックなし */
const UNDOKAI_DEADLINE = '2026-10-12T12:00:00+09:00';

/** 定員。0 なら無制限 */
const UNDOKAI_CAPACITY = 0;

const UNDOKAI_HEADERS = [
  '申込日時',
  'イベント',
  '開催日',
  '開始',
  '終了',
  'お名前',
  '電話番号',
  'ご利用店舗',
  'ホットスタジオOP',
  '当日精算(円)',
  'ご要望',
  'ステータス',
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return undokaiJsonOut_({ ok: false, error: '混み合っています。少し時間をおいて再度お試しください。' });
  }
  try {
    const payload = undokaiParseBody_(e);
    if (!payload) {
      return undokaiJsonOut_({ ok: false, error: 'リクエストの形式が正しくありません。' });
    }

    const name = undokaiTrim_(payload.name);
    const phone = undokaiTrim_(payload.phone);
    if (!name || !phone) {
      return undokaiJsonOut_({ ok: false, error: 'お名前と電話番号は必須です。' });
    }

    if (undokaiIsPastDeadline_()) {
      return undokaiJsonOut_({ ok: false, error: 'お申し込みの受付は終了しました。' });
    }

    const sheet = undokaiGetSheet_();

    if (UNDOKAI_CAPACITY > 0 && Math.max(0, sheet.getLastRow() - 1) >= UNDOKAI_CAPACITY) {
      return undokaiJsonOut_({ ok: false, error: '定員に達したため受付を終了しました。' });
    }

    if (undokaiIsDuplicate_(sheet, name, phone)) {
      return undokaiJsonOut_({
        ok: false,
        error: '同じお名前・電話番号でのお申し込みを既に受け付けています。',
      });
    }

    sheet.appendRow([
      new Date(),
      undokaiTrim_(payload.eventName),
      undokaiTrim_(payload.dateLabel) || undokaiTrim_(payload.date),
      undokaiTrim_(payload.start),
      undokaiTrim_(payload.end),
      name,
      undokaiPhoneCell_(phone),
      undokaiTrim_(payload.storeType),
      undokaiTrim_(payload.hotStudioOption),
      Number(payload.dropInFee) || 0,
      undokaiTrim_(payload.note),
      '受付',
    ]);

    return undokaiJsonOut_({ ok: true });
  } catch (err) {
    return undokaiJsonOut_({
      ok: false,
      error: '保存中にエラーが発生しました: ' + (err && err.message ? err.message : err),
    });
  } finally {
    lock.releaseLock();
  }
}

function undokaiParseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return null;
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return null;
  }
}

function undokaiGetSheet_() {
  const ss = SpreadsheetApp.openById(UNDOKAI_SPREADSHEET_ID);
  let sheet = ss.getSheetByName(UNDOKAI_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(UNDOKAI_SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, UNDOKAI_HEADERS.length).setValues([UNDOKAI_HEADERS]);
    sheet.getRange(1, 1, 1, UNDOKAI_HEADERS.length).setFontWeight('bold').setBackground('#fff2cc');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('yyyy/MM/dd HH:mm');
    // 電話番号は先頭の0が落ちないよう書式をテキストにする
    sheet.getRange('G:G').setNumberFormat('@');
    sheet.setColumnWidth(1, 140);
    sheet.setColumnWidth(2, 200);
    sheet.setColumnWidth(6, 120);
    sheet.setColumnWidth(7, 130);
    sheet.setColumnWidth(11, 240);
  }
  return sheet;
}

function undokaiIsPastDeadline_() {
  if (!UNDOKAI_DEADLINE) return false;
  const limit = new Date(UNDOKAI_DEADLINE).getTime();
  if (isNaN(limit)) return false;
  return Date.now() > limit;
}

function undokaiIsDuplicate_(sheet, name, phone) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  const rows = sheet.getRange(2, 6, lastRow - 1, 2).getDisplayValues(); // F:お名前 / G:電話番号
  const nk = undokaiNormalizeName_(name);
  const pk = undokaiPhoneKey_(phone);
  for (let i = 0; i < rows.length; i++) {
    if (undokaiNormalizeName_(rows[i][0]) === nk && undokaiPhoneKey_(rows[i][1]) === pk) return true;
  }
  return false;
}

function undokaiNormalizeName_(v) {
  return String(v || '').replace(/[\s　]/g, '').replace(/様$/, '');
}

function undokaiDigits_(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

/**
 * 電話番号の照合キー。
 * セルに数値として入ってしまった過去の行は先頭の0が落ちているため、
 * 先頭の0を無視して比較する。
 */
function undokaiPhoneKey_(v) {
  return undokaiDigits_(v).replace(/^0+/, '');
}

/**
 * 「09012345678」のような数字だけの文字列はセルに入れると数値化され
 * 先頭の0が落ちる。ハイフンを入れて文字列として保持する。
 */
function undokaiPhoneCell_(v) {
  const d = undokaiDigits_(v);
  if (/^0[789]0\d{8}$/.test(d)) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  if (/^0\d{9,10}$/.test(d)) return "'" + d;
  return undokaiTrim_(v);
}

function undokaiTrim_(v) {
  return String(v == null ? '' : v).trim();
}

function undokaiJsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 動作確認用。スプレッドシートに1件テスト行を追加する */
function undokaiTestSave() {
  const res = doPost({
    postData: {
      contents: JSON.stringify({
        eventName: '大運動会 スポーツの日 2026',
        date: '2026-10-12',
        dateLabel: '10月12日',
        start: '13:30',
        end: '15:00',
        name: 'テスト 太郎',
        phone: '090-0000-0000',
        storeType: '経堂店の会員',
        hotStudioOption: '契約していない',
        dropInFee: 550,
        note: 'テスト送信',
      }),
    },
  });
  Logger.log(res.getContent());
}
