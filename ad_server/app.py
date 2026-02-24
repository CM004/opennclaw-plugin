from fastapi import FastAPI
from data import campaigns

app = FastAPI(title="Mini AdTech Platform")

@app.get("/")
def root():
    return {"message": "AdTech Platform Running"}

# Return structured campaign objects
@app.get("/campaigns")
def list_campaigns():
    return campaigns

# Proper search
@app.get("/campaign/{campaign_id}")
def campaign_details(campaign_id: str):
    for campaign in campaigns:
        if campaign["campaign_id"] == campaign_id:
            return campaign

    return {"error": f"Campaign '{campaign_id}' not found"}