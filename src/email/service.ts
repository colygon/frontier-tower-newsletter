/**
 * Email Service
 *
 * Replaces Luma's expensive invite system. Instead of paying $900/mo
 * for 100k Luma invites, send emails via SendGrid for ~$300/mo.
 * Handles event invites, newsletters, follow-ups, and waitlist updates.
 */

import type { PlatformConfig } from "../config.js";
import type { Campaign, CampaignStats, Contact, Event } from "../types.js";

export class EmailService {
  constructor(private config: PlatformConfig) {}

  // -------------------------------------------------------------------------
  // Core sending
  // -------------------------------------------------------------------------

  /** Send a single email via SendGrid. */
  async send(opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
    tags?: string[];
  }): Promise<boolean> {
    if (!this.config.sendgridApiKey) {
      console.log(`[EMAIL DRY RUN] to=${opts.to} subject=${opts.subject}`);
      return true;
    }

    const payload = {
      personalizations: [{ to: [{ email: opts.to }] }],
      from: { email: this.config.fromEmail, name: this.config.fromName },
      reply_to: opts.replyTo ? { email: opts.replyTo } : undefined,
      subject: opts.subject,
      content: [
        { type: "text/plain", value: opts.text },
        { type: "text/html", value: opts.html },
      ],
      categories: opts.tags,
      tracking_settings: {
        click_tracking: { enable: true },
        open_tracking: { enable: true },
      },
    };

    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.sendgridApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[EMAIL FAILED] ${opts.to}: ${response.status} ${body}`);
      return false;
    }

    return true;
  }

  /** Send bulk emails (batch via SendGrid). */
  async sendBulk(
    contacts: Contact[],
    buildContent: (contact: Contact) => { subject: string; text: string; html: string },
    tags?: string[],
  ): Promise<CampaignStats> {
    const stats: CampaignStats = {
      totalSent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      unsubscribed: 0,
      rsvpd: 0,
    };

    for (const contact of contacts) {
      if (contact.status !== "active") continue;

      const content = buildContent(contact);
      const success = await this.send({
        to: contact.email,
        ...content,
        tags,
      });

      stats.totalSent++;
      if (success) stats.delivered++;
      else stats.bounced++;
    }

    return stats;
  }

  // -------------------------------------------------------------------------
  // Event Invite Emails (replaces Luma invites)
  // -------------------------------------------------------------------------

  /** Send event invite emails to a list of contacts. */
  async sendEventInvites(contacts: Contact[], event: Event): Promise<CampaignStats> {
    return this.sendBulk(
      contacts,
      (contact) => ({
        subject: `You're invited: ${event.title}`,
        text: this.buildInviteText(contact, event),
        html: this.buildInviteHtml(contact, event),
      }),
      ["event_invite", event.id],
    );
  }

  /** Send follow-up to waitlisted contacts. */
  async sendWaitlistFollowUp(contacts: Contact[], event: Event): Promise<CampaignStats> {
    return this.sendBulk(
      contacts,
      (contact) => ({
        subject: `Update on ${event.title} — You're on the waitlist`,
        text: this.buildWaitlistText(contact, event),
        html: this.buildWaitlistHtml(contact, event),
      }),
      ["waitlist_followup", event.id],
    );
  }

  /** Send weekly newsletter digest. */
  async sendNewsletter(contacts: Contact[], events: Event[], isDraft: boolean): Promise<CampaignStats> {
    return this.sendBulk(
      contacts,
      (contact) => ({
        subject: isDraft
          ? "[Preview] This Week's Events"
          : "This Week's Events",
        text: this.buildNewsletterText(contact, events, isDraft),
        html: this.buildNewsletterHtml(contact, events, isDraft),
      }),
      ["newsletter", isDraft ? "preview" : "final"],
    );
  }

  // -------------------------------------------------------------------------
  // Social engagement outreach
  // -------------------------------------------------------------------------

  /** Send a message asking attendees to post about the event on social. */
  async sendSocialEngagementRequest(
    contacts: Contact[],
    event: Event,
    opts: {
      messageTemplate: string;
      hashtags: string[];
      mentions: string[];
    },
  ): Promise<CampaignStats> {
    return this.sendBulk(
      contacts,
      (contact) => {
        const personalizedMessage = opts.messageTemplate
          .replace("{{name}}", contact.firstName)
          .replace("{{event}}", event.title)
          .replace("{{hashtags}}", opts.hashtags.map((h) => `#${h}`).join(" "))
          .replace("{{mentions}}", opts.mentions.map((m) => `@${m}`).join(" "));

        return {
          subject: `Share your experience at ${event.title}!`,
          text: personalizedMessage,
          html: this.buildSocialEngagementHtml(contact, event, personalizedMessage, opts.hashtags),
        };
      },
      ["social_engagement", event.id],
    );
  }

  // -------------------------------------------------------------------------
  // Email Templates
  // -------------------------------------------------------------------------

  private buildInviteHtml(contact: Contact, event: Event): string {
    const when = event.startAt
      ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })
      : "TBD";

    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #111827;">
      <h2 style="margin-bottom: 8px;">You're Invited</h2>
      <p>Hi ${contact.firstName},</p>
      <p>We'd love for you to join us at <strong>${event.title}</strong>.</p>
      <div style="background: #f9fafb; border-left: 4px solid #6366f1; padding: 16px; margin: 16px 0; border-radius: 4px;">
        <p style="margin: 0 0 4px;"><strong>${event.title}</strong></p>
        <p style="margin: 0 0 4px; color: #6b7280;">${when}</p>
        <p style="margin: 0 0 4px; color: #6b7280;">${event.location ?? "Online"}</p>
        ${event.url ? `<a href="${event.url}" style="color: #6366f1; text-decoration: none;">View Details & RSVP &rarr;</a>` : ""}
      </div>
      <p>${event.description.slice(0, 300)}${event.description.length > 300 ? "..." : ""}</p>
      ${event.url ? `<a href="${event.url}" style="display: inline-block; background: #6366f1; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 8px;">RSVP Now</a>` : ""}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="font-size: 12px; color: #9ca3af;">This invite was sent based on your interest in ${event.topics.join(", ") || "events like this"}. Reply STOP to unsubscribe.</p>
    </div>`.trim();
  }

  private buildInviteText(contact: Contact, event: Event): string {
    const when = event.startAt
      ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })
      : "TBD";

    return [
      `Hi ${contact.firstName},`,
      "",
      `You're invited to: ${event.title}`,
      `When: ${when}`,
      `Where: ${event.location ?? "Online"}`,
      event.url ? `RSVP: ${event.url}` : "",
      "",
      event.description.slice(0, 300),
      "",
      "Reply STOP to unsubscribe.",
    ].filter((l) => l !== undefined).join("\n");
  }

  private buildWaitlistHtml(contact: Contact, event: Event): string {
    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #111827;">
      <h2>Waitlist Update</h2>
      <p>Hi ${contact.firstName},</p>
      <p>You're currently on the waitlist for <strong>${event.title}</strong>. We wanted to let you know we haven't forgotten about you.</p>
      <p>We'll notify you as soon as a spot opens up. In the meantime, feel free to check out our other upcoming events.</p>
      ${event.url ? `<a href="${event.url}" style="color: #6366f1;">View event details</a>` : ""}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="font-size: 12px; color: #9ca3af;">Reply STOP to unsubscribe.</p>
    </div>`.trim();
  }

  private buildWaitlistText(contact: Contact, event: Event): string {
    return [
      `Hi ${contact.firstName},`,
      "",
      `Waitlist update for: ${event.title}`,
      "You're on the waitlist. We'll notify you when a spot opens.",
      event.url ? `Details: ${event.url}` : "",
      "",
      "Reply STOP to unsubscribe.",
    ].join("\n");
  }

  private buildNewsletterHtml(contact: Contact, events: Event[], isDraft: boolean): string {
    const rows = events
      .map((event) => {
        const when = event.startAt
          ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
          : "TBD";
        return `
        <div style="border-bottom: 1px solid #e5e7eb; padding: 12px 0;">
          <strong>${event.title}</strong>
          <span style="color: #6b7280;"> &mdash; ${when} &bull; ${event.location ?? "Online"}</span>
          ${event.url ? `<br><a href="${event.url}" style="color: #6366f1; font-size: 14px;">Details &rarr;</a>` : ""}
        </div>`;
      })
      .join("");

    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #111827;">
      <h2>${isDraft ? "[Preview] " : ""}This Week's Events</h2>
      <p>Hi ${contact.firstName},</p>
      <p>${isDraft ? "Here's a preview of" : "Here are"} this week's upcoming events curated for your interests.</p>
      ${rows}
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="font-size: 12px; color: #9ca3af;">You're receiving this because you're interested in ${contact.interests.join(", ") || "our events"}. Reply STOP to unsubscribe or CHANGE: topic1,topic2 to update preferences.</p>
    </div>`.trim();
  }

  private buildNewsletterText(contact: Contact, events: Event[], isDraft: boolean): string {
    const lines = [
      isDraft ? "[Preview] This Week's Events" : "This Week's Events",
      `Hi ${contact.firstName},`,
      "",
      ...events.map((event) => {
        const when = event.startAt
          ? new Date(event.startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
          : "TBD";
        return `- ${event.title} — ${when} • ${event.location ?? "Online"}${event.url ? ` (${event.url})` : ""}`;
      }),
      "",
      "Reply STOP to unsubscribe.",
    ];
    return lines.join("\n");
  }

  private buildSocialEngagementHtml(
    contact: Contact,
    event: Event,
    message: string,
    hashtags: string[],
  ): string {
    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #111827;">
      <h2>Share Your Experience!</h2>
      <p>${message.replace(/\n/g, "<br>")}</p>
      <div style="background: #f0f9ff; border-radius: 8px; padding: 16px; margin: 16px 0;">
        <p style="margin: 0 0 8px; font-weight: 600;">Suggested hashtags:</p>
        <p style="margin: 0; color: #6366f1;">${hashtags.map((h) => `#${h}`).join(" ")}</p>
      </div>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
      <p style="font-size: 12px; color: #9ca3af;">Reply STOP to unsubscribe.</p>
    </div>`.trim();
  }
}
