/**
 * Contact Enrichment Module
 *
 * Uses Apollo.io (and optionally GitHub) to enrich contact data so
 * organizers can learn about who's attending their events.
 * Enrichment covers company, title, seniority, industry, social profiles,
 * and for DevRel: GitHub activity, languages, and notable repos.
 */

import type { PlatformConfig } from "../config.js";
import type { Contact, ContactEnrichment, GitHubProfile } from "../types.js";
import type { ContactManager } from "./manager.js";

// ---------------------------------------------------------------------------
// Apollo.io API types
// ---------------------------------------------------------------------------

type ApolloPersonMatch = {
  id: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  seniority?: string;
  linkedin_url?: string;
  github_url?: string;
  twitter_url?: string;
  city?: string;
  state?: string;
  country?: string;
  organization?: {
    name?: string;
    short_description?: string;
    industry?: string;
    estimated_num_employees?: number;
    technologies?: string[];
  };
};

type ApolloEnrichResponse = {
  person: ApolloPersonMatch | null;
};

// ---------------------------------------------------------------------------
// GitHub API types
// ---------------------------------------------------------------------------

type GitHubUser = {
  login: string;
  public_repos: number;
  followers: number;
  following: number;
  bio: string | null;
  company: string | null;
  location: string | null;
};

type GitHubRepo = {
  name: string;
  stargazers_count: number;
  language: string | null;
  fork: boolean;
};

// ---------------------------------------------------------------------------
// Enrichment Service
// ---------------------------------------------------------------------------

export class EnrichmentService {
  constructor(
    private config: PlatformConfig,
    private contactManager: ContactManager,
  ) {}

  // -------------------------------------------------------------------------
  // Apollo.io Enrichment
  // -------------------------------------------------------------------------

