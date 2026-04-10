/**
 * Core types for the Luma SaaS Integration Platform.
 *
 * This platform connects Luma event management with automated email marketing,
 * contact enrichment, CRM integrations, and a network of 200k+ event attendees.
 */

// ---------------------------------------------------------------------------
// Organization / Tenant
// ---------------------------------------------------------------------------

/** A customer organization using the platform. */
export type Organization = {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "starter" | "pro" | "enterprise";
  lumaApiKey?: string;
  lumaAdminEmail?: string;
  /** Luma calendar URLs this org manages. */
  lumaSourceUrls: string[];
  createdAt: string;
  settings: OrgSettings;
};

export type OrgSettings = {
  /** Max emails per month included in plan. */
  emailQuota: number;
  /** Whether the org has enrichment enabled (Apollo.io). */
  enrichmentEnabled: boolean;
  /** Whether the org can access the shared network for invites. */
  networkAccessEnabled: boolean;
  /** Auto-approval rules. */
  approvalEnabled: boolean;
  /** Default review window (hours) before sending. */
  reviewWindowHours: number;
};

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactSource = "luma_import" | "manual" | "csv_upload" | "crm_sync" | "network_rsvp" | "api";

export type SocialProfiles = {
  github?: string;
  linkedin?: string;
  twitter?: string;
  /** Personal website / portfolio. */
  website?: string;
};

export type Contact = {
  id: string;
  orgId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  company?: string;
  jobTitle?: string;
  /** Social profiles for DevRel tracking. */
  social: SocialProfiles;
  /** Topic interests inferred or declared. */
  interests: string[];
  tags: string[];
  source: ContactSource;
  /** Whether this contact was sourced from the shared network. */
  isNetworkSourced: boolean;
  /** Enrichment data from Apollo.io or similar. */
  enrichment?: ContactEnrichment;
  /** Social engagement score (posting, sharing, etc). */
  socialScore: number;
  status: "active" | "unsubscribed" | "bounced" | "pending";
  createdAt: string;
  updatedAt: string;
};

