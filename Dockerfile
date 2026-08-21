# LedgerLens — the Next.js app as a production image.
#
# This image is an optional smoke check, not the development environment and
# not what production runs. Vercel builds and serves the deployed app from
# Next.js's own output; compose.yaml runs this image beside the local
# Supabase stack so the production build gets exercised in Linux once, where
# container-shaped mistakes surface. See ADR 0006.
#
# Node 22 installs (via pnpm) and builds and serves. The local Supabase stack
# is not built here — `supabase start` already runs Postgres, Auth, PostgREST
# and the Edge Runtime in Docker, and a second definition of those would be a
# copy that drifts. compose.yaml joins this image to the network that stack
# created.

# --- deps --------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
RUN npm install --global pnpm@10
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- build -------------------------------------------------------------------
# pnpm (in deps) installs; the Next.js compiler runs under Node, the runtime
# the toolchain targets and that the runtime image serves with.
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN node node_modules/next/dist/bin/next build

# --- runtime -----------------------------------------------------------------
# next.config.ts sets output: "standalone", which traces the server's actual
# imports into one directory — the runtime image carries neither the package
# manager nor the full dependency tree.
FROM node:24-alpine AS runner
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