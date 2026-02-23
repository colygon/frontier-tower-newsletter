#!/usr/bin/env npx tsx

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_TOPICS: Record<string, string[]> = {
  "Neuro tech": ["neuro", "neuroscience", "brain", "biotech", "biohacking", "neurotech"],
  AI: ["ai", "artificial intelligence", "machine learning", "ml", "llm", "gpt", "agent", "agentic"],
  Crypto: ["crypto", "blockchain", "web3", "token", "defi", "nft", "dao"],
};

const MS = {
  HOUR: 60 * 60 * 1000,
  WEEK_DAYS: 7,
};

type TopicMap = Record<string, string[]>;

type Lead = {
  id: string;
  name: string;
  email?: string;
  telegramId?: string;
  topics: string[];
  status: "active" | "paused" | "archived";
  allowEmail: boolean;
  allowTelegram: boolean;
};

type EventItem = {
  id: string;
  title: string;
  description: string;
  startAt?: string;
  location?: string;
  url?: string;
  topics: string[];
};

type LeadDigest = {
  leadId: string;
  leadName: string;
  email?: string;
  telegramId?: string;
  events: EventItem[];
  channels: {
    email?: string;
    telegram?: string;
  };
  topics: string[];
  previewSentAt?: string;
  finalSentAt?: string;
};

type RunState = {
  id: string;
  createdAt: string;
  sourceSignature: string;
  status: "draft" | "finalized" | "cancelled";
  scheduledSendAt: string;
  reviewWindowHours: number;
  digests: LeadDigest[];
};

type AutomationState = {
  runs: RunState[];
};

type LeadAction = {
  runId?: string;
  leadId?: string;
  email?: string;
  telegramId?: string;
  action: "opt_out" | "set_topics" | "remove_event" | "add_event";
  topics?: string[];
  eventId?: string | string[];
};

type EnvConfig = {
  lumaUrls: string[];
  leadSourcePath: string;
  leadActionPath: string;
  statePath: string;
  lookAheadDays: number;
  reviewWindowHours: number;
  topicKeywords: TopicMap;
  fromEmail: string;
  fromName: string;
  sendgridApiKey?: string;
  telegramBotToken?: string;
  defaultTelegramChatId?: string;
  topicTelegramMap: Record<string, string>;
};

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

function parseJsonArray(value?: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === "string").map((x) => String(x).trim()).filter(Boolean);
  } catch {
    return value
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  return [];
}

function parseTopicMap(rawJson?: string, fallback: TopicMap = {}): TopicMap {
  const parsed = parseJsonArray(rawJson);
  const out: TopicMap = {};

  if (rawJson && parsed.length === 0) {
    try {
      const obj = JSON.parse(rawJson || "{}");
      if (typeof obj === "object" && obj !== null) {
        for (const [topic, values] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof topic !== "string") continue;
          if (Array.isArray(values)) {
            const terms = values.map((value) => String(value).toLowerCase().trim()).filter(Boolean);
            if (terms.length) out[topic] = terms;
          }
        }
      }
    } catch {
      // ignore
    }
  } else if (parsed.length > 0) {
    parsed.forEach((topic) => {
      const [topicName, ...rest] = topic.split(":").map((s) => s.trim()).filter(Boolean);
      const terms = (rest.length ? rest.join(":") : "").split("|").map((t) => t.trim().toLowerCase()).filter(Boolean);
      if (topicName && terms.length) out[topicName] = terms;
    });
  }

  return { ...fallback, ...out };
}

function buildTopicMapFromJsonLike(key: string, fallback: TopicMap): TopicMap {
  const raw = process.env[key];
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const normalized: TopicMap = {};
      for (const [topic, terms] of Object.entries(parsed)) {
        if (typeof topic !== "string" || !Array.isArray(terms)) continue;
        normalized[topic] = terms
          .map((value) => String(value).toLowerCase().trim())
          .filter(Boolean);
      }
      return { ...fallback, ...normalized };
    }
  } catch {
    // fallback handled below
  }

  return parseTopicMap(raw, fallback);
}

