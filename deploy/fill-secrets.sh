#!/usr/bin/env bash
# Prompts for each credential and writes it as line 2 of the matching
# file in deploy/secrets/. Secret input is not echoed to the terminal.
set -euo pipefail
cd "$(dirname "$0")/secrets"

fill() { # name prompt secret?
  local name="$1" prompt="$2" secret="${3:-yes}" value
  if [ -s "$name" ] && [ "$(sed -n '2p' "$name" | tr -d '[:space:]')" != "" ]; then
    printf '%-24s already filled, skipping (delete the file to redo)\n' "$name"
    return
  fi
  if [ "$secret" = yes ]; then
    read -r -s -p "$prompt: " value; echo
  else
    read -r -p "$prompt: " value
  fi
  printf '%s\n%s\n' "$name" "$value" > "$name"
}

echo "== Butler credentials =="
echo "Values are hidden while you type. Already-filled entries are skipped."
echo

NEXTCLOUD_SERVER_DEFAULT="https://fie.nl.tab.digital"
if [ ! -s NEXTCLOUD_SERVER ] || [ -z "$(sed -n '2p' NEXTCLOUD_SERVER | tr -d '[:space:]')" ]; then
  read -r -p "Nextcloud server URL [$NEXTCLOUD_SERVER_DEFAULT]: " nc_server
  printf 'NEXTCLOUD_SERVER\n%s\n' "${nc_server:-$NEXTCLOUD_SERVER_DEFAULT}" > NEXTCLOUD_SERVER
fi

fill META_API_KEY           "Meta API key (sk-...)"
fill NEXTCLOUD_USERNAME     "Nextcloud username" no
fill NEXTCLOUD_APP_PASSWORD "Nextcloud app password"
fill MAIL_ADDRESS           "Family mailbox address (you@yahoo.com)" no
fill YAHOO_APP_PASSWORD     "Yahoo app password"
fill DISCORD_BOT_TOKEN      "Discord bot token"
fill DISCORD_CHANNEL_ID     "Discord channel ID" no
fill TRICOUNT_TOKEN         "Tricount token (leave blank to skip)"

# blank Tricount is allowed for now
if [ -z "$(sed -n '2p' TRICOUNT_TOKEN | tr -d '[:space:]')" ]; then
  printf 'TRICOUNT_TOKEN\n\n' > TRICOUNT_TOKEN
fi

chmod 600 ./*
echo
echo "Done. Filled files:"
for f in *; do
  if [ -n "$(sed -n '2p' "$f" | tr -d '[:space:]')" ]; then
    echo "  $f  [filled]"
  else
    echo "  $f  [EMPTY]"
  fi
done
