FROM debian:bookworm-slim

RUN printf 'bring-lineage-base\n' > /bring-lineage-base

LABEL devcontainer.metadata="[]"
