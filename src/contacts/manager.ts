/**
 * Contact Management Module
 *
 * Handles contact CRUD, segmentation into mailing lists by interest/topic,
 * waitlist/pending follow-up identification, and unsubscribe tracking.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PlatformConfig } from "../config.js";
import type {
  Contact,
  ContactSource,
  MailingList,
  SegmentFilter,
  SocialProfiles,
} from "../types.js";

export class ContactManager {
  private contacts: Map<string, Contact> = new Map();
  private mailingLists: Map<string, MailingList> = new Map();
  private dataDir: string;

  constructor(private config: PlatformConfig) {
    this.dataDir = config.dataDir;
    mkdirSync(this.dataDir, { recursive: true });
    this.loadFromDisk();
  }

  // -------------------------------------------------------------------------
  // Contact CRUD
  // -------------------------------------------------------------------------

  addContact(data: {
    orgId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    company?: string;
    jobTitle?: string;
    social?: SocialProfiles;
    interests?: string[];
    tags?: string[];
    source?: ContactSource;
  }): Contact {
    const existing = this.findByEmail(data.orgId, data.email);
    if (existing) {
      return this.updateContact(existing.id, data);
    }

    const contact: Contact = {
      id: crypto.randomUUID(),
      orgId: data.orgId,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      company: data.company,
      jobTitle: data.jobTitle,
      social: data.social ?? {},
      interests: data.interests ?? [],
      tags: data.tags ?? [],
      source: data.source ?? "manual",
      isNetworkSourced: false,
      socialScore: 0,
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.contacts.set(contact.id, contact);
    this.saveToDisk();
    return contact;
  }

  updateContact(id: string, updates: Partial<Contact>): Contact {
    const contact = this.contacts.get(id);
    if (!contact) throw new Error(`Contact not found: ${id}`);

    const updated = {
      ...contact,
      ...updates,
      id: contact.id, // never overwrite id
      orgId: contact.orgId, // never change org
      updatedAt: new Date().toISOString(),
    };

    this.contacts.set(id, updated);
    this.saveToDisk();
    return updated;
  }

  getContact(id: string): Contact | undefined {
    return this.contacts.get(id);
  }

  findByEmail(orgId: string, email: string): Contact | undefined {
    const normalized = email.toLowerCase().trim();
    for (const contact of this.contacts.values()) {
      if (contact.orgId === orgId && contact.email.toLowerCase().trim() === normalized) {
        return contact;
      }
    }
    return undefined;
  }

  listContacts(orgId: string): Contact[] {
    return [...this.contacts.values()].filter((c) => c.orgId === orgId);
  }

  // -------------------------------------------------------------------------
  // Bulk Import
  // -------------------------------------------------------------------------

  /** Import contacts from Luma guest data. */
  importFromLuma(orgId: string, guests: { name: string; email: string; interests?: string[] }[]): Contact[] {
    const imported: Contact[] = [];
    for (const guest of guests) {
      const nameParts = guest.name.split(" ");
      const contact = this.addContact({
        orgId,
        firstName: nameParts[0] ?? "",
        lastName: nameParts.slice(1).join(" "),
        email: guest.email,
        interests: guest.interests ?? [],
        source: "luma_import",
      });
      imported.push(contact);
    }
    return imported;
  }

  /** Import contacts from CSV data (parsed rows). */
  importFromCsv(orgId: string, rows: Record<string, string>[]): Contact[] {
    const imported: Contact[] = [];
    for (const row of rows) {
      if (!row.email) continue;
      const contact = this.addContact({
        orgId,
        firstName: row.first_name ?? row.firstName ?? row.name?.split(" ")[0] ?? "",
        lastName: row.last_name ?? row.lastName ?? row.name?.split(" ").slice(1).join(" ") ?? "",
        email: row.email,
        company: row.company,
        jobTitle: row.job_title ?? row.jobTitle,
        social: {
          github: row.github,
          linkedin: row.linkedin,
          twitter: row.twitter,
        },
        interests: row.interests?.split(",").map((s) => s.trim()).filter(Boolean),
        tags: row.tags?.split(",").map((s) => s.trim()).filter(Boolean),
        source: "csv_upload",
      });
      imported.push(contact);
    }
    return imported;
  }

  // -------------------------------------------------------------------------
  // Segmentation
  // -------------------------------------------------------------------------

  /** Create a mailing list with dynamic filters and/or static contacts. */
  createMailingList(data: {
    orgId: string;
    name: string;
    description?: string;
    filters?: SegmentFilter[];
    staticContactIds?: string[];
  }): MailingList {
    const list: MailingList = {
      id: crypto.randomUUID(),
      orgId: data.orgId,
      name: data.name,
      description: data.description,
      filters: data.filters ?? [],
      staticContactIds: data.staticContactIds ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.mailingLists.set(list.id, list);
    this.saveToDisk();
    return list;
  }

  /** Resolve a mailing list to actual contacts (static + dynamic filter matches). */
  resolveMailingList(listId: string): Contact[] {
    const list = this.mailingLists.get(listId);
    if (!list) return [];

    const orgContacts = this.listContacts(list.orgId).filter((c) => c.status === "active");
    const matchedByFilter = orgContacts.filter((c) => this.matchesFilters(c, list.filters));
    const staticContacts = list.staticContactIds
      .map((id) => this.contacts.get(id))
      .filter((c): c is Contact => c !== undefined && c.status === "active");

    // Dedupe
    const seen = new Set<string>();
    const result: Contact[] = [];
    for (const c of [...matchedByFilter, ...staticContacts]) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        result.push(c);
      }
    }
    return result;
  }

  /** Create a mailing list for a specific topic. */
  createTopicList(orgId: string, topic: string): MailingList {
    return this.createMailingList({
      orgId,
      name: `${topic} Interested`,
      description: `Auto-generated list for contacts interested in ${topic}`,
      filters: [{ field: "interests", operator: "contains", value: topic }],
    });
  }

  /** Get contacts on a waitlist or pending for a specific event. */
  getWaitlistedContacts(orgId: string): Contact[] {
    return this.listContacts(orgId).filter((c) => c.tags.includes("waitlisted"));
  }

  /** Get contacts who have been pending approval. */
  getPendingContacts(orgId: string): Contact[] {
    return this.listContacts(orgId).filter((c) => c.status === "pending");
  }

  // -------------------------------------------------------------------------
  // Unsubscribe Tracking
  // -------------------------------------------------------------------------

  unsubscribe(contactId: string): void {
    const contact = this.contacts.get(contactId);
    if (!contact) return;
    contact.status = "unsubscribed";
    contact.updatedAt = new Date().toISOString();
    this.saveToDisk();
  }

  unsubscribeByEmail(orgId: string, email: string): void {
    const contact = this.findByEmail(orgId, email);
    if (contact) this.unsubscribe(contact.id);
  }

  getUnsubscribed(orgId: string): Contact[] {
    return this.listContacts(orgId).filter((c) => c.status === "unsubscribed");
  }

  // -------------------------------------------------------------------------
  // Hashing for network privacy
  // -------------------------------------------------------------------------

  /** Hash an email for privacy-preserving network matching. */
  hashEmail(email: string): string {
    return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
  }

  // -------------------------------------------------------------------------
  // Filter matching
  // -------------------------------------------------------------------------

  private matchesFilters(contact: Contact, filters: SegmentFilter[]): boolean {
    if (filters.length === 0) return true;
    return filters.every((filter) => this.matchesFilter(contact, filter));
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
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) => v.toLowerCase() === String(filter.value).toLowerCase());
        }
        return String(fieldValue).toLowerCase() === String(filter.value).toLowerCase();

      case "not_equals":
        return String(fieldValue).toLowerCase() !== String(filter.value).toLowerCase();

      case "in":
        if (!Array.isArray(filter.value)) return false;
        const lowerValues = filter.value.map((v) => v.toLowerCase());
        if (Array.isArray(fieldValue)) {
          return fieldValue.some((v) => lowerValues.includes(v.toLowerCase()));
        }
        return lowerValues.includes(String(fieldValue).toLowerCase());

      case "not_in":
        if (!Array.isArray(filter.value)) return true;
        const excludeValues = filter.value.map((v) => v.toLowerCase());
        return !excludeValues.includes(String(fieldValue).toLowerCase());

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

  // -------------------------------------------------------------------------
  // Persistence (file-based for dev, replace with DB in production)
  // -------------------------------------------------------------------------

  private contactsPath(): string {
    return path.join(this.dataDir, "contacts.json");
  }

  private listsPath(): string {
    return path.join(this.dataDir, "mailing-lists.json");
  }

  private loadFromDisk(): void {
    if (existsSync(this.contactsPath())) {
      try {
        const raw = JSON.parse(readFileSync(this.contactsPath(), "utf-8"));
        if (Array.isArray(raw)) {
          for (const c of raw) this.contacts.set(c.id, c);
        }
      } catch { /* ignore corrupt data */ }
    }

    if (existsSync(this.listsPath())) {
      try {
        const raw = JSON.parse(readFileSync(this.listsPath(), "utf-8"));
        if (Array.isArray(raw)) {
          for (const l of raw) this.mailingLists.set(l.id, l);
        }
      } catch { /* ignore */ }
    }
  }

  saveToDisk(): void {
    writeFileSync(this.contactsPath(), JSON.stringify([...this.contacts.values()], null, 2));
    writeFileSync(this.listsPath(), JSON.stringify([...this.mailingLists.values()], null, 2));
  }
}
