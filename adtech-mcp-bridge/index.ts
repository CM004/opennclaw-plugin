import { spawn, ChildProcess } from "child_process";
import * as readline from "readline";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginConfig {
  serverScript: string;
  pythonCommand?: string;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
}

interface McpResponse {
  id: number;
  result?: { content?: Array<{ type: string; text: string }> };
  error?: { message: string };
}

// ─── Plugin Registration ──────────────────────────────────────────────────────

export function register(api: any) {
  api.registerTool({
    name: "adtech_email_top_campaign_report",
    description:
      "Fetches top AdTech campaigns with metrics and emails a formatted report to the specified recipient.",
    inputSchema: {
      type: "object",
      properties: {
        recipientEmail: {
          type: "string",
          description: "Email address to send the campaign report to",
        },
        topN: {
          type: "number",
          description: "Number of top campaigns to include (default: 3)",
          default: 3,
        },
      },
      required: ["recipientEmail"],
    },

    execute: async (params: { recipientEmail: string; topN?: number }, ctx: any) => {
      // ── Runtime config validation ────────────────────────────────────────────
      const config: PluginConfig = ctx?.config ?? {};

      if (!config.serverScript || config.serverScript.trim() === "") {
        return {
          text: [
            "❌ adtech-mcp-bridge: serverScript is not configured.",
            "",
            "Fix: run this command:",
            `  openclaw config set --strict-json plugins.entries.adtech-mcp-bridge '{`,
            `    "enabled": true,`,
            `    "config": {`,
            `      "serverScript": "/home/chandramohan/Desktop/openclawAdtech/mcp_tools/mcp_server.py",`,
            `      "pythonCommand": "python3",`,
            `      "apiBaseUrl": "http://localhost:8000",`,
            `      "requestTimeoutMs": 45000`,
            `    }`,
            `  }'`,
          ].join("\n"),
        };
      }

      const pythonCmd  = config.pythonCommand    ?? "python3";
      const timeoutMs  = config.requestTimeoutMs ?? 45000;
      const topN       = params.topN             ?? 3;
      const projectDir = "/home/chandramohan/Desktop/openclawAdtech";

      let proc: ChildProcess | null = null;

      try {
        // ── Spawn Python MCP server ────────────────────────────────────────────
        proc = spawn(pythonCmd, [config.serverScript], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: projectDir,
        });

        proc.stderr?.on("data", (data: Buffer) => {
          console.error(`[adtech-mcp-bridge] stderr: ${data.toString().trim()}`);
        });

        const rl = readline.createInterface({ input: proc.stdout! });
        const responseMap = new Map<number, (r: McpResponse) => void>();
        let msgId = 1; // id 0 is reserved for initialize

        rl.on("line", (line: string) => {
          let parsed: McpResponse | null = null;
          try {
            parsed = JSON.parse(line);
          } catch {
            console.warn("[adtech-mcp-bridge] non-JSON line:", line);
            return;
          }
          if (parsed?.id !== undefined) {
            responseMap.get(parsed.id)?.(parsed);
          }
        });

        // ── Step 1: MCP initialize handshake ──────────────────────────────────
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("MCP initialize timeout (10s)")),
            10000
          );

          responseMap.set(0, (resp) => {
            clearTimeout(timer);
            responseMap.delete(0);
            if (resp.error) {
              return reject(new Error(`MCP init error: ${resp.error.message}`));
            }
            // Send notifications/initialized — no response expected
            proc!.stdin!.write(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              }) + "\n"
            );
            resolve();
          });

          proc!.stdin!.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "adtech-mcp-bridge", version: "1.0.0" },
              },
            }) + "\n"
          );
        });

        // ── callMcp helper (used after handshake) ─────────────────────────────
        const callMcp = (toolName: string, toolArgs: object): Promise<McpResponse> => {
          return new Promise((resolve, reject) => {
            const id = msgId++;
            const timer = setTimeout(() => {
              responseMap.delete(id);
              reject(
                new Error(
                  `[adtech-mcp-bridge] Timeout after ${timeoutMs}ms calling '${toolName}'`
                )
              );
            }, timeoutMs);

            responseMap.set(id, (resp) => {
              clearTimeout(timer);
              responseMap.delete(id);
              resolve(resp);
            });

            proc!.stdin!.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: { name: toolName, arguments: toolArgs },
              }) + "\n"
            );
          });
        };

        const extractText = (resp: McpResponse): string => {
          if (resp.error) throw new Error(resp.error.message);
          return (resp.result?.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        };

        // ── Step 2: Get campaign list ──────────────────────────────────────────
        const listResp = await callMcp("get_campaign_list", { limit: topN });
        const listText = extractText(listResp);

        let campaigns: Array<{ id: string; name: string }> = [];
        try {
          const parsed = JSON.parse(listText);
          // Handle both array response and single-object response
          campaigns = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return {
            text: `❌ Failed to parse campaign list.\nRaw response:\n${listText}`,
          };
        }

        // ── Step 3: Get metrics for each campaign ──────────────────────────────
        const reportSections: string[] = [];

        for (const campaign of campaigns.slice(0, topN)) {
          const campaignId   = campaign.id   ?? (campaign as any).campaign_id;
          const campaignName = campaign.name ?? (campaign as any).campaign_name ?? campaignId;

          const mResp  = await callMcp("get_campaign_metrics", { campaign_id: campaignId });
          const mText  = extractText(mResp);

          let metricsBlock: string;
          try {
            const m = JSON.parse(mText);
            metricsBlock = [
              `  CTR:          ${m.ctr ?? "N/A"}%`,
              `  ROI:          ${m.roi ?? "N/A"}x`,
              `  Daily Spend:  $${m.daily_spend ?? "N/A"}`,
              `  Age Group:    ${m.age_group ?? "N/A"}`,
              `  Keywords:     ${(m.keywords ?? []).join(", ")}`,
            ].join("\n");
          } catch {
            metricsBlock = mText;
          }

          reportSections.push(`### ${campaignName}\n${metricsBlock}`);
        }

        const reportBody = [
          `AdTech Top ${topN} Campaign Report`,
          `Generated: ${new Date().toISOString()}`,
          "",
          ...reportSections,
        ].join("\n\n");

        // ── Step 4: Email the report ───────────────────────────────────────────
        const emailResp   = await callMcp("email_campaign_report", {
          recipient: params.recipientEmail,
          subject:   `Top ${topN} AdTech Campaign Report`,
          body:      reportBody,
        });
        const emailResult = extractText(emailResp);

        return {
          text: [
            `✅ Campaign report emailed to **${params.recipientEmail}**`,
            "",
            `📊 Campaigns included: ${campaigns
              .slice(0, topN)
              .map((c) => (c as any).campaign_name ?? c.name ?? c.id)
              .join(", ")}`,
            "",
            emailResult,
          ].join("\n"),
        };

      } catch (err: any) {
        return {
          text: `❌ adtech-mcp-bridge error: ${err?.message ?? String(err)}`,
        };
      } finally {
        proc?.stdin?.end();
        proc?.kill();
      }
    },
  });
}
