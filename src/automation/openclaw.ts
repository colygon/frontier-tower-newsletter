/**
 * OpenClaw Integration
 *
 * Uses OpenClaw (https://github.com/openclaw/openclaw) as the AI-powered
 * automation backbone. OpenClaw provides multi-channel messaging
 * (WhatsApp, Telegram, Slack, Discord, etc.) and a plugin system
 * for extending automation capabilities.
 *
 * This module configures OpenClaw as the orchestration layer for:
 * - Multi-channel attendee communication
 * - AI-powered approval decisions
 * - Automated follow-ups and engagement
 * - Social engagement prompts
 */

import type { PlatformConfig } from "../config.js";
import type { Contact, Event, AutomationRule, AutomationTrigger } from "../types.js";

// ---------------------------------------------------------------------------
// OpenClaw Plugin Configuration
// ---------------------------------------------------------------------------

export type OpenClawPluginConfig = {
  /** Plugin name as registered in OpenClaw. */
  name: string;
  /** Whether the plugin is enabled. */
  enabled: boolean;
  /** Plugin-specific settings. */
  settings: Record<string, unknown>;
};

/** Configuration for the Frontier Tower OpenClaw integration. */
export type OpenClawConfig = {
  /** Base URL of the OpenClaw instance. */
  baseUrl: string;
  /** API key for OpenClaw (if running as a service). */
  apiKey?: string;
  /** Enabled communication channels. */
  channels: OpenClawChannel[];
  /** Registered plugins. */
  plugins: OpenClawPluginConfig[];
};

