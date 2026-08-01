# Single image serving both the API and the static mobile web app — see
# server/src/app.js, which mounts express.static(web/) itself. No native
# build tools are needed: every server dependency is pure JS.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --omit=dev --workspace @shirt-designs/server

COPY server server
COPY web web

# Where uploads, exports and the JSON database live. Mount a persistent
# volume/disk here in production — without one, everything is lost on
# restart, which defeats the point of a design library.
ENV SHIRT_DATA_DIR=/data
ENV PORT=4000
EXPOSE 4000

CMD ["node", "server/src/index.js"]
