/**
 * Stakeholder Management & Promotion Module
 *
 * Manages speakers, community leaders, sponsors, workshop instructors,
 * and dev advocates. Provides tools to:
 * - Feature stakeholders on event pages
 * - Generate promotional content for social media
 * - Create speaker/sponsor spotlights for newsletters
 * - Track engagement and reach for each stakeholder
 * - Cross-promote across events and channels
 */

import type { PlatformConfig } from "../config.js";
import type {
  Contact,
  Event,
  EventStakeholder,
  StakeholderRole,
  StakeholderSpotlight,
  SocialProfiles,
  SocialPlatform,
} from "../types.js";
import type { ContactManager } from "../contacts/manager.js";
import type { EmailService } from "../email/service.js";
import type { OpenClawService } from "../automation/openclaw.js";

// ---------------------------------------------------------------------------
// Stakeholder Manager
// ---------------------------------------------------------------------------

export class StakeholderManager {
  private stakeholders: Map<string, EventStakeholder> = new Map();
  private spotlights: Map<string, StakeholderSpotlight> = new Map();

  constructor(
    private config: PlatformConfig,
    private contactManager: ContactManager,
    private emailService: EmailService,
    private openclaw: OpenClawService,
  ) {}

  // -------------------------------------------------------------------------
  // Stakeholder CRUD
  // -------------------------------------------------------------------------

  /** Register a stakeholder for an event. */
  addStakeholder(opts: {
    contactId: string;
    eventId: string;
    orgId: string;
    role: StakeholderRole;
    displayName?: string;
    bio?: string;
    photoUrl?: string;
    sessionTitle?: string;
    sessionDescription?: string;
    representingCompany?: string;
    sponsorTier?: EventStakeholder["sponsorTier"];
    social?: SocialProfiles;
  }): EventStakeholder {
    const contact = this.contactManager.getContact(opts.contactId);
    const displayName = opts.displayName
      ?? (contact ? `${contact.firstName} ${contact.lastName}`.trim() : "Unknown");

    const stakeholder: EventStakeholder = {
      id: crypto.randomUUID(),
      contactId: opts.contactId,
      eventId: opts.eventId,
      orgId: opts.orgId,
      role: opts.role,
      displayName,
      bio: opts.bio,
      photoUrl: opts.photoUrl,
      sessionTitle: opts.sessionTitle,
      sessionDescription: opts.sessionDescription,
      representingCompany: opts.representingCompany,
      sponsorTier: opts.sponsorTier,
      social: opts.social ?? contact?.social ?? {},
      isFeatured: false,
      createdAt: new Date().toISOString(),
    };

    this.stakeholders.set(stakeholder.id, stakeholder);
    return stakeholder;
  }

  /** Get all stakeholders for an event. */
  getEventStakeholders(eventId: string): EventStakeholder[] {
    return [...this.stakeholders.values()].filter((s) => s.eventId === eventId);
  }

  /** Get stakeholders by role. */
  getByRole(eventId: string, role: StakeholderRole): EventStakeholder[] {
    return this.getEventStakeholders(eventId).filter((s) => s.role === role);
  }

  /** Get all speakers for an event. */
  getSpeakers(eventId: string): EventStakeholder[] {
    return this.getByRole(eventId, "speaker");
  }

  /** Get all sponsors for an event. */
  getSponsors(eventId: string): EventStakeholder[] {
    return this.getByRole(eventId, "sponsor");
  }

  /** Get all workshop instructors for an event. */
  getWorkshopInstructors(eventId: string): EventStakeholder[] {
    return this.getByRole(eventId, "workshop_instructor");
  }

  /** Get all dev advocates for an event. */
  getDevAdvocates(eventId: string): EventStakeholder[] {
    return this.getByRole(eventId, "dev_advocate");
  }

  /** Get all community leaders for an event. */
  getCommunityLeaders(eventId: string): EventStakeholder[] {
    return this.getByRole(eventId, "community_leader");
  }

  // -------------------------------------------------------------------------
  // Promotional Content Generation
  // -------------------------------------------------------------------------

  /** Generate a spotlight for a stakeholder. */
  generateSpotlight(stakeholderId: string, event: Event): StakeholderSpotlight {
    const stakeholder = this.stakeholders.get(stakeholderId);
    if (!stakeholder) throw new Error(`Stakeholder not found: ${stakeholderId}`);

    const promo = this.buildPromoContent(stakeholder, event);

    const spotlight: StakeholderSpotlight = {
      id: crypto.randomUUID(),
      stakeholderId,
      eventId: event.id,
      orgId: event.orgId,
      promoContent: promo,
      distributedTo: [],
      createdAt: new Date().toISOString(),
    };

    this.spotlights.set(spotlight.id, spotlight);
    return spotlight;
  }

