// 문항 docx → {units, questions}. 원문 글자는 그대로 두고 구조만 읽는다.
// 형식: "학습 1. 단원명" / "01. 발문 [교과서 3쪽]" / "① 보기 ✓ 정답"
(function (root) {
  const UNIT = /^학습\s*(\d+)\.\s*(.+)$/;
  const QUES = /^(\d{1,3})\.\s*(.+?)\s*(?:\[(교과서[^\]]*)\])?\s*$/;
  const OPT = /^([①②③④⑤])\s*(.*?)\s*(✓\s*정답)?\s*$/;

  function parseLines(lines) {
    const units = [], questions = [], problems = [];
    let unitNo = null, cur = null;
    for (const raw of lines) {
      const line = raw.replace(/ /g, ' ').trim();
      if (!line) continue;
      let m = line.match(UNIT);
      if (m) { unitNo = Number(m[1]); units.push({ unit_no: unitNo, title: m[2].trim() }); continue; }
      m = line.match(OPT);
      if (m && cur) {
        if (m[3]) {
          if (cur.answer !== null) problems.push(`${cur.q_no}번: 정답 표시가 두 개 이상입니다.`);
          cur.answer = cur.options.length;
        }
        cur.options.push(m[2]);
        continue;
      }
      m = line.match(QUES);
      if (m && unitNo !== null) {
        cur = { q_no: Number(m[1]), unit_no: unitNo, stem: m[2],
                page: (m[3] || '').replace('교과서', '').trim(), options: [], answer: null, group: '' };
        questions.push(cur);
      }
    }
    const seen = new Set();
    for (const q of questions) {
      if (q.answer === null) problems.push(`${q.q_no}번: '✓ 정답' 표시를 찾지 못했습니다.`);
      if (q.options.length < 2 || q.options.length > 5) problems.push(`${q.q_no}번: 보기가 ${q.options.length}개입니다.`);
      if (seen.has(q.q_no)) problems.push(`${q.q_no}번: 문항 번호가 겹칩니다.`);
      seen.add(q.q_no);
    }
    if (!questions.length) problems.push('문항을 하나도 찾지 못했습니다. 파일 형식을 확인해 주세요.');
    return { units, questions, problems };
  }

  // word/document.xml의 문단 글자만 뽑는다
  function docxXmlToLines(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const lines = [];
    for (const p of doc.getElementsByTagNameNS(W, 'p')) {
      let s = '';
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.namespaceURI === W && c.localName === 't') s += c.textContent;
          else if (c.namespaceURI === W && (c.localName === 'tab')) s += ' ';
          else if (c.namespaceURI === W && (c.localName === 'br' || c.localName === 'cr')) { lines.push(s); s = ''; }
          else if (c.nodeType === 1 && !(c.namespaceURI === W && c.localName === 'p')) walk(c);
        }
      };
      walk(p);
      lines.push(s);
    }
    return lines;
  }

  async function parseDocx(file) {
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('docx 파일이 아닙니다.');
    return parseLines(docxXmlToLines(await entry.async('string')));
  }

  root.PTParse = { parseLines, docxXmlToLines, parseDocx };
})(typeof window !== 'undefined' ? window : globalThis);
