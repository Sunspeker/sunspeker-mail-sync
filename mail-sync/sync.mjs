// Sincronizza le email di una o più caselle Aruba (IMAP) nel database Supabase.
// Legge la Posta in arrivo (ricevute) e la cartella Inviata (inviate) di OGNI
// casella, estrae i metadati e li salva nella tabella "emails" (dedup per message_id).
//
// Gira su GitHub Actions ogni pochi minuti. Le credenziali arrivano dalle
// variabili d'ambiente (GitHub Secrets), mai scritte nel codice.
//
// Caselle: ARUBA_USER/ARUBA_PASS (prima), poi facoltative ARUBA_USER_2/ARUBA_PASS_2,
//          _3, _4, _5 per aggiungerne altre.
// Supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Opzionali: ARUBA_HOST (default imaps.aruba.it), ARUBA_PORT (993),
//            SYNC_DAYS (1825 = 5 anni), MAX_PER_FOLDER (6000).

import { ImapFlow } from 'imapflow';
import { createClient } from '@supabase/supabase-js';
import { simpleParser } from 'mailparser';

const {
  ARUBA_HOST = 'imaps.aruba.it',
  ARUBA_PORT = '993',
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  // Finestra di sincronizzazione: email più vecchie di così non vengono MAI
  // lette, nemmeno se sono ancora nella casella (vedi "since" sotto). Era 365
  // giorni: un contatto del 2024 restava fuori. Alzata a 5 anni; MAX_PER_FOLDER
  // alzato di conseguenza, altrimenti con una finestra larga e tanti messaggi
  // si prendono solo i 2000 più recenti e i più vecchi restano comunque fuori.
  SYNC_DAYS = '1825',
  MAX_PER_FOLDER = '6000',
  MAX_BODIES = '400',           // quante anteprime-corpo scaricare per ogni giro
} = process.env;