export type OpenClawChannel =
  | "whatsapp"
  | "telegram"
  | "slack"
  | "discord"
  | "email"
  | "sms";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type OpenClawMessage = {
  channel: OpenClawChannel;
  recipientId: string;
  content: string;
  /** Optional rich content (buttons, cards, etc). */
  richContent?: {
    type: "button" | "card" | "carousel";
    data: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
};

export type OpenClawMessageResult = {
  messageId: string;
  channel: OpenClawChannel;
  status: "sent" | "failed" | "queued";
  error?: string;
};

// ---------------------------------------------------------------------------
// OpenClaw Service
// ---------------------------------------------------------------------------

export class OpenClawService {
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(private config: PlatformConfig) {
    this.baseUrl = (process.env.OPENCLAW_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");
    this.apiKey = process.env.OPENCLAW_API_KEY;
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.baseUrl}/api${path}`, {
      ...opts,
      headers: { ...headers, ...opts?.headers },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenClaw API ${response.status}: ${path} - ${body}`);
    }

    return response.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Multi-Channel Messaging
  // -------------------------------------------------------------------------

  /** Send a message through OpenClaw's multi-channel system. */
  async sendMessage(message: OpenClawMessage): Promise<OpenClawMessageResult> {
    return this.request<OpenClawMessageResult>("/messages/send", {
      method: "POST",
      body: JSON.stringify(message),
    });
  }

  /** Send a message to a contact across their preferred channel. */
  async messageContact(
    contact: Contact,
    content: string,
    preferredChannel?: OpenClawChannel,
  ): Promise<OpenClawMessageResult | null> {
    const channel = preferredChannel ?? this.resolveChannel(contact);
    if (!channel) return null;

    const recipientId = this.resolveRecipientId(contact, channel);
    if (!recipientId) return null;

    return this.sendMessage({
      channel,
      recipientId,
      content,
      metadata: {
        contactId: contact.id,
        orgId: contact.orgId,
      },
    });
  }

  /** Broadcast a message to multiple contacts. */
  async broadcast(
    contacts: Contact[],
    content: string,
    channel?: OpenClawChannel,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    for (const contact of contacts) {
      try {
        const result = await this.messageContact(contact, content, channel);
        if (result?.status === "sent" || result?.status === "queued") sent++;
        else failed++;
      } catch {
        failed++;
      }
    }

    return { sent, failed };
  }

  // -------------------------------------------------------------------------
  // Event Automation Workflows
  // -------------------------------------------------------------------------

  /** Notify attendees about an upcoming event via their preferred channel. */
  async notifyUpcomingEvent(contacts: Contact[], event: Event): Promise<void> {
    const message = [
      `Reminder: ${event.title}`,
      `When: ${event.startAt ? new Date(event.startAt).toLocaleString() : "TBD"}`,
      `Where: ${event.location ?? "Online"}`,
      event.url ? `Details: ${event.url}` : "",
    ].filter(Boolean).join("\n");

    await this.broadcast(contacts, message);
  }

  /** Send approval notification to a contact. */
  async notifyApprovalStatus(
    contact: Contact,
    event: Event,
    status: "approved" | "declined" | "waitlisted",
  ): Promise<void> {
    const messages = {
      approved: `Great news! You've been approved for ${event.title}. See you there!${event.url ? `\nDetails: ${event.url}` : ""}`,
      declined: `Thank you for your interest in ${event.title}. Unfortunately, we're unable to accommodate your registration at this time. We hope to see you at future events!`,
      waitlisted: `You've been added to the waitlist for ${event.title}. We'll notify you if a spot opens up!`,
    };

    await this.messageContact(contact, messages[status]);
  }

  /** Send social engagement prompt via OpenClaw channels. */
  async promptSocialEngagement(
    contact: Contact,
    event: Event,
    opts: { hashtags: string[]; incentive?: string },
  ): Promise<void> {
    const lines = [
      `Hey ${contact.firstName}! Thanks for attending ${event.title}.`,
      "",
      "We'd love it if you shared your experience on social media!",
      "",
      `Suggested hashtags: ${opts.hashtags.map((h) => `#${h}`).join(" ")}`,
    ];

    if (opts.incentive) {
      lines.push("", `As a thank you: ${opts.incentive}`);
    }

    await this.messageContact(contact, lines.join("\n"));
  }

  // -------------------------------------------------------------------------
  // Automation Rule Execution
  // -------------------------------------------------------------------------

  /** Execute an automation rule's actions. */
  async executeRule(
    rule: AutomationRule,
    triggerData: { contact?: Contact; event?: Event },
  ): Promise<void> {
    if (!rule.enabled) return;

    for (const action of rule.actions) {
      switch (action.type) {
        case "notify_telegram":
          if (triggerData.contact) {
            const msg = String(action.config.message ?? "Notification from Frontier Tower");
            await this.messageContact(triggerData.contact, msg, "telegram");
          }
          break;

        case "notify_slack":
          if (triggerData.contact) {
            const msg = String(action.config.message ?? "Notification from Frontier Tower");
            await this.messageContact(triggerData.contact, msg, "slack");
          }
          break;

        case "send_email":
          if (triggerData.contact) {
            await this.messageContact(
              triggerData.contact,
              String(action.config.message ?? ""),
              "email",
            );
          }
          break;

        default:
          console.log(`[OPENCLAW] Unhandled action type: ${action.type}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Plugin Management
  // -------------------------------------------------------------------------

  /** Register a custom plugin with OpenClaw. */
  async registerPlugin(plugin: OpenClawPluginConfig): Promise<void> {
    await this.request("/plugins/register", {
      method: "POST",
      body: JSON.stringify(plugin),
    });
  }

  /** Get status of all registered plugins. */
  async getPluginStatus(): Promise<OpenClawPluginConfig[]> {
    return this.request<OpenClawPluginConfig[]>("/plugins");
  }

  // -------------------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    try {
      await this.request("/health");
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resolveChannel(contact: Contact): OpenClawChannel | null {
    // Priority: Telegram > Email > Slack
    if (contact.social.twitter) return "telegram"; // If they have social presence, try telegram
    if (contact.email) return "email";
    return null;
  }

  private resolveRecipientId(contact: Contact, channel: OpenClawChannel): string | null {
    switch (channel) {
      case "email": return contact.email || null;
      case "telegram": return contact.email || null; // OpenClaw resolves internally
      case "whatsapp": return contact.phone || null;
      case "sms": return contact.phone || null;
      default: return contact.email || null;
    }
  }
}
