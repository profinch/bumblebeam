# puzzle.bumblebeam.org's API (/api/*): bitcoin/puzzle/api/server.js and pool.js (the coordinator), Node, no
# dependencies; reads a Bitcoin node's REST API (NODE_API, from the server's .env) and keeps its state in /data
# (state.json, pool.db, pool-secret unless POOL_SECRET is set, vault/: found keys sealed under POOL_VAULT_KEY). Built by CI from the repo root:
#   docker build -f deploy/docker/containers/puzzle-api/Dockerfile .
FROM node:22-alpine
COPY bitcoin/puzzle/api/server.js bitcoin/puzzle/api/pool.js bitcoin/puzzle/api/finds.js bitcoin/puzzle/api/vault.js bitcoin/puzzle/api/pages.js bitcoin/puzzle/api/limits.js bitcoin/puzzle/api/knock-notes.json /app/
# the browser engine's reference and address checks, the claim's split and checks, and the benchmark's card names,
# shared with the site
COPY bitcoin/puzzle/web/engine/secp.js bitcoin/puzzle/web/engine/tx.js bitcoin/puzzle/web/engine/claimkit.js bitcoin/puzzle/web/engine/seal.js bitcoin/puzzle/web/engine/gpuname.js bitcoin/puzzle/web/render.js /app/
USER node
WORKDIR /app
EXPOSE 8080
# node:sqlite (the pool's database) still prints an experimental warning
CMD ["node", "--no-warnings", "server.js"]
