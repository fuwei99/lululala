# Use a lightweight Node.js LTS image
FROM node:20-alpine

# Set environment to production
ENV NODE_ENV=production

# Set working directory inside the container
WORKDIR /app

# Copy package configuration files
COPY package.json package-lock.json* ./

# Install production dependencies (if any are added in the future)
RUN npm install --omit=dev

# Copy models metadata and the application source code
COPY models.json models.jsonc ./
COPY src/ ./src/

# Expose the default port configured in config.js (LMARENA_PORT defaults to 8787)
EXPOSE 8787

# Define the entry command to start the application
CMD ["node", "src/server.js"]
