# LedgerLens — the Next.js app, containerised.
#
# Two targets matter to compose.yaml: `dev` (hot reload, IDE-debuggable,
# source bind-mounted) and `runner` (the production build, the deployed
# artifact). `build` is an intermediate stage for `runner`, not used on its
# own.
#
# The local Supabase stack is not built here: `supabase start` already runs
# Postgres, Auth, PostgREST and the Edge Runtime in Docker, and a second
# definition of those would be a copy that drifts. compose.yaml joins this
# image to the network that stack already created. See ADR 0006.

# --- deps --------------------------------------------------------------------
FROM oven/bun:1.3.14-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- dev ---------------------------------------------------------------------
# The inner dev loop, containerised: source is bind-mounted by compose.yaml's
# `dev` service, not copied here, so this stage builds once and every edit is
# live without a rebuild. Runs on `deps` — the full toolchain, not the traced
# `runner` stage below — since `bun run dev`, `bun test`, `tsc`, etc. all need
# it. CMD here is `bun run dev` (package.json's script, which binds its
# debug port to `127.0.0.1:6499`, not the `9230` in `EXPOSE` below — that
# number describes compose.yaml's `command:` override, the actual way this
# stage runs; a bare `docker run` of this image, without compose, gets
# `package.json`'s own port instead) — the right default for `docker run`
# without compose; compose.yaml overrides `command:` with an explicit
# `0.0.0.0:9230` bind for the `dev` service specifically, since that's the
# one meant to be attached to from the host. See ADR 0006.
#
# Real Node is installed alongside Bun for one reason: `next build` under
# Bun segfaults on Alpine (see the `build` stage below — the same crash is
# why that stage runs on `node:22-alpine`, not `deps`). `task build` in this
# `dev` container needs the same escape hatch; the fallback `node` Bun ships
# on its own `PATH` is Bun pretending to be Node, not a real fix.
#
# Not root: this container reads .env.local (the service-role key), publishes
# an inspector, and bind-mounts the whole repo read-write — the same reason
# `runner` below refuses root, applied here too. `oven/bun` already ships a
# `bun` user (uid 1000); `chown` before switching so the image's own
# `node_modules` (written as root by `bun install` in `deps`) is writable
# once compose's named volume copies it in.
FROM deps AS dev
# `.next` doesn't exist in this stage — nothing has built here yet — so it's
# created explicitly. A directory with no image content still gets a fresh
# *root*-owned volume when compose's named volume first mounts over it
# (there's nothing to inherit ownership from); `mkdir` before `chown` is
# what makes that volume come up owned by `bun` instead. `node_modules`
# doesn't need this — `bun install` in `deps` already gave it real content.
RUN apk add --no-cache nodejs \
 && mkdir -p /app/.next \
 && chown -R bun:bun /app
USER bun
EXPOSE 3000 9230
CMD ["bun", "run", "dev"]

# --- build -------------------------------------------------------------------
# Bun installs; Node builds. The Next.js compiler runs under Node here for the
# same reason the Playwright CLI does on the host: it is the runtime that
# toolchain targets, and delegating to it removes a class of failures that
# have nothing to do with this code.
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN node node_modules/next/dist/bin/next build

# --- runtime -----------------------------------------------------------------
# next.config.ts sets output: "standalone", which traces the server's actual
# imports into one directory — the runtime image carries neither the package
# manager nor the full dependency tree.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never root: the container reaches the database with the service-role key,
# so a process escape should not also be a root shell.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# A route that needs no database, so an unhealthy report means the app is
# down rather than the stack behind it.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/mock-provider/summary').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
