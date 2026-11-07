# Using Norske trailere with docker-compose-template

For stacks based on [Viren070/docker-compose-template](https://github.com/Viren070/docker-compose-template)
(Traefik + Authelia, files in `/opt/docker`).

1. Copy `apps/trailers-with-subs/` (both `compose.yaml` and `.env`) to `/opt/docker/apps/trailers-with-subs/`.
2. In `/opt/docker/compose.yaml`, add this line to `include:` (alphabetical, before `tuliprox`):
   ```yaml
     - apps/trailers-with-subs/compose.yaml
   ```
3. In `/opt/docker/.env`, add the hostname next to the others, and add `trailers-with-subs` to `COMPOSE_PROFILES`:
   ```bash
   TRAILERS_WITH_SUBS_HOSTNAME=trailers.${DOMAIN}
   ```
4. In `/opt/docker/apps/authelia/compose.yaml`, add the hostname to `TEMPLATE_STREMIO_ADDON_HOSTNAMES`:
   ```yaml
           ${TRAILERS_WITH_SUBS_HOSTNAME},
   ```
   Authelia then requires login for `/configure` but lets AIOMetadata and your players reach
   `/manifest.json`, `/stream/…` and `/play/…`.
5. Put your TMDB key in `apps/trailers-with-subs/.env` (or enter it on the settings page).
6. Start it, and restart Authelia so it picks up the new hostname:
   ```bash
   docker compose --profile trailers-with-subs up -d --build
   ```
   ```bash
   docker compose --profile authelia up -d --force-recreate authelia
   ```
7. Open `https://trailers.<your domain>/configure`, copy the manifest URL and paste it into
   AIOMetadata → Trailers → *A trailer addon*.

To update to a newer version of the addon later:

```bash
docker compose --profile trailers-with-subs build --pull --no-cache && docker compose --profile trailers-with-subs up -d
```

## YouTube on a VPS

YouTube often answers datacenter IPs (Oracle included) with *"Sign in to confirm you're not a bot"*.
Check with `docker logs trailers-with-subs` after playing a trailer. If you see it:

- **WARP:** add the `warp` profile and set `YTDLP_ARGS=--proxy http://warp:1080` in the app's `.env`.
  yt-dlp then fetches both the video info and the video itself through Cloudflare, so the
  IP-locked YouTube links stay valid.
- **Cookies:** export cookies (Netscape format) from a browser signed in to a throwaway Google
  account to `/opt/docker/data/trailers-with-subs/cookies.txt`, and set `YTDLP_COOKIES=/data/cookies.txt`.

## Tip: let AIOMetadata talk to the addon directly

AIOMetadata and the addon share the Docker network, so in AIOMetadata you can use
`http://trailers-with-subs:7000/<settings>/manifest.json` instead of the public URL. That skips
Traefik for the lookups. The play links still use `BASE_URL`, so your players get the public address.