export type ContactEnrichment = {
  provider: "apollo" | "clearbit" | "manual";
  enrichedAt: string;
  company?: string;
  companySize?: string;
  industry?: string;
  jobTitle?: string;
  seniority?: string;
  linkedinUrl?: string;
  location?: string;
  technologies?: string[];
  /** Raw payload from the enrichment provider. */
  raw?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Mailing Lists / Segments
// ---------------------------------------------------------------------------

export type MailingList = {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  /** Dynamic filter criteria. Contacts matching these are auto-included. */
  filters: SegmentFilter[];
  /** Manually added contact IDs. */
  staticContactIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SegmentFilter = {
  field: "interests" | "tags" | "source" | "status" | "company" | "jobTitle" | "seniority" | "industry";
  operator: "contains" | "equals" | "not_equals" | "in" | "not_in";
  value: string | string[];
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventStatus = "draft" | "published" | "cancelled" | "completed";

export type Event = {
  id: string;
  orgId: string;
  /** Luma event ID if synced. */
  lumaEventId?: string;
  /** Hi.Events event ID if using event pages. */
  hiEventsId?: string;
  title: string;
  description: string;
  startAt: string;
  endAt?: string;
  location?: string;
  url?: string;
  topics: string[];
  status: EventStatus;
  /** Whether registration requires approval. */
  requiresApproval: boolean;
  /** Approval criteria (used by automation). */
  approvalCriteria?: ApprovalCriteria;
  capacity?: number;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalCriteria = {
  /** Auto-approve if contact matches ALL of these. */
  autoApproveFilters: SegmentFilter[];
  /** Auto-decline if contact matches ANY of these. */
  autoDeclineFilters: SegmentFilter[];
  /** Require manual review for everyone else. */
  defaultAction: "approve" | "decline" | "manual_review";
};

// ---------------------------------------------------------------------------
// RSVPs / Guests
// ---------------------------------------------------------------------------

export type RSVPStatus = "pending" | "approved" | "declined" | "waitlisted" | "cancelled";

export type RSVP = {
  id: string;
  eventId: string;
  contactId: string;
  orgId: string;
  status: RSVPStatus;
  /** How they registered. */
  source: "luma_sync" | "invite_sent" | "self_registered" | "network_invite";
  /** If they came from the shared network, the originating org. */
  networkSourceOrgId?: string;
  registrationData?: Record<string, unknown>;
  approvedAt?: string;
  declinedAt?: string;
  declineReason?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Email Campaigns
// ---------------------------------------------------------------------------

export type CampaignType = "event_invite" | "newsletter" | "follow_up" | "waitlist_update";

export type Campaign = {
  id: string;
  orgId: string;
  eventId?: string;
  type: CampaignType;
  name: string;
  subject: string;
  /** Mailing list IDs to send to. */
  mailingListIds: string[];
  /** Additional individual contact IDs. */
  contactIds: string[];
  /** Whether to include network contacts (targeted by interest). */
  useNetworkContacts: boolean;
  /** Max network contacts to invite. */
  networkContactLimit?: number;
  status: "draft" | "scheduled" | "sending" | "sent" | "cancelled";
  scheduledAt?: string;
  sentAt?: string;
  stats?: CampaignStats;
  createdAt: string;
};

export type CampaignStats = {
  totalSent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  unsubscribed: number;
  rsvpd: number;
};

// ---------------------------------------------------------------------------
// Network (shared contact pool)
// ---------------------------------------------------------------------------

/** A record of a contact available in the shared network for targeted invites. */
export type NetworkContact = {
  id: string;
  /** Hashed email for matching without exposing the raw address. */
  emailHash: string;
  interests: string[];
  /** Aggregated event attendance topics. */
  topicAffinities: Record<string, number>;
  lastEventDate: string;
  totalEventsAttended: number;
  /** The org will never see PII unless the contact RSVPs to their event. */
};

// ---------------------------------------------------------------------------
// CRM Integration
// ---------------------------------------------------------------------------

export type CRMProvider = "twenty" | "attio" | "hubspot" | "salesforce" | "none";

export type CRMConfig = {
  provider: CRMProvider;
  apiKey?: string;
  baseUrl?: string;
  /** Field mappings: our field -> CRM field. */
  fieldMappings: Record<string, string>;
  syncDirection: "push" | "pull" | "bidirectional";
  syncEnabled: boolean;
};

// ---------------------------------------------------------------------------
// Automation Rules
// ---------------------------------------------------------------------------

export type AutomationTrigger =
  | "new_rsvp"
  | "rsvp_approved"
  | "rsvp_declined"
  | "contact_enriched"
  | "campaign_sent"
  | "event_created"
  | "unsubscribe";

export type AutomationAction =
  | "send_email"
  | "add_to_list"
  | "remove_from_list"
  | "update_crm"
  | "notify_slack"
  | "notify_telegram"
  | "approve_rsvp"
  | "decline_rsvp";

export type AutomationRule = {
  id: string;
  orgId: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: SegmentFilter[];
  actions: { type: AutomationAction; config: Record<string, unknown> }[];
  enabled: boolean;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Social Engagement / DevRel Tracking
// ---------------------------------------------------------------------------

export type SocialPlatform = "github" | "linkedin" | "twitter";

/** Tracks a social post about an event by a contact. */
export type SocialPost = {
  id: string;
  contactId: string;
  eventId: string;
  orgId: string;
  platform: SocialPlatform;
  postUrl: string;
  postContent?: string;
  /** Metrics pulled from the platform. */
  metrics?: SocialPostMetrics;
  /** Whether the post was prompted by an engagement campaign. */
  wasIncentivized: boolean;
  detectedAt: string;
};

export type SocialPostMetrics = {
  likes: number;
  comments: number;
  shares: number;
  impressions?: number;
};

/** An engagement campaign asking attendees to post about an event. */
export type SocialEngagementCampaign = {
  id: string;
  orgId: string;
  eventId: string;
  name: string;
  /** Message template sent to attendees asking them to post. */
  messageTemplate: string;
  /** Channels to reach attendees through. */
  channels: ("email" | "telegram" | "in_app")[];
  /** Incentive offered (e.g. "Priority access to next event"). */
  incentiveDescription?: string;
  /** Hashtags or mentions to include. */
  suggestedHashtags: string[];
  suggestedMentions: string[];
  /** Target platforms for posting. */
  targetPlatforms: SocialPlatform[];
  status: "draft" | "active" | "completed";
  stats?: {
    messagesSent: number;
    postsDetected: number;
    totalReach: number;
  };
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Event Stakeholders (Speakers, Sponsors, Community Leaders, etc.)
// ---------------------------------------------------------------------------

export type StakeholderRole =
  | "speaker"
  | "community_leader"
  | "sponsor"
  | "workshop_instructor"
  | "dev_advocate"
  | "panelist"
  | "mc"
  | "organizer";

/** A featured person associated with an event. */
export type EventStakeholder = {
  id: string;
  contactId: string;
  eventId: string;
  orgId: string;
  role: StakeholderRole;
  /** Display name (may differ from contact name for branding). */
  displayName: string;
  /** Short bio for event page / promo materials. */
  bio?: string;
  /** Headshot / avatar URL. */
  photoUrl?: string;
  /** Talk / workshop title. */
  sessionTitle?: string;
  /** Talk / workshop description. */
  sessionDescription?: string;
  /** Company they represent at this event. */
  representingCompany?: string;
  /** Sponsor tier if applicable. */
  sponsorTier?: "platinum" | "gold" | "silver" | "bronze" | "community";
  /** Social profiles for promotion. */
  social: SocialProfiles;
  /** Whether this stakeholder has been featured in promo materials. */
  isFeatured: boolean;
  /** Whether promo has been sent for this stakeholder. */
  promoSentAt?: string;
  createdAt: string;
};

/** A promotional feature/spotlight for a stakeholder. */
export type StakeholderSpotlight = {
  id: string;
  stakeholderId: string;
  eventId: string;
  orgId: string;
  /** Generated promo content for social/email. */
  promoContent: {
    headline: string;
    body: string;
    hashtags: string[];
    mentionHandles: string[];
  };
  /** Channels this spotlight was distributed to. */
  distributedTo: ("email" | "twitter" | "linkedin" | "telegram" | "website")[];
  /** Engagement metrics. */
  metrics?: SocialPostMetrics;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Developer Ambassador Program
// ---------------------------------------------------------------------------

export type AmbassadorStatus = "applied" | "active" | "inactive" | "alumni";

export type OpportunityType =
  | "conference_speaker"
  | "workshop_instructor"
  | "meetup_organizer"
  | "hackathon_mentor"
  | "hackathon_judge"
  | "panelist"
  | "podcast_guest"
  | "content_creator"
  | "community_manager"
  | "dev_advocate_role";

/** A developer ambassador in the program. */
export type DevAmbassador = {
  id: string;
  contactId: string;
  /** Ambassador profile display name. */
  displayName: string;
  bio: string;
  social: SocialProfiles;
  /** Topics/technologies they're experts in. */
  expertise: string[];
  /** Languages they speak. */
  languages: string[];
  /** Cities/regions they can attend events in. */
  availableLocations: string[];
  /** Types of opportunities they're interested in. */
  interestedIn: OpportunityType[];
  /** Past experience (auto-populated from event history). */
  pastExperience: AmbassadorExperience[];
  /** Ambassador score based on activity, reach, and feedback. */
  reputationScore: number;
  status: AmbassadorStatus;
  appliedAt: string;
  activatedAt?: string;
};

export type AmbassadorExperience = {
  eventId: string;
  eventTitle: string;
  role: StakeholderRole;
  date: string;
  /** Feedback score (1-5) from the organizer. */
  organizerRating?: number;
  /** Feedback score (1-5) from attendees. */
  attendeeRating?: number;
};

/** An opportunity posted by an organizer looking for ambassadors. */
export type AmbassadorOpportunity = {
  id: string;
  orgId: string;
  eventId?: string;
  type: OpportunityType;
  title: string;
  description: string;
  /** Topics/technologies relevant to this opportunity. */
  topics: string[];
  location?: string;
  isRemote: boolean;
  date?: string;
  /** Compensation offered. */
  compensation?: {
    type: "paid" | "travel_covered" | "volunteer" | "stipend";
    amount?: number;
    currency?: string;
    details?: string;
  };
  /** Requirements for applicants. */
  requirements: string[];
  /** Max number of ambassadors needed. */
  spotsAvailable: number;
  status: "open" | "filled" | "closed" | "draft";
  applications: AmbassadorApplication[];
  createdAt: string;
};

export type AmbassadorApplication = {
  id: string;
  ambassadorId: string;
  opportunityId: string;
  coverNote: string;
  status: "pending" | "accepted" | "declined" | "withdrawn";
  appliedAt: string;
  respondedAt?: string;
};

/** GitHub-specific data for DevRel tracking. */
export type GitHubProfile = {
  username: string;
  publicRepos: number;
  followers: number;
  following: number;
  bio?: string;
  company?: string;
  location?: string;
  /** Top languages by repo count. */
  topLanguages: string[];
  /** Total contributions in last year. */
  contributionsLastYear: number;
  /** Notable repos (starred > 10). */
  notableRepos: { name: string; stars: number; language?: string }[];
  fetchedAt: string;
};
