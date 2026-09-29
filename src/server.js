import express from 'express';
import { randomUUID } from 'node:crypto';
import ical from 'node-ical';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const PORT = Number.parseInt(process.env.PORT ?? '8000', 10);
const DEFAULT_TZ = process.env.WEBCAL_DEFAULT_TZ ?? 'Europe/Berlin';
const CALENDAR_NAME_OVERRIDE = process.env.WEBCAL_NAME?.trim() || '';
const CACHE_TTL_SECONDS = boundedInt(process.env.WEBCAL_CACHE_TTL_SECONDS, 300, 30, 86400);
const FETCH_TIMEOUT_MS = boundedInt(process.env.WEBCAL_FETCH_TIMEOUT_MS, 15000, 1000, 120000);
const MAX_BYTES = boundedInt(process.env.WEBCAL_MAX_BYTES, 5 * 1024 * 1024, 1024, 50 * 1024 * 1024);
const MAX_RANGE_DAYS = boundedInt(process.env.WEBCAL_MAX_RANGE_DAYS, 730, 1, 3650);

let cache = null;

function boundedInt(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw ?? '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeFeedUrl(raw) {
  if (!raw) throw new Error('WEBCAL_URL is not configured');

  const trimmed = raw.trim();
  const normalized = trimmed
    .replace(/^webcals:\/\//i, 'https://')
    .replace(/^webcal:\/\//i, 'https://');

  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('WEBCAL_URL is invalid');
  }

  if (url.protocol !== 'https:') {
    throw new Error('WEBCAL_URL must use webcal://, webcals://, or https://');
  }

  return url.toString();
}

function validateTimezone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const FALLBACK_TZ = validateTimezone(DEFAULT_TZ);

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: 'failed', error: message }) }],
  };
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${name}] ${message}`);
      return toolError(error);
    }
  });
}

async function readLimitedText(response) {
  const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(length) && length > MAX_BYTES) {
    throw new Error('Webcal feed exceeds configured size limit');
  }

  if (!response.body) return '';

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BYTES) {
      throw new Error('Webcal feed exceeds configured size limit');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function calendarMetadata(parsed) {
  const vcalendar = Object.values(parsed).find((entry) => entry?.type === 'VCALENDAR');
  const discoveredName =
    vcalendar?.wr_calname ??
    vcalendar?.['x-wr-calname'] ??
    vcalendar?.name ??
    '';

  return {
    calendar_id: 'webcal',
    name: CALENDAR_NAME_OVERRIDE || String(discoveredName || 'Webcal'),
    read_only: true,
    timezone: FALLBACK_TZ,
  };
}

async function fetchCalendar({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    cache &&
    now - cache.fetchedAt < CACHE_TTL_SECONDS * 1000
  ) {
    return cache;
  }

  const url = normalizeFeedUrl(process.env.WEBCAL_URL);
  const headers = {
    accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1',
    'user-agent': 'hunger-koch-webcal-mcp/1.0',
  };

  if (cache?.etag) headers['if-none-match'] = cache.etag;
  if (cache?.lastModified) headers['if-modified-since'] = cache.lastModified;

  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Webcal fetch failed due to a network error or timeout');
  }

  if (response.status === 304 && cache) {
    cache = { ...cache, fetchedAt: now };
    return cache;
  }

  if (!response.ok) {
    throw new Error(`Webcal fetch failed with HTTP ${response.status}`);
  }

  const text = await readLimitedText(response);
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('Webcal response is not an iCalendar feed');
  }

  let parsed;
  try {
    parsed = ical.sync.parseICS(text);
  } catch {
    throw new Error('Webcal feed could not be parsed as iCalendar');
  }

  cache = {
    fetchedAt: now,
    etag: response.headers.get('etag') || null,
    lastModified: response.headers.get('last-modified') || null,
    parsed,
    metadata: calendarMetadata(parsed),
  };

  return cache;
}

function parseDate(value, label) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid ISO 8601 date/time`);
  }
  return date;
}

function resolveRange(start, end) {
  const from = start ? parseDate(start, 'start') : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const to = end ? parseDate(end, 'end') : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  if (to <= from) throw new Error('end must be after start');

  const maxMs = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  if (to.getTime() - from.getTime() > maxMs) {
    throw new Error(`Requested range exceeds ${MAX_RANGE_DAYS} days`);
  }

  return { from, to };
}