  /** Generate spotlights for all stakeholders of an event. */
  generateAllSpotlights(event: Event): StakeholderSpotlight[] {
    const stakeholders = this.getEventStakeholders(event.id);
    return stakeholders.map((s) => this.generateSpotlight(s.id, event));
  }

  private buildPromoContent(
    stakeholder: EventStakeholder,
    event: Event,
  ): StakeholderSpotlight["promoContent"] {
    const roleLabels: Record<StakeholderRole, string> = {
      speaker: "Speaker",
      community_leader: "Community Leader",
      sponsor: "Sponsor",
      workshop_instructor: "Workshop Instructor",
      dev_advocate: "Dev Advocate",
      panelist: "Panelist",
      mc: "MC",
      organizer: "Organizer",
    };

    const roleLabel = roleLabels[stakeholder.role];
    const sessionPart = stakeholder.sessionTitle
      ? ` presenting "${stakeholder.sessionTitle}"`
      : "";
    const companyPart = stakeholder.representingCompany
      ? ` from ${stakeholder.representingCompany}`
      : "";

    const headline = `Meet our ${roleLabel}: ${stakeholder.displayName}${companyPart}`;

    const bodyParts = [
      `We're excited to feature ${stakeholder.displayName} as a ${roleLabel} at ${event.title}!`,
    ];

    if (stakeholder.sessionTitle) {
      bodyParts.push(`They'll be${sessionPart}.`);
    }

    if (stakeholder.bio) {
      bodyParts.push(stakeholder.bio);
    }

    if (stakeholder.sponsorTier) {
      bodyParts.push(`${stakeholder.representingCompany} is a ${stakeholder.sponsorTier} sponsor of this event.`);
    }

    bodyParts.push(
      event.url ? `Register: ${event.url}` : "",
    );

    // Build mention handles
    const mentionHandles: string[] = [];
    if (stakeholder.social.twitter) mentionHandles.push(stakeholder.social.twitter);
    if (stakeholder.social.linkedin) mentionHandles.push(stakeholder.social.linkedin);

    // Build hashtags
    const hashtags = [
      ...event.topics.map((t) => t.replace(/\s+/g, "")),
      event.title.replace(/\s+/g, ""),
    ];

    if (stakeholder.role === "speaker") hashtags.push("speaker");
    if (stakeholder.role === "dev_advocate") hashtags.push("DevRel", "DevAdvocate");
    if (stakeholder.role === "workshop_instructor") hashtags.push("workshop", "handson");
    if (stakeholder.sponsorTier) hashtags.push("sponsor");

    return {
      headline,
      body: bodyParts.filter(Boolean).join("\n\n"),
      hashtags,
      mentionHandles,
    };
  }

  // -------------------------------------------------------------------------
  // Distribution
  // -------------------------------------------------------------------------

  /** Send stakeholder spotlight via email to the contact list. */
  async distributeSpotlightViaEmail(
    spotlightId: string,
    contacts: Contact[],
  ): Promise<void> {
    const spotlight = this.spotlights.get(spotlightId);
    if (!spotlight) throw new Error(`Spotlight not found: ${spotlightId}`);

    const stakeholder = this.stakeholders.get(spotlight.stakeholderId);
    if (!stakeholder) return;

    await this.emailService.sendBulk(
      contacts,
      (contact) => ({
        subject: spotlight.promoContent.headline,
        text: spotlight.promoContent.body,
        html: this.buildSpotlightEmailHtml(stakeholder, spotlight),
      }),
      ["stakeholder_spotlight", stakeholder.role],
    );

    spotlight.distributedTo.push("email");
  }

  /** Share stakeholder spotlight via OpenClaw channels. */
  async distributeSpotlightViaOpenClaw(
    spotlightId: string,
    contacts: Contact[],
  ): Promise<void> {
    const spotlight = this.spotlights.get(spotlightId);
    if (!spotlight) return;

    const message = [
      spotlight.promoContent.headline,
      "",
      spotlight.promoContent.body,
      "",
      spotlight.promoContent.hashtags.map((h) => `#${h}`).join(" "),
    ].join("\n");

    await this.openclaw.broadcast(contacts.slice(0, 100), message);
    spotlight.distributedTo.push("telegram");
  }

