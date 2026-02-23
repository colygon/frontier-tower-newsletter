# Frontier Tower Newsletter Automation

Standalone weekly automation for Frontier Tower lead outreach from Luma events.

## Features

- Fetches upcoming events from one or more Luma sources (`LUMA_SOURCE_URLS`).
- Builds lead-specific digests by topic preference (Neuro tech / AI / Crypto by default).
- Sends a **24-hour preview** to leads via:
  - Email (SendGrid)
  - Telegram
- Supports action overrides before final send (`STOP`, topic edits, event remove/add hooks via action JSON file).
- After review window expires, auto-finalizes and sends final messages.

## Setup

1. Install deps:

```bash
npm install
```

2. Create `.env.local` from `.env.example`.

3. Add data files:
- `data/frontier-floor-leads.example.json`
- `data/frontier-floor-lead-actions.example.json` (optional, can be empty list)

## Run

- Create draft + preview:

```bash
npm run create
```

- Finalize due drafts:

```bash
npm run finalize
```

- Run both phases:

```bash
npm run run
```

## Scheduling recommendation

- **Tuesday 08:00 AM** local: `npm run create`
- **Hourly**: `npm run finalize` (or a cron aligned with review window)

## Repo structure

- `scripts/frontier-luma-newsletter.ts` — core automation
- `data/` — sample lead/action/state inputs
- `.env.example` — required env vars

This project is intentionally independent from `clawhack-ai`.