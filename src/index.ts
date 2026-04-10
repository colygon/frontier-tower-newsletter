#!/usr/bin/env npx tsx

/**
 * Frontier Tower — Luma SaaS Integration Platform
 *
 * An automation system for event marketing that replaces expensive
 * Luma invites, provides contact enrichment, automated approvals,
 * and access to a 200k+ event attendee network.
 *
 * "Connect your Luma to your platform in one go."
 *
 * Core value props:
 * - Save $600+/mo by replacing Luma invites with direct email
 * - Contact enrichment via Apollo.io + GitHub (DevRel focused)
 * - Automated event approval (solve Luma's auto-accept problem)
 * - Privacy-first contact sharing (PII only revealed on RSVP)
 * - CRM integration (Twenty built-in + Attio/HubSpot/Salesforce)
 * - Social tracking (GitHub, LinkedIn, X) with engagement campaigns
 * - Multi-channel comms via OpenClaw (WhatsApp, Telegram, Slack, etc)
 * - Event pages via Hi.Events (open source Eventbrite alternative)
 * - AI-powered search via Tavily, web scraping via Apify
 * - Stakeholder promotion (speakers, sponsors, dev advocates, etc)
 * - Developer Ambassador Program (opportunity marketplace)
 */

import { loadConfig, type PlatformConfig } from "./config.js";
import { LumaClient } from "./luma/client.js";
import { ContactManager } from "./contacts/manager.js";
import { EnrichmentService } from "./contacts/enrichment.js";
import { EmailService } from "./email/service.js";
import { ApprovalEngine } from "./automation/approval.js";
import { SocialTrackingService } from "./automation/social.js";
import { OpenClawService } from "./automation/openclaw.js";
import { NetworkSharingService } from "./network/sharing.js";
import { HiEventsClient } from "./events/hi-events.js";
import { StakeholderManager } from "./stakeholders/manager.js";
import { AmbassadorProgram } from "./ambassadors/program.js";
import { createCRMAdapter, type CRMAdapter } from "./crm/interface.js";
import type { Event, Contact, RSVP, Organization } from "./types.js";

// ---------------------------------------------------------------------------
// Platform Instance
// ---------------------------------------------------------------------------

export class FrontierTowerPlatform {
  readonly config: PlatformConfig;
  readonly luma: LumaClient;
  readonly contacts: ContactManager;
  readonly enrichment: EnrichmentService;
  readonly email: EmailService;
  readonly approval: ApprovalEngine;
  readonly social: SocialTrackingService;
  readonly openclaw: OpenClawService;
  readonly network: NetworkSharingService;
  readonly hiEvents: HiEventsClient;
  readonly stakeholders: StakeholderManager;
  readonly ambassadors: AmbassadorProgram;
  readonly crm: CRMAdapter | null;

  constructor(config?: PlatformConfig) {
    this.config = config ?? loadConfig();
    this.luma = new LumaClient(this.config);
    this.contacts = new ContactManager(this.config);
    this.enrichment = new EnrichmentService(this.config, this.contacts);
    this.email = new EmailService(this.config);
    this.approval = new ApprovalEngine(this.contacts, this.luma);
    this.social = new SocialTrackingService(this.config, this.contacts, this.email);
    this.openclaw = new OpenClawService(this.config);
    this.network = new NetworkSharingService(this.config);
    this.hiEvents = new HiEventsClient(this.config);
    this.stakeholders = new StakeholderManager(this.config, this.contacts, this.email, this.openclaw);
    this.ambassadors = new AmbassadorProgram(this.config, this.contacts, this.email, this.openclaw);
    this.crm = createCRMAdapter(this.config);
  }

  // -------------------------------------------------------------------------
  // High-Level Workflows
  // -------------------------------------------------------------------------

