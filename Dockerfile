# Build stage: compile Go backend and build frontend
FROM node:22-slim AS frontend-builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM golang:1.27-bookworm AS backend-builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o gpx_victoriametricsexplorer .

# Final stage: assemble the plugin
FROM alpine:3.21
RUN apk add --no-cache ca-certificates
WORKDIR /plugin

# Copy built frontend
COPY --from=frontend-builder /app/dist/ /plugin/

# Copy built backend binary
COPY --from=backend-builder /app/gpx_victoriametricsexplorer /plugin/gpx_victoriametricsexplorer_amd64

# Create go_plugin_build_manifest.json
RUN echo '{"exec":"gpx_victoriametricsexplorer_amd64","os":"linux","arch":"amd64"}' > /plugin/go_plugin_build_manifest.json

# Verify structure
RUN ls -la /plugin/
