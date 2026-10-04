FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
WORKDIR /opt/target
COPY server/dist/ ./server/dist/
COPY server/migrations/ ./server/migrations/
COPY server/fixtures/demo-fixture.json server/fixtures/demo-media.mp4 ./server/fixtures/
COPY scripts/vigolium-rewind-target.mjs ./scripts/
USER 1000:1000
ENTRYPOINT ["node", "scripts/vigolium-rewind-target.mjs", "--serve"]