  /** Enrich a single contact via Apollo.io People Enrichment API. */
  async enrichWithApollo(contactId: string): Promise<ContactEnrichment | null> {
    if (!this.config.apolloApiKey) {
      console.log("[ENRICHMENT] Apollo API key not configured, skipping.");
      return null;
    }

    const contact = this.contactManager.getContact(contactId);
    if (!contact) throw new Error(`Contact not found: ${contactId}`);

    const response = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.config.apolloApiKey,
      },
      body: JSON.stringify({
        email: contact.email,
        first_name: contact.firstName,
        last_name: contact.lastName,
      }),
    });

    if (!response.ok) {
      console.error(`[ENRICHMENT] Apollo API error: ${response.status}`);
      return null;
    }

    const data = (await response.json()) as ApolloEnrichResponse;
    if (!data.person) return null;

    const enrichment: ContactEnrichment = {
      provider: "apollo",
      enrichedAt: new Date().toISOString(),
      company: data.person.organization?.name,
      companySize: data.person.organization?.estimated_num_employees?.toString(),
      industry: data.person.organization?.industry,
      jobTitle: data.person.title,
      seniority: data.person.seniority,
      linkedinUrl: data.person.linkedin_url,
      location: [data.person.city, data.person.state, data.person.country]
        .filter(Boolean)
        .join(", "),
      technologies: data.person.organization?.technologies,
      raw: data.person as unknown as Record<string, unknown>,
    };

    // Update the contact with enrichment data and social profiles
    this.contactManager.updateContact(contactId, {
      enrichment,
      company: enrichment.company ?? contact.company,
      jobTitle: enrichment.jobTitle ?? contact.jobTitle,
      social: {
        ...contact.social,
        linkedin: data.person.linkedin_url ?? contact.social.linkedin,
        github: data.person.github_url ?? contact.social.github,
        twitter: data.person.twitter_url ?? contact.social.twitter,
      },
    });

    return enrichment;
  }

  /** Bulk enrich contacts for an org. */
  async bulkEnrich(orgId: string, opts?: { limit?: number; skipEnriched?: boolean }): Promise<{
    enriched: number;
    skipped: number;
    failed: number;
  }> {
    const contacts = this.contactManager.listContacts(orgId);
    const limit = opts?.limit ?? 100;
    let enriched = 0;
    let skipped = 0;
    let failed = 0;

    for (const contact of contacts.slice(0, limit)) {
      if (opts?.skipEnriched && contact.enrichment) {
        skipped++;
        continue;
      }

      try {
        const result = await this.enrichWithApollo(contact.id);
        if (result) enriched++;
        else skipped++;
      } catch (err) {
        console.error(`[ENRICHMENT] Failed for ${contact.email}:`, err);
        failed++;
      }

      // Rate limiting: Apollo allows ~5 req/sec on most plans
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return { enriched, skipped, failed };
  }

  // -------------------------------------------------------------------------
  // GitHub Enrichment (DevRel)
  // -------------------------------------------------------------------------

  /** Fetch GitHub profile data for a contact. */
  async enrichGitHub(contactId: string): Promise<GitHubProfile | null> {
    const contact = this.contactManager.getContact(contactId);
    if (!contact?.social.github) return null;

    const username = this.extractGitHubUsername(contact.social.github);
    if (!username) return null;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "FrontierTowerPlatform/1.0",
    };
    if (this.config.githubToken) {
      headers.Authorization = `Bearer ${this.config.githubToken}`;
    }

    try {
      // Fetch user profile
      const userResp = await fetch(`https://api.github.com/users/${username}`, { headers });
      if (!userResp.ok) return null;
      const user = (await userResp.json()) as GitHubUser;

      // Fetch repos (top 100 by stars)
      const reposResp = await fetch(
        `https://api.github.com/users/${username}/repos?sort=stars&per_page=100`,
        { headers },
      );
      const repos = reposResp.ok ? ((await reposResp.json()) as GitHubRepo[]) : [];

      // Compute top languages
      const langCounts = new Map<string, number>();
      for (const repo of repos.filter((r) => !r.fork && r.language)) {
        langCounts.set(repo.language!, (langCounts.get(repo.language!) ?? 0) + 1);
      }
      const topLanguages = [...langCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([lang]) => lang);

      // Notable repos (10+ stars)
      const notableRepos = repos
        .filter((r) => !r.fork && r.stargazers_count >= 10)
        .map((r) => ({ name: r.name, stars: r.stargazers_count, language: r.language ?? undefined }));

      const profile: GitHubProfile = {
        username,
        publicRepos: user.public_repos,
        followers: user.followers,
        following: user.following,
        bio: user.bio ?? undefined,
        company: user.company ?? undefined,
        location: user.location ?? undefined,
        topLanguages,
        contributionsLastYear: 0, // Would need GraphQL API for this
        notableRepos,
        fetchedAt: new Date().toISOString(),
      };

      return profile;
    } catch (err) {
      console.error(`[GITHUB] Failed to fetch profile for ${username}:`, err);
      return null;
    }
  }

  /** Bulk enrich GitHub profiles for all contacts with GitHub URLs. */
  async bulkEnrichGitHub(orgId: string): Promise<{ enriched: number; skipped: number }> {
    const contacts = this.contactManager.listContacts(orgId)
      .filter((c) => c.social.github);

    let enriched = 0;
    let skipped = 0;

    for (const contact of contacts) {
      const profile = await this.enrichGitHub(contact.id);
      if (profile) {
        enriched++;
        // Update interests based on GitHub languages
        const currentInterests = new Set(contact.interests);
        for (const lang of profile.topLanguages) {
          currentInterests.add(lang);
        }
        this.contactManager.updateContact(contact.id, {
          interests: [...currentInterests],
        });
      } else {
        skipped++;
      }

      // GitHub rate limiting
      await new Promise((resolve) => setTimeout(resolve, this.config.githubToken ? 100 : 1500));
    }

    return { enriched, skipped };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private extractGitHubUsername(input: string): string | null {
    // Handle full URLs
    const urlMatch = input.match(/github\.com\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    // Handle plain usernames
    if (/^[a-zA-Z0-9_-]+$/.test(input)) return input;
    return null;
  }
}