function getConfig(): EnvConfig {
  loadEnvFile();

  const lumaUrls = parseJsonArray(process.env.LUMA_SOURCE_URLS)
    .map((url) => url.trim())
    .filter(Boolean);

  const topicKeywords = buildTopicMapFromJsonLike("TOPIC_KEYWORDS_JSON", DEFAULT_TOPICS);

  const rawMap = process.env.TELEGRAM_TOPIC_CHAT_IDS || "{}";
  const topicTelegramMap: Record<string, string> = {};

  try {
    const parsed = JSON.parse(rawMap);
    if (parsed && typeof parsed === "object") {
      for (const [topic, rawValue] of Object.entries(parsed)) {
        const value = String(rawValue).trim();
        if (value) topicTelegramMap[topic.toLowerCase()] = value;
      }
    }
  } catch {
    // ignored
  }

  const lookAheadDays = Number(process.env.LUMA_LOOKAHEAD_DAYS ?? 30);
  const reviewWindowHours = Number(process.env.FRONTIER_REVIEW_WINDOW_HOURS ?? 24);

  return {
    lumaUrls,
    leadSourcePath: process.env.LEAD_SOURCE_PATH ?? path.resolve(process.cwd(), "data/frontier-floor-leads.json"),
    leadActionPath: process.env.FRONTIER_LEAD_ACTION_PATH ?? path.resolve(process.cwd(), "data/frontier-floor-lead-actions.json"),
    statePath: process.env.FRONTIER_NEWSLETTER_STATE_PATH ?? path.resolve(process.cwd(), "data/frontier-newsletter-state.json"),
    lookAheadDays: Number.isFinite(lookAheadDays) ? Math.max(1, Math.floor(lookAheadDays)) : 14,
    reviewWindowHours: Number.isFinite(reviewWindowHours) ? Math.max(1, Math.floor(reviewWindowHours)) : 24,
    topicKeywords,
    fromEmail: process.env.FROM_EMAIL || "frontier-floor@clawd.email",
    fromName: process.env.FROM_NAME || "Frontier Tower Events",
    sendgridApiKey: process.env.SENDGRID_API_KEY,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    defaultTelegramChatId: process.env.TELEGRAM_DEFAULT_CHAT_ID,
    topicTelegramMap,
  };
}

function dedupeEvents(events: EventItem[]): EventItem[] {
  const map = new Map<string, EventItem>();
  for (const event of events) {
    const normalizedId = `${event.id}`.trim().toLowerCase();
    map.set(normalizedId, event);
  }
  return [...map.values()];
}

function parseEventLike(raw: Record<string, unknown>): EventItem | null {
  const get = (key: string): string => {
    const value = raw[key];
    return typeof value === "string" ? value : "";
  };

  const title = String(raw.title || raw.name || raw.headline || "").trim();
  if (!title) return null;

  const description = String(raw.description || raw.summary || "").trim();
  const url = get("url");

  const locationRaw = raw.location;
  let location = "";
  if (typeof locationRaw === "string") location = locationRaw;
  else if (locationRaw && typeof locationRaw === "object") {
    const maybeName = (locationRaw as Record<string, unknown>).name;
    if (typeof maybeName === "string") location = maybeName;
  }

  const startRaw = get("startDate") || get("start_time") || get("start_at") || get("startAt");

  const id = String(raw.id || raw.uuid || url || `${title}-${startRaw}`);

  const tags = new Set<string>();
  const keywordSource = [
    get("keywords"),
    get("tags"),
    get("tag"),
    ...[get("category"), get("category_name")],
    String(raw.type || ""),
  ];

  for (const rawTagLine of keywordSource.filter(Boolean)) {
    const entries = rawTagLine
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    for (const entry of entries) tags.add(entry);
  }

  return {
    id,
    title,
    description,
    startAt: startRaw || undefined,
    location: location || undefined,
    url: url || undefined,
    topics: [...tags],
  };
}

function extractTopicMatches(text: string, topicMap: TopicMap): string[] {
  const haystack = text.toLowerCase();
  const matches = new Set<string>();

  for (const [topic, terms] of Object.entries(topicMap)) {
    for (const term of terms) {
      const normalized = term.trim().toLowerCase();
      if (!normalized) continue;
      if (haystack.includes(normalized)) {
        matches.add(topic);
        break;
      }
    }
  }

  return [...matches];
}

function normalizeLead(raw: Record<string, unknown>): Lead {
  const topicsRaw = Array.isArray(raw.topics)
    ? raw.topics.map((value) => String(value).trim()).filter(Boolean)
    : typeof raw.topics === "string"
      ? String(raw.topics).split(",").map((value) => value.trim()).filter(Boolean)
      : [];

  const status =
    raw.status === "paused" || raw.status === "archived" ? raw.status : "active";

  return {
    id: String(raw.id || raw.email || raw.telegramId || crypto.randomUUID()),
    name: String(raw.name || "Frontier lead").trim(),
    email: typeof raw.email === "string" ? raw.email : undefined,
    telegramId: typeof raw.telegramId === "string" ? raw.telegramId : undefined,
    topics: topicsRaw.map((topic) => topic),
    status,
    allowEmail: raw.allowEmail !== false,
    allowTelegram: raw.allowTelegram !== false,
  };
}

async function fetchLumaEvents(url: string): Promise<EventItem[]> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "FrontierNewsletter/1.0 (+automation)",
      Accept: "application/json, text/html;q=0.9, */*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await response.text();
  const events: EventItem[] = [];

  // JSON endpoint.
  if (contentType.includes("application/json") || text.trim().startsWith("[") || text.trim().startsWith("{")) {
    try {
      const payload = JSON.parse(text);
      const nested =
        (Array.isArray(payload) ? payload : null) ||
        (payload && Array.isArray((payload as Record<string, unknown>).events)
          ? ((payload as Record<string, unknown>).events as unknown[])
          : null) ||
        (payload && Array.isArray((payload as Record<string, unknown>).items)
          ? ((payload as Record<string, unknown>).items as unknown[])
          : []);

      for (const item of nested) {
        if (!item || typeof item !== "object") continue;
        const parsed = parseEventLike(item as Record<string, unknown>);
        if (parsed) events.push(parsed);
      }
    } catch {
      // fall back to html parsing below
    }
  }

  // JSON-LD fallback for Luma/landing pages.
  if (events.length === 0) {
    const ldRegex = /<script[^>]*type=[\"']application\/ld\+json[\"'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = ldRegex.exec(text))) {
      try {
        const parsed = JSON.parse(match[1] || "{}");
        const blobs = Array.isArray(parsed)
          ? parsed
          : [parsed];

        for (const blob of blobs) {
          if (!blob || typeof blob !== "object") continue;
          const itemList = (blob as Record<string, unknown>).itemListElement;

          if (Array.isArray(itemList)) {
            for (const node of itemList) {
              if (!node || typeof node !== "object") continue;
              const candidate = parseEventLike(node as Record<string, unknown>);
              if (candidate) events.push(candidate);
            }
            continue;
          }

          const candidate = parseEventLike(blob as Record<string, unknown>);
          if (candidate) events.push(candidate);
        }
      } catch {
        // ignore malformed JSON-LD blocks
      }
    }
  }

  return dedupeEvents(events);
}

function normalizeEvent(event: EventItem, topicKeywords: TopicMap): EventItem {
  const inferred = extractTopicMatches(`${event.title} ${event.description} ${event.location ?? ""} ${event.url ?? ""}`, topicKeywords);
  const merged = new Set([...event.topics, ...inferred]);

  if (!merged.size) {
    merged.add("General");
  }

  return {
    ...event,
    topics: [...merged],
  };
}

