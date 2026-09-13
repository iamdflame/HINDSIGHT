/**
 * POST /api/telegram — the bot's webhook.
 *
 *   /assess 0x…      the desk's verdict on an Ethereum address, every instrument, with the reason
 *   /hunt            open bounties and what each pays
 *   /bounty <id>     one claim in full: what it says, what refuting it pays, until when
 *   /start, /help    what this is
 *
 * Telegram calls this with an update; the function answers through the Bot API and returns 200.
 * Two secrets, both from the environment and neither in the repository: TELEGRAM_BOT_TOKEN (to
 * send) and TELEGRAM_WEBHOOK_SECRET (which Telegram echoes in a header on every update, so nobody
 * else can feed this function messages). A request without the right header is refused before any
 * chain read happens.
 *
 * Everything it says is read from the deployed contracts through the same functions as /api/assess.
 * It cannot spend: there is no key here that signs anything. Nothing it returns is a score.
 */
import { parseEther } from 'ethers';
import { contracts, checksummed, assessAll, filesOn, policies, CORS } from './_desk.js';
import { manifest } from './_manifest.js';

export const config = { maxDuration: 30 };

const SITE = manifest.site ?? 'https://hindsight.run';
const MANDATE = 'https://mandate.hindsight.run';

type Update = { message?: { chat: { id: number }; text?: string; from?: { username?: string } }; callback_query?: unknown };

const days = (blocks: number) => Math.round((blocks * 12) / 86_400);
const tctc = (wei: string | bigint, d = 3) => (Number(BigInt(wei)) / 1e18).toLocaleString('en-US', { maximumFractionDigits: d });
const esc = (s: string) => s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);