function localDateKey(date, timeZone) {
  const tz = validateTimezone(timeZone || FALLBACK_TZ);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function eventTimezone(event, instance) {
  return (
    instance?.start?.tz ||
    event?.start?.tz ||
    event?.timezone ||
    FALLBACK_TZ
  );
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    if (typeof value.val === 'string') return value.val;
    if (typeof value.value === 'string') return value.value;
  }
  return value == null ? null : String(value);
}

function normalizeCategories(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [textValue(value)].filter(Boolean);
}

function truncate(value, max) {
  const text = textValue(value);
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function overlaps(start, end, from, to) {
  return start < to && end > from;
}

function baseEventTimes(event) {
  const start = event?.start instanceof Date ? event.start : null;
  if (!start) return null;

  let end = event?.end instanceof Date ? event.end : null;
  if (!end) {
    const isFullDay = Boolean(start.dateOnly || event.datetype === 'date');
    end = new Date(start.getTime() + (isFullDay ? 24 * 60 * 60 * 1000 : 0));
  }

  return { start, end };
}

function normalizeOccurrence(event, instance, { fullDescription = false } = {}) {
  const start = instance?.start instanceof Date ? instance.start : event.start;
  const end = instance?.end instanceof Date ? instance.end : (event.end ?? start);
  const timeZone = eventTimezone(event, instance);
  const allDay = Boolean(
    instance?.isFullDay ||
    start?.dateOnly ||
    event?.datetype === 'date'
  );

  const source = instance ?? event;
  const uid = textValue(source.uid ?? event.uid);
  const occurrenceStart = start instanceof Date ? start.toISOString() : null;

  return {
    calendar_id: 'webcal',
    uid,
    occurrence_start: occurrenceStart,
    summary: textValue(source.summary ?? event.summary) || '(ohne Titel)',
    start: allDay ? localDateKey(start, timeZone) : occurrenceStart,
    end: allDay ? localDateKey(end, timeZone) : (end instanceof Date ? end.toISOString() : null),
    all_day: allDay,
    timezone: timeZone,
    location: textValue(source.location ?? event.location),
    description: truncate(source.description ?? event.description, fullDescription ? 8000 : 1000),
    url: textValue(source.url ?? event.url),
    status: textValue(source.status ?? event.status),
    organizer: textValue(source.organizer ?? event.organizer),
    categories: normalizeCategories(source.categories ?? event.categories),
    recurring: Boolean(event.rrule),
    recurrence_rule: event.rrule?.toString?.() ?? null,
    recurrence_override: Boolean(instance?.isOverride),
  };
}

function eventObjects(parsed) {
  return Object.values(parsed).filter((entry) => entry?.type === 'VEVENT');
}

function expandEvent(event, from, to) {
  if (String(event.status || '').toUpperCase() === 'CANCELLED') return [];

  if (!event.rrule) {
    const times = baseEventTimes(event);
    if (!times || !overlaps(times.start, times.end, from, to)) return [];
    return [normalizeOccurrence(event, event)];
  }

  let instances;
  try {
    instances = ical.expandRecurringEvent(event, {
      from,
      to,
      includeOverrides: true,
      excludeExdates: true,
      expandOngoing: true,
    });
  } catch {
    throw new Error(`Could not expand recurring event ${textValue(event.uid) || '(unknown UID)'}`);
  }

  if (!Array.isArray(instances)) return [];

  return instances
    .filter((instance) => String(instance?.status ?? event.status ?? '').toUpperCase() !== 'CANCELLED')
    .map((instance) => normalizeOccurrence(event, instance))
    .filter((occurrence) => {
      const start = parseDate(occurrence.all_day ? `${occurrence.start}T00:00:00Z` : occurrence.start, 'occurrence start');
      const endValue = occurrence.end || occurrence.start;
      const end = parseDate(occurrence.all_day ? `${endValue}T00:00:00Z` : endValue, 'occurrence end');
      return overlaps(start, end, from, to);
    });
}

function sortOccurrences(events) {
  return events.sort((a, b) => {
    const aTime = Date.parse(a.all_day ? `${a.start}T00:00:00Z` : a.start);
    const bTime = Date.parse(b.all_day ? `${b.start}T00:00:00Z` : b.start);
    return aTime - bTime;
  });
}

function matchesQuery(event, query) {
  if (!query) return true;
  const needle = query.toLocaleLowerCase('de-DE');
  const haystack = [
    event.summary,
    event.location,
    event.description,
    event.organizer,
    event.url,
    ...(event.categories ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLocaleLowerCase('de-DE');

  return haystack.includes(needle);
}

function registerCalendarTools(server) {
  registerTool(
    server,
    'list_calendars',
    {
      description: 'List the configured read-only Webcal calendar.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {},
    },
    async () => {
      const data = await fetchCalendar();
      return {
        status: 'ok',
        calendars: [data.metadata],
        cache_age_seconds: Math.max(0, Math.floor((Date.now() - data.fetchedAt) / 1000)),
      };
    },
  );

  registerTool(
    server,
    'search_events',
    {
      description: 'Search and expand Webcal events in a bounded time range. Recurrences, EXDATEs, and RECURRENCE-ID overrides are resolved before results are returned.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        start: z.string().optional().describe('ISO 8601 range start. Defaults to 24 hours ago.'),
        end: z.string().optional().describe('ISO 8601 range end. Defaults to 90 days from now.'),
        query: z.string().max(500).optional().describe('Case-insensitive text filter across title, location, description, organizer, URL, and categories.'),
        limit: z.number().int().min(1).max(200).default(50),
        refresh: z.boolean().default(false).describe('Bypass the in-memory feed cache for this call.'),
      },
    },
    async ({ start, end, query, limit, refresh }) => {
      const { from, to } = resolveRange(start, end);
      const data = await fetchCalendar({ force: refresh });

      const occurrences = sortOccurrences(
        eventObjects(data.parsed)
          .flatMap((event) => expandEvent(event, from, to))
          .filter((event) => matchesQuery(event, query)),
      );

      return {
        status: 'ok',
        calendar: data.metadata,
        range: { start: from.toISOString(), end: to.toISOString() },
        total_matches: occurrences.length,
        truncated: occurrences.length > limit,
        events: occurrences.slice(0, limit),
      };
    },
  );

  registerTool(
    server,
    'get_event',
    {
      description: 'Get one Webcal event by UID. For a specific recurring occurrence, also pass the occurrence_start returned by search_events.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        uid: z.string().min(1),
        occurrence_start: z.string().optional().describe('ISO timestamp returned by search_events for a recurring occurrence.'),
      },
    },
    async ({ uid, occurrence_start }) => {
      const data = await fetchCalendar();
      const event = eventObjects(data.parsed).find((candidate) => textValue(candidate.uid) === uid);

      if (!event) {
        return { status: 'not_found', uid };
      }

      if (!occurrence_start) {
        const normalized = normalizeOccurrence(event, event, { fullDescription: true });
        return {
          status: 'ok',
          calendar: data.metadata,
          event: normalized,
        };
      }

      const target = parseDate(occurrence_start, 'occurrence_start');
      const from = new Date(target.getTime() - 36 * 60 * 60 * 1000);
      const to = new Date(target.getTime() + 36 * 60 * 60 * 1000);

      const occurrence = expandEvent(event, from, to).find(
        (candidate) => candidate.occurrence_start === target.toISOString(),
      );

      if (!occurrence) {
        return { status: 'not_found', uid, occurrence_start: target.toISOString() };
      }

      const detailed = {
        ...occurrence,
        description: truncate(event.description, 8000),
      };

      return {
        status: 'ok',
        calendar: data.metadata,
        event: detailed,
      };
    },
  );
}

function createMcpServer() {
  const server = new McpServer({
    name: 'hunger-koch-webcal-mcp-sidecar',
    version: '1.0.0',
  });

  registerCalendarTools(server);
  return server;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const transports = new Map();

app.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    configured: Boolean(process.env.WEBCAL_URL),
    cached: Boolean(cache),
    cache_age_seconds: cache ? Math.max(0, Math.floor((Date.now() - cache.fetchedAt) / 1000)) : null,
  });
});

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (typeof sessionId === 'string' && transports.has(sessionId)) {
      transport = transports.get(sessionId);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });

      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      res.status(400).json({ error: 'Invalid or missing MCP session' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-post] ${message}`);
    if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' });
  }
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  if (typeof sessionId !== 'string' || !transports.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing MCP session' });
    return;
  }
  await transports.get(sessionId).handleRequest(req, res);
}

app.get('/mcp', (req, res) => {
  handleSessionRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-get] ${message}`);
    if (!res.headersSent) res.status(500).end();
  });
});

app.delete('/mcp', (req, res) => {
  handleSessionRequest(req, res).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[mcp-delete] ${message}`);
    if (!res.headersSent) res.status(500).end();
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hunger & Koch Webcal MCP sidecar listening on :${PORT}/mcp`);
});
