/**
 * Point the Telegram bot at the webhook, once.
 *
 *   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node src/telegram-setup.ts [--site https://hindsight.run]
 *
 * Registers `<site>/api/telegram` as the webhook with the secret Telegram must echo on every update,
 * sets the command menu, and prints what Telegram reports back. The same two variables must be set on
 * the Vercel project (`vercel env add`) for the function to accept and answer updates. Idempotent.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !secret) throw new Error('set TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_WEBHOOK_SECRET (any long random string)');
const i = process.argv.indexOf('--site');
const site = i >= 0 ? process.argv[i + 1] : 'https://hindsight.run';

const api = async (method: string, body: unknown) => {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
};

const me = await api('getMe', {});
console.log(`bot @${me.username} (${me.id})`);
await api('setWebhook', { url: `${site}/api/telegram`, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
await api('setMyCommands', {
  commands: [
    { command: 'assess', description: 'Would the desk lend to this Ethereum address, and if not, why' },
    { command: 'hunt', description: 'Open bounties: false statements with money on them' },
    { command: 'bounty', description: 'One bounty in full: /bounty <id>' },
    { command: 'help', description: 'What this is' },
  ],
});
await api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Mandate', web_app: { url: 'https://mandate.hindsight.run/tg/' } } });
const info = await api('getWebhookInfo', {});
console.log('webhook  :', info.url, info.last_error_message ? `(last error: ${info.last_error_message})` : '');
console.log('pending  :', info.pending_update_count);
console.log('\nnow set the same two variables on Vercel:');
console.log('  vercel env add TELEGRAM_BOT_TOKEN production');
console.log('  vercel env add TELEGRAM_WEBHOOK_SECRET production');
