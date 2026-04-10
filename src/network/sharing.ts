/**
 * Network Sharing Module
 *
 * Manages the shared contact network (200k+ past event attendees).
 * Key privacy principle: organizers can PAY to send targeted invites
 * to network contacts, but they only gain access to PII for contacts
 * who actually RSVP to their event. The full network is never exposed.
 *
 * This solves Luma's co-host problem where co-hosts can steal all contacts.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { PlatformConfig } from "../config.js";
import type { NetworkContact, Contact, Event } from "../types.js";

export class NetworkSharingService {
  private networkContacts: Map<string, NetworkContact> = new Map();
  private dataDir: string;

  constructor(private config: PlatformConfig) {
    this.dataDir = config.dataDir;
    mkdirSync(this.dataDir, { recursive: true });
    this.loadFromDisk();
  }

  // -------------------------------------------------------------------------
  // Network Registration
  // -------------------------------------------------------------------------

  /**
   * Add a contact to the shared network pool (with privacy protection).
   * Only stores hashed email and aggregated interest data.
   */
  addToNetwork(contact: Contact, eventTopics: string[]): NetworkContact {
    const emailHash = this.hashEmail(contact.email);
    const existing = this.networkContacts.get(emailHash);

    if (existing) {
      // Update affinities
      for (const topic of eventTopics) {
        existing.topicAffinities[topic] = (existing.topicAffinities[topic] ?? 0) + 1;
      }
      existing.totalEventsAttended++;
      existing.lastEventDate = new Date().toISOString();
      existing.interests = [...new Set([...existing.interests, ...contact.interests])];
      this.saveToDisk();
      return existing;
    }

    const networkContact: NetworkContact = {
      id: crypto.randomUUID(),
      emailHash,
      interests: [...contact.interests],
      topicAffinities: Object.fromEntries(eventTopics.map((t) => [t, 1])),
      lastEventDate: new Date().toISOString(),
      totalEventsAttended: 1,
    };

    this.networkContacts.set(emailHash, networkContact);
    this.saveToDisk();
    return networkContact;
  }

  /**
   * Bulk register event attendees into the network.
   * Called after an event completes to grow the network.
   */
  bulkAddFromEvent(contacts: Contact[], event: Event): number {
    let added = 0;
    for (const contact of contacts) {
      // Only add active, non-bounced contacts who aren't already unsubscribed
      if (contact.status !== "active") continue;
      this.addToNetwork(contact, event.topics);
      added++;
    }
    return added;
  }

  // -------------------------------------------------------------------------
  // Targeted Invite Discovery
  // -------------------------------------------------------------------------

  /**
   * Find network contacts who match specific topics/interests.
   * Returns anonymized network contacts (no PII).
   * The org pays for the invite, and only gets PII on RSVP.
   */
  findMatchingContacts(opts: {
    topics: string[];
    limit: number;
    /** Exclude contacts already known to the org. */
    excludeEmailHashes?: Set<string>;
    /** Minimum events attended. */
    minEvents?: number;
    /** Only contacts active in the last N days. */
    activeSinceDays?: number;
  }): NetworkContact[] {
    const candidates: { contact: NetworkContact; score: number }[] = [];
    const now = Date.now();
    const activeSinceMs = (opts.activeSinceDays ?? 365) * 24 * 60 * 60 * 1000;

    for (const contact of this.networkContacts.values()) {
      // Exclude already-known contacts
      if (opts.excludeEmailHashes?.has(contact.emailHash)) continue;

      // Activity filter
      if (now - new Date(contact.lastEventDate).getTime() > activeSinceMs) continue;

      // Minimum events filter
      if (opts.minEvents && contact.totalEventsAttended < opts.minEvents) continue;

      // Score by topic affinity
      let score = 0;
      for (const topic of opts.topics) {
        // Check topic affinities
        score += contact.topicAffinities[topic] ?? 0;
        // Check interest match
        if (contact.interests.some((i) => i.toLowerCase().includes(topic.toLowerCase()))) {
          score += 2;
        }
      }

      if (score > 0) {
        candidates.push({ contact, score });
      }
    }

    // Sort by score (highest affinity first) and limit
    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit)
      .map((c) => c.contact);
  }

  /**
   * Get the count of network contacts matching given topics.
   * Used for pricing/quota display.
   */
  countMatchingContacts(topics: string[]): number {
    return this.findMatchingContacts({ topics, limit: Infinity }).length;
  }

  // -------------------------------------------------------------------------
  // RSVP Reveal (contact claims on RSVP)
  // -------------------------------------------------------------------------

  /**
   * When a network contact RSVPs to an event, the organizer gets
   * access to their information. This is the ONLY way an org
   * can get PII from the network.
   *
   * Returns the email hash for matching against the network pool.
   */
  revealOnRsvp(email: string): { emailHash: string; isInNetwork: boolean } {
    const emailHash = this.hashEmail(email);
    const isInNetwork = this.networkContacts.has(emailHash);
    return { emailHash, isInNetwork };
  }

  // -------------------------------------------------------------------------
  // Network Stats
  // -------------------------------------------------------------------------

  getNetworkSize(): number {
    return this.networkContacts.size;
  }

  getTopTopics(limit = 10): { topic: string; count: number }[] {
    const topicCounts = new Map<string, number>();

    for (const contact of this.networkContacts.values()) {
      for (const [topic, count] of Object.entries(contact.topicAffinities)) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + count);
      }
    }

    return [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([topic, count]) => ({ topic, count }));
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private hashEmail(email: string): string {
    return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private networkPath(): string {
    return path.join(this.dataDir, "network-contacts.json");
  }

  private loadFromDisk(): void {
    if (!existsSync(this.networkPath())) return;
    try {
      const raw = JSON.parse(readFileSync(this.networkPath(), "utf-8"));
      if (Array.isArray(raw)) {
        for (const c of raw) this.networkContacts.set(c.emailHash, c);
      }
    } catch { /* ignore */ }
  }

  private saveToDisk(): void {
    writeFileSync(this.networkPath(), JSON.stringify([...this.networkContacts.values()], null, 2));
  }
}
