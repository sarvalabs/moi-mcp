import { z } from "zod";

import { DappClient, sessionCookieFrom } from "../dapp/client.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

export type { FetchLike } from "../dapp/client.js";

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

export class LaunchpadClient extends DappClient {
  // -- auth: Sign-In With MOI is the generic client's; verify also returns the profile

  override async verify(input: { address: string; message: string; signature: string }): Promise<LaunchpadSession> {
    const res = await this.request("POST", "/api/auth/verify", { body: input });
    const body = await this.parse(res, Verified, "/api/auth/verify", false);
    const cookie = sessionCookieFrom(res);
    if (!cookie) {
      throw new MoiError(ErrorCode.LAUNCHPAD_ERROR, "The Launchpad accepted the signature but set no session cookie.");
    }
    return { cookie: cookie.cookie, expiresAt: cookie.expiresAt, profile: body.profile };
  }

  async me(cookie: string): Promise<z.infer<typeof Me>> {
    return this.json("GET", "/api/me", { cookie, schema: Me });
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
   * The agent's setup script, private key embedded. Read by the setup-script
   * tool only to describe it with secrets blanked, and by the one-time
   * download page to hand it to a browser. The body never becomes a tool result.
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
}
