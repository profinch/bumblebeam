# BumbleBeam API (/v1) and MCP server (/mcp): beam/explorer/api/server.js, Node, no dependencies; reads
# explorer-node and the pool over the compose network. Built by CI from the repository root:
#   docker build -f deploy/docker/containers/explorer-api/Dockerfile .
FROM node:22-alpine
COPY beam/explorer/api/server.js /app/server.js
USER node
WORKDIR /app
EXPOSE 8080
CMD ["node", "server.js"]
