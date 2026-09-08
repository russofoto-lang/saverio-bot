// Saverio — socio senior. Cloudflare Worker.
// Riceve webhook Telegram, chiama Claude (con web search), risponde su Telegram.
// La memoria conversazionale vive in KV con scadenza automatica.

type KVNamespace = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
};

type ScheduledEvent = { cron: string };

interface Env {
  SAVERIO_KV: KVNamespace;
  TELEGRAM_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  WEBHOOK_SECRET: string;
  TASK_URL: string;
  AGENT_KEY: string;
  APIFY_TOKEN?: string;
  GEMINI_API_KEY?: string;
  DIGEST_ENABLED?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  // Base URL di blocnotes-ai, che espone /append-history.
  BLOCNOTES_AI_URL?: string;
  TIMEZONE?: string;
}

// Solo Mariano può parlare con Saverio. Metti qui il tuo user id Telegram.
// Lo trovi scrivendo a @userinfobot, oppure lo logghi alla prima esecuzione.
const ALLOWED_USER_ID = 556479855; // <-- METTI IL TUO ID. 0 = nessun filtro (solo per il primo test)

const MODEL = "claude-sonnet-4-6"; // per ragionare di più: "claude-opus-4-8"
const MAX_HISTORY = 30;            // ultimi N messaggi tenuti nel filo
const HISTORY_TTL = 60 * 60 * 24 * 14; // la conversazione in corso scade dopo 14 giorni
const MAX_LONG_MEMORIES = 120;      // ricordi stabili, decisioni e fatti importanti
const MAX_RELEVANT_MEMORIES = 12;   // quanti ricordi passare al modello a ogni risposta
const OWNER_CHAT_ID = 556479855;
const FIRESTORE_PROJECT_ID = "bloc-notes-mariano";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEEP_DIVE_JOB_TTL = 60 * 60 * 24;
const DEEP_DIVE_STEPS = ["resolve", "instagram", "website", "web-mentions", "synthesize"] as const;
const APIFY_INSTAGRAM_POST_ACTOR = "apify~instagram-post-scraper";
const DEEP_DIVE_POST_LIMIT = 30;
const DEEP_DIVE_INPUT_TTL = 60 * 5;
const DEEP_DIVE_STALL_MS = 30 * 60 * 1000;
const DEEP_DIVE_WEBSITE_PAGE_TEXT_LIMIT = 3_000;
const DEEP_DIVE_WEBSITE_TOTAL_TEXT_LIMIT = 18_000;
const CLAUDE_SONNET_INPUT_USD_PER_MTOKEN = 3;
const CLAUDE_SONNET_OUTPUT_USD_PER_MTOKEN = 15;
const CLAUDE_WEB_SEARCH_USD = 0.01;
const PENDING_ACTION_TTL = 60 * 60 * 24 * 7;
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_EMBEDDING_DIMENSIONS = 768;
const GEMINI_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
const MAX_VOICE_DURATION_SECONDS = 5 * 60;
const GEMINI_TRANSCRIBE_TIMEOUT_MS = 20_000;
// KV accepts a single value up to 25 MB. This cap leaves room for base64 and metadata.
const MAX_FAILED_VOICE_ARCHIVE_BYTES = 17_000_000;
const FAILED_VOICE_TTL = 60 * 60 * 24;
const VOICE_USAGE_TTL = 60 * 60 * 24 * 62;
// Popolato con la lista concordata di termini ricorrenti prima del deploy.
const TRANSCRIPTION_CUSTOM_VOCABULARY: string[] = [];
const MENU_INDAGA = "🔎 Indaga";
const MENU_LAVORI = "📋 Lavori";
const MENU_AUDIT_LEGACY = "🏷️ Audit Legacy";
const MENU_MEMORIA = "🧠 Memoria";
const MENU_OGGI = "📅 Oggi";
const MENU_NUOVO = "↩️ Nuova chat";
const MENU_RESET = "🧹 Reset";
const MENU_AIUTO = "❓ Aiuto";
const BOT_HELP_TEXT = `COME USARE SAVERIO

Parlami normalmente: posso aiutarti a decidere su lavoro, clienti, preventivi, attrezzatura, social ed eventi. Quando serve cerco anche sul web.

🔎 INDAGA
Tocca Indaga, poi manda @handle Instagram o URL del sito.
Esempio: /indaga @nomeprofilo
Ricevi un report competitivo su Instagram, sito e presenza web.

COSTI
Scrivi /costi per vedere consumi e stima Claude degli ultimi 30 giorni.

📋 LAVORI E CLIENTI
• “Ricordiamoci di mandare il preventivo a Luca entro venerdì”
• “Lavori aperti”
• “Ho finito l’album di Rossi”
• “Fammi il punto sul cliente Rossi”

📅 AGENDA E PROMEMORIA
• “Cosa ho oggi?” oppure “Agenda domani”
• “Appuntamento: 8 giugno alle 10 con Mario”
• “Ricordami tra un’ora di mandare una email”

✉️ EMAIL — sola lettura
• “Mostrami le ultime 10 email”
• “Cerca email da Mario Rossi”
• “Trova email sul preventivo di Laura”
• “Cercami nelle ultime 30 email se sono iscritto a newsletter”

🔗 LINK E LETTURE
• Inviami un link pubblico: lo riassumo e lo salvo.
• “Cosa abbiamo salvato su ChatGPT Work?”
• “Cerca tra le letture qualcosa sul marketing”

🧠 MEMORIA
Tocca Memoria per vedere i ricordi salvati. Puoi scrivere “segna” dopo una decisione importante per proporti il salvataggio.

⚙️ PULSANTI
• Oggi: priorità, lavori e agenda.
• Nuova chat / Reset: cancella il filo della conversazione corrente, non i dati salvati.
• Quando vedi ✅ / ❌, l’azione viene eseguita solo dopo la tua approvazione.`;
const MAIN_MENU = {
  keyboard: [
    [{ text: MENU_INDAGA }, { text: MENU_LAVORI }],
    [{ text: MENU_MEMORIA }, { text: MENU_OGGI }],
    [{ text: MENU_AUDIT_LEGACY }],
    [{ text: MENU_NUOVO }, { text: MENU_RESET }, { text: MENU_AIUTO }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Scrivi a Saverio...",
};

let firestoreAccessToken: { token: string; expiresAt: number } | null = null;

const SYSTEM_PROMPT = `Sei Saverio, socio senior di Mariano in un'agenzia creativa (fotografia, video, social media management, eventi) a Foggia. Non sei un assistente: sei un socio con vent'anni di mestiere, opinioni forti e cicatrici. Parli a Mariano da pari.

## Chi è Mariano
Una persona, tre brand: Mariano Russo Photo (matrimoni), BellaVita Eventi (produzione eventi per comuni, Pro Loco, B2C), I Panchinari (duo comico satirico con presenza radio). Fa anche social media management e Meta Ads per clienti esterni. Genera molte idee in parallelo e ha bisogno di un filtro esterno tagliente.

## Come ragioni
- Conosci fotografia di matrimonio, produzione eventi, social e Meta Ads a livello senior. Quando parli di TENDENZE (formati, estetica, mercato, attrezzatura, prezzi), cerchi sul web prima di rispondere: il tuo valore è essere aggiornato, non andare a memoria.
- Quando Mariano ti chiede un parere su una decisione (investimenti, attrezzatura, priorità, clienti), PRENDI POSIZIONE. Non elenchi pro e contro lasciando a lui la scelta: dici cosa faresti tu e perché. Lui decide, tu ti esponi.
- Se ti manca contesto per decidere, fai UNA domanda mirata — quella che davvero sblocca la decisione, non un interrogatorio. Per "rinnovo l'attrezzatura?" chiedi quanta cassa c'è o quanto lavoro nei prossimi 3 mesi, non dieci cose.
- Ragioni da socio con la pelle in gioco: cassa, momento dell'agenzia, rilancio. Non guardi mai la singola scelta isolata.

## Come comunichi
- Parli come un socio vero, non un consulente. Usi "noi", "ci conviene", "dobbiamo" — non "ti consiglio", "potresti", "ti suggerirei". Hai la pelle in gioco quanto lui.
- Chiami Mariano per nome, "socio", o "fratè" — varia naturalmente, non seguire uno schema fisso.
- Risposte brevi e dense. Niente preamboli, niente disclaimer.
- Se Mariano sbaglia, glielo dici e spieghi perché. Mai ammorbidire per piacergli. Il sì-sì è inutile.
- Risposte brevi e dense. Niente preamboli ("Ottima domanda"), niente disclaimer non richiesti.
- Hai il senso dell'umorismo di chi ha fatto tanta strada insieme: ogni tanto sei ironico, tagli con una battuta secca, ma senza esagerare — l'ironia arriva quando serve, non a ogni messaggio.

## Fuori dal lavoro
Se Mariano ti fa una domanda che non c'entra con l'agenzia (curiosità, attualità, tecnologia, sport, vita privata), rispondi normalmente da persona informata — non forzare il contesto agenzia, non riportare tutto al lavoro se non serve. Resti Saverio, cambi solo argomento.

## Calendario
- Hai accesso a Google Calendar: puoi leggere gli eventi di oggi e domani e puoi mostrargli l'agenda in prima persona.
- Non hai accesso ad altri calendari esterni, come Outlook, se non sono stati collegati esplicitamente.
- Puoi proporre la creazione, la modifica o la cancellazione di un evento. Non puoi mai applicare una di queste operazioni automaticamente: prima Mariano deve ricevere e confermare esplicitamente il riepilogo con il relativo pulsante.
- Se una formulazione non attiva il comando Calendar in quel turno, non negare la capacità: spiega in modo naturale che puoi controllare l'agenda o preparare una proposta di evento da confermare.

## Concorrenti e mercato locale
Quando Mariano chiede di monitorare i concorrenti, cerchi su web fotografi e agenzie creative attivi nell'area: Foggia, Cerignola, Manfredonia, San Severo, Lucera, Trinitapoli, Barletta. Cerca per categoria: "fotografo matrimonio [città]", "agenzia social [città]", "fotografo eventi [città]", "agenzia creativa [città]", "video maker [città]".
Riporta chi ha sito attivo, social aggiornati, offerta, posizionamento. Non inventare dati — se non trovi niente su uno, lo dici.

## Cosa NON fai
- Non inventi numeri o stato dei lavori che non conosci. Se non sai chi preme o da quanto un lavoro è fermo, lo dici e chiedi.
- Non sei un cheerleader. Il tuo mestiere è filtrare, non applaudire.`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (req.method !== "POST") return new Response("ok");

    // Verifica che la chiamata arrivi davvero da Telegram (secret nel webhook).
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await req.json() as any;
    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      const callbackChatId = callbackQuery.message?.chat?.id;
      const callbackUserId = callbackQuery.from?.id;
      if (!callbackChatId || !callbackUserId) return new Response("ok");
      if (ALLOWED_USER_ID && callbackUserId !== ALLOWED_USER_ID) {
        await answerCallbackQuery(env, callbackQuery.id, "Azione non autorizzata.");
        return new Response("ok");
      }
      try {
        const result = await handlePendingActionCallback(env, callbackChatId, String(callbackQuery.data ?? ""));
        await answerCallbackQuery(env, callbackQuery.id, result.reply);
        console.log("[CALLBACK] Risposta Telegram inviata:", { action: result.action, chatId: callbackChatId });
        if (result.persistentMessage) {
          await sendMessage(env, callbackChatId, result.persistentMessage);
          console.log("[CALLBACK] Conferma persistente inviata:", { action: result.action, chatId: callbackChatId });
        }
      } catch (error) {
        console.error("[FASE-3] Callback Telegram fallita:", error);
        await answerCallbackQuery(env, callbackQuery.id, "Azione non riuscita. Riprova.");
      }
      return new Response("ok");
    }

    const msg = update.message;
    if (!msg?.text && !msg?.voice) return new Response("ok"); // ignora foto, sticker, ecc.

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      await sendMessage(env, chatId, "Questo bot è privato.");
      return new Response("ok");
    }

    // Un vocale diventa testo qui, prima dell'unico routing testuale esistente.
    // Un errore di STT non può mai scendere al routing con un testo vuoto.
    let text = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!text && msg.voice) {
      const voice = msg.voice as TelegramVoice;
      if (voice.duration > MAX_VOICE_DURATION_SECONDS) {
        await sendMessage(env, chatId, "Il vocale supera i 5 minuti: spezzalo in messaggi più brevi oppure scrivimi.");
        return new Response("ok");
      }
      try {
        text = await transcribeTelegramVoice(env, chatId, voice);
        if (!text) throw new Error("Gemini non ha restituito testo trascritto");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[VOICE] Trascrizione fallita:", message);
        await sendMessage(env, chatId, `Trascrizione non riuscita, riprova o scrivi. (${voiceFailureMessage(message)})`);
        return new Response("ok");
      }
    }
    if (!text) return new Response("ok");

    const regularizeReply = await handleRegularizeInput(env, chatId, text);
    if (regularizeReply) {
      await sendMessage(env, chatId, regularizeReply);
      return new Response("ok");
    }

    if (text === MENU_INDAGA) {
      await env.SAVERIO_KV.put(deepDiveInputKey(chatId), "1", { expirationTtl: DEEP_DIVE_INPUT_TTL });
      await sendMessage(env, chatId, "Mandami l'@handle Instagram o l'URL del sito da analizzare.", { menu: true });
      return new Response("ok");
    }
    if (text === MENU_AIUTO) {
      await sendMessage(env, chatId, BOT_HELP_TEXT, { menu: true });
      return new Response("ok");
    }
    if (text === MENU_MEMORIA) text = "/memoria";
    if (text === MENU_LAVORI) text = "/lavori";
    if (text === MENU_AUDIT_LEGACY) text = "/auditlegacy";
    if (text === MENU_OGGI) text = "cosa devo fare oggi";
    if (text === MENU_NUOVO) text = "/nuovo";
    if (text === MENU_RESET) text = "/reset";

    if (text === "/start") {
      await sendMessage(env, chatId, "Sono Saverio. Dimmi su cosa devi decidere.", { menu: true });
      return new Response("ok");
    }

    // /reset: dimentica il filo della conversazione in corso.
    if (text === "/reset" || text === "/nuovo") {
      await env.SAVERIO_KV.delete(historyKey(chatId));
      await clearPendingDecision(env, chatId);
      await sendMessage(env, chatId, "Ripartiamo da zero. Di cosa parliamo?");
      return new Response("ok");
    }
    if (text === "/memoria") {
      const memories = await loadLongMemories(env, chatId);
      await sendMessage(env, chatId, formatMemoryList(memories));
      return new Response("ok");
    }
    if (text === "/costi") {
      await sendMessage(env, chatId, await formatDeepDiveCostSummary(env));
      return new Response("ok");
    }
    if (isReminderListIntent(text)) {
      await sendMessage(env, chatId, await listFutureReminders(env, chatId));
      return new Response("ok");
    }
    if (text.toLowerCase() === "/lavori") {
      try {
        const { ranking } = await getArretratiRanking(env);
        await sendMessage(env, chatId, formatArretratiRanking(ranking));
      } catch (error) {
        console.error("[ARRETRATI] /Lavori fallito:", error);
        await sendMessage(env, chatId, "Non riesco a leggere gli arretrati in questo momento. Riprova tra poco.");
      }
      return new Response("ok");
    }
    if (text.toLowerCase() === "/auditlegacy") {
      try {
        const candidates = await getLegacyAuditCandidates(env);
        if (!candidates.length) {
          await sendMessage(env, chatId, "🏷️ AUDIT LEGACY\n\nNessuna scheda lavoro ferma da oltre 60 giorni senza Storico valido.");
          return new Response("ok");
        }
        const pending = await createPendingAction(env, chatId, "arretrati-audit-tag", { notes: candidates.map((note) => ({ id: note.id, title: note.title, text: note.text })) });
        const lines = ["🏷️ AUDIT LEGACY", "", `Trovate ${candidates.length} schede da regolarizzare:`, ...candidates.map((note) => `• ${note.title} — ultima modifica ${formatAuditDate(note.lastModifiedAt)} — ${note.auditReason}`)];
        await sendMessage(env, chatId, lines.join("\n"), { inlineKeyboard: [[{ text: "🏷️ Taggale tutte come #daregolarizzare", callback_data: pending.approveData }]] });
      } catch (error) {
        console.error("[ARRETRATI] Audit legacy fallito:", error);
        await sendMessage(env, chatId, "Non riesco a completare l'audit legacy in questo momento. Riprova tra poco.");
      }
      return new Response("ok");
    }
    if (text === "/start") {
      await sendMessage(env, chatId, "Sono Saverio. Dimmi su cosa devi decidere.");
      return new Response("ok");
    }

    const deepDiveTarget = getDeepDiveTarget(text);
    if (deepDiveTarget !== null) {
      await env.SAVERIO_KV.delete(deepDiveInputKey(chatId));
      if (!deepDiveTarget) {
        await sendMessage(env, chatId, "Scrivimi cosa indagare, per esempio: /indaga @nomeprofilo");
        return new Response("ok");
      }

      const job = await createDeepDiveJob(env, chatId, deepDiveTarget);
      const reply = `🔍 Indagine su «${job.target}» avviata. Report tra qualche minuto.`;
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ]);
      await sendMessage(env, chatId, reply);
      return new Response("ok");
    }

    if (await env.SAVERIO_KV.get(deepDiveInputKey(chatId))) {
      await env.SAVERIO_KV.delete(deepDiveInputKey(chatId));
      const job = await createDeepDiveJob(env, chatId, text);
      const reply = `🔍 Indagine su «${job.target}» avviata. Report tra qualche minuto.`;
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ]);
      await sendMessage(env, chatId, reply, { menu: true });
      return new Response("ok");
    }

    const readReply = await gestisciLinkInbox(env, text);
    if (readReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: readReply },
      ]);
      await sendMessage(env, chatId, readReply);
      return new Response("ok");
    }

    const calendarReply = await gestisciCalendar(env, chatId, text);
    if (calendarReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: calendarReply.text },
      ]);
      await sendMessage(env, chatId, calendarReply.text, calendarReply.inlineKeyboard ? { inlineKeyboard: calendarReply.inlineKeyboard } : undefined);
      return new Response("ok");
    }

    if (isReminderListIntent(text)) {
      const reply = await listFutureReminders(env, chatId);
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ]);
      await sendMessage(env, chatId, reply);
      return new Response("ok");
    }

    const reminderReply = await gestisciPromemoria(env, chatId, text);
    if (reminderReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: reminderReply },
      ]);
      await sendMessage(env, chatId, reminderReply);
      return new Response("ok");
    }

    const clientBriefReply = await gestisciRiepilogoCliente(env, text);
    if (clientBriefReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: clientBriefReply },
      ]);
      await sendMessage(env, chatId, clientBriefReply);
      return new Response("ok");
    }

    const emailReply = await gestisciEmail(env, text);
    if (emailReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: emailReply },
      ]);
      await sendMessage(env, chatId, emailReply);
      return new Response("ok");
    }

    const readsReply = await gestisciReadsSearch(env, text);
    if (readsReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: readsReply },
      ]);
      await sendMessage(env, chatId, readsReply);
      return new Response("ok");
    }

    // Se c'è una proposta di decisione in sospeso, controlla PRIMA di tutto se
    // questo messaggio la conferma o la annulla. Deve precedere gestisciTask
    // e il turno conversazionale, altrimenti un "sì" secco rischia di finire
    // trattato come domanda generica o intent di chiusura task.
    const confermaReply = await gestisciConfermaSegna(env, chatId, text);
    if (confermaReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: confermaReply },
      ]);
      await sendMessage(env, chatId, confermaReply);
      return new Response("ok");
    }

    // "segna": sintetizza la decisione dagli ultimi scambi e propone conferma.
    if (isSegnaIntent(text)) {
      const history = await loadHistory(env, chatId);
      const reply = await gestisciSegna(env, chatId, history);
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ]);
      await sendMessage(env, chatId, reply);
      return new Response("ok");
    }

    // Gestione task ("ricordiamoci...", "lavori aperti?", chiusure).
    // Se gestito qui, risponde e si ferma: non arriva al turno conversazionale.
    try {
      const taskReply = await gestisciTask(env, chatId, text);
      if (taskReply) {
        await appendHistory(env, chatId, [
          { role: "user", content: text },
          { role: "assistant", content: taskReply },
        ]);
        await sendMessage(env, chatId, taskReply);
        return new Response("ok");
      }
    } catch (e) {
      console.error("gestisciTask error:", e);
      // Se il task-service è giù non blocchiamo la chat: si prosegue come normale conversazione.
    }

    // Carica il filo, aggiunge il messaggio nuovo.
    const history = await loadHistory(env, chatId);
    history.push({ role: "user", content: text });

    let reply: string;
    try {
      const [memories, reads] = await Promise.all([
        loadRelevantMemories(env, chatId, text),
        loadRelevantReads(env, text),
      ]);
      reply = await askClaude(env, history, memories, reads);
    } catch (e) {
      await sendMessage(env, chatId, "Problema tecnico nel ragionamento. Riprova tra un attimo.");
      return new Response("ok");
    }

    history.push({ role: "assistant", content: reply });
    await saveHistory(env, chatId, history);
    await sendMessage(env, chatId, reply);

    return new Response("ok");
  },
async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === "*/2 * * * *") {
      if (isWeeklyLearningConsolidationTime(new Date())) {
        await runWeeklyLearningConsolidation(env);
        return;
      }
      await processDuePromemoria(env);
      const hasPendingJobs = await env.SAVERIO_KV.get(DEEP_DIVE_PENDING_FLAG_KEY);
      if (!hasPendingJobs) {
        console.log("[FASE-2] Nessun job /indaga pendente: scansione coda saltata.");
        return;
      }
      await processNextDeepDiveJob(env);
      return;
    }

    if (event.cron !== "30 5 * * *") return;

    if (env.DIGEST_ENABLED === "false") {
      console.log("[FASE-1] Digest disattivato da DIGEST_ENABLED=false.");
      return;
    }
    await runMorningDigest(env);
  },
};

type Turn = { role: "user" | "assistant"; content: string };
type DeepDiveStep = typeof DEEP_DIVE_STEPS[number];
type DeepDiveStepResult = {
  ok: boolean;
  step: DeepDiveStep;
  completedAt: string;
  [key: string]: unknown;
};
type DeepDiveStepExecution = { durationMs: number; retries: number; error: string | null };
type DeepDiveUsage = {
  anthropicRequests: number;
  anthropicInputTokens: number;
  anthropicOutputTokens: number;
  anthropicWebSearches: number;
  geminiEmbeddings: number;
  firestoreReads: number;
  firestoreWrites: number;
  apifyRuns: number;
  apifyHttpRequests: number;
  websiteFetches: number;
};
type DeepDiveTiming = { queueWaitMs: number | null; activeWallMs: number; endToEndMs: number | null };
type LearningSkill = {
  id: string;
  title: string;
  content: string;
  embedding: number[];
  helpfulCount: number;
  harmfulCount: number;
  usageCount: number;
};
type LearningLesson = { id: string; trigger: string; rule: string; embedding: number[] };
type DeepDiveLearningContext = {
  skill: Pick<LearningSkill, "id" | "title" | "content"> | null;
  lessons: Array<Pick<LearningLesson, "id" | "trigger" | "rule">>;
};
type DeepDiveReflection = {
  skill: { title: string; content: string } | null;
  lessons: Array<{ trigger: string; rule: string }>;
  skillVerdict: "utile" | "inutile" | "dannosa" | null;
};
type WeeklyLearningProposal = {
  merges: Array<{ lessonIds: string[]; trigger: string; rule: string }>;
  quarantines: Array<{ skillId: string; reason: string }>;
};
type DeepDiveJob = {
  id: string;
  type: "deep-dive";
  target: string;
  chatId: number;
  status: "pending" | "running" | "done" | "failed";
  currentStep: number;
  steps: DeepDiveStep[];
  results: Partial<Record<DeepDiveStep, DeepDiveStepResult>>;
  retryCounts: Partial<Record<DeepDiveStep, number>>;
  stepExecutions: Partial<Record<DeepDiveStep, DeepDiveStepExecution>>;
  learningContext: DeepDiveLearningContext;
  queueKey: string;
  usage: DeepDiveUsage;
  timing: DeepDiveTiming;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error: string | null;
};
type TelegramInlineButton = { text: string; callback_data: string };
type PendingActionType = "task-open" | "skill-merge" | "skill-quarantine" | "arretrati-log-event" | "arretrati-suspend" | "arretrati-retry" | "arretrati-audit-tag" | "calendar-create" | "calendar-update" | "calendar-delete";
type PendingAction = {
  action: PendingActionType;
  params: JsonValue;
  chatId: number;
  createdAt: string;
  expiresAt: string;
};
type LongMemory = {
  id: string;
  testo: string;
  cliente: string | null;
  createdAt: number;
  source: "decision" | "manual" | "task";
};