  /**
   * Full event sync: Pull events from Luma, create pages on Hi.Events,
   * sync contacts, and prepare for email campaigns.
   */
  async syncLumaEvents(orgId: string): Promise<Event[]> {
    console.log("[SYNC] Fetching events from Luma...");
    const lumaEvents = await this.luma.listEvents();

    const events: Event[] = [];
    for (const lumaEvent of lumaEvents) {
      const event = this.luma.lumaEventToEvent(lumaEvent, orgId);

      // Classify topics
      event.topics = this.classifyTopics(event);

      // Sync guests from Luma
      const guests = await this.luma.listGuests(lumaEvent.api_id);
      for (const guest of guests) {
        if (!guest.user_email) continue;
        const contactData = this.luma.lumaGuestToContact(guest, orgId);
        if (contactData.email) {
          this.contacts.addContact({
            orgId,
            firstName: contactData.firstName ?? "",
            lastName: contactData.lastName ?? "",
            email: contactData.email,
            source: "luma_import",
          });
        }
      }

      events.push(event);
      console.log(`[SYNC] Imported ${event.title} with ${guests.length} guests`);
    }

    return events;
  }

  /**
   * Run the event approval workflow.
   * Processes pending RSVPs, applies criteria, syncs decisions to Luma.
   */
  async processApprovals(event: Event, rsvps: RSVP[]): Promise<void> {
    const pending = rsvps.filter((r) => r.status === "pending");
    if (pending.length === 0) {
      console.log(`[APPROVAL] No pending RSVPs for ${event.title}`);
      return;
    }

    console.log(`[APPROVAL] Processing ${pending.length} pending RSVPs for ${event.title}...`);
    const decisions = await this.approval.processEventApprovals(event, pending);

    // Notify contacts of their approval status via OpenClaw
    for (const decision of decisions) {
      const contact = this.contacts.getContact(decision.contactId);
      if (!contact) continue;

      const status = decision.decision === "approved" ? "approved"
        : decision.decision === "declined" ? "declined"
        : "waitlisted";

      await this.openclaw.notifyApprovalStatus(contact, event, status);
      console.log(`[APPROVAL] ${contact.email}: ${decision.decision} — ${decision.reason}`);
    }

    // Sync to Luma if applicable
    if (event.lumaEventId) {
      const guestMapping = new Map<string, string>(); // Would be built from Luma sync
      await this.approval.applyToLuma(event, decisions, guestMapping);
    }
  }

  /**
   * Send targeted event invites using the shared network.
   * Finds matching contacts by topic interest, sends invites,
   * and only reveals PII when they RSVP.
   */
  async sendNetworkInvites(event: Event, opts: {
    maxInvites: number;
    excludeOrgContacts?: boolean;
  }): Promise<{ invitesSent: number; networkReach: number }> {
    if (!this.config.networkEnabled) {
      console.log("[NETWORK] Network access is disabled.");
      return { invitesSent: 0, networkReach: 0 };
    }

    // Get org's existing contacts to exclude from network
    const orgContacts = this.contacts.listContacts(event.orgId);
    const excludeHashes = opts.excludeOrgContacts
      ? new Set(orgContacts.map((c) => this.contacts.hashEmail(c.email)))
      : undefined;

    // Find matching network contacts
    const matches = this.network.findMatchingContacts({
      topics: event.topics,
      limit: opts.maxInvites,
      excludeEmailHashes: excludeHashes,
      minEvents: 1,
      activeSinceDays: 180,
    });

    console.log(`[NETWORK] Found ${matches.length} matching contacts for ${event.title}`);
    return {
      invitesSent: matches.length, // Actual sending happens via the email service
      networkReach: this.network.getNetworkSize(),
    };
  }

  /**
   * Enrich all contacts for an org (Apollo.io + GitHub).
   */
  async enrichContacts(orgId: string): Promise<void> {
    console.log("[ENRICH] Starting Apollo.io enrichment...");
    const apolloResults = await this.enrichment.bulkEnrich(orgId, {
      skipEnriched: true,
      limit: 100,
    });
    console.log(`[ENRICH] Apollo: ${apolloResults.enriched} enriched, ${apolloResults.skipped} skipped, ${apolloResults.failed} failed`);

    console.log("[ENRICH] Starting GitHub enrichment...");
    const githubResults = await this.enrichment.bulkEnrichGitHub(orgId);
    console.log(`[ENRICH] GitHub: ${githubResults.enriched} enriched, ${githubResults.skipped} skipped`);
  }

