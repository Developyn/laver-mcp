FROM node:24-alpine

WORKDIR /app

# Dependencies first, so a change to server.js does not reinstall them.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js README.md LICENSE ./

# The server talks JSON-RPC over stdin/stdout. It starts and answers
# introspection without credentials; LAVER_API_KEY is only needed once a
# tool actually calls the Laver API.
#   docker run -i --rm -e LAVER_API_KEY=... laver-mcp
ENTRYPOINT ["node", "server.js"]