/** The text the bot sends for each command. Pure over chain reads, so it can be tested without Telegram. */
export async function reply(text: string): Promise<{ text: string; parse_mode?: 'MarkdownV2'; button?: { text: string; url: string } }> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest[0] ?? '';
  const { cc, desk, mirror, registry } = contracts();

  switch ((cmd ?? '').split('@')[0].toLowerCase()) {
    case '/start':
    case '/help':
      return {
        text:
          'This is Mandate, an underwriting desk on Creditcoin that reads Ethereum history nobody here owns\\.\n\n' +
          '/assess 0x… — would the desk lend to this Ethereum address, and if not, why\n' +
          '/hunt — open bounties: false statements with money on them\n' +
          '/bounty 7 — one bounty in full\n\n' +
          'Every answer is a live read of the contract that holds the money\\. Nothing is a score, nothing is minted, and there is no number\\.',
        parse_mode: 'MarkdownV2',
        button: { text: 'Open Mandate', url: `${MANDATE}/tg/` },
      };

    case '/assess': {
      const subject = checksummed(arg);
      if (!subject) return { text: 'Give me an Ethereum address: /assess 0x… (40 hex characters)' };
      const [block, ps] = await Promise.all([cc.getBlockNumber(), policies(desk)]);
      const [verdicts, files] = await Promise.all([assessAll(desk, mirror, subject, parseEther('1')), filesOn(registry, subject, ps)]);
      const headline = verdicts.find((v) => v.reason === 'ProvenLiar') ?? verdicts.find((v) => v.reason === 'EventOnRecord') ?? verdicts.find((v) => v.ok) ?? verdicts[0];
      const lines = [
        `*${esc(headline?.ok ? 'PAYS' : 'REFUSES')}* — \`${esc(headline?.reason ?? 'none')}\``,
        esc(headline?.why ?? ''),
        '',
        `\`${esc(subject)}\``,
        esc(`On file: ${files.length === 0 ? 'nothing — silence, which the desk does not read as innocence' : `${files.length} statement${files.length === 1 ? '' : 's'}, ${tctc(files.reduce((a, f) => a + BigInt(f.bondStaked), 0n))} tCTC staked`}`),
        '',
        ...verdicts.map((v) => esc(`#${v.policy.id} ${v.ok ? 'pays' : 'refuses'} · ${v.policy.kind === 'BlankFile' ? 'silence accepted' : v.policy.requiresBinding ? 'bond + proven owner' : 'bond required'} · ${days(v.policy.window)} d · ${v.reason}`)),
        '',
        esc(`Read at Creditcoin block ${block.toLocaleString('en-US')}. Nothing is minted, nothing is transferable, and there is no number.`),
      ];
      return { text: lines.join('\n'), parse_mode: 'MarkdownV2', button: { text: 'Certificate (PDF)', url: `${SITE}/api/certificate?subject=${subject}` } };
    }

    case '/hunt': {
      const n = Number(await registry.claimCount());
      const rows = await Promise.all(Array.from({ length: n }, (_, i) => registry.claimOf(i)));
      const open = rows.map((c: any, id: number) => ({ id, c })).filter((x) => Number(x.c.status) === 1);
      if (open.length === 0) return { text: 'Nothing is open. Every statement on the board has been refuted or has stood.', button: { text: 'The board', url: `${MANDATE}/hunt/` } };
      const lines = [`*${open.length} open bount${open.length === 1 ? 'y' : 'ies'}*`, ''];
      for (const { id, c } of open) {
        const pays = BigInt(c.bondStaked) / 2n;
        lines.push(esc(`#${id} · pays ${tctc(pays)} tCTC · "no such event" about 0x${String(c.subject).slice(26, 34)}… · blocks ${Number(c.spanFrom).toLocaleString('en-US')}–${Number(c.spanTo).toLocaleString('en-US')} · until ${new Date(Number(c.openUntil) * 1000).toISOString().slice(0, 10)}`));
      }
      lines.push('', esc('Find the transaction that contradicts one, and half the bond is yours. /bounty <id> for details.'));
      return { text: lines.join('\n'), parse_mode: 'MarkdownV2', button: { text: 'Hunt', url: `${MANDATE}/hunt/` } };
    }

    case '/bounty': {
      if (!/^\d+$/.test(arg)) return { text: 'Which one? /bounty <claim id> — see /hunt for the list.' };
      const id = Number(arg);
      const n = Number(await registry.claimCount());
      if (id >= n) return { text: `There is no claim #${id}; the board holds ${n}.` };
      const [c, loss] = await Promise.all([registry.claimOf(id), registry.enforceableLoss(id)]);
      const status = ['none', 'open', 'refuted', 'standing'][Number(c.status)] ?? '?';
      const lines = [
        `*Claim \\#${id}* — ${esc(status)}`,
        esc(`${Number(c.kind) === 0 ? 'Says no event' : 'Says exactly these events'} with topic ${String(c.topic0).slice(0, 10)}… at ${c.venue} about 0x${String(c.subject).slice(26)} in Ethereum blocks ${Number(c.spanFrom).toLocaleString('en-US')}–${Number(c.spanTo).toLocaleString('en-US')}.`),
        '',
        esc(`Bond ${tctc(c.bondStaked)} tCTC. Refuting it pays ${tctc(BigInt(c.bondStaked) - BigInt(loss))} tCTC and burns ${tctc(loss)}.`),
        esc(Number(c.status) === 1 ? `Open until ${new Date(Number(c.openUntil) * 1000).toUTCString()}.` : Number(c.status) === 2 ? `Refuted by ${c.refuter}.` : 'Stood unrefuted: economic, not a proof.'),
      ];
      return { text: lines.join('\n'), parse_mode: 'MarkdownV2', button: { text: `Claim #${id}`, url: `${SITE}/watch/?claim=${id}` } };
    }

    default:
      return { text: 'I know /assess 0x…, /hunt and /bounty <id>. /help for what this is.' };
  }
}

async function send(token: string, chatId: number, r: Awaited<ReturnType<typeof reply>>) {
  const body: Record<string, unknown> = { chat_id: chatId, text: r.text, disable_web_page_preview: true };
  if (r.parse_mode) body.parse_mode = r.parse_mode;
  if (r.button) body.reply_markup = { inline_keyboard: [[{ text: r.button.text, url: r.button.url }]] };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok && r.parse_mode) {
    // Markdown escaping is fragile; a message Telegram rejects is re-sent as plain text rather than lost.
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, parse_mode: undefined, text: r.text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1') }) });
  }
}

export async function POST(request: Request): Promise<Response> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !secret) return Response.json({ error: 'the bot is not configured' }, { status: 503 });
  if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response(null, { status: 401 });

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return Response.json({ error: 'not an update' }, { status: 400 });
  }
  const msg = update.message;
  if (!msg?.text || !msg.chat?.id) return Response.json({ ok: true, ignored: true });

  try {
    await send(token, msg.chat.id, await reply(msg.text));
  } catch (e) {
    await send(token, msg.chat.id, { text: `Could not read the chain just now: ${String((e as Error).message).slice(0, 120)}` }).catch(() => {});
  }
  // Always 200: Telegram retries anything else, and a retried /assess is just another read.
  return Response.json({ ok: true });
}

export async function GET(): Promise<Response> {
  const configured = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);
  return Response.json({ bot: configured ? 'configured' : 'not configured', commands: ['/assess 0x…', '/hunt', '/bounty <id>', '/help'], webhook: 'POST with X-Telegram-Bot-Api-Secret-Token' }, { headers: CORS });
}
