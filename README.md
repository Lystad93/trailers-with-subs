# 🇳🇴 Norske trailere: trailers with Norwegian subtitles for AIOMetadata

A self-hosted trailer addon for [AIOMetadata](https://github.com/cedya77/aiometadata)'s
**Trailers → "A trailer addon"** setting. For every movie and series it offers:

- **Norwegian cinema trailers.** The trailers Norwegian distributors and cinemas publish on YouTube
  (SF Studios, Nordisk Film, UIP, Disney, Warner, Norsk Filmdistribusjon, Filmweb and others). They
  already have Norwegian text in the picture, or Norwegian voices ("norsk tale"), so they are
  copied as they are and start fastest. Trailers TMDB lists as Norwegian are added, and when there
  is nothing Norwegian at all the addon can search YouTube for a dub.
- **English trailers with Norwegian subtitles.** Non-English films also get their original-language trailer subtitled.
  The subtitles are picked best first:
  1. Norwegian subtitles a person made (`nb` / `no` / `nn`)
  2. Human-made English subtitles, translated to Norwegian. The addon uses Gemini or LibreTranslate
     when one is set up (recommended, see `GEMINI_API_KEY`), otherwise YouTube's own translation
  3. The auto-generated captions, translated the same way (can be turned off)

Every trailer is fetched in the **best quality YouTube has**: separate video and audio streams up to
4K, not the 360p combined file.

## Why the subtitles are inside the video

AIOMetadata keeps only a trailer's `title` and its `url` (or YouTube id). Any subtitle
list an addon sends is dropped, and a player's YouTube playback cannot be told to show
Norwegian captions. So the addon serves the video itself:

```
AIOMetadata ──/stream/movie/tt…json──▶ addon ──TMDB──▶ which trailers exist
player ──/play/<id>/<profile>/<sig>.mkv──▶ addon ──yt-dlp──▶ best video + audio   ┐ at the same time
                                             ├─ Norwegian subtitles (translated)  ┘
                                             └─ffmpeg──▶ MKV, copied without re-encoding
```

- **Subtitle track** (default): YouTube's video and audio are copied as they are into an MKV, next to a
  Norwegian subtitle track marked *default* with the language `nor`. Nothing is re-encoded, so the
  server does very little work and the picture is YouTube's own. The player has to show the track:
  the AIOStreams app picks it by your subtitle language, and Stremio and most players follow the default flag.
- **Burned in**: the text becomes part of the picture, for players that ignore subtitle tracks. The
  whole video is re-encoded with x264 (CRF 20, capped at 1080p by default), which is slow on a small server.

The download starts as soon as YouTube has answered, while the subtitles are fetched and
translated. A copy is normally complete a few seconds later and is served as a finished, seekable
file; a slow one is streamed while it is written. Subtitles get `SUB_WAIT_MS` (10 seconds) to
arrive. If they are later than that, the trailer starts without them, they are finished in the
background, and the next play has them. Finished trailers are served from the disk cache.

## Where the Norwegian trailers come from

The addon keeps a list of the videos on the Norwegian distributors' YouTube channels in
`channels.json` in the cache folder. It fetches each channel's whole list the first time and once
a week, and only the newest videos every 12 hours in between. A film is matched against that
list by its Norwegian, English and original title, without asking YouTube anything: the video
title has to be the film's name plus trailer wording ("Frost 2 | Offisiell trailer | På kino 25.
desember"), and the video has to be from around the film's release, which keeps remakes apart.
Ten-second spots, featurettes and clips are left out. `/health` shows how many videos are listed.

Add channels of your own with `CHANNELS_EXTRA` (channel ids or @handles, comma separated).

## Which apps this works in

- **AIOStreams app (Android TV, desktop, web)**: plays the addon's links with its own player and
  lists them first. Set *Norwegian* as a subtitle language and the subtitle mode to *Smart* or
  *Always* in the app's playback settings.
- **Stremio**: plays the links; the subtitle track is on by default.
- **Nuvio**: does not work. Nuvio only reads YouTube ids from a title's trailers and plays those
  with its own YouTube player, so it never opens this addon's links. Turning on *Also list the plain
  YouTube video* at least gives Nuvio the Norwegian dubbed trailers the addon found.

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
| Norwegian trailers | on | Norwegian cinema trailers and dubbed trailers |
| Use Norwegian distributors' and cinemas' YouTube channels | on | Off = only the Norwegian trailers TMDB lists |
| English trailers with Norwegian subtitles | on | |
| Max per group | 2 / 2 | |
| Show first | Norwegian | Which group comes first. The first trailer is what the *Trailer* button plays |
| Find Norwegian dubs on YouTube | animation & family | `off`, `family` or `all`. Only used when no Norwegian trailer is known. Searches are rate-limited and cached for 7 days |
| How subtitles are shown | subtitle track | `soft` (a subtitle track, no re-encoding) or `burn` (burned into the picture, slow) |
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
| `CHANNELS_EXTRA` | – | More YouTube channels with Norwegian trailers: channel ids (`UC…`) or `@handles`, comma separated |
| `CHANNEL_REFRESH_HOURS` | `12` | How often the channels' newest videos are fetched |
| `CHANNEL_DEPTH` / `CHANNEL_RECENT` | `1500` / `60` | Videos per channel on a full fetch and on a refresh |
| `SUB_WAIT_MS` | `10000` | How long a trailer waits for its subtitles before starting without them (twice as long for burn-in) |
| `FINISH_WAIT_MS` | `3000` | How long the first viewer waits for a copy that is about to finish, to get a seekable file |
| `BURN_MAX_HEIGHT` | `1080` | Highest resolution for burned-in subtitles (re-encoding 4K is slow) |
| `BURN_PRESET` / `BURN_CRF` | `veryfast` / `20` | x264 settings for burned-in subtitles |
| `SUB_FONT` / `SUB_FONT_SIZE` | `DejaVu Sans` / `18` | Burned-in subtitle style (the size is relative to a 288-line canvas) |
| `GEMINI_API_KEY` | – | Translate subtitles with Google Gemini (key from aistudio.google.com; the same key AIOMetadata uses works). Strongly recommended on a VPS: YouTube rate limits its own translations for servers |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model for translation |
| `LIBRETRANSLATE_URL` / `LIBRETRANSLATE_API_KEY` | – | Or translate with a LibreTranslate server, e.g. `http://libretranslate:5000` |
| `YTDLP_COOKIES` | – | Path to a cookies.txt, if YouTube asks you to sign in |
| `YTDLP_ARGS` | – | Extra yt-dlp arguments, e.g. `--extractor-args youtube:player_client=…` |
| `YTDLP_AUTO_UPDATE` | `1` | Update yt-dlp each time the container starts |
| `MAX_DURATION` | `600` | Refuse videos longer than this many seconds |
| `SEARCH_BUDGET_MS` | `3500` | How long a trailer lookup waits for the YouTube search (AIOMetadata waits 6 s) |
| `SEARCH_QUEUE_MAX` | `5` | YouTube searches allowed to wait in line; more are skipped and retried later |
| `TMDB_RPS` / `TMDB_CONCURRENCY` | `20` / `6` | TMDB request rate and parallelism. TMDB allows ~50/s per IP, shared with AIOMetadata |
| `SECRET` | random, kept in the cache dir | Signs play links so the server can't be used to fetch any YouTube video |

## Troubleshooting

- **"Sign in to confirm you're not a bot"** in the logs. YouTube blocks many datacenter and VPN
  IPs. Run the addon on a home connection, or export YouTube cookies from a browser to
  `./data/cookies.txt` and set `YTDLP_COOKIES=/data/cookies.txt`.
- **`HTTP Error 429` on subtitles.** YouTube rate limits its *translated* subtitles (`no-en`, `no`)
  hard for servers. Set `GEMINI_API_KEY` (or `LIBRETRANSLATE_URL`): the addon then fetches the original
  track, an ordinary request, and translates it itself. Without one it retries, and if YouTube still
  refuses, plays the trailer without subtitles and tries again 30 minutes later.
- **No subtitles on a trailer.** The video has no captions at all (music-only trailers), or you have turned off
  auto-generated subtitles. The trailer still plays. The logs say which track was used.
- **A trailer is slow to start, or doesn't start.** Build one by hand and read what it says. It
  prints each step, how long it took and what failed:
  ```bash
  docker exec trailers-with-subs node src/selftest.js <YouTube id or link>
  ```
- **The first play has no subtitles, the second has.** The subtitles took longer than `SUB_WAIT_MS`.
- **Subtitles don't show in the AIOStreams app.** Add Norwegian to the app's subtitle languages; with
  the mode *Only forced* or *None* the track is not shown.
- **Changes don't show up.** AIOMetadata caches trailer lists for 24 hours (`TRAILER_ADDON_TTL`).
- **Lots of requests when AIOMetadata starts.** Its catalog warm-up asks about every title at once. TMDB
  calls are queued and rate limited, and when TMDB still fails the addon answers with an error
  (503), so AIOMetadata asks again later instead of keeping an empty list for a day.

## Development

```bash
npm test
```

The tests cover subtitle clean-up, format and subtitle choice, the TMDB logic, the
HTTP API in the shape AIOMetadata reads, and the whole ffmpeg pipeline: streaming a file that is
still being written, subtitle tracks and burned-in subtitles, slow and refused subtitles, range
requests, and failing on a lost audio track. They use synthetic media instead of YouTube.
