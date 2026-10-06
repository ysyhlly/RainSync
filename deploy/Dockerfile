FROM rust:1.98-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/server ./apps/server
COPY apps/media-worker ./apps/media-worker
COPY apps/nas-agent ./apps/nas-agent
COPY migrations ./migrations
ARG CARGO_BUILD_JOBS=2
RUN cargo build --release --locked --workspace --jobs "$CARGO_BUILD_JOBS"

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg mesa-vulkan-drivers && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -m rainsync && mkdir -p /cache /media /state && chown rainsync:rainsync /cache /state
COPY --from=build /build/target/release/rainsync-server /build/target/release/rainsync-media-worker /build/target/release/rainsync-nas-agent /build/target/release/rainsync-compute-node /usr/local/bin/
USER rainsync
ENV RUST_LOG=info
CMD ["rainsync-server"]
