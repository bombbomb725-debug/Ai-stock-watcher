# Cloudflare Git deployment

This repository is connected to the existing Cloudflare Worker `ai-stock-watcher-api`.

- Production branch: `main`
- Deploy command: `npx wrangler deploy`
- Worker configuration: `wrangler.toml`
- Worker entry point: `worker.js`

Cloudflare should run the deploy command when a new commit is pushed to the connected production branch. Keep API credentials in Cloudflare Worker secrets; never commit them to this repository.
