/**
 * Luma API Client
 *
 * Full integration with Luma for event management, guest management,
 * and contact sync. Replaces Luma's expensive invite system by
 * pulling guest data and managing events via API.
 */

import type { PlatformConfig } from "../config.js";
import type { Event, Contact, RSVPStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Luma API types (external)
// ---------------------------------------------------------------------------

type LumaEvent = {
  api_id: string;
  name: string;
  description?: string;
  start_at: string;
  end_at?: string;
  geo_address_json?: { city?: string; full_address?: string; place_id?: string };
  url: string;
  cover_url?: string;
  visibility: string;
  event_type?: string;
  tags?: string[];
  series_api_id?: string;
};

type LumaGuest = {
  api_id: string;
  event_api_id: string;
  user_api_id?: string;
  user_name?: string;
  user_email?: string;
  approval_status: "approved" | "declined" | "pending" | "waitlisted";
  registered_at: string;
  checked_in_at?: string;
  registration_answers?: Record<string, string>;
};

type LumaCalendarEntry = {
  event: LumaEvent;
};

type LumaPaginatedResponse<T> = {
  entries: T[];
  has_more: boolean;
  next_cursor?: string;
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class LumaClient {
  private baseUrl = "https://api.lu.ma/public/v2";
  private apiKey: string | undefined;
  private sourceUrls: string[];

  constructor(config: PlatformConfig) {
    this.apiKey = config.lumaApiKey;
    this.sourceUrls = config.lumaSourceUrls;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      h["x-luma-api-key"] = this.apiKey;
    }
    return h;
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: { ...this.headers(), ...options?.headers },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Luma API ${response.status}: ${path} - ${body}`);
    }

    return response.json() as Promise<T>;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** List events from the authenticated calendar. */
  async listEvents(opts?: { after?: string; seriesId?: string }): Promise<LumaEvent[]> {
    const params = new URLSearchParams();
    if (opts?.after) params.set("after", opts.after);
    if (opts?.seriesId) params.set("series_api_id", opts.seriesId);

    const all: LumaEvent[] = [];
    let cursor: string | undefined;

    do {
      if (cursor) params.set("pagination_cursor", cursor);
      const resp = await this.request<LumaPaginatedResponse<LumaCalendarEntry>>(
        `/calendar/list-events?${params.toString()}`
      );
      for (const entry of resp.entries) {
        all.push(entry.event);
      }
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    return all;
  }

  /** Get a single event by its Luma API ID. */
  async getEvent(eventId: string): Promise<LumaEvent> {
    const resp = await this.request<{ event: LumaEvent }>(`/event/get?api_id=${eventId}`);
    return resp.event;
  }

  // -------------------------------------------------------------------------
  // Guests
  // -------------------------------------------------------------------------

  /** List all guests for an event, handling pagination. */
  async listGuests(eventId: string): Promise<LumaGuest[]> {
    const all: LumaGuest[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({ event_api_id: eventId });
      if (cursor) params.set("pagination_cursor", cursor);
      const resp = await this.request<LumaPaginatedResponse<LumaGuest>>(
        `/event/get-guests?${params.toString()}`
      );
      all.push(...resp.entries);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);

    return all;
  }

  /** Get guests filtered by approval status. */
  async getGuestsByStatus(eventId: string, status: RSVPStatus): Promise<LumaGuest[]> {
    const guests = await this.listGuests(eventId);
    const lumaStatus = this.mapToLumaStatus(status);
    return guests.filter((g) => g.approval_status === lumaStatus);
  }

  /** Get waitlisted guests for follow-up. */
  async getWaitlistedGuests(eventId: string): Promise<LumaGuest[]> {
    return this.getGuestsByStatus(eventId, "waitlisted");
  }

  /** Get pending guests that need approval. */
  async getPendingGuests(eventId: string): Promise<LumaGuest[]> {
    return this.getGuestsByStatus(eventId, "pending");
  }

  // -------------------------------------------------------------------------
  // Guest Management (as admin)
  // -------------------------------------------------------------------------

  /** Approve a guest registration. */
  async approveGuest(eventId: string, guestId: string): Promise<void> {
    await this.request(`/event/manage-guest`, {
      method: "POST",
      body: JSON.stringify({
        event_api_id: eventId,
        guest_api_id: guestId,
        approval_status: "approved",
      }),
    });
  }

  /** Decline a guest registration (politely). */
  async declineGuest(eventId: string, guestId: string): Promise<void> {
    await this.request(`/event/manage-guest`, {
      method: "POST",
      body: JSON.stringify({
        event_api_id: eventId,
        guest_api_id: guestId,
        approval_status: "declined",
      }),
    });
  }

  // -------------------------------------------------------------------------
  // Scraping fallback (for public Luma pages without API key)
  // -------------------------------------------------------------------------

  /** Fetch events from public Luma URLs via JSON-LD scraping. */
  async scrapePublicEvents(url: string): Promise<Partial<Event>[]> {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "FrontierTowerPlatform/1.0 (+automation)",
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    const text = await response.text();
    const events: Partial<Event>[] = [];

    // Try JSON first
    if (text.trim().startsWith("[") || text.trim().startsWith("{")) {
      try {
        const payload = JSON.parse(text);
        const items = Array.isArray(payload)
          ? payload
          : payload.events ?? payload.items ?? [];
        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          const e = this.parseEventFromJson(item);
          if (e) events.push(e);
        }
      } catch {
        // fall through to JSON-LD
      }
    }

    // JSON-LD fallback
    if (events.length === 0) {
      const ldRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let match: RegExpExecArray | null;
      while ((match = ldRegex.exec(text))) {
        try {
          const parsed = JSON.parse(match[1] || "{}");
          const blobs = Array.isArray(parsed) ? parsed : [parsed];
          for (const blob of blobs) {
            const e = this.parseEventFromJson(blob);
            if (e) events.push(e);
          }
        } catch {
          // skip malformed
        }
      }
    }

    return events;
  }

  // -------------------------------------------------------------------------
  // Conversions
  // -------------------------------------------------------------------------

  /** Convert a Luma event to our Event type. */
  lumaEventToEvent(luma: LumaEvent, orgId: string): Event {
    const location = luma.geo_address_json?.full_address ?? luma.geo_address_json?.city;
    return {
      id: crypto.randomUUID(),
      orgId,
      lumaEventId: luma.api_id,
      title: luma.name,
      description: luma.description ?? "",
      startAt: luma.start_at,
      endAt: luma.end_at,
      location,
      url: luma.url,
      topics: luma.tags ?? [],
      status: "published",
      requiresApproval: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Convert a Luma guest to our Contact type. */
  lumaGuestToContact(guest: LumaGuest, orgId: string): Partial<Contact> {
    const nameParts = (guest.user_name ?? "").split(" ");
    return {
      orgId,
      firstName: nameParts[0] ?? "",
      lastName: nameParts.slice(1).join(" "),
      email: guest.user_email ?? "",
      source: "luma_import",
      isNetworkSourced: false,
      interests: [],
      tags: [],
      social: {},
      socialScore: 0,
      status: "active",
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private mapToLumaStatus(status: RSVPStatus): LumaGuest["approval_status"] {
    switch (status) {
      case "approved": return "approved";
      case "declined": return "declined";
      case "waitlisted": return "waitlisted";
      case "pending": return "pending";
      default: return "pending";
    }
  }

  private parseEventFromJson(raw: Record<string, unknown>): Partial<Event> | null {
    const title = String(raw.title || raw.name || raw.headline || "").trim();
    if (!title) return null;

    return {
      title,
      description: String(raw.description || raw.summary || "").trim(),
      startAt: String(raw.startDate || raw.start_time || raw.start_at || raw.startAt || ""),
      location: typeof raw.location === "string"
        ? raw.location
        : typeof raw.location === "object" && raw.location
          ? String((raw.location as Record<string, unknown>).name ?? "")
          : undefined,
      url: typeof raw.url === "string" ? raw.url : undefined,
      topics: [],
    };
  }
}
