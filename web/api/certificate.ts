/**
 * GET /api/certificate?subject=0x…[&principal=1]
 *
 * One page, as a PDF, saying what the desk said about an address and exactly which on-chain facts it
 * said it from: the instrument, the window it was priced against (span ids, first and last height),
 * every claim on file with its status and the tCTC beyond recovery, the transaction that forbade the
 * loan if one did, and the Creditcoin block the reading was taken at. Anyone holding the page can
 * re-run every line against the chain.
 *
 * Deterministic: the same subject at the same block produces the same bytes. There is no signature,
 * because a signature would say "trust the issuer" and the point is that there is nothing to trust --
 * the page is a set of instructions for checking, printed nicely. The PDF is written by hand, with the
 * fourteen standard fonts, so this function has no dependency that could not be audited in an hour.
 *
 * It is not a credential. Nothing is minted, nothing is transferable, and there is no number.
 */
import { parseEther } from 'ethers';
import { contracts, checksummed, assessAll, filesOn, policies, archive, CORS } from './_desk.js';
import { manifest } from './_manifest.js';

export const config = { maxDuration: 30 };

const fmt = (wei: string | bigint, d = 3) => (Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: d });
const days = (blocks: number) => Math.round((blocks * 12) / 86_400);

/** A tiny PDF writer: one page, text only, standard fonts. Enough for a certificate, not for anything else. */
class Page {
  private ops: string[] = [];
  private y = 800;
  // Plain fields, not parameter properties: Vercel's runtime strips types and does not transform them.
  private readonly width: number;
  private readonly height: number;
  constructor(width = 595.28, height = 841.89) {
    this.width = width;
    this.height = height;
  }