// Raccoglie una o più caselle dai secrets (ARUBA_USER[_2.._5] / ARUBA_PASS[_2.._5]).
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
  console.error('❌ Mancano le credenziali Aruba (ARUBA_USER/ARUBA_PASS) o Supabase (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const since = new Date(Date.now() - Number(SYNC_DAYS) * 86400000);

// Riprova un'operazione fallita (es. Supabase momentaneamente irraggiungibile),
// con attese crescenti, così un progetto in pausa ha il tempo di riattivarsi.
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

// Maschera un indirizzo per i log (es. "sales@ditta.it" -> "sa***@***"),
// così anche in un repository pubblico i log non rivelano gli indirizzi.
const mask = (email = '') => {
  const [local, domain] = String(email).split('@');
  const l = (local || '').slice(0, 2) + '***';
  return domain ? `${l}@***` : l;
};

// Domini aziendali (delle caselle sincronizzate): per capire chi è "esterno".
const ownDomains = new Set(accounts.map((a) => (a.user.split('@')[1] || '').toLowerCase()).filter(Boolean));
const asAddrs = (list) => (Array.isArray(list) ? list : [])
  .map((a) => ({ email: (a.address || '').trim().toLowerCase(), name: (a.name || '').trim() }))
  .filter((x) => x.email);
const isExternal = (p) => p.email && !ownDomains.has(p.email.split('@')[1]);

// Sceglie la controparte considerando anche CC e CCN (BCC), preferendo SEMPRE
// un indirizzo esterno all'azienda, sia che sia il mittente sia che sia tra i
// destinatari/copie. Per le inviate: primo destinatario esterno (A → CC → CCN).
// Per le ricevute: mittente esterno, altrimenti il primo destinatario/copia
// esterno (caso tipico: un collega scrive a un cliente mettendo sales/hello in
// copia — qui il mittente è interno, il cliente esterno va cercato tra i
// destinatari, NON va scelto il collega come fallback prima di provarci).
function pickCounterpart(env, direction) {
  const from = asAddrs(env.from);
  const recipients = [...asAddrs(env.to), ...asAddrs(env.cc), ...asAddrs(env.bcc)];
  if (direction === 'out') return recipients.find(isExternal) || recipients[0] || null;
  return from.find(isExternal) || recipients.find(isExternal) || from[0] || recipients[0] || null;
}

// Ricava un breve riassunto/anteprima dal testo della mail: toglie il testo
// citato e le firme di reply, comprime gli spazi e taglia a ~280 caratteri.
function makeSnippet(text) {
  if (!text) return '';
  const kept = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    if (t.startsWith('>')) continue;
    if (/^(il .*ha scritto:|on .*wrote:|-{2,}\s*original message|da:\s|from:\s)/i.test(t)) break;
    kept.push(t);
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim().slice(0, 280);
}

// Legge una cartella in modo INCREMENTALE quando possibile: se conosciamo
// già l'ultimo UID letto in un giro precedente (e la cartella non ha
// cambiato "uidvalidity", cioè non è stata ricreata), chiediamo al server
// solo gli UID più nuovi di quello, invece di rileggere ogni volta le
// intestazioni di tutti i messaggi nella finestra SYNC_DAYS. Senza questo,
// ogni sincronizzazione (anche quella avviata a mano dal CRM) impiegava
// diversi minuti ed era quindi sempre "in corso" quando l'utente si
// aspettava di vedere comparire un'email appena inviata/ricevuta.
// Ritorna { records, uidValidity, lastUid } (lastUid invariato se non ci
// sono messaggi nuovi, così il prossimo giro riparte da dove eravamo).
async function readFolder(client, path, direction, haveSnippet, budget, priorState) {
  const out = [];
  const lock = await client.getMailboxLock(path);
  try {
    const uidValidity = client.mailbox?.uidValidity != null ? Number(client.mailbox.uidValidity) : null;
    const prior = (priorState && uidValidity != null && String(priorState.uid_validity) === String(uidValidity))
      ? priorState.last_uid : null;
    let uids;
    if (prior) {
      uids = await client.search({ uid: `${prior + 1}:*` }, { uid: true });
      uids = (uids || []).filter((u) => u > prior);
    } else {
      // Primo giro per questa cartella (o "uidvalidity" cambiata): scansione
      // completa della finestra SYNC_DAYS, come prima.
      uids = await client.search({ since }, { uid: true });
    }
    const newLastUid = uids && uids.length ? Math.max(prior || 0, ...uids) : (prior || 0);
    if (!uids || !uids.length) return { records: out, uidValidity, lastUid: newLastUid };
    uids = uids.slice(-Number(MAX_PER_FOLDER));
    // Fase 1: solo intestazioni (veloce).
    for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
      const env = msg.envelope || {};
      const party = pickCounterpart(env, direction);
      if (!party || !party.email) continue;
      const from = asAddrs(env.from)[0] || null;
      out.push({
        _uid: msg.uid,
        message_id: env.messageId || `${path}:${msg.uid}`,
        direction,
        counterpart_email: party.email,
        counterpart_name: party.name,
        // Mittente/destinatari/copia originali: servono al CRM per capire se
        // tocca a noi rispondere (mittente esterno) o attendiamo risposta
        // (mittente interno, azienda o collega, verso un destinatario esterno).
        from_email: from ? from.email : null,
        from_name: from ? from.name : null,
        to_addrs: asAddrs(env.to),
        cc_addrs: asAddrs(env.cc),
        subject: env.subject || '',
        sent_at: env.date ? new Date(env.date).toISOString() : null,
      });
    }
    // Fase 2: anteprima del corpo, SOLO per i messaggi nuovi (senza snippet) ed
    // entro il budget. È fail-safe: se qualcosa va storto, l'email resta senza anteprima.
    const need = out.filter((r) => !haveSnippet.has(r.message_id));
    const take = need.slice(-Math.max(0, budget.n));
    if (take.length) {
      const byUid = new Map(take.map((r) => [r._uid, r]));
      try {
        for await (const msg of client.fetch(take.map((r) => r._uid), { source: true }, { uid: true })) {
          const r = byUid.get(msg.uid);
          if (!r || !msg.source) continue;
          try {
            const parsed = await simpleParser(msg.source);
            const text = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : '');
            r.snippet = makeSnippet(text);
            // Testo completo (per l'esportazione Excel), limitato per sicurezza.
            r.body_text = String(text || '').replace(/\r\n/g, '\n').trim().slice(0, 30000);
          } catch { /* singolo messaggio non parsabile */ }
        }
      } catch (e) { console.warn(`⚠️  anteprima corpo non riuscita in "${path}": ${e.message}`); }
      budget.n -= take.length;
    }
  } finally { lock.release(); }
  // Toglie il campo interno _uid prima di salvare.
  return { records: out.map(({ _uid, ...r }) => r), uidValidity, lastUid: newLastUid };
}

async function findSentPath(client) {
  const list = await client.list();
  const bySpecial = list.find((m) => m.specialUse === '\\Sent');
  if (bySpecial) return bySpecial.path;
  const names = ['Sent', 'Posta inviata', 'INBOX.Sent', 'Sent Items', 'Inviata', 'INBOX.Sent Items'];
  const byName = list.find((m) => names.includes(m.path) || names.includes(m.name));
  return byName ? byName.path : null;
}

// Stato di sincronizzazione (ultimo UID letto per casella+cartella), da
// mail_sync_state: resiliente se la migrazione non è ancora stata eseguita
// (tabella assente), in tal caso ogni giro ricade sulla scansione completa.
async function loadSyncState() {
  const map = new Map();
  try {
    const { data, error } = await supabase.from('mail_sync_state').select('mailbox, folder, uid_validity, last_uid');
    if (error) throw error;
    for (const r of (data || [])) map.set(`${r.mailbox}:${r.folder}`, r);
  } catch { /* tabella non ancora creata: nessuno stato, scansione completa */ }
  return map;
}
async function saveSyncState(updates) {
  if (!updates.length) return;
  try {
    const { error } = await supabase.from('mail_sync_state')
      .upsert(updates.map((u) => ({ ...u, updated_at: new Date().toISOString() })), { onConflict: 'mailbox,folder' });
    if (error) throw error;
  } catch (e) { console.warn('⚠️  stato sincronizzazione non salvato (manca la migrazione mail-sync-incrementale?):', e.message); }
}