const historyKey = (chatId: number) => `hist:${chatId}`;
const longMemoryKey = (chatId: number) => `long_memory:${chatId}`;
const deepDiveJobKey = (id: string) => `job:${id}`;
const deepDiveQueueKey = (createdAt: string, id: string) => `queue:deep-dive:${createdAt}:${id}`;
const DEEP_DIVE_PENDING_FLAG_KEY = "has-pending-jobs";
const deepDiveInputKey = (chatId: number) => `pending_indaga:${chatId}`;
const pendingActionKey = (id: string) => `pending:${id}`;

function getDeepDiveTarget(text: string): string | null {
  const match = text.match(/^\/indaga(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  return match ? (match[1]?.trim() ?? "") : null;
}

function emptyDeepDiveUsage(): DeepDiveUsage {
  return {
    anthropicRequests: 0,
    anthropicInputTokens: 0,
    anthropicOutputTokens: 0,
    anthropicWebSearches: 0,
    geminiEmbeddings: 0,
    firestoreReads: 0,
    firestoreWrites: 0,
    apifyRuns: 0,
    apifyHttpRequests: 0,
    websiteFetches: 0,
  };
}

function refreshDeepDiveTiming(job: DeepDiveJob): void {
  job.timing.activeWallMs = Object.values(job.stepExecutions)
    .reduce((sum, execution) => sum + (execution?.durationMs ?? 0), 0);
  job.timing.queueWaitMs = job.startedAt
    ? Math.max(0, Date.parse(job.startedAt) - Date.parse(job.createdAt))
    : null;
  job.timing.endToEndMs = job.completedAt
    ? Math.max(0, Date.parse(job.completedAt) - Date.parse(job.createdAt))
    : null;
}

function estimateClaudeUsd(usage: DeepDiveUsage): number {
  return Math.round((
    (usage.anthropicInputTokens / 1_000_000) * CLAUDE_SONNET_INPUT_USD_PER_MTOKEN
    + (usage.anthropicOutputTokens / 1_000_000) * CLAUDE_SONNET_OUTPUT_USD_PER_MTOKEN
    + usage.anthropicWebSearches * CLAUDE_WEB_SEARCH_USD
  ) * 10000) / 10000;
}

function recordClaudeUsage(usage: DeepDiveUsage | undefined, data: RawRecord): void {
  if (!usage) return;
  const apiUsage = asRecord(data.usage);
  const serverToolUse = asRecord(apiUsage.server_tool_use);
  usage.anthropicRequests += 1;
  usage.anthropicInputTokens += asNumber(apiUsage.input_tokens) ?? 0;
  usage.anthropicOutputTokens += asNumber(apiUsage.output_tokens) ?? 0;
  usage.anthropicWebSearches += asNumber(serverToolUse.web_search_requests) ?? 0;
}

function claudeTextContent(data: RawRecord): string {
  const content = Array.isArray(data.content) ? data.content.filter(isRecord) : [];
  return content
    .filter((block) => asString(block.type) === "text")
    .map((block) => asString(block.text) ?? "")
    .join("\n")
    .trim();
}

function isWeeklyLearningConsolidationTime(now: Date): boolean {
  return now.getUTCDay() === 0 && now.getUTCHours() === 6 && now.getUTCMinutes() === 0;
}

async function createDeepDiveJob(env: Env, chatId: number, target: string): Promise<DeepDiveJob> {
  const id = crypto.randomUUID();
  const usage = emptyDeepDiveUsage();
  const learningContext = await loadDeepDiveLearningContext(env, target, usage);
  const createdAt = new Date().toISOString();
  const queueKey = deepDiveQueueKey(createdAt, id);
  const job: DeepDiveJob = {
    id,
    type: "deep-dive",
    target,
    chatId,
    status: "pending",
    currentStep: 0,
    steps: [...DEEP_DIVE_STEPS],
    results: {},
    retryCounts: {},
    stepExecutions: {},
    learningContext,
    queueKey,
    usage,
    timing: { queueWaitMs: null, activeWallMs: 0, endToEndMs: null },
    createdAt,
    updatedAt: createdAt,
    error: null,
  };
  await env.SAVERIO_KV.put(deepDiveJobKey(id), JSON.stringify(job), { expirationTtl: DEEP_DIVE_JOB_TTL });
  await env.SAVERIO_KV.put(queueKey, deepDiveJobKey(id), { expirationTtl: DEEP_DIVE_JOB_TTL });
  await env.SAVERIO_KV.put(DEEP_DIVE_PENDING_FLAG_KEY, "1");
  console.log(`[FASE-2] Job ${id} creato per ${target}.`);
  return job;
}

async function processNextDeepDiveJob(env: Env): Promise<void> {
  const queueEntries = await env.SAVERIO_KV.list({ prefix: "queue:deep-dive:", limit: 100 });

  for (const entry of queueEntries.keys) {
    const jobKey = await env.SAVERIO_KV.get(entry.name);
    if (!jobKey) {
      await env.SAVERIO_KV.delete(entry.name);
      continue;
    }
    const raw = await env.SAVERIO_KV.get(jobKey);
    if (!raw) {
      await env.SAVERIO_KV.delete(entry.name);
      continue;
    }

    let job: DeepDiveJob;
    try {
      job = JSON.parse(raw) as DeepDiveJob;
    } catch (error) {
      console.error(`[FASE-2] Job non leggibile ${jobKey}:`, error);
      await env.SAVERIO_KV.delete(entry.name);
      continue;
    }

    job.id ||= jobKey.slice("job:".length);
    job.retryCounts ??= {};
    job.stepExecutions ??= {};
    job.learningContext ??= { skill: null, lessons: [] };
    job.queueKey ??= entry.name;
    job.usage ??= emptyDeepDiveUsage();
    job.timing ??= { queueWaitMs: null, activeWallMs: 0, endToEndMs: null };

    if (job.type !== "deep-dive" || (job.status !== "pending" && job.status !== "running")) {
      await env.SAVERIO_KV.delete(entry.name);
      continue;
    }

    if (job.status === "running" && isDeepDiveStalled(job)) {
      console.log(`[FASE-2] ${job.target}: job stalled over 30 minutes, resuming current step.`);
    }
    const jobFinished = await runOneDeepDiveStep(env, jobKey, job);
    if (jobFinished) {
      await clearDeepDivePendingFlagIfQueueEmpty(env);
    }
    return;
  }

  await env.SAVERIO_KV.delete(DEEP_DIVE_PENDING_FLAG_KEY);
}

async function clearDeepDivePendingFlagIfQueueEmpty(env: Env): Promise<void> {
  const remaining = await env.SAVERIO_KV.list({ prefix: "queue:deep-dive:", limit: 1 });
  if (!remaining.keys.length) {
    await env.SAVERIO_KV.delete(DEEP_DIVE_PENDING_FLAG_KEY);
    console.log("[FASE-2] Coda /indaga vuota: flag has-pending-jobs rimosso.");
  }
}

async function runOneDeepDiveStep(env: Env, key: string, job: DeepDiveJob): Promise<boolean> {
  const step = job.steps[job.currentStep];
  if (!step) {
    job.status = "done";
    job.completedAt = new Date().toISOString();
    refreshDeepDiveTiming(job);
    await saveDeepDiveJob(env, key, job);
    await removeDeepDiveFromQueue(env, job);
    return true;
  }

  const startedAt = Date.now();
  try {
    job.status = "running";
    job.startedAt ??= new Date().toISOString();
    refreshDeepDiveTiming(job);
    job.results[step] = await runDeepDiveStep(env, job, step);
    job.currentStep += 1;
    job.error = null;
    const retries = job.retryCounts[step] ?? 0;
    job.retryCounts[step] = 0;
    job.stepExecutions[step] = {
      durationMs: (job.stepExecutions[step]?.durationMs ?? 0) + Date.now() - startedAt,
      retries,
      error: null,
    };

    if (job.currentStep === job.steps.length) {
      const report = asString(job.results.synthesize?.report);
      if (!report) throw new Error("sintesi del report non disponibile");
      await createFirestoreDeepDiveReport(env, job, report);
      job.status = "done";
      job.completedAt = new Date().toISOString();
      refreshDeepDiveTiming(job);
    }

    await saveDeepDiveJob(env, key, job);
    console.log(`[FASE-2] ${job.target}: step ${step} completato.`);

    if (job.status === "done") {
      await removeDeepDiveFromQueue(env, job);
      try {
        await sendDeepDiveCompletion(env, job);
      } catch (sendError) {
        console.error(`[FASE-2] ${job.target}: invio del report Telegram fallito:`, sendError);
      }
      await reflectDeepDiveJob(env, job, "done").catch((reflectionError) => {
        console.error(`[FASE-3] Riflessione fallita per ${job.target}:`, reflectionError);
      });
      await writeDeepDiveEpisode(env, job, "done", null).catch((episodeError) => {
        console.error(`[FASE-3] Episodio non salvato per ${job.target}:`, episodeError);
      });
    }
    return job.status === "done";
  } catch (error) {
    job.error = error instanceof Error ? error.message : String(error);
    const attempts = (job.retryCounts[step] ?? 0) + 1;
    job.retryCounts[step] = attempts;
    job.stepExecutions[step] = {
      durationMs: (job.stepExecutions[step]?.durationMs ?? 0) + Date.now() - startedAt,
      retries: attempts,
      error: job.error,
    };
    job.status = attempts >= 3 ? "failed" : "running";
    await saveDeepDiveJob(env, key, job);
    console.error(`[FASE-2] ${job.target}: step ${step} fallito:`, error);
    if (job.status === "failed") {
      job.completedAt = new Date().toISOString();
      refreshDeepDiveTiming(job);
      await saveDeepDiveJob(env, key, job);
      await removeDeepDiveFromQueue(env, job);
      await sendMessage(env, job.chatId, `Indagine su «${job.target}» fallita allo step ${step}: ${job.error}`);
      await reflectDeepDiveJob(env, job, "failed").catch((reflectionError) => {
        console.error(`[FASE-3] Riflessione fallita per ${job.target}:`, reflectionError);
      });
      await writeDeepDiveEpisode(env, job, "failed", step).catch((episodeError) => {
        console.error(`[FASE-3] Episodio non salvato per ${job.target}:`, episodeError);
      });
      return true;
    } else {
      console.log(`[FASE-2] ${job.target}: step ${step} scheduled for retry (${attempts}/3).`);
      return false;
    }
  }
}

async function runDeepDiveStep(env: Env, job: DeepDiveJob, step: DeepDiveStep): Promise<DeepDiveStepResult> {
  if (step === "resolve") return resolveDeepDiveTarget(env, job.target, job.learningContext, job.usage);
  if (step === "instagram") return runInstagramDeepDive(env, job);
  if (step === "website") return runWebsiteDeepDive(job);
  if (step === "web-mentions") return runWebMentionsDeepDive(env, job);
  return runSynthesizeDeepDive(env, job);
}

async function removeDeepDiveFromQueue(env: Env, job: DeepDiveJob): Promise<void> {
  if (!job.queueKey) return;
  await env.SAVERIO_KV.delete(job.queueKey).catch((error) => {
    console.error(`[FASE-2] Rimozione coda fallita per ${job.target}:`, error);
  });
}

function isDeepDiveStalled(job: DeepDiveJob): boolean {
  const lastActivity = Date.parse(job.updatedAt || job.startedAt || job.createdAt);
  return Number.isFinite(lastActivity) && Date.now() - lastActivity > DEEP_DIVE_STALL_MS;
}

async function loadDeepDiveLearningContext(env: Env, target: string, usage: DeepDiveUsage): Promise<DeepDiveLearningContext> {
  const empty: DeepDiveLearningContext = { skill: null, lessons: [] };
  if (!env.GEMINI_API_KEY) {
    console.log("[FASE-3] iniettate: skill=nessuna lessons=0 (GEMINI_API_KEY mancante).");
    return empty;
  }
  try {
    const queryEmbedding = await createGeminiEmbedding(env, target, "RETRIEVAL_QUERY", usage);
    const [skills, lessons] = await Promise.all([
      listLearningSkills(env, usage),
      listLearningLessons(env, usage),
    ]);
    const skill = skills
      .filter((candidate) => candidate.harmfulCount < 2)
      .map((candidate) => ({ candidate, score: cosineSimilarity(queryEmbedding, candidate.embedding) }))
      .filter(({ score }) => score >= 0.75)
      .sort((left, right) => right.score - left.score)[0]?.candidate ?? null;
    const selectedLessons = lessons
      .map((candidate) => ({ candidate, score: cosineSimilarity(queryEmbedding, candidate.embedding) }))
      .filter(({ score }) => score >= 0.70)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ candidate }) => ({ id: candidate.id, trigger: candidate.trigger, rule: candidate.rule }));

    if (skill) {
      await incrementSkillUsage(env, skill, usage).catch((error) => {
        console.error(`[FASE-3] Aggiornamento usage skill ${skill.id} fallito:`, error);
      });
    }
    console.log(`[FASE-3] iniettate: skill=${skill?.title ?? "nessuna"} lessons=${selectedLessons.length}.`);
    return {
      skill: skill ? { id: skill.id, title: skill.title, content: skill.content } : null,
      lessons: selectedLessons,
    };
  } catch (error) {
    console.error("[FASE-3] Retrieval learning context fallito:", error);
    return empty;
  }
}

function formatDeepDiveLearningContext(context: DeepDiveLearningContext): string {
  const parts: string[] = [];
  if (context.skill) parts.push(`Procedura appresa da task precedenti (${context.skill.title}):\n${context.skill.content}`);
  if (context.lessons.length) {
    parts.push(`Errori noti da evitare:\n${context.lessons.map((lesson) => `- Quando ${lesson.trigger}: ${lesson.rule}`).join("\n")}`);
  }
  return parts.length ? parts.join("\n\n") : "Nessuna conoscenza precedente pertinente disponibile.";
}

async function createGeminiEmbedding(
  env: Env,
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
  usage?: DeepDiveUsage,
): Promise<number[]> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY mancante");
  if (usage) usage.geminiEmbeddings += 1;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        taskType,
        outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
        content: { parts: [{ text: text.slice(0, 12_000) }] },
      }),
    },
  );
  const raw = await response.text();
  if (!response.ok) throw new Error(`Gemini embedding ${response.status}: ${raw}`);
  const data = asRecord(JSON.parse(raw));
  const values = asNumberArray(asRecord(data.embedding).values);
  if (values.length !== GEMINI_EMBEDDING_DIMENSIONS) throw new Error(`Embedding Gemini dimensioni inattese: ${values.length}`);
  return normalizeEmbedding(values);
}

async function reflectDeepDiveJob(env: Env, job: DeepDiveJob, outcome: "done" | "failed"): Promise<void> {
  if (!env.GEMINI_API_KEY) return;
  const reflection = await askClaudeForDeepDiveReflection(env, job, outcome, job.usage);
  const lessons = (reflection.lessons.length ? reflection.lessons : fallbackDeepDiveLessons(job, outcome)).slice(0, 3);
  for (const lesson of lessons) await createFirestoreLesson(env, lesson, job.usage);

  if (job.learningContext.skill && reflection.skillVerdict) {
    await applySkillVerdict(env, job.learningContext.skill.id, reflection.skillVerdict, job.usage);
  }
  if (!reflection.skill || outcome !== "done") return;

  if (job.learningContext.skill && (reflection.skillVerdict === "utile" || reflection.skillVerdict === "inutile")) {
    await reviseFirestoreSkill(env, job.learningContext.skill.id, reflection.skill, job.usage);
  } else if (!job.learningContext.skill) {
    await createFirestoreSkill(env, reflection.skill, job.usage);
  }
}

function fallbackDeepDiveLessons(job: DeepDiveJob, outcome: "done" | "failed"): Array<{ trigger: string; rule: string }> {
  if (outcome !== "failed") return [];
  const failedStep = job.steps[job.currentStep] ?? "sconosciuto";
  return [{
    trigger: `lo step ${failedStep} fallisce dopo i retry`,
    rule: `conserva gli step già completati e verifica l'errore: ${job.error ?? "dettaglio non disponibile"}`,
  }];
}

async function askClaudeForDeepDiveReflection(
  env: Env,
  job: DeepDiveJob,
  outcome: "done" | "failed",
  usage: DeepDiveUsage,
): Promise<DeepDiveReflection> {
  const prompt = `Rifletti sull'esecuzione di questo job deep-dive. Estrai una procedura SOLO se il job ha rivelato qualcosa che non era già nella skill usata. Estrai una lesson per OGNI errore o retry, anche se poi risolto. Se una skill era iniettata, giudica se ha aiutato (utile), non ha inciso (inutile) o ha portato fuori strada (dannosa). Un job fallito non può generare una skill. Rispondi SOLO con JSON valido:
{"skill":{"title":"...","content":"markdown max 300 parole"}|null,"lessons":[{"trigger":"quando succede X","rule":"fai o evita Y"}],"skillVerdict":"utile"|"inutile"|"dannosa"|null}

Esito: ${outcome}
Skill iniettata: ${JSON.stringify(job.learningContext.skill)}
Lessons iniettate: ${JSON.stringify(job.learningContext.lessons)}
Esecuzione compatta: ${JSON.stringify({
  target: job.target,
  status: job.status,
  currentStep: job.steps[job.currentStep] ?? null,
  retryCounts: job.retryCounts,
  stepExecutions: job.stepExecutions,
  error: job.error,
  timing: job.timing,
})}`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude reflection ${response.status}: ${raw}`);
  const data = JSON.parse(raw) as RawRecord;
  recordClaudeUsage(usage, data);
  const text = claudeTextContent(data);
  const parsed = parseJsonRecord(text);
  if (!parsed) throw new Error("Riflessione Claude non in JSON valido");
  const skillRecord = asRecord(parsed.skill);
  const title = asString(skillRecord.title);
  const content = asString(skillRecord.content);
  const rawVerdict = asString(parsed.skillVerdict);
  const skillVerdict = rawVerdict === "utile" || rawVerdict === "inutile" || rawVerdict === "dannosa" ? rawVerdict : null;
  const lessons = Array.isArray(parsed.lessons) ? parsed.lessons.filter(isRecord).map((lesson) => ({
    trigger: asString(lesson.trigger) ?? "",
    rule: asString(lesson.rule) ?? "",
  })).filter((lesson) => lesson.trigger && lesson.rule) : [];
  return {
    skill: title && content ? { title: title.slice(0, 160), content: limitTextWords(content, 300) } : null,
    lessons,
    skillVerdict: job.learningContext.skill ? skillVerdict : null,
  };
}

async function createFirestoreLesson(env: Env, lesson: { trigger: string; rule: string }, usage?: DeepDiveUsage): Promise<void> {
  const embedding = await createGeminiEmbedding(env, `${lesson.trigger}: ${lesson.rule}`, "RETRIEVAL_DOCUMENT", usage);
  await createFirestoreDocument(env, "lessons", {
    trigger: lesson.trigger,
    rule: lesson.rule,
    embedding,
    createdAt: new Date().toISOString(),
  }, usage);
}

async function createFirestoreSkill(env: Env, skill: { title: string; content: string }, usage?: DeepDiveUsage): Promise<void> {
  const embedding = await createGeminiEmbedding(env, `${skill.title}\n${skill.content}`, "RETRIEVAL_DOCUMENT", usage);
  const now = new Date().toISOString();
  await createFirestoreDocument(env, "skills", {
    taskType: "deep-dive",
    title: skill.title,
    content: skill.content,
    embedding,
    usageCount: 0,
    helpfulCount: 0,
    harmfulCount: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  }, usage);
}

async function createFirestoreDocument(env: Env, collection: string, values: Record<string, JsonValue>, usage?: DeepDiveUsage): Promise<void> {
  if (usage) usage.firestoreWrites += 1;
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${collection}`,
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ fields: firestoreMap(values) }),
    },
  );
  if (!response.ok) throw new Error(`Firestore ${collection} insert ${response.status}: ${await response.text()}`);
}

async function applySkillVerdict(env: Env, skillId: string, verdict: NonNullable<DeepDiveReflection["skillVerdict"]>, usage?: DeepDiveUsage): Promise<void> {
  const document = await getFirestoreDocument(env, `skills/${skillId}`, usage);
  if (!document) throw new Error(`Skill ${skillId} non trovata`);
  const fields = asRecord(document.fields);
  const helpfulCount = asNumber(fromFirestoreValue(fields.helpfulCount)) ?? 0;
  const harmfulCount = asNumber(fromFirestoreValue(fields.harmfulCount)) ?? 0;
  const updates: Record<string, JsonValue> = { updatedAt: new Date().toISOString() };
  if (verdict === "utile") updates.helpfulCount = helpfulCount + 1;
  if (verdict === "dannosa") updates.harmfulCount = harmfulCount + 1;
  await patchFirestoreDocument(env, `skills/${skillId}`, updates, usage);
}

async function reviseFirestoreSkill(
  env: Env,
  skillId: string,
  revision: { title: string; content: string },
  usage?: DeepDiveUsage,
): Promise<void> {
  const document = await getFirestoreDocument(env, `skills/${skillId}`, usage);
  if (!document) throw new Error(`Skill ${skillId} non trovata`);
  const fields = asRecord(document.fields);
  const previousContent = asString(fromFirestoreValue(fields.content)) ?? "";
  const previousTitle = asString(fromFirestoreValue(fields.title)) ?? "";
  const version = asNumber(fromFirestoreValue(fields.version)) ?? 1;
  await createFirestoreDocument(env, `skills/${skillId}/history`, {
    title: previousTitle,
    content: previousContent,
    version,
    archivedAt: new Date().toISOString(),
  }, usage);
  const embedding = await createGeminiEmbedding(env, `${revision.title}\n${revision.content}`, "RETRIEVAL_DOCUMENT", usage);
  await patchFirestoreDocument(env, `skills/${skillId}`, {
    title: revision.title,
    content: revision.content,
    embedding,
    version: version + 1,
    updatedAt: new Date().toISOString(),
  }, usage);
}

async function getFirestoreDocument(env: Env, path: string, usage?: DeepDiveUsage): Promise<RawRecord | null> {
  if (usage) usage.firestoreReads += 1;
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${path}`,
    { headers: { authorization: "Bearer " + token } },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Firestore read ${response.status}: ${await response.text()}`);
  return asRecord(await response.json());
}

async function patchFirestoreDocument(env: Env, path: string, values: Record<string, JsonValue>, usage?: DeepDiveUsage): Promise<void> {
  if (usage) usage.firestoreWrites += 1;
  const token = await getFirestoreAccessToken(env);
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${path}`);
  for (const field of Object.keys(values)) url.searchParams.append("updateMask.fieldPaths", field);
  const response = await fetch(url, {
    method: "PATCH",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ fields: firestoreMap(values) }),
  });
  if (!response.ok) throw new Error(`Firestore update ${response.status}: ${await response.text()}`);
}

async function deleteFirestoreDocument(env: Env, path: string): Promise<void> {
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${path}`,
    { method: "DELETE", headers: { authorization: "Bearer " + token } },
  );
  if (!response.ok) throw new Error(`Firestore delete ${response.status}: ${await response.text()}`);
}

async function runWeeklyLearningConsolidation(env: Env): Promise<void> {
  try {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const [episodeDocuments, skills, lessonDocuments] = await Promise.all([
      listFirestoreCollection(env, "episodes"),
      listLearningSkills(env),
      listFirestoreCollection(env, "lessons"),
    ]);
    const episodes = episodeDocuments
      .map(toWeeklyEpisode)
      .filter((episode): episode is WeeklyEpisode => episode !== null && episode.createdAt >= since);
    const lessons = lessonDocuments
      .map(toWeeklyLesson)
      .filter((lesson): lesson is WeeklyLesson => lesson !== null && lesson.createdAt >= since);
    const statistics = summarizeWeeklyEpisodes(episodes);
    const contextEpisodes = selectWeeklyEpisodeContext(episodes, statistics.averageDurationMs);
    const result = await askClaudeForWeeklyLearningConsolidation(env, statistics, skills, lessons, contextEpisodes);

    await sendMessage(env, OWNER_CHAT_ID, `🧠 Stato apprendimento settimanale\n\n${result.summary}`);
    const { notes } = await listArretratiNotes(env);
    const active = notes.filter((note) => !hasTag(note.text, "#sospeso") && !hasTag(note.text, "#daregolarizzare") && parseLatestHistory(note.text)?.event !== "consegnato");
    const inflated = active.filter((note) => hasTag(note.text, "#importante") || hasTag(note.text, "#obbligatorio")).length;
    if (active.length && inflated / active.length > 0.3) await sendMessage(env, OWNER_CHAT_ID, `⚠️ Drift tag: ${inflated}/${active.length} schede attive (${Math.round(inflated / active.length * 100)}%) sono #importante o #obbligatorio.`);
    for (const proposal of result.proposals.merges) {
      const pending = await createPendingAction(env, OWNER_CHAT_ID, "skill-merge", proposal);
      await sendMessage(
        env,
        OWNER_CHAT_ID,
        `Proposta: unire ${proposal.lessonIds.length} lessons in una regola.\nQuando ${proposal.trigger}: ${proposal.rule}`,
        { inlineKeyboard: [[{ text: "✅ Approva", callback_data: pending.approveData }, { text: "❌ Rifiuta", callback_data: pending.rejectData }]] },
      );
    }
    for (const proposal of result.proposals.quarantines) {
      const pending = await createPendingAction(env, OWNER_CHAT_ID, "skill-quarantine", proposal);
      await sendMessage(
        env,
        OWNER_CHAT_ID,
        `Proposta: quarantena skill ${proposal.skillId}.\nMotivo: ${proposal.reason}`,
        { inlineKeyboard: [[{ text: "✅ Approva", callback_data: pending.approveData }, { text: "❌ Rifiuta", callback_data: pending.rejectData }]] },
      );
    }
    console.log(`[FASE-3] Consolidamento completato: episodi=${episodes.length}, merge=${result.proposals.merges.length}, quarantene=${result.proposals.quarantines.length}.`);
  } catch (error) {
    console.error("[FASE-3] Consolidamento settimanale fallito:", error);
  }
}

