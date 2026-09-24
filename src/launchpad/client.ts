/**
 * HTTP client for the MOI Agent Launchpad (sarvalabs/moi-agent-launchpad).
 *
 * The Launchpad has no API keys. An owner is whoever holds its `moi_session`
 * cookie, which it issues after Sign-In With MOI: it hands out a message, the
 * wallet signs it, the signature comes back. Everything here is that cookie
 * plus the handful of JSON routes the dashboard itself uses, read against the
 * Launchpad source on 2026-09-23. No MCP imports: plain TS library.
 */

import { z } from "zod";

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

/** Per-request budget. The Launchpad geocodes and hits the chain on some routes. */
const TIMEOUT_MS = 20_000;
const SESSION_COOKIE = "moi_session";
/** What the Launchpad sets when the cookie carries no Max-Age. Its own default. */
const DEFAULT_SESSION_SECONDS = 7 * 24 * 60 * 60;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const Nonce = z.object({ nonce: z.string().min(1), message: z.string().min(20) });
const Profile = z.object({ id: z.string(), walletAddress: z.string() });
const Verified = z.object({ ok: z.literal(true), profile: Profile });
const Me = z.object({
  profile: z.object({ id: z.string(), walletAddress: z.string(), telegramLinked: z.boolean() }),
  usage: z.object({ interactions: z.number(), max: z.number() }).optional(),
});

export const ConfigField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.string(),
  placeholder: z.string().optional(),
  help: z.string().optional(),
  maxLength: z.number().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  allowCustom: z.boolean().optional(),
  optional: z.boolean().optional(),
  privateValue: z.boolean().optional(),
});
export const Template = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string().optional(),
  emoji: z.string().optional(),
  scaffold: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  requiresApiKey: z.boolean().optional(),
  apiKeyPresent: z.boolean().optional(),
  configFields: z.array(ConfigField).default([]),
  examplePrompts: z.array(z.string()).default([]),
});
export type Template = z.infer<typeof Template>;
const Templates = z.object({ templates: z.array(Template) });
type TemplatesOut = z.output<typeof Templates>;

/** What POST /api/agents and GET /api/agents hand back per agent. Extra columns pass through. */
export const AgentRecord = z
  .object({
    id: z.string(),
    name: z.string(),
    moi_address: z.string().nullable().optional(),
    template_id: z.string().optional(),
    status: z.string(),
    visibility: z.string().optional(),
    registry_tx: z.string().nullable().optional(),
    keyReadable: z.boolean().optional(),
  })
  .passthrough();
export type AgentRecord = z.infer<typeof AgentRecord>;
const Created = z.object({ agent: AgentRecord });
const AgentList = z.object({ agents: z.array(AgentRecord) });
const AgentDetail = z.object({ agent: AgentRecord });
const RegisterIntent = z.object({
  interaction: z.unknown(),
  blocked: z
    .object({
      sequence: z.number(),
      fuelLimit: z.number(),
      blockedCount: z.number(),
      underfunded: z.boolean(),
      balance: z.number(),
      needed: z.number(),
    })
    .nullable()
    .optional(),
});
export type RegisterIntent = z.infer<typeof RegisterIntent>;
const Confirmed = z.object({ ok: z.literal(true), registryTx: z.string().optional() });
const DeepLink = z.object({ deepLink: z.string().url() });

export interface CreateAgentBody {
  templateId: string;
  name: string;
  avatarSeed: string;
  config: Record<string, unknown>;
  visibility?: "private" | "public";
  category?: string;
  price?: number;
}

export interface LaunchpadSession {
  cookie: string;
  /** Unix seconds. */
  expiresAt: number;
  profile: z.infer<typeof Profile>;
}

/** The Launchpad's own error string, when its JSON body carries one. */
function errorOf(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const parts = [o["error"], o["message"], o["reason"], o["detail"]].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (parts.length > 0) return parts.join(": ");
  }
  return `HTTP ${status}`;
}