  /** Generate social media post text for a stakeholder spotlight. */
  getSocialPostText(spotlightId: string, platform: SocialPlatform): string {
    const spotlight = this.spotlights.get(spotlightId);
    if (!spotlight) return "";

    const stakeholder = this.stakeholders.get(spotlight.stakeholderId);
    if (!stakeholder) return "";

    const { headline, hashtags, mentionHandles } = spotlight.promoContent;

    if (platform === "twitter") {
      // Twitter: keep it short
      const mentions = mentionHandles.length > 0
        ? mentionHandles.map((h) => h.startsWith("@") ? h : `@${h}`).join(" ")
        : "";
      const hashtagStr = hashtags.slice(0, 3).map((h) => `#${h}`).join(" ");
      return `${headline}\n\n${mentions}\n\n${hashtagStr}`.trim();
    }

    if (platform === "linkedin") {
      return [
        headline,
        "",
        spotlight.promoContent.body,
        "",
        hashtags.map((h) => `#${h}`).join(" "),
      ].join("\n");
    }

    // GitHub (e.g., for discussion posts)
    return [
      `## ${headline}`,
      "",
      spotlight.promoContent.body,
      "",
      stakeholder.social.github ? `GitHub: ${stakeholder.social.github}` : "",
    ].filter(Boolean).join("\n");
  }

  // -------------------------------------------------------------------------
  // Event Page Data (for Hi.Events integration)
  // -------------------------------------------------------------------------

  /** Get structured data for rendering on event pages. */
  getEventPageData(eventId: string): {
    speakers: StakeholderPageEntry[];
    sponsors: StakeholderPageEntry[];
    workshopInstructors: StakeholderPageEntry[];
    devAdvocates: StakeholderPageEntry[];
    communityLeaders: StakeholderPageEntry[];
  } {
    const toEntry = (s: EventStakeholder): StakeholderPageEntry => ({
      name: s.displayName,
      role: s.role,
      bio: s.bio,
      photoUrl: s.photoUrl,
      company: s.representingCompany,
      sessionTitle: s.sessionTitle,
      sessionDescription: s.sessionDescription,
      sponsorTier: s.sponsorTier,
      social: s.social,
    });

    return {
      speakers: this.getSpeakers(eventId).map(toEntry),
      sponsors: this.getSponsors(eventId).map(toEntry),
      workshopInstructors: this.getWorkshopInstructors(eventId).map(toEntry),
      devAdvocates: this.getDevAdvocates(eventId).map(toEntry),
      communityLeaders: this.getCommunityLeaders(eventId).map(toEntry),
    };
  }

  // -------------------------------------------------------------------------
  // Email HTML
  // -------------------------------------------------------------------------

  private buildSpotlightEmailHtml(
    stakeholder: EventStakeholder,
    spotlight: StakeholderSpotlight,
  ): string {
    const roleColors: Record<StakeholderRole, string> = {
      speaker: "#6366f1",
      community_leader: "#059669",
      sponsor: "#d97706",
      workshop_instructor: "#0891b2",
      dev_advocate: "#7c3aed",
      panelist: "#6366f1",
      mc: "#4f46e5",
      organizer: "#1d4ed8",
    };

    const color = roleColors[stakeholder.role] ?? "#6366f1";

    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #111827;">
      <div style="background: ${color}; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">${spotlight.promoContent.headline}</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; padding: 24px;">
        ${stakeholder.photoUrl ? `<img src="${stakeholder.photoUrl}" alt="${stakeholder.displayName}" style="width: 120px; height: 120px; border-radius: 50%; float: right; margin-left: 16px;" />` : ""}
        <h3 style="margin-top: 0;">${stakeholder.displayName}</h3>
        ${stakeholder.representingCompany ? `<p style="color: #6b7280; margin-top: -8px;">${stakeholder.representingCompany}</p>` : ""}
        ${stakeholder.sessionTitle ? `<p><strong>Session:</strong> ${stakeholder.sessionTitle}</p>` : ""}
        ${stakeholder.sessionDescription ? `<p>${stakeholder.sessionDescription}</p>` : ""}
        ${stakeholder.bio ? `<p>${stakeholder.bio}</p>` : ""}
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e7eb;">
          ${stakeholder.social.twitter ? `<a href="https://x.com/${stakeholder.social.twitter}" style="color: ${color}; margin-right: 16px;">X/Twitter</a>` : ""}
          ${stakeholder.social.linkedin ? `<a href="${stakeholder.social.linkedin}" style="color: ${color}; margin-right: 16px;">LinkedIn</a>` : ""}
          ${stakeholder.social.github ? `<a href="https://github.com/${stakeholder.social.github}" style="color: ${color}; margin-right: 16px;">GitHub</a>` : ""}
        </div>
      </div>
      <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">${spotlight.promoContent.hashtags.map((h) => `#${h}`).join(" ")}</p>
    </div>`.trim();
  }
}

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export type StakeholderPageEntry = {
  name: string;
  role: StakeholderRole;
  bio?: string;
  photoUrl?: string;
  company?: string;
  sessionTitle?: string;
  sessionDescription?: string;
  sponsorTier?: EventStakeholder["sponsorTier"];
  social: SocialProfiles;
};