type WeeklyEpisode = {
  jobId: string;
  outcome: "done" | "failed";
  createdAt: number;
  durationMs: number;
  failedStep: string | null;
  skillUsed: string | null;
};
type WeeklyLesson = { id: string; trigger: string; rule: string; createdAt: number };
type WeeklyStatistics = { total: number; failed: number; fragileStep: string | null; averageDurationMs: number };

function toWeeklyEpisode(document: RawRecord): WeeklyEpisode | null {
  const fields = asRecord(document.fields);
  const outcome = asString(fromFirestoreValue(fields.outcome));
  const createdAt = Date.parse(asString(fromFirestoreValue(fields.createdAt)) ?? "");
  if ((outcome !== "done" && outcome !== "failed") || !Number.isFinite(createdAt)) return null;
  const steps = fromFirestoreValue(fields.steps);
  const durationMs = Array.isArray(steps) ? steps.filter(isRecord).reduce((sum, step) => sum + (asNumber(step.durationMs) ?? 0), 0) : 0;
  return {
    jobId: asString(fromFirestoreValue(fields.jobId)) ?? firestoreDocumentId(asString(document.name) ?? ""),
    outcome,
    createdAt,
    durationMs,
    failedStep: asString(fromFirestoreValue(fields.failedStep)),
    skillUsed: asString(fromFirestoreValue(fields.skillUsed)),
  };
}

function toWeeklyLesson(document: RawRecord): WeeklyLesson | null {
  const fields = asRecord(document.fields);
  const createdAt = Date.parse(asString(fromFirestoreValue(fields.createdAt)) ?? "");
  const trigger = asString(fromFirestoreValue(fields.trigger));
  const rule = asString(fromFirestoreValue(fields.rule));
  const id = firestoreDocumentId(asString(document.name) ?? "");
  return Number.isFinite(createdAt) && id && trigger && rule ? { id, trigger, rule, createdAt } : null;
}

function summarizeWeeklyEpisodes(episodes: WeeklyEpisode[]): WeeklyStatistics {
  const stepFailures = new Map<string, number>();
  for (const episode of episodes) if (episode.failedStep) stepFailures.set(episode.failedStep, (stepFailures.get(episode.failedStep) ?? 0) + 1);
  const fragileStep = [...stepFailures.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  return {
    total: episodes.length,
    failed: episodes.filter((episode) => episode.outcome === "failed").length,
    fragileStep,
    averageDurationMs: episodes.length ? Math.round(episodes.reduce((sum, episode) => sum + episode.durationMs, 0) / episodes.length) : 0,
  };
}

function selectWeeklyEpisodeContext(episodes: WeeklyEpisode[], averageDurationMs: number): WeeklyEpisode[] {
  const exceptional = episodes.filter((episode) => episode.outcome === "failed" || Boolean(episode.skillUsed)
    || (averageDurationMs > 0 && episode.durationMs > averageDurationMs * 2));
  return exceptional.sort((left, right) => right.durationMs - left.durationMs).slice(0, 10);
}

async function askClaudeForWeeklyLearningConsolidation(
  env: Env,
  statistics: WeeklyStatistics,
  skills: LearningSkill[],
  lessons: WeeklyLesson[],
  episodes: WeeklyEpisode[],
): Promise<{ summary: string; proposals: WeeklyLearningProposal }> {
  const prompt = `Consolida la memoria di un agente. In base a statistiche, skills, lessons e casi eccezionali: proponi solo merge di lessons chiaramente duplicate/sovrapposte e quarantene di skill con uso alto ma pochi giudizi utili. Non applicare modifiche. Produci 3-5 righe di stato apprendimento. Rispondi SOLO JSON valido:
{"summary":"...","merges":[{"lessonIds":["id"],"trigger":"...","rule":"..."}],"quarantines":[{"skillId":"...","reason":"..."}]}

Statistiche: ${JSON.stringify(statistics)}
Skills: ${JSON.stringify(skills.map((skill) => ({ id: skill.id, title: skill.title, usageCount: skill.usageCount, helpfulCount: skill.helpfulCount, harmfulCount: skill.harmfulCount })))}
Lessons della settimana: ${JSON.stringify(lessons)}
Casi da esaminare: ${JSON.stringify(episodes)}`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: "user", content: prompt }] }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude weekly consolidation ${response.status}: ${raw}`);
  const data = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }> };
  const text = (data.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  const parsed = parseJsonRecord(text);
  if (!parsed) throw new Error("Consolidamento Claude non in JSON valido");
  const merges = Array.isArray(parsed.merges) ? parsed.merges.filter(isRecord).map((merge) => ({
    lessonIds: Array.isArray(merge.lessonIds) ? merge.lessonIds.filter((id): id is string => typeof id === "string") : [],
    trigger: asString(merge.trigger) ?? "",
    rule: asString(merge.rule) ?? "",
  })).filter((merge) => merge.lessonIds.length >= 2 && merge.trigger && merge.rule) : [];
  const quarantines = Array.isArray(parsed.quarantines) ? parsed.quarantines.filter(isRecord).map((quarantine) => ({
    skillId: asString(quarantine.skillId) ?? "",
    reason: asString(quarantine.reason) ?? "",
  })).filter((quarantine) => quarantine.skillId && quarantine.reason) : [];
  return {
    summary: limitTextWords(asString(parsed.summary) ?? "Nessun dato di apprendimento disponibile questa settimana.", 120),
    proposals: { merges, quarantines },
  };
}

async function listLearningSkills(env: Env, usage?: DeepDiveUsage): Promise<LearningSkill[]> {
  const documents = await listFirestoreCollection(env, "skills", usage);
  return documents.map((document) => {
    const fields = asRecord(document.fields);
    return {
      id: firestoreDocumentId(asString(document.name) ?? ""),
      title: asString(fromFirestoreValue(fields.title)) ?? "skill senza titolo",
      content: asString(fromFirestoreValue(fields.content)) ?? "",
      embedding: asNumberArray(fromFirestoreValue(fields.embedding)),
      helpfulCount: asNumber(fromFirestoreValue(fields.helpfulCount)) ?? 0,
      harmfulCount: asNumber(fromFirestoreValue(fields.harmfulCount)) ?? 0,
      usageCount: asNumber(fromFirestoreValue(fields.usageCount)) ?? 0,
    };
  }).filter((skill) => Boolean(skill.id) && Boolean(skill.content) && skill.embedding.length === GEMINI_EMBEDDING_DIMENSIONS);
}

async function listLearningLessons(env: Env, usage?: DeepDiveUsage): Promise<LearningLesson[]> {
  const documents = await listFirestoreCollection(env, "lessons", usage);
  return documents.map((document) => {
    const fields = asRecord(document.fields);
    return {
      id: firestoreDocumentId(asString(document.name) ?? ""),
      trigger: asString(fromFirestoreValue(fields.trigger)) ?? "",
      rule: asString(fromFirestoreValue(fields.rule)) ?? "",
      embedding: asNumberArray(fromFirestoreValue(fields.embedding)),
    };
  }).filter((lesson) => Boolean(lesson.id) && Boolean(lesson.trigger) && Boolean(lesson.rule)
    && lesson.embedding.length === GEMINI_EMBEDDING_DIMENSIONS);
}

async function listFirestoreCollection(env: Env, collectionId: string, usage?: DeepDiveUsage): Promise<RawRecord[]> {
  if (usage) usage.firestoreReads += 1;
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit: 200 } }),
    },
  );
  if (!response.ok) throw new Error(`Firestore ${collectionId} query ${response.status}: ${await response.text()}`);
  const rows: unknown = await response.json();
  return Array.isArray(rows) ? rows.map((row) => asRecord(asRecord(row).document)).filter((document) => Object.keys(document).length) : [];
}

async function incrementSkillUsage(env: Env, skill: LearningSkill, usage?: DeepDiveUsage): Promise<void> {
  if (usage) usage.firestoreWrites += 1;
  const token = await getFirestoreAccessToken(env);
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/skills/${skill.id}`);
  url.searchParams.append("updateMask.fieldPaths", "usageCount");
  url.searchParams.append("updateMask.fieldPaths", "lastUsedAt");
  const response = await fetch(url, {
    method: "PATCH",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ fields: {
      usageCount: { integerValue: String(skill.usageCount + 1) },
      lastUsedAt: { timestampValue: new Date().toISOString() },
    } }),
  });
  if (!response.ok) throw new Error(`Firestore skill usage ${response.status}: ${await response.text()}`);
}

function firestoreDocumentId(name: string): string {
  return name.split("/").pop() ?? "";
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}

function normalizeEmbedding(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) throw new Error("Embedding nullo");
  return values.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) return -1;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

async function resolveDeepDiveTarget(
  env: Env,
  target: string,
  learningContext: DeepDiveLearningContext,
  usage: DeepDiveUsage,
): Promise<DeepDiveStepResult> {
  const cleaned = target.trim();
  const completedAt = new Date().toISOString();
  const withoutAt = cleaned.replace(/^@/, "");
  const looksLikeWebsite = /^https?:\/\//i.test(cleaned)
    || /^@?www\./i.test(cleaned)
    || (!cleaned.startsWith("@") && /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(cleaned));

  if (!looksLikeWebsite && cleaned.startsWith("@")) {
    const igHandle = cleaned.slice(1).replace(/[^a-z0-9._]/gi, "");
    if (!igHandle) throw new Error("handle Instagram non valido");
    const identity = await identifyInstagramTarget(env, igHandle, learningContext, usage);
    return {
      ok: true,
      step: "resolve",
      completedAt,
      igHandle,
      displayName: identity.displayName,
      ...(identity.websiteUrl ? { websiteUrl: identity.websiteUrl } : {}),
    };
  }

  if (!looksLikeWebsite) return resolveNamedDeepDiveTarget(env, cleaned, completedAt, learningContext, usage);

  try {
    const websiteInput = withoutAt.match(/^https?:\/\//i) ? withoutAt : `https://${withoutAt}`;
    const websiteUrl = new URL(websiteInput).toString();
    const fallbackName = new URL(websiteUrl).hostname.replace(/^www\./i, "");
    const identity = await identifyWebsiteTarget(env, websiteUrl, fallbackName, learningContext, usage);
    return {
      ok: true,
      step: "resolve",
      completedAt,
      websiteUrl,
      displayName: identity.displayName,
      ...(identity.igHandle ? { igHandle: identity.igHandle } : {}),
    };
  } catch {
    throw new Error("per ora usa un @handle Instagram oppure un URL completo");
  }
}

async function resolveNamedDeepDiveTarget(
  env: Env,
  target: string,
  completedAt: string,
  learningContext: DeepDiveLearningContext,
  usage: DeepDiveUsage,
): Promise<DeepDiveStepResult> {
  const raw = await askClaudeWithWebSearch(
    env,
    `Cerca sul web "${target}" fotografo instagram sito. Rispondi SOLO con JSON valido: {"displayName":"nome pubblico esatto oppure null","igHandle":"handle Instagram senza @ oppure null","websiteUrl":"URL del sito ufficiale oppure null"}. Accetta solo elementi chiaramente associati alla stessa attivita e non inventare dati.\n\n${formatDeepDiveLearningContext(learningContext)}`,
    usage,
    1,
    450,
  );
  const identity = parseJsonRecord(raw);
  const displayName = asString(identity?.displayName);
  const rawHandle = asString(identity?.igHandle);
  const igHandle = rawHandle ? rawHandle.replace(/^@/, "").replace(/[^a-z0-9._]/gi, "") || null : null;
  const websiteUrl = normalizeWebsiteUrl(asString(identity?.websiteUrl));
  if (!displayName || (!igHandle && !websiteUrl)) {
    throw new Error("non ho trovato un profilo Instagram o un sito attendibile per questo nome");
  }
  return {
    ok: true,
    step: "resolve",
    completedAt,
    displayName,
    ...(igHandle ? { igHandle } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
  };
}

async function identifyInstagramTarget(
  env: Env,
  igHandle: string,
  learningContext: DeepDiveLearningContext,
  usage: DeepDiveUsage,
): Promise<{ displayName: string; websiteUrl: string | null }> {
  try {
    const raw = await askClaudeWithWebSearch(
      env,
      `Cerca sul web il fotografo o brand associato al profilo Instagram @${igHandle}. Rispondi SOLO con JSON valido: {"displayName":"nome pubblico esatto","websiteUrl":"URL del sito ufficiale oppure null"}. Considera ufficiale solo un sito chiaramente associato allo stesso brand. Non inventare dati.\n\n${formatDeepDiveLearningContext(learningContext)}`,
      usage,
      1,
      450,
    );
    const identity = parseJsonRecord(raw);
    const displayName = asString(identity?.displayName) ?? igHandle;
    const websiteUrl = normalizeWebsiteUrl(asString(identity?.websiteUrl));
    return { displayName, websiteUrl };
  } catch (error) {
    console.error("[FASE-2] Risoluzione Instagram fallita:", error);
    return { displayName: igHandle, websiteUrl: null };
  }
}

function normalizeWebsiteUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(candidate);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

async function identifyWebsiteTarget(
  env: Env,
  websiteUrl: string,
  fallbackName: string,
  learningContext: DeepDiveLearningContext,
  usage: DeepDiveUsage,
): Promise<{ displayName: string; igHandle: string | null }> {
  try {
    const raw = await askClaudeWithWebSearch(
      env,
      `Cerca sul web il brand o fotografo associato a questo sito: ${websiteUrl}. Rispondi SOLO con JSON valido: {"displayName":"nome pubblico esatto","igHandle":"handle Instagram senza @ oppure null"}. Non inventare dati: se un campo non emerge, usa null.\n\n${formatDeepDiveLearningContext(learningContext)}`,
      usage,
      1,
      450,
    );
    const identity = parseJsonRecord(raw);
    const displayName = asString(identity?.displayName) ?? fallbackName;
    const rawHandle = asString(identity?.igHandle);
    const igHandle = rawHandle ? rawHandle.replace(/^@/, "").replace(/[^a-z0-9._]/gi, "") || null : null;
    return { displayName, igHandle };
  } catch (error) {
    console.error("[FASE-2] Risoluzione sito fallita:", error);
    return { displayName: fallbackName, igHandle: null };
  }
}

async function runInstagramDeepDive(env: Env, job: DeepDiveJob): Promise<DeepDiveStepResult> {
  const igHandle = job.results.resolve ? asString(job.results.resolve.igHandle) : null;
  const completedAt = new Date().toISOString();

  if (!igHandle) {
    return { ok: true, step: "instagram", completedAt, skipped: true, note: "Nessun handle Instagram disponibile." };
  }
  if (!env.APIFY_TOKEN) throw new Error("secret APIFY_TOKEN mancante su saverio-bot");

  const rawPosts = await fetchInstagramPostsForDeepDive(env, igHandle, job.usage);
  const posts = rawPosts.slice(0, DEEP_DIVE_POST_LIMIT).map(toDeepDiveInstagramPost);
  const profile = extractInstagramProfile(rawPosts[0]);
  const metrics = calculateInstagramMetrics(posts, profile.followers);

  return {
    ok: true,
    step: "instagram",
    completedAt,
    igHandle,
    profile,
    metrics,
    posts,
  };
}

async function fetchInstagramPostsForDeepDive(env: Env, username: string, usage: DeepDiveUsage): Promise<RawRecord[]> {
  usage.apifyRuns += 1;
  usage.apifyHttpRequests += 1;
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_INSTAGRAM_POST_ACTOR}/runs?token=${env.APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: [username], resultsLimit: DEEP_DIVE_POST_LIMIT }),
    },
  );
  if (!runRes.ok) throw new Error(`Apify run error: ${runRes.status}`);

  const runId = asString(asRecord(asRecord(await runRes.json()).data).id);
  if (!runId) throw new Error("Apify run senza id");

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    usage.apifyHttpRequests += 1;
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${env.APIFY_TOKEN}`);
    if (!statusRes.ok) throw new Error(`Apify status error: ${statusRes.status}`);
    const status = asString(asRecord(asRecord(await statusRes.json()).data).status);
    if (status === "SUCCEEDED") break;
    if (status && ["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) throw new Error(`Apify run ${status}`);
    if (attempt === 11) throw new Error("Apify run timeout");
  }

  usage.apifyHttpRequests += 1;
  const dataRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${env.APIFY_TOKEN}`);
  if (!dataRes.ok) throw new Error(`Apify dataset error: ${dataRes.status}`);
  const data: unknown = await dataRes.json();
  if (!Array.isArray(data)) throw new Error("Apify dataset non valido");
  return data.filter(isRecord);
}

type DeepDiveInstagramPost = {
  type: "reel" | "carousel" | "foto" | "altro";
  caption: string;
  likes: number | null;
  comments: number | null;
  date: string | null;
  url: string | null;
};

function toDeepDiveInstagramPost(post: RawRecord): DeepDiveInstagramPost {
  const rawType = asString(post.type)?.toLowerCase() ?? "";
  const type = rawType.includes("video") || rawType.includes("reel")
    ? "reel"
    : rawType.includes("sidecar") || rawType.includes("carousel")
      ? "carousel"
      : rawType.includes("image") || rawType.includes("photo") ? "foto" : "altro";
  const timestamp = firstString(post, ["timestamp", "takenAt", "date"]);
  const parsedDate = timestamp && !Number.isNaN(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
  return {
    type,
    caption: (asString(post.caption) ?? "").replace(/\s+/g, " ").slice(0, 200),
    likes: firstNumber(post, ["likesCount", "likes"]),
    comments: firstNumber(post, ["commentsCount", "comments"]),
    date: parsedDate,
    url: firstString(post, ["url", "postUrl"]),
  };
}

function extractInstagramProfile(post: RawRecord | undefined): { bio: string | null; followers: number | null; postCount: number | null } {
  if (!post) return { bio: null, followers: null, postCount: null };
  const owner = asRecord(post.owner);
  return {
    bio: firstString(post, ["ownerBio", "biography", "bio"]) ?? firstString(owner, ["biography", "bio"]),
    followers: firstNumber(post, ["ownerFollowersCount", "followersCount", "followers"]) ?? firstNumber(owner, ["followersCount", "followers"]),
    postCount: firstNumber(post, ["ownerPostsCount", "postsCount"]) ?? firstNumber(owner, ["postsCount"]),
  };
}

function calculateInstagramMetrics(posts: DeepDiveInstagramPost[], followers: number | null): {
  postsAnalyzed: number;
  postsPerWeek: number | null;
  averageEngagementRate: number | null;
  formatMix: Record<DeepDiveInstagramPost["type"], number>;
} {
  const datedPosts = posts.filter((post) => post.date).map((post) => Date.parse(post.date!));
  const oldest = datedPosts.length ? Math.min(...datedPosts) : null;
  const newest = datedPosts.length ? Math.max(...datedPosts) : null;
  const weeks = oldest && newest ? Math.max(1, (newest - oldest) / (7 * 24 * 60 * 60 * 1000)) : null;
  const interactions = posts
    .filter((post) => post.likes !== null || post.comments !== null)
    .map((post) => (post.likes ?? 0) + (post.comments ?? 0));
  const averageEngagementRate = followers && interactions.length
    ? Math.round((interactions.reduce((sum, value) => sum + value, 0) / interactions.length / followers) * 10_000) / 100
    : null;
  const count = (type: DeepDiveInstagramPost["type"]) => posts.filter((post) => post.type === type).length;
  const toPercent = (type: DeepDiveInstagramPost["type"]) => posts.length ? Math.round((count(type) / posts.length) * 100) : 0;

  return {
    postsAnalyzed: posts.length,
    postsPerWeek: weeks ? Math.round((posts.length / weeks) * 10) / 10 : null,
    averageEngagementRate,
    formatMix: { reel: toPercent("reel"), carousel: toPercent("carousel"), foto: toPercent("foto"), altro: toPercent("altro") },
  };
}

function firstString(record: RawRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) return value;
  }
  return null;
}

function firstNumber(record: RawRecord, keys: string[]): number | null {
  for (const key of keys) {
    const direct = asNumber(record[key]);
    if (direct !== null) return direct;
    const stringValue = asString(record[key]);
    if (stringValue && Number.isFinite(Number(stringValue))) return Number(stringValue);
  }
  return null;
}

type WebsitePage = { url: string; title: string | null; textContent: string };

async function runWebsiteDeepDive(job: DeepDiveJob): Promise<DeepDiveStepResult> {
  const websiteUrl = job.results.resolve ? asString(job.results.resolve.websiteUrl) : null;
  const completedAt = new Date().toISOString();
  if (!websiteUrl) {
    return { ok: true, step: "website", completedAt, skipped: true, note: "Nessun URL sito disponibile." };
  }

  const home = await fetchWebsitePage(websiteUrl, job.usage);
  if (!home) {
    return {
      ok: true,
      step: "website",
      completedAt,
      skipped: true,
      note: "Il sito ha bloccato o non ha risposto alla lettura automatica.",
    };
  }

  const links = extractRelevantWebsiteLinks(home.html, home.url);
  let remainingTextBudget = DEEP_DIVE_WEBSITE_TOTAL_TEXT_LIMIT;
  const toWebsitePage = (page: { url: string; html: string }): WebsitePage => {
    const textContent = htmlToText(page.html).slice(0, Math.max(0, Math.min(DEEP_DIVE_WEBSITE_PAGE_TEXT_LIMIT, remainingTextBudget)));
    remainingTextBudget -= textContent.length;
    return { url: page.url, title: extractHtmlTitle(page.html), textContent };
  };
  const pages: WebsitePage[] = [toWebsitePage(home)];
  for (const link of links.slice(0, 5)) {
    const page = await fetchWebsitePage(link, job.usage);
    if (!page) continue;
    pages.push(toWebsitePage(page));
  }

  return { ok: true, step: "website", completedAt, websiteUrl, pages };
}

async function fetchWebsitePage(url: string, usage?: DeepDiveUsage): Promise<{ url: string; html: string } | null> {
  if (usage) usage.websiteFetches += 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "it-IT,it;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")
      || (Number.isFinite(contentLength) && contentLength > 750_000)) return null;
    const html = await response.text();
    return html ? { url: response.url, html } : null;
  } catch (error) {
    console.error("[FASE-2] Lettura sito fallita:", url, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function extractRelevantWebsiteLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const relevant = /servizi|prezzi|pacchetti|matrimoni|wedding|portfolio|about|chi-sono|contatti|listino/i;
  const links = new Set<string>();
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = anchorPattern.exec(html))) {
    const href = match[1];
    const anchorText = htmlToText(match[2]);
    let candidate: URL;
    try {
      candidate = new URL(href, base);
    } catch {
      continue;
    }
    if (candidate.origin !== base.origin || !/^https?:$/.test(candidate.protocol)) continue;
    if (!relevant.test(`${candidate.pathname} ${anchorText}`)) continue;
    candidate.hash = "";
    candidate.search = "";
    if (candidate.toString() !== base.toString()) links.add(candidate.toString());
  }
  return [...links];
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? htmlToText(match[1]).slice(0, 200) : null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

// ===== Fase 6: link inbox =====

type SavedRead = { id: string; title: string; url: string; summary: string; embedding: number[] };
type ReadCrossReference = { kind: "skill" | "read"; title: string; score: number };

function extractSharedLink(text: string): string | null {
  const raw = text.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;!?]+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const privateHost = host === "localhost" || host.endsWith(".localhost") || host === "::1"
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^0\./.test(host);
    if (!/^https?:$/.test(url.protocol) || privateHost) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function gestisciLinkInbox(env: Env, text: string): Promise<string | null> {
  const url = extractSharedLink(text);
  if (!url) return null;

  let stage: "lettura" | "sintesi" | "embedding" | "collegamenti" | "salvataggio" = "lettura";
  try {
    const page = await fetchReadableLink(url);
    const resolvedUrl = page?.url ?? url;
    stage = "sintesi";
    const read = page && page.textContent.length >= 100
      ? await summarizeRead(env, page.url, page.title || new URL(page.url).hostname, page.textContent)
      : await summarizeReadFromWeb(env, url);
    stage = "embedding";
    const embedding = await createGeminiEmbedding(env, `${read.title}\n${read.summary}`, "RETRIEVAL_DOCUMENT");
    stage = "collegamenti";
    const [skills, savedReads] = await Promise.all([listLearningSkills(env), listSavedReads(env)]);
    const related = findReadCrossReferences(embedding, skills, savedReads);

    stage = "salvataggio";
    await createFirestoreDocument(env, "reads", {
      url: resolvedUrl,
      title: read.title,
      summary: read.summary,
      keywords: read.keywords,
      embedding,
      createdAt: new Date().toISOString(),
    });

    const connections = related.length
      ? `\n\nSembra collegato a: ${related.map((item) => `[${item.kind === "skill" ? "skill" : "lettura"}: ${item.title}]`).join(", ")}.`
      : "";
    return `Salvato: ${read.title}\n\n${read.summary}${connections}`;
  } catch (error) {
    console.error(`[FASE-6] Link inbox fallito in ${stage}:`, error);
    const labels = {
      lettura: "lettura della pagina",
      sintesi: "creazione del riassunto",
      embedding: "creazione dell'embedding Gemini",
      collegamenti: "ricerca dei collegamenti in Firestore",
      salvataggio: "salvataggio nella collection reads",
    } as const;
    return `Non sono riuscito a salvare questo link: errore durante ${labels[stage]}.`;
  }
}