export class LaunchpadClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  // -- auth ---------------------------------------------------------------

  async nonce(walletAddress: string): Promise<z.infer<typeof Nonce>> {
    return this.json("POST", "/api/auth/nonce", { body: { walletAddress }, schema: Nonce });
  }

  /**
   * Exchange the signed message for a session. The cookie comes out of the
   * Set-Cookie header; the body only says who signed in.
   */
  async verify(input: { address: string; message: string; signature: string }): Promise<LaunchpadSession> {
    const res = await this.request("POST", "/api/auth/verify", { body: input });
    const body = await this.parse(res, Verified, "/api/auth/verify");
    const cookie = sessionCookieFrom(res);
    if (!cookie) {
      throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, "The Launchpad accepted the signature but set no session cookie.");
    }
    return { cookie: cookie.value, expiresAt: cookie.expiresAt, profile: body.profile };
  }

  async me(cookie: string): Promise<z.infer<typeof Me>> {
    return this.json("GET", "/api/me", { cookie, schema: Me });
  }

  async logout(cookie: string): Promise<void> {
    await this.request("POST", "/api/auth/logout", { cookie });
  }

  // -- templates and agents ------------------------------------------------

  async templates(): Promise<Template[]> {
    const out: TemplatesOut = await this.json("GET", "/api/templates", { schema: Templates });
    return out.templates;
  }

  async createAgent(cookie: string, body: CreateAgentBody): Promise<AgentRecord> {
    return (await this.json("POST", "/api/agents", { cookie, body, schema: Created })).agent;
  }

  async listAgents(cookie: string): Promise<AgentRecord[]> {
    return (await this.json("GET", "/api/agents", { cookie, schema: AgentList })).agents;
  }

  async getAgent(cookie: string, id: string): Promise<AgentRecord> {
    return (await this.json("GET", `/api/agents/${encodeURIComponent(id)}`, { cookie, schema: AgentDetail })).agent;
  }

  async registerIntent(cookie: string, id: string): Promise<RegisterIntent> {
    return this.json("POST", `/api/agents/${encodeURIComponent(id)}/register-intent`, { cookie, schema: RegisterIntent });
  }

  async registerConfirm(cookie: string, id: string, body: { txHash: string; agentId?: string }): Promise<void> {
    await this.json("POST", `/api/agents/${encodeURIComponent(id)}/register-confirm`, { cookie, body, schema: Confirmed });
  }

  async telegramLink(cookie: string): Promise<string> {
    return (await this.json("POST", "/api/telegram/link", { cookie, schema: DeepLink })).deepLink;
  }

  /**
   * The agent's setup script, private key embedded. Fetched only at the moment
   * a one-time download link is opened; never returned through a tool.
   */
  async setupScript(cookie: string, id: string): Promise<{ filename: string; body: string }> {
    const res = await this.request("GET", `/api/agents/${encodeURIComponent(id)}/setup-script`, { cookie });
    if (!res.ok) await this.fail(res, "/api/agents/:id/setup-script", true);
    const disposition = res.headers.get("content-disposition") ?? "";
    const named = /filename="([^"]+)"/.exec(disposition)?.[1];
    return { filename: named ?? `setup-${id}.sh`, body: await res.text() };
  }

  // -- plumbing -----------------------------------------------------------

  private async json<T>(
    method: "GET" | "POST",
    path: string,
    opts: { cookie?: string; body?: unknown; schema: z.ZodType<T, z.ZodTypeDef, unknown> },
  ): Promise<T> {
    const res = await this.request(method, path, opts);
    return this.parse(res, opts.schema, path, opts.cookie !== undefined);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    opts: { cookie?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.cookie) headers["cookie"] = `${SESSION_COOKIE}=${opts.cookie}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    try {
      return await this.fetchImpl(this.baseUrl + path, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_ERROR,
        `Could not reach the Launchpad at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async parse<T>(
    res: Response,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    path: string,
    withSession = false,
  ): Promise<T> {
    if (!res.ok) await this.fail(res, path, withSession);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `The Launchpad answered ${path} with something other than JSON.`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_ERROR,
        `The Launchpad answered ${path} in a shape this server does not understand: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    }
    return parsed.data;
  }

  /**
   * A 401 to a request that carried the session means the session is dead.
   * A 401 to sign-in itself means the signature was refused; that is an
   * ordinary error, and the caller has no session to forget.
   */
  private async fail(res: Response, path: string, withSession: boolean): Promise<never> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const detail = errorOf(body, res.status);
    if (res.status === 401 && withSession) {
      throw new MoiError(
        ErrorCode.LAUNCHPAD_NOT_SIGNED_IN,
        "The Launchpad does not recognise this session. Sign in again with moi_launchpad_sign_in.",
      );
    }
    throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, `Launchpad ${path} refused: ${detail}`, {
      status: res.status,
      ...(body && typeof body === "object" ? { body } : {}),
    });
  }
}

/** The session cookie out of a response, with when the Launchpad says it ends. */
export function sessionCookieFrom(res: Response): { value: string; expiresAt: number } | undefined {
  const all: string[] =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : ([res.headers.get("set-cookie")].filter(Boolean) as string[]);
  for (const line of all) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq) !== SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1);
    if (!value) continue;
    let seconds = DEFAULT_SESSION_SECONDS;
    for (const attr of attrs) {
      const m = /^max-age=(\d+)$/i.exec(attr);
      if (m) seconds = Number(m[1]);
    }
    return { value, expiresAt: Math.floor(Date.now() / 1000) + seconds };
  }
  return undefined;
}
