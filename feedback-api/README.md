# Feedback API

One Vercel serverless function, `api/feedback.js`. The game's "Send feedback"
dialog posts to it, and it opens a GitHub issue labeled `feedback` on
meaningladder/meaningladder.github.io. Players don't need a GitHub account.

- **Secret:** `GITHUB_TOKEN`, set in Vercel (Project, Settings, Environment
  Variables). Use a fine-grained token for this one repo with only
  *Issues: Read and write*. Never commit it.
- **Who can call it:** only https://meaningladder.github.io and
  http://localhost:8000 (`make serve`). Add an origin in `ORIGINS` if the site moves.
- **Spam guards:** honeypot field, at least 3 seconds with the form open, size
  caps, and 3 posts per IP per 10 minutes per instance (best effort).
- **Tests:** `tests/js/feedback-api.test.mjs` in the main repo.

GitHub Pages never deploys this folder (`.github/workflows/pages.yml` copies a
fixed list of files).
