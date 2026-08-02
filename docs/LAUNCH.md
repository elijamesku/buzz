# Launching your fork — hosted relay + a downloadable app

Goal: someone downloads your app, opens it, and they're in — **no Docker, no
terminal, no setup.** That takes two pieces of infrastructure that only you can
own (a server and an Apple Developer account); everything else already exists in
this repo. This is the exact runbook.

There are two audiences, and the whole point is to separate them:

| Audience | What they do | What they need |
|----------|--------------|----------------|
| **End users** | Download the app, join your community | Nothing. Zero setup. |
| **You (operator)** | Run one relay, publish one signed app | A VPS + domain, an Apple Developer account |

---

## Part 1 — Stand up a hosted relay (~30 min, ~$6/mo)

The relay + Postgres + Redis + automatic HTTPS ship as a turnkey compose bundle
(`deploy/compose`). You run it once on any small server.

**You provide:** a cheap VPS (Hetzner/DigitalOcean/Fly, 2 GB RAM is plenty) and a
domain you can point at it.

1. **DNS:** add an `A` record for `relay.yourdomain.com` → your VPS IP.
2. **On the VPS:** install Docker, then:
   ```bash
   git clone https://github.com/elijamesku/buzz.git && cd buzz/deploy/compose
   cp .env.example .env
   $EDITOR .env          # set the domain + fill every CHANGE_ME (secrets, RELAY_OWNER_PUBKEY)
   BUZZ_AUTO_MIGRATE=true BUZZ_COMPOSE_TLS=true ./run.sh start
   ```
   `BUZZ_COMPOSE_TLS=true` makes Caddy fetch a free Let's Encrypt cert
   automatically. `BUZZ_AUTO_MIGRATE=true` sets up the database on first boot.
3. **Verify:**
   ```bash
   curl -fsS https://relay.yourdomain.com/_liveness && echo OK
   ```

You now have a public relay at **`wss://relay.yourdomain.com`**. Keep the secrets
in `.env` stable across restarts (see `deploy/compose/README.md` → Production
notes, and `./run.sh backup-hint`).

> Pin `BUZZ_IMAGE` to a specific `ghcr.io/elijamesku/buzz:<tag>` you publish
> (via `just release-relay`, or the `docker.yml` workflow on your fork) rather
> than tracking `:main`.

---

## Part 2 — Build a signed app that auto-connects to your relay

The desktop build can **bake your relay URL in**, so a downloaded app connects
with zero configuration. Signing + notarization is what removes the macOS
"unidentified developer" wall.

**You provide:** an [Apple Developer account](https://developer.apple.com/programs/)
($99/yr) → a **Developer ID Application** certificate + an app-specific password
for notarization.

**Bake the relay in** (build-time env — already supported by `build.rs`):
```bash
export BUZZ_RELAY_URL="wss://relay.yourdomain.com"
export BUZZ_RELAY_HTTP="https://relay.yourdomain.com"
export BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1
export BUZZ_BUILD_GITHUB_CLIENT_ID="Ov23litXNJlAtam2CEpB"   # your GitHub OAuth app
```

**Sign + notarize** (standard Tauri signing — set these before building):
```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
# then:
just release-desktop 0.5.3      # produces a signed, notarized .dmg
```

Output is a `.dmg` under `desktop/src-tauri/target/release/bundle/`. Because it's
signed + notarized, users double-click and it just opens.

---

## Part 3 — Distribute + auto-update

1. Upload the `.dmg` (and the generated updater manifest) to a **GitHub Release**
   on your fork. That's your download link.
2. The app bundles `tauri-plugin-updater`. Bake the update feed so installed apps
   update themselves:
   ```bash
   export BUZZ_UPDATER_ENDPOINT="https://github.com/elijamesku/buzz/releases/latest/download/latest.json"
   export BUZZ_UPDATER_PUBLIC_KEY="<your tauri updater public key>"
   ```
   Generate the keypair once with `pnpm tauri signer generate`; keep the private
   key secret (a CI secret), bake the public key.

Now: **you send someone a download link → they install → the app auto-connects to
your relay → they're in.** No Docker, no commands.

---

## What's already done vs. what's on you

| Piece | Status |
|-------|--------|
| Turnkey relay deploy (compose + HTTPS) | ✅ in `deploy/compose` |
| Relay Docker image build | ✅ `just release-relay` / `.github/workflows/docker.yml` |
| Bake default relay into the app | ✅ `build.rs` (`BUZZ_RELAY_URL`, `…AUTO_CONNECT_DEFAULT_RELAY`) |
| Signed/notarized desktop build | ✅ `just release-desktop` (needs *your* Apple cert) |
| In-app self-host helper (buttons) | ✅ Settings → Local setup |
| **A VPS + domain** | ⬜ you |
| **Apple Developer account + cert** | ⬜ you |
| **CI workflow for signed downloads** | ⬜ optional — the repo's `signed-macos-canary.yml` uses Block's internal signer; a fork one using standard Apple secrets can be added |

> The repo's `signed-macos-canary.yml` signs via Block's internal service
> (`OSX_CODESIGN_ROLE` / `CODESIGN_S3_BUCKET`), which your fork can't use. Sign
> locally with `just release-desktop` (above), or add a fork CI workflow that
> uses standard Apple certificate secrets — ask and it can be scaffolded.
