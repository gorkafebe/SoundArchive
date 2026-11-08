# syntax=docker/dockerfile:1
#
# Image for the "caddy" service: the web server WITH the built web app inside.
#
# Build context = the repository root (compose.yaml sets it), because the
# image needs both web/ and infra/caddy/Caddyfile. Only those reach the
# build: see web/Dockerfile.dockerignore.
#
# Two stages:
#   build   Node installs the exact dependencies (package-lock.json) and
#           Vite builds the app into /web/dist. Thrown away afterwards.
#   server  the official Caddy image plus dist/ and the Caddyfile. No Node,
#           no node_modules, no source code: only static files.
#
# Why bake the files into the image instead of mounting folders? `make
# prod-up` then rebuilds the web app and re-creates Caddy whenever the app or
# the Caddyfile changes (before, a Caddyfile change needed a manual restart),
# and each image is one exact, reproducible version of the site.

# Node's current LTS line (26), pinned to an exact release. Same value as
# NODE_IMAGE in the Makefile.
ARG NODE_IMAGE=node:26.13.0-alpine3.24
ARG CADDY_IMAGE=caddy:2.11.7-alpine

# --- build ----------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /web
# Dependencies first: this layer is cached until package*.json change.
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- server (last stage = what `docker build` produces) ---------------------------
FROM ${CADDY_IMAGE} AS server
COPY infra/caddy/Caddyfile infra/caddy/Caddyfile.tailnet /etc/caddy/
COPY --from=build /web/dist /srv/web
