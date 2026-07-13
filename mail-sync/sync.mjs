import { ImapFlow } from 'imapflow';
import { createClient } from '@supabase/supabase-js';

const {
  ARUBA_HOST = 'imaps.aruba.it',
  ARUBA_PORT = '993',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SYNC_DAYS = '365',
  MAX_PER_FOLDER = '2000',
} = process.env;

function collectAccounts() {
  const accounts = [];
  for (const s of ['', '_2', '_3', '_4', '_5']) {
    const user = process.env[`ARUBA_USER${s}`];
    const pass = process.env[`ARUBA_PASS${s}`];
    if (user && pass) accounts.push({ user: user.trim(), pass });
  }
  return accounts;
}

const accounts = collectAccounts();
if (!accounts.length || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Mancano le credenziali Aruba o Supabase.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = new Date(Date.now() - Number(SYNC_DAYS) * 86400000);

async function retry(fn, label) {
  const TRIES = 8;
  for (let i = 1; i <= TRIES; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === TRIES) throw e;
      const wait = Math.min(30000, 5000 * i);
      console.warn(`⏳ ${label}: tentativo ${i}/${TRIES} fallito (${e.message}). Riprovo tra ${wait / 1000}s…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const firstAddr = (list) => (Array.isArray(list) && list[0]
  ? { email: (list[0].address || '').trim().toLowerCase(), name: (list[0].name || '').trim() }
  : { email: '', name: '' });

async function readFolder(client, path, direction) {
  const out = [];
  const lock = await client.getMailboxLock(path);
  try {
    let uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return out;
    uids = uids.slice(-Number(MAX_PER_FOLDER));
    for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
      const env = msg.envelope || {};
      const party = direction === 'out' ? firstAddr(env.to) : firstAddr(env.from);
      if (!party.email) continue;
      out.push({
        message_id: env.messageId || `${path}:${msg.uid}`,
        direction,
        counterpart_email: party.email,
        counterpart_name: party.name,
        subject: env.subject || '',
        sent_at: env.date ? new Date(env.date).toISOString() : null,
      });
    }
  } finally { lock.release(); }
  return out;
}

async function findSentPath(client) {
  const list = await client.list();
  const bySpecial = list.find((m) => m.specialUse === '\\Sent');
  if (bySpecial) return bySpecial.path;
  const names = ['Sent', 'Posta inviata', 'INBOX.Sent', 'Sent Items', 'Inviata', 'INBOX.Sent Items'];
  const byName = list.find((m) => names.includes(m.path) || names.includes(m.name));
  return byName ? byName.path : null;
}

async function syncAccount({ user, pass }) {
  const client = new ImapFlow({ host: ARUBA_HOST, port: Number(ARUBA_PORT), secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  console.log(`✅ Connesso: ${user}`);
  let records = [];
  records = records.concat(await readFolder(client, 'INBOX', 'in'));
  const sentPath = await findSentPath(client);
  if (sentPath) records = records.concat(await readFolder(client, sentPath, 'out'));
  else console.warn(`⚠️  ${user}: cartella "Inviata" non trovata (solo ricevute).`);
  await client.logout();
  records = records.map((r) => ({ ...r, mailbox: user }));
  console.log(`   ${user}: ${records.length} messaggi.`);
  return records;
}

async function main() {
  let all = [];
  for (const acc of accounts) {
    try { all = all.concat(await syncAccount(acc)); }
    catch (e) { console.error(`❌ Errore sulla casella ${acc.user}:`, e.message); }
  }
  if (!all.length) { console.log('Nessun messaggio da sincronizzare.'); return; }

  const seen = new Set();
  const unique = all.filter((r) => (seen.has(r.message_id) ? false : seen.add(r.message_id)));

  let saved = 0;
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    await retry(async () => {
      const { error } = await supabase.from('emails').upsert(chunk, { onConflict: 'message_id' });
      if (error) throw new Error(error.message);
    }, 'Salvataggio Supabase');
    saved += chunk.length;
  }
  console.log(`💾 Completato: ${saved} messaggi da ${accounts.length} casella/e.`);
}

main().catch((e) => { console.error('❌ Errore:', e.message); process.exit(1); });
