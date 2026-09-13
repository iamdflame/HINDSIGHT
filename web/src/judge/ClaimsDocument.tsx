import type { ReactNode } from 'react';

/**
 * A renderer for exactly the constructs CLAIMS.md uses — headings, paragraphs, tables, bullet lists
 * with continuation lines, a rule, and inline bold / italic / code / links. No markdown library; the
 * page is the file, so it cannot drift from it.
 */
function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\[((?:`[^`]+`|[^\]])+)\]\(([^)]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\s][^*]*)\*)/g;
  let last = 0, m: RegExpExecArray | null, n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) {
      const href = m[4];
      const external = /^https?:/.test(href);
      out.push(<a key={k} href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>{inline(m[3], k)}</a>);
    } else if (m[5]) out.push(<strong key={k}>{inline(m[6], k)}</strong>);
    else if (m[7]) out.push(<em key={k}>{inline(m[8], k)}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function ClaimsDocument({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0, b = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) {
      // Fenced code: rendered verbatim, never through the inline parser.
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre key={b++} className="doc-code" data-lang={lang || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) quote.push(lines[i++].slice(2));
      blocks.push(<blockquote key={b++}>{inline(quote.join(' '))}</blockquote>);
      continue;
    }
    if (line.startsWith('### ')) { blocks.push(<h3 key={b++} className="t-ui">{inline(line.slice(4))}</h3>); i++; continue; }
    if (line.startsWith('# ')) { blocks.push(<h1 key={b++} className="t-title">{inline(line.slice(2))}</h1>); i++; continue; }
    if (line.startsWith('## ')) { blocks.push(<h2 key={b++} className="t-ui section-head">{inline(line.slice(3))}</h2>); i++; continue; }
    if (/^-{3,}$/.test(line.trim())) { blocks.push(<hr key={b++} />); i++; continue; }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const [head, , ...body] = rows;
      blocks.push(
        <div key={b++} className="doc-table-wrap">
          <table>
            <thead><tr>{cells(head).map((c, j) => <th key={j} scope="col">{inline(c)}</th>)}</tr></thead>
            <tbody>{body.map((r, ri) => <tr key={ri}>{cells(r).map((c, j) => <td key={j}>{inline(c, `r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || (/^ {2}\S/.test(lines[i]) && items.length))) {
        if (lines[i].startsWith('- ')) items.push(lines[i].slice(2));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push(<ul key={b++}>{items.map((it, j) => <li key={j}>{inline(it, `l${j}`)}</li>)}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#|\||- |-{3,}$)/.test(lines[i])) para.push(lines[i++].trim());
    blocks.push(<p key={b++}>{inline(para.join(' '))}</p>);
  }
  return <article className="doc">{blocks}</article>;
}
