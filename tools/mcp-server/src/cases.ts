// MCP-Cases bridge — thin HTTP client wrapping the canonical
// /api/cases routes. Each MCP tool's callTool branch goes through a
// helper here; the helpers don't add policy, just config + path +
// JSON shape. The Rust backend owns auth, RBAC, audit-events,
// invariant validation — the bridge is a transport adapter.
//
// Auth model (v2, self-healing — landed via [[runbook 0008]]):
//   REDPASH_API_BASE     — base URL incl. /api suffix.
//                          Default: http://localhost:8080/api
//   REDPASH_API_SESSION  — rp_session cookie value (optional). When
//                          set it's used as the initial cookie (CI /
//                          canonical-host pinning); when unset OR
//                          when the backend returns 401, the bridge
//                          self-mints via `POST /auth/dev-login`,
//                          caches the returned cookie in module
//                          state, and retries the failed call once.
//                          The cache survives the process lifetime
//                          and is shared across all helpers below.
//
// Why this changed (Em 2026-05-31):
//   v1 pinned the env at startup with no refresh path. When the
//   pinned cookie expired or was invalidated, every Torv's case
//   tools returned `HTTP 401, "no session cookie"` silently — only
//   surfaced when a tool was used, and only fixable by hand-editing
//   ~/.claude.json + restarting Claude Code. v2 makes the bridge
//   self-healing: if dev-login is reachable, the bridge keeps
//   working without any human-rotation step.
//
// The bridge is per-agent in stdio mode (one subprocess per Claude
// Code instance, module state scoped per process), so the session
// identity IS the agent's identity. HTTP-transport mode would need
// explicit agent identity per call — out of scope for v1 and v2.

const API_BASE_DEFAULT = "http://localhost:8080/api";

export class CaseApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "CaseApiError";
  }
}

function apiBase(): string {
  return (process.env.REDPASH_API_BASE ?? API_BASE_DEFAULT).replace(/\/+$/, "");
}

// ── session state (cache + mint coalescer) ──────────────────────────
//
// `cachedSession` is the live `rp_session` value. On first call it
// seeds from REDPASH_API_SESSION env; on any 401 it gets replaced by
// the result of `mintSession()`. The env's role is "initial seed,"
// not "single source of truth" — once a mint succeeds, the cache
// takes precedence for the rest of the process lifetime.
let cachedSession: string | null = null;
// In-flight mint promise — coalesces concurrent 401-driven retries so
// we don't stampede `POST /auth/dev-login` when several tool calls
// 401 at once.
let mintInFlight: Promise<string> | null = null;

async function mintSession(): Promise<string> {
  if (mintInFlight) return mintInFlight;
  const url = apiBase() + "/auth/dev-login";
  mintInFlight = (async () => {
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        throw new CaseApiError(
          `POST /auth/dev-login failed with HTTP ${res.status}`,
          res.status,
        );
      }
      // dev-login returns `Set-Cookie: rp_session=<id>; HttpOnly; …`.
      // Node's fetch joins multiple Set-Cookie headers with comma,
      // so a permissive regex on the joined value is fine — we only
      // care about extracting the `rp_session=…` token.
      const setCookie = res.headers.get("set-cookie") ?? "";
      const match = setCookie.match(/rp_session=([^;,\s]+)/);
      if (!match) {
        throw new CaseApiError(
          "POST /auth/dev-login succeeded but Set-Cookie missing rp_session",
          res.status,
        );
      }
      cachedSession = match[1];
      return cachedSession;
    } finally {
      mintInFlight = null;
    }
  })();
  return mintInFlight;
}

function currentSessionCookie(): string | null {
  // Cache (set by mint) wins over env — represents the most-
  // recently-valid session. Env is the seed when cache is empty.
  const sid = cachedSession ?? process.env.REDPASH_API_SESSION ?? null;
  return sid ? `rp_session=${sid}` : null;
}

interface ApiOpts {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | undefined>;
}

