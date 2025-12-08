FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install system deps required by Puppeteer/Chrome
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get dist-upgrade -y \
 && apt-get install -y --no-install-recommends \
     ca-certificates \
     fonts-liberation \
     libatk1.0-0 \
     libatk-bridge2.0-0 \
     libx11-xcb1 \
     libxcomposite1 \
     libxdamage1 \
     libxrandr2 \
     libgbm1 \
     libasound2 \
     libnss3 \
     libcups2 \
     libxss1 \
     libxtst6 \
     libgtk-3-0 \
     xvfb \
    xauth \
     wget \
     dumb-init \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Allow controlling whether Puppeteer downloads its Chromium at build-time.
# Default is 1 (skip download) which is useful when building for Raspberry Pi
# where we'll install a system Chromium. Override with --build-arg PUPPETEER_SKIP_DOWNLOAD=0
ARG PUPPETEER_SKIP_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=${PUPPETEER_SKIP_DOWNLOAD}

# Copy only package files first and install deps
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Create writable directory for user data (if using USER_DATA_DIR volume)
# Ensure the path used by the app exists so mounts targeting `/usr/src/app/data` are valid
RUN mkdir -p /usr/src/app/data

# Install system Chromium so Puppeteer can use the system binary on ARM (Raspberry Pi).
# Try common package names and don't fail the build if a name isn't available.
RUN apt-get update \
 && (apt-get install -y --no-install-recommends chromium || true) \
 && (apt-get install -y --no-install-recommends chromium-browser || true) \
 && (apt-get install -y --no-install-recommends chromium-chromedriver || true)

ENV NODE_ENV=production
WORKDIR /usr/src/app

# If you plan to run headless chrome inside the container, set REFRESH_HEADLESS=true
# and mount a volume to /usr/src/app/data to persist user profile: -v sd_data:/usr/src/app/data

# Default CHROME_PATH points to common Debian/Ubuntu locations. The entrypoint will detect actual path.
ENV CHROME_PATH=/usr/bin/chromium-browser

# Copy entrypoint that removes Chromium profile locks before starting
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Ensure entrypoint runs first to clean any leftover Chromium locks
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "refresh_cookies.js"]
