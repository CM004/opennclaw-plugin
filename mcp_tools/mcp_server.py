from mcp.server.fastmcp import FastMCP
import requests
from services.mailer import send_email

mcp = FastMCP("AdTech Campaign Analyst")

BASE_URL = "http://localhost:8000"


# -----------------------------
# TOOL 1: List campaigns
# -----------------------------
@mcp.tool()
def get_campaign_list():
    """
    Fetch all available advertising campaign IDs.

    Use this tool when the user asks to:
    - view campaigns
    - compare or analyze campaigns
    - generate performance report
    """
    res = requests.get(f"{BASE_URL}/campaigns")
    return res.json()


# -----------------------------
# TOOL 2: Campaign metrics
# -----------------------------
@mcp.tool()
def get_campaign_metrics(campaign_id: str):
    """
    Retrieve performance metrics of a specific campaign.

    Returns CTR, ROI, daily spend, keywords and age group.

    Call this AFTER get_campaign_list.
    """
    res = requests.get(f"{BASE_URL}/campaign/{campaign_id}")
    return res.json()


# -----------------------------
# TOOL 3: Email report
# -----------------------------
@mcp.tool()
def email_campaign_report(to_email: str, report: str):
    """
    Send the generated campaign performance report to a user email.

    The LLM should call this AFTER creating the final marketing analysis report.
    """
    return send_email(
        to_email=to_email,
        subject="Ad Campaign Performance Report",
        body=report
    )


if __name__ == "__main__":
    mcp.run(transport="stdio")