async function collectAllEvents(urls: string[], topicKeywords: TopicMap): Promise<EventItem[]> {
  const bucket: EventItem[] = [];

  for (const rawUrl of urls) {
    const events = await fetchLumaEvents(rawUrl);
    for (const event of events) {
      const normalized = normalizeEvent(event, topicKeywords);
      bucket.push(normalized);
    }
  }

  const seen = new Map<string, EventItem>();
  for (const event of bucket) {
    const key = `${event.id}`;
    seen.set(key, event);
  }

  return Array.from(seen.values());
}

function filterUpcoming(events: EventItem[], now: Date, daysAhead: number): EventItem[] {
  const end = new Date(now);
  end.setDate(end.getDate() + daysAhead);

  return events.filter((event) => {
    if (!event.startAt) return false;
    const start = new Date(event.startAt);
    if (Number.isNaN(start.getTime())) return false;
    return start.getTime() >= now.getTime() && start.getTime() <= end.getTime();
  });
}

function matchTopics(lead: Lead, event: EventItem): boolean {
  const leadTopics = lead.topics.map((topic) => topic.toLowerCase());
  if (!leadTopics.length) return true;
  const candidates = event.topics.map((topic) => topic.toLowerCase());

  return leadTopics.some((topic) => candidates.includes(topic));
}

function eventsForLead(lead: Lead, events: EventItem[]): EventItem[] {
  return events
    .filter((event) => matchTopics(lead, event))
    .sort((a, b) => Date.parse(a.startAt ?? "") - Date.parse(b.startAt ?? ""));
}

function resolveTelegramForLead(lead: Lead, config: EnvConfig): string | undefined {
  if (lead.telegramId) return lead.telegramId;
  if (!lead.allowTelegram) return undefined;
  if (lead.topics.length) {
    const mapKey = lead.topics[0].toLowerCase();
    if (config.topicTelegramMap[mapKey]) return config.topicTelegramMap[mapKey];
  }
  return config.defaultTelegramChatId;
}

function buildRunSignature(config: EnvConfig, eventCount: number, leadCount: number): string {
  return `${config.lumaUrls.length}-${eventCount}-${leadCount}-${config.lookAheadDays}`;
}

function loadState(statePath: string): AutomationState {
  if (!existsSync(statePath)) return { runs: [] };

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8"));
    if (parsed && Array.isArray(parsed.runs)) return parsed as AutomationState;
  } catch {
    // ignore
  }

  return { runs: [] };
}

function saveState(statePath: string, state: AutomationState) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadLeads(config: EnvConfig): Lead[] {
  if (!existsSync(config.leadSourcePath)) {
    throw new Error(`Lead source missing: ${config.leadSourcePath}`);
  }

  const raw = JSON.parse(readFileSync(config.leadSourcePath, "utf-8"));
  if (!Array.isArray(raw)) throw new Error("Lead source should be an array of leads.");

  return raw.map((item) => normalizeLead(item as Record<string, unknown>));
}

function loadLeadActions(config: EnvConfig): LeadAction[] {
  if (!existsSync(config.leadActionPath)) return [];

  try {
    const raw = JSON.parse(readFileSync(config.leadActionPath, "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is LeadAction => {
        const actionItem = item as Record<string, unknown>;
        if (!actionItem || typeof actionItem !== "object") return false;
        const action = actionItem.action;
        return (
          action === "opt_out" ||
          action === "set_topics" ||
          action === "remove_event" ||
          action === "add_event"
        );
      })
      .map((item) => item as LeadAction);
  } catch {
    return [];
  }
}

