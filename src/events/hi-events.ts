/**
 * Hi.Events Integration
 *
 * Uses Hi.Events (https://hi.events) as the open-source event page
 * and ticketing platform. Replaces Luma's event pages with a self-hosted
 * solution that gives full control over branding, data, and checkout.
 *
 * Hi.Events features: QR check-in, embeddable widgets, custom forms,
 * event analytics, and a full REST API.
 */

import type { PlatformConfig } from "../config.js";
import type { Event, Contact, RSVP } from "../types.js";

// ---------------------------------------------------------------------------
// Hi.Events API types
// ---------------------------------------------------------------------------

type HiEventResponse = {
  id: number;
  title: string;
  description?: string;
  start_date: string;
  end_date?: string;
  location_details?: {
    venue_name?: string;
    address_line_1?: string;
    city?: string;
  };
  status: string;
  slug: string;
};

type HiTicketResponse = {
  id: number;
  title: string;
  price: number;
  quantity_available: number;
  quantity_sold: number;
};

type HiOrderResponse = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  status: string;
  order_items: {
    ticket_id: number;
    ticket_title: string;
    quantity: number;
  }[];
  question_answers?: Record<string, string>;
};

type HiAttendeeResponse = {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  status: string;
  checked_in_at?: string;
  ticket?: { title: string };
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class HiEventsClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: PlatformConfig) {
    this.baseUrl = config.hiEventsBaseUrl.replace(/\/$/, "");
    this.apiKey = config.hiEventsApiKey ?? "";
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api/v1${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...opts?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Hi.Events API ${response.status}: ${path} - ${body}`);
    }

    const json = (await response.json()) as { data: T };
    return json.data;
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /** Create an event on Hi.Events. */
  async createEvent(event: Event): Promise<number> {
    const data = await this.request<HiEventResponse>("/events", {
      method: "POST",
      body: JSON.stringify({
        title: event.title,
        description: event.description,
        start_date: event.startAt,
        end_date: event.endAt,
        location_details: event.location ? {
          venue_name: event.location,
        } : undefined,
        status: event.status === "published" ? "LIVE" : "DRAFT",
      }),
    });

    return data.id;
  }

  /** Get an event by ID. */
  async getEvent(eventId: number): Promise<HiEventResponse> {
    return this.request<HiEventResponse>(`/events/${eventId}`);
  }

  /** List all events. */
  async listEvents(): Promise<HiEventResponse[]> {
    return this.request<HiEventResponse[]>("/events");
  }

  /** Update an event. */
  async updateEvent(eventId: number, updates: Partial<{
    title: string;
    description: string;
    start_date: string;
    end_date: string;
    status: string;
  }>): Promise<HiEventResponse> {
    return this.request<HiEventResponse>(`/events/${eventId}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
  }

  // -------------------------------------------------------------------------
  // Tickets
  // -------------------------------------------------------------------------

  /** Create a ticket type for an event (free RSVP or paid). */
  async createTicket(eventId: number, opts: {
    title: string;
    price?: number;
    quantityAvailable?: number;
  }): Promise<number> {
    const data = await this.request<HiTicketResponse>(
      `/events/${eventId}/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          title: opts.title,
          price: opts.price ?? 0,
          quantity_available: opts.quantityAvailable,
        }),
      },
    );
    return data.id;
  }

  // -------------------------------------------------------------------------
  // Attendees / Orders
  // -------------------------------------------------------------------------

  /** List attendees for an event. */
  async listAttendees(eventId: number): Promise<HiAttendeeResponse[]> {
    return this.request<HiAttendeeResponse[]>(`/events/${eventId}/attendees`);
  }

  /** List orders for an event. */
  async listOrders(eventId: number): Promise<HiOrderResponse[]> {
    return this.request<HiOrderResponse[]>(`/events/${eventId}/orders`);
  }

  /** Check in an attendee (QR code scan). */
  async checkInAttendee(eventId: number, attendeeId: number): Promise<void> {
    await this.request(`/events/${eventId}/attendees/${attendeeId}/check-in`, {
      method: "POST",
    });
  }

  // -------------------------------------------------------------------------
  // Conversions
  // -------------------------------------------------------------------------

  /** Convert a Hi.Events event to our Event type. */
  hiEventToEvent(hi: HiEventResponse, orgId: string): Event {
    const location = hi.location_details
      ? [hi.location_details.venue_name, hi.location_details.city].filter(Boolean).join(", ")
      : undefined;

    return {
      id: crypto.randomUUID(),
      orgId,
      hiEventsId: String(hi.id),
      title: hi.title,
      description: hi.description ?? "",
      startAt: hi.start_date,
      endAt: hi.end_date,
      location,
      url: `${this.baseUrl}/event/${hi.slug}`,
      topics: [],
      status: hi.status === "LIVE" ? "published" : "draft",
      requiresApproval: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Convert Hi.Events attendees to our Contact type. */
  hiAttendeeToContact(attendee: HiAttendeeResponse, orgId: string): Partial<Contact> {
    return {
      orgId,
      firstName: attendee.first_name,
      lastName: attendee.last_name,
      email: attendee.email,
      source: "luma_import", // TODO: add "hi_events" source
      isNetworkSourced: false,
      interests: [],
      tags: attendee.ticket?.title ? [attendee.ticket.title] : [],
      social: {},
      socialScore: 0,
      status: "active",
    };
  }

  /** Sync event from our system to Hi.Events (create event page). */
  async syncEventToHiEvents(event: Event): Promise<number> {
    const hiEventId = await this.createEvent(event);

    // Create a free RSVP ticket
    await this.createTicket(hiEventId, {
      title: "RSVP",
      price: 0,
      quantityAvailable: event.capacity,
    });

    return hiEventId;
  }

  /** Pull attendees from Hi.Events into our contact system. */
  async pullAttendees(hiEventId: number, orgId: string): Promise<Partial<Contact>[]> {
    const attendees = await this.listAttendees(hiEventId);
    return attendees.map((a) => this.hiAttendeeToContact(a, orgId));
  }
}
