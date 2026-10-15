FROM node:20-slim

# LibreOffice (headless, Impress only, to keep the image smaller) + poppler
# for PPTX -> PDF -> PNG slide conversion, and python3-pptx to normalize
# OOXML from decks exported by AI slide tools before handing them to
# LibreOffice (some such files are rejected by LibreOffice's importer
# outright even though they are valid OOXML zips).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-impress \
    poppler-utils \
    python3 \
    python3-pip \
    fonts-dejavu \
    fonts-liberation \
    && pip3 install --no-cache-dir --break-system-packages python-pptx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .

# Run as the unprivileged "node" user (not root). It owns /app so uploads /
# runtime state can be written, and gets a writable HOME for LibreOffice.
RUN mkdir -p /app/data /app/public/images/media-library /app/public/images/custom-themes \
    && chown -R node:node /app
USER node
ENV HOME=/home/node
ENV NODE_ENV=production
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