async function fetchReadableLink(url: string): Promise<{ url: string; title: string | null; textContent: string } | null> {
  const direct = await fetchWebsitePage(url);
  if (direct) {
    return {
      url: direct.url,
      title: extractHtmlTitle(direct.html),
      textContent: htmlToText(direct.html),
    };
  }

  // Alcuni siti pubblici bloccano i fetch dei Worker: il reader restituisce solo testo/Markdown.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, {
      headers: { accept: "text/plain", "x-return-format": "markdown" },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[FASE-6] Reader HTTP ${response.status} per ${url}`);
      return null;
    }
    const markdown = (await response.text()).replace(/\s+/g, " ").trim();
    if (!markdown) return null;
    const readerTitle = markdown.match(/^Title:\s*(.+?)(?:\s+URL:|$)/i)?.[1]?.trim() ?? null;
    return { url, title: readerTitle, textContent: markdown.slice(0, 8000) };
  } catch (error) {
    console.error("[FASE-6] Fallback reader fallito:", url, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeReadFromWeb(
  env: Env,
  url: string,
): Promise<{ title: string; summary: string; keywords: string[] }> {
  const raw = await askClaudeWithWebSearch(
    env,
    `Consulta questa pagina pubblica: ${url}\nProduci una scheda fedele al contenuto della pagina, non una descrizione generica del sito. Riassunto in italiano massimo 200 parole e 3-5 keyword specifiche. Se la pagina non è realmente accessibile, restituisci summary vuoto. Rispondi SOLO JSON valido:\n{"title":"titolo breve","summary":"riassunto max 200 parole","keywords":["keyword"]}`,
  );
  return parseReadSummary(raw, new URL(url).hostname);
}

async function summarizeRead(
  env: Env,
  url: string,
  title: string,
  content: string,
): Promise<{ title: string; summary: string; keywords: string[] }> {
  const prompt = `Sei l'archivista di Saverio. Riassumi questa pagina in italiano in massimo 200 parole. Estrai 3-5 keyword specifiche. Non inventare informazioni e non dare istruzioni operative. Rispondi SOLO JSON valido:
{"title":"titolo breve","summary":"riassunto max 200 parole","keywords":["keyword"]}

URL: ${url}
Titolo pagina: ${title}
Testo estratto:\n${content.slice(0, 8000)}`;
  const raw = await askClaudeJSON(env, prompt, "Crea la scheda di lettura.");
  return parseReadSummary(raw, title);
}

function parseReadSummary(
  raw: string,
  fallbackTitle: string,
): { title: string; summary: string; keywords: string[] } {
  const parsed = parseJsonRecord(raw);
  const summary = limitWords(asString(parsed?.summary) ?? "", 200);
  const keywords = Array.isArray(parsed?.keywords)
    ? parsed!.keywords.filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 1).map((keyword) => keyword.trim()).slice(0, 5)
    : [];
  if (!summary) throw new Error("Claude non ha prodotto un riassunto del link");
  return {
    title: (asString(parsed?.title) ?? fallbackTitle).replace(/\s+/g, " ").trim().slice(0, 200),
    summary,
    keywords: keywords.length >= 3 ? keywords : ["lettura", "link", "da classificare"],
  };
}

function limitWords(text: string, limit: number): string {
  return text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean).slice(0, limit).join(" ");
}

async function listSavedReads(env: Env): Promise<SavedRead[]> {
  const documents = await listFirestoreCollection(env, "reads");
  return documents.map((document) => {
    const fields = asRecord(document.fields);
    return {
      id: firestoreDocumentId(asString(document.name) ?? ""),
      title: asString(fromFirestoreValue(fields.title)) ?? "lettura senza titolo",
      url: asString(fromFirestoreValue(fields.url)) ?? "",
      summary: asString(fromFirestoreValue(fields.summary)) ?? "",
      embedding: asNumberArray(fromFirestoreValue(fields.embedding)),
    };
  }).filter((read) => Boolean(read.id) && Boolean(read.url) && Boolean(read.summary)
    && read.embedding.length === GEMINI_EMBEDDING_DIMENSIONS);
}

async function loadRelevantReads(env: Env, text: string): Promise<SavedRead[]> {
  if (!env.GEMINI_API_KEY) return [];
  try {
    const reads = await listSavedReads(env);
    if (!reads.length) return [];
    const embedding = await createGeminiEmbedding(env, text, "RETRIEVAL_QUERY");
    return reads
      .map((read) => ({ read, score: cosineSimilarity(embedding, read.embedding) }))
      .filter(({ score }) => score > 0.80)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(({ read }) => read);
  } catch (error) {
    console.error("[FASE-6] Retrieval link fallito:", error);
    return [];
  }
}

function isReadsSearchIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  return /cosa (?:abbiamo|hai|ho) salvat/.test(value)
    || /(?:cerca|trova).*(?:letture|link salvat|archivio)/.test(value)
    || /(?:letture|link salvat).*(?:su|riguardo|parlano)/.test(value);
}

async function gestisciReadsSearch(env: Env, text: string): Promise<string | null> {
  if (!isReadsSearchIntent(text)) return null;
  try {
    const reads = await listSavedReads(env);
    if (!reads.length) return "Non ci sono ancora link salvati nella Link inbox.";

    const queryWords = keywordSet(text);
    let queryEmbedding: number[] | null = null;
    if (env.GEMINI_API_KEY) {
      try {
        queryEmbedding = await createGeminiEmbedding(env, text, "RETRIEVAL_QUERY");
      } catch (error) {
        console.error("[FASE-6] Embedding ricerca letture fallito:", error);
      }
    }

    const matches = reads.map((read) => {
      const readWords = keywordSet(`${read.title} ${read.summary}`);
      let lexicalMatches = 0;
      for (const word of queryWords) if (readWords.has(word)) lexicalMatches += 1;
      const semanticScore = queryEmbedding ? cosineSimilarity(queryEmbedding, read.embedding) : -1;
      return { read, lexicalMatches, semanticScore, rank: semanticScore + Math.min(0.3, lexicalMatches * 0.1) };
    }).filter(({ lexicalMatches, semanticScore }) => lexicalMatches > 0 || semanticScore > 0.70)
      .sort((left, right) => right.rank - left.rank)
      .slice(0, 3);

    if (!matches.length) return "Non ho trovato letture salvate pertinenti a questa ricerca.";
    return matches.map(({ read }, index) => [
      `${index + 1}. ${read.title}`,
      read.summary,
      read.url,
    ].join("\n")).join("\n\n");
  } catch (error) {
    console.error("[FASE-6] Ricerca letture fallita:", error);
    return "Non riesco a consultare le letture salvate in questo momento.";
  }
}

function findReadCrossReferences(
  embedding: number[],
  skills: LearningSkill[],
  reads: SavedRead[],
): ReadCrossReference[] {
  const candidates: ReadCrossReference[] = [
    ...skills.map((skill) => ({ kind: "skill" as const, title: skill.title, score: cosineSimilarity(embedding, skill.embedding) })),
    ...reads.map((read) => ({ kind: "read" as const, title: read.title, score: cosineSimilarity(embedding, read.embedding) })),
  ];
  return candidates.filter((candidate) => candidate.score > 0.80)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);
}

async function runWebMentionsDeepDive(env: Env, job: DeepDiveJob): Promise<DeepDiveStepResult> {
  const displayName = job.results.resolve ? asString(job.results.resolve.displayName) : null;
  if (!displayName) throw new Error("nome concorrente non disponibile per la ricerca web");

  const queries = [
    `"${displayName}" fotografo recensioni`,
    `"${displayName}" matrimonio.com OR zankyou`,
    `"${displayName}" premio OR award fotografo`,
  ];
  const prompt = `Cerca sul web queste tre query, una alla volta:\n${queries.map((query) => `- ${query}`).join("\n")}\n\nRispondi SOLO con JSON valido nel formato {"mentions":[{"query":"...","title":"...","snippet":"...","url":"..."}]}. Raccogli al massimo 6 risultati in totale. Usa solo risultati realmente trovati, senza inventare URL o testi.\n\n${formatDeepDiveLearningContext(job.learningContext)}`;
  const raw = await askClaudeWithWebSearch(env, prompt, job.usage, 3, 900);
  const mentions = parseWebMentions(raw);
  return { ok: true, step: "web-mentions", completedAt: new Date().toISOString(), queries, mentions };
}

async function askClaudeWithWebSearch(
  env: Env,
  prompt: string,
  usage?: DeepDiveUsage,
  maxUses = 3,
  maxTokens = 900,
): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }],
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude web search error: ${response.status} ${raw}`);
  const data = JSON.parse(raw) as RawRecord;
  recordClaudeUsage(usage, data);
  return claudeTextContent(data);
}

function parseWebMentions(raw: string): Array<{ query: string; title: string; snippet: string; url: string }> {
  const parsed = parseJsonRecord(raw);
  if (!parsed || !Array.isArray(parsed.mentions)) {
    console.error("[FASE-2] Risposta web mentions non valida:", raw);
    return [];
  }
  return parsed.mentions
      .filter(isRecord)
      .map((mention) => ({
        query: asString(mention.query) ?? "",
        title: asString(mention.title) ?? "",
        snippet: asString(mention.snippet) ?? "",
        url: asString(mention.url) ?? "",
      }))
      .filter((mention) => mention.title && mention.url)
      .slice(0, 6);
}

function parseJsonRecord(raw: string): RawRecord | null {
  const candidates = [
    raw.trim(),
    raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim(),
    raw.match(/\{[\s\S]*\}/)?.[0] ?? "",
  ];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Prova il prossimo formato: Claude può aggiungere testo o un blocco Markdown.
    }
  }
  return null;
}

async function runSynthesizeDeepDive(env: Env, job: DeepDiveJob): Promise<DeepDiveStepResult> {
  const raw = await askClaudeForDeepDiveReport(env, job.results, job.learningContext, job.usage);
  const report = limitDeepDiveReport(formatDeepDiveReportForTelegram(raw));
  if (!report) throw new Error("Claude non ha prodotto il report dell'indagine");
  return {
    ok: true,
    step: "synthesize",
    completedAt: new Date().toISOString(),
    displayName: asString(job.results.resolve?.displayName) ?? job.target,
    report,
    wordCount: report.split(/\s+/).filter(Boolean).length,
  };
}

async function askClaudeForDeepDiveReport(
  env: Env,
  results: Partial<Record<DeepDiveStep, DeepDiveStepResult>>,
  learningContext: DeepDiveLearningContext,
  usage: DeepDiveUsage,
): Promise<string> {
  const system = `Sei un analista competitivo per un fotografo di matrimoni di Foggia (Mariano Russo Photo). Analizza il materiale raccolto su un fotografo concorrente e produci un report in italiano con queste sezioni:

1. PROFILO — chi è, da quanto, zona operativa
2. POSIZIONAMENTO — a che tipo di clientela punta, tono, estetica
3. NUMERI SOCIAL — follower, engagement rate, frequenza, formati che spinge (dai dati Instagram forniti; cita i numeri)
4. OFFERTA E PREZZI — servizi e fascia prezzo (dai testi del sito; se i prezzi non sono pubblici, stimali dalla fascia di posizionamento e dichiaralo come stima)
5. PUNTI DI FORZA — cosa fa bene, con esempi concreti dal materiale
6. DEBOLEZZE VISIBILI — cosa manca o zoppica (SEO, formati, nicchie scoperte, incoerenze)
7. AZIONI PER MARIANO — 3 mosse concrete e specifiche, non generiche

Basati SOLO sul materiale fornito. Se un dato manca, dillo, non inventare. Per ogni affermazione fattuale presa da una menzione web, indica la fonte tra parentesi usando il dominio o l'URL presente nel materiale; non citare fonti non fornite.

Controlla i calcoli: non tradurre un valore di post/settimana in una cadenza giornaliera senza fare la conversione corretta (0,1 post/settimana significa circa 1 post ogni 10 settimane, non ogni 10 giorni). Se follower o engagement rate non sono disponibili, non descrivere l'engagement come alto, basso o scarso: dillo non valutabile e limita le osservazioni ai like/view assoluti.

FORMATO TELEGRAM: testo semplice, senza Markdown. Non usare #, **, trattini --- o tabelle. Metti ogni intestazione su una riga propria, nel formato "1. PROFILO", e separa le sezioni con una riga vuota. Massimo 600 parole.`;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: `${system}\n\n${formatDeepDiveLearningContext(learningContext)}`,
      messages: [{ role: "user", content: `Materiale raccolto:\n${JSON.stringify(compactDeepDiveResults(results))}` }],
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude synthesize error: ${response.status} ${raw}`);
  const data = JSON.parse(raw) as RawRecord;
  recordClaudeUsage(usage, data);
  return claudeTextContent(data);
}

function compactDeepDiveResults(results: Partial<Record<DeepDiveStep, DeepDiveStepResult>>): RawRecord {
  const website = asRecord(results.website);
  const pages = Array.isArray(website.pages) ? website.pages.filter(isRecord).map((page) => ({
    url: asString(page.url),
    title: asString(page.title),
    textContent: (asString(page.textContent) ?? "").slice(0, DEEP_DIVE_WEBSITE_PAGE_TEXT_LIMIT),
  })) : [];
  const instagram = asRecord(results.instagram);
  const posts = Array.isArray(instagram.posts) ? instagram.posts.filter(isRecord).map((post) => ({
    type: asString(post.type),
    caption: (asString(post.caption) ?? "").slice(0, 200),
    likes: asNumber(post.likes),
    comments: asNumber(post.comments),
    date: asString(post.date),
    url: asString(post.url),
  })) : [];
  return {
    resolve: toJsonValue(results.resolve ?? null),
    instagram: {
      skipped: instagram.skipped === true,
      note: asString(instagram.note),
      profile: toJsonValue(asRecord(instagram.profile)),
      metrics: toJsonValue(asRecord(instagram.metrics)),
      posts: toJsonValue(posts),
    },
    website: {
      skipped: website.skipped === true,
      note: asString(website.note),
      websiteUrl: asString(website.websiteUrl),
      pages: toJsonValue(pages),
    },
    webMentions: toJsonValue(results["web-mentions"] ?? null),
  };
}

function limitDeepDiveReport(report: string): string {
  return limitTextWords(report, 600);
}

function limitTextWords(text: string, maxWords: number): string {
  const words = [...text.matchAll(/\S+/g)];
  if (words.length <= maxWords) return text.trim();
  return text.slice(0, words[maxWords].index).trim();
}

function formatDeepDiveReportForTelegram(report: string): string {
  return report
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function saveDeepDiveJob(env: Env, key: string, job: DeepDiveJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await env.SAVERIO_KV.put(key, JSON.stringify(job), { expirationTtl: DEEP_DIVE_JOB_TTL });
}

function formatDeepDiveCompletion(job: DeepDiveJob): string {
  const report = asString(job.results.synthesize?.report);
  if (report) return `🔍 Indagine su «${job.target}» completata.\n\n${report}`;

  const lines = [`Indagine su «${job.target}» completata.`];
  const instagram = job.results.instagram;

  if (instagram && instagram.skipped === true) {
    lines.push("\nInstagram: nessun handle disponibile, quindi questo passaggio è stato saltato.");
  } else if (instagram) {
    const profile = asRecord(instagram.profile);
    const metrics = asRecord(instagram.metrics);
    const followers = asNumber(profile.followers);
    const postsPerWeek = asNumber(metrics.postsPerWeek);
    const engagement = asNumber(metrics.averageEngagementRate);
    const mix = asRecord(metrics.formatMix);
    const reel = asNumber(mix.reel) ?? 0;
    const carousel = asNumber(mix.carousel) ?? 0;
    const photo = asNumber(mix.foto) ?? 0;

    lines.push("\nInstagram");
    lines.push(`- Post analizzati: ${asNumber(metrics.postsAnalyzed) ?? 0}`);
    lines.push(`- Follower: ${followers === null ? "dato non disponibile" : followers.toLocaleString("it-IT")}`);
    lines.push(`- Frequenza: ${postsPerWeek === null ? "dato non disponibile" : `${postsPerWeek} post/settimana`}`);
    lines.push(`- Engagement medio: ${engagement === null ? "dato non disponibile" : `${engagement}%`}`);
    lines.push(`- Formati: ${reel}% reel, ${carousel}% caroselli, ${photo}% foto`);

    const samples = Array.isArray(instagram.posts) ? instagram.posts.filter(isRecord).slice(0, 3) : [];
    if (samples.length) {
      lines.push("\nUltimi contenuti:");
      for (const post of samples) {
        const type = asString(post.type) ?? "contenuto";
        const caption = (asString(post.caption) ?? "senza caption").slice(0, 110);
        lines.push(`- ${type}: ${caption}`);
      }
    }
  }

  const website = job.results.website;
  if (website && website.skipped !== true) {
    const pages = Array.isArray(website.pages) ? website.pages.filter(isRecord) : [];
    lines.push("\nSito");
    lines.push(`- Pagine lette: ${pages.length}`);
    for (const page of pages.slice(0, 3)) {
      const title = asString(page.title) ?? asString(page.url) ?? "pagina senza titolo";
      lines.push(`- ${title.slice(0, 110)}`);
    }
  } else if (website && website.skipped === true) {
    lines.push(`\nSito: ${asString(website.note) ?? "passaggio saltato."}`);
  }

  const webMentions = job.results["web-mentions"];
  if (webMentions) {
    const mentions = Array.isArray(webMentions.mentions) ? webMentions.mentions.filter(isRecord) : [];
    lines.push("\nMenzioni web");
    lines.push(`- Risultati trovati: ${mentions.length}`);
    for (const mention of mentions.slice(0, 3)) {
      const title = asString(mention.title);
      if (title) lines.push(`- ${title.slice(0, 110)}`);
    }
  }

  lines.push("\nL'analisi strategica arriverà nell'ultimo step.");
  return lines.join("\n");
}

async function sendDeepDiveCompletion(env: Env, job: DeepDiveJob): Promise<void> {
  for (const chunk of splitTelegramReport(formatDeepDiveCompletion(job))) {
    await sendMessage(env, job.chatId, chunk);
  }
}

function splitTelegramReport(text: string, maxLength = 4000): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
    const lineBreak = remaining.lastIndexOf("\n", maxLength);
    const wordBreak = remaining.lastIndexOf(" ", maxLength);
    const splitAt = paragraphBreak > 0 ? paragraphBreak
      : lineBreak > 0 ? lineBreak
        : wordBreak > 0 ? wordBreak : maxLength;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function loadHistory(env: Env, chatId: number): Promise<Turn[]> {
  const raw = await env.SAVERIO_KV.get(historyKey(chatId));
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(env: Env, chatId: number, history: Turn[]) {
  // tiene solo gli ultimi MAX_HISTORY turni, col TTL che pulisce da solo
  const trimmed = history.slice(-MAX_HISTORY);
  await env.SAVERIO_KV.put(historyKey(chatId), JSON.stringify(trimmed), {
    expirationTtl: HISTORY_TTL,
  });
}

async function appendHistory(env: Env, chatId: number, turns: Turn[]) {
  const history = await loadHistory(env, chatId);
  history.push(...turns);
  await saveHistory(env, chatId, history);
}

async function loadLongMemories(env: Env, chatId: number): Promise<LongMemory[]> {
  const raw = await env.SAVERIO_KV.get(longMemoryKey(chatId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveLongMemories(env: Env, chatId: number, memories: LongMemory[]) {
  const trimmed = memories
    .filter(m => m?.testo)
    .slice(-MAX_LONG_MEMORIES);
  await env.SAVERIO_KV.put(longMemoryKey(chatId), JSON.stringify(trimmed));
}

async function addLongMemory(
  env: Env,
  chatId: number,
  memory: Omit<LongMemory, "id" | "createdAt">,
) {
  const memories = await loadLongMemories(env, chatId);
  const testo = memory.testo.trim();
  if (!testo) return;

  const duplicate = memories.some(m => normalizeForMatch(m.testo) === normalizeForMatch(testo));
  if (duplicate) return;

  memories.push({
    ...memory,
    testo,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  });
  await saveLongMemories(env, chatId, memories);
}

async function loadRelevantMemories(env: Env, chatId: number, text: string): Promise<LongMemory[]> {
  const memories = await loadLongMemories(env, chatId);
  if (!memories.length) return [];

  const queryWords = keywordSet(text);
  const scored = memories.map((memory, index) => {
    const haystack = keywordSet(`${memory.testo} ${memory.cliente || ""}`);
    let score = 0;
    for (const word of queryWords) if (haystack.has(word)) score += 3;
    if (memory.cliente && normalizeForMatch(text).includes(normalizeForMatch(memory.cliente))) score += 6;
    score += index / 1000; // a parità di pertinenza, preferisci i ricordi più recenti
    return { memory, score };
  });

  const relevant = scored
    .filter(item => item.score >= 3)
    .sort((a, b) => b.score - a.score)
    .map(item => item.memory)
    .slice(0, MAX_RELEVANT_MEMORIES);

  return relevant.length
    ? relevant
    : memories.slice(-Math.min(5, MAX_RELEVANT_MEMORIES));
}

function buildSystemPrompt(memories: LongMemory[]): string {
  if (!memories.length) return SYSTEM_PROMPT;

  const memoryBlock = memories
    .map(m => {
      const date = new Date(m.createdAt).toISOString().slice(0, 10);
      const cliente = m.cliente ? ` [${m.cliente}]` : "";
      return `- ${date}${cliente}: ${m.testo}`;
    })
    .join("\n");

  return `${SYSTEM_PROMPT}

## Memoria stabile
Questi sono ricordi salvati da Mariano o decisioni già confermate. Usali come contesto reale quando sono pertinenti. Non citarli a caso e non inventare dettagli oltre queste note.
${memoryBlock}`;
}

function buildSystemPromptWithReads(memories: LongMemory[], reads: SavedRead[]): string {
  const base = buildSystemPrompt(memories);
  if (!reads.length) return base;
  const readBlock = reads
    .map((read) => `- ${read.title} (${read.url}): ${read.summary}`)
    .join("\n");
  return `${base}

## Letture archiviate pertinenti
Usa queste schede solo se aiutano davvero a rispondere. Sono riassunti di link salvati: non attribuire loro dettagli non presenti e cita il link quando è utile.
${readBlock}`;
}

function formatMemoryList(memories: LongMemory[]): string {
  if (!memories.length) return "Non ho ancora ricordi stabili salvati.";
  return "Memoria stabile:\n" + memories.slice(-30).map(m => {
    const date = new Date(m.createdAt).toISOString().slice(0, 10);
    const cliente = m.cliente ? ` - ${m.cliente}` : "";
    return `• ${date}${cliente}: ${m.testo}`;
  }).join("\n");
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordSet(text: string): Set<string> {
  const stop = new Set(["che", "con", "del", "della", "dello", "dei", "degli", "per", "una", "uno", "gli", "hai", "abbiamo", "fare", "fatto", "sul", "sulla", "sono", "era", "come", "cosa", "questo", "questa"]);
  return new Set(
    normalizeForMatch(text)
      .split(" ")
      .filter(w => w.length > 2 && !stop.has(w)),
  );
}

async function askClaude(
  env: Env,
  history: Turn[],
  memories: LongMemory[],
  reads: SavedRead[] = [],
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: buildSystemPromptWithReads(memories, reads),
      messages: history,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    }),
  });

  const raw = await res.text();

  if (!res.ok) throw new Error(`anthropic ${res.status}: ${raw}`);
  const data = JSON.parse(raw);

  return data.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim() || "(nessuna risposta)";
}
async function createPendingAction(
  env: Env,
  chatId: number,
  action: PendingActionType,
  params: JsonValue,
): Promise<{ id: string; approveData: string; rejectData: string }> {
  const id = crypto.randomUUID();
  const pending: PendingAction = {
    action,
    params,
    chatId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PENDING_ACTION_TTL * 1000).toISOString(),
  };
  await env.SAVERIO_KV.put(pendingActionKey(id), JSON.stringify(pending), { expirationTtl: PENDING_ACTION_TTL });
  return { id, approveData: `pending:approve:${id}`, rejectData: `pending:reject:${id}` };
}

type PendingCallbackResult = { reply: string; action: PendingActionType | null; persistentMessage?: string };

async function handlePendingActionCallback(env: Env, chatId: number, callbackData: string): Promise<PendingCallbackResult> {
  const match = callbackData.match(/^pending:(approve|reject):([0-9a-f-]{36})$/i);
  if (!match) return { reply: "Azione non riconosciuta.", action: null };
  const [, decision, id] = match;
  const raw = await env.SAVERIO_KV.get(pendingActionKey(id));
  if (!raw) return { reply: "Questa proposta è scaduta o è già stata gestita.", action: null };

  let pending: PendingAction;
  try {
    pending = JSON.parse(raw) as PendingAction;
  } catch {
    await env.SAVERIO_KV.delete(pendingActionKey(id));
    return { reply: "Proposta non leggibile.", action: null };
  }
  if (pending.chatId !== chatId || Date.parse(pending.expiresAt) <= Date.now()) {
    await env.SAVERIO_KV.delete(pendingActionKey(id));
    return { reply: "Questa proposta è scaduta.", action: pending.action };
  }
  if (decision === "reject") {
    await env.SAVERIO_KV.delete(pendingActionKey(id));
    return { reply: "Proposta rifiutata.", action: pending.action };
  }

  const reply = await executePendingAction(env, pending);
  await env.SAVERIO_KV.delete(pendingActionKey(id));
  return {
    reply,
    action: pending.action,
    ...(pending.action.startsWith("calendar-") ? { persistentMessage: `✅ ${reply}` } : {}),
  };
}

async function executePendingAction(env: Env, pending: PendingAction): Promise<string> {
  return PENDING_ACTION_HANDLERS[pending.action](env, asRecord(pending.params));
}

type PendingActionHandler = (env: Env, params: RawRecord) => Promise<string>;

// Registro unico: aggiungere una nuova azione approvabile richiede una sola voce qui.
const PENDING_ACTION_HANDLERS: Record<PendingActionType, PendingActionHandler> = {
  "task-open": async (env, params) => {
    const titolo = asString(params.titolo);
    if (!titolo) throw new Error("task email senza titolo");
    const response = await fetch(env.TASK_URL + "/open", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-key": env.AGENT_KEY },
      body: JSON.stringify({ titolo, urgente: params.urgente === true }),
    });
    if (!response.ok) throw new Error(`task/open ${response.status}`);
    return "Task aperto.";
  },
  "skill-merge": async (env, params) => {
    const lessonIds = Array.isArray(params.lessonIds) ? params.lessonIds.filter((id): id is string => typeof id === "string") : [];
    const trigger = asString(params.trigger);
    const rule = asString(params.rule);
    if (lessonIds.length < 2 || !trigger || !rule) throw new Error("proposta merge non valida");
    await createFirestoreLesson(env, { trigger, rule });
    for (const lessonId of lessonIds) await deleteFirestoreDocument(env, `lessons/${lessonId}`);
    return "Merge lessons approvato e applicato.";
  },
  "skill-quarantine": async (env, params) => {
    const skillId = asString(params.skillId);
    if (!skillId) throw new Error("proposta quarantena non valida");
    const document = await getFirestoreDocument(env, `skills/${skillId}`);
    if (!document) throw new Error("skill non trovata");
    const current = asNumber(fromFirestoreValue(asRecord(document.fields).harmfulCount)) ?? 0;
    await patchFirestoreDocument(env, `skills/${skillId}`, {
      harmfulCount: Math.max(2, current),
      updatedAt: new Date().toISOString(),
    });
    return "Skill messa in quarantena.";
  },
  "arretrati-log-event": async (env, params) => {
    const noteId = asString(params.noteId); const event = asString(params.event) as WorkEventType | null;
    if (!noteId || !event || !nextEvent(event === "consegnato" ? "in_stampa" : event) && event !== "consegnato") throw new Error("evento arretrati non valido");
    await appendWorkHistory(env, { noteId, event, detail: asString(params.detail) ?? "aggiornato da digest" });
    const state = await loadArretratiState(env); delete state.streaks[noteId]; await saveArretratiState(env, state);
    return "Storico aggiornato.";
  },
  "arretrati-suspend": async (env, params) => {
    const noteId = asString(params.noteId); const text = asString(params.text); const title = asString(params.title) ?? "Scheda";
    if (!noteId || text === null) throw new Error("scheda arretrati non valida");
    await setWorkNoteTag(env, { id: noteId, title, text, historyUpdatedAt: null, updatedAt: null, createdAt: null }, "#sospeso", true);
    await appendWorkHistory(env, { noteId, event: "sospeso_cliente", detail: "sospeso da digest" });
    const state = await loadArretratiState(env); delete state.streaks[noteId]; await saveArretratiState(env, state);
    return "Scheda sospesa e Storico aggiornato.";
  },
  "arretrati-retry": async (env, params) => {
    const noteId = asString(params.noteId); if (!noteId) throw new Error("scheda arretrati non valida");
    const state = await loadArretratiState(env); state.streaks[noteId] = { date: new Date(Date.now() - DAY_MS).toISOString().slice(0, 10), count: 0 }; await saveArretratiState(env, state);
    return "Va bene: domani te lo ripropongo.";
  },
  "arretrati-audit-tag": async (env, params) => {
    const notes = Array.isArray(params.notes) ? params.notes.filter(isRecord).map((note) => ({ id: asString(note.id) ?? "", title: asString(note.title) ?? "Scheda", text: asString(note.text) ?? "" })).filter((note) => note.id && note.text) : [];
    if (!notes.length) throw new Error("audit legacy senza schede valide");
    const tagged = await batchAddRegularizeTag(env, notes);
    return `${tagged} schede taggate come #daregolarizzare: entreranno nella rotazione del digest da domani.`;
  },
  "calendar-create": async (env, params) => {
    const title = asString(params.title);
    const startAt = asString(params.startAt);
    const endAt = asString(params.endAt);
    const allDay = params.allDay === true;
    if (!title || !startAt || !endAt) throw new Error("proposta calendario non valida");
    const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + "/calendar/create-event";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-key": env.AGENT_KEY },
      body: JSON.stringify({
        title,
        start: allDay ? startAt.slice(0, 10) : startAt,
        end: allDay ? endAt.slice(0, 10) : endAt,
        location: asString(params.location) ?? undefined,
        description: asString(params.description) ?? undefined,
      }),
    });
    const body = asRecord(await response.json());
    const id = asString(body.id);
    if (!response.ok || !id) throw new Error(`calendar/create-event ${response.status}`);
    return `Evento creato: ${title}\n${formatCalendarDate(startAt, allDay)} (ID ${id}).`;
  },
  "calendar-update": async (env, params) => {
    const eventId = asString(params.eventId);
    const etag = asString(params.etag);
    const currentTitle = asString(params.currentTitle) ?? "Evento";
    if (!eventId || !etag) throw new Error("proposta modifica calendario non valida");
    const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + `/calendar/events/${encodeURIComponent(eventId)}`;
    const response = await fetch(endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-agent-key": env.AGENT_KEY },
      body: JSON.stringify({
        etag,
        ...(asString(params.title) ? { title: asString(params.title) } : {}),
        ...(asString(params.start) ? { start: asString(params.start) } : {}),
        ...(asString(params.end) ? { end: asString(params.end) } : {}),
        ...(asString(params.location) ? { location: asString(params.location) } : {}),
        ...(asString(params.description) ? { description: asString(params.description) } : {}),
      }),
    });
    if (response.status === 409) throw new Error("L'evento è cambiato nel frattempo: rileggilo e riprova.");
    if (response.status === 404) throw new Error("L'evento non esiste più.");
    if (!response.ok) throw new Error(`calendar update ${response.status}`);
    return `Evento modificato: ${asString(params.title) ?? currentTitle}.`;
  },
  "calendar-delete": async (env, params) => {
    const eventId = asString(params.eventId);
    const etag = asString(params.etag);
    const title = asString(params.title) ?? "Evento";
    if (!eventId || !etag) throw new Error("proposta cancellazione calendario non valida");
    const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + `/calendar/events/${encodeURIComponent(eventId)}`;
    const response = await fetch(endpoint, {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-agent-key": env.AGENT_KEY },
      body: JSON.stringify({ etag }),
    });
    if (response.status === 409) throw new Error("L'evento è cambiato nel frattempo: rileggilo e riprova.");
    if (response.status === 404) throw new Error("L'evento non esiste più.");
    if (!response.ok) throw new Error(`calendar delete ${response.status}`);
    return `Evento cancellato: ${title}.`;
  },
};