function applyActions(digests: LeadDigest[], actions: LeadAction[], runId: string): LeadDigest[] {
  const pending = [...digests];
  const active = pending.filter(Boolean);
  const byLead = new Map<string, LeadAction[]>();

  for (const action of actions.filter((a) => !a.runId || a.runId === runId)) {
    const key = action.leadId || action.email || action.telegramId;
    if (!key) continue;
    byLead.set(key, [...(byLead.get(key) || []), action]);
  }

  const out: LeadDigest[] = [];

  for (const digest of active) {
    const key = digest.leadId || digest.email || digest.telegramId;
    const leadActions = key ? byLead.get(key) || [] : [];

    let removed = false;
    let events = digest.events;
    let topics = digest.topics;

    for (const action of leadActions) {
      if (action.action === "opt_out") {
        removed = true;
        break;
      }

      if (action.action === "set_topics" && action.topics?.length) {
        const nextTopics = new Set(action.topics.map((topic) => topic.toLowerCase()));
        topics = Array.from(nextTopics);
        events = events.filter((event) => event.topics.some((topic) => nextTopics.has(topic.toLowerCase())));
      }

      if (action.action === "remove_event" && action.eventId) {
        const removeIds = new Set(
          Array.isArray(action.eventId) ? action.eventId : [action.eventId],
        );
        events = events.filter((event) => !removeIds.has(event.id));
      }

      if (action.action === "add_event" && action.eventId) {
        const include = new Set(Array.isArray(action.eventId) ? action.eventId : [action.eventId]);
        // Explicit add is handled by event source; keep for future extension and explicit override files.
      }
    }

    if (!removed && events.length > 0) {
      out.push({ ...digest, events, topics: [...topics] });
    }
  }

  return out;
}

function sourceSignature(events: EventItem[], leads: Lead[]): string {
  const eventDigest = events.map((event) => event.id).sort().join(",");
  const leadDigest = leads.map((lead) => lead.id).sort().join(",");
  return `${eventDigest.length}-${leadDigest.length}-${eventDigest.slice(0, 80)}-${leadDigest.slice(0, 80)}`;
}

function makeRunId(now = new Date()) {
  return `run-${now.toISOString().slice(0, 10)}-${Math.floor(now.getTime() / 1000)}`;
}

function buildEmailHtml(leadName: string, events: EventItem[], isDraft: boolean): string {
  const rows = events
    .map((event) => {
      const when = event.startAt ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "TBD";
      const safeLocation = event.location || "TBD";
      const link = event.url ? `<a href="${event.url}">Details</a>` : "";
      return `<li><strong>${event.title}</strong> — ${when} • ${safeLocation} ${link}</li>`;
    })
    .join("");

  return `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; padding: 16px; color: #111827;">
    <h2>${isDraft ? "[Draft Preview]" : "This Week in Frontier Tower"}</h2>
    <p>Hi ${leadName},</p>
    <p>${isDraft ? "Preview for this week's newsletter" : "Here is the final weekly list"} for upcoming events.</p>
    <ul>${rows}</ul>
    <p style="font-size: 12px; color: #6b7280;">This is an automated message from Frontier Tower. Reply <strong>STOP</strong> to remove yourself from this community, or <strong>CHANGE: Neuro tech,AI,Crypto</strong> to update what you receive.</p>
  </div>
  `.trim();
}

function buildEmailText(leadName: string, events: EventItem[], isDraft: boolean): string {
  const lines = [
    `${isDraft ? "[Draft Preview]" : "Frontier Tower Weekly Events"}`,
    `Hi ${leadName},`,
    isDraft
      ? "Preview for this week's newsletter (final preview in 24h):"
      : "Here is this week's final Frontier Tower event list:",
    "",
    ...events.map((event) => {
      const when = event.startAt
        ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
        : "TBD";
      const line = `- ${event.title} — ${when} • ${event.location || "TBD"}${event.url ? ` (${event.url})` : ""}`;
      return line;
    }),
    "",
    "Reply STOP to opt out | Reply CHANGE: Neuro tech,AI,Crypto to update topic preferences",
    "This message came from your open club automated workflow.",
  ];
  return lines.join("\n");
}

