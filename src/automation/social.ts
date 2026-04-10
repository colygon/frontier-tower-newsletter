/**
 * Social Engagement & DevRel Tracking
 *
 * Tracks attendees' social activity across GitHub, LinkedIn, and X (Twitter).
 * Enables organizers to:
 * - See who posted about their event
 * - Incentivize social sharing via engagement campaigns
 * - Track GitHub profiles for DevRel
 * - Measure social reach and impact
 *
 * Uses Apify for web scraping and Tavily for AI-powered search.
 */

import type { PlatformConfig } from "../config.js";
import type {
  Contact,
  Event,
  SocialPost,
  SocialPostMetrics,
  SocialEngagementCampaign,
  SocialPlatform,
} from "../types.js";
import type { ContactManager } from "../contacts/manager.js";
import type { EmailService } from "../email/service.js";

// ---------------------------------------------------------------------------
// Apify client for social scraping
// ---------------------------------------------------------------------------

type ApifyRunResult = {
  items: Record<string, unknown>[];
};

async function runApifyActor(
  actorId: string,
  input: Record<string, unknown>,
  apiToken: string,
): Promise<ApifyRunResult> {
  const response = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${apiToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Apify actor ${actorId} failed: ${response.status} ${body}`);
  }

  const items = (await response.json()) as Record<string, unknown>[];
  return { items };
}

// ---------------------------------------------------------------------------
// Tavily client for AI-powered search
// ---------------------------------------------------------------------------

type TavilySearchResult = {
  results: {
    title: string;
    url: string;
    content: string;
    score: number;
  }[];
};

async function searchTavily(
  query: string,
  apiKey: string,
  opts?: { maxResults?: number; searchDepth?: "basic" | "advanced" },
): Promise<TavilySearchResult> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: opts?.maxResults ?? 10,
      search_depth: opts?.searchDepth ?? "basic",
      include_answer: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily search failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<TavilySearchResult>;
}

// ---------------------------------------------------------------------------
// Social Tracking Service
// ---------------------------------------------------------------------------

export class SocialTrackingService {
  private posts: Map<string, SocialPost> = new Map();
  private campaigns: Map<string, SocialEngagementCampaign> = new Map();

  constructor(
    private config: PlatformConfig,
    private contactManager: ContactManager,
    private emailService: EmailService,
  ) {}

  // -------------------------------------------------------------------------
  // Post Detection (using Tavily AI search + Apify scraping)
  // -------------------------------------------------------------------------

  /**
   * Search for social posts about an event across platforms.
   * Uses Tavily for AI-powered search and Apify for structured scraping.
   */
  async detectEventPosts(event: Event, opts?: {
    platforms?: SocialPlatform[];
    hashtags?: string[];
  }): Promise<SocialPost[]> {
    const platforms = opts?.platforms ?? ["twitter", "linkedin", "github"];
    const detected: SocialPost[] = [];

    // Build search queries
    const baseQuery = `"${event.title}"`;
    const hashtagQueries = (opts?.hashtags ?? []).map((h) => `#${h}`);

    for (const platform of platforms) {
      try {
        const posts = await this.searchPlatform(platform, event, baseQuery, hashtagQueries);
        detected.push(...posts);
      } catch (err) {
        console.error(`[SOCIAL] Failed to search ${platform} for event ${event.id}:`, err);
      }
    }

    // Store detected posts
    for (const post of detected) {
      this.posts.set(post.id, post);
    }

    return detected;
  }

  private async searchPlatform(
    platform: SocialPlatform,
    event: Event,
    query: string,
    hashtagQueries: string[],
  ): Promise<SocialPost[]> {
    const posts: SocialPost[] = [];
    const fullQuery = [query, ...hashtagQueries].join(" OR ");

    // Use Tavily for discovery
    if (process.env.TAVILY_API_KEY) {
      const siteFilter = platform === "twitter" ? "site:x.com OR site:twitter.com"
        : platform === "linkedin" ? "site:linkedin.com"
        : platform === "github" ? "site:github.com"
        : "";

      const results = await searchTavily(
        `${fullQuery} ${siteFilter}`,
        process.env.TAVILY_API_KEY,
        { maxResults: 20, searchDepth: "advanced" },
      );

      for (const result of results.results) {
        // Try to match to a known contact
        const contact = this.findContactByPostUrl(event.orgId, result.url);

        posts.push({
          id: crypto.randomUUID(),
          contactId: contact?.id ?? "unknown",
          eventId: event.id,
          orgId: event.orgId,
          platform,
          postUrl: result.url,
          postContent: result.content.slice(0, 500),
          wasIncentivized: false,
          detectedAt: new Date().toISOString(),
        });
      }
    }

    // Use Apify for structured Twitter/X scraping
    if (platform === "twitter" && process.env.APIFY_API_TOKEN) {
      try {
        const result = await runApifyActor(
          "apidojo~tweet-scraper",
          {
            searchTerms: [fullQuery],
            maxTweets: 50,
            sort: "Latest",
          },
          process.env.APIFY_API_TOKEN,
        );

        for (const item of result.items) {
          const url = String(item.url ?? "");
          const text = String(item.full_text ?? item.text ?? "");
          const userObj = (item.user ?? {}) as Record<string, unknown>;
          const contact = this.findContactByTwitterHandle(
            event.orgId,
            String(userObj.screen_name ?? ""),
          );

          posts.push({
            id: crypto.randomUUID(),
            contactId: contact?.id ?? "unknown",
            eventId: event.id,
            orgId: event.orgId,
            platform: "twitter",
            postUrl: url,
            postContent: text.slice(0, 500),
            metrics: {
              likes: Number(item.favorite_count ?? 0),
              comments: Number(item.reply_count ?? 0),
              shares: Number(item.retweet_count ?? 0),
              impressions: Number(item.views_count ?? 0),
            },
            wasIncentivized: false,
            detectedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error("[SOCIAL] Apify Twitter scrape failed:", err);
      }
    }

    // Use Apify for LinkedIn scraping
    if (platform === "linkedin" && process.env.APIFY_API_TOKEN) {
      try {
        const result = await runApifyActor(
          "anchor~linkedin-post-search-scraper",
          { searchQuery: fullQuery, maxResults: 30 },
          process.env.APIFY_API_TOKEN,
        );

        for (const item of result.items) {
          posts.push({
            id: crypto.randomUUID(),
            contactId: "unknown",
            eventId: event.id,
            orgId: event.orgId,
            platform: "linkedin",
            postUrl: String(item.postUrl ?? item.url ?? ""),
            postContent: String(item.text ?? "").slice(0, 500),
            metrics: {
              likes: Number(item.numLikes ?? 0),
              comments: Number(item.numComments ?? 0),
              shares: Number(item.numShares ?? 0),
            },
            wasIncentivized: false,
            detectedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error("[SOCIAL] Apify LinkedIn scrape failed:", err);
      }
    }

    return posts;
  }

  // -------------------------------------------------------------------------
  // Social Engagement Campaigns
  // -------------------------------------------------------------------------

  /**
   * Create a campaign to ask attendees to post about an event.
   * Messages them via email/telegram with suggested content & hashtags.
   */
  async createEngagementCampaign(opts: {
    orgId: string;
    eventId: string;
    name: string;
    messageTemplate: string;
    channels: ("email" | "telegram" | "in_app")[];
    incentiveDescription?: string;
    suggestedHashtags: string[];
    suggestedMentions: string[];
    targetPlatforms: SocialPlatform[];
  }): Promise<SocialEngagementCampaign> {
    const campaign: SocialEngagementCampaign = {
      id: crypto.randomUUID(),
      ...opts,
      status: "draft",
      createdAt: new Date().toISOString(),
    };

    this.campaigns.set(campaign.id, campaign);
    return campaign;
  }

  /**
   * Send engagement campaign messages to attendees.
   */
  async sendEngagementCampaign(
    campaignId: string,
    contacts: Contact[],
    event: Event,
  ): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new Error(`Campaign not found: ${campaignId}`);

    if (campaign.channels.includes("email")) {
      const stats = await this.emailService.sendSocialEngagementRequest(
        contacts,
        event,
        {
          messageTemplate: campaign.messageTemplate,
          hashtags: campaign.suggestedHashtags,
          mentions: campaign.suggestedMentions,
        },
      );

      campaign.stats = {
        messagesSent: stats.totalSent,
        postsDetected: 0,
        totalReach: 0,
      };
    }

    campaign.status = "active";
  }

  /**
   * Check for new posts from an active engagement campaign and update scores.
   */
  async updateCampaignResults(campaignId: string, event: Event): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return;

    const newPosts = await this.detectEventPosts(event, {
      platforms: campaign.targetPlatforms,
      hashtags: campaign.suggestedHashtags,
    });

    // Mark incentivized posts
    for (const post of newPosts) {
      post.wasIncentivized = true;
      this.posts.set(post.id, post);
    }

    // Update campaign stats
    const allCampaignPosts = [...this.posts.values()].filter(
      (p) => p.eventId === event.id && p.wasIncentivized,
    );

    campaign.stats = {
      messagesSent: campaign.stats?.messagesSent ?? 0,
      postsDetected: allCampaignPosts.length,
      totalReach: allCampaignPosts.reduce((sum, p) => {
        return sum + (p.metrics?.impressions ?? p.metrics?.likes ?? 0);
      }, 0),
    };

    // Update social scores for contacts who posted
    for (const post of allCampaignPosts) {
      if (post.contactId !== "unknown") {
        const contact = this.contactManager.getContact(post.contactId);
        if (contact) {
          this.contactManager.updateContact(contact.id, {
            socialScore: contact.socialScore + this.calculatePostScore(post.metrics),
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Social Score Calculation
  // -------------------------------------------------------------------------

  private calculatePostScore(metrics?: SocialPostMetrics): number {
    if (!metrics) return 1;
    return (
      metrics.likes * 1 +
      metrics.comments * 3 +
      metrics.shares * 5 +
      (metrics.impressions ?? 0) * 0.01
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private findContactByPostUrl(orgId: string, url: string): Contact | undefined {
    // Try to extract username from URL and match to contacts
    const contacts = this.contactManager.listContacts(orgId);

    for (const contact of contacts) {
      if (contact.social.twitter && url.includes(contact.social.twitter)) return contact;
      if (contact.social.linkedin && url.includes(contact.social.linkedin)) return contact;
      if (contact.social.github && url.includes(contact.social.github)) return contact;
    }

    return undefined;
  }

  private findContactByTwitterHandle(orgId: string, handle: string): Contact | undefined {
    if (!handle) return undefined;
    const contacts = this.contactManager.listContacts(orgId);
    const normalizedHandle = handle.toLowerCase().replace("@", "");

    return contacts.find((c) => {
      const twitter = c.social.twitter?.toLowerCase() ?? "";
      return twitter.includes(normalizedHandle);
    });
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  getPostsForEvent(eventId: string): SocialPost[] {
    return [...this.posts.values()].filter((p) => p.eventId === eventId);
  }

  getEventSocialStats(eventId: string): {
    totalPosts: number;
    byPlatform: Record<SocialPlatform, number>;
    totalReach: number;
    topPosters: { contactId: string; postCount: number; totalReach: number }[];
  } {
    const posts = this.getPostsForEvent(eventId);

    const byPlatform: Record<SocialPlatform, number> = { github: 0, linkedin: 0, twitter: 0 };
    const posterStats = new Map<string, { postCount: number; totalReach: number }>();

    let totalReach = 0;

    for (const post of posts) {
      byPlatform[post.platform]++;
      const reach = post.metrics?.impressions ?? post.metrics?.likes ?? 0;
      totalReach += reach;

      if (post.contactId !== "unknown") {
        const existing = posterStats.get(post.contactId) ?? { postCount: 0, totalReach: 0 };
        existing.postCount++;
        existing.totalReach += reach;
        posterStats.set(post.contactId, existing);
      }
    }

    const topPosters = [...posterStats.entries()]
      .map(([contactId, stats]) => ({ contactId, ...stats }))
      .sort((a, b) => b.totalReach - a.totalReach)
      .slice(0, 10);

    return { totalPosts: posts.length, byPlatform, totalReach, topPosters };
  }
}