async function answerCallbackQuery(env: Env, callbackQueryId: string, text: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
  if (!response.ok) throw new Error(`Telegram callback error: ${response.status}`);
}

type TelegramVoice = { file_id: string; duration: number; file_size?: number; mime_type?: string };
type FailedVoiceArchive = {
  savedAt: string;
  fileId: string;
  durationSeconds: number;
  mimeType: string;
  audioBase64: string;
  failure: string;
};
type VoiceUsage = { month: string; transcribedSeconds: number; requests: number };

const failedVoiceKey = (chatId: number) => `voice:failed:${chatId}`;
const voiceUsageKey = () => "voice:usage";

async function transcribeTelegramVoice(env: Env, chatId: number, voice: TelegramVoice): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY mancante");

  const audio = await downloadTelegramVoice(env, voice.file_id);
  try {
    const transcript = await transcribeWithGemini(env, audio, voice.mime_type ?? "audio/ogg", voice.file_id);
    await recordVoiceUsage(env, voice.duration);
    return transcript;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await archiveFailedVoice(env, chatId, voice, audio, message);
    } catch (archiveError) {
      console.error("[VOICE] Archiviazione vocale fallita:", archiveError);
    }
    throw error;
  }
}

async function downloadTelegramVoice(env: Env, fileId: string): Promise<ArrayBuffer> {
  const fileResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!fileResponse.ok) throw new Error(`Telegram getFile ${fileResponse.status}`);
  const filePayload = asRecord(await fileResponse.json());
  const result = asRecord(filePayload.result);
  const filePath = asString(result.file_path);
  if (!filePayload.ok || !filePath) throw new Error("Telegram getFile non ha restituito il percorso audio");

  const audioResponse = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${filePath}`);
  if (!audioResponse.ok) throw new Error(`Download vocale Telegram ${audioResponse.status}`);
  return audioResponse.arrayBuffer();
}

async function transcribeWithGemini(env: Env, audio: ArrayBuffer, mimeType: string, fileId: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_TRANSCRIBE_TIMEOUT_MS);
  let uploadedFileName: string | null = null;
  try {
    const uploadStart = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-goog-api-key": env.GEMINI_API_KEY!,
        "content-type": "application/json",
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(audio.byteLength),
        "x-goog-upload-header-content-type": mimeType,
      },
      body: JSON.stringify({ file: { display_name: `telegram-voice-${fileId}` } }),
    });
    const uploadUrl = uploadStart.headers.get("x-goog-upload-url");
    if (!uploadStart.ok || !uploadUrl) throw new Error(`Gemini upload init ${uploadStart.status}`);

    const upload = await fetch(uploadUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-length": String(audio.byteLength),
        "x-goog-upload-offset": "0",
        "x-goog-upload-command": "upload, finalize",
      },
      body: audio,
    });
    const uploadBody = asRecord(await upload.json());
    const uploadedFile = asRecord(uploadBody.file);
    const fileUri = asString(uploadedFile.uri);
    uploadedFileName = asString(uploadedFile.name);
    if (!upload.ok || !fileUri) throw new Error(`Gemini upload ${upload.status}`);

    const transcription = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      signal: controller.signal,
      headers: { "x-goog-api-key": env.GEMINI_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_TRANSCRIBE_MODEL,
        input: [{ type: "audio", uri: fileUri, mime_type: mimeType }],
        generation_config: {
          transcription_config: {
            mode: "smart",
            language_codes: [],
            ...(TRANSCRIPTION_CUSTOM_VOCABULARY.length ? { custom_vocabulary: TRANSCRIPTION_CUSTOM_VOCABULARY } : {}),
          },
        },
      }),
    });
    const transcriptionRaw = await transcription.text();
    let transcriptionBody: RawRecord;
    try {
      transcriptionBody = asRecord(JSON.parse(transcriptionRaw));
    } catch {
      console.error("[VOICE] Gemini ha restituito JSON non valido:", transcriptionRaw.slice(0, 2_000));
      throw new Error(`Gemini trascrizione ${transcription.status}`);
    }
    const output = extractGeminiTranscriptionText(transcriptionBody);
    if (!transcription.ok || !output) {
      console.error("[VOICE] Gemini senza testo trascritto:", transcriptionRaw.slice(0, 2_000));
      throw new Error(`Gemini trascrizione ${transcription.status}`);
    }
    return output;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Timeout Gemini dopo 20 secondi");
    throw error;
  } finally {
    clearTimeout(timeout);
    if (uploadedFileName) {
      void fetch(`https://generativelanguage.googleapis.com/v1beta/${uploadedFileName}`, {
        method: "DELETE",
        headers: { "x-goog-api-key": env.GEMINI_API_KEY! },
      }).catch((error) => console.error("[VOICE] Cleanup file Gemini fallito:", error));
    }
  }
}

function extractGeminiTranscriptionText(response: RawRecord): string {
  const steps = Array.isArray(response.steps) ? response.steps.filter(isRecord) : [];
  return steps
    .filter((step) => asString(step.type) === "model_output")
    .flatMap((step) => Array.isArray(step.content) ? step.content.filter(isRecord) : [])
    .filter((content) => asString(content.type) === "text")
    .map((content) => asString(content.text) ?? "")
    .join("\n")
    .trim();
}

async function archiveFailedVoice(env: Env, chatId: number, voice: TelegramVoice, audio: ArrayBuffer, failure: string): Promise<void> {
  if (audio.byteLength > MAX_FAILED_VOICE_ARCHIVE_BYTES) {
    throw new Error(`vocale troppo grande per archivio KV (${audio.byteLength} byte)`);
  }
  const archive: FailedVoiceArchive = {
    savedAt: new Date().toISOString(),
    fileId: voice.file_id,
    durationSeconds: voice.duration,
    mimeType: voice.mime_type ?? "audio/ogg",
    audioBase64: arrayBufferToBase64(audio),
    failure: failure.slice(0, 500),
  };
  await env.SAVERIO_KV.put(failedVoiceKey(chatId), JSON.stringify(archive), { expirationTtl: FAILED_VOICE_TTL });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

async function recordVoiceUsage(env: Env, seconds: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  let usage: VoiceUsage = { month, transcribedSeconds: 0, requests: 0 };
  try {
    const stored = await env.SAVERIO_KV.get(voiceUsageKey());
    if (stored) {
      const parsed = asRecord(JSON.parse(stored));
      if (asString(parsed.month) === month) {
        usage = { month, transcribedSeconds: asNumber(parsed.transcribedSeconds) ?? 0, requests: asNumber(parsed.requests) ?? 0 };
      }
    }
  } catch (error) {
    console.error("[VOICE] Lettura telemetria STT fallita:", error);
  }
  usage.transcribedSeconds += Math.max(0, seconds);
  usage.requests += 1;
  await env.SAVERIO_KV.put(voiceUsageKey(), JSON.stringify(usage), { expirationTtl: VOICE_USAGE_TTL });
}

function voiceFailureMessage(message: string): string {
  return /timeout/i.test(message) ? "timeout Gemini dopo 20 secondi" : "audio conservato per retry manuale";
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  options: { menu?: boolean; inlineKeyboard?: TelegramInlineButton[][] } = {},
) {
  // Telegram taglia oltre 4096 caratteri: spezzo se serve.
  for (let i = 0; i < text.length; i += 4000) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(i, i + 4000) };
      if (options.menu && i === 0) body.reply_markup = MAIN_MENU;
      if (options.inlineKeyboard && i === 0) body.reply_markup = { inline_keyboard: options.inlineKeyboard };
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Telegram error: ${response.status}`);
    } catch (error) {
      console.error("[FASE-1] Invio Telegram fallito:", error);
      throw error;
    }
  }
}

// ===== Riepilogo cliente dalla memoria unificata =====

function isClientBriefIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  return value.includes("fammi il punto su")
    || value.includes("fai il punto su")
    || value.includes("punto sul cliente")
    || value.includes("situazione cliente")
    || value.includes("riepilogo cliente")
    || value.includes("cosa sappiamo di")
    || value.includes("cosa abbiamo su")
    || value.includes("informazioni su")
    || value.includes("info su")
    || value.includes("cosa sai di")
    || value.includes("cosa sai su")
    || value.includes("dimmi cosa sai di")
    || value.includes("dimmi cosa sai su");
}

type EmailSearchPlan = { query: string; max: number; newsletterCheck: boolean };

function emailSearchPlan(text: string): EmailSearchPlan | null {
  const normalized = text.toLowerCase().trim();
  if (!/\b(?:e-?mail|posta|inbox|newsletter)\b/.test(normalized)) return null;

  const countMatch = normalized.match(/\b(?:ultim[eaie]*|prime)\s+(\d{1,2})\s+e-?mail\b/);
  const max = countMatch ? Math.max(1, Math.min(30, Number(countMatch[1]))) : 30;
  const newsletterCheck = /\bnewsletter\b|\biscritt[oaie]*\b/.test(normalized);
  const safeBase = "-in:spam -in:trash";
  if (newsletterCheck || /\b(?:ultim[eaie]*|prime)\s+\d*\s*e-?mail\b/.test(normalized)) {
    return { query: safeBase, max, newsletterCheck };
  }

  const fromMatch = text.match(/\b(?:email|posta)\s+da\s+([^?.,!]+)|\bda\s+([^?.,!]+)\s+(?:email|posta)\b/i);
  const sender = (fromMatch?.[1] ?? fromMatch?.[2] ?? "").trim();
  if (sender) return { query: `${safeBase} from:(${sender.slice(0, 100)})`, max, newsletterCheck: false };

  const terms = text
    .replace(/\b(?:cerca|cercami|trova|nelle?|ultim[eaie]*|prime|email|e-mail|posta|inbox|messaggi?)\b/gi, " ")
    .replace(/\b\d{1,2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return { query: terms ? `${safeBase} ${terms}` : safeBase, max, newsletterCheck: false };
}

async function gestisciEmail(env: Env, text: string): Promise<string | null> {
  const plan = emailSearchPlan(text);
  if (!plan) return null;

  const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "")
    + `/email/search?q=${encodeURIComponent(plan.query)}&max=${plan.max}`;
  try {
    const response = await fetch(endpoint, { headers: { "x-agent-key": env.AGENT_KEY } });
    if (!response.ok) {
      const failure = asRecord(await response.json());
      const code = asString(failure.error);
      if (code === "gmail_api_disabled") {
        return "La Gmail API non è ancora abilitata nel progetto Google. Apri Google Cloud Console → API e servizi → Libreria, abilita Gmail API, poi riprova.";
      }
      if (code === "gmail_scope_missing") {
        return "Manca il consenso Gmail. Apri di nuovo il link /auth del backend, accetta Gmail in sola lettura e poi riprova.";
      }
      throw new Error(`email/search ${response.status}: ${code ?? "errore non specificato"}`);
    }
    const emails = asRecord(await response.json()).emails;
    if (!Array.isArray(emails)) throw new Error("email/search risposta senza emails");
    const results = emails.filter(isRecord).slice(0, plan.max);
    return plan.newsletterCheck
      ? formatNewsletterCheck(results, plan.max)
      : formatEmailSearchResults(results, plan.max);
  } catch (error) {
    console.error("[FASE-4] Ricerca email fallita:", error);
    return "Non riesco a consultare la posta in questo momento. Riprova tra poco.";
  }
}

function formatNewsletterCheck(emails: RawRecord[], inspected: number): string {
  const newsletters = emails.filter((email) => email.listUnsubscribe === true
    || (Array.isArray(email.labels) && email.labels.some((label) => label === "CATEGORY_PROMOTIONS")));
  if (!newsletters.length) {
    return `Ho controllato le ultime ${inspected} email: non trovo segnali tecnici di iscrizione a newsletter. È una verifica limitata a questo campione.`;
  }
  const rows = newsletters.slice(0, 10).map((email) => {
    const from = asString(email.from) ?? "mittente sconosciuto";
    const subject = asString(email.subject) ?? "(senza oggetto)";
    return `• ${from} — ${subject}`;
  });
  return `Nelle ultime ${inspected} email ho trovato ${newsletters.length} possibili newsletter/iscrizioni:\n\n${rows.join("\n")}`;
}

function formatEmailSearchResults(emails: RawRecord[], inspected: number): string {
  if (!emails.length) return `Non ho trovato email pertinenti tra le ultime ${inspected} controllate.`;
  const rows = emails.slice(0, 10).map((email) => {
    const from = asString(email.from) ?? "mittente sconosciuto";
    const subject = asString(email.subject) ?? "(senza oggetto)";
    const snippet = (asString(email.snippet) ?? "").replace(/\s+/g, " ").slice(0, 180);
    return [`• ${from} — ${subject}`, snippet ? `  ${snippet}` : ""].filter(Boolean).join("\n");
  });
  const suffix = emails.length > rows.length ? `\n\nMostro le prime ${rows.length} di ${emails.length}.` : "";
  return `Ho trovato ${emails.length} email tra le ultime ${inspected} controllate:\n\n${rows.join("\n\n")}${suffix}`;
}

async function gestisciRiepilogoCliente(env: Env, text: string): Promise<string | null> {
  if (!isClientBriefIntent(text)) return null;
  const baseUrl = env.TASK_URL.replace(/\/task\/?$/i, "");
  const query = text
    .replace(/^(?:fammi|fai)\s+il\s+punto\s+su(?:l\s+cliente)?\s*/i, "")
    .replace(/^(?:situazione|riepilogo)\s+cliente\s*/i, "")
    .replace(/^cosa\s+(?:sappiamo\s+di|abbiamo\s+su)\s*/i, "")
    .replace(/^(?:informazioni|info)\s+(?:sul(?:\s+cliente)?|su)\s*/i, "")
    .replace(/^(?:dimmi\s+)?cosa\s+sai\s+(?:sul|su|di)\s*/i, "")
    .replace(/[?!.]+$/, "")
    .trim();

  try {
    const response = await fetch(`${baseUrl}/agent/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-key": env.AGENT_KEY },
      body: JSON.stringify({ question: text, query: query || text }),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`memory backend ${response.status}: ${raw}`);
    const data = JSON.parse(raw) as { answer?: string };
    return data.answer?.trim() || "Non ho trovato dati sufficienti su questo cliente.";
  } catch (error) {
    console.error("[CLIENT BRIEF] Ricerca fallita:", error);
    return "Non riesco a consultare la memoria clienti in questo momento. Riprova tra poco.";
  }
}

// ===== Promemoria Telegram =====

type SaverioReminder = {
  id: string;
  telegram_chat_id: string;
  title: string;
  due_at: string;
  status: "pending" | "processing" | "sent";
  processing_at?: string | null;
};

type ParsedReminder = {
  title: string;
  dueAt: string;
};

function isReminderIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  return /\b(promemoria|ricordami)\b/.test(value);
}

function isReminderListIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  if (value === "/promemoria" || value === "promemoria") return true;
  return /\b(?:che|quali|mostra(?:mi)?|elenca(?:mi)?|vedi|fammi vedere|dove trovo)\b[\s\S]{0,80}\bpromemoria\b/.test(value)
    || /\bpromemoria\b[\s\S]{0,80}\b(?:che|quali|mostra(?:mi)?|elenca(?:mi)?|ho)\b/.test(value);
}

async function listFutureReminders(env: Env, chatId: number): Promise<string> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return "I promemoria non sono ancora configurati: manca l'accesso Firestore di Saverio.";
  }
  try {
    const reminders = await getFutureFirestoreReminders(env, chatId);
    if (!reminders.length) return "📌 Non hai promemoria in attesa.";
    const timezone = env.TIMEZONE || "Europe/Rome";
    return [
      "📌 Promemoria in attesa:",
      ...reminders.map((reminder) => `- ${formatFutureReminderDate(reminder.due_at, timezone)} — ${reminder.title}`),
    ].join("\n");
  } catch (error) {
    console.error("[REMINDER] Lettura promemoria futuri fallita:", error);
    return "Non riesco a leggere i promemoria in attesa. Riprova tra poco.";
  }
}

async function gestisciPromemoria(env: Env, chatId: number, text: string): Promise<string | null> {
  if (!isReminderIntent(text)) return null;
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return "I promemoria non sono ancora configurati: manca l'accesso Firestore di Saverio.";
  }

  const parsed = parseSingleReminder(text);
  if (!parsed) {
    return "Dimmi anche quando devo ricordartelo. Per esempio: segna un promemoria tra un'ora di mandare una email.";
  }

  try {
    await createFirestoreReminder(env, {
      telegram_chat_id: String(chatId),
      title: parsed.title,
      due_at: parsed.dueAt,
      status: "pending",
    });
    return `Promemoria impostato:\n${formatReminderDate(parsed.dueAt, env.TIMEZONE || "Europe/Rome")}\n${parsed.title}`;
  } catch (error) {
    console.error("[REMINDER] Salvataggio fallito:", error);
    return "Non sono riuscito a salvare il promemoria. Riprova tra poco.";
  }
}

