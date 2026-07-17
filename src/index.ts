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
  DIGEST_ENABLED?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  GOOGLE_CALENDAR_REFRESH_TOKEN?: string;
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
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const GOOGLE_CALENDAR_ID = "primary";
const DEEP_DIVE_JOB_TTL = 60 * 60 * 24;
const DEEP_DIVE_STEPS = ["resolve", "instagram", "website", "web-mentions", "synthesize"] as const;
const APIFY_INSTAGRAM_POST_ACTOR = "apify~instagram-post-scraper";
const DEEP_DIVE_POST_LIMIT = 30;
const DEEP_DIVE_INPUT_TTL = 60 * 5;
const MENU_INDAGA = "🔎 Indaga";
const MENU_LAVORI = "📋 Lavori";
const MENU_MEMORIA = "🧠 Memoria";
const MENU_OGGI = "📅 Oggi";
const MENU_NUOVO = "↩️ Nuova chat";
const MENU_RESET = "🧹 Reset";
const MENU_AIUTO = "❓ Aiuto";
const MAIN_MENU = {
  keyboard: [
    [{ text: MENU_INDAGA }, { text: MENU_LAVORI }],
    [{ text: MENU_MEMORIA }, { text: MENU_OGGI }],
    [{ text: MENU_NUOVO }, { text: MENU_RESET }, { text: MENU_AIUTO }],
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: "Scrivi a Saverio...",
};

let firestoreAccessToken: { token: string; expiresAt: number } | null = null;
let googleCalendarAccessToken: { token: string; expiresAt: number } | null = null;

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

## Concorrenti e mercato locale
Quando Mariano chiede di monitorare i concorrenti, cerchi su web fotografi e agenzie creative attivi nell'area: Foggia, Cerignola, Manfredonia, San Severo, Lucera, Trinitapoli, Barletta. Cerca per categoria: "fotografo matrimonio [città]", "agenzia social [città]", "fotografo eventi [città]", "agenzia creativa [città]", "video maker [città]".
Riporta chi ha sito attivo, social aggiornati, offerta, posizionamento. Non inventare dati — se non trovi niente su uno, lo dici.

## Cosa NON fai
- Non inventi numeri o stato dei lavori che non conosci. Se non sai chi preme o da quanto un lavoro è fermo, lo dici e chiedi.
- Non sei un cheerleader. Il tuo mestiere è filtrare, non applaudire.`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/auth") return redirectToGoogleOAuth(req, env);
    if (req.method === "GET" && url.pathname === "/auth/callback") return handleGoogleOAuthCallback(req, env);

    if (req.method !== "POST") return new Response("ok");

    // Verifica che la chiamata arrivi davvero da Telegram (secret nel webhook).
    if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await req.json() as any;
    const msg = update.message;
    if (!msg?.text) return new Response("ok"); // ignora foto, sticker, ecc.

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    let text = msg.text.trim();

    if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
      await sendMessage(env, chatId, "Questo bot è privato.");
      return new Response("ok");
    }

    if (text === MENU_INDAGA) {
      await env.SAVERIO_KV.put(deepDiveInputKey(chatId), "1", { expirationTtl: DEEP_DIVE_INPUT_TTL });
      await sendMessage(env, chatId, "Mandami l'@handle Instagram o l'URL del sito da analizzare.", { menu: true });
      return new Response("ok");
    }
    if (text === MENU_AIUTO) {
      await sendMessage(env, chatId, "Tocca un tasto oppure scrivimi normalmente. Per un concorrente: Indaga, poi @handle o URL.", { menu: true });
      return new Response("ok");
    }
    if (text === MENU_MEMORIA) text = "/memoria";
    if (text === MENU_LAVORI) text = "lavori aperti";
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
      const reply = `Indagine su «${job.target}» avviata. Ti mando il report tra qualche minuto.`;
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
      const reply = `Indagine su "${job.target}" avviata. Ti mando il report tra qualche minuto.`;
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ]);
      await sendMessage(env, chatId, reply, { menu: true });
      return new Response("ok");
    }

    const calendarReply = await gestisciCalendar(env, text);
    if (calendarReply) {
      await appendHistory(env, chatId, [
        { role: "user", content: text },
        { role: "assistant", content: calendarReply },
      ]);
      await sendMessage(env, chatId, calendarReply);
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
      const memories = await loadRelevantMemories(env, chatId, text);
      reply = await askClaude(env, history, memories);
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
    if (event.cron === "* * * * *") {
      await processDuePromemoria(env);
      await processNextDeepDiveJob(env);
      return;
    }

    if (event.cron === "25 5 * * *") {
      try {
        await fetch(env.TASK_URL + "/open", { method: "GET" });
        console.log("[FASE-1] Warm-up ping a sm-backend inviato.");
      } catch (e) {
        console.error("[FASE-1] Warm-up ping fallito:", e);
      }
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
type DeepDiveJob = {
  type: "deep-dive";
  target: string;
  chatId: number;
  status: "pending" | "running" | "done" | "failed";
  currentStep: number;
  steps: DeepDiveStep[];
  results: Partial<Record<DeepDiveStep, DeepDiveStepResult>>;
  createdAt: string;
  completedAt?: string;
  error: string | null;
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
const deepDiveInputKey = (chatId: number) => `pending_indaga:${chatId}`;

function getDeepDiveTarget(text: string): string | null {
  const match = text.match(/^\/indaga(?:@\w+)?(?:\s+([\s\S]+))?$/i);
  return match ? (match[1]?.trim() ?? "") : null;
}

async function createDeepDiveJob(env: Env, chatId: number, target: string): Promise<DeepDiveJob> {
  const id = crypto.randomUUID();
  const job: DeepDiveJob = {
    type: "deep-dive",
    target,
    chatId,
    status: "pending",
    currentStep: 0,
    steps: [...DEEP_DIVE_STEPS],
    results: {},
    createdAt: new Date().toISOString(),
    error: null,
  };
  await env.SAVERIO_KV.put(deepDiveJobKey(id), JSON.stringify(job), { expirationTtl: DEEP_DIVE_JOB_TTL });
  console.log(`[FASE-2] Job ${id} creato per ${target}.`);
  return job;
}

async function processNextDeepDiveJob(env: Env): Promise<void> {
  const jobs = await env.SAVERIO_KV.list({ prefix: "job:", limit: 100 });

  for (const key of jobs.keys) {
    const raw = await env.SAVERIO_KV.get(key.name);
    if (!raw) continue;

    let job: DeepDiveJob;
    try {
      job = JSON.parse(raw) as DeepDiveJob;
    } catch (error) {
      console.error(`[FASE-2] Job non leggibile ${key.name}:`, error);
      continue;
    }

    if (job.type !== "deep-dive" || (job.status !== "pending" && job.status !== "running")) continue;
    await runOneDeepDiveStep(env, key.name, job);
    return;
  }
}

async function runOneDeepDiveStep(env: Env, key: string, job: DeepDiveJob): Promise<void> {
  const step = job.steps[job.currentStep];
  if (!step) {
    job.status = "done";
    job.completedAt = new Date().toISOString();
    await saveDeepDiveJob(env, key, job);
    return;
  }

  try {
    job.status = "running";
    job.results[step] = await runDeepDiveStep(env, job, step);
    job.currentStep += 1;

    if (job.currentStep === job.steps.length) {
      job.status = "done";
      job.completedAt = new Date().toISOString();
    }

    await saveDeepDiveJob(env, key, job);
    console.log(`[FASE-2] ${job.target}: step ${step} completato.`);

    if (job.status === "done") {
      await sendMessage(env, job.chatId, formatDeepDiveCompletion(job));
    }
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await saveDeepDiveJob(env, key, job);
    console.error(`[FASE-2] ${job.target}: step ${step} fallito:`, error);
    await sendMessage(env, job.chatId, `Indagine su «${job.target}» interrotta allo step ${step}.`);
  }
}

async function runDeepDiveStep(env: Env, job: DeepDiveJob, step: DeepDiveStep): Promise<DeepDiveStepResult> {
  if (step === "resolve") return resolveDeepDiveTarget(job.target);
  if (step === "instagram") return runInstagramDeepDive(env, job);
  if (step === "website") return runWebsiteDeepDive(job);
  if (step === "web-mentions") return runWebMentionsDeepDive(env, job);
  return runDeepDivePlaceholderStep(step);
}

function resolveDeepDiveTarget(target: string): DeepDiveStepResult {
  const cleaned = target.trim();
  const completedAt = new Date().toISOString();
  if (cleaned.startsWith("@")) {
    const igHandle = cleaned.slice(1).replace(/[^a-z0-9._]/gi, "");
    if (!igHandle) throw new Error("handle Instagram non valido");
    return { ok: true, step: "resolve", completedAt, igHandle, displayName: igHandle };
  }

  try {
    const websiteUrl = new URL(cleaned).toString();
    return { ok: true, step: "resolve", completedAt, websiteUrl, displayName: new URL(websiteUrl).hostname };
  } catch {
    throw new Error("per ora usa un @handle Instagram oppure un URL completo");
  }
}

async function runInstagramDeepDive(env: Env, job: DeepDiveJob): Promise<DeepDiveStepResult> {
  const igHandle = job.results.resolve ? asString(job.results.resolve.igHandle) : null;
  const completedAt = new Date().toISOString();

  if (!igHandle) {
    return { ok: true, step: "instagram", completedAt, skipped: true, note: "Nessun handle Instagram disponibile." };
  }
  if (!env.APIFY_TOKEN) throw new Error("secret APIFY_TOKEN mancante su saverio-bot");

  const rawPosts = await fetchInstagramPostsForDeepDive(env, igHandle);
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

async function fetchInstagramPostsForDeepDive(env: Env, username: string): Promise<RawRecord[]> {
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
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${env.APIFY_TOKEN}`);
    if (!statusRes.ok) throw new Error(`Apify status error: ${statusRes.status}`);
    const status = asString(asRecord(asRecord(await statusRes.json()).data).status);
    if (status === "SUCCEEDED") break;
    if (status && ["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) throw new Error(`Apify run ${status}`);
    if (attempt === 11) throw new Error("Apify run timeout");
  }

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

  const home = await fetchWebsitePage(websiteUrl);
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
  const pages: WebsitePage[] = [{ url: home.url, title: extractHtmlTitle(home.html), textContent: htmlToText(home.html) }];
  for (const link of links.slice(0, 5)) {
    const page = await fetchWebsitePage(link);
    if (!page) continue;
    pages.push({ url: page.url, title: extractHtmlTitle(page.html), textContent: htmlToText(page.html) });
  }

  return { ok: true, step: "website", completedAt, websiteUrl, pages };
}

