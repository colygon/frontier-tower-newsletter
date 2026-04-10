/**
 * Developer Ambassador Program
 *
 * A marketplace connecting developer ambassadors with event opportunities.
 * Ambassadors sign up with their expertise and interests, and get matched
 * with speaking gigs, workshops, meetups, hackathons, and more.
 *
 * Features:
 * - Ambassador profiles with expertise, social, and availability
 * - Opportunity board (organizers post, ambassadors apply)
 * - Smart matching by topic, location, and experience
 * - Reputation scoring based on past events and feedback
 * - Auto-populated experience from event history
 */

import type { PlatformConfig } from "../config.js";
import type {
  DevAmbassador,
  AmbassadorOpportunity,
  AmbassadorApplication,
  AmbassadorExperience,
  AmbassadorStatus,
  OpportunityType,
  Contact,
  Event,
  SocialProfiles,
} from "../types.js";
import type { ContactManager } from "../contacts/manager.js";
import type { EmailService } from "../email/service.js";
import type { OpenClawService } from "../automation/openclaw.js";

export class AmbassadorProgram {
  private ambassadors: Map<string, DevAmbassador> = new Map();
  private opportunities: Map<string, AmbassadorOpportunity> = new Map();

  constructor(
    private config: PlatformConfig,
    private contactManager: ContactManager,
    private emailService: EmailService,
    private openclaw: OpenClawService,
  ) {}

  // -------------------------------------------------------------------------
  // Ambassador Registration
  // -------------------------------------------------------------------------

  /** Sign up as a developer ambassador. */
  applyAsAmbassador(opts: {
    contactId: string;
    displayName: string;
    bio: string;
    social?: SocialProfiles;
    expertise: string[];
    languages?: string[];
    availableLocations?: string[];
    interestedIn: OpportunityType[];
  }): DevAmbassador {
    const existing = this.findAmbassadorByContact(opts.contactId);
    if (existing) {
      return this.updateAmbassador(existing.id, opts);
    }

    const ambassador: DevAmbassador = {
      id: crypto.randomUUID(),
      contactId: opts.contactId,
      displayName: opts.displayName,
      bio: opts.bio,
      social: opts.social ?? {},
      expertise: opts.expertise,
      languages: opts.languages ?? ["English"],
      availableLocations: opts.availableLocations ?? [],
      interestedIn: opts.interestedIn,
      pastExperience: [],
      reputationScore: 0,
      status: "applied",
      appliedAt: new Date().toISOString(),
    };

    this.ambassadors.set(ambassador.id, ambassador);
    return ambassador;
  }

  /** Activate an ambassador (approve their application). */
  activateAmbassador(ambassadorId: string): DevAmbassador {
    const ambassador = this.ambassadors.get(ambassadorId);
    if (!ambassador) throw new Error(`Ambassador not found: ${ambassadorId}`);

    ambassador.status = "active";
    ambassador.activatedAt = new Date().toISOString();
    return ambassador;
  }

  /** Update ambassador profile. */
  updateAmbassador(id: string, updates: Partial<DevAmbassador>): DevAmbassador {
    const ambassador = this.ambassadors.get(id);
    if (!ambassador) throw new Error(`Ambassador not found: ${id}`);

    Object.assign(ambassador, updates, { id: ambassador.id, contactId: ambassador.contactId });
    return ambassador;
  }

  /** Get ambassador by ID. */
  getAmbassador(id: string): DevAmbassador | undefined {
    return this.ambassadors.get(id);
  }

  /** Find ambassador by contact ID. */
  findAmbassadorByContact(contactId: string): DevAmbassador | undefined {
    return [...this.ambassadors.values()].find((a) => a.contactId === contactId);
  }

  /** List all active ambassadors. */
  listActiveAmbassadors(): DevAmbassador[] {
    return [...this.ambassadors.values()].filter((a) => a.status === "active");
  }

  // -------------------------------------------------------------------------
  // Opportunity Management
  // -------------------------------------------------------------------------

