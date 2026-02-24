# Test command flow (AdTech MCP bridge)

## 0) Prerequisites

- Your Python MCP server file exists (example: `/ABS/PATH/mcp_server.py`).
- Campaign API is reachable at `http://localhost:8000`.
- Mailer integration works in your Python project.

## 1) Install + enable plugin

```bash
openclaw plugins install -l /home/chandramohan/Desktop/openclawAdtech/adtech-mcp-plugin
openclaw plugins enable adtech-mcp-bridge
```

## 2) Configure plugin

Set required path:

```bash
openclaw config set plugins.entries.adtech-mcp-bridge.config.serverScript /home/chandramohan/Desktop/openclawAdtech/mcp_tools/mcp_server.py
```

Optional settings:

```bash
openclaw config set plugins.entries.adtech-mcp-bridge.config.pythonCommand python3
openclaw config set plugins.entries.adtech-mcp-bridge.config.apiBaseUrl http://localhost:8000
openclaw config set plugins.entries.adtech-mcp-bridge.config.defaultRecipientEmail you@example.com
openclaw config set plugins.entries.adtech-mcp-bridge.config.requestTimeoutMs 45000
```

## 3) Allow optional tool for your main agent

```bash
openclaw config set agents.list '[{"id":"main","tools":{"allow":["adtech_email_top_campaign_report"]}}]'
```

> If you already have `agents.list`, merge carefully instead of overwriting.

## 4) Restart gateway

```bash
openclaw gateway restart
openclaw plugins doctor
```

## 5) Use from chat

Ask OpenClaw in Telegram/Discord:

- `Email me the report of the top performing campaign to ayush@example.com`
- `Send campaign report to ayush@example.com for campaign C123`

The agent should call tool `adtech_email_top_campaign_report`.

## 6) Debug checks

```bash
openclaw plugins list
openclaw status --deep
openclaw logs --follow
```

Look for:

- plugin loaded: `adtech-mcp-bridge`
- no MCP startup errors
- MCP tool calls succeeding (`get_campaign_list`, `get_campaign_metrics`, `email_campaign_report`)
