# puzzle.bumblebeam.org's API (/api/*): bitcoin/puzzle/api/server.js, Node, no dependencies; reads a Bitcoin
# node's REST API (NODE_API, from the server's .env) and keeps its state in /data. Built by CI from the repo root:
#   docker build -f deploy/docker/containers/puzzle-api/Dockerfile .
FROM node:22-alpine
COPY bitcoin/puzzle/api/server.js /app/server.js
USER node
WORKDIR /app
EXPOSE 8080
CMD ["node", "server.js"]