  /** Post an opportunity for ambassadors. */
  postOpportunity(opts: {
    orgId: string;
    eventId?: string;
    type: OpportunityType;
    title: string;
    description: string;
    topics: string[];
    location?: string;
    isRemote?: boolean;
    date?: string;
    compensation?: AmbassadorOpportunity["compensation"];
    requirements?: string[];
    spotsAvailable?: number;
  }): AmbassadorOpportunity {
    const opportunity: AmbassadorOpportunity = {
      id: crypto.randomUUID(),
      orgId: opts.orgId,
      eventId: opts.eventId,
      type: opts.type,
      title: opts.title,
      description: opts.description,
      topics: opts.topics,
      location: opts.location,
      isRemote: opts.isRemote ?? false,
      date: opts.date,
      compensation: opts.compensation,
      requirements: opts.requirements ?? [],
      spotsAvailable: opts.spotsAvailable ?? 1,
      status: "open",
      applications: [],
      createdAt: new Date().toISOString(),
    };

    this.opportunities.set(opportunity.id, opportunity);
    return opportunity;
  }

  /** List open opportunities, optionally filtered. */
  listOpenOpportunities(filters?: {
    type?: OpportunityType;
    topics?: string[];
    location?: string;
    isRemote?: boolean;
  }): AmbassadorOpportunity[] {
    let results = [...this.opportunities.values()].filter((o) => o.status === "open");

    if (filters?.type) {
      results = results.filter((o) => o.type === filters.type);
    }
    if (filters?.topics?.length) {
      const topicSet = new Set(filters.topics.map((t) => t.toLowerCase()));
      results = results.filter((o) =>
        o.topics.some((t) => topicSet.has(t.toLowerCase())),
      );
    }
    if (filters?.location) {
      results = results.filter((o) =>
        o.location?.toLowerCase().includes(filters.location!.toLowerCase()) || o.isRemote,
      );
    }
    if (filters?.isRemote) {
      results = results.filter((o) => o.isRemote);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Applications
  // -------------------------------------------------------------------------

  /** Apply to an opportunity. */
  applyToOpportunity(ambassadorId: string, opportunityId: string, coverNote: string): AmbassadorApplication {
    const ambassador = this.ambassadors.get(ambassadorId);
    if (!ambassador) throw new Error(`Ambassador not found: ${ambassadorId}`);

    const opportunity = this.opportunities.get(opportunityId);
    if (!opportunity) throw new Error(`Opportunity not found: ${opportunityId}`);

    if (opportunity.status !== "open") {
      throw new Error("Opportunity is no longer accepting applications.");
    }

    const existingApp = opportunity.applications.find((a) => a.ambassadorId === ambassadorId);
    if (existingApp) {
      throw new Error("Already applied to this opportunity.");
    }

    const application: AmbassadorApplication = {
      id: crypto.randomUUID(),
      ambassadorId,
      opportunityId,
      coverNote,
      status: "pending",
      appliedAt: new Date().toISOString(),
    };

    opportunity.applications.push(application);
    return application;
  }

  /** Accept an application. */
  acceptApplication(opportunityId: string, applicationId: string): void {
    const opportunity = this.opportunities.get(opportunityId);
    if (!opportunity) throw new Error(`Opportunity not found: ${opportunityId}`);

    const application = opportunity.applications.find((a) => a.id === applicationId);
    if (!application) throw new Error(`Application not found: ${applicationId}`);

    application.status = "accepted";
    application.respondedAt = new Date().toISOString();

    // Check if all spots are filled
    const acceptedCount = opportunity.applications.filter((a) => a.status === "accepted").length;
    if (acceptedCount >= opportunity.spotsAvailable) {
      opportunity.status = "filled";
    }
  }

  /** Decline an application. */
  declineApplication(opportunityId: string, applicationId: string): void {
    const opportunity = this.opportunities.get(opportunityId);
    if (!opportunity) throw new Error(`Opportunity not found: ${opportunityId}`);

    const application = opportunity.applications.find((a) => a.id === applicationId);
    if (!application) throw new Error(`Application not found: ${applicationId}`);

    application.status = "declined";
    application.respondedAt = new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Smart Matching
  // -------------------------------------------------------------------------

  /** Find the best ambassador matches for an opportunity. */
  findMatches(opportunityId: string, limit = 20): { ambassador: DevAmbassador; score: number }[] {
    const opportunity = this.opportunities.get(opportunityId);
    if (!opportunity) return [];

    const candidates = this.listActiveAmbassadors();
    const scored: { ambassador: DevAmbassador; score: number }[] = [];

    for (const ambassador of candidates) {
      let score = 0;

      // Topic/expertise match
      for (const topic of opportunity.topics) {
        if (ambassador.expertise.some((e) => e.toLowerCase().includes(topic.toLowerCase()))) {
          score += 10;
        }
      }

      // Opportunity type interest match
      if (ambassador.interestedIn.includes(opportunity.type)) {
        score += 5;
      }

      // Location match
      if (opportunity.isRemote) {
        score += 2; // Anyone can do remote
      } else if (opportunity.location) {
        if (ambassador.availableLocations.some((l) =>
          l.toLowerCase().includes(opportunity.location!.toLowerCase()),
        )) {
          score += 8;
        }
      }

      // Reputation bonus
      score += ambassador.reputationScore * 0.5;

      // Experience in similar roles
      const similarExp = ambassador.pastExperience.filter((e) => {
        const roleTypeMap: Record<string, OpportunityType[]> = {
          speaker: ["conference_speaker"],
          workshop_instructor: ["workshop_instructor"],
          panelist: ["panelist", "podcast_guest"],
          dev_advocate: ["dev_advocate_role"],
          community_leader: ["meetup_organizer", "community_manager"],
        };

        for (const [_role, types] of Object.entries(roleTypeMap)) {
          if (types.includes(opportunity.type)) return true;
        }
        return false;
      });
      score += similarExp.length * 3;

      if (score > 0) {
        scored.push({ ambassador, score });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Experience & Reputation
  // -------------------------------------------------------------------------

  /** Add experience to an ambassador's profile (called after an event). */
  addExperience(ambassadorId: string, experience: AmbassadorExperience): void {
    const ambassador = this.ambassadors.get(ambassadorId);
    if (!ambassador) return;

    ambassador.pastExperience.push(experience);
    this.recalculateReputation(ambassadorId);
  }

  /** Record feedback for an ambassador from an organizer or attendees. */
  addFeedback(ambassadorId: string, eventId: string, feedback: {
    organizerRating?: number;
    attendeeRating?: number;
  }): void {
    const ambassador = this.ambassadors.get(ambassadorId);
    if (!ambassador) return;

    const exp = ambassador.pastExperience.find((e) => e.eventId === eventId);
    if (exp) {
      if (feedback.organizerRating) exp.organizerRating = feedback.organizerRating;
      if (feedback.attendeeRating) exp.attendeeRating = feedback.attendeeRating;
    }

    this.recalculateReputation(ambassadorId);
  }

  private recalculateReputation(ambassadorId: string): void {
    const ambassador = this.ambassadors.get(ambassadorId);
    if (!ambassador) return;

    let score = 0;

    // Base points for activity
    score += ambassador.pastExperience.length * 5;

    // Rating bonus
    for (const exp of ambassador.pastExperience) {
      if (exp.organizerRating) score += exp.organizerRating * 2;
      if (exp.attendeeRating) score += exp.attendeeRating * 3;
    }

    // Social presence bonus
    if (ambassador.social.github) score += 3;
    if (ambassador.social.twitter) score += 2;
    if (ambassador.social.linkedin) score += 2;

    ambassador.reputationScore = score;
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Notify matching ambassadors about a new opportunity. */
  async notifyMatchingAmbassadors(opportunityId: string): Promise<number> {
    const matches = this.findMatches(opportunityId, 50);
    const opportunity = this.opportunities.get(opportunityId);
    if (!opportunity || matches.length === 0) return 0;

    let notified = 0;

    for (const { ambassador } of matches) {
      const contact = this.contactManager.getContact(ambassador.contactId);
      if (!contact) continue;

      const message = [
        `New opportunity that matches your profile!`,
        "",
        `${opportunity.title}`,
        `Type: ${opportunity.type.replace(/_/g, " ")}`,
        `Topics: ${opportunity.topics.join(", ")}`,
        opportunity.location ? `Location: ${opportunity.location}${opportunity.isRemote ? " (remote ok)" : ""}` : "Remote",
        opportunity.compensation ? `Compensation: ${opportunity.compensation.type}${opportunity.compensation.amount ? ` ($${opportunity.compensation.amount})` : ""}` : "",
        "",
        opportunity.description.slice(0, 200),
      ].filter(Boolean).join("\n");

      await this.openclaw.messageContact(contact, message);
      notified++;
    }

    return notified;
  }

  /** Send weekly digest of new opportunities to all active ambassadors. */
  async sendWeeklyDigest(): Promise<void> {
    const openOpps = this.listOpenOpportunities();
    if (openOpps.length === 0) return;

    const ambassadors = this.listActiveAmbassadors();

    for (const ambassador of ambassadors) {
      const contact = this.contactManager.getContact(ambassador.contactId);
      if (!contact) continue;

      // Filter to opportunities matching their interests
      const relevant = openOpps.filter((opp) =>
        ambassador.interestedIn.includes(opp.type) ||
        opp.topics.some((t) => ambassador.expertise.some((e) =>
          e.toLowerCase().includes(t.toLowerCase()),
        )),
      );

      if (relevant.length === 0) continue;

      const subject = `${relevant.length} new opportunities for you this week`;
      const text = [
        `Hi ${ambassador.displayName},`,
        "",
        `Here are ${relevant.length} opportunities matching your profile:`,
        "",
        ...relevant.slice(0, 10).map((opp, i) =>
          `${i + 1}. ${opp.title} (${opp.type.replace(/_/g, " ")}) — ${opp.topics.join(", ")}`,
        ),
        "",
        "Log in to apply!",
      ].join("\n");

      await this.emailService.send({
        to: contact.email,
        subject,
        text,
        html: this.buildDigestHtml(ambassador, relevant),
        tags: ["ambassador_digest"],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalAmbassadors: number;
    activeAmbassadors: number;
    openOpportunities: number;
    totalApplications: number;
    acceptedApplications: number;
  } {
    const allApps = [...this.opportunities.values()].flatMap((o) => o.applications);

    return {
      totalAmbassadors: this.ambassadors.size,
      activeAmbassadors: this.listActiveAmbassadors().length,
      openOpportunities: this.listOpenOpportunities().length,
      totalApplications: allApps.length,
      acceptedApplications: allApps.filter((a) => a.status === "accepted").length,
    };
  }

  // -------------------------------------------------------------------------
  // HTML
  // -------------------------------------------------------------------------

  private buildDigestHtml(ambassador: DevAmbassador, opportunities: AmbassadorOpportunity[]): string {
    const rows = opportunities.slice(0, 10).map((opp) => `
      <div style="border-bottom: 1px solid #e5e7eb; padding: 12px 0;">
        <strong>${opp.title}</strong>
        <span style="color: #6b7280;"> — ${opp.type.replace(/_/g, " ")}</span>
        <br>
        <span style="font-size: 14px; color: #6b7280;">Topics: ${opp.topics.join(", ")}</span>
        ${opp.location ? `<br><span style="font-size: 14px; color: #6b7280;">Location: ${opp.location}${opp.isRemote ? " (remote ok)" : ""}</span>` : ""}
        ${opp.compensation ? `<br><span style="font-size: 14px; color: #059669;">Compensation: ${opp.compensation.type}${opp.compensation.amount ? ` ($${opp.compensation.amount})` : ""}</span>` : ""}
      </div>
    `).join("");

    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px; color: #111827;">
      <div style="background: #7c3aed; color: white; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="margin: 0;">Developer Ambassador Opportunities</h2>
      </div>
      <div style="border: 1px solid #e5e7eb; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
        <p>Hi ${ambassador.displayName},</p>
        <p>Here are <strong>${opportunities.length}</strong> opportunities matching your expertise:</p>
        ${rows}
      </div>
      <p style="font-size: 12px; color: #9ca3af; margin-top: 16px;">You're receiving this because you're a Frontier Tower Developer Ambassador. Reply STOP to unsubscribe.</p>
    </div>`.trim();
  }
}
