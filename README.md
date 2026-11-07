# 🇳🇴 Norske trailere: trailers with Norwegian subtitles for AIOMetadata

A self-hosted trailer addon for [AIOMetadata](https://github.com/cedya77/aiometadata)'s
**Trailers → "A trailer addon"** setting. For every movie and series it offers:

- **Norwegian trailers.** Dubbed trailers ("norsk tale") and trailers from the Norwegian distributor,
  taken from TMDB. When TMDB has none, the addon can also search YouTube for a Norwegian dub.
- **English trailers with Norwegian subtitles.** Non-English films also get their original-language trailer subtitled.
  The subtitles are picked best first:
  1. Norwegian subtitles a person made (`nb` / `no` / `nn`)
  2. YouTube's Norwegian translation of human-made English subtitles
  3. YouTube's Norwegian translation of the auto-generated captions (can be turned off)

Every trailer is fetched in the **best quality YouTube has**: separate video and audio streams up to
4K, not the 360p combined file.

## Why the subtitles are inside the video

AIOMetadata keeps only a trailer's `title` and its `url` (or YouTube id). Any subtitle
list an addon sends is dropped, and Stremio's YouTube player cannot be told to show
Norwegian captions. So the addon builds the video itself:

```
AIOMetadata ──/stream/movie/tt…json──▶ addon ──TMDB──▶ which trailers exist
player ──/play/<id>/<profile>/<sig>.mp4──▶ addon ──yt-dlp──▶ best video + audio + Norwegian subs
                                             └─ffmpeg──▶ MP4 with subtitles (burned in, or a default track)
```

- **Burned in** (default): the text is part of the picture, so it shows in every player
  (Stremio, Nuvio, Jellyfin, Apple TV …). The video is re-encoded with x264 (CRF 20, capped at 1080p by default).
- **Soft**: a Norwegian subtitle track marked *default*. There's no re-encode, so it's faster and keeps the
  original picture, but the player has to honour the default flag.

The first viewer gets the trailer as soon as ffmpeg starts writing, usually after 3–8 seconds.
After that the finished file is served from the disk cache with seeking (HTTP ranges).

## Quick start (Docker)

```bash
git clone https://github.com/lystad93/trailers-with-subs.git
```

```bash
cd trailers-with-subs
```

Edit `docker-compose.yml`. At minimum, set `BASE_URL` to the address AIOMetadata and your players
use to reach this server. Then start it:

```bash
docker compose up -d --build
```

Open `http://<server>:7000/configure`, choose your settings and copy the manifest URL.

In AIOMetadata's `/configure` page, set **Trailers** to **A trailer addon**, paste the URL, save,
and reinstall AIOMetadata in your client.

You need a free TMDB API key (themoviedb.org → Settings → API). Put it in `TMDB_API_KEY` on
the server, or in the settings page (it is then stored in the manifest URL).

### With Viren070's docker-compose-template

Ready-made files are in [`deploy/docker-compose-template`](deploy/docker-compose-template). They use
Traefik and Authelia, and build from this repository, which also works on ARM (Oracle Ampere).
The steps are in that folder's README.

### Without Docker

You need Node.js 20+, ffmpeg (with libass), ffprobe and yt-dlp (`pip install "yt-dlp[default]"`).

```bash
TMDB_API_KEY=… BASE_URL=http://192.168.1.10:7000 npm start
```

## Settings (per user, in the manifest URL)

| Setting | Default | |
|---|---|---|
| Norwegian trailers | on | Dubbed / Norwegian release trailers |
| English trailers with Norwegian subtitles | on | |
| Max per group | 2 / 2 | |
| Show first | Norwegian | Which group comes first. The first trailer is what the *Trailer* button plays |
| Find Norwegian dubs on YouTube | animation & family | `off`, `family` or `all`. Searches are rate-limited and cached for 7 days |
| How subtitles are shown | burned in | `burn` or `soft` |
| Allow YouTube's translated / auto subtitles | on | Off = only Norwegian subtitles made by a person |
| Max resolution | 1080 | 480 to 2160 |
| Video codec | H.264 | `h264` plays everywhere (YouTube has it up to 1080p); `any` = best VP9/AV1 up to 4K |
| Also list the plain YouTube video | off | Plays in Stremio's YouTube player, without the added subtitles |

## Server environment

| Variable | Default | |
|---|---|---|
| `BASE_URL` | from the request | Public URL used in play links |
| `PORT` | `7000` | |
| `TMDB_API_KEY` | – | v3 key or v4 read token |
| `CACHE_DIR` | `/data/cache` | Finished trailers |
| `CACHE_MAX_GB` | `10` | Least recently watched files are removed first |
| `MAX_JOBS` | `2` | Trailers prepared at the same time |
| `BURN_MAX_HEIGHT` | `1080` | Highest resolution for burned-in subtitles (re-encoding 4K is slow) |
| `BURN_PRESET` / `BURN_CRF` | `veryfast` / `20` | x264 settings for burned-in subtitles |
| `SUB_FONT` / `SUB_FONT_SIZE` | `DejaVu Sans` / `18` | Burned-in subtitle style (the size is relative to a 288-line canvas) |
| `YTDLP_COOKIES` | – | Path to a cookies.txt, if YouTube asks you to sign in |
| `YTDLP_ARGS` | – | Extra yt-dlp arguments, e.g. `--extractor-args youtube:player_client=…` |
| `YTDLP_AUTO_UPDATE` | `1` | Update yt-dlp each time the container starts |
| `MAX_DURATION` | `600` | Refuse videos longer than this many seconds |
| `SEARCH_BUDGET_MS` | `3500` | How long a trailer lookup waits for the YouTube search (AIOMetadata waits 6 s) |
| `SECRET` | random, kept in the cache dir | Signs play links so the server can't be used to fetch any YouTube video |

## Troubleshooting

- **"Sign in to confirm you're not a bot"** in the logs. YouTube blocks many datacenter and VPN
  IPs. Run the addon on a home connection, or export YouTube cookies from a browser to
  `./data/cookies.txt` and set `YTDLP_COOKIES=/data/cookies.txt`.
- **No subtitles on a trailer.** The video has no captions at all (music-only trailers), or you have turned off
  auto-generated subtitles. The trailer still plays. The logs say which track was used.
- **The first play doesn't start on Apple devices.** AVPlayer insists on byte ranges, which a trailer still being made
  can't offer. Opening it again a few seconds later plays the cached file.
- **Changes don't show up.** AIOMetadata caches trailer lists for 24 hours (`TRAILER_ADDON_TTL`).

## Development

```bash
npm test
```

The tests cover subtitle clean-up, format and subtitle choice, the TMDB logic, the
HTTP API in the shape AIOMetadata reads, and the whole ffmpeg pipeline: streaming while building,
burned-in and soft subtitles, range requests, and failing on a lost audio track. They use
synthetic media instead of YouTube.