async function fetchWebsitePage(url: string): Promise<{ url: string; html: string } | null> {
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
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return null;
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

async function runWebMentionsDeepDive(env: Env, job: DeepDiveJob): Promise<DeepDiveStepResult> {
  const displayName = job.results.resolve ? asString(job.results.resolve.displayName) : null;
  if (!displayName) throw new Error("nome concorrente non disponibile per la ricerca web");

  const queries = [
    `"${displayName}" fotografo recensioni`,
    `"${displayName}" matrimonio.com OR zankyou`,
    `"${displayName}" premio OR award fotografo`,
  ];
  const prompt = `Cerca sul web queste tre query, una alla volta:\n${queries.map((query) => `- ${query}`).join("\n")}\n\nRispondi SOLO con JSON valido nel formato {"mentions":[{"query":"...","title":"...","snippet":"...","url":"..."}]}. Raccogli al massimo 6 risultati in totale. Usa solo risultati realmente trovati, senza inventare URL o testi.`;
  const raw = await askClaudeWithWebSearch(env, prompt);
  const mentions = parseWebMentions(raw);
  return { ok: true, step: "web-mentions", completedAt: new Date().toISOString(), queries, mentions };
}

async function askClaudeWithWebSearch(env: Env, prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1400,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Claude web search error: ${response.status} ${raw}`);
  const data = JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function parseWebMentions(raw: string): Array<{ query: string; title: string; snippet: string; url: string }> {
  const json = raw.replace(/^```json\s*|\s*```$/g, "").trim();
  try {
    const parsed = JSON.parse(json) as { mentions?: unknown };
    if (!Array.isArray(parsed.mentions)) return [];
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
  } catch (error) {
    console.error("[FASE-2] Risposta web mentions non valida:", raw, error);
    return [];
  }
}

async function runDeepDivePlaceholderStep(step: DeepDiveStep): Promise<DeepDiveStepResult> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  return { ok: true, step, completedAt: new Date().toISOString() };
}

async function saveDeepDiveJob(env: Env, key: string, job: DeepDiveJob): Promise<void> {
  await env.SAVERIO_KV.put(key, JSON.stringify(job), { expirationTtl: DEEP_DIVE_JOB_TTL });
}

function formatDeepDiveCompletion(job: DeepDiveJob): string {
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

async function askClaude(env: Env, history: Turn[], memories: LongMemory[]): Promise<string> {
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
      system: buildSystemPrompt(memories),
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
async function sendMessage(env: Env, chatId: number, text: string, options: { menu?: boolean } = {}) {
  // Telegram taglia oltre 4096 caratteri: spezzo se serve.
  for (let i = 0; i < text.length; i += 4000) {
    try {
      const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(i, i + 4000) };
      if (options.menu && i === 0) body.reply_markup = MAIN_MENU;
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

type GoogleCalendarEvent = {
  id?: string;
  summary?: string;
  location?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

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

async function gestisciCalendar(env: Env, text: string): Promise<string | null> {
  if (!isCalendarReadIntent(text) && !isCalendarIntent(text)) return null;

  if (!env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
    return "Calendar non e' ancora configurato su Saverio. Serve impostare GOOGLE_CALENDAR_REFRESH_TOKEN con i permessi Calendar gia' approvati.";
  }

  if (isCalendarReadIntent(text)) {
    const range = getCalendarReadRange(text, env.TIMEZONE || "Europe/Rome");
    const events = await listGoogleCalendarEvents(env, range.start, range.end);
    if (events === null) {
      return "Non riesco a leggere Google Calendar in questo momento. Controlliamo token e permessi.";
    }
    return formatGoogleCalendarEvents(events, range.label, env.TIMEZONE || "Europe/Rome");
  }

  const draft = await parseCalendarEvent(env, text);
  if (draft.intent !== "calendar_create" || draft.confidence < 0.65) {
    return "Socio, per metterlo in calendario scrivimelo piu' secco: appuntamento: 8 giugno 2026 alle 10 con Nome.";
  }
  if (!draft.title) return "Mi manca il titolo dell'appuntamento.";
  if (!draft.start_at) return "Mi manca data o ora dell'appuntamento.";

  const startAt = draft.start_at;
  const endAt = draft.end_at || addMinutesIso(startAt, draft.all_day ? 24 * 60 : 60);
  const googleId = await insertGoogleCalendarEvent(env, {
    summary: draft.title,
    description: draft.description,
    location: draft.location,
    startAt,
    endAt,
    allDay: draft.all_day,
  });

  if (!googleId) {
    return "Ho capito l'appuntamento, ma Google Calendar non l'ha salvato. Controlliamo refresh token e permessi Calendar.";
  }

  return `Messo in calendario: ${draft.title}\n${formatCalendarDate(startAt, draft.all_day)}${draft.location ? `\nLuogo: ${draft.location}` : ""}`;
}

function getCalendarReadRange(text: string, timezone: string): { start: string; end: string; label: string } {
  const value = normalizeForMatch(text);
  const today = getRomeDateParts(new Date(), timezone);
  let start = new Date(Date.UTC(today.year, today.month - 1, today.day));
  let days = 1;
  let label = "oggi";
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

  if (value.includes("dopodomani")) {
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
    const token = await getGoogleCalendarAccessToken(env);
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("maxResults", "20");
    const response = await fetch(url.toString(), { headers: { authorization: "Bearer " + token } });
    const raw = await response.text();
    if (!response.ok) {
      console.error("[GCAL] Lettura eventi fallita:", response.status, raw);
      return null;
    }
    const data = JSON.parse(raw) as { items?: GoogleCalendarEvent[] };
    return data.items || [];
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

function cleanJson(text: string): string {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
}

async function getGoogleCalendarAccessToken(env: Env): Promise<string> {
  if (googleCalendarAccessToken && googleCalendarAccessToken.expiresAt > Date.now() + 60_000) {
    return googleCalendarAccessToken.token;
  }
  if (!env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET || !env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
    throw new Error("Google Calendar OAuth non configurato");
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
      refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("[GCAL] OAuth refresh fallito: " + response.status + " " + raw);
  const body = JSON.parse(raw) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("[GCAL] OAuth senza access token");
  googleCalendarAccessToken = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in || 3600) * 1000,
  };
  return body.access_token;
}

async function insertGoogleCalendarEvent(env: Env, event: {
  summary: string;
  description?: string | null;
  location?: string | null;
  startAt: string;
  endAt: string;
  allDay?: boolean;
}): Promise<string | null> {
  try {
    const token = await getGoogleCalendarAccessToken(env);
    const body: Record<string, unknown> = { summary: event.summary };
    if (event.description) body.description = event.description;
    if (event.location) body.location = event.location;
    if (event.allDay) {
      body.start = { date: event.startAt.slice(0, 10) };
      body.end = { date: event.endAt.slice(0, 10) };
    } else {
      body.start = { dateTime: event.startAt, timeZone: env.TIMEZONE || "Europe/Rome" };
      body.end = { dateTime: event.endAt, timeZone: env.TIMEZONE || "Europe/Rome" };
    }

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(GOOGLE_CALENDAR_ID)}/events`, {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const raw = await response.text();
    if (!response.ok) {
      console.error("[GCAL] Scrittura evento fallita:", response.status, raw);
      return null;
    }
    const data = JSON.parse(raw) as { id?: string };
    console.log("[GCAL] Evento creato:", data.id);
    return data.id || null;
  } catch (error) {
    console.error("[GCAL] Errore scrittura:", error);
    return null;
  }
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

function redirectToGoogleOAuth(req: Request, env: Env): Response {
  if (!env.GOOGLE_CALENDAR_CLIENT_ID) return new Response("GOOGLE_CALENDAR_CLIENT_ID mancante", { status: 500 });
  const requestUrl = new URL(req.url);
  const redirectUri = `${requestUrl.origin}/auth/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CALENDAR_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("prompt", "consent");
  return Response.redirect(url.toString(), 302);
}

async function handleGoogleOAuthCallback(req: Request, env: Env): Promise<Response> {
  if (!env.GOOGLE_CALENDAR_CLIENT_ID || !env.GOOGLE_CALENDAR_CLIENT_SECRET) {
    return new Response("Google OAuth client non configurato", { status: 500 });
  }
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code");
  if (!code) return new Response("code mancante", { status: 400 });
  const redirectUri = `${requestUrl.origin}/auth/callback`;
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
      client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const raw = await response.text();
  if (!response.ok) return new Response("OAuth error: " + raw, { status: 500 });
  const data = JSON.parse(raw) as { refresh_token?: string };
  const refreshToken = data.refresh_token || "";
  return new Response(`<!DOCTYPE html>
<html>
<head><title>OAuth Success</title></head>
<body>
  <h1>Autorizzazione completata</h1>
  <p>Copia questo refresh token e salvalo con:</p>
  <pre>npx wrangler secret put GOOGLE_CALENDAR_REFRESH_TOKEN</pre>
  <textarea readonly style="width:100%;height:120px" onclick="this.select()">${escapeHtml(refreshToken)}</textarea>
  <p><strong>Attenzione:</strong> questo token e' visibile solo ora. Se lo perdi, rifai il flusso.</p>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ===== Fase 1: signal bus + digest mattutino =====

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

const DIGEST_SYSTEM_PROMPT = "Sei Saverio, chief of staff di Mariano. Ricevi: segnali dai sistemi di\n"
  + "monitoraggio (competitor Instagram, bandi pubblici), task aperti con\n"
  + "eventuali scadenze. Produci un digest mattutino in italiano, asciutto,\n"
  + "max 12 righe, ordinato per urgenza. Raggruppa per tema. Niente\n"
  + "convenevoli. Se non c'è NULLA che meriti attenzione oggi (nessun\n"
  + "segnale, nessuna scadenza entro 7 giorni), rispondi esattamente con la\n"
  + "parola SILENZIO e nient'altro.";

async function runMorningDigest(env: Env): Promise<void> {
  try {
    const signals = await getUnseenSignals(env);
    const tasks = await fetchOpenTasksForDigest(env);
    const digest = await createMorningDigest(env, signals, tasks);

    if (digest === "SILENZIO") {
      await markSignalsSeen(env, signals);
      console.log("[FASE-1] Digest silenzioso; " + signals.length + " segnali marcati come visti.");
      return;
    }

    // I segnali vengono marcati solo dopo che Telegram ha confermato l'invio.
    await sendMessage(env, OWNER_CHAT_ID, digest);
    await markSignalsSeen(env, signals);
    console.log("[FASE-1] Digest inviato; " + signals.length + " segnali marcati come visti.");
  } catch (error) {
    // In caso di errore non marchiamo nulla: il segnale rientra nel prossimo digest.
    console.error("[FASE-1] Digest mattutino fallito:", error);
  }
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

async function createMorningDigest(env: Env, signals: Signal[], tasks: JsonValue[]): Promise<string> {
  const userPayload = JSON.stringify({
    signals: signals.map(({ documentPath: _documentPath, ...signal }) => signal),
    tasks,
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
    if (!text) throw new Error("Claude digest senza testo");
    return text;
  } catch (error) {
    console.error("[FASE-1] Claude digest fallito:", error);
    throw error;
  }
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
