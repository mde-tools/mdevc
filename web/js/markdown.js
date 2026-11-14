// Markdown の読み込み（Markdown → 画面の HTML）と書き出し（画面の要素 → Markdown）。
//
// 読み込みは2段階：
//  1. parseBlocks：文書を見出し・段落・リスト・表などの「ブロック」に分ける。最上位のブロックには
//     元テキストの中の位置（start〜end）を記録する（編集していないブロックを元のまま保存するため）。
//  2. renderBlock / renderInline：ブロックを画面の HTML にする。
// 書き出しは serializeBlock / serializeInline：画面の要素から Markdown を組み立てる
// （編集したブロックだけに使う。editor.js の Editor.serialize 参照）。
//
// ブロックの種類（parseLines が返すオブジェクトの type）：
//   heading（見出し）・paragraph（段落）・hr（水平線）・code（コードブロック）・quote（引用）・
//   list（箇条書き・番号付きリスト）・table（表）・raw（HTML のブロック・リンクの定義。書かれたまま扱う）

// ===== 段落中の改行の表示（メニュー「表示」→「段落中の改行」。mde と同じ）=====
/**
 * 段落中の改行（空行を挟まない、ソースの単純な改行）を、改行せずに空白として表示するか。
 *  - false：ソースの通りに改行する。改行は <br data-soft> にする
 *  - true：空行が入るまで改行しない（CommonMark・VSCode の Markdown プレビューと同じ。mdew の既定）。
 *    改行は文字の改行（\n）のまま置き、ブラウザが空白として表示する
 * どちらの表示でも、保存する時は改行に戻る（serializeInline）。
 * mdew の既定（true）は main.js が起動時に設定する。ここの初期値は、ブラウザ単体の自動テスト等で使う値。
 */
let s_joinSoftBreaks = false;

/**
 * 段落中の改行の表示を切り替える。次に読み込む・貼り付ける内容から反映される
 * （表示中の文書に反映するには、読み込み直す。main.js の setSoftBreakMode）。
 * @param {boolean} a_join true：空行が入るまで改行しない、false：ソースの通りに改行する
 */
export function setJoinSoftBreaks(a_join) {
  s_joinSoftBreaks = !!a_join;
}

// ===== ブロックの判定に使う正規表現 =====
const RE_FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RE_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RE_HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const RE_QUOTE = /^ {0,3}> ?/;
const RE_LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const RE_HTML_BLOCK_START = /^ {0,3}(?:<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s>/]|$)|<!--)/;
/** 「<img ...>」で始まる行（HTML のブロックにせず、段落の中の画像として表示する。mde と同じ）。 */
const RE_IMG_LINE = /^ {0,3}<img[\s/>]/i;
/** HTML のブロックの始まりの行か（「<img ...>」で始まる行は除く）。RegExp と同じく test で使う。 */
const RE_HTML_BLOCK = { test: (a_line) => RE_HTML_BLOCK_START.test(a_line) && !RE_IMG_LINE.test(a_line) };
/** HTML の画像のタグ（<img src="..." alt="..." style="...">。mde と同じ形）。 */
const RE_IMG_TAG = /^<img\s[^>]*?\/?>/i;
const RE_LINK_DEF = /^ {0,3}\[[^\]]+\]:[ \t]*\S/;
const RE_TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const RE_SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const RE_SETEXT_2 = /^ {0,3}-+[ \t]*$/;

/**
 * 空行（空白とタブだけの行）か。
 * @param {string} a_line 行
 * @returns {boolean}
 */
const isBlank = (a_line) => /^[ \t]*$/.test(a_line);

/**
 * 行頭の空白の数（字下げの深さ）。
 * @param {string} a_line 行
 * @returns {number}
 */
const indentOf = (a_line) => a_line.match(/^ */)[0].length;

/**
 * 表の始まりか（この行に「|」があり、次の行が「|---|---|」の形の区切り行）。
 * @param {string} a_line 行
 * @param {string|undefined} a_next 次の行（文書の最後なら undefined）
 * @returns {boolean}
 */
function isTableStart(a_line, a_next) {
  return null != a_next && a_line.includes('|') && a_next.includes('-') && RE_TABLE_DELIM.test(a_next);
}

/**
 * その行から新しいブロックが始まるか（段落の途中で現れたら段落を終わらせる）。
 * @param {string} a_line 行
 * @param {string|undefined} a_next 次の行（表の始まりの判定に使う）
 * @param {boolean} a_inParagraph 段落の途中か（段落の途中では、割り込めるリストの条件が厳しくなる）
 * @returns {boolean}
 */
function startsBlock(a_line, a_next, a_inParagraph) {
  if (RE_FENCE_OPEN.test(a_line) || RE_HEADING.test(a_line) || RE_HR.test(a_line) ||
      RE_QUOTE.test(a_line) || RE_HTML_BLOCK.test(a_line)) {
    return true;
  }
  const m = a_line.match(RE_LIST_ITEM);
  if (m && m[1].length <= 3) {
    // 段落の途中では、番号付きリストは「1.」から始まる場合だけ、空の項目は割り込まない（CommonMark と同じ）
    if (!a_inParagraph) return true;
    if (!m[4] || '' === m[4].trim()) return false;
    return /^[-*+]$/.test(m[2]) || /^1[.)]$/.test(m[2]);
  }
  return !a_inParagraph && isTableStart(a_line, a_next);
}

/**
 * 行の配列をブロックの配列にする。引用・リストの中身は、記号や字下げを外した行で再帰的に呼ぶ。
 * @param {string[]} a_lines 行の配列（改行を含まない）
 * @returns {object[]} ブロックの配列。各ブロックには種類（type）ごとの内容と、元の行の範囲
 *   （lineStart〜lineEnd、lineEnd は含まない）が入る。
 */