function buildTelegramText(leadName: string, events: EventItem[], isDraft: boolean, runId: string): string {
  const lines = [
    isDraft ? "[Frontier Tower] Draft weekly pick list" : "[Frontier Tower] Weekly Picks",
    `Hi ${leadName},`,
    isDraft ? "This is a preview of Friday's list" : "Final list is below",
    `Run ID: ${runId}`,
    ...events.map((event) => {
      const when = event.startAt
        ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
        : "TBD";
      return `• ${event.title} — ${when} • ${event.location || "TBD"}`;
    }),
    "",
    isDraft
      ? "Reply STOP to remove yourself or CHANGE: Neuro tech,AI,Crypto within 24h. No reply = final send."
      : "Final send for this run.",
  ];

  return lines.join("\n");
}

function findMostRecentDraftForToday(state: AutomationState, signature: string): RunState | undefined {
  const today = new Date().toISOString().slice(0, 10);
  return state.runs.find(
    (run) => run.status === "draft" && run.createdAt.startsWith(today) && run.sourceSignature === signature,
  );
}

async function sendEmail(config: EnvConfig, to: string, subject: string, text: string, html: string): Promise<void> {
  if (!config.sendgridApiKey) {
    console.log(`[EMAIL DRY RUN] to=${to}\n${text}`);
    return;
  }

  const payload = {
    personalizations: [
      {
        to: [{ email: to }],
      },
    ],
    from: { email: config.fromEmail, name: config.fromName },
    subject,
    content: [
      { type: "text/plain", value: text },
      { type: "text/html", value: html },
    ],
  };

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[EMAIL FAILED] ${to} ${response.status} ${body}`);
  }
}

async function sendTelegram(config: EnvConfig, chatId: string, text: string): Promise<void> {
  if (!config.telegramBotToken) {
    console.log(`[TELEGRAM DRY RUN] to=${chatId}\n${text}`);
    return;
  }

  const endpoint = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`[TELEGRAM FAILED] ${chatId} ${response.status} ${body}`);
  }
}

function parseArgs(): Set<string> {
  return new Set(process.argv.slice(2));
}

function getRunById(state: AutomationState, runId: string | undefined): RunState | undefined {
  if (!runId) return undefined;
  return state.runs.find((run) => run.id === runId);
}

function parseValueArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function buildSignature(eventCount: number, leadCount: number, urls: string[]): string {
  return `${eventCount}:${leadCount}:${urls.length}:${urls.join("|")}`;
}

async function buildDraft(config: EnvConfig, state: AutomationState, force = false): Promise<RunState> {
  const now = new Date();
  const rawLeads = loadLeads(config);
  const activeLeads = rawLeads.filter((lead) => lead.status === "active");
  const events = await collectAllEvents(config.lumaUrls, config.topicKeywords);
  const upcoming = filterUpcoming(events, now, config.lookAheadDays);

  const signature = sourceSignature(upcoming, activeLeads);
  const existing = force ? undefined : findMostRecentDraftForToday(state, signature);
  if (existing && existing.digests.length) {
    console.log(`Draft already exists for today: ${existing.id}`);
    return existing;
  }

  const digests: LeadDigest[] = activeLeads
    .flatMap((lead) => {
      const matched = eventsForLead(lead, upcoming);
      if (!matched.length) return [] as LeadDigest[];
      const telegram = resolveTelegramForLead(lead, config);

      if (!lead.allowEmail && !telegram) return [] as LeadDigest[];

      return [
        {
          leadId: lead.id,
          leadName: lead.name,
          email: lead.allowEmail ? lead.email : undefined,
          telegramId: lead.allowTelegram ? telegram : undefined,
          events: matched,
          channels: {
            email: lead.allowEmail ? lead.email : undefined,
            telegram,
          },
          topics: [...lead.topics],
        },
      ];
    });

  const run: RunState = {
    id: makeRunId(now),
    createdAt: now.toISOString(),
    sourceSignature: signature,
    status: "draft",
    scheduledSendAt: new Date(now.getTime() + config.reviewWindowHours * MS.HOUR).toISOString(),
    reviewWindowHours: config.reviewWindowHours,
    digests,
  };

  // Keep only latest 30 runs.
  state.runs = [run, ...state.runs.filter((r) => r.id !== run.id)].slice(0, 30);
  return run;
}

async function sendPreviews(config: EnvConfig, run: RunState): Promise<void> {
  for (const digest of run.digests) {
    if (digest.previewSentAt) continue;

    const subject = "[Frontier Tower] Weekly event preview (last chance in 24h)";
    const emailText = buildEmailText(digest.leadName, digest.events, true);
    const emailHtml = buildEmailHtml(digest.leadName, digest.events, true);

    if (digest.channels.email) {
      await sendEmail(config, digest.channels.email, subject, emailText, emailHtml);
    }

    if (digest.channels.telegram) {
      const text = buildTelegramText(digest.leadName, digest.events, true, run.id);
      await sendTelegram(config, digest.channels.telegram, text);
    }

    digest.previewSentAt = new Date().toISOString();
  }
}

type FinalizeOptions = {
  config: EnvConfig;
  state: AutomationState;
  runId?: string;
};

async function finalizeRun({ config, state, runId }: FinalizeOptions): Promise<void> {
  const run = getRunById(state, runId);
  const now = Date.now();
  const targets = state.runs.filter((candidate) => {
    if (candidate.status !== "draft") return false;
    if (run && candidate.id !== run.id) return false;
    return new Date(candidate.scheduledSendAt).getTime() <= now;
  });

  if (!targets.length) {
    console.log("No draft runs due for final delivery.");
    return;
  }

  const allActions = loadLeadActions(config);

  for (const item of targets) {
    const actions = allActions.filter((action) => !action.runId || action.runId === item.id);
    const digests = applyActions(item.digests, actions, item.id);

    for (const digest of digests) {
      if (digest.finalSentAt) continue;

      const subject = "[Frontier Tower] This Week's Events";
      const emailText = buildEmailText(digest.leadName, digest.events, false);
      const emailHtml = buildEmailHtml(digest.leadName, digest.events, false);

      if (digest.channels.email) {
        await sendEmail(config, digest.channels.email, subject, emailText, emailHtml);
      }
      if (digest.channels.telegram) {
        const text = buildTelegramText(digest.leadName, digest.events, false, item.id);
        await sendTelegram(config, digest.channels.telegram, text);
      }

      digest.finalSentAt = new Date().toISOString();
    }

    item.status = "finalized";
    console.log(`Finalized run ${item.id} with ${digests.length} recipients.`);
  }
}

function listRuns(state: AutomationState) {
  if (!state.runs.length) {
    console.log("No runs yet.");
    return;
  }

  console.log("Run history:");
  for (const run of state.runs.slice(0, 10)) {
    console.log(
      `- ${run.id} [${run.status}] created=${run.createdAt} sendAt=${run.scheduledSendAt} recipients=${run.digests.length}`,
    );
  }
}

async function main() {
  const args = parseArgs();
  const config = getConfig();
  const state = loadState(config.statePath);

  if (config.lumaUrls.length === 0) {
    throw new Error("Set LUMA_SOURCE_URLS to at least one URL (Luma event page or API endpoint).");
  }

  const runId = parseValueArg("--run-id");

  if (args.has("--list")) {
    listRuns(state);
    return;
  }

  const runOnly = args.has("--create-only");
  const finalizeOnly = args.has("--finalize-only");
  const forceCreate = args.has("--force");

  if (!runOnly && !finalizeOnly) {
    const run = await buildDraft(config, state, forceCreate);
    await sendPreviews(config, run);
    saveState(config.statePath, state);
    await finalizeRun({ config, state, runId });
    saveState(config.statePath, state);
    return;
  }

  if (runOnly) {
    const run = await buildDraft(config, state, forceCreate);
    await sendPreviews(config, run);
    saveState(config.statePath, state);
    console.log(`Created and previewed run ${run.id}`);
  }

  if (finalizeOnly) {
    await finalizeRun({ config, state, runId });
    saveState(config.statePath, state);
  }
}

main().catch((error) => {
  console.error("frontier-luma-newsletter failed:", error);
  process.exit(1);
});