async function syncAccount({ user, pass }, haveSnippet, budget, syncState) {
  const client = new ImapFlow({ host: ARUBA_HOST, port: Number(ARUBA_PORT), secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  console.log(`✅ Connesso: ${mask(user)}`);
  let records = [];
  const stateUpdates = [];
  const inboxResult = await readFolder(client, 'INBOX', 'in', haveSnippet, budget, syncState.get(`${user}:INBOX`));
  records = records.concat(inboxResult.records);
  stateUpdates.push({ mailbox: user, folder: 'INBOX', uid_validity: inboxResult.uidValidity, last_uid: inboxResult.lastUid });
  const sentPath = await findSentPath(client);
  if (sentPath) {
    const sentResult = await readFolder(client, sentPath, 'out', haveSnippet, budget, syncState.get(`${user}:${sentPath}`));
    records = records.concat(sentResult.records);
    stateUpdates.push({ mailbox: user, folder: sentPath, uid_validity: sentResult.uidValidity, last_uid: sentResult.lastUid });
  } else console.warn(`⚠️  ${mask(user)}: cartella "Inviata" non trovata (solo ricevute).`);
  await client.logout();
  // Registra la casella aziendale di provenienza (es. sales@ / hello@).
  records = records.map((r) => ({ ...r, mailbox: user }));
  console.log(`   ${mask(user)}: ${records.length} messaggi nuovi/modificati.`);
  return { records, stateUpdates };
}

// Message_id che hanno già il testo completo salvato (per non riscaricare il corpo).
async function loadSnippetSet() {
  const set = new Set();
  try {
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase.from('emails')
        .select('message_id').not('body_text', 'is', null).neq('body_text', '')
        .range(from, from + pageSize - 1);
      if (error) break;
      (data || []).forEach((r) => set.add(r.message_id));
      if (!data || data.length < pageSize) break;
    }
  } catch { /* in caso di errore, riscarica: non è un problema */ }
  return set;
}

// Rimuove dal DB le email non più presenti nelle caselle (eliminate o spostate
// fuori dalla Posta in arrivo/Inviata), limitandosi alla finestra scansionata.
// Gira SOLO se tutte le caselle sono state lette correttamente, per non
// cancellare per sbaglio i messaggi di una casella momentaneamente irraggiungibile.
async function reconcileDeletions(all) {
  const currentIds = new Set(all.map((r) => r.message_id));
  const minScanned = all.reduce((m, r) => (r.sent_at && (!m || r.sent_at < m) ? r.sent_at : m), null);
  if (!minScanned) return;
  const toDelete = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('emails')
      .select('message_id').gte('sent_at', minScanned).range(from, from + pageSize - 1);
    if (error) { console.warn('⚠️  riconciliazione saltata:', error.message); return; }
    for (const r of (data || [])) if (!currentIds.has(r.message_id)) toDelete.push(r.message_id);
    if (!data || data.length < pageSize) break;
  }
  for (let i = 0; i < toDelete.length; i += 200) {
    const chunk = toDelete.slice(i, i + 200);
    await retry(async () => {
      const { error } = await supabase.from('emails').delete().in('message_id', chunk);
      if (error) throw new Error(error.message);
    }, 'Rimozione Supabase');
  }
  if (toDelete.length) console.log(`🗑️  Rimosse ${toDelete.length} email non più presenti nelle caselle.`);
}

async function main() {
  const haveSnippet = await loadSnippetSet();
  const syncState = await loadSyncState();
  const budget = { n: Number(MAX_BODIES) || 0 };
  let all = [];
  let allOk = true;
  let pendingStateUpdates = [];
  for (const acc of accounts) {
    try {
      const { records, stateUpdates } = await syncAccount(acc, haveSnippet, budget, syncState);
      all = all.concat(records);
      pendingStateUpdates = pendingStateUpdates.concat(stateUpdates);
    } catch (e) {
      // Se una casella fallisce, continua con le altre (ma niente riconciliazione,
      // e il suo "ultimo UID letto" non avanza: verrà ritentata dall'inizio
      // del punto in cui era arrivata, non perde messaggi).
      allOk = false;
      console.error(`❌ Errore sulla casella ${mask(acc.user)}:`, e.message);
    }
  }
  if (!all.length) {
    console.log('Nessun messaggio nuovo da sincronizzare.');
    await saveSyncState(pendingStateUpdates);
    return;
  }

  // Dedup locale per message_id (una stessa email può toccare più caselle).
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
  console.log(`💾 Salvati ${saved} messaggi da ${accounts.length} casella/e.`);
  // Avanza "l'ultimo UID letto" solo DOPO che i messaggi sono stati salvati
  // con successo, così un errore di salvataggio non fa perdere messaggi al
  // giro successivo (verrebbero comunque riletti).
  await saveSyncState(pendingStateUpdates);

  if (allOk) await reconcileDeletions(all);
  else console.warn('⚠️  Riconciliazione saltata: non tutte le caselle sono state lette.');
}

main().catch((e) => { console.error('❌ Errore:', e.message); process.exit(1); });
