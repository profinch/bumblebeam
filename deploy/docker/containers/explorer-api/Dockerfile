# BumbleBeam API (/v1) and MCP server (/mcp): api/server.js from the public repository at a given
# ref. Node, no dependencies; reads explorer-node and the pool over the compose network.
FROM alpine:3.22 AS src
ARG BUMBLEBEAM_REPO=https://github.com/profinch/bumblebeam
ARG BUMBLEBEAM_REF=main
RUN apk add --no-cache git
RUN git clone "$BUMBLEBEAM_REPO" /src && git -C /src checkout --detach "$BUMBLEBEAM_REF"

FROM node:22-alpine
COPY --from=src /src/api/server.js /app/server.js
USER node
WORKDIR /app
EXPOSE 8080
CMD ["node", "server.js"]
