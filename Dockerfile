FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install system deps required by Puppeteer/Chrome
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libgbm-dev \
    libasound2 \
    libatk1.0-0 \
    libnss3 \
    libcups2 \
    libxss1 \
    libxtst6 \
    libgtk-3-0 \
    lsb-release \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Copy only package files first and install deps
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Create writable directory for user data (if using USER_DATA_DIR volume)
RUN mkdir -p /data

ENV NODE_ENV=production
WORKDIR /usr/src/app

# If you plan to run headless chrome inside the container, set REFRESH_HEADLESS=true
# and mount a volume to /data to persist user profile: -v sd_data:/usr/src/app/data

CMD ["node", "refresh_cookies.js"]
