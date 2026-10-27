#!/bin/bash
# Prerenders the indexable pages of pool.bumblebeam.org and explorer.bumblebeam.org.
#
# Every INTERVAL seconds each page is opened in headless Chromium through the host nginx
# (127.0.0.1:443, the real certificate, no Cloudflare; ?prerender=1 makes nginx serve the bare app,
# not the previous snapshot), app.js renders it with live data, and the
# DOM is saved as /snap/<site>/<page>.html. A page counts only when app.js marked <html
# data-ready="1"> (its own data arrived); otherwise the previous snapshot stays, and one older than
# MAX_AGE minutes is removed, so the site falls back to the bare app instead of old numbers.
# Explorer asset pages are rendered once a day. sitemap.xml lists the snapshots there are.
set -u

SNAP=${SNAP:-/snap}
INTERVAL=${INTERVAL:-600}
ASSET_INTERVAL=${ASSET_INTERVAL:-86400}
MAX_AGE=${MAX_AGE:-360}
POOL=https://pool.bumblebeam.org
EXPLORER=https://explorer.bumblebeam.org
POOL_PAGES=(/ /network /blocks /connect /api)
EXPLORER_PAGES=(/ /assets /contracts /dex /names /api)

PROFILE=$(mktemp -d)
TMP=$(mktemp -d)
trap 'rm -rf "$PROFILE" "$TMP"' EXIT
mkdir -p "$SNAP/pool" "$SNAP/explorer/asset"

log() { echo "prerender: $*"; }

# render <url> <file>: 0 when <file> was replaced with a fresh snapshot
render() {
  local url=$1 out=$2 dom="$TMP/dom.html" now
  # --virtual-time-budget lets app.js finish its requests before the DOM is taken
  timeout 90 chromium-browser --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --no-first-run --no-default-browser-check --disable-extensions --disable-background-networking \
    --hide-scrollbars --mute-audio --window-size=1280,2000 --user-data-dir="$PROFILE" \
    --host-resolver-rules="MAP pool.bumblebeam.org 127.0.0.1,MAP explorer.bumblebeam.org 127.0.0.1" \
    --virtual-time-budget=15000 --dump-dom "$url?prerender=1" >"$dom" 2>/dev/null
  if ! grep -q '<html[^>]* data-ready="1"' "$dom" || [ "$(wc -c <"$dom")" -lt 2000 ]; then
    log "skip $url (not rendered)"
    return 1
  fi
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$(dirname "$out")"
  {
    # Chromium's DOM dump carries the doctype; without one the page would render in quirks mode
    head -c 200 "$dom" | grep -qi '<!doctype' || printf '<!doctype html>\n'
    sed -e 's| data-ready="1"||' -e "s|<main id=\"view\"|<main id=\"view\" data-snap=\"$now\"|" "$dom"
  } >"$out.tmp" && mv "$out.tmp" "$out"
}

# snapshot file of a page: / is index.html, /asset/1 is asset/1.html
file_of() { local p=${2#/}; echo "$SNAP/$1/${p:-index}.html"; }

sitemap() {
  local site=$1 base=$2 f path
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    while IFS= read -r f; do
      path=${f#"$SNAP/$site/"}
      path=${path%.html}
      [ "$path" = index ] && path=
      echo "  <url><loc>$base/$path</loc><lastmod>$(date -u -r "$f" +%Y-%m-%dT%H:%M:%SZ)</lastmod></url>"
    done < <(find "$SNAP/$site" -name '*.html' | sort)
    echo '</urlset>'
  } >"$SNAP/$site/sitemap.xml.tmp" && mv "$SNAP/$site/sitemap.xml.tmp" "$SNAP/$site/sitemap.xml"
}

last_assets=0
while :; do
  ok=0 all=0
  for p in "${POOL_PAGES[@]}"; do all=$((all + 1)); render "$POOL$p" "$(file_of pool "$p")" && ok=$((ok + 1)); done
  for p in "${EXPLORER_PAGES[@]}"; do all=$((all + 1)); render "$EXPLORER$p" "$(file_of explorer "$p")" && ok=$((ok + 1)); done

  # asset pages: the named ones, once a day
  if [ $(( $(date +%s) - last_assets )) -ge "$ASSET_INTERVAL" ]; then
    ids=$(curl -sf --max-time 30 --resolve explorer.bumblebeam.org:443:127.0.0.1 "$EXPLORER/v1/assets" \
      | jq -r '.assets[] | select((.name // "") != "") | .asset_id')
    if [ -n "$ids" ]; then
      n=0
      for id in $ids; do render "$EXPLORER/asset/$id" "$SNAP/explorer/asset/$id.html" && n=$((n + 1)); done
      log "assets: $n of $(wc -w <<<"$ids") rendered"
      last_assets=$(date +%s)
      # assets that lost their name, or stopped rendering for days
      find "$SNAP/explorer/asset" -name '*.html' -mmin +$((ASSET_INTERVAL / 60 * 3)) -delete
    fi
  fi

  # pages that have not rendered for MAX_AGE minutes: the bare app rather than old numbers
  find "$SNAP/pool" "$SNAP/explorer" -maxdepth 1 -name '*.html' -mmin +"$MAX_AGE" -print -delete | sed 's/^/prerender: stale, removed /'
  sitemap pool "$POOL"
  sitemap explorer "$EXPLORER"
  log "pages: $ok of $all rendered"
  sleep "$INTERVAL"
done
