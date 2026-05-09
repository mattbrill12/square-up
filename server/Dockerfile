# syntax=docker/dockerfile:1.6
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/squares .

FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 1000 app \
    && mkdir -p /data \
    && chown app:app /data
COPY --from=build /out/squares /app/squares
USER app
WORKDIR /data
ENV DB_PATH=/data/squares.db PORT=8080
EXPOSE 8080
CMD ["/app/squares"]
