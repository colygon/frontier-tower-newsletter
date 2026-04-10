/**
 * CRM Integration Layer
 *
 * Provides a common interface for syncing contacts and events with
 * external CRMs. Built-in Twenty CRM + native integrations with
 * Attio, HubSpot, and Salesforce.
 *
 * Twenty (https://twenty.com) is the recommended built-in CRM:
 * open source, Airtable-like interface, 43k+ GitHub stars,
 * GraphQL + REST API, custom objects & fields, self-hostable.
 */

import type { Contact, Event, CRMProvider, CRMConfig } from "../types.js";
import type { PlatformConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Common CRM interface
// ---------------------------------------------------------------------------

export type CRMContact = {
  externalId: string;
  firstName: string;
  lastName: string;
  email: string;
  company?: string;
  jobTitle?: string;
  phone?: string;
  customFields?: Record<string, unknown>;
};

export type CRMDeal = {
  externalId: string;
  name: string;
  stage: string;
  value?: number;
  contactIds: string[];
  customFields?: Record<string, unknown>;
};

export interface CRMAdapter {
  readonly provider: CRMProvider;

  /** Test the connection to the CRM. */
  testConnection(): Promise<boolean>;

  /** Push a contact to the CRM (create or update). */
  upsertContact(contact: Contact): Promise<CRMContact>;

  /** Pull contacts from the CRM. */
  listContacts(opts?: { limit?: number; cursor?: string }): Promise<{ contacts: CRMContact[]; nextCursor?: string }>;

  /** Push an event as a "deal" or "opportunity" to the CRM. */
  upsertEvent(event: Event): Promise<CRMDeal>;

  /** Sync event attendees to the CRM as associated contacts. */
  syncAttendees(eventId: string, contacts: Contact[]): Promise<void>;

  /** Search contacts in the CRM. */
  searchContacts(query: string): Promise<CRMContact[]>;
}

// ---------------------------------------------------------------------------
// Twenty CRM Adapter (built-in, recommended)
// ---------------------------------------------------------------------------

export class TwentyCRMAdapter implements CRMAdapter {
  readonly provider: CRMProvider = "twenty";
  private baseUrl: string;
  private apiKey: string;

  constructor(config: PlatformConfig) {
    this.baseUrl = config.twentyBaseUrl.replace(/\/$/, "");
    this.apiKey = config.twentyApiKey ?? "";
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Twenty API error ${response.status}: ${body}`);
    }

    const json = (await response.json()) as { data: T; errors?: unknown[] };
    if (json.errors?.length) {
      throw new Error(`Twenty GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.gql(`query { currentWorkspace { id displayName } }`);
      return true;
    } catch {
      return false;
    }
  }

  async upsertContact(contact: Contact): Promise<CRMContact> {
    // Try to find existing by email
    const existing = await this.searchContacts(contact.email);
    if (existing.length > 0) {
      return this.updateTwentyContact(existing[0].externalId, contact);
    }

    const data = await this.gql<{ createPerson: { id: string } }>(`
      mutation CreatePerson($input: PersonCreateInput!) {
        createPerson(data: $input) {
          id
        }
      }
    `, {
      input: {
        name: { firstName: contact.firstName, lastName: contact.lastName },
        emails: { primaryEmail: contact.email },
        phones: contact.phone ? { primaryPhone: contact.phone } : undefined,
        jobTitle: contact.jobTitle,
        company: contact.company,
      },
    });

    return {
      externalId: data.createPerson.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      company: contact.company,
      jobTitle: contact.jobTitle,
    };
  }

  private async updateTwentyContact(externalId: string, contact: Contact): Promise<CRMContact> {
    await this.gql(`
      mutation UpdatePerson($id: ID!, $input: PersonUpdateInput!) {
        updatePerson(id: $id, data: $input) {
          id
        }
      }
    `, {
      id: externalId,
      input: {
        name: { firstName: contact.firstName, lastName: contact.lastName },
        jobTitle: contact.jobTitle,
        company: contact.company,
      },
    });

    return {
      externalId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      company: contact.company,
      jobTitle: contact.jobTitle,
    };
  }

  async listContacts(opts?: { limit?: number; cursor?: string }): Promise<{ contacts: CRMContact[]; nextCursor?: string }> {
    const limit = opts?.limit ?? 50;
    const data = await this.gql<{
      people: { edges: { node: { id: string; name: { firstName: string; lastName: string }; emails: { primaryEmail: string }; jobTitle?: string; company?: string } }[]; pageInfo: { hasNextPage: boolean; endCursor?: string } };
    }>(`
      query ListPeople($first: Int, $after: String) {
        people(first: $first, after: $after) {
          edges {
            node {
              id
              name { firstName lastName }
              emails { primaryEmail }
              jobTitle
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { first: limit, after: opts?.cursor });

    return {
      contacts: data.people.edges.map((e) => ({
        externalId: e.node.id,
        firstName: e.node.name.firstName,
        lastName: e.node.name.lastName,
        email: e.node.emails.primaryEmail,
        jobTitle: e.node.jobTitle,
      })),
      nextCursor: data.people.pageInfo.hasNextPage ? data.people.pageInfo.endCursor : undefined,
    };
  }

  async upsertEvent(event: Event): Promise<CRMDeal> {
    // Map events to Twenty's opportunity object
    const data = await this.gql<{ createOpportunity: { id: string } }>(`
      mutation CreateOpportunity($input: OpportunityCreateInput!) {
        createOpportunity(data: $input) {
          id
        }
      }
    `, {
      input: {
        name: event.title,
        stage: event.status === "published" ? "OPEN" : "DRAFT",
      },
    });

    return {
      externalId: data.createOpportunity.id,
      name: event.title,
      stage: event.status,
      contactIds: [],
    };
  }

  async syncAttendees(eventId: string, contacts: Contact[]): Promise<void> {
    for (const contact of contacts) {
      await this.upsertContact(contact);
    }
  }

  async searchContacts(query: string): Promise<CRMContact[]> {
    const data = await this.gql<{
      people: { edges: { node: { id: string; name: { firstName: string; lastName: string }; emails: { primaryEmail: string }; jobTitle?: string } }[] };
    }>(`
      query SearchPeople($filter: PersonFilterInput) {
        people(filter: $filter) {
          edges {
            node {
              id
              name { firstName lastName }
              emails { primaryEmail }
              jobTitle
            }
          }
        }
      }
    `, {
      filter: { emails: { primaryEmail: { eq: query } } },
    });

    return data.people.edges.map((e) => ({
      externalId: e.node.id,
      firstName: e.node.name.firstName,
      lastName: e.node.name.lastName,
      email: e.node.emails.primaryEmail,
      jobTitle: e.node.jobTitle,
    }));
  }
}

// ---------------------------------------------------------------------------
// HubSpot CRM Adapter
// ---------------------------------------------------------------------------

export class HubSpotAdapter implements CRMAdapter {
  readonly provider: CRMProvider = "hubspot";
  private apiKey: string;

  constructor(config: PlatformConfig) {
    this.apiKey = config.crmApiKey ?? "";
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const response = await fetch(`https://api.hubapi.com${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HubSpot API ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request("/crm/v3/objects/contacts?limit=1");
      return true;
    } catch { return false; }
  }

  async upsertContact(contact: Contact): Promise<CRMContact> {
    const properties = {
      firstname: contact.firstName,
      lastname: contact.lastName,
      email: contact.email,
      company: contact.company ?? "",
      jobtitle: contact.jobTitle ?? "",
      phone: contact.phone ?? "",
    };

    // Try create, fallback to update on conflict
    try {
      const data = await this.request<{ id: string }>("/crm/v3/objects/contacts", {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
      return { externalId: data.id, ...contact };
    } catch {
      // Search and update
      const existing = await this.searchContacts(contact.email);
      if (existing.length > 0) {
        await this.request(`/crm/v3/objects/contacts/${existing[0].externalId}`, {
          method: "PATCH",
          body: JSON.stringify({ properties }),
        });
        return existing[0];
      }
      throw new Error(`Failed to upsert contact: ${contact.email}`);
    }
  }

  async listContacts(opts?: { limit?: number; cursor?: string }): Promise<{ contacts: CRMContact[]; nextCursor?: string }> {
    const limit = opts?.limit ?? 50;
    const url = `/crm/v3/objects/contacts?limit=${limit}${opts?.cursor ? `&after=${opts.cursor}` : ""}`;
    const data = await this.request<{
      results: { id: string; properties: Record<string, string> }[];
      paging?: { next?: { after: string } };
    }>(url);

    return {
      contacts: data.results.map((r) => ({
        externalId: r.id,
        firstName: r.properties.firstname ?? "",
        lastName: r.properties.lastname ?? "",
        email: r.properties.email ?? "",
        company: r.properties.company,
        jobTitle: r.properties.jobtitle,
      })),
      nextCursor: data.paging?.next?.after,
    };
  }

  async upsertEvent(event: Event): Promise<CRMDeal> {
    const data = await this.request<{ id: string }>("/crm/v3/objects/deals", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          dealname: event.title,
          pipeline: "default",
          dealstage: "appointmentscheduled",
        },
      }),
    });

    return { externalId: data.id, name: event.title, stage: "scheduled", contactIds: [] };
  }

  async syncAttendees(_eventId: string, contacts: Contact[]): Promise<void> {
    for (const contact of contacts) {
      await this.upsertContact(contact);
    }
  }

  async searchContacts(query: string): Promise<CRMContact[]> {
    const data = await this.request<{
      results: { id: string; properties: Record<string, string> }[];
    }>("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: "email", operator: "EQ", value: query }],
        }],
      }),
    });

    return data.results.map((r) => ({
      externalId: r.id,
      firstName: r.properties.firstname ?? "",
      lastName: r.properties.lastname ?? "",
      email: r.properties.email ?? "",
      company: r.properties.company,
      jobTitle: r.properties.jobtitle,
    }));
  }
}

