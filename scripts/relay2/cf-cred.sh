# Source me (zsh). Feeds wrangler the `cf` CLI OAuth credentials via env; never prints them.
CLOUDFLARE_API_TOKEN=$(node ${${(%):-%x}:A:h}/cf-token.mjs) || { echo "cf-cred: no cf token" >&2; return 1; }
export CLOUDFLARE_API_TOKEN