function parseLines(a_lines) {
  const blocks = [];
  let i = 0;
  while (i < a_lines.length) {
    const line = a_lines[i];
    if (isBlank(line)) { i++; continue; }
    const start = i;
    const next = a_lines[i + 1];
    let m;

    if ((m = line.match(RE_FENCE_OPEN)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      // コードブロック：開始と同じ記号・同じ長さ以上の行で閉じる（無ければ文書の終わりまで）
      const indent = m[1].length;
      const fence = m[2];
      const info = m[3].trim();
      const code = [];
      i++;
      let closed = false;
      while (i < a_lines.length) {
        const close = a_lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
        if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { closed = true; i++; break; }
        code.push(a_lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      blocks.push({ type: 'code', fence, info, code: code.join('\n'), closed, lineStart: start, lineEnd: i });
      continue;
    }
    if ((m = line.match(RE_HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] || '', lineStart: start, lineEnd: i + 1 });
      i++;
      continue;
    }
    if (RE_HR.test(line)) {
      blocks.push({ type: 'hr', lineStart: start, lineEnd: i + 1 });
      i++;
      continue;
    }
    if (RE_QUOTE.test(line)) {
      // 引用：「>」で始まる行と、段落の続き（「>」の無い行）をまとめる
      const inner = [];
      let lastWasText = false;
      while (i < a_lines.length) {
        const l = a_lines[i];
        if (RE_QUOTE.test(l)) {
          const content = l.replace(RE_QUOTE, '');
          inner.push(content);
          lastWasText = !isBlank(content);
          i++;
        } else if (lastWasText && !isBlank(l) && !startsBlock(l, a_lines[i + 1], true)) {
          inner.push(l);
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: 'quote', children: parseLines(inner), lineStart: start, lineEnd: i });
      continue;
    }
    if ((m = line.match(RE_LIST_ITEM)) && m[1].length <= 3) {
      const list = parseList(a_lines, i);
      list.lineStart = start;
      blocks.push(list);
      i = list.lineEnd;
      continue;
    }
    if (RE_HTML_BLOCK.test(line) || RE_LINK_DEF.test(line)) {
      // HTML のブロックとリンクの定義は、書かれたままの文字として表示・編集する
      const isDef = RE_LINK_DEF.test(line) && !RE_HTML_BLOCK.test(line);
      i++;
      while (!isDef && i < a_lines.length && !isBlank(a_lines[i])) i++;
      blocks.push({ type: 'raw', text: a_lines.slice(start, i).join('\n'), lineStart: start, lineEnd: i });
      continue;
    }
    if (isTableStart(line, next)) {
      const header = splitTableRow(line);
      const aligns = splitTableRow(next).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      const rows = [];
      i += 2;
      while (i < a_lines.length && !isBlank(a_lines[i]) && !startsBlock(a_lines[i], a_lines[i + 1], false)) {
        rows.push(splitTableRow(a_lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, aligns, rows, lineStart: start, lineEnd: i });
      continue;
    }

    // 段落：空行か、別のブロックの始まりまで
    const para = [line];
    i++;
    let setext = 0;
    while (i < a_lines.length && !isBlank(a_lines[i])) {
      const l = a_lines[i];
      if (RE_SETEXT_1.test(l)) { setext = 1; i++; break; }
      if (RE_SETEXT_2.test(l)) { setext = 2; i++; break; }
      if (startsBlock(l, a_lines[i + 1], true)) break;
      para.push(l);
      i++;
    }
    if (setext) {
      blocks.push({ type: 'heading', level: setext, text: para.join(' ').trim(), setext: true, lineStart: start, lineEnd: i });
    } else {
      blocks.push({ type: 'paragraph', text: para.map((l) => l.replace(/^[ \t]+/, '')).join('\n'), lineStart: start, lineEnd: i });
    }
  }
  return blocks;
}

/**
 * a_start 行目から始まるリストを読む。項目の中身（入れ子のリスト等）は字下げを外して再帰的に読む。
 * 記号の種類（「-」「*」「+」、番号の後ろの「.」「)」）が変わったところで、別のリストとして終わる。
 * @param {string[]} a_lines 行の配列
 * @param {number} a_start リストの最初の項目の行番号
 * @returns {{type:'list', ordered:boolean, startNumber:number, marker:string,
 *   items:{children:object[], task:(boolean|null)}[], loose:boolean, lineEnd:number}}
 *   items の task はチェックボックスの項目なら true（チェックあり）・false（なし）、通常の項目は null。
 *   loose は項目の間に空行があるリスト。lineEnd はリストの次の行の行番号。
 */
function parseList(a_lines, a_start) {
  const first = a_lines[a_start].match(RE_LIST_ITEM);
  const ordered = /\d/.test(first[2]);
  const markerKind = ordered ? first[2].slice(-1) : first[2];
  const list = { type: 'list', ordered, startNumber: ordered ? parseInt(first[2], 10) : 1, marker: first[2], items: [], loose: false };
  let i = a_start;
  while (i < a_lines.length) {
    const m = a_lines[i].match(RE_LIST_ITEM);
    if (!m) break;
    const kind = /\d/.test(m[2]) ? m[2].slice(-1) : m[2];
    if (kind !== markerKind || m[1].length > 3) break;
    const indent = m[1].length;
    const spaces = m[3] || '';
    const contentOffset = indent + m[2].length + (m[4] ? (spaces.length >= 5 ? 1 : spaces.length) : 1);
    const content = [m[4] || ''];
    i++;
    let lastBlank = false;
    while (i < a_lines.length) {
      const l = a_lines[i];
      if (isBlank(l)) {
        // 空行の後が字下げされた行なら、同じ項目の続き
        let k = i;
        while (k < a_lines.length && isBlank(a_lines[k])) k++;
        if (k < a_lines.length && indentOf(a_lines[k]) >= contentOffset) {
          for (; i < k; i++) content.push('');
          lastBlank = true;
          continue;
        }
        break;
      }
      if (indentOf(l) >= contentOffset) {
        content.push(l.slice(contentOffset));
        lastBlank = false;
        i++;
        continue;
      }
      const sibling = l.match(RE_LIST_ITEM);
      if (sibling || lastBlank || startsBlock(l, a_lines[i + 1], true)) break;
      content.push(l.trim()); // 段落の続き（字下げなしで書かれた行）
      i++;
    }
    const children = parseLines(content);
    let task = null;
    const head = children[0];
    if (head && 'paragraph' === head.type) {
      const t = head.text.match(/^\[([ xX])\](?:[ \t]+|$)/);
      if (t) {
        task = 'x' === t[1].toLowerCase();
        head.text = head.text.slice(t[0].length);
      }
    }
    list.items.push({ children, task });
    // 項目の間の空行
    let k = i;
    while (k < a_lines.length && isBlank(a_lines[k])) k++;
    const nextItem = k < a_lines.length ? a_lines[k].match(RE_LIST_ITEM) : null;
    if (k > i && nextItem && nextItem[1].length <= 3 &&
        (/\d/.test(nextItem[2]) ? nextItem[2].slice(-1) : nextItem[2]) === markerKind) {
      list.loose = true;
      i = k;
    }
  }
  list.lineEnd = i;
  return list;
}

/**
 * 表の1行を、セルの文字列の配列にする（「\|」はセルの区切りとみなさない）。
 * @param {string} a_line 表の1行（例：「| a | b |」）。行頭・行末の「|」は省略されていてもよい
 * @returns {string[]} 各セルの文字列（前後の空白を除いたもの）
 */
export function splitTableRow(a_line) {
  let s = a_line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if ('\\' === s[i] && '|' === s[i + 1]) { cur += '\\|'; i++; continue; }
    if ('|' === s[i]) { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * 文書全体を最上位のブロックに分ける。
 * @param {string} a_source 文書の全体（改行は LF、BOM なし）
 * @returns {object[]} 最上位のブロックの配列。各ブロックの start / end は、そのブロックの元テキストの中の
 *   文字の位置（end は含まない。最後の行の改行は含めない）。
 */
export function parseBlocks(a_source) {
  // 各行の先頭の文字の位置を求めておき、ブロックの行の範囲を文字の位置に直す
  const lines = a_source.split('\n');
  const offsets = [];
  let pos = 0;
  for (const l of lines) { offsets.push(pos); pos += l.length + 1; }
  return parseLines(lines).map((b) => {
    b.start = offsets[b.lineStart];
    b.end = offsets[b.lineEnd - 1] + lines[b.lineEnd - 1].length;
    return b;
  });
}

// ===== 画面の HTML を作る =====

/**
 * HTML の特別な文字（& < > "）を文字参照にする。
 * @param {string} a_text 文字列
 * @returns {string} HTML の中（属性値を含む）にそのまま書ける文字列
 */
export function escapeHtml(a_text) {
  return a_text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 表のセルの揃え方を表す属性（保存用の data-align と、表示用の style）。
 * @param {string} a_align 'left' / 'center' / 'right'、指定なしは ''
 * @returns {string} 属性の文字列（先頭に空白付き）。指定なしは ''
 */
const alignAttr = (a_align) => (a_align ? ` data-align="${a_align}" style="text-align:${a_align}"` : '');

/** 表のセルの先頭のチェックボックスの記号（「[ ]」「[x]」。後ろは空白かセルの終わり）。 */
const RE_CELL_CHECKBOX = /^\[([ xX])\](?:[ \t]+|$)/;

/**
 * 表の見出しの行以外のセルの中身を HTML にする。セルの先頭の「[ ]」「[x]」は、チェックボックスにする（箇条書きの
 * チェックボックスと同じ見た目・操作。見出しの行のセルはチェックボックスにしない）。
 * @param {string} a_text セルの Markdown の文字列
 * @returns {string} HTML
 */
function renderBodyCell(a_text) {
  const m = a_text.match(RE_CELL_CHECKBOX);
  if (!m) return renderInline(a_text);
  const box = `<input type="checkbox" contenteditable="false"${'x' === m[1].toLowerCase() ? ' checked' : ''}>`;
  return `${box}${renderInline(a_text.slice(m[0].length)) || '<br>'}`;
}

/**
 * ブロックを画面の HTML にする。中身が空の見出し・段落・項目には、カーソルを置けるよう <br> を入れる。
 * @param {object} a_block parseBlocks・parseLines が返したブロック
 * @returns {string} HTML（ブロック1つ分）。知らない種類のブロックは ''
 */
export function renderBlock(a_block) {
  switch (a_block.type) {
    case 'heading':
      return `<h${a_block.level}>${renderInline(a_block.text) || '<br>'}</h${a_block.level}>`;
    case 'paragraph':
      return `<p>${renderInline(a_block.text) || '<br>'}</p>`;
    case 'hr':
      return '<hr>';
    case 'code':
      return `<pre data-fence="${escapeHtml(a_block.fence)}" data-info="${escapeHtml(a_block.info)}"><code>${escapeHtml(a_block.code)}\n</code></pre>`;
    case 'quote':
      return `<blockquote>${a_block.children.map(renderBlock).join('') || '<p><br></p>'}</blockquote>`;
    case 'raw':
      return `<div class="md-raw">${escapeHtml(a_block.text)}</div>`;
    case 'table': {
      const head = a_block.header.map((c, k) => `<th${alignAttr(a_block.aligns[k])}>${renderInline(c)}</th>`).join('');
      const body = a_block.rows.map((r) =>
        `<tr>${a_block.header.map((_, k) => `<td${alignAttr(a_block.aligns[k])}>${renderBodyCell(r[k] || '')}</td>`).join('')}</tr>`).join('');
      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case 'list': {
      const tag = a_block.ordered ? 'ol' : 'ul';
      const startAttr = a_block.ordered && 1 !== a_block.startNumber ? ` start="${a_block.startNumber}"` : '';
      const items = a_block.items.map((item) => {
        const [first, ...rest] = item.children;
        // 入れ子のリストから始まる項目（「-」だけの行の下に入れ子の項目がある）は、項目自身の行（<br>）を置く。
        // 無いと、項目の記号と入れ子のリストの記号が同じ行に並ぶため
        let inner = first && 'paragraph' === first.type ? renderInline(first.text)
          : (first ? ('list' === first.type ? '<br>' : '') + renderBlock(first) : '');
        inner += rest.map(renderBlock).join('');
        const box = null === item.task ? '' : `<input type="checkbox" contenteditable="false"${item.task ? ' checked' : ''}>`;
        return `<li${null === item.task ? '' : ' class="task"'}>${box}${inner || '<br>'}</li>`;
      }).join('');
      return `<${tag}${startAttr} data-marker="${escapeHtml(a_block.marker)}">${items}</${tag}>`;
    }
    default:
      return '';
  }
}

/**
 * 段落などの中の書式（太字・リンク・画像・インラインコード等）を HTML にする。
 * CommonMark の規則を簡略化したもの。閉じ側の記号が見つからない場合は、記号を文字のまま表示する。
 * 先頭から1文字ずつ見て、書式の始まりの記号があればその書式として読み、無ければ文字として出力する。
 * 文中にそのまま書かれたメールアドレスは、mailto のリンクとして表示する（GitHub と同じ。保存する時は書いたままにする。
 * data-bare="1" の印を付け、serializeInline でリンクの文字だけを書き出す）。
 * @param {string} a_text 段落・見出し・セル等の Markdown の文字列（段落内の改行を含んでよい）
 * @param {boolean} [a_inLink] リンクの文字の中か（リンクの中のメールアドレスは、リンクにしない）
 * @returns {string} HTML
 */
export function renderInline(a_text, a_inLink = false) {
  let out = '';
  let i = 0;
  const s = a_text;
  while (i < s.length) {
    const ch = s[i];
    // バックスラッシュによるエスケープ
    if ('\\' === ch && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    // 改行（ソースの1行の終わり）。既定は mde と同じく見た目も改行する。「空行が入るまで改行しない」の時は、
    // 文字の改行のまま置く（ブラウザが空白として表示する。保存する時はそのまま改行になる）
    if ('\n' === ch) {
      out += s_joinSoftBreaks ? '\n' : '<br data-soft="1">';
      i++;
      continue;
    }
    // インラインコード：同じ数のバッククォートで閉じる
    if ('`' === ch) {
      const run = s.slice(i).match(/^`+/)[0];
      const close = findCodeClose(s, i + run.length, run.length);
      if (close >= 0) {
        let code = s.slice(i + run.length, close).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        out += `<code>${escapeHtml(code)}</code>`;
        i = close + run.length;
      } else {
        out += escapeHtml(run);
        i += run.length;
      }
      continue;
    }
    // 画像・リンク
    if (('!' === ch && '[' === s[i + 1]) || '[' === ch) {
      const isImage = '!' === ch;
      const link = parseLinkAt(s, isImage ? i + 1 : i);
      if (link) {
        const title = link.title ? ` title="${escapeHtml(link.title)}"` : '';
        if (isImage) {
          out += `<img ${imageSrcAttrs(link.url)} alt="${escapeHtml(unescapeMd(link.text))}"${title}>`;
        } else {
          out += `<a href="${escapeHtml(link.url)}"${title}>${renderInline(link.text, true)}</a>`;
        }
        i = link.end;
        continue;
      }
    }
    // 山括弧の URL・メールアドレス、<br>、<u>…</u>、<img ...>
    if ('<' === ch) {
      const rest = s.slice(i);
      let m;
      if ((m = rest.match(RE_IMG_TAG))) {
        out += renderImageTag(m[0]);
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<((?:https?|ftp):\/\/[^\s<>]+)>/i)) || (m = rest.match(/^<(mailto:[^\s<>]+)>/i))) {
        out += `<a href="${escapeHtml(m[1])}" data-auto="1">${escapeHtml(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/))) {
        out += `<a href="mailto:${escapeHtml(m[1])}" data-auto="1">${escapeHtml(m[1])}</a>`;
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<br\s*\/?>/i))) {
        out += '<br>';
        i += m[0].length;
        continue;
      }
      if ((m = rest.match(/^<u>/i))) {
        const close = s.toLowerCase().indexOf('</u>', i + 3);
        if (close > i) {
          out += `<u>${renderInline(s.slice(i + 3, close), a_inLink)}</u>`;
          i = close + 4;
          continue;
        }
      }
    }
    // 強調・取り消し線・ハイライト
    if ('*' === ch || '_' === ch || '~' === ch || '=' === ch) {
      const em = parseEmphasisAt(s, i);
      if (em) {
        const mark = em.mark ? ` data-mark="${em.mark}"` : '';
        out += `<${em.tag}${mark}>${renderInline(em.inner, a_inLink)}</${em.tag}>`;
        i = em.end;
        continue;
      }
    }
    // そのまま書かれたメールアドレス（前がメールアドレス・URL の一部になる文字でない所から始まるもの）
    if (!a_inLink && '@' !== ch && !RE_EMAIL_PREV_CHAR.test(s[i - 1] || '')) {
      const m = s.slice(i).match(RE_BARE_EMAIL);
      if (m) {
        out += `<a href="mailto:${escapeHtml(m[0])}" data-bare="1">${escapeHtml(m[0])}</a>`;
        i += m[0].length;
        continue;
      }
    }
    out += escapeHtml(ch);
    i++;
  }
  return out;
}

/**
 * 文中にそのまま書かれたメールアドレス（文字列の先頭から）。ドメインは「.」で区切られた2つ以上の部分で、最後は英字2文字以上。
 * 終わりの「.」（文の句点）は含めない。
 */
export const RE_BARE_EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9-]|\.[A-Za-z0-9])/;
/** メールアドレスの直前にあると、そこからはメールアドレスとみなさない文字（メールアドレス・URL の一部になる文字）。 */
export const RE_EMAIL_PREV_CHAR = /[A-Za-z0-9._%+\-/@]/;

/**
 * インラインコードの閉じ側（開き側と同じ数のバッククォート）を探す。
 * @param {string} a_s 文字列
 * @param {number} a_from 探し始める位置（開き側の直後）
 * @param {number} a_len 開き側のバッククォートの数
 * @returns {number} 閉じ側の位置。見つからなければ -1
 */
function findCodeClose(a_s, a_from, a_len) {
  let j = a_from;
  while (j < a_s.length) {
    const k = a_s.indexOf('`', j);
    if (k < 0) return -1;
    const run = a_s.slice(k).match(/^`+/)[0];
    if (run.length === a_len) return k;
    j = k + run.length;
  }
  return -1;
}

/**
 * [文字](URL "タイトル") の形のリンク（画像の場合は「!」の次から）を読む。
 * @param {string} a_s 文字列
 * @param {number} a_pos 「[」の位置
 * @returns {{text:string, url:string, title:string, end:number}|null} text はリンクの文字（Markdown のまま）、
 *   url・title はエスケープを外したもの、end はリンクの次の文字の位置。リンクの形でなければ null
 */
function parseLinkAt(a_s, a_pos) {
  // リンクの文字の部分：対応する「]」を探す（入れ子の [] とインラインコードの中は飛ばす）
  let depth = 0;
  let j = a_pos;
  for (; j < a_s.length; j++) {
    const c = a_s[j];
    if ('\\' === c) { j++; continue; }
    if ('`' === c) {
      const run = a_s.slice(j).match(/^`+/)[0];
      const close = findCodeClose(a_s, j + run.length, run.length);
      if (close >= 0) { j = close + run.length - 1; continue; }
    }
    if ('[' === c) depth++;
    else if (']' === c && 0 === --depth) break;
  }
  if (j >= a_s.length || '(' !== a_s[j + 1]) return null;
  const text = a_s.slice(a_pos + 1, j);
  // 参照先：<> で囲まれた形か、空白までの形（対応の取れた括弧は含める）
  let k = j + 2;
  while (' ' === a_s[k]) k++;
  let url = '';
  if ('<' === a_s[k]) {
    const close = a_s.indexOf('>', k);
    if (close < 0) return null;
    url = a_s.slice(k + 1, close);
    k = close + 1;
  } else {
    let paren = 0;
    const from = k;
    for (; k < a_s.length; k++) {
      const c = a_s[k];
      if ('\\' === c) { k++; continue; }
      if (/\s/.test(c)) break;
      if ('(' === c) paren++;
      else if (')' === c) { if (0 === paren) break; paren--; }
    }
    url = a_s.slice(from, k);
  }
  // タイトル（省略可）："…"・'…'・(…) のどれか
  while (' ' === a_s[k]) k++;
  let title = '';
  const q = a_s[k];
  if ('"' === q || "'" === q || '(' === q) {
    const closeChar = '(' === q ? ')' : q;
    const close = a_s.indexOf(closeChar, k + 1);
    if (close < 0) return null;
    title = a_s.slice(k + 1, close);
    k = close + 1;
    while (' ' === a_s[k]) k++;
  }
  if (')' !== a_s[k]) return null;
  return { text, url: unescapeMd(url), title: unescapeMd(title), end: k + 1 };
}

/**
 * **太字**・*斜体*・~~取り消し線~~・==ハイライト== を読む（「_」で囲む形も含む）。
 * @param {string} a_s 文字列
 * @param {number} a_pos 開き側の記号の位置
 * @returns {{tag:string, inner:string, end:number}|null} tag は HTML の要素名（strong・em・s・mark）、
 *   inner は記号の内側の文字列（Markdown のまま）、end は閉じ側の記号の次の位置。書式でなければ null
 */
function parseEmphasisAt(a_s, a_pos) {
  const ch = a_s[a_pos];
  // 「*」は、太字と斜体が重なった「***」や、閉じ側の「*」が続いた「****」も読めるよう、別に読む（parseStarEmphasisAt）
  if ('*' === ch) return parseStarEmphasisAt(a_s, a_pos);
  const prev = a_s[a_pos - 1] || '';
  const doubled = a_s[a_pos + 1] === ch;
  if (('~' === ch || '=' === ch) && !doubled) return null;
  const len = doubled ? 2 : 1;
  const marker = ch.repeat(len);
  const after = a_s[a_pos + len] || '';
  if ('' === after || /\s/.test(after) || after === ch) return null;
  // 「_」は単語の途中では強調にしない（例：clipboard_image_1）
  if ('_' === ch && /[\p{L}\p{N}]/u.test(prev)) return null;
  // 閉じ側の記号を探す（直前が空白のもの・エスケープされたものは閉じ側にしない）
  let j = a_pos + len;
  while (j < a_s.length) {
    const k = a_s.indexOf(marker, j);
    if (k < 0) return null;
    if ('\\' === a_s[k - 1]) { j = k + 1; continue; }
    // 1文字の記号（*斜体*）を探している時に「**」が見つかったら、その中の太字として飛ばす
    if (1 === len && a_s[k + 1] === ch) {
      const inner = a_s.indexOf(ch + ch, k + 2);
      j = inner < 0 ? k + 2 : inner + 2;
      continue;
    }
    const before = a_s[k - 1];
    const next = a_s[k + len] || '';
    if (/\s/.test(before) || k === a_pos + len) { j = k + 1; continue; }
    if ('_' === ch && /[\p{L}\p{N}]/u.test(next)) { j = k + 1; continue; }
    // 取り消し線は <s>（ブラウザ標準の取り消し線の切り替え（execCommand）が <del> を解除できないため）
    const tag = '~' === ch ? 's' : '=' === ch ? 'mark' : 2 === len ? 'strong' : 'em';
    // 「_」で囲んだ斜体は、保存する時も「_」で書く（mark。serializeInline）
    return { tag, inner: a_s.slice(a_pos + len, k), end: k + len, mark: 'em' === tag && '_' === ch ? '_' : '' };
  }
  return null;
}

/**
 * 「*」で始まる **太字**・*斜体* を読む（mde の TryParseEmphasis と同じ考え方）。
 *  - 「***」で始まる時は、斜体を外側として読み（「***a***」「***a** b*」）、読めなければ太字を外側にする（「***a* b**」）
 *  - 太字の閉じ側が3つ以上の「*」の並び（「**a *b***」「**a *b****c*」）の時は、中身に閉じていない「*」が残っていれば、
 *    並びの2つ目から2つを太字の閉じとする（1つ目は中身の斜体の閉じ。残りは、後ろの書式の開き側）
 *  - 斜体の中身の中の「**」は、太字として飛ばして閉じ側を探す。太字として読めない「**」の1つ目は、閉じ側にしてよい
 * 開き側の後ろ・閉じ側の前が空白の場合と、中身が空の場合は書式にしない。インラインコードの中の「*」は使わない。
 * @param {string} a_s 文字列
 * @param {number} a_pos 開き側の「*」の位置
 * @returns {{tag:string, inner:string, end:number, mark:string}|null} parseEmphasisAt と同じ
 */
function parseStarEmphasisAt(a_s, a_pos) {
  const run = countRun(a_s, a_pos, '*');
  const after = a_s[a_pos + run] || '';
  if ('' === after || /\s/.test(after)) return null;
  if (run >= 3) {
    // 斜体を外側にする読み方と、太字を外側にする読み方（中身が斜体で始まる時だけ。「***a**」は、1つ目の「*」を文字として
    // 読む）の両方で読めたら、内側の書式が先に閉じる方にする（「***a* b**」は太字が外側、「***a** b*」は斜体が外側）
    const italic = parseStarItalic(a_s, a_pos, true);
    const bold = parseStarBold(a_s, a_pos);
    const boldInner = bold ? parseStarItalic(bold.inner, 0, false) : null;
    if (!boldInner) return italic;
    if (!italic) return bold;
    const italicInner = parseStarBold(a_s, a_pos + 1);
    return a_pos + 2 + boldInner.end < (italicInner ? italicInner.end : Infinity) ? bold : italic;
  }
  if (2 === run) return parseStarBold(a_s, a_pos);
  return parseStarItalic(a_s, a_pos, false);
}

/**
 * a_pos からの **太字** を読む（parseStarEmphasisAt 参照）。
 * @param {string} a_s 文字列
 * @param {number} a_pos 開き側の「**」の位置
 * @returns {{tag:string, inner:string, end:number, mark:string}|null}
 */
function parseStarBold(a_s, a_pos) {
  const start = a_pos + 2;
  let j = start;
  while (j <= a_s.length) {
    let k = indexOfOutsideCode(a_s, '**', j);
    if (k < 0) return null;
    if (k === start || '\\' === a_s[k - 1]) { j = k + 1; continue; } // 中身は1文字以上
    const run = countRun(a_s, k, '*');
    if (/\s/.test(a_s[k - 1])) { j = k + run; continue; }
    // 閉じ側が3つ以上の並び：中身に閉じていない「*」（1つだけの並びが奇数個）があれば、その閉じの後ろの2つを使う
    if (run >= 3 && 1 === countSingleStars(a_s, start, k) % 2) k += 1;
    return { tag: 'strong', inner: a_s.slice(start, k), end: k + 2, mark: '' };
  }
  return null;
}

/**
 * a_pos からの *斜体* を読む（parseStarEmphasisAt 参照）。
 * @param {string} a_s 文字列
 * @param {number} a_pos 開き側の「*」の位置
 * @param {boolean} a_triple 開き側が「***」の並びか（開き側の直後の「**」を、中身の太字の開き側として読む）
 * @returns {{tag:string, inner:string, end:number, mark:string}|null}
 */
function parseStarItalic(a_s, a_pos, a_triple) {
  const start = a_pos + 1;
  if (!a_triple && '*' === a_s[start]) return null;
  let j = start;
  while (j < a_s.length) {
    const k = indexOfOutsideCode(a_s, '*', j);
    if (k < 0) return null;
    if ('\\' === a_s[k - 1]) { j = k + 1; continue; }
    const run = countRun(a_s, k, '*');
    // 「*x***y**」のような、斜体の閉じと太字の開きが続いた並び：並びの前後が空白でなく、長さが CommonMark の「3の倍数の
    // 規則」に当たらない（1＋並びの長さが3の倍数でない）時は、並びの1つ目を斜体の閉じにする（「*a**b**c*」の「**」は太字の開き）
    if (run >= 2 && k > start && !/\s/.test(a_s[k - 1]) && 0 !== (1 + run) % 3) {
      return { tag: 'em', inner: a_s.slice(start, k), end: k + 1, mark: '' };
    }
    if (run >= 2 || (a_triple && k === start)) {
      // 中身の中の太字：その閉じ側の後ろから探し直す
      const bold = parseStarBold(a_s, k);
      if (bold) { j = bold.end; continue; }
      if (k === start) return null;
    }
    if (k === start || /\s/.test(a_s[k - 1])) { j = k + run; continue; }
    return { tag: 'em', inner: a_s.slice(start, k), end: k + 1, mark: '' };
  }
  return null;
}

/**
 * a_pos から続く a_ch の並びの長さ。
 * @param {string} a_s 文字列
 * @param {number} a_pos 位置
 * @param {string} a_ch 文字
 * @returns {number}
 */
function countRun(a_s, a_pos, a_ch) {
  let k = a_pos;
  while (a_ch === a_s[k]) k++;
  return k - a_pos;
}

/**
 * a_from〜a_to の間の、1つだけの「*」の並びの数（インラインコードの中・エスケープした「*」は数えない）。
 * @param {string} a_s 文字列
 * @param {number} a_from 数え始める位置
 * @param {number} a_to 数え終わる位置（含まない）
 * @returns {number}
 */
function countSingleStars(a_s, a_from, a_to) {
  let count = 0;
  let k = a_from;
  while (k < a_to) {
    const star = indexOfOutsideCode(a_s, '*', k);
    if (star < 0 || star >= a_to) break;
    if ('\\' === a_s[star - 1]) { k = star + 1; continue; } // エスケープした「*」は数えない
    const run = Math.min(countRun(a_s, star, '*'), a_to - star);
    if (1 === run) count++;
    k = star + run;
  }
  return count;
}

/**
 * a_from から a_value を探す。インラインコード（`…`）の中にあるものは飛ばす。
 * @param {string} a_s 文字列
 * @param {string} a_value 探す文字列
 * @param {number} a_from 探し始める位置
 * @returns {number} 見つかった位置。無ければ -1
 */
function indexOfOutsideCode(a_s, a_value, a_from) {
  let from = a_from;
  while (from <= a_s.length) {
    const k = a_s.indexOf(a_value, from);
    const tick = a_s.indexOf('`', from);
    if (tick < 0 || (k >= 0 && k < tick)) return k;
    const ticks = countRun(a_s, tick, '`');
    const close = '\\' === a_s[tick - 1] ? -1 : findCodeClose(a_s, tick + ticks, ticks);
    if (close < 0) {
      from = tick + ticks;
      continue;
    }
    from = close + ticks;
  }
  return -1;
}

/**
 * バックスラッシュによるエスケープを外す（例：「\*」→「*」）。
 * @param {string} a_text 文字列
 * @returns {string}
 */
function unescapeMd(a_text) {
  return a_text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/**
 * 画像の参照先を、img 要素の属性にする。C:\dir\a.png・C:/dir/a.png・file:///C:/dir/a.png のような
 * Windows の絶対パスは、そのままでは「C:」が URL の種類と解釈されて読めないため、「./C:/dir/a.png」として
 * 文書の基準（https://doc.mdew/<世代>/）から要求させる（ホストが絶対パスとして読む。Program.cs の
 * ServeDocumentResource）。書かれたままの参照先は data-src に残し、保存時にはそれを使う（serializeInline）。
 * @param {string} a_url 書かれた参照先
 * @returns {string} 「src="..."」（絶対パスの時は「src="..." data-src="..."」）
 */
function imageSrcAttrs(a_url) {
  let path = null;
  if (/^[a-zA-Z]:[\\/]/.test(a_url)) {
    path = a_url;
  } else if (/^file:\/\/\/[a-zA-Z]:[\\/]/i.test(a_url)) {
    try {
      path = decodeURIComponent(a_url.slice(8));
    } catch (err) {
      path = a_url.slice(8);
    }
  }
  if (null === path) return `src="${escapeHtml(a_url)}"`;
  const src = `./${path.replace(/\\/g, '/').split('/').map((p) => encodeURIComponent(p).replace(/%3A/gi, ':')).join('/')}`;
  return `src="${escapeHtml(src)}" data-src="${escapeHtml(a_url)}"`;
}

/**
 * HTML のタグの属性の値を取り出す（「name="値"」「name='値'」「name=値」の形）。
 * @param {string} a_tag タグの文字列
 * @param {string} a_name 属性の名前
 * @returns {string|null} 値（文字参照は戻したもの）。無ければ null
 */
function tagAttribute(a_tag, a_name) {
  const m = a_tag.match(new RegExp(`\\s${a_name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>/]+))`, 'i'));
  if (!m) return null;
  const value = m[1] ?? m[2] ?? m[3];
  const t = document.createElement('textarea');
  t.innerHTML = value;
  return t.value;
}

/** HTML の画像のタグの style のうち、表示に使うもの（大きさ・余白・配置。他は無視する）。 */
const ALLOWED_IMAGE_STYLES = /^(?:width|height|max-width|max-height|min-width|min-height|margin(?:-[a-z]+)?|vertical-align|float|border(?:-[a-z]+)?|border-radius)$/;

/**
 * HTML の画像のタグ（<img src="..." alt="..." width="..." style="...">）を、画面の img 要素にする。
 * 表示に使うのは src・alt・title・width・height と、style の大きさ等だけ。書かれたままのタグは data-html に
 * 残し、保存時には（編集していなければ）そのまま書き出す（serializeInline）。
 * @param {string} a_tag タグの文字列
 * @returns {string} HTML
 */
function renderImageTag(a_tag) {
  const src = tagAttribute(a_tag, 'src') || '';
  let attrs = imageSrcAttrs(src);
  attrs += ` alt="${escapeHtml(tagAttribute(a_tag, 'alt') || '')}"`;
  const title = tagAttribute(a_tag, 'title');
  if (title) attrs += ` title="${escapeHtml(title)}"`;
  for (const name of ['width', 'height']) {
    const v = tagAttribute(a_tag, name);
    if (v && /^\d+(?:\.\d+)?%?$/.test(v.trim())) attrs += ` ${name}="${escapeHtml(v.trim())}"`;
  }
  const style = (tagAttribute(a_tag, 'style') || '').split(';').map((d) => d.trim()).filter((d) => {
    const k = d.indexOf(':');
    return k > 0 && ALLOWED_IMAGE_STYLES.test(d.slice(0, k).trim().toLowerCase()) && !/url\s*\(|expression/i.test(d);
  }).join(';');
  if (style) attrs += ` style="${escapeHtml(style)}"`;
  return `<img ${attrs} data-html="${escapeHtml(a_tag)}">`;
}

/**
 * 画面の img 要素の、書かれたままの参照先（imageSrcAttrs で data-src に残したもの。無ければ src 属性）。
 * @param {Element} a_img img 要素
 * @returns {string}
 */
export function imageSource(a_img) {
  return a_img.getAttribute('data-src') || a_img.getAttribute('src') || '';
}

// ===== 画面の要素から Markdown を組み立てる =====

/**
 * 文字を Markdown に書き出す時、書式の記号と誤解される文字だけをエスケープする。
 * あわせて、編集用の文字（改行しない空白 U+00A0、カーソル位置の目印のゼロ幅の空白 U+200B）を取り除く。
 * @param {string} a_text 画面の文字（テキストノードの内容）
 * @returns {string} Markdown に書ける文字列
 */
export function escapeText(a_text) {
  let t = a_text.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
  t = t.replace(/\\(?=[!-/:-@[-`{-~])/g, '\\\\');
  t = t.replace(/[*`]/g, '\\$&');
  t = t.replace(/~~/g, '\\~\\~').replace(/==/g, '\\=\\=');
  // 単語の途中でない「_」（前か後ろが英数字でない）はエスケープする（「__」の2つ目も漏らさないよう、前の文字は先読みで見る）
  t = t.replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_');
  t = t.replace(/<(?=[a-zA-Z/!])/g, '\\<');
  // 「[」は、後ろに「](」「][」が続いてリンクと誤解される場合だけエスケープする（[画像] 等はそのまま）
  if (/\]\(|\]\[/.test(t)) t = t.replace(/\[/g, '\\[');
  return t;
}

/**
 * リンク・画像の参照先を Markdown に書く形にする（空白や括弧を含む場合は <> で囲む）。
 * @param {string} a_url 参照先
 * @returns {string}
 */
function linkDestination(a_url) {
  return /[\s()<>]/.test(a_url) ? `<${a_url}>` : a_url;
}

/**
 * リンク・画像のタイトルを Markdown に書く形にする。
 * @param {string|null} a_title タイトル（無ければ null か ''）
 * @returns {string} 「 "タイトル"」の形（先頭に空白付き）。タイトルが無ければ ''
 */
function titlePart(a_title) {
  return a_title ? ` "${a_title.replace(/"/g, '\\"')}"` : '';
}

/** 書式の要素 → 書式の名前（serializeInline）。b：太字、i：斜体、s：取り消し線、m：ハイライト、u：下線。 */
const FORMAT_KIND = { STRONG: 'b', B: 'b', EM: 'i', I: 'i', DEL: 's', S: 's', STRIKE: 's', MARK: 'm', U: 'u' };

/** 範囲が同じ長さの書式を開く時の順（外側から。mde の InlineStyles.STACKABLE_ORDER と同じ考え方）。 */
const FORMAT_ORDER_LIST = ['s', 'b', 'i', 'm', 'u'];

/** 書式の記号（開き側・閉じ側）。斜体の記号（「*」か「_」）は、書き出す時に決める（serializeInline）。 */
const FORMAT_MARKERS = { b: ['**', '**'], s: ['~~', '~~'], m: ['==', '=='], u: ['<u>', '</u>'] };

/** 英数字等の単語の文字（「_」の斜体の前後に来ると、「_」が単語の途中の文字として読まれる）。 */
const RE_WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * 段落などの中身（要素の子）を Markdown の1行（または改行を含む文字列）にする。
 * 書式は、要素の入れ子のまま書くのではなく、文字ごとの書式から書き直す（mde の WriteMarkdownInlineItems と同じ考え方）：
 *  - 書式の範囲の先頭・末尾の空白は、記号の外に出す（「**foo **」は読み直すと太字にならないため）。空白だけの書式は書かない
 *  - 隣り合う同じ書式は1つにまとめる（「**a****b**」にしない）
 *  - 範囲が重なった書式（太字の途中から外まで斜体を付けた等）は、長く続く方を外側にして、内側を分けて書く
 *  - 閉じた記号の直後に別の「*」の記号を開く所は、斜体を「_」で書いて、記号の並びを読み違えないようにする（書ける時だけ）
 *  - 「_斜体_」で書かれていた斜体（data-mark）は、書ける時は「_」のまま書く
 * Shift+Enter 等の改行（<br>）は、前後の文字と同じ書式なら書式を途切れさせない。
 * @param {Element} a_el 段落・見出し・セル・リストの項目等の要素
 * @param {string} [a_open] 外側ですでに付いている書式（FORMAT_KIND の名前を並べたもの。リンクの中の文字等）。
 *   その書式の記号は書かない（書くと「**a **b** c**」のように、読み直した時に別の範囲が太字になる）
 * @returns {string} Markdown。Shift+Enter 等の改行（data-soft の <br>）は改行文字になる
 */
export function serializeInline(a_el, a_open = '') {
  const items = [];
  collectInlineItems(a_el, a_open, false, items);
  if (!items.length) return '';
  const outer = new Set(a_open);
  // 改行（<br>）の書式は、前後の文字に共通の書式にする（前後が同じ書式なら、書式を途切れさせない）
  for (let n = 0; n < items.length; n++) {
    if ('br' !== items[n].type) continue;
    let p = n - 1;
    while (p >= 0 && 'br' === items[p].type) p--;
    let q = n + 1;
    while (q < items.length && 'br' === items[q].type) q++;
    const before = p >= 0 ? items[p].styles : new Set();
    const after = q < items.length ? items[q].styles : new Set();
    items[n].styles = new Set([...before].filter((k) => after.has(k)));
  }
  for (const item of items) for (const k of outer) item.styles.delete(k);
  trimFormatWhiteSpace(items);
  return writeInlineItems(groupInlineItems(items));
}

/**
 * 要素の子を、書式付きの項目の並びにする（serializeInline）。文字は文字のノードごと（先頭・末尾の空白は別）の項目、インラインコード・リンク・画像は
 * それぞれ1つの項目（書き出した Markdown を持つ）、改行は改行の項目にする。
 * @param {Element} a_el 要素
 * @param {string} a_styles 外側の書式（FORMAT_KIND の名前を並べたもの）
 * @param {boolean} a_underscore 外側の斜体が「_」で書かれていたか
 * @param {object[]} a_out 項目を足す配列（{type:'text'|'atom'|'br', text, styles:Set, underscore}）
 */
function collectInlineItems(a_el, a_styles, a_underscore, a_out) {
  for (const node of a_el.childNodes) {
    if (3 === node.nodeType) {
      // 先頭・末尾の空白は別の項目にする（書式の範囲の端の空白を、記号の外に出すため。trimFormatWhiteSpace）
      const m = node.data.replace(/\u200b/g, '').match(/^(\s*)([\s\S]*?)(\s*)$/);
      for (const part of [m[1], m[2], m[3]]) {
        if (part) a_out.push({ type: 'text', text: part, styles: new Set(a_styles), underscore: a_underscore });
      }
      continue;
    }
    if (1 !== node.nodeType) continue;
    const tag = node.tagName;
    const kind = FORMAT_KIND[tag];
    if (kind) {
      const underscore = a_styles.includes('i') ? a_underscore : 'i' === kind && '_' === node.dataset.mark;
      collectInlineItems(node, a_styles.includes(kind) ? a_styles : a_styles + kind, underscore, a_out);
      continue;
    }
    const atom = (a_text) => a_out.push({ type: 'atom', text: a_text, styles: new Set(a_styles), underscore: a_underscore });
    switch (tag) {
      case 'BR':
        // 最後の <br> は、空の行を表示するためにブラウザが置いたもの
        if (node === a_el.lastChild && !node.dataset.soft) break;
        a_out.push({ type: 'br', text: node.dataset.soft ? '\n' : '<br>', styles: new Set(), underscore: false });
        break;
      case 'CODE': {
        let code = node.textContent.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
        if (!code) break;
        // 隣り合うインラインコードは1つにまとめる（「`a``b`」と書くと、読み直した時に別の形になるため）
        const last = a_out[a_out.length - 1];
        if (last && 'atom' === last.type && undefined !== last.code && [...last.styles].sort().join('') === [...a_styles].sort().join('')) {
          code = last.code + code;
          a_out.pop();
        }
        const longest = Math.max(0, ...(code.match(/`+/g) || []).map((r) => r.length));
        const fence = '`'.repeat(longest + 1);
        const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
        atom(`${fence}${pad}${code}${pad}${fence}`);
        a_out[a_out.length - 1].code = code;
        break;
      }
      case 'A': {
        const href = node.getAttribute('href') || '';
        if (node.dataset.bare) {
          // 文中にそのまま書かれていたメールアドレス（renderInline 参照）：書かれたままの文字を書き出す
          atom(node.textContent);
        } else if (node.dataset.auto) {
          // <https://...> や <name@example.com> の形で書かれていたリンク
          const text = node.textContent;
          atom(`<${href.startsWith('mailto:') && !text.startsWith('mailto:') ? text : href}>`);
        } else {
          atom(`[${serializeInline(node, a_styles)}](${linkDestination(href)}${titlePart(node.getAttribute('title'))})`);
        }
        break;
      }
      case 'IMG':
        // HTML のタグで書かれていた画像は、書かれたままのタグで書き出す
        if (node.dataset.html) atom(node.dataset.html);
        else atom(`![${(node.getAttribute('alt') || '').replace(/[[\]]/g, '\\$&')}](${linkDestination(imageSource(node))}${titlePart(node.getAttribute('title'))})`);
        break;
      case 'INPUT':
        break;
      case 'UL': case 'OL': case 'P': case 'DIV': case 'PRE': case 'BLOCKQUOTE': case 'TABLE':
        break; // ブロック要素は serializeBlock 側で扱う
      default:
        collectInlineItems(node, a_styles, a_underscore, a_out);
    }
  }
}

/**
 * 項目が空白（記号の内側に置けないもの）か。
 * @param {object} a_item 項目
 * @returns {boolean}
 */
function isWhiteSpaceItem(a_item) {
  return 'br' === a_item.type || ('text' === a_item.type && /^\s+$/.test(a_item.text));
}

/**
 * 書式ごとに、続いている範囲の先頭・末尾の空白（と改行）から、その書式を外す（記号の内側に空白を置かない）。
 * @param {object[]} a_items 項目
 */
function trimFormatWhiteSpace(a_items) {
  for (const k of FORMAT_ORDER_LIST) {
    let n = 0;
    while (n < a_items.length) {
      if (!a_items[n].styles.has(k)) { n++; continue; }
      let end = n;
      while (end < a_items.length && a_items[end].styles.has(k)) end++;
      let first = n;
      while (first < end && isWhiteSpaceItem(a_items[first])) a_items[first++].styles.delete(k);
      let last = end - 1;
      while (last >= first && isWhiteSpaceItem(a_items[last])) a_items[last--].styles.delete(k);
      n = end;
    }
  }
}

/**
 * 同じ書式の続く文字を1つの項目にまとめる。
 * @param {object[]} a_items 項目
 * @returns {object[]} まとめた項目
 */
function groupInlineItems(a_items) {
  const out = [];
  const key = (a_styles) => [...a_styles].sort().join('');
  for (const item of a_items) {
    const last = out[out.length - 1];
    if ('text' === item.type && last && 'text' === last.type && key(last.styles) === key(item.styles)) {
      last.text += item.text;
    } else {
      out.push({ ...item });
    }
  }
  return out;
}

/**
 * 記号の内側に来た空白を、記号の外へ出す（writeInlineItems）。書式の範囲の端の空白は trimFormatWhiteSpace で外して
 * あるが、範囲が重なった書式を分けて書く所（閉じてすぐ開き直す所）では、開き直した記号の直後に空白が来ることがある。
 * 記号の並び（閉じ側→開き側の順）の前の文字の末尾の空白と、後ろの文字の先頭の空白を、閉じ側と開き側の間に移す。
 * @param {object[]} a_tokens 記号と項目の並び（書き換える）
 */
function moveWhiteSpaceOutOfMarkers(a_tokens) {
  for (let t = 0; t < a_tokens.length;) {
    if ('item' === a_tokens[t].type) { t++; continue; }
    let end = t;
    while (end < a_tokens.length && 'item' !== a_tokens[end].type) end++;
    let split = t;
    while (split < end && 'close' === a_tokens[split].type) split++;
    // 閉じ側の前の空白（改行の項目・文字の末尾の空白）と、開き側の後ろの空白を集める（空白だけの項目は、続けてその先も見る）
    const before = [];
    if (split > t) {
      while (t > 0) {
        const prev = a_tokens[t - 1].item;
        if ('br' === prev.type || ('text' === prev.type && /^\s+$/.test(prev.text))) {
          before.unshift(prev);
          a_tokens.splice(t - 1, 1);
          t--; end--; split--;
          continue;
        }
        const m = 'text' === prev.type ? prev.text.match(/\s+$/) : null;
        if (m) {
          before.unshift({ type: 'text', text: m[0], styles: new Set() });
          prev.text = prev.text.slice(0, -m[0].length);
        }
        break;
      }
    }
    const after = [];
    if (split < end) {
      while (end < a_tokens.length && 'item' === a_tokens[end].type) {
        const next = a_tokens[end].item;
        if ('br' === next.type || ('text' === next.type && /^\s+$/.test(next.text))) {
          after.push(next);
          a_tokens.splice(end, 1);
          continue;
        }
        const m = 'text' === next.type ? next.text.match(/^\s+/) : null;
        if (m) {
          after.push({ type: 'text', text: m[0], styles: new Set() });
          next.text = next.text.slice(m[0].length);
        }
        break;
      }
    }
    const moved = [...before, ...after];
    if (moved.length) {
      a_tokens.splice(split, 0, ...moved.map((a_item) => ({ type: 'item', item: a_item })));
      end += moved.length;
    }
    t = end;
  }
}

/**
 * 書式付きの項目の並びを Markdown にする（serializeInline）。
 * @param {object[]} a_items 項目（groupInlineItems でまとめたもの）
 * @returns {string}
 */
function writeInlineItems(a_items) {
  // 書式ごとに、各項目からその書式が続く長さ（外側にする書式を決めるのに使う）
  const remain = {};
  for (const k of FORMAT_ORDER_LIST) {
    remain[k] = new Array(a_items.length + 1).fill(0);
    for (let n = a_items.length - 1; n >= 0; n--) remain[k][n] = a_items[n].styles.has(k) ? remain[k][n + 1] + 1 : 0;
  }
  // 1回目：記号を開く・閉じる位置を決める（斜体の記号は後で決める）
  const tokens = [];
  const stack = [];
  const runs = [];
  const closeTo = (a_depth) => {
    while (stack.length > a_depth) {
      const run = stack.pop();
      tokens.push({ type: 'close', run });
    }
  };
  for (let n = 0; n < a_items.length; n++) {
    const item = a_items[n];
    let keep = 0;
    while (keep < stack.length && item.styles.has(stack[keep].kind)) keep++;
    closeTo(keep);
    const opening = [...item.styles].filter((k) => !stack.some((r) => r.kind === k));
    opening.sort((a, b) => remain[b][n] - remain[a][n] || FORMAT_ORDER_LIST.indexOf(a) - FORMAT_ORDER_LIST.indexOf(b));
    for (const kind of opening) {
      const run = { kind, underscore: 'i' === kind && item.underscore, contested: false, open: -1, close: -1, marker: '*' };
      runs.push(run);
      stack.push(run);
      tokens.push({ type: 'open', run });
    }
    tokens.push({ type: 'item', item });
  }
  closeTo(0);
  moveWhiteSpaceOutOfMarkers(tokens);
  for (let t = 0; t < tokens.length; t++) {
    if ('open' === tokens[t].type) tokens[t].run.open = t;
    if ('close' === tokens[t].type) tokens[t].run.close = t;
  }
  // 閉じた「*」の記号の直後に「*」の記号を開く所（「**a*b****c*」のような並び）の斜体は、「_」で書く候補にする
  // （「*」が続くと、どこまでが閉じ側か読み違えるため。CommonMark でも「**a*b***_c_」なら正しく読める）
  const isStar = (a_token) => 'i' === a_token.run.kind || 'b' === a_token.run.kind;
  for (let t = 0; t < tokens.length;) {
    if ('item' === tokens[t].type) { t++; continue; }
    let end = t;
    while (end < tokens.length && 'item' !== tokens[end].type) end++;
    const cluster = tokens.slice(t, end);
    if (cluster.some((x) => 'close' === x.type && isStar(x)) && cluster.some((x) => 'open' === x.type && isStar(x))) {
      for (const x of cluster) if ('i' === x.run.kind) x.run.contested = true;
    }
    t = end;
  }
  // 斜体の記号を決める。「_」は、前後が単語の文字でない時だけ使える（単語の途中の「_」は斜体の記号にならない）。
  // 前後の文字は、記号を挟まない隣の文字（a_adjacent。記号を挟む時は記号＝句読点）か、記号を除いた隣の文字
  const charBefore = (a_t, a_adjacent) => {
    for (let t = a_t - 1; t >= 0; t--) {
      if ('item' === tokens[t].type) return tokens[t].item.text.slice(-1);
      if (a_adjacent) return '*';
    }
    return '';
  };
  const charAfter = (a_t, a_adjacent) => {
    for (let t = a_t + 1; t < tokens.length; t++) {
      if ('item' === tokens[t].type) return tokens[t].item.text[0];
      if (a_adjacent) return '*';
    }
    return '';
  };
  const canUnderscore = (a_run, a_adjacent) =>
    !RE_WORD_CHAR.test(charBefore(a_run.open, a_adjacent)) && !RE_WORD_CHAR.test(charAfter(a_run.close, a_adjacent));
  for (const run of runs) {
    if ('i' !== run.kind) continue;
    run.marker = (run.underscore && canUnderscore(run, false)) || (run.contested && canUnderscore(run, true)) ? '_' : '*';
  }
  // 2回目：書き出す
  let out = '';
  let text = '';
  const flush = () => {
    out += escapeText(text);
    text = '';
  };
  for (const token of tokens) {
    if ('item' === token.type) {
      if ('text' === token.item.type) {
        text += token.item.text;
      } else {
        flush();
        out += token.item.text;
      }
      continue;
    }
    flush();
    const run = token.run;
    const markers = 'i' === run.kind ? [run.marker, run.marker] : FORMAT_MARKERS[run.kind];
    out += 'open' === token.type ? markers[0] : markers[1];
  }
  flush();
  return out;
}

/**
 * 段落の各行の先頭が、見出し・リスト・引用の記号と誤解されないようにエスケープする。
 * @param {string} a_text 段落の Markdown
 * @returns {string}
 */
function protectLineStarts(a_text) {
  return a_text.split('\n').map((l) =>
    l.replace(/^(\s*)(#{1,6}(?=\s|$)|>|[-+](?=\s|$)|\d+(?=[.)](\s|$)))/, (m, sp, mark) => `${sp}\\${mark}`)).join('\n');
}

/**
 * 画面のブロック要素を Markdown にする（編集したブロックだけに使う）。
 * @param {HTMLElement} a_el 見出し・段落・コードブロック・引用・リスト・表等の要素
 * @param {{bullet:string}} a_opts 書き出しの設定。bullet は新しく作った箇条書きに使う記号（「-」等）
 * @returns {string} Markdown（末尾の改行なし）。空のブロックは ''
 */
export function serializeBlock(a_el, a_opts) {
  const tag = a_el.tagName;
  if (/^H[1-6]$/.test(tag)) {
    const text = serializeInline(a_el).replace(/\n/g, ' ').trim();
    return `${'#'.repeat(Number(tag[1]))} ${text}`.trimEnd();
  }
  switch (tag) {
    case 'P':
    case 'DIV':
      if (a_el.classList.contains('md-raw')) return a_el.innerText.replace(/\u00a0/g, ' ').replace(/\n$/, '');
      return protectLineStarts(serializeInline(a_el).replace(/\n+$/, ''));
    case 'HR':
      return '---';
    case 'PRE': {
      let code = a_el.innerText.replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
      if (code.endsWith('\n')) code = code.slice(0, -1);
      const info = a_el.dataset.info || '';
      let fence = a_el.dataset.fence || '```';
      const longest = Math.max(0, ...(code.match(new RegExp(`^${fence[0]}{3,}`, 'gm')) || []).map((r) => r.length));
      if (longest >= fence.length) fence = fence[0].repeat(longest + 1);
      return `${fence}${info}\n${code}\n${fence}`;
    }
    case 'BLOCKQUOTE': {
      const parts = [...a_el.children].map((c) => serializeBlock(c, a_opts)).filter((t) => '' !== t);
      return parts.join('\n\n').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    }
    case 'UL':
    case 'OL':
      return serializeList(a_el, a_opts);
    case 'TABLE':
      return serializeTable(a_el);
    default:
      return serializeInline(a_el);
  }
}

/**
 * リスト（ul・ol）を Markdown にする。項目の2行目以降（入れ子のリスト等）は、記号の幅だけ字下げする。
 * @param {HTMLElement} a_el ul・ol 要素
 * @param {{bullet:string}} a_opts serializeBlock と同じ
 * @returns {string} Markdown（末尾の改行なし）
 */
function serializeList(a_el, a_opts) {
  const ordered = 'OL' === a_el.tagName;
  let n = ordered ? parseInt(a_el.getAttribute('start') || '1', 10) : 0;
  const delim = ordered ? ((a_el.dataset.marker || '.').slice(-1) === ')' ? ')' : '.') : '';
  const bullet = !ordered ? (a_el.dataset.marker || a_opts.bullet || '-') : '';
  const lines = [];
  for (const li of a_el.children) {
    if ('LI' !== li.tagName) continue;
    // 項目の記号（番号付きリストは番号を振り直す）と、2行目以降の字下げ
    const marker = ordered ? `${n++}${delim}` : bullet;
    const pad = ' '.repeat(marker.length + 1);
    const box = li.querySelector(':scope > input[type=checkbox]');
    const task = box ? (box.checked ? '[x] ' : '[ ] ') : '';
    // 項目の中身：先頭の文字の部分と、その後ろのブロック（入れ子のリスト等）
    const blocks = [];
    let inline = document.createElement('span');
    const flush = () => {
      const t = serializeInline(inline).replace(/\n+$/, '');
      if ('' !== t || 0 === blocks.length) blocks.push(t);
      inline = document.createElement('span');
    };
    for (const child of [...li.childNodes]) {
      if (1 === child.nodeType && /^(UL|OL|P|PRE|BLOCKQUOTE|TABLE|DIV|HR|H[1-6])$/.test(child.tagName)) {
        flush();
        blocks.push(serializeBlock(child, a_opts));
      } else {
        inline.appendChild(child.cloneNode(true));
      }
    }
    flush();
    const body = blocks.filter((b, k) => 0 === k || '' !== b).join('\n');
    const [firstLine, ...restLines] = body.split('\n');
    lines.push(`${marker} ${task}${firstLine}`.trimEnd());
    for (const l of restLines) lines.push(l ? pad + l : '');
  }
  return lines.join('\n');
}

/**
 * 表を Markdown にする。1行目を見出しの行とし、2行目に揃え方の区切り行を書く。
 * 列の数が足りない行は、空のセルで埋める。
 * @param {HTMLElement} a_el table 要素
 * @returns {string} Markdown（末尾の改行なし）。行が無ければ ''
 */
function serializeTable(a_el) {
  const rows = [...a_el.querySelectorAll('tr')];
  if (0 === rows.length) return '';
  // セルのチェックボックス（renderBodyCell）は、セルの先頭の「[ ]」「[x]」にする
  const cellText = (c) => {
    const box = c.querySelector(':scope > input[type=checkbox]');
    const prefix = box ? (box.checked ? '[x] ' : '[ ] ') : '';
    // （チェックボックスの直後に打った空白は、「[ ]」の後ろの空白と重なるので除く）
    const text = box ? serializeInline(c).trimStart() : serializeInline(c);
    return (prefix + text).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim();
  };
  const headerCells = [...rows[0].children];
  const out = [`| ${headerCells.map(cellText).join(' | ')} |`];
  out.push(`| ${headerCells.map((c) => {
    const a = c.dataset.align || '';
    return 'center' === a ? ':---:' : 'right' === a ? '---:' : 'left' === a ? ':---' : '---';
  }).join(' | ')} |`);
  for (const tr of rows.slice(1)) {
    const cells = [...tr.children].map(cellText);
    while (cells.length < headerCells.length) cells.push('');
    out.push(`| ${cells.join(' | ')} |`);
  }
  return out.join('\n');
}
