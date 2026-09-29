# Webcal MCP Sidecar

Read-only MCP sidecar for exposing one `webcal://` / HTTPS iCalendar feed to Hermes Agent.

The feed URL is treated as a secret. It is never returned by MCP tools or written to normal application logs.

## Architecture

```text
Hermes Agent
    |
    | Streamable HTTP MCP
    v
http://webcal-mcp:8000/mcp
    |
    | HTTPS GET + in-memory cache
    v
Webcal / ICS feed
```

The server expands recurring events with RRULE, EXDATE and RECURRENCE-ID handling through `node-ical`.

## MCP tools

- `list_calendars` — metadata for the configured feed
- `search_events` — bounded date-range search with recurrence expansion
- `get_event` — fetch one event by UID, optionally one specific recurring occurrence

All tools are read-only.

## Configuration

The preferred setup is a mounted secret file:

```text
WEBCAL_URL_FILE=/run/secrets/webcal_url
WEBCAL_DEFAULT_TZ=Europe/Berlin
WEBCAL_CACHE_TTL_SECONDS=300
```

Optional environment variables:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `WEBCAL_NAME` | feed name / `Webcal` | Override the calendar display name |
| `WEBCAL_DEFAULT_TZ` | `Europe/Berlin` | Fallback timezone |
| `WEBCAL_CACHE_TTL_SECONDS` | `300` | In-memory feed cache TTL |
| `WEBCAL_FETCH_TIMEOUT_MS` | `15000` | HTTP timeout |
| `WEBCAL_MAX_BYTES` | `5242880` | Maximum ICS response size |
| `WEBCAL_MAX_RANGE_DAYS` | `730` | Maximum search window |
| `PORT` | `8000` | MCP HTTP port |

`webcal://` and `webcals://` URLs are normalized to HTTPS. Plain HTTP is intentionally rejected.

## Secret on the Docker host

Create the secret without putting the URL into shell history:

```bash
install -d -m 700 /etc/koch-secrets

read -r -s -p "Webcal URL: " WEBCAL_URL_TMP
printf '\n'
printf '%s' "$WEBCAL_URL_TMP" > /etc/koch-secrets/webcal_url
unset WEBCAL_URL_TMP

chown 10000:10000 /etc/koch-secrets/webcal_url
chmod 600 /etc/koch-secrets/webcal_url

stat -c '%F %u:%g %a %n' /etc/koch-secrets/webcal_url
```

Expected:

```text
regular file 10000:10000 600 /etc/koch-secrets/webcal_url
```

## Docker Compose / Coolify

Add this service to the existing Der Koch stack:

```yaml
  webcal-mcp:
    build:
      context: 'https://github.com/hungerundkoch/webcal-mcp-sidecar.git#main'
      dockerfile: Dockerfile
    restart: unless-stopped
    expose:
      - '8000'
    environment:
      WEBCAL_URL_FILE: /run/secrets/webcal_url
      WEBCAL_DEFAULT_TZ: Europe/Berlin
      WEBCAL_CACHE_TTL_SECONDS: '300'
    volumes:
      - '/etc/koch-secrets/webcal_url:/run/secrets/webcal_url:ro'
```

The image runs as UID/GID `10000:10000`, so the mounted secret must be readable by that identity.

## Hermes registration

After the service is reachable inside the Compose network:

```bash
hermes mcp add webcal-calendar --url "http://webcal-mcp:8000/mcp"
hermes mcp test webcal-calendar
```

For a running messaging gateway, reload MCP connections with:

```text
/reload-mcp
```

The resulting config entry is equivalent to:

```yaml
mcp_servers:
  webcal-calendar:
    url: http://webcal-mcp:8000/mcp
```

## Endpoints

- MCP: `POST/GET/DELETE /mcp`
- Health: `GET /healthz`

The health endpoint never fetches the remote calendar and never exposes the feed URL.

## Caching and freshness

The feed is cached in memory for five minutes by default. Conditional requests use `ETag` and `Last-Modified` when the feed server supports them.

`search_events` accepts `refresh: true` to bypass the TTL for one call.

## Security notes

- The Webcal URL may itself grant access to the calendar and must be treated like a password.
- No write capability exists.
- No feed URL is returned by MCP tools.
- Network and parse failures are deliberately reported without echoing the secret URL.
- Search windows and response size are bounded to avoid pathological or hostile feeds.