// ---------------------------------------------------------------------------
// Attio CRM Adapter
// ---------------------------------------------------------------------------

export class AttioAdapter implements CRMAdapter {
  readonly provider: CRMProvider = "attio";
  private apiKey: string;

  constructor(config: PlatformConfig) {
    this.apiKey = config.crmApiKey ?? "";
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const response = await fetch(`https://api.attio.com/v2${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Attio API ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request("/self");
      return true;
    } catch { return false; }
  }

  async upsertContact(contact: Contact): Promise<CRMContact> {
    const data = await this.request<{ data: { id: { record_id: string } } }>(
      "/objects/people/records",
      {
        method: "PUT",
        body: JSON.stringify({
          data: {
            values: {
              email_addresses: [contact.email],
              name: [{ first_name: contact.firstName, last_name: contact.lastName }],
              job_title: [contact.jobTitle ?? ""],
              company: contact.company ? [contact.company] : [],
            },
          },
          matching_attribute: "email_addresses",
        }),
      },
    );

    return {
      externalId: data.data.id.record_id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      company: contact.company,
      jobTitle: contact.jobTitle,
    };
  }

  async listContacts(opts?: { limit?: number; cursor?: string }): Promise<{ contacts: CRMContact[]; nextCursor?: string }> {
    const limit = opts?.limit ?? 50;
    const data = await this.request<{
      data: { id: { record_id: string }; values: Record<string, { value?: string; first_name?: string; last_name?: string }[]> }[];
      next_cursor?: string;
    }>(`/objects/people/records/query`, {
      method: "POST",
      body: JSON.stringify({ limit, offset: opts?.cursor ? Number(opts.cursor) : 0 }),
    });

    return {
      contacts: data.data.map((r) => ({
        externalId: r.id.record_id,
        firstName: r.values.name?.[0]?.first_name ?? "",
        lastName: r.values.name?.[0]?.last_name ?? "",
        email: r.values.email_addresses?.[0]?.value ?? "",
        jobTitle: r.values.job_title?.[0]?.value,
      })),
      nextCursor: data.next_cursor,
    };
  }

  async upsertEvent(event: Event): Promise<CRMDeal> {
    const data = await this.request<{ data: { id: { record_id: string } } }>(
      "/objects/deals/records",
      {
        method: "POST",
        body: JSON.stringify({
          data: { values: { name: [event.title] } },
        }),
      },
    );

    return { externalId: data.data.id.record_id, name: event.title, stage: "open", contactIds: [] };
  }

  async syncAttendees(_eventId: string, contacts: Contact[]): Promise<void> {
    for (const contact of contacts) {
      await this.upsertContact(contact);
    }
  }

  async searchContacts(query: string): Promise<CRMContact[]> {
    const data = await this.request<{
      data: { id: { record_id: string }; values: Record<string, { value?: string; first_name?: string; last_name?: string }[]> }[];
    }>("/objects/people/records/query", {
      method: "POST",
      body: JSON.stringify({
        filter: {
          email_addresses: { "$contains": query },
        },
      }),
    });

    return data.data.map((r) => ({
      externalId: r.id.record_id,
      firstName: r.values.name?.[0]?.first_name ?? "",
      lastName: r.values.name?.[0]?.last_name ?? "",
      email: r.values.email_addresses?.[0]?.value ?? "",
    }));
  }
}

// ---------------------------------------------------------------------------
// Salesforce CRM Adapter
// ---------------------------------------------------------------------------

export class SalesforceAdapter implements CRMAdapter {
  readonly provider: CRMProvider = "salesforce";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: PlatformConfig) {
    this.apiKey = config.crmApiKey ?? "";
    this.baseUrl = config.crmBaseUrl ?? "";
  }

  private async request<T>(path: string, opts?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/services/data/v59.0${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Salesforce API ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request("/limits");
      return true;
    } catch { return false; }
  }

  async upsertContact(contact: Contact): Promise<CRMContact> {
    const data = await this.request<{ id: string }>("/sobjects/Contact", {
      method: "POST",
      body: JSON.stringify({
        FirstName: contact.firstName,
        LastName: contact.lastName,
        Email: contact.email,
        Title: contact.jobTitle,
        Phone: contact.phone,
      }),
    });

    return {
      externalId: data.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
    };
  }

  async listContacts(opts?: { limit?: number; cursor?: string }): Promise<{ contacts: CRMContact[]; nextCursor?: string }> {
    const limit = opts?.limit ?? 50;
    const soql = `SELECT Id, FirstName, LastName, Email, Title, Account.Name FROM Contact LIMIT ${limit}`;
    const data = await this.request<{
      records: { Id: string; FirstName: string; LastName: string; Email: string; Title?: string; Account?: { Name: string } }[];
    }>(`/query?q=${encodeURIComponent(soql)}`);

    return {
      contacts: data.records.map((r) => ({
        externalId: r.Id,
        firstName: r.FirstName ?? "",
        lastName: r.LastName ?? "",
        email: r.Email ?? "",
        company: r.Account?.Name,
        jobTitle: r.Title,
      })),
    };
  }

  async upsertEvent(event: Event): Promise<CRMDeal> {
    const data = await this.request<{ id: string }>("/sobjects/Opportunity", {
      method: "POST",
      body: JSON.stringify({
        Name: event.title,
        StageName: "Prospecting",
        CloseDate: event.startAt,
      }),
    });

    return { externalId: data.id, name: event.title, stage: "Prospecting", contactIds: [] };
  }

  async syncAttendees(_eventId: string, contacts: Contact[]): Promise<void> {
    for (const contact of contacts) {
      await this.upsertContact(contact);
    }
  }

  async searchContacts(query: string): Promise<CRMContact[]> {
    const soql = `SELECT Id, FirstName, LastName, Email, Title FROM Contact WHERE Email = '${query.replace(/'/g, "\\'")}'`;
    const data = await this.request<{
      records: { Id: string; FirstName: string; LastName: string; Email: string; Title?: string }[];
    }>(`/query?q=${encodeURIComponent(soql)}`);

    return data.records.map((r) => ({
      externalId: r.Id,
      firstName: r.FirstName ?? "",
      lastName: r.LastName ?? "",
      email: r.Email ?? "",
      jobTitle: r.Title,
    }));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCRMAdapter(config: PlatformConfig): CRMAdapter | null {
  switch (config.crmProvider) {
    case "twenty": return new TwentyCRMAdapter(config);
    case "hubspot": return new HubSpotAdapter(config);
    case "attio": return new AttioAdapter(config);
    case "salesforce": return new SalesforceAdapter(config);
    case "none": return null;
    default: return null;
  }
}