// Inner request runner — one round-trip with the cookie it's given.
// Returns the parsed body on success; throws `CaseApiError` on failure.
// The 401-aware retry lives in `apiFetch` so this function stays
// linear and easy to read.
async function doFetch<T>(
  url: string,
  method: string,
  cookie: string | null,
  hasBody: boolean,
  bodyJson: string | undefined,
  path: string,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (hasBody) headers["Content-Type"] = "application/json";

  const res = await fetch(url, { method, headers, body: bodyJson });
  const ct = res.headers.get("content-type") ?? "";
  let parsed: unknown = null;
  if (ct.includes("application/json")) {
    try { parsed = await res.json(); } catch { parsed = null; }
  } else {
    try { parsed = await res.text(); } catch { parsed = null; }
  }
  if (!res.ok) {
    const msg = typeof parsed === "object" && parsed && "message" in (parsed as object)
      ? String((parsed as Record<string, unknown>).message)
      : `${method} ${path} failed with HTTP ${res.status}`;
    throw new CaseApiError(msg, res.status, parsed);
  }
  return parsed as T;
}

async function apiFetch<T = unknown>(path: string, opts: ApiOpts = {}): Promise<T> {
  const method = opts.method ?? "GET";
  let url = apiBase() + path;
  if (opts.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null && v !== "") params.set(k, v);
    }
    const qs = params.toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const hasBody = opts.body !== undefined;
  const bodyJson = hasBody ? JSON.stringify(opts.body) : undefined;

  // First attempt — use whatever cookie is currently cached / env'd.
  try {
    return await doFetch<T>(url, method, currentSessionCookie(), hasBody, bodyJson, path);
  } catch (err) {
    if (!(err instanceof CaseApiError) || err.status !== 401) throw err;
    // 401 path — invalidate the cache so currentSessionCookie() falls
    // back to the env (if any) for the retry's cookie computation,
    // then re-mint via dev-login. The mint coalescer makes concurrent
    // retries share one dev-login round-trip.
    cachedSession = null;
    await mintSession();
    // Second attempt — if this also 401s, surface the error.
    return await doFetch<T>(url, method, currentSessionCookie(), hasBody, bodyJson, path);
  }
}

// ── tool-shape DTOs (mirror the Rust handlers' request/response) ────

export interface CaseCreateArgs {
  title: string;
  description?: string;
  type?: "bug" | "feature" | "task" | "epic";
  priority?: "low" | "medium" | "high" | "critical";
  assignee_id?: string;
  project_id?: string;
  company_id?: string;
}

export interface CaseCommentArgs {
  rid: string;
  body: string;
}

export interface CaseSetStatusArgs {
  rid: string;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "done";
}

export interface CaseListArgs {
  status?: string;
  assignee?: string;
  project?: string;
  q?: string;
  page?: number;
  size?: number;
}

export interface CaseSummary {
  redpash_id?: string;
  title?: string;
  status?: string;
  priority?: string;
  type?: string;
  assignee_id?: string | null;
  assignee_display_name?: string | null;
  reporter_id?: string | null;
  reporter_display_name?: string | null;
  updated_at?: string;
  created_at?: string;
  [k: string]: unknown;
}

// ── public helpers ──────────────────────────────────────────────────

export function createCase(args: CaseCreateArgs) {
  return apiFetch<CaseSummary>("/cases", { method: "POST", body: args });
}

export function getCase(rid: string) {
  return apiFetch<unknown>(`/cases/${encodeURIComponent(rid)}`);
}

export function listCases(args: CaseListArgs) {
  return apiFetch<{ items: CaseSummary[]; total: number; page: number; size: number }>(
    "/cases",
    {
      query: {
        status:   args.status,
        assignee: args.assignee,
        project:  args.project,
        q:        args.q,
        page:     args.page != null ? String(args.page) : undefined,
        size:     args.size != null ? String(args.size) : undefined,
      },
    },
  );
}

export function addComment(args: CaseCommentArgs) {
  return apiFetch<unknown>(
    `/cases/${encodeURIComponent(args.rid)}/comments`,
    { method: "POST", body: { body: args.body } },
  );
}

export function setCaseStatus(args: CaseSetStatusArgs) {
  // PATCH /cases/:rid is a partial update — sending only `status` moves the
  // kanban column without touching title/priority/assignee. The Rust backend
  // validates the enum and emits a "status: X → Y" activity-feed event (the
  // audit spine), so the bridge duplicates no policy here.
  return apiFetch<CaseSummary>(
    `/cases/${encodeURIComponent(args.rid)}`,
    { method: "PATCH", body: { status: args.status } },
  );
}