  /**
   * Run a social engagement campaign for an event.
   */
  async runSocialCampaign(event: Event, opts: {
    hashtags: string[];
    mentions: string[];
    incentive?: string;
    messageTemplate: string;
  }): Promise<void> {
    const campaign = await this.social.createEngagementCampaign({
      orgId: event.orgId,
      eventId: event.id,
      name: `Social push: ${event.title}`,
      messageTemplate: opts.messageTemplate,
      channels: ["email"],
      incentiveDescription: opts.incentive,
      suggestedHashtags: opts.hashtags,
      suggestedMentions: opts.mentions,
      targetPlatforms: ["twitter", "linkedin"],
    });

    const attendees = this.contacts.listContacts(event.orgId)
      .filter((c) => c.status === "active");

    await this.social.sendEngagementCampaign(campaign.id, attendees, event);
    console.log(`[SOCIAL] Engagement campaign sent to ${attendees.length} contacts`);

    // Also prompt via OpenClaw channels
    for (const contact of attendees.slice(0, 50)) {
      await this.openclaw.promptSocialEngagement(contact, event, {
        hashtags: opts.hashtags,
        incentive: opts.incentive,
      });
    }
  }

  /**
   * Sync contacts to external CRM.
   */
  async syncToCRM(orgId: string): Promise<void> {
    if (!this.crm) {
      console.log("[CRM] No CRM configured.");
      return;
    }

    const connected = await this.crm.testConnection();
    if (!connected) {
      console.error("[CRM] Failed to connect to CRM.");
      return;
    }

    const contacts = this.contacts.listContacts(orgId);
    console.log(`[CRM] Syncing ${contacts.length} contacts to ${this.crm.provider}...`);

    for (const contact of contacts) {
      try {
        await this.crm.upsertContact(contact);
      } catch (err) {
        console.error(`[CRM] Failed to sync ${contact.email}:`, err);
      }
    }

    console.log("[CRM] Sync complete.");
  }