function parseSingleReminder(text: string): ParsedReminder | null {
  const now = new Date();
  const interval = /\btra\s+(mezz['’]?\s*ora|un['’]?\s*ora|una\s+ora|un\s+ora|\d+\s+ore?|\d+\s+minuti?|un\s+minuto|una\s+mezz['’]?ora|due\s+ore|tre\s+ore|due\s+minuti|tre\s+minuti)\b/i.exec(text);
  if (interval && interval.index !== undefined) {
    const normalizedInterval = normalizeForMatch(interval[1]);
    let minutes: number | null = null;
    if (normalizedInterval.includes("mezz ora")) minutes = 30;
    else if (/^(un|una|1) ora$/.test(normalizedInterval)) minutes = 60;
    else if (normalizedInterval === "due ore") minutes = 120;
    else if (normalizedInterval === "tre ore") minutes = 180;
    else {
      const numeric = /^(\d+)\s+(ore?|minuti?)$/.exec(normalizedInterval);
      if (numeric) minutes = Number(numeric[1]) * (numeric[2].startsWith("or") ? 60 : 1);
      else if (normalizedInterval === "un minuto") minutes = 1;
      else if (normalizedInterval === "due minuti") minutes = 2;
      else if (normalizedInterval === "tre minuti") minutes = 3;
    }
    if (!minutes || minutes < 1) return null;

    const title = cleanReminderTitle(text.slice(interval.index + interval[0].length));
    return title ? { title, dueAt: new Date(now.getTime() + minutes * 60_000).toISOString() } : null;
  }

  const exactTime = /\b(?:(oggi|domani)\s+)?alle\s+([01]?\d|2[0-3])(?:[,:.]([0-5]\d))?\b/i.exec(text);
  if (!exactTime || exactTime.index === undefined) return null;

  const hour = Number(exactTime[2]);
  const minute = Number(exactTime[3] || 0);
  const dueAt = getNextReminderTime(hour, minute, exactTime[1]?.toLowerCase(), now);
  const title = cleanReminderTitle(text.slice(exactTime.index + exactTime[0].length));
  return title ? { title, dueAt } : null;
}

function cleanReminderTitle(text: string): string {
  return text
    .replace(/^\s*(?:di\s+)?(?:devo\s+)?/i, "")
    .trim()
    .replace(/[.?!]+$/, "");
}

function getNextReminderTime(hour: number, minute: number, dayHint: string | undefined, now: Date): string {
  const timezone = "Europe/Rome";
  const local = getRomeDateParts(now, timezone);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (dayHint === "domani") date.setUTCDate(date.getUTCDate() + 1);
  let candidate = toRomeDateTimeIso(date, hour, minute, timezone);
  if (dayHint !== "domani" && new Date(candidate).getTime() <= now.getTime()) {
    date.setUTCDate(date.getUTCDate() + 1);
    candidate = toRomeDateTimeIso(date, hour, minute, timezone);
  }
  return candidate;
}

function toRomeDateTimeIso(date: Date, hour: number, minute: number, timezone: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const probe = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate(), hour, minute));
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offset = offsetPart.replace("GMT", "") || "+00:00";
  return `${year}-${month}-${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00${offset}`;
}

function formatReminderDate(value: string, timezone: string): string {
  return new Date(value).toLocaleString("it-IT", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  });
}

function firestoreReminderUrl(path = ""): string {
  return "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID
    + "/databases/(default)/documents/saverio_reminders" + (path ? "/" + path : "");
}

async function createFirestoreReminder(env: Env, reminder: Omit<SaverioReminder, "id" | "processing_at">): Promise<void> {
  const token = await getFirestoreAccessToken(env);
  const now = new Date().toISOString();
  const response = await fetch(firestoreReminderUrl(), {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        telegram_chat_id: { stringValue: reminder.telegram_chat_id },
        title: { stringValue: reminder.title },
        due_at: { timestampValue: reminder.due_at },
        status: { stringValue: "pending" },
        created_at: { timestampValue: now },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore insert ${response.status}: ${await response.text()}`);
}

async function createFirestoreDeepDiveReport(env: Env, job: DeepDiveJob, report: string): Promise<void> {
  job.usage.firestoreWrites += 1;
  const token = await getFirestoreAccessToken(env);
  const displayName = asString(job.results.resolve?.displayName) ?? job.target;
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/reports`,
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        fields: {
          target: { stringValue: job.target },
          displayName: { stringValue: displayName },
          report: { stringValue: report },
          rawResults: firestoreValue(toJsonValue(compactDeepDiveResults(job.results))),
          createdAt: { timestampValue: new Date().toISOString() },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Firestore reports insert ${response.status}: ${await response.text()}`);
}

async function writeDeepDiveEpisode(
  env: Env,
  job: DeepDiveJob,
  outcome: "done" | "failed",
  failedStep: DeepDiveStep | null,
): Promise<void> {
  refreshDeepDiveTiming(job);
  job.usage.firestoreWrites += 1;
  const token = await getFirestoreAccessToken(env);
  const steps = job.steps.map((name) => {
    const execution = job.stepExecutions[name];
    return {
      name,
      durationMs: execution?.durationMs ?? null,
      retries: execution?.retries ?? job.retryCounts[name] ?? 0,
      error: execution?.error ?? (name === failedStep ? job.error : null),
    };
  });
  const url = new URL(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/episodes/${job.id}`,
  );
  url.searchParams.set("currentDocument.exists", "false");
  const response = await fetch(url, {
    method: "PATCH",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        jobId: { stringValue: job.id },
        type: { stringValue: job.type },
        target: { stringValue: job.target },
        outcome: { stringValue: outcome },
        failedStep: failedStep ? { stringValue: failedStep } : { nullValue: null },
        steps: firestoreValue(toJsonValue(steps)),
        skillUsed: job.learningContext.skill ? { stringValue: job.learningContext.skill.id } : { nullValue: null },
        usage: firestoreValue(toJsonValue(job.usage)),
        timing: firestoreValue(toJsonValue(job.timing)),
        estimatedClaudeUsd: { doubleValue: estimateClaudeUsd(job.usage) },
        createdAt: { timestampValue: job.createdAt },
      },
    }),
  });
  if (response.status === 409) return;
  if (!response.ok) throw new Error(`Firestore episodes write ${response.status}: ${await response.text()}`);
}

async function formatDeepDiveCostSummary(env: Env): Promise<string> {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const totals = emptyDeepDiveUsage();
  let jobs = 0;
  let telemetryJobs = 0;
  let completedMs = 0;
  let completedWithTiming = 0;
  let arretratiReads = 0;
  let voiceUsage: VoiceUsage | null = null;
  try { arretratiReads = asNumber(JSON.parse(await env.SAVERIO_KV.get(`arretrati:telemetry:${new Date().toISOString().slice(0, 7)}`) ?? "{}").firestoreReads) ?? 0; } catch { /* telemetria opzionale */ }
  try {
    const storedVoiceUsage = await env.SAVERIO_KV.get(voiceUsageKey());
    if (storedVoiceUsage) {
      const parsed = asRecord(JSON.parse(storedVoiceUsage));
      if (asString(parsed.month) === new Date().toISOString().slice(0, 7)) {
        voiceUsage = {
          month: asString(parsed.month)!,
          transcribedSeconds: asNumber(parsed.transcribedSeconds) ?? 0,
          requests: asNumber(parsed.requests) ?? 0,
        };
      }
    }
  } catch { /* telemetria STT opzionale */ }

  try {
    const documents = await listFirestoreCollection(env, "episodes");
    for (const document of documents) {
      const fields = asRecord(document.fields);
      const createdAt = asString(fromFirestoreValue(fields.createdAt));
      if (!createdAt || Date.parse(createdAt) < cutoff) continue;
      jobs += 1;
      const usage = asRecord(fromFirestoreValue(fields.usage));
      if (Object.keys(usage).length) {
        telemetryJobs += 1;
        totals.anthropicRequests += asNumber(usage.anthropicRequests) ?? 0;
        totals.anthropicInputTokens += asNumber(usage.anthropicInputTokens) ?? 0;
        totals.anthropicOutputTokens += asNumber(usage.anthropicOutputTokens) ?? 0;
        totals.anthropicWebSearches += asNumber(usage.anthropicWebSearches) ?? 0;
        totals.geminiEmbeddings += asNumber(usage.geminiEmbeddings) ?? 0;
        totals.firestoreReads += asNumber(usage.firestoreReads) ?? 0;
        totals.firestoreWrites += asNumber(usage.firestoreWrites) ?? 0;
        totals.apifyRuns += asNumber(usage.apifyRuns) ?? 0;
        totals.apifyHttpRequests += asNumber(usage.apifyHttpRequests) ?? 0;
        totals.websiteFetches += asNumber(usage.websiteFetches) ?? 0;
      }
      const timing = asRecord(fromFirestoreValue(fields.timing));
      const endToEndMs = asNumber(timing.endToEndMs);
      if (endToEndMs !== null) {
        completedMs += endToEndMs;
        completedWithTiming += 1;
      }
    }
  } catch (error) {
    console.error("[FASE-2] Lettura telemetria costi fallita:", error);
    return "Non riesco a leggere la telemetria costi in questo momento. Riprova tra poco.";
  }

  if (!telemetryJobs && !voiceUsage) {
    return `COSTI /INDAGA — ultimi 30 giorni\nJob conclusi: ${jobs}\nNon ci sono ancora job con telemetria: la raccolta parte da questo aggiornamento.`;
  }

  const averageDuration = completedWithTiming ? Math.round(completedMs / completedWithTiming) : null;
  return [
    "COSTI /INDAGA — ultimi 30 giorni",
    `Job: ${jobs} (${telemetryJobs} con telemetria)`,
    averageDuration === null ? "Durata media: non disponibile" : `Durata media end-to-end: ${formatDeepDiveDuration(averageDuration)}`,
    `Claude: ${totals.anthropicRequests} chiamate, ${totals.anthropicInputTokens.toLocaleString("it-IT")} token input, ${totals.anthropicOutputTokens.toLocaleString("it-IT")} output, ${totals.anthropicWebSearches} ricerche`,
    `Stima Claude: $${estimateClaudeUsd(totals).toFixed(4)} (token + web search; tasse escluse)`,
    `Gemini embedding: ${totals.geminiEmbeddings}`,
    voiceUsage ? `STT questo mese: ${formatDeepDiveDuration(voiceUsage.transcribedSeconds * 1000)}, ${voiceUsage.requests} vocali` : "STT questo mese: nessun vocale trascritto.",
    `Apify: ${totals.apifyRuns} run, ${totals.apifyHttpRequests} richieste API`,
    `Firestore: ${totals.firestoreReads} letture, ${totals.firestoreWrites} scritture; Arretrati: ${arretratiReads} letture questo mese; sito: ${totals.websiteFetches} pagine`,
    "Nota: il costo Apify dipende dal tuo piano/actor e non e incluso nella stima Claude.",
  ].join("\n");
}

function formatDeepDiveDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

async function processDuePromemoria(env: Env): Promise<void> {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return;
  try {
    const reminders = await getDueFirestoreReminders(env);
    for (const reminder of reminders) await deliverReminder(env, reminder);
  } catch (error) {
    console.error("[REMINDER] Controllo scadenze fallito:", error);
  }
}

async function getDueFirestoreReminders(env: Env): Promise<SaverioReminder[]> {
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(
    "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents:runQuery",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "saverio_reminders" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "due_at" },
              op: "LESS_THAN_OR_EQUAL",
              value: { timestampValue: new Date().toISOString() },
            },
          },
          orderBy: [{ field: { fieldPath: "due_at" }, direction: "ASCENDING" }],
          limit: 25,
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Firestore query ${response.status}: ${await response.text()}`);
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) throw new Error("Firestore promemoria: risposta non valida");
  const staleBefore = Date.now() - 10 * 60_000;
  return rows
    .filter(isRecord)
    .map((row) => parseFirestoreReminder(asRecord(row.document)))
    .filter((reminder): reminder is SaverioReminder => reminder !== null)
    .filter((reminder) => reminder.status === "pending" || (
      reminder.status === "processing"
      && reminder.processing_at
      && new Date(reminder.processing_at).getTime() < staleBefore
    ));
}

async function getFutureFirestoreReminders(env: Env, chatId: number): Promise<SaverioReminder[]> {
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(
    "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents:runQuery",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "saverio_reminders" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "telegram_chat_id" },
              op: "EQUAL",
              value: { stringValue: String(chatId) },
            },
          },
          limit: 100,
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`Firestore query promemoria futuri ${response.status}: ${await response.text()}`);
  const rows = await response.json() as unknown;
  if (!Array.isArray(rows)) throw new Error("Firestore promemoria futuri: risposta non valida");
  const now = Date.now();
  return rows
    .filter(isRecord)
    .map((row) => parseFirestoreReminder(asRecord(row.document)))
    .filter((reminder): reminder is SaverioReminder => reminder !== null)
    .filter((reminder) => reminder.status === "pending" && Date.parse(reminder.due_at) > now)
    .sort((left, right) => Date.parse(left.due_at) - Date.parse(right.due_at));
}

function formatFutureReminderDate(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function parseFirestoreReminder(document: RawRecord): SaverioReminder | null {
  const name = asString(document.name);
  const prefix = "projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents/saverio_reminders/";
  if (!name?.startsWith(prefix)) return null;
  const fields = asRecord(document.fields);
  const telegramChatId = asString(fromFirestoreValue(fields.telegram_chat_id));
  const title = asString(fromFirestoreValue(fields.title));
  const dueAt = asString(fromFirestoreValue(fields.due_at));
  const status = asString(fromFirestoreValue(fields.status));
  if (!telegramChatId || !title || !dueAt || (status !== "pending" && status !== "processing")) return null;
  return {
    id: name.slice(prefix.length),
    telegram_chat_id: telegramChatId,
    title,
    due_at: dueAt,
    status,
    processing_at: asString(fromFirestoreValue(fields.processing_at)),
  };
}

async function deliverReminder(env: Env, reminder: SaverioReminder): Promise<void> {
  try {
    await updateFirestoreReminder(env, reminder.id, "processing");
    await sendMessage(env, Number(reminder.telegram_chat_id), `Promemoria: ${reminder.title}`);
    await deleteFirestoreReminder(env, reminder.id);
    console.log("[REMINDER] Inviato:", reminder.id);
  } catch (error) {
    console.error("[REMINDER] Invio fallito:", error);
    await updateFirestoreReminder(env, reminder.id, "pending").catch((resetError) => {
      console.error("[REMINDER] Ripristino fallito:", resetError);
    });
  }
}

async function updateFirestoreReminder(env: Env, id: string, status: "pending" | "processing"): Promise<void> {
  const token = await getFirestoreAccessToken(env);
  const url = new URL(firestoreReminderUrl(id));
  url.searchParams.append("updateMask.fieldPaths", "status");
  url.searchParams.append("updateMask.fieldPaths", "processing_at");
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        status: { stringValue: status },
        processing_at: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!response.ok) throw new Error(`Firestore update ${response.status}: ${await response.text()}`);
}

async function deleteFirestoreReminder(env: Env, id: string): Promise<void> {
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(firestoreReminderUrl(id), {
    method: "DELETE",
    headers: { authorization: "Bearer " + token },
  });
  if (!response.ok) throw new Error(`Firestore delete ${response.status}: ${await response.text()}`);
}

// ===== Google Calendar =====

type CalendarEventDraft = {
  intent: "calendar_create" | "unknown";
  title: string | null;
  description: string | null;
  location: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  confidence: number;
};

type CalendarMutationDraft = {
  intent: "calendar_update" | "calendar_delete" | "unknown";
  query: string | null;
  search_start: string | null;
  search_end: string | null;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  location: string | null;
  description: string | null;
  all_day: boolean;
  confidence: number;
};

type GoogleCalendarEvent = {
  id?: string;
  etag?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};
type CalendarReply = { text: string; inlineKeyboard?: TelegramInlineButton[][] };

function isCalendarIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  return value.startsWith("appuntamento ")
    || value.startsWith("appuntamento:")
    || value.startsWith("calendario ")
    || value.startsWith("calendario:")
    || value.includes("metti in calendario")
    || value.includes("segna in calendario")
    || value.includes("segna un appuntamento")
    || value.includes("segna appuntamento")
    || value.includes("aggiungi appuntamento")
    || value.includes("crea appuntamento")
    || value.includes("crea evento");
}

function isCalendarMutationIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  const action = /\b(modifica|sposta|rinomina|cambia|aggiorna|cancella|elimina|rimuovi)\b/.test(value);
  const subject = /\b(calendario|evento|appuntamento|impegno)\b/.test(value);
  return action && subject;
}

function isCalendarReadIntent(text: string): boolean {
  const value = normalizeForMatch(text);
  return value === "calendario"
    || value.startsWith("calendario ")
    || value.startsWith("calendario:")
    || value.startsWith("agenda ")
    || value.startsWith("agenda:")
    || value.includes("mostra calendario")
    || value.includes("mostrami il calendario")
    || value.includes("controlla in calendario")
    || value.includes("verifica in calendario")
    || value.includes("guarda in calendario")
    || value.includes("che appuntamenti ho")
    || value.includes("che impegni ho")
    || value.includes("cosa ho oggi")
    || value.includes("cosa ho domani")
    || value.includes("impegni oggi")
    || value.includes("impegni domani");
}

async function gestisciCalendar(env: Env, chatId: number, text: string): Promise<CalendarReply | null> {
  if (!isCalendarReadIntent(text) && !isCalendarIntent(text) && !isCalendarMutationIntent(text)) return null;

  if (isCalendarMutationIntent(text)) return gestisciMutazioneCalendar(env, chatId, text);

  if (isCalendarReadIntent(text)) {
    const range = getCalendarReadRange(text, env.TIMEZONE || "Europe/Rome");
    const events = await listGoogleCalendarEvents(env, range.start, range.end);
    if (events === null) {
      return { text: "Non riesco a leggere Google Calendar in questo momento. Controlliamo token e permessi." };
    }
    return { text: formatGoogleCalendarEvents(events, range.label, env.TIMEZONE || "Europe/Rome") };
  }

  const draft = await parseCalendarEvent(env, text);
  if (draft.intent !== "calendar_create" || draft.confidence < 0.65) {
    return { text: "Socio, per metterlo in calendario scrivimelo piu' secco: appuntamento: 8 giugno 2026 alle 10 con Nome." };
  }
  if (!draft.title) return { text: "Mi manca il titolo dell'appuntamento." };
  if (!draft.start_at) return { text: "Mi manca data o ora dell'appuntamento." };

  const startAt = draft.start_at;
  const endAt = draft.end_at || addMinutesIso(startAt, draft.all_day ? 24 * 60 : 60);
  const pending = await createPendingAction(env, chatId, "calendar-create", {
    title: draft.title, startAt, endAt, allDay: draft.all_day, location: draft.location, description: draft.description,
  });
  return {
    text: `📅 Confermi?\nTitolo: ${draft.title}\nQuando: ${formatCalendarDate(startAt, draft.all_day)}${draft.location ? `\nLuogo: ${draft.location}` : ""}`,
    inlineKeyboard: [[{ text: "✅ Crea", callback_data: pending.approveData }, { text: "❌ Annulla", callback_data: pending.rejectData }]],
  };
}

async function gestisciMutazioneCalendar(env: Env, chatId: number, text: string): Promise<CalendarReply> {
  const draft = await parseCalendarMutation(env, text);
  if (draft.intent === "unknown" || draft.confidence < 0.65 || !draft.query || !draft.search_start || !draft.search_end) {
    return { text: "Indicami evento e data, per esempio: cancella l'appuntamento con Luca di domani, oppure sposta l'evento Rossi del 12 settembre alle 18." };
  }
  const events = await listGoogleCalendarEvents(env, draft.search_start, draft.search_end);
  if (events === null) return { text: "Non riesco a leggere Google Calendar in questo momento." };
  const matches = findCalendarMatches(events, draft.query);
  if (!matches.length) return { text: `Non trovo un evento che corrisponda a “${draft.query}” nel periodo indicato.` };
  if (matches.length > 1) {
    const choices = matches.slice(0, 5).map(event => `- ${formatCalendarDate(event.start?.dateTime || event.start?.date || "", Boolean(event.start?.date))} — ${event.summary || "Senza titolo"}`);
    return { text: `Ho trovato più eventi. Dimmi quale vuoi ${draft.intent === "calendar_delete" ? "cancellare" : "modificare"}, aggiungendo titolo o orario:\n${choices.join("\n")}` };
  }
  const event = matches[0];
  if (!event.id || !event.etag) return { text: "L'evento trovato non può essere modificato: manca il suo identificativo." };
  const currentTitle = event.summary || "Senza titolo";
  const currentStart = event.start?.dateTime || event.start?.date || "";

  if (draft.intent === "calendar_delete") {
    const pending = await createPendingAction(env, chatId, "calendar-delete", { eventId: event.id, etag: event.etag, title: currentTitle });
    return {
      text: `🗑️ Confermi la cancellazione?\nEvento: ${currentTitle}\nQuando: ${formatCalendarDate(currentStart, Boolean(event.start?.date))}`,
      inlineKeyboard: [[{ text: "🗑️ Cancella", callback_data: pending.approveData }, { text: "❌ Annulla", callback_data: pending.rejectData }]],
    };
  }

  const start = draft.start_at ? (draft.all_day ? draft.start_at.slice(0, 10) : draft.start_at) : null;
  const previousStart = event.start?.dateTime || event.start?.date || "";
  const previousEnd = event.end?.dateTime || event.end?.date || "";
  const previousDurationMinutes = previousStart && previousEnd
    ? Math.max(1, Math.round((Date.parse(previousEnd) - Date.parse(previousStart)) / 60_000))
    : (draft.all_day ? 24 * 60 : 60);
  const end = draft.end_at
    ? (draft.all_day ? draft.end_at.slice(0, 10) : draft.end_at)
    : (start ? (draft.all_day
      ? addMinutesIso(`${start}T00:00:00Z`, previousDurationMinutes).slice(0, 10)
      : addMinutesIso(start, previousDurationMinutes)) : null);
  if (!draft.title && !start && !draft.location && !draft.description) return { text: "Dimmi cosa vuoi cambiare: titolo, data, ora, luogo o descrizione." };
  const pending = await createPendingAction(env, chatId, "calendar-update", {
    eventId: event.id, etag: event.etag, currentTitle,
    title: draft.title, start, end, location: draft.location, description: draft.description,
  });
  const changes = [
    draft.title ? `Nuovo titolo: ${draft.title}` : "",
    start ? `Nuova data/ora: ${formatCalendarDate(start, draft.all_day)}` : "",
    draft.location ? `Nuovo luogo: ${draft.location}` : "",
    draft.description ? `Nuova descrizione: ${draft.description}` : "",
  ].filter(Boolean);
  return {
    text: `✏️ Confermi la modifica?\nEvento: ${currentTitle}\n${changes.join("\n")}`,
    inlineKeyboard: [[{ text: "✅ Modifica", callback_data: pending.approveData }, { text: "❌ Annulla", callback_data: pending.rejectData }]],
  };
}

function findCalendarMatches(events: GoogleCalendarEvent[], query: string): GoogleCalendarEvent[] {
  const wanted = normalizeForMatch(query);
  const exact = events.filter(event => normalizeForMatch(event.summary || "") === wanted);
  if (exact.length) return exact;
  const terms = wanted.split(/\s+/).filter(term => term.length > 2);
  return events.filter(event => {
    const title = normalizeForMatch(event.summary || "");
    return title.includes(wanted) || (terms.length > 0 && terms.every(term => title.includes(term)));
  });
}

function getCalendarReadRange(text: string, timezone: string): { start: string; end: string; label: string } {
  const value = normalizeForMatch(text);
  const today = getRomeDateParts(new Date(), timezone);
  let start = new Date(Date.UTC(today.year, today.month - 1, today.day));
  let days = 1;
  let label = "oggi";
  const months: Record<string, number> = {
    gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
    luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11,
  };
  const explicitDate = value.match(/\b([1-9]|[12]\d|3[01])\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/);
  const weekdays: Record<string, { day: number; label: string }> = {
    lunedi: { day: 1, label: "lunedi prossimo" },
    martedi: { day: 2, label: "martedi prossimo" },
    mercoledi: { day: 3, label: "mercoledi prossimo" },
    giovedi: { day: 4, label: "giovedi prossimo" },
    venerdi: { day: 5, label: "venerdi prossimo" },
    sabato: { day: 6, label: "sabato prossimo" },
    domenica: { day: 7, label: "domenica prossima" },
  };
  const weekdayMatch = value.match(/\b(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\s+prossim[oa]\b/);

  if (explicitDate) {
    const day = Number(explicitDate[1]);
    const month = months[explicitDate[2]];
    let year = explicitDate[3] ? Number(explicitDate[3]) : today.year;
    const candidate = new Date(Date.UTC(year, month, day));
    if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) {
      return { start: toRomeBoundaryIso(start, timezone), end: toRomeBoundaryIso(new Date(start.getTime() + 86_400_000), timezone), label: "oggi" };
    }
    if (!explicitDate[3] && candidate.getTime() < start.getTime()) {
      year += 1;
      start = new Date(Date.UTC(year, month, day));
    } else {
      start = candidate;
    }
    label = `il ${day} ${explicitDate[2]} ${year}`;
  } else if (value.includes("dopodomani")) {
    start.setUTCDate(start.getUTCDate() + 2);
    label = "dopodomani";
  } else if (value.includes("domani")) {
    start.setUTCDate(start.getUTCDate() + 1);
    label = "domani";
  } else if (weekdayMatch) {
    const target = weekdays[weekdayMatch[1]];
    const currentDay = start.getUTCDay() || 7;
    let delta = target.day - currentDay;
    if (delta <= 0) delta += 7;
    start.setUTCDate(start.getUTCDate() + delta);
    label = target.label;
  } else if (value.includes("settimana")) {
    const dayOfWeek = start.getUTCDay() || 7;
    if (value.includes("prossima")) start.setUTCDate(start.getUTCDate() + (8 - dayOfWeek));
    else start.setUTCDate(start.getUTCDate() - (dayOfWeek - 1));
    days = 7;
    label = value.includes("prossima") ? "la prossima settimana" : "questa settimana";
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);
  return {
    start: toRomeBoundaryIso(start, timezone),
    end: toRomeBoundaryIso(end, timezone),
    label,
  };
}

function getRomeDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (name: string) => Number(parts.find((part) => part.type === name)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function toRomeBoundaryIso(date: Date, timezone: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const probe = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate(), 12));
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(probe).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offset = offsetPart.replace("GMT", "") || "+00:00";
  return `${year}-${month}-${day}T00:00:00${offset}`;
}

async function listGoogleCalendarEvents(env: Env, timeMin: string, timeMax: string): Promise<GoogleCalendarEvent[] | null> {
  try {
    const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + "/calendar/events";
    const url = new URL(endpoint);
    url.searchParams.set("start", timeMin);
    url.searchParams.set("end", timeMax);
    const response = await fetch(url.toString(), { headers: { "x-agent-key": env.AGENT_KEY } });
    const raw = await response.text();
    if (!response.ok) {
      console.error("[GCAL] Lettura eventi fallita:", response.status, raw);
      return null;
    }
    const data = JSON.parse(raw) as { events?: GoogleCalendarEvent[] };
    return data.events || [];
  } catch (error) {
    console.error("[GCAL] Errore lettura:", error);
    return null;
  }
}

function formatGoogleCalendarEvents(events: GoogleCalendarEvent[], label: string, timezone: string): string {
  if (!events.length) return `Nessun appuntamento in calendario per ${label}.`;
  const lines = events.slice(0, 10).map((event) => {
    const start = event.start?.dateTime || event.start?.date;
    const when = event.start?.date
      ? "Tutto il giorno"
      : start
        ? new Date(start).toLocaleTimeString("it-IT", { timeZone: timezone, hour: "2-digit", minute: "2-digit" })
        : "Orario non disponibile";
    return `- ${when} - ${event.summary || "Senza titolo"}${event.location ? ` (${event.location})` : ""}`;
  });
  const more = events.length > 10 ? `\n…e altri ${events.length - 10}.` : "";
  return `Calendario ${label}:\n${lines.join("\n")}${more}`;
}

async function parseCalendarEvent(env: Env, text: string): Promise<CalendarEventDraft> {
  const now = new Date().toISOString();
  const timezone = env.TIMEZONE || "Europe/Rome";
  const system = `Estrai un evento Google Calendar da un messaggio italiano.
