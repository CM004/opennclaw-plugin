import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
};

type PluginConfig = {
  pythonCommand?: string;
  serverScript?: string;
  apiBaseUrl?: string;
  defaultRecipientEmail?: string;
  requestTimeoutMs?: number;
};

class StdioMcpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private defaultTimeoutMs: number;

  constructor(command: string, scriptPath: string, env: Record<string, string>, timeoutMs: number) {
    this.defaultTimeoutMs = timeoutMs;
    this.proc = spawn(command, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.on("data", (chunk) => {
      // Keep stderr visible for debugging in gateway logs
      console.warn("[adtech-mcp-bridge:mcp-stderr]", chunk.toString().trim());
    });

    this.proc.on("exit", (code, signal) => {
      const err = new Error(`MCP server exited (code=${code}, signal=${signal ?? "none"})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.buffer = Buffer.alloc(0);
        throw new Error("Invalid MCP frame: missing Content-Length header");
      }

      const contentLength = Number(contentLengthMatch[1]);
      const frameStart = headerEnd + 4;
      const frameEnd = frameStart + contentLength;
      if (this.buffer.length < frameEnd) return;

      const body = this.buffer.slice(frameStart, frameEnd).toString("utf8");
      this.buffer = this.buffer.slice(frameEnd);

      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      if (msg?.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? "Unknown MCP error"));
        else p.resolve(msg.result);
      }
    }
  }

  private send(req: JsonRpcRequest, timeoutMs?: number) {
    const to = timeoutMs ?? this.defaultTimeoutMs;
    const payload = JSON.stringify(req);
    const frame = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;

    return new Promise<any>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      this.proc.stdin.write(frame, "utf8", (err) => {
        if (err) {
          this.pending.delete(req.id);
          reject(err);
          return;
        }
        setTimeout(() => {
          if (this.pending.has(req.id)) {
            this.pending.delete(req.id);
            reject(new Error(`MCP request timed out: ${req.method}`));
          }
        }, to);
      });
    });
  }

  async initialize() {
    const id = this.nextId++;
    return this.send({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openclaw-adtech-bridge", version: "0.1.0" },
      },
    });
  }

  async callTool(name: string, args: Record<string, any>) {
    const id = this.nextId++;
    return this.send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    });
  }

  async close() {
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

function normalizeMcpToolResult(result: any): string {
  if (!result) return "No data returned.";

  // FastMCP usually returns MCP content array; keep it flexible.
  if (Array.isArray(result.content)) {
    const texts = result.content
      .map((c: any) => {
        if (typeof c?.text === "string") return c.text;
        return JSON.stringify(c);
      })
      .join("\n");
    return texts || JSON.stringify(result);
  }

  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function pickTopCampaign(campaignList: any): string | null {
  if (!campaignList) return null;

  const arr = Array.isArray(campaignList)
    ? campaignList
    : Array.isArray(campaignList?.campaigns)
      ? campaignList.campaigns
      : [];

  if (!arr.length) return null;

  // Try common ID keys
  const first = arr[0];
  return String(first.id ?? first.campaign_id ?? first.campaignId ?? first.name ?? "").trim() || null;
}

export default function register(api: any) {
  api.registerTool(
    {
      name: "adtech_email_top_campaign_report",
      description:
        "Fetch campaign list, choose top/first campaign (or user-specified campaign_id), pull campaign metrics via MCP, and email a report.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          email: {
            type: "string",
            description: "Recipient email. If omitted, plugin defaultRecipientEmail is used.",
          },
          campaign_id: {
            type: "string",
            description: "Optional explicit campaign id. If omitted, first campaign from list is selected.",
          },
          report_title: {
            type: "string",
            description: "Optional report title prefix.",
          },
        },
      },
      async execute(_toolCallId: string, params: any) {
        const cfg: PluginConfig = api?.config ?? {};
        const pythonCommand = cfg.pythonCommand || "python3";
        const serverScript = cfg.serverScript;
        const timeoutMs = cfg.requestTimeoutMs ?? 30000;
        const recipient = params?.email || cfg.defaultRecipientEmail;

        if (!serverScript) {
          return {
            content: [
              {
                type: "text",
                text: "Plugin config missing serverScript. Set plugins.entries.adtech-mcp-bridge.config.serverScript",
              },
            ],
            isError: true,
          };
        }

        if (!recipient) {
          return {
            content: [
              {
                type: "text",
                text: "No recipient email provided. Pass email parameter or set defaultRecipientEmail in plugin config.",
              },
            ],
            isError: true,
          };
        }

        const client = new StdioMcpClient(
          pythonCommand,
          serverScript,
          {
            BASE_URL: cfg.apiBaseUrl || "http://localhost:8000",
          },
          timeoutMs,
        );

        try {
          await client.initialize();

          let campaignId = params?.campaign_id;

          if (!campaignId) {
            const listRes = await client.callTool("get_campaign_list", {});
            const listData = listRes?.content?.[0]?.text ? safeJsonParse(listRes.content[0].text) : listRes;
            campaignId = pickTopCampaign(listData);
            if (!campaignId) {
              return {
                content: [{ type: "text", text: "No campaigns found to generate report." }],
                isError: true,
              };
            }
          }

          const metricsRes = await client.callTool("get_campaign_metrics", { campaign_id: campaignId });
          const metricsText = normalizeMcpToolResult(metricsRes);

          const title = params?.report_title || "Ad Campaign Performance Report";
          const report = `${title}\n\nCampaign ID: ${campaignId}\n\nMetrics:\n${metricsText}`;

          const emailRes = await client.callTool("email_campaign_report", {
            email: recipient,
            report,
          });

          return {
            content: [
              {
                type: "text",
                text:
                  `✅ Report generated and email request sent.\n` +
                  `Recipient: ${recipient}\n` +
                  `Campaign ID: ${campaignId}\n\n` +
                  `Mailer response:\n${normalizeMcpToolResult(emailRes)}`,
              },
            ],
          };
        } catch (err: any) {
          return {
            content: [
              {
                type: "text",
                text: `adtech-mcp-bridge error: ${err?.message ?? String(err)}`,
              },
            ],
            isError: true,
          };
        } finally {
          await client.close();
        }
      },
    },
    { optional: true },
  );
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