  text(s: string, opts: { font?: 'serif' | 'serif-bold' | 'serif-italic' | 'mono' | 'sans'; size?: number; x?: number; gap?: number; color?: [number, number, number] } = {}) {
    const font = { serif: 'F1', 'serif-bold': 'F2', 'serif-italic': 'F3', mono: 'F4', sans: 'F5' }[opts.font ?? 'serif'];
    const size = opts.size ?? 10.5;
    const x = opts.x ?? 56;
    const [r, g, b] = opts.color ?? [0.09, 0.08, 0.06];
    this.y -= size * 1.35 + (opts.gap ?? 0);
    const esc = s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, (ch) => (ch === '—' ? '-' : ch === '·' ? '.' : ch === '≈' ? '~' : ch === '…' ? '...' : ch === '“' || ch === '”' ? '"' : ch === '’' ? "'" : '?'));
    this.ops.push(`BT ${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)} rg /${font} ${size} Tf ${x.toFixed(2)} ${this.y.toFixed(2)} Td (${esc}) Tj ET`);
  }

  /** Word-wrap at roughly `chars` characters; body copy in a 10.5pt serif fits ~95 across A4 margins. */
  para(s: string, opts: Parameters<Page['text']>[1] & { chars?: number } = {}) {
    const chars = opts.chars ?? 96;
    const words = s.split(/\s+/);
    let line = '';
    let first = true;
    for (const w of words) {
      if ((line + ' ' + w).trim().length > chars) {
        this.text(line.trim(), first ? opts : { ...opts, gap: 0 });
        first = false;
        line = w;
      } else line = line ? line + ' ' + w : w;
    }
    if (line) this.text(line.trim(), first ? opts : { ...opts, gap: 0 });
  }

  rule(gap = 8, weight = 0.6, color: [number, number, number] = [0.72, 0.68, 0.59]) {
    this.y -= gap;
    const [r, g, b] = color;
    this.ops.push(`${r.toFixed(2)} ${g.toFixed(2)} ${b.toFixed(2)} RG ${weight} w 56 ${this.y.toFixed(2)} m ${(this.width - 56).toFixed(2)} ${this.y.toFixed(2)} l S`);
    this.y -= gap;
  }

  /** The wax stamp: a rotated outlined word, the one red on the page. */
  stamp(word: string) {
    const x = this.width - 168;
    const y = this.height - 178;
    this.ops.push(`q 0.48 0.12 0.17 RG 0.48 0.12 0.17 rg 2.2 w 0.9659 0.2588 -0.2588 0.9659 ${x} ${y} cm -6 -18 ${word.length * 19 + 12} 40 re S BT /F2 26 Tf 0 0 Td (${word}) Tj ET Q`);
  }

  space(n = 6) {
    this.y -= n;
  }

  get remaining() {
    return this.y;
  }

  render(): Uint8Array {
    const content = this.ops.join('\n');
    const objects: string[] = [];
    const add = (s: string) => (objects.push(s), objects.length);
    const fonts = { F1: 'Times-Roman', F2: 'Times-Bold', F3: 'Times-Italic', F4: 'Courier', F5: 'Helvetica' };
    const fontIds = Object.fromEntries(Object.entries(fonts).map(([k, name]) => [k, add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`)]));
    const contentId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const resources = `<< /Font << ${Object.entries(fontIds).map(([k, id]) => `/${k} ${id} 0 R`).join(' ')} >> >>`;
    const pagesId = objects.length + 2;
    const pageId = add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Contents ${contentId} 0 R /Resources ${resources} >>`);
    add(`<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`);
    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const subject = checksummed(url.searchParams.get('subject') ?? url.searchParams.get('q'));
  if (!subject) return Response.json({ error: 'subject must be an Ethereum address: ?subject=0x…' }, { status: 400, headers: CORS });
  let principal: bigint;
  try {
    principal = parseEther(url.searchParams.get('principal') ?? '1');
  } catch {
    return Response.json({ error: 'principal must be a number of tCTC' }, { status: 400, headers: CORS });
  }

  const { cc, desk, mirror, registry } = contracts();
  const [block, ps, verdicts, arch] = await Promise.all([cc.getBlockNumber(), policies(desk), assessAll(desk, mirror, subject, principal), archive(mirror, 3)]);
  const files = await filesOn(registry, subject, ps);
  const headline = verdicts.find((v) => v.reason === 'ProvenLiar') ?? verdicts.find((v) => v.reason === 'EventOnRecord') ?? verdicts.find((v) => v.ok) ?? verdicts[0] ?? null;
  const refutedFile = files.find((f) => f.status === 'Refuted');

  const page = new Page();
  page.text('MANDATE', { font: 'sans', size: 9, color: [0.42, 0.39, 0.33] });
  page.text('Certificate of assessment', { font: 'serif', size: 22, gap: 4 });
  page.text(`Ethereum address ${subject}`, { font: 'mono', size: 9.5, gap: 6 });
  page.text(`Read at Creditcoin block ${block.toLocaleString('en-US')} from the lending contract at ${manifest.contracts.UnderwritingDesk.address}`, { font: 'sans', size: 8.5, color: [0.42, 0.39, 0.33] });
  if (headline && !headline.ok) page.stamp(headline.reason === 'ProvenLiar' ? 'REFUTED' : 'REFUSED');
  page.rule(10);

  page.text('Verdict', { font: 'serif-bold', size: 11, gap: 2 });
  if (headline) {
    page.text(`${headline.ok ? 'PAYS' : 'REFUSES'} - ${headline.reason}`, { font: 'serif-bold', size: 13 });
    page.para(headline.why, { font: 'serif', size: 10.5 });
    page.para(`Under instrument #${headline.policy.id} (${headline.policy.kind === 'BlankFile' ? 'silence accepted' : headline.policy.requiresBinding ? 'bond and proven owner required' : 'bond required'}), asked for ${fmt(principal)} tCTC, looking back ${headline.policy.window.toLocaleString('en-US')} Ethereum blocks (about ${days(headline.policy.window)} days).`, { font: 'serif', size: 10.5, gap: 2 });
  } else page.text('The desk has no instruments on file.', {});

  page.rule(10);
  page.text('Every instrument, the same address', { font: 'serif-bold', size: 11, gap: 2 });
  for (const v of verdicts) {
    page.text(`#${v.policy.id}  ${v.ok ? 'pays   ' : 'refuses'}  ${v.reason.padEnd(20)}  ${v.policy.kind === 'BlankFile' ? 'silence accepted' : v.policy.requiresBinding ? 'bond + proven owner' : 'bond required'}  ${days(v.policy.window)} d  ${v.policy.venue.slice(0, 10)}...`, { font: 'mono', size: 8.5 });
  }

  page.rule(10);
  page.text('The window it was priced against', { font: 'serif-bold', size: 11, gap: 2 });
  const w = headline?.window;
  if (w) {
    page.para(`Sealed span${w.spanIds.length > 1 ? 's' : ''} ${w.spanIds.join(', ')}: heights ${w.from.toLocaleString('en-US')} to ${w.to.toLocaleString('en-US')}, ${(w.to - w.from + 1).toLocaleString('en-US')} Ethereum blocks held with no gap. A span cannot be sealed across a missing height, so this is the range in which a contradicting transaction had nowhere to hide.`, { font: 'serif', size: 10 });
  } else page.para('No adjacent run of sealed spans covers the window these terms look back over. The desk refuses on incapacity, which is the only safe direction.', { font: 'serif', size: 10 });
  page.text(`Archive: ${arch.held.toLocaleString('en-US')} heights held between ${arch.lowest.toLocaleString('en-US')} and ${arch.highest.toLocaleString('en-US')}${arch.missingInRange ? `, ${arch.missingInRange.toLocaleString('en-US')} still missing inside that range` : ', no gaps'}.`, { font: 'sans', size: 8.5, color: [0.42, 0.39, 0.33] });

  page.rule(10);
  page.text('On file', { font: 'serif-bold', size: 11, gap: 2 });
  if (files.length === 0) page.para('Nothing. Nobody has staked money on a statement about this address. That is silence, which the desk does not read as innocence.', { font: 'serif', size: 10 });
  for (const f of files.slice(0, 8)) {
    page.text(`#${f.id}  ${f.status.padEnd(9)} ${f.kind === 'EmptySet' ? 'no such event  ' : 'complete list  '} ${f.spanFrom.toLocaleString('en-US')}-${f.spanTo.toLocaleString('en-US')}  ${fmt(f.bondStaked)} tCTC staked, ${fmt(f.enforceableLoss)} beyond recovery`, { font: 'mono', size: 8.5 });
  }
  if (files.length > 8) page.text(`... and ${files.length - 8} more`, { font: 'sans', size: 8.5 });
  if (refutedFile) {
    page.para(`Claim #${refutedFile.id} was refuted by ${refutedFile.refuter}: a transaction inside its range was produced and verified against a held root. The refuter received ${fmt(BigInt(refutedFile.bondStaked) - BigInt(refutedFile.enforceableLoss))} tCTC; ${fmt(refutedFile.enforceableLoss)} tCTC was burned.`, { font: 'serif', size: 10, gap: 2 });
  }

  page.rule(10);
  page.text('How to check this page', { font: 'serif-bold', size: 11, gap: 2 });
  page.para(`Call UnderwritingDesk.assess("${subject}", ${headline?.policy.id ?? 0}, ${principal.toString()}, [${w?.spanIds.join(', ') ?? ''}]) at ${manifest.contracts.UnderwritingDesk.address} on Creditcoin (chain 102031). It is a view: no key, no gas, no account. The same function decides whether money moves, so what it returns to you is what it returned here.`, { font: 'serif', size: 9.5 });
  page.para(`${manifest.site}/mandate/?q=${subject}  .  ${manifest.explorer}/address/${manifest.contracts.UnderwritingDesk.address}`, { font: 'mono', size: 8 });
  page.space(4);
  page.para('This is not a credential and not a score. Nothing is minted, nothing is transferable, and there is no number.', { font: 'serif-italic', size: 9.5, color: [0.36, 0.34, 0.28] });

  const pdf = page.render();
  return new Response(pdf, {
    headers: {
      ...CORS,
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="mandate-${subject.slice(0, 10)}-${block}.pdf"`,
      'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}
