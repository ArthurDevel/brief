"""
Test 3: Compare Python httpx vs Node fetch behavior for the same email ID.

The voice pipeline (Python/httpx) successfully fetches emails by id,
but Node fetch returns 404. Test whether the HTTP client matters.
"""

import asyncio
import os
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

DSN = os.environ["UNIPILE_DSN"]
API_KEY = os.environ["UNIPILE_API_KEY"]
ACCOUNT_ID = os.environ["UNIPILE_ACCOUNT_ID"]

HEADERS = {
    "X-API-KEY": API_KEY,
    "Accept": "application/json",
}


async def main():
    async with httpx.AsyncClient(timeout=15.0) as client:
        # Step 1: List emails
        print(f"=== Listing emails for account {ACCOUNT_ID} ===")
        list_res = await client.get(
            f"{DSN}/api/v1/emails",
            headers=HEADERS,
            params={"account_id": ACCOUNT_ID, "limit": 3, "folder": "INBOX"},
        )
        print(f"  List status: {list_res.status_code}")
        emails = list_res.json().get("items", [])

        for e in emails:
            email_id = e["id"]
            provider_id = e["provider_id"]
            subject = e.get("subject", "")[:50]
            print(f"\n  Email: id={email_id} | provider_id={provider_id} | {subject}")

            # Step 2: Fetch by id (same as voice pipeline does)
            r1 = await client.request(
                "GET",
                f"{DSN}/api/v1/emails/{email_id}",
                headers=HEADERS,
            )
            print(f"    httpx GET /emails/{email_id} -> {r1.status_code}")

            # Step 3: Also try with params= instead of URL interpolation
            r2 = await client.get(
                f"{DSN}/api/v1/emails/{email_id}",
                headers=HEADERS,
            )
            print(f"    httpx.get /emails/{email_id} -> {r2.status_code}")

            # Step 4: Print the actual URL that httpx sends
            print(f"    Actual URL sent: {r1.request.url}")

            # Step 5: Try raw urllib to compare
            import urllib.request
            import urllib.error
            req = urllib.request.Request(
                f"{DSN}/api/v1/emails/{email_id}",
                headers={"X-API-KEY": API_KEY, "Accept": "application/json"},
            )
            try:
                with urllib.request.urlopen(req) as resp:
                    print(f"    urllib GET -> {resp.status}")
            except urllib.error.HTTPError as err:
                print(f"    urllib GET -> {err.code}")


asyncio.run(main())
