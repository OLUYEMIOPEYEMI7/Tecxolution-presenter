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
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "server.js"]
