# Ask feature flag

This page keeps the Ask flag notes that used to live in the root README. Usage events are in [ANALYTICS.md](ANALYTICS.md).

Ask stays hidden in the web app until PostHog evaluates the boolean flag `ask` to true. A missing key, a disabled or missing flag, and a failed request all keep it hidden. This controls the Ask navigation and page, including a direct visit to `/app/ask`. The authenticated server route `POST /api/ask` stays available either way.

## Web

Copy `web/.env.example` to `web/.env.local`. Set `VITE_POSTHOG_KEY` to the public Project API key from PostHog project settings. Set `VITE_POSTHOG_HOST` to your ingestion host. Never put a personal or secret API key in a `VITE_` variable. `web/.env.example` is tracked. `web/.env.local` is gitignored.

Create a boolean flag named `ask` in PostHog and allow client-side evaluation. Leave it disabled, or at 0% rollout, until Ask should show. The browser sends an anonymous id stored in `sessionStorage` for that tab (`doggy.flags-id` in `web/src/hooks/useAskFlag.ts`). Percentage rollouts therefore apply to tabs, not to Doggy accounts. Evaluation calls PostHog's public flags API: `POST {host}/flags?v=2`.

Vite reads `VITE_` variables at build time. Restart `bun run dev` after editing them locally.

## Production build of the web app

For the hosted layout in `deploy/`, put the same values in `/srv/doggy/web/.env.local`, keep that file owned by the `doggy` user, and run `/srv/doggy/deploy/deploy.sh` so the web app is rebuilt. Changing the PostHog flag takes effect on the next page load. It does not need another build.

Server analytics uses `POSTHOG_KEY` and `POSTHOG_HOST` in `server/.env`. On the hosted layout those live in `/etc/doggy/doggy.env`. See [ANALYTICS.md](ANALYTICS.md). A custom ingestion host must be set on the server as well. The HTML content security policy allows the US and EU PostHog hosts plus the origin of `POSTHOG_HOST`.
