# syntax=docker/dockerfile:1.6

# 1. Build the web bundle with Expo.
FROM node:20-alpine AS web
WORKDIR /web
COPY mobile/package.json mobile/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY mobile/ .
RUN npx expo export --platform web --output-dir dist

# 2. Build the Go server.
FROM golang:1.23-alpine AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/squares .

# 3. Final runtime image.
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 1000 app \
    && mkdir -p /data \
    && chown app:app /data
COPY --from=server /out/squares /app/squares
COPY --from=web /web/dist /app/public
USER app
WORKDIR /data
ENV DB_PATH=/data/squares.db PORT=8080 STATIC_DIR=/app/public
EXPOSE 8080
CMD ["/app/squares"]
