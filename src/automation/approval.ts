/**
 * Event Approval Automation
 *
 * Automates the guest approval process for events. Organizers define
 * criteria for auto-approve, auto-decline, or manual review.
 * Solves Luma's problem where invites auto-accept people, bypassing
 * the registration flow and losing data.
 */

import type { Contact, Event, RSVP, ApprovalCriteria, SegmentFilter } from "../types.js";
import type { ContactManager } from "../contacts/manager.js";
import type { LumaClient } from "../luma/client.js";

export type ApprovalResult = {
  rsvpId: string;
  contactId: string;
  decision: "approved" | "declined" | "manual_review";
  reason: string;
};

export class ApprovalEngine {
  constructor(
    private contactManager: ContactManager,
    private lumaClient: LumaClient,
  ) {}

  /**
   * Process pending RSVPs for an event, applying approval criteria.
   * Returns decisions for each pending RSVP.
   */
  async processEventApprovals(
    event: Event,
    pendingRsvps: RSVP[],
  ): Promise<ApprovalResult[]> {
    if (!event.requiresApproval || !event.approvalCriteria) {
      // Auto-approve everything if no criteria set
      return pendingRsvps.map((rsvp) => ({
        rsvpId: rsvp.id,
        contactId: rsvp.contactId,
        decision: "approved" as const,
        reason: "No approval criteria configured — auto-approved.",
      }));
    }

    const results: ApprovalResult[] = [];

    for (const rsvp of pendingRsvps) {
      const contact = this.contactManager.getContact(rsvp.contactId);
      if (!contact) {
        results.push({
          rsvpId: rsvp.id,
          contactId: rsvp.contactId,
          decision: "manual_review",
          reason: "Contact not found in system.",
        });
        continue;
      }

      const decision = this.evaluateContact(contact, event.approvalCriteria);
      results.push({
        rsvpId: rsvp.id,
        contactId: rsvp.contactId,
        ...decision,
      });
    }

    return results;
  }

  /**
   * Apply approval decisions to Luma (if Luma-synced event).
   */
  async applyToLuma(
    event: Event,
    decisions: ApprovalResult[],
    guestMapping: Map<string, string>, // contactId -> lumaGuestId
  ): Promise<void> {
    if (!event.lumaEventId) return;

    for (const decision of decisions) {
      const lumaGuestId = guestMapping.get(decision.contactId);
      if (!lumaGuestId) continue;

      if (decision.decision === "approved") {
        await this.lumaClient.approveGuest(event.lumaEventId, lumaGuestId);
      } else if (decision.decision === "declined") {
        await this.lumaClient.declineGuest(event.lumaEventId, lumaGuestId);
      }
      // manual_review is left as-is in Luma (pending)
    }
  }

  /**
   * Evaluate a single contact against approval criteria.
   */
  private evaluateContact(
    contact: Contact,
    criteria: ApprovalCriteria,
  ): { decision: ApprovalResult["decision"]; reason: string } {
    // Check auto-decline first (any match declines)
    for (const filter of criteria.autoDeclineFilters) {
      if (this.matchesFilter(contact, filter)) {
        return {
          decision: "declined",
          reason: `Auto-declined: matched filter ${filter.field} ${filter.operator} ${JSON.stringify(filter.value)}`,
        };
      }
    }

    // Check auto-approve (all must match)
    if (criteria.autoApproveFilters.length > 0) {
      const allMatch = criteria.autoApproveFilters.every((f) => this.matchesFilter(contact, f));
      if (allMatch) {
        return {
          decision: "approved",
          reason: "Auto-approved: matched all approval criteria.",
        };
      }
    }

    // Fall through to default action
    return {
      decision: criteria.defaultAction === "approve"
        ? "approved"
        : criteria.defaultAction === "decline"
          ? "declined"
          : "manual_review",
      reason: `Default action: ${criteria.defaultAction}`,
    };
  }

  private matchesFilter(contact: Contact, filter: SegmentFilter): boolean {
    const fieldValue = this.getFieldValue(contact, filter.field);

    switch (filter.operator) {
      case "contains":
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) =>
            v.toLowerCase().includes(String(filter.value).toLowerCase())
          );
        }
        return String(fieldValue).toLowerCase().includes(String(filter.value).toLowerCase());

      case "equals":
        return String(fieldValue).toLowerCase() === String(filter.value).toLowerCase();

      case "in":
        if (!Array.isArray(filter.value)) return false;
        const targets = filter.value.map((v) => v.toLowerCase());
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) => targets.includes(v.toLowerCase()));
        }
        return targets.includes(String(fieldValue).toLowerCase());

      case "not_equals":
        return String(fieldValue).toLowerCase() !== String(filter.value).toLowerCase();

      case "not_in":
        if (!Array.isArray(filter.value)) return true;
        const excluded = filter.value.map((v) => v.toLowerCase());
        return !excluded.includes(String(fieldValue).toLowerCase());

      default:
        return false;
    }
  }

  private getFieldValue(contact: Contact, field: SegmentFilter["field"]): string | string[] {
    switch (field) {
      case "interests": return contact.interests;
      case "tags": return contact.tags;
      case "source": return contact.source;
      case "status": return contact.status;
      case "company": return contact.company ?? "";
      case "jobTitle": return contact.jobTitle ?? "";
      case "seniority": return contact.enrichment?.seniority ?? "";
      case "industry": return contact.enrichment?.industry ?? "";
      default: return "";
    }
  }
}