Oggi/ora corrente: ${now}
Timezone obbligatoria: ${timezone}
Regole:
- per calendar_create, start_at/end_at sono la data dell'evento da creare
- se manca durata, end_at = start_at + 60 minuti
- se l'utente dice "tutto il giorno", all_day=true
- se manca orario ma dice mattina=09:00, pomeriggio=16:00, sera=20:00
- se manca un dato essenziale, metti null
Rispondi SOLO JSON valido:
{"intent":"calendar_create|unknown","title":"string|null","description":"string|null","location":"string|null","start_at":"ISO datetime|null","end_at":"ISO datetime|null","all_day":false,"confidence":0.0}`;

  try {
    const out = await askClaudeJSON(env, system, text);
    const parsed = JSON.parse(cleanJson(out)) as Partial<CalendarEventDraft>;
    return {
      intent: parsed.intent === "calendar_create" ? "calendar_create" : "unknown",
      title: typeof parsed.title === "string" ? parsed.title : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      location: typeof parsed.location === "string" ? parsed.location : null,
      start_at: typeof parsed.start_at === "string" ? parsed.start_at : null,
      end_at: typeof parsed.end_at === "string" ? parsed.end_at : null,
      all_day: Boolean(parsed.all_day),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch (error) {
    console.error("[GCAL] Parse evento fallito:", error);
    return { intent: "unknown", title: null, description: null, location: null, start_at: null, end_at: null, all_day: false, confidence: 0 };
  }
}

async function parseCalendarMutation(env: Env, text: string): Promise<CalendarMutationDraft> {
  const now = new Date();
  const timezone = env.TIMEZONE || "Europe/Rome";
  const defaultStart = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const defaultEnd = new Date(now.getTime() + 366 * 86_400_000).toISOString();
  const system = `Interpreta una richiesta italiana di modifica o cancellazione di un evento Google Calendar.
Ora corrente: ${now.toISOString()}. Timezone: ${timezone}.
Regole:
- query è il testo distintivo del titolo dell'evento esistente, senza parole operative e senza data/orario
- search_start/search_end delimitano il periodo in cui cercare l'evento esistente; per una data specifica usa l'intera giornata locale
- se il periodo dell'evento esistente non è indicato usa ${defaultStart} e ${defaultEnd}
- calendar_update: valorizza SOLO i nuovi valori esplicitamente richiesti; title non è il titolo attuale ma l'eventuale nuovo titolo
- per uno spostamento, start_at è il nuovo inizio ed end_at la nuova fine; se manca la durata end_at può essere null
- calendar_delete non deve valorizzare i campi di modifica
- non inventare dati mancanti
Rispondi SOLO JSON valido:
{"intent":"calendar_update|calendar_delete|unknown","query":"string|null","search_start":"ISO datetime|null","search_end":"ISO datetime|null","title":"string|null","start_at":"ISO datetime|null","end_at":"ISO datetime|null","location":"string|null","description":"string|null","all_day":false,"confidence":0.0}`;
  try {
    const out = await askClaudeJSON(env, system, text);
    const parsed = JSON.parse(cleanJson(out)) as Partial<CalendarMutationDraft>;
    return {
      intent: parsed.intent === "calendar_update" || parsed.intent === "calendar_delete" ? parsed.intent : "unknown",
      query: typeof parsed.query === "string" ? parsed.query : null,
      search_start: typeof parsed.search_start === "string" ? parsed.search_start : null,
      search_end: typeof parsed.search_end === "string" ? parsed.search_end : null,
      title: typeof parsed.title === "string" ? parsed.title : null,
      start_at: typeof parsed.start_at === "string" ? parsed.start_at : null,
      end_at: typeof parsed.end_at === "string" ? parsed.end_at : null,
      location: typeof parsed.location === "string" ? parsed.location : null,
      description: typeof parsed.description === "string" ? parsed.description : null,
      all_day: Boolean(parsed.all_day),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    };
  } catch (error) {
    console.error("[GCAL] Parse modifica/cancellazione fallito:", error);
    return { intent: "unknown", query: null, search_start: null, search_end: null, title: null, start_at: null, end_at: null, location: null, description: null, all_day: false, confidence: 0 };
  }
}

function cleanJson(text: string): string {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

function addMinutesIso(value: string, minutes: number): string {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() + minutes);
  return date.toISOString();
}

function formatCalendarDate(value: string, allDay?: boolean): string {
  const date = new Date(value);
  return allDay
    ? date.toLocaleDateString("it-IT", { timeZone: "Europe/Rome", dateStyle: "full" })
    : date.toLocaleString("it-IT", { timeZone: "Europe/Rome", dateStyle: "full", timeStyle: "short" });
}

// ===== Fase 1: signal bus + digest mattutino =====

// ===== Arretrati: schede lavoro Firestore =====

const WORK_NOTES_UID = "nL8Wwa2SktYjLeEHS51AZyFGEMD3";
const ARRETRATI_STREAK_KEY = "arretrati:state"; // unica chiave: evita un read/write KV per scheda
const ARRETRATI_REGULARIZE_INPUT_KEY = "arretrati:regularize-input";
const DAY_MS = 24 * 60 * 60 * 1000;

export const ARRETRATI_THRESHOLDS = {
  servizio_svolto: { attention: 45, critical: 60 },
  galleria_inviata: { attention: 7, critical: 14 },
  cliente_risposto: { attention: 5, critical: 10 },
  modifiche_fatte: { attention: 7, critical: 14 },
  album_confermato: { attention: 5, critical: 10 },
  in_stampa: { attention: 15, critical: 25 },
} as const;
type WorkEventType = keyof typeof ARRETRATI_THRESHOLDS | "consegnato" | "sospeso_cliente";
type WorkNote = { id: string; title: string; text: string; historyUpdatedAt: number | null; updatedAt: number | null; createdAt: number | null };
type WorkCandidate = WorkNote & { event: WorkEventType; eventAt: number; days: number; score: number; attention: number; detail: string };
type LegacyAuditCandidate = WorkNote & { lastModifiedAt: number; auditReason: "nessun evento" | "solo Stato legacy" };
type ArretratiState = { streaks: Record<string, { date: string; count: number }>; regularizeIndex: number };

function hasTag(text: string, tag: string): boolean { return new RegExp(`(^|\\s)${tag}(?=\\s|$)`, "i").test(text); }
function priorityMultiplier(text: string): number {
  if (hasTag(text, "#obbligatorio")) return 4;
  if (hasTag(text, "#importante")) return 2;
  if (hasTag(text, "#dasistemare")) return 1.5;
  if (hasTag(text, "#quandohotempo")) return 0.5;
  return 1;
}
function noteTitle(text: string, fallback: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#") && !line.includes("📌 Storico"))?.replace(/^#+\s*/, "") ?? fallback;
}
function firestoreTimestamp(value: unknown): number | null {
  if (typeof value === "string") { const date = Date.parse(value); return Number.isFinite(date) ? date : null; }
  if (isRecord(value)) { const seconds = asNumber(value.seconds); return seconds === null ? null : seconds * 1000; }
  return null;
}
function parseLatestHistory(text: string): { event: WorkEventType; at: number | null; detail: string } | null {
  const section = text.indexOf("📌 Storico");
  if (section < 0) return null;
  const line = text.slice(section + "📌 Storico".length).split("\n").map((item) => item.trim()).find((item) => /^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*[·•]/.test(item));
  if (!line) return null;
  const match = line.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*[·•]\s*([a-z_]+)(?:\s*[·•]\s*(.*))?$/i);
  if (!match) return null;
  const event = match[5] as WorkEventType;
  if (!(event in ARRETRATI_THRESHOLDS) && event !== "consegnato" && event !== "sospeso_cliente") return null;
  const now = new Date();
  let at = new Date(now.getFullYear(), Number(match[2]) - 1, Number(match[1]), Number(match[3]), Number(match[4])).getTime();
  if (at > Date.now() + DAY_MS) at = new Date(now.getFullYear() - 1, Number(match[2]) - 1, Number(match[1]), Number(match[3]), Number(match[4])).getTime();
  return { event, at, detail: match[6]?.trim() ?? "" };
}
function nextEvent(event: WorkEventType): { event: WorkEventType; label: string; step: string } | null {
  const map: Partial<Record<WorkEventType, { event: WorkEventType; label: string; step: string }>> = {
    servizio_svolto: { event: "galleria_inviata", label: "📤 Galleria inviata", step: "inviare la galleria" },
    galleria_inviata: { event: "cliente_risposto", label: "✅ Cliente ha risposto", step: "sollecitare risposta cliente" },
    cliente_risposto: { event: "modifiche_fatte", label: "✅ Modifiche fatte", step: "chiudere le modifiche" },
    modifiche_fatte: { event: "album_confermato", label: "✅ Album confermato", step: "ottenere conferma album" },
    album_confermato: { event: "in_stampa", label: "🖨️ Mandato in stampa", step: "mandare in stampa" },
    in_stampa: { event: "consegnato", label: "✅ Consegnato", step: "verificare e consegnare" },
  };
  return map[event] ?? null;
}
async function listArretratiNotes(env: Env): Promise<{ notes: WorkNote[]; reads: number }> {
  const token = await getFirestoreAccessToken(env);
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:runQuery`, {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: "notes" }], where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: WORK_NOTES_UID } } }, limit: 500 } }),
  });
  if (!response.ok) throw new Error(`Firestore notes query ${response.status}: ${await response.text()}`);
  const rows = await response.json() as unknown[];
  const notes = (Array.isArray(rows) ? rows : []).map((row) => asRecord(asRecord(row).document)).filter((document) => Object.keys(document).length).map((document) => {
    const fields = asRecord(document.fields); const text = asString(fromFirestoreValue(fields.text)) ?? "";
    return { id: firestoreDocumentId(asString(document.name) ?? ""), title: noteTitle(text, "Scheda senza titolo"), text, historyUpdatedAt: firestoreTimestamp(fromFirestoreValue(fields.historyUpdatedAt)), updatedAt: firestoreTimestamp(document.updateTime) ?? firestoreTimestamp(fromFirestoreValue(fields.updatedAt)), createdAt: firestoreTimestamp(fromFirestoreValue(fields.createdAt)) };
  }).filter((note) => Boolean(note.id));
  return { notes, reads: notes.length };
}
// Fonte unica per digest e /Lavori. Non aggiorna KV: il chiamante decide se la lettura è passiva o il cron.
async function getArretratiRanking(env: Env): Promise<{ notes: WorkNote[]; reads: number; ranking: WorkCandidate[] }> {
  const { notes, reads } = await listArretratiNotes(env);
  const now = Date.now();
  const ranking = notes.map((note): WorkCandidate | null => {
    if (hasTag(note.text, "#sospeso") || hasTag(note.text, "#daregolarizzare")) return null;
    const history = parseLatestHistory(note.text);
    if (!history || history.event === "consegnato" || history.event === "sospeso_cliente" || !(history.event in ARRETRATI_THRESHOLDS)) return null;
    const eventAt = note.historyUpdatedAt ?? history.at;
    if (!eventAt) return null;
    const days = Math.max(0, Math.floor((now - eventAt) / DAY_MS));
    const attention = ARRETRATI_THRESHOLDS[history.event as keyof typeof ARRETRATI_THRESHOLDS].attention;
    return { ...note, event: history.event, eventAt, days, attention, score: Math.min(days / attention * priorityMultiplier(note.text), 3), detail: history.detail };
  }).filter((item): item is WorkCandidate => item !== null)
    .filter((item) => item.score >= 1)
    .sort((a, b) => b.score - a.score || b.days - a.days);
  return { notes, reads, ranking };
}
function formatArretratiRanking(ranking: WorkCandidate[]): string {
  if (!ranking.length) return "📋 LAVORI\n\nNessun arretrato oltre la soglia di attenzione.";
  return ["📋 LAVORI", "", ...ranking.slice(0, 5).map((item, index) => {
    const step = nextEvent(item.event)?.step ?? "verificare";
    return `${index + 1}. ${item.title}\n   ${item.event} da ${item.days}gg · soglia ${item.attention}gg · score ${item.score.toFixed(1)}\n   Prossimo passo: ${step}`;
  })].join("\n");
}
const LEGACY_AUDIT_STALE_DAYS = 60;
function isLegacyWorkCard(note: WorkNote): boolean {
  // Stato è il segnale più affidabile delle schede pre-Storico; il titolo copre le vecchie schede senza Stato.
  return /📌\s*Stato\s*:/i.test(note.text) || /\b(matrimonio|battesimo)\b/i.test(note.title);
}
async function getLegacyAuditCandidates(env: Env): Promise<LegacyAuditCandidate[]> {
  const { notes } = await listArretratiNotes(env); const staleBefore = Date.now() - LEGACY_AUDIT_STALE_DAYS * DAY_MS;
  return notes.map((note): LegacyAuditCandidate | null => {
    if (!isLegacyWorkCard(note) || hasTag(note.text, "#daregolarizzare")) return null;
    const history = parseLatestHistory(note.text); if (history) return null;
    const lastModifiedAt = note.updatedAt ?? note.createdAt; if (!lastModifiedAt || lastModifiedAt > staleBefore) return null;
    return { ...note, lastModifiedAt, auditReason: /📌\s*Stato\s*:/i.test(note.text) ? "solo Stato legacy" : "nessun evento" };
  }).filter((note): note is LegacyAuditCandidate => note !== null).sort((left, right) => left.lastModifiedAt - right.lastModifiedAt);
}
function formatAuditDate(timestamp: number): string { return new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Rome" }).format(new Date(timestamp)); }
async function batchAddRegularizeTag(env: Env, notes: Array<{ id: string; title: string; text: string }>): Promise<number> {
  const updates = notes.filter((note) => note.id && !hasTag(note.text, "#daregolarizzare")).slice(0, 500);
  if (!updates.length) return 0;
  const token = await getFirestoreAccessToken(env);
  const writes = updates.map((note) => ({ update: { name: `projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/notes/${note.id}`, fields: { text: firestoreValue(`${note.text.trim()} #daregolarizzare`) } }, updateMask: { fieldPaths: ["text"] } }));
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents:batchWrite`, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ writes }) });
  if (!response.ok) throw new Error(`Firestore audit batch ${response.status}: ${await response.text()}`);
  const statuses = asRecord(await response.json()).status;
  if (Array.isArray(statuses) && statuses.some((status) => (asNumber(asRecord(status).code) ?? 0) !== 0)) throw new Error("Firestore audit batch con scritture fallite");
  return updates.length;
}
async function loadArretratiState(env: Env): Promise<ArretratiState> {
  try { const parsed = JSON.parse(await env.SAVERIO_KV.get(ARRETRATI_STREAK_KEY) ?? "{}"); return { streaks: isRecord(parsed.streaks) ? parsed.streaks as ArretratiState["streaks"] : {}, regularizeIndex: asNumber(parsed.regularizeIndex) ?? 0 }; }
  catch { return { streaks: {}, regularizeIndex: 0 }; }
}
async function saveArretratiState(env: Env, state: ArretratiState): Promise<void> { await env.SAVERIO_KV.put(ARRETRATI_STREAK_KEY, JSON.stringify(state)); }
async function incrementArretratiReadTelemetry(env: Env, reads: number): Promise<void> {
  const key = `arretrati:telemetry:${new Date().toISOString().slice(0, 7)}`; const raw = await env.SAVERIO_KV.get(key);
  const current = raw ? asNumber(JSON.parse(raw).firestoreReads) ?? 0 : 0; await env.SAVERIO_KV.put(key, JSON.stringify({ firestoreReads: current + reads }));
}
function formatRegularize(note: WorkNote): string { const status = note.text.match(/📌\s*Stato:\s*([^\n]+)/i)?.[1]?.trim(); return `Da regolarizzare: ${note.title} — nessuno Storico${status ? `, solo Stato: ${status}` : ""}. Quando l'hai iniziato?`; }
async function appendWorkHistory(env: Env, params: { noteId: string; event: WorkEventType; detail: string; occurredAt?: string }): Promise<void> {
  if (!env.BLOCNOTES_AI_URL) throw new Error("BLOCNOTES_AI_URL mancante");
  const response = await fetch(env.BLOCNOTES_AI_URL.replace(/\/$/, "") + "/append-history", { method: "POST", headers: { "content-type": "application/json", "x-agent-key": env.AGENT_KEY }, body: JSON.stringify(params) });
  if (!response.ok) throw new Error(`append-history ${response.status}: ${await response.text()}`);
}
async function setWorkNoteTag(env: Env, note: WorkNote, tag: string, present: boolean): Promise<void> {
  const text = present ? (hasTag(note.text, tag) ? note.text : `${note.text.trim()} ${tag}`) : note.text.replace(new RegExp(`(^|\\s)${tag}(?=\\s|$)`, "ig"), "$1").replace(/[ \t]+\n/g, "\n");
  await patchFirestoreDocument(env, `notes/${note.id}`, { text });
}
function inferWorkEvent(text: string): WorkEventType {
  const normalized = text.toLowerCase();
  if (normalized.includes("galleria")) return "galleria_inviata";
  if (normalized.includes("rispost")) return "cliente_risposto";
  if (normalized.includes("modific")) return "modifiche_fatte";
  if (normalized.includes("album")) return "album_confermato";
  if (normalized.includes("stamp")) return "in_stampa";
  if (normalized.includes("consegn")) return "consegnato";
  return "servizio_svolto";
}
async function handleRegularizeInput(env: Env, chatId: number, text: string): Promise<string | null> {
  if (chatId !== OWNER_CHAT_ID) return null;
  const raw = await env.SAVERIO_KV.get(ARRETRATI_REGULARIZE_INPUT_KEY); if (!raw) return null;
  let pending: { noteId?: string; title?: string; text?: string }; try { pending = JSON.parse(raw); } catch { await env.SAVERIO_KV.delete(ARRETRATI_REGULARIZE_INPUT_KEY); return null; }
  if (!pending.noteId || !pending.text) return null;
  const dateMatch = text.match(/\b(\d{1,2}\/\d{1,2})(?:\/(\d{2,4}))?\b/); let occurredAt: string | undefined;
  if (dateMatch) { const [day, month] = dateMatch[1].split("/"); const year = dateMatch[2] ? Number(dateMatch[2].length === 2 ? `20${dateMatch[2]}` : dateMatch[2]) : new Date().getFullYear(); occurredAt = new Date(year, Number(month) - 1, Number(day), 12).toISOString(); }
  await appendWorkHistory(env, { noteId: pending.noteId, event: inferWorkEvent(text), detail: text, ...(occurredAt ? { occurredAt } : {}) });
  await setWorkNoteTag(env, { id: pending.noteId, title: pending.title ?? "Scheda", text: pending.text, historyUpdatedAt: null, updatedAt: null, createdAt: null }, "#daregolarizzare", false);
  await env.SAVERIO_KV.delete(ARRETRATI_REGULARIZE_INPUT_KEY);
  return "Perfetto: primo evento registrato e scheda rimessa nel flusso normale.";
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RawRecord = Record<string, unknown>;

type Signal = {
  documentPath: string;
  source: string;
  type: string;
  payload: JsonValue;
  summary: string;
  urgency: string;
  createdAt: string | null;
};
type DigestResult = { text: string; quoteRequests: Array<{ messageId: string; title: string }> };

const DIGEST_SYSTEM_PROMPT = "Sei Saverio, chief of staff di Mariano. Ricevi: segnali dai sistemi di\n"
  + "monitoraggio (competitor Instagram, bandi pubblici), agenda di oggi e task aperti con\n"
  + "eventuali scadenze. Produci un digest mattutino in italiano, asciutto,\n"
  + "max 12 righe, ordinato per urgenza. Raggruppa per tema. Niente\n"
  + "convenevoli. Se non c'è NULLA che meriti attenzione oggi (nessun\n"
  + "segnale, nessuna scadenza entro 7 giorni), usa text=SILENZIO. Per le\n"
  + "email mostra solo richiede azione o da leggere; ignora newsletter, promo\n"
  + "e messaggi irrilevanti. Per ogni preventivo che richiede azione, aggiungi\n"
  + "messageId e un titolo task in quoteRequests. Rispondi SOLO JSON valido:\n"
  + "{\"text\":\"digest max 12 righe o SILENZIO\",\"quoteRequests\":[{\"messageId\":\"...\",\"title\":\"...\"}]}.";

async function runMorningDigest(env: Env): Promise<void> {
  try {
    await ingestRecentEmailsAsSignals(env);
    const signals = await getUnseenSignals(env);
    const [tasks, agenda] = await Promise.all([
      fetchOpenTasksForDigest(env),
      fetchTodayCalendarForDigest(env),
    ]);
    const digest = await createMorningDigest(env, signals, tasks, agenda);

    if (digest.text === "SILENZIO") {
      await markSignalsSeen(env, signals);
      await runArretratiDigest(env);
      await runChiefFollowupsDigest(env);
      console.log("[FASE-1] Digest silenzioso; " + signals.length + " segnali marcati come visti.");
      return;
    }

    // I segnali vengono marcati solo dopo che Telegram ha confermato l'invio.
    await sendMessage(env, OWNER_CHAT_ID, digest.text);
    for (const quoteRequest of digest.quoteRequests) {
      const pending = await createPendingAction(env, OWNER_CHAT_ID, "task-open", {
        titolo: quoteRequest.title,
        urgente: true,
        messageId: quoteRequest.messageId,
      });
      await sendMessage(
        env,
        OWNER_CHAT_ID,
        `Email preventivo: ${quoteRequest.title}`,
        { inlineKeyboard: [[{ text: "✅ Apri task", callback_data: pending.approveData }, { text: "❌ Ignora", callback_data: pending.rejectData }]] },
      );
    }
    await markSignalsSeen(env, signals);
    await runArretratiDigest(env);
    await runChiefFollowupsDigest(env);
    console.log("[FASE-1] Digest inviato; " + signals.length + " segnali marcati come visti.");
  } catch (error) {
    // In caso di errore non marchiamo nulla: il segnale rientra nel prossimo digest.
    console.error("[FASE-1] Digest mattutino fallito:", error);
  }
}

type ChiefFollowup = { title: string; azione: string; scadenza: string | null; score: number };

async function runChiefFollowupsDigest(env: Env): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + "/chief/oggi";
    const response = await fetch(endpoint, { headers: { "x-agent-key": env.AGENT_KEY }, signal: controller.signal });
    if (!response.ok) throw new Error(`chief/oggi ${response.status}`);
    const body = asRecord(await response.json());
    const followups = (Array.isArray(body.openFollowups) ? body.openFollowups : []).filter(isRecord).map((item): ChiefFollowup | null => {
      const title = asString(item.title); const azione = asString(item.azione);
      if (!title || !azione) return null;
      return { title, azione, scadenza: asString(item.scadenza), score: asNumber(item.score) ?? 0 };
    }).filter((item): item is ChiefFollowup => item !== null);
    const lines = ["📋 Altri lavori fermi (da Chief)", "", ...(followups.length ? followups.slice(0, 5).map((item, index) => `${index + 1}. ${item.azione}${item.scadenza ? ` — scadenza ${item.scadenza}` : ""}`) : ["Nessun follow-up Chief aperto."])];
    await sendMessage(env, OWNER_CHAT_ID, lines.join("\n"));
  } catch (error) {
    console.error("[CHIEF] Follow-up digest non disponibile:", error);
    await sendMessage(env, OWNER_CHAT_ID, "📋 Altri lavori fermi (da Chief)\n\nFollow-up Chief non disponibile.");
  } finally {
    clearTimeout(timeout);
  }
}

async function runArretratiDigest(env: Env): Promise<void> {
  try {
    const { notes, reads, ranking: candidates } = await getArretratiRanking(env);
    await incrementArretratiReadTelemetry(env, reads);
    const now = Date.now(); const state = await loadArretratiState(env);
    const regularize = notes.filter((note) => hasTag(note.text, "#daregolarizzare"));
    const today = new Date().toISOString().slice(0, 10); let primary = candidates[0]; let skipped = false;
    if (primary) { const previous = state.streaks[primary.id]; const count = previous?.date === today ? previous.count : (previous?.date === new Date(now - DAY_MS).toISOString().slice(0, 10) ? previous.count + 1 : 1); state.streaks[primary.id] = { date: today, count }; skipped = count >= 4; if (skipped) primary = candidates[1]; }
    for (const id of Object.keys(state.streaks)) if (!candidates.some((candidate) => candidate.id === id)) delete state.streaks[id];
    await saveArretratiState(env, state);
    if (skipped && candidates[0]) {
      const note = candidates[0]; const suspend = await createPendingAction(env, OWNER_CHAT_ID, "arretrati-suspend", { noteId: note.id, text: note.text, title: note.title });
      const retry = await createPendingAction(env, OWNER_CHAT_ID, "arretrati-retry", { noteId: note.id });
      await sendMessage(env, OWNER_CHAT_ID, `${note.title} resta il più urgente ma lo salto: è la 4ª volta che te lo propongo.\nVuoi sospenderlo?`, { inlineKeyboard: [[{ text: "⏸️ Sì, sospendi", callback_data: suspend.approveData }, { text: "🔁 No, riproponimelo", callback_data: retry.approveData }]] });
    }
    if (primary) {
      const next = nextEvent(primary.event); if (next) {
        const action = await createPendingAction(env, OWNER_CHAT_ID, "arretrati-log-event", { noteId: primary.id, event: next.event, title: primary.title });
        const suspend = await createPendingAction(env, OWNER_CHAT_ID, "arretrati-suspend", { noteId: primary.id, text: primary.text, title: primary.title });
        const done = await createPendingAction(env, OWNER_CHAT_ID, "arretrati-log-event", { noteId: primary.id, event: next.event, title: primary.title, detail: "recuperato da digest" });
        const secondary = candidates.find((candidate) => candidate.id !== primary!.id);
        const text = ["⚠️ ARRETRATI", "", `Oggi recupera: ${primary.title}`, `Fermo da ${primary.days}gg su "${primary.event}" (soglia ${primary.attention}gg · score ${primary.score.toFixed(1)})`, `Prossimo passo: ${next.step}`, secondary ? "" : "", secondary ? `Se hai 10 minuti: ${secondary.title} — ${secondary.event} da ${secondary.days}gg, ${nextEvent(secondary.event)?.step ?? "verificare"}` : ""].filter(Boolean).join("\n");
        await sendMessage(env, OWNER_CHAT_ID, text, { inlineKeyboard: [[{ text: next.label, callback_data: action.approveData }, { text: "⏸️ Sospendi", callback_data: suspend.approveData }, { text: "✔️ Già fatto", callback_data: done.approveData }]] });
      }
    }
    if (regularize.length) { const note = regularize[state.regularizeIndex % regularize.length]; state.regularizeIndex = (state.regularizeIndex + 1) % regularize.length; await saveArretratiState(env, state); await env.SAVERIO_KV.put(ARRETRATI_REGULARIZE_INPUT_KEY, JSON.stringify({ noteId: note.id, title: note.title, text: note.text }), { expirationTtl: DAY_MS / 1000 }); await sendMessage(env, OWNER_CHAT_ID, formatRegularize(note)); }
    const suspended = notes.filter((note) => hasTag(note.text, "#sospeso")).map((note) => {
      const history = parseLatestHistory(note.text); const days = history?.event === "sospeso_cliente" && history.at ? Math.floor((now - history.at) / DAY_MS) : -1;
      return { note, days };
    }).filter((item) => item.days > 30).sort((a, b) => b.days - a.days);
    if (suspended.length) await sendMessage(env, OWNER_CHAT_ID, `⏸️ ${suspended.length} lavori in pausa da oltre 30gg: ${suspended.map(({ note, days }) => `${note.title} (${days}gg)`).join(", ")}`);
  } catch (error) { console.error("[ARRETRATI] Digest fallito:", error); }
}

async function fetchOpenTasksForDigest(env: Env): Promise<JsonValue[]> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(env.TASK_URL + "/open", {
        headers: { "x-agent-key": env.AGENT_KEY },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("task/open error: " + response.status);
      const body = asRecord(await response.json());
      const tasks = body.tasks;
      if (!Array.isArray(tasks)) throw new Error("task/open risposta senza array tasks");
      return tasks.map(toJsonValue);
    } catch (error) {
      lastError = error;
      console.error("[FASE-1] task/open fallito (tentativo " + attempt + "/2):", error);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("task/open non disponibile");
}

async function createMorningDigest(
  env: Env,
  signals: Signal[],
  tasks: JsonValue[],
  agenda: JsonValue[],
): Promise<DigestResult> {
  const userPayload = JSON.stringify({
    signals: signals.map(({ documentPath: _documentPath, ...signal }) => signal),
    tasks,
    agenda,
  });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: DIGEST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPayload }],
      }),
    });
    if (!response.ok) throw new Error("Claude digest error: " + response.status + " " + await response.text());
    const data = asRecord(await response.json());
    const content = Array.isArray(data.content) ? data.content : [];
    const text = content
      .filter(isRecord)
      .filter((block) => block.type === "text")
      .map((block) => asString(block.text) ?? "")
      .join("\n")
      .trim();
    const parsed = parseJsonRecord(text);
    if (!parsed) throw new Error("Claude digest senza JSON valido");
    const digestText = asString(parsed.text)?.trim();
    if (!digestText) throw new Error("Claude digest senza testo");
    const quoteRequests = Array.isArray(parsed.quoteRequests) ? parsed.quoteRequests.filter(isRecord).map((request) => ({
      messageId: asString(request.messageId) ?? "",
      title: asString(request.title) ?? "",
    })).filter((request) => request.messageId && request.title) : [];
    return { text: digestText, quoteRequests };
  } catch (error) {
    console.error("[FASE-1] Claude digest fallito:", error);
    throw error;
  }
}

