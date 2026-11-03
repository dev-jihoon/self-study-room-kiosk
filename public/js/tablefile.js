/*
 명단 파일 읽기: 엑셀(.xlsx), CSV, 텍스트를 줄과 칸으로 바꾼다. 라이브러리 없이 브라우저 기능만 쓴다.
 - xlsx는 zip 안의 XML이라 DecompressionStream('deflate-raw')로 풀어서 첫 번째 시트를 읽는다.
 - CSV는 UTF-8이 아니면 엑셀이 저장하는 EUC-KR(CP949)로 읽는다.
*/
(function () {
  'use strict';

  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('euc-kr').decode(buf); }
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* zip 목록을 읽어 이름 -> 내용 꺼내는 함수 */
  function unzip(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('엑셀 파일을 열지 못했어요');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const utf8 = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = utf8.decode(u8.subarray(p + 46, p + 46 + nameLen));
      files.set(name, { method, size, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return async function get(name) {
      const f = files.get(name);
      if (!f) return null;
      const start = f.local + 30 + dv.getUint16(f.local + 26, true) + dv.getUint16(f.local + 28, true);
      const data = u8.subarray(start, start + f.size);
      const out = f.method === 0 ? data : f.method === 8 ? await inflate(data) : null;
      if (!out) throw new Error('엑셀 파일을 열지 못했어요');
      return utf8.decode(out);
    };
  }

  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  /* 요소의 글자만 모은다. 한글 엑셀이 넣는 윗주(rPh)는 뺀다 */
  function textOf(el) {
    let s = '';
    el.querySelectorAll('t').forEach((t) => { if (!t.closest('rPh')) s += t.textContent; });
    return s;
  }
  function colIndex(ref) {
    const m = /^([A-Z]+)/.exec(ref || '');
    if (!m) return -1;
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  async function readXlsx(buf) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 엑셀을 못 읽어요. CSV로 저장해서 올려 주세요');
    const get = unzip(buf);
    /* 첫 번째 시트 위치 찾기 */
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = await get('xl/workbook.xml'), rels = await get('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = xml(wb).getElementsByTagName('sheet')[0];
      const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = rid && [...xml(rels).getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
      if (rel) {
        const t = rel.getAttribute('Target');
        sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
      }
    }
    const sheet = await get(sheetPath);
    if (!sheet) throw new Error('엑셀 시트를 찾지 못했어요');
    const ssText = await get('xl/sharedStrings.xml');
    const shared = ssText ? [...xml(ssText).getElementsByTagName('si')].map(textOf) : [];
    const rows = [];
    [...xml(sheet).getElementsByTagName('row')].forEach((row, i) => {
      const r = Number(row.getAttribute('r')) || i + 1;
      const cells = [];
      [...row.getElementsByTagName('c')].forEach((c, j) => {
        const idx = c.getAttribute('r') ? colIndex(c.getAttribute('r')) : j;
        const t = c.getAttribute('t');
        const v = c.getElementsByTagName('v')[0];
        let val = '';
        if (t === 's') val = shared[Number(v && v.textContent)] || '';
        else if (t === 'inlineStr') val = textOf(c);
        else if (v) val = v.textContent;
        cells[idx] = String(val).trim();
      });
      for (let k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = '';
      rows[r - 1] = cells;
    });
    for (let k = 0; k < rows.length; k++) if (!rows[k]) rows[k] = [];
    return rows;
  }

  /* 파일 하나를 표로 읽는다 */
  async function read(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 8));
    if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(buf);
    if (head[0] === 0xd0 && head[1] === 0xcf) throw new Error('예전 엑셀(.xls)은 못 읽어요. 엑셀에서 .xlsx나 CSV로 다시 저장해 주세요');
    return window.KioskCore.parseCsv(decodeText(buf));
  }

  window.TableFile = { read, readXlsx, decodeText };
})();
