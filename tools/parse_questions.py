"""문항 파일(docx를 pandoc으로 바꾼 텍스트)을 JSON으로 바꾼다. 사이트의 JS 파서와 같은 규칙."""
import json
import re
import sys

UNIT = re.compile(r'^학습\s*(\d+)\.\s*(.+)$')
QUES = re.compile(r'^(\d{1,3})\.\s*(.+?)\s*(?:\[(교과서[^\]]*)\])?\s*$')
OPT = re.compile(r'^([①②③④⑤])\s*(.*?)\s*(✓\s*정답)?\s*$')
MARKS = '①②③④⑤'

GROUPS = {
    1: {'g1': [14, 15], 'g2': [31, 32], 'g3': [33, 34]},
    2: {'g1': [4, 5], 'g2': [14, 15, 16], 'g3': [29, 31]},
}


def parse(text, round_no):
    units, qs, unit_no, cur = [], [], None, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = UNIT.match(line)
        if m:
            unit_no = int(m.group(1))
            units.append({'unit_no': unit_no, 'title': m.group(2).strip()})
            continue
        m = OPT.match(line)
        if m and cur is not None:
            if m.group(3):
                cur['answer'] = len(cur['options'])
            cur['options'].append(m.group(2))
            continue
        m = QUES.match(line)
        if m and unit_no is not None:
            cur = {'q_no': int(m.group(1)), 'unit_no': unit_no, 'stem': m.group(2),
                   'page': (m.group(3) or '').replace('교과서', '').strip(), 'options': [], 'answer': None}
            qs.append(cur)
    group_of = {n: g for g, ns in GROUPS.get(round_no, {}).items() for n in ns}
    for q in qs:
        q['group'] = group_of.get(q['q_no'], '')
        assert q['answer'] is not None and len(q['options']) >= 2, q
    return {'units': units, 'questions': qs}


if __name__ == '__main__':
    data = parse(open(sys.argv[1], encoding='utf-8').read(), int(sys.argv[2]))
    print(json.dumps(data, ensure_ascii=False))