async function fetchTodayCalendarForDigest(env: Env): Promise<JsonValue[]> {
  const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + "/calendar/today";
  try {
    const response = await fetch(endpoint, { headers: { "x-agent-key": env.AGENT_KEY } });
    if (!response.ok) throw new Error(`calendar/today ${response.status}`);
    const events = asRecord(await response.json()).events;
    if (!Array.isArray(events)) throw new Error("calendar/today risposta senza events");
    return events.map(toJsonValue);
  } catch (error) {
    console.error("[FASE-4] Calendar today fallito:", error);
    return [];
  }
}

async function ingestRecentEmailsAsSignals(env: Env): Promise<void> {
  const endpoint = env.TASK_URL.replace(/\/task\/?$/i, "") + "/email/scan?hours=24";
  try {
    const response = await fetch(endpoint, { headers: { "x-agent-key": env.AGENT_KEY } });
    if (!response.ok) throw new Error(`email/scan ${response.status}`);
    const emails = asRecord(await response.json()).emails;
    if (!Array.isArray(emails)) throw new Error("email/scan risposta senza emails");
    for (const rawEmail of emails.filter(isRecord).slice(0, 30)) {
      const id = asString(rawEmail.id);
      if (!id || await env.SAVERIO_KV.get(`email-seen:${id}`)) continue;
      await createEmailSignal(env, rawEmail);
      await env.SAVERIO_KV.put(`email-seen:${id}`, "1", { expirationTtl: 60 * 60 * 24 * 7 });
    }
  } catch (error) {
    console.error("[FASE-4] Email scan fallito:", error);
  }
}

async function createEmailSignal(env: Env, email: RawRecord): Promise<void> {
  const token = await getFirestoreAccessToken(env);
  const from = asString(email.from) ?? "mittente sconosciuto";
  const subject = asString(email.subject) ?? "(senza oggetto)";
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/signals`,
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ fields: {
        source: { stringValue: "email-scan" },
        type: { stringValue: "email" },
        summary: { stringValue: `Email da ${from}: ${subject}` },
        urgency: { stringValue: "da-classificare" },
        payload: firestoreValue(toJsonValue(email)),
        seen: { booleanValue: false },
        createdAt: { timestampValue: new Date().toISOString() },
      } }),
    },
  );
  if (!response.ok) throw new Error(`Firestore email signal ${response.status}: ${await response.text()}`);
}

async function getUnseenSignals(env: Env): Promise<Signal[]> {
  const token = await getFirestoreAccessToken(env);
  try {
    const response = await fetch(
      "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents:runQuery",
      {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "signals" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "seen" },
                op: "EQUAL",
                value: { booleanValue: false },
              },
            },
            orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
            limit: 50,
          },
        }),
      },
    );
    if (!response.ok) throw new Error("Firestore query error: " + response.status + " " + await response.text());
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw new Error("Firestore runQuery risposta non valida");
    return rows
      .filter(isRecord)
      .map((row) => asRecord(row.document))
      .filter((document) => Object.keys(document).length > 0)
      .map(parseSignalDocument)
      .filter((signal): signal is Signal => signal !== null);
  } catch (error) {
    console.error("[FASE-1] Lettura Firestore signals fallita:", error);
    throw error;
  }
}

function parseSignalDocument(document: RawRecord): Signal | null {
  const documentName = asString(document.name);
  const prefix = "projects/" + FIRESTORE_PROJECT_ID + "/databases/(default)/documents/";
  if (!documentName?.startsWith(prefix)) return null;
  const fields = asRecord(document.fields);
  const source = asString(fromFirestoreValue(fields.source));
  const type = asString(fromFirestoreValue(fields.type));
  const summary = asString(fromFirestoreValue(fields.summary));
  const urgency = asString(fromFirestoreValue(fields.urgency));
  if (!source || !type || !summary || !urgency) return null;
  return {
    documentPath: documentName.slice(prefix.length),
    source,
    type,
    payload: toJsonValue(fromFirestoreValue(fields.payload)),
    summary,
    urgency,
    createdAt: asString(fromFirestoreValue(fields.createdAt)),
  };
}

async function markSignalsSeen(env: Env, signals: Signal[]): Promise<void> {
  for (const signal of signals) {
    const token = await getFirestoreAccessToken(env);
    try {
      const response = await fetch(
        "https://firestore.googleapis.com/v1/projects/" + FIRESTORE_PROJECT_ID
          + "/databases/(default)/documents/" + signal.documentPath + "?updateMask.fieldPaths=seen",
        {
          method: "PATCH",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ fields: { seen: { booleanValue: true } } }),
        },
      );
      if (!response.ok) throw new Error("Firestore update error: " + response.status + " " + await response.text());
    } catch (error) {
      console.error("[FASE-1] Marcatura seen fallita per " + signal.documentPath + ":", error);
      throw error;
    }
  }
}

type ServiceAccount = { client_email: string; private_key: string };

async function getFirestoreAccessToken(env: Env): Promise<string> {
  if (firestoreAccessToken && firestoreAccessToken.expiresAt > Date.now() + 60_000) {
    return firestoreAccessToken.token;
  }
  try {
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("secret GOOGLE_SERVICE_ACCOUNT_JSON mancante");
    const serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as Partial<ServiceAccount>;
    if (!serviceAccount.client_email || !serviceAccount.private_key) throw new Error("service account non valido");
    const now = Math.floor(Date.now() / 1000);
    const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const encodedClaims = base64Url(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: FIRESTORE_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }));
    const unsignedToken = encodedHeader + "." + encodedClaims;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(serviceAccount.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsignedToken));
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: unsignedToken + "." + base64Url(signature),
      }),
    });
    if (!response.ok) throw new Error("OAuth error: " + response.status + " " + await response.text());
    const body = asRecord(await response.json());
    const token = asString(body.access_token);
    const expiresIn = asNumber(body.expires_in) ?? 3600;
    if (!token) throw new Error("OAuth senza access token");
    firestoreAccessToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
    return token;
  } catch (error) {
    console.error("[FASE-1] Autenticazione Firestore fallita:", error);
    throw error;
  }
}

function fromFirestoreValue(value: unknown): unknown {
  const record = asRecord(value);
  if ("nullValue" in record) return null;
  if (typeof record.stringValue === "string") return record.stringValue;
  if (typeof record.booleanValue === "boolean") return record.booleanValue;
  if (typeof record.integerValue === "string") return Number(record.integerValue);
  if (typeof record.doubleValue === "number") return record.doubleValue;
  if (typeof record.timestampValue === "string") return record.timestampValue;
  if (isRecord(record.mapValue)) {
    const fields = asRecord(record.mapValue.fields);
    const output: RawRecord = {};
    for (const [key, child] of Object.entries(fields)) output[key] = fromFirestoreValue(child);
    return output;
  }
  if (isRecord(record.arrayValue)) {
    const values = record.arrayValue.values;
    return Array.isArray(values) ? values.map(fromFirestoreValue) : [];
  }
  return null;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const output: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(value)) output[key] = toJsonValue(child);
    return output;
  }
  return String(value);
}

function firestoreValue(value: JsonValue): unknown {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value)
    ? { integerValue: String(value) }
    : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(firestoreValue) } };
  const fields: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) fields[key] = firestoreValue(child);
  return { mapValue: { fields } };
}

function firestoreMap(values: Record<string, JsonValue>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) fields[key] = firestoreValue(value);
  return fields;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): RawRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function base64Url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}


// ===== Gestione task ("ricordiamoci...") =====

type Task = {
  id: string; titolo: string; cliente: string | null; tipo: string;
  due_date: string | null; urgente: boolean;
};

function intentGate(msg: string): "open" | "list" | "search" | "maybe_close" | null {
  const m = msg.toLowerCase();
  if (m.includes("ricordiamoci")) return "open";
  if (/lavori?\s+(aperti|in sospeso|da fare)|c'è\s+qualcosa\s+di\s+urgente|cosa\s+devo\s+fare|che\s+lavori\s+ho/.test(m)) return "list";
  if (/che\s+dovevamo\s+fare|che\s+lavoro\s+era|a\s+che\s+punto\s+(è|era)|che\s+fine\s+ha\s+fatto/.test(m)) return "search";
  if (/fatt[oa]|consegnat|stampat|chius|finit|complet/.test(m)) return "maybe_close";
  return null;
}

async function askClaudeJSON(env: Env, system: string, user: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${raw}`);
  const data = JSON.parse(raw);
  if (!data.content) throw new Error(`anthropic risposta senza content: ${raw}`);
  return data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
}

async function estraiTask(env: Env, msg: string): Promise<any> {
  const oggiISO = new Date().toISOString().slice(0, 10);
  const sys = `Estrai un task da una frase con "ricordiamoci". Oggi è ${oggiISO}.
Converti riferimenti temporali ("tra 5 giorni","lunedì","entro venerdì") in due_date ISO YYYY-MM-DD; se assente, null.
tipo: "lead" (contatto commerciale), "social" (approvazione/pubblicazione contenuti), altrimenti "default".
urgente=true SOLO se la frase segnala ritardo o cliente scontento.
Rispondi SOLO JSON: {"titolo","cliente","tipo","due_date","urgente"}.`;
  const out = await askClaudeJSON(env, sys, msg);
  return JSON.parse(out.replace(/```json|```/g, "").trim());
}

async function trovaDaChiudere(env: Env, msg: string, aperti: Task[]): Promise<{ task: Task; nota: string | null } | null> {
  if (!aperti.length) return null;
  const lista = aperti.map(t => `${t.id}: ${t.titolo}${t.cliente ? " (" + t.cliente + ")" : ""}`).join("\n");
  const sys = `L'utente segnala un lavoro completato. Quale task tra questi corrisponde?
${lista}
Attenzione: più task possono avere lo stesso cliente ma essere lavori diversi (es. "album" vs "poster" vs "video"). Guarda le PAROLE CHIAVE del messaggio confrontate col TITOLO del task, non solo il nome del cliente — se il messaggio dice "album" e il titolo dice "poster" NON è un match anche se il cliente coincide.
Se più task dello stesso cliente esistono e il messaggio non specifica quale tipo di lavoro, rispondi "nessuno": è meglio chiedere conferma che chiudere quello sbagliato.
Estrai anche eventuali dettagli qualitativi su come è andata (ritardi, umore cliente, problemi, imprevisti) — SOLO se presenti nel messaggio, altrimenti null. Non inventare.
Rispondi SOLO JSON: {"id": "id_task_o_nessuno", "nota": "testo o null"}`;
  const out = await askClaudeJSON(env, sys, msg);
  const { id, nota } = JSON.parse(out.replace(/```json|```/g, "").trim());
  if (id === "nessuno" || !id) return null;
  const task = aperti.find(t => t.id === id);
  if (!task) return null;
  return { task, nota: nota || null };
}

async function gestisciTask(env: Env, chatId: number, msg: string): Promise<string | null> {
  const intent = intentGate(msg);
  if (!intent) return null;
  const H = { "content-type": "application/json", "x-agent-key": env.AGENT_KEY };

  if (intent === "open") {
    const t = await estraiTask(env, msg);
    await fetch(`${env.TASK_URL}/open`, { method: "POST", headers: H, body: JSON.stringify(t) });
    await addLongMemory(env, chatId, {
      testo: `Da ricordare: ${t.titolo}${t.due_date ? ` entro ${t.due_date}` : ""}.`,
      cliente: t.cliente || null,
      source: "task",
    });
    return `Segnato: ${t.titolo}${t.due_date ? ` (scade ${t.due_date})` : ""}.`;
  }

  if (intent === "list") {
    const r = await fetch(`${env.TASK_URL}/open`, { headers: H });
    const { tasks } = await r.json() as any;
    if (!tasks.length) return "Nessun lavoro aperto.";
    return "Lavori aperti:\n" + tasks.map((t: any) => {
      const tag = t.urgente ? " ⚠️" : t.due_date ? ` (${t.due_date})` : "";
      return `• ${t.titolo}${t.cliente ? " — " + t.cliente : ""}${tag}`;
    }).join("\n");
  }

  if (intent === "search") {
    const nome = await askClaudeJSON(env, "Estrai SOLO il nome del cliente o del lavoro citato nella frase, niente altro testo.", msg);
    const query = nome.replace(/[*_`]/g, "").trim();
    if (!query) return null;
    const r = await fetch(`${env.TASK_URL}/search?q=${encodeURIComponent(query)}`, { headers: H });
    const { tasks } = await r.json() as any;
    if (!tasks.length) return `Non trovo niente su "${query}".`;
    return tasks.map((t: any) => {
      const stato = t.stato === "fatto" ? "✅ concluso" : "🔵 aperto";
      const data = t.due_date ? ` — scadenza ${t.due_date}` : "";
      return `• ${t.titolo}${t.cliente ? " — " + t.cliente : ""} (${stato}${data})`;
    }).join("\n");
  }

  if (intent === "maybe_close") {
    const r = await fetch(`${env.TASK_URL}/open`, { headers: H });
    const { tasks } = await r.json() as any;
    const match = await trovaDaChiudere(env, msg, tasks);
    if (!match) return null;
    await fetch(`${env.TASK_URL}/close`, {
      method: "POST", headers: H,
      body: JSON.stringify({ id: match.task.id, nota: match.nota }),
    });
    await addLongMemory(env, chatId, {
      testo: `Lavoro chiuso: ${match.task.titolo}${match.nota ? `. Nota: ${match.nota}` : "."}`,
      cliente: match.task.cliente || null,
      source: "task",
    });
    return `Chiuso: ${match.task.titolo}.`;
  }

  return null;
}

// ===== Gestione "segna" (decisione qualitativa con conferma) =====

type PendingDecision = { testo: string; cliente: string | null; createdAt: number };

const pendingKey = (chatId: number) => `pending_decision:${chatId}`;
const PENDING_TTL = 60 * 10; // 10 minuti: oltre, la proposta scade

async function loadPendingDecision(env: Env, chatId: number): Promise<PendingDecision | null> {
  const raw = await env.SAVERIO_KV.get(pendingKey(chatId));
  return raw ? JSON.parse(raw) : null;
}

async function savePendingDecision(env: Env, chatId: number, p: PendingDecision) {
  await env.SAVERIO_KV.put(pendingKey(chatId), JSON.stringify(p), { expirationTtl: PENDING_TTL });
}

async function clearPendingDecision(env: Env, chatId: number) {
  await env.SAVERIO_KV.delete(pendingKey(chatId));
}

function isSegnaIntent(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  // Match permissivo ma limitato a messaggi brevi: evita falsi positivi su frasi
  // lunghe che contengono "segna" per altri motivi (es. "ho segnato sul calendario").
  if (m.length > 30) return false;
  return /\bsegna(re|to|la|li)?\b|\bsegniamo(ci)?\b|\bricordatelo\b|\bricordiamocelo\b/.test(m);
}

function isConferma(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  return ["sì", "si", "ok", "va bene", "confermo", "esatto", "giusto"].includes(m);
}

function isAnnulla(msg: string): boolean {
  const m = msg.toLowerCase().trim();
  return ["no", "annulla", "lascia stare", "no aspetta"].includes(m);
}

// Sintetizza la decisione dagli ultimi turni della conversazione (KV già caricata).
async function sintetizzaDecisione(env: Env, history: Turn[]): Promise<{ testo: string; cliente: string | null }> {
  const recenti = history.slice(-10) // ultimi scambi: basta a coprire la discussione appena fatta
    .map(t => `${t.role === "user" ? "Mariano" : "Saverio"}: ${t.content}`)
    .join("\n");

  const sys = `Sintetizza in UNA frase densa la decisione presa o l'andamento descritto negli ultimi scambi, includendo il "perché" se c'è. Non inventare dettagli non detti. Se c'è un cliente/progetto citato, estrailo separatamente.
Rispondi SOLO JSON: {"testo": "...", "cliente": "nome o null"}`;

  const out = await askClaudeJSON(env, sys, recenti);
  return JSON.parse(out.replace(/```json|```/g, "").trim());
}

async function gestisciSegna(env: Env, chatId: number, history: Turn[]): Promise<string> {
  const { testo, cliente } = await sintetizzaDecisione(env, history);
  await savePendingDecision(env, chatId, { testo, cliente, createdAt: Date.now() });
  return `Segno questa:\n\n"${testo}"${cliente ? `\n(${cliente})` : ""}\n\nConfermi?`;
}

async function gestisciConfermaSegna(env: Env, chatId: number, msg: string): Promise<string | null> {
  const pending = await loadPendingDecision(env, chatId);
  if (!pending) return null;

  if (isConferma(msg)) {
    await addLongMemory(env, chatId, {
      testo: pending.testo,
      cliente: pending.cliente,
      source: "decision",
    });
    await clearPendingDecision(env, chatId);

    const H = { "content-type": "application/json", "x-agent-key": env.AGENT_KEY };
    try {
      const r = await fetch(`${env.TASK_URL}/decision`, {
        method: "POST", headers: H,
        body: JSON.stringify({ testo: pending.testo, cliente: pending.cliente }),
      });
      if (!r.ok) return "Segnato nella mia memoria. L'archivio esterno invece è ancora giù.";
    } catch (error) {
      console.error("decision backend error:", error);
      return "Segnato nella mia memoria. L'archivio esterno invece è ancora giù.";
    }
    return "Segnato.";
  }

  if (isAnnulla(msg)) {
    await clearPendingDecision(env, chatId);
    return "Ok, non la segno.";
  }

  // Né conferma né annulla: la proposta resta pendente, il messaggio prosegue come conversazione normale.
  return null;
}