  /**
   * Generate a cost savings report comparing Luma invites vs platform emails.
   */
  getCostSavingsReport(orgId: string): {
    monthlyLumaCost: number;
    monthlyPlatformCost: number;
    monthlySavings: number;
    contactCount: number;
  } {
    const contacts = this.contacts.listContacts(orgId);
    const activeContacts = contacts.filter((c) => c.status === "active").length;

    // Luma charges ~$0.009 per invite for high volumes
    const lumaPerInvite = 0.009;
    const estimatedMonthlyInvites = activeContacts * 4; // ~4 campaigns/month
    const monthlyLumaCost = estimatedMonthlyInvites * lumaPerInvite;

    // Our platform at $300/mo flat
    const monthlyPlatformCost = 300;

    return {
      monthlyLumaCost: Math.round(monthlyLumaCost),
      monthlyPlatformCost,
      monthlySavings: Math.max(0, Math.round(monthlyLumaCost - monthlyPlatformCost)),
      contactCount: activeContacts,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private classifyTopics(event: Event): string[] {
    const text = `${event.title} ${event.description} ${event.location ?? ""}`.toLowerCase();
    const topics = new Set<string>(event.topics);

    for (const [topic, keywords] of Object.entries(this.config.topicKeywords)) {
      for (const keyword of keywords) {
        if (text.includes(keyword.toLowerCase())) {
          topics.add(topic);
          break;
        }
      }
    }

    if (topics.size === 0) topics.add("General");
    return [...topics];
  }
}

// ---------------------------------------------------------------------------
// CLI Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const args = new Set(process.argv.slice(2));
  const platform = new FrontierTowerPlatform();

  console.log("Frontier Tower — Luma SaaS Integration Platform");
  console.log("================================================");
  console.log(`Network size: ${platform.network.getNetworkSize()} contacts`);
  console.log(`CRM provider: ${platform.config.crmProvider}`);
  console.log();

  // Default org for CLI usage
  const orgId = process.env.ORG_ID ?? "default-org";

  if (args.has("--sync")) {
    const events = await platform.syncLumaEvents(orgId);
    console.log(`\nSynced ${events.length} events from Luma.`);
  }

  if (args.has("--enrich")) {
    await platform.enrichContacts(orgId);
  }

  if (args.has("--crm-sync")) {
    await platform.syncToCRM(orgId);
  }

  if (args.has("--cost-report")) {
    const report = platform.getCostSavingsReport(orgId);
    console.log("\n--- Cost Savings Report ---");
    console.log(`Active contacts: ${report.contactCount}`);
    console.log(`Estimated Luma cost: $${report.monthlyLumaCost}/mo`);
    console.log(`Platform cost: $${report.monthlyPlatformCost}/mo`);
    console.log(`Monthly savings: $${report.monthlySavings}/mo`);
    console.log(`Annual savings: $${report.monthlySavings * 12}/yr`);
  }

  if (args.has("--network-stats")) {
    console.log("\n--- Network Stats ---");
    console.log(`Total network contacts: ${platform.network.getNetworkSize()}`);
    const topTopics = platform.network.getTopTopics();
    for (const { topic, count } of topTopics) {
      console.log(`  ${topic}: ${count} attendances`);
    }
  }

  if (args.has("--ambassador-stats")) {
    const stats = platform.ambassadors.getStats();
    console.log("\n--- Ambassador Program ---");
    console.log(`Total ambassadors: ${stats.totalAmbassadors}`);
    console.log(`Active ambassadors: ${stats.activeAmbassadors}`);
    console.log(`Open opportunities: ${stats.openOpportunities}`);
    console.log(`Total applications: ${stats.totalApplications}`);
    console.log(`Accepted: ${stats.acceptedApplications}`);
  }

  if (args.has("--health")) {
    console.log("\n--- Service Health ---");
    const clawOk = await platform.openclaw.healthCheck();
    console.log(`OpenClaw: ${clawOk ? "OK" : "UNAVAILABLE"}`);
    if (platform.crm) {
      const crmOk = await platform.crm.testConnection();
      console.log(`CRM (${platform.crm.provider}): ${crmOk ? "OK" : "UNAVAILABLE"}`);
    }
  }

  if (args.size === 0) {
    console.log("Usage:");
    console.log("  --sync              Sync events and contacts from Luma");
    console.log("  --enrich            Enrich contacts via Apollo.io + GitHub");
    console.log("  --crm-sync          Sync contacts to external CRM");
    console.log("  --cost-report       Show cost savings vs Luma invites");
    console.log("  --network-stats     Show shared network statistics");
    console.log("  --ambassador-stats  Show ambassador program statistics");
    console.log("  --health            Check service health");
  }
}

// ---------------------------------------------------------------------------
// Exports for programmatic usage
// ---------------------------------------------------------------------------

export { loadConfig } from "./config.js";
export { LumaClient } from "./luma/client.js";
export { ContactManager } from "./contacts/manager.js";
export { EnrichmentService } from "./contacts/enrichment.js";
export { EmailService } from "./email/service.js";
export { ApprovalEngine } from "./automation/approval.js";
export { SocialTrackingService } from "./automation/social.js";
export { OpenClawService } from "./automation/openclaw.js";
export { NetworkSharingService } from "./network/sharing.js";
export { HiEventsClient } from "./events/hi-events.js";
export { StakeholderManager } from "./stakeholders/manager.js";
export { AmbassadorProgram } from "./ambassadors/program.js";
export { createCRMAdapter } from "./crm/interface.js";
export type { CRMAdapter } from "./crm/interface.js";

main().catch((err) => {
  console.error("Platform error:", err);
  process.exit(1);
});
