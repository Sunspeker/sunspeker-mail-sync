// Sincronizza le email di una casella Aruba (IMAP) nel database Supabase del CRM.
// Legge la Posta in arrivo (ricevute) e la cartella Inviata (inviate), estrae i
// metadati e li salva nella tabella "emails" (dedup per message_id).
//
// Gira su GitHub Actions ogni pochi minuti. Le credenziali arrivano dalle
// variabili d'ambiente (GitHub Secrets), mai scritte nel codice.
//
// Variabili richieste:
//   ARUBA_USER  - indirizzo email Aruba completo (es. info@tuazienda.it)
//   ARUBA_PASS  - password della casella Aruba
//   SUPABASE_URL                - URL del progetto Supabase
//   SUPABASE_SERVICE_ROLE_KEY   - service_role key (segreta) del progetto
// Opzionali:
//   ARUBA_HOST (default imaps.aruba.it), ARUBA_PORT (993),
//   SYNC_DAYS (365), MAX_PER_FOLDER (2000)

import { ImapFlow } from 'imapflow';
import { createClient } from '@supabase/supabase-js';

const {
  ARUBA_HOST = 'imaps.aruba.it',
  ARUBA_PORT = '993',
  ARUBA_USER,
  ARUBA_PASS,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SYNC_DAYS = '365',
  MAX_PER_FOLDER = '2000',
} = process.env;

if (!ARUBA_USER || !ARUBA_PASS || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Mancano una o più variabili: ARUBA_USER, ARUBA_PASS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = new Date(Date.now() - Number(SYNC_DAYS) * 86400000);

const firstAddr = (list) => (Array.isArray(list) && list[0]
  ? { email: (list[0].address || '').trim().toLowerCase(), name: (list[0].name || '').trim() }
  : { email: '', name: '' });

// Legge una cartella e restituisce i record pronti per Supabase.
async function readFolder(client, path, direction) {
  const out = [];
  const lock = await client.getMailboxLock(path);
  try {
    let uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return out;
    uids = uids.slice(-Number(MAX_PER_FOLDER)); // i più recenti
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
  } finally {
    lock.release();
  }
  return out;
}

// Individua la cartella "Inviata" (per attributo speciale o per nome comune Aruba).
async function findSentPath(client) {
  const list = await client.list();
  const bySpecial = list.find((m) => m.specialUse === '\\Sent');
  if (bySpecial) return bySpecial.path;
  const names = ['Sent', 'Posta inviata', 'INBOX.Sent', 'Sent Items', 'Inviata', 'INBOX.Sent Items'];
  const byName = list.find((m) => names.includes(m.path) || names.includes(m.name));
  return byName ? byName.path : null;
}

async function main() {
  const client = new ImapFlow({
    host: ARUBA_HOST, port: Number(ARUBA_PORT), secure: true,
    auth: { user: ARUBA_USER, pass: ARUBA_PASS }, logger: false,
  });
  await client.connect();
  console.log('✅ Connesso ad Aruba IMAP:', ARUBA_HOST);

  let records = [];
  records = records.concat(await readFolder(client, 'INBOX', 'in'));
  console.log(`📥 Posta in arrivo: ${records.length} messaggi.`);

  const sentPath = await findSentPath(client);
  if (sentPath) {
    const sent = await readFolder(client, sentPath, 'out');
    records = records.concat(sent);
    console.log(`📤 Inviata ("${sentPath}"): ${sent.length} messaggi.`);
  } else {
    console.warn('⚠️  Cartella "Inviata" non trovata: verranno sincronizzate solo le ricevute.');
  }

  await client.logout();

  if (!records.length) { console.log('Nessun messaggio da sincronizzare.'); return; }

  let saved = 0;
  for (let i = 0; i < records.length; i += 500) {
    const chunk = records.slice(i, i + 500);
    const { error } = await supabase.from('emails').upsert(chunk, { onConflict: 'message_id', ignoreDuplicates: true });
    if (error) { console.error('❌ Errore salvataggio su Supabase:', error.message); process.exit(1); }
    saved += chunk.length;
  }
  console.log(`💾 Sincronizzazione completata: ${saved} messaggi elaborati (i duplicati sono ignorati).`);
}

main().catch((e) => { console.error('❌ Errore:', e.message); process.exit(1); });
