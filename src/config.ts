import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CRMProvider } from "./types.js";

export type PlatformConfig = {
  // Luma
  lumaApiKey?: string;
  lumaSourceUrls: string[];
  lumaLookaheadDays: number;

  // Email (SendGrid)
  sendgridApiKey?: string;
  fromEmail: string;
  fromName: string;

  // Telegram
  telegramBotToken?: string;
  telegramDefaultChatId?: string;

  // Apollo.io enrichment
  apolloApiKey?: string;

  // CRM
  crmProvider: CRMProvider;
  crmApiKey?: string;
  crmBaseUrl?: string;

  // Twenty (built-in CRM)
  twentyApiKey?: string;
  twentyBaseUrl: string;

  // Hi.Events
  hiEventsApiKey?: string;
  hiEventsBaseUrl: string;

  // Social / DevRel
  githubToken?: string;
  twitterBearerToken?: string;
  linkedinClientId?: string;
  linkedinClientSecret?: string;

  // Platform
  databaseUrl: string;
  reviewWindowHours: number;
  networkEnabled: boolean;

  // Topic keywords for classification
  topicKeywords: Record<string, string[]>;

  // Data paths (for file-based storage, used in dev/small deployments)
  dataDir: string;
};

const DEFAULT_TOPICS: Record<string, string[]> = {
  "Neuro tech": ["neuro", "neuroscience", "brain", "biotech", "biohacking", "neurotech"],
  AI: ["ai", "artificial intelligence", "machine learning", "ml", "llm", "gpt", "agent", "agentic"],
  Crypto: ["crypto", "blockchain", "web3", "token", "defi", "nft", "dao"],
  DevTools: ["developer", "devtools", "sdk", "api", "open source", "oss", "infrastructure"],
  Cloud: ["cloud", "aws", "gcp", "azure", "kubernetes", "k8s", "serverless"],
};

function loadEnvFile(): void {
  for (const name of [".env.local", ".env"]) {
    const envPath = path.resolve(process.cwd(), name);
    if (!existsSync(envPath)) continue;

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
}

function env(key: string, fallback = ""): string {
  return process.env[key]?.trim() ?? fallback;
}

function envList(key: string): string[] {
  const raw = env(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // comma-separated fallback
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function envJson<T>(key: string, fallback: T): T {
  const raw = env(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadConfig(): PlatformConfig {
  loadEnvFile();

  return {
    // Luma
    lumaApiKey: env("LUMA_API_KEY") || undefined,
    lumaSourceUrls: envList("LUMA_SOURCE_URLS"),
    lumaLookaheadDays: Math.max(1, Number(env("LUMA_LOOKAHEAD_DAYS", "30")) || 30),

    // Email
    sendgridApiKey: env("SENDGRID_API_KEY") || undefined,
    fromEmail: env("FROM_EMAIL", "events@frontier-tower.com"),
    fromName: env("FROM_NAME", "Frontier Tower Events"),

    // Telegram
    telegramBotToken: env("TELEGRAM_BOT_TOKEN") || undefined,
    telegramDefaultChatId: env("TELEGRAM_DEFAULT_CHAT_ID") || undefined,

    // Enrichment
    apolloApiKey: env("APOLLO_API_KEY") || undefined,

    // CRM
    crmProvider: (env("CRM_PROVIDER", "twenty") as CRMProvider) || "twenty",
    crmApiKey: env("CRM_API_KEY") || undefined,
    crmBaseUrl: env("CRM_BASE_URL") || undefined,

    // Twenty
    twentyApiKey: env("TWENTY_API_KEY") || undefined,
    twentyBaseUrl: env("TWENTY_BASE_URL", "http://localhost:3000"),

    // Hi.Events
    hiEventsApiKey: env("HI_EVENTS_API_KEY") || undefined,
    hiEventsBaseUrl: env("HI_EVENTS_BASE_URL", "http://localhost:8080"),

    // Social / DevRel
    githubToken: env("GITHUB_TOKEN") || undefined,
    twitterBearerToken: env("TWITTER_BEARER_TOKEN") || undefined,
    linkedinClientId: env("LINKEDIN_CLIENT_ID") || undefined,
    linkedinClientSecret: env("LINKEDIN_CLIENT_SECRET") || undefined,

    // Platform
    databaseUrl: env("DATABASE_URL", "sqlite://data/platform.db"),
    reviewWindowHours: Math.max(1, Number(env("REVIEW_WINDOW_HOURS", "24")) || 24),
    networkEnabled: env("NETWORK_ENABLED", "true") === "true",

    // Topics
    topicKeywords: envJson("TOPIC_KEYWORDS_JSON", DEFAULT_TOPICS),

    // Data
    dataDir: env("DATA_DIR", path.resolve(process.cwd(), "data")),
  };
}
