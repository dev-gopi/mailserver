# ---------- Build Stage ----------
FROM node:22 AS builder

WORKDIR /app

# Copy only files needed to install dependencies
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the source code
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to JavaScript
RUN npx tsc

# ---------- Final Stage ----------
FROM node:22-alpine AS production

# Set working directory
WORKDIR /app

# Manual and scheduled backups must use real PostgreSQL dump files.
RUN apk add --no-cache postgresql-client tar

# Copy only the compiled code and necessary files from the builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist

# Install only production dependencies
RUN npm ci --omit=dev

# Expose port (make sure it matches your Express app)
EXPOSE 8080

# Start the app
CMD ["node", "dist/index.js"]
