# TURN ICE Server Test

## Goal
Verify that Metered TURN credentials can be fetched and that our server selection logic picks the right STUN + TURN servers for aiortc (which only uses the first of each).

## What didn't work
- Passing all 5 Metered servers to aiortc -- it only uses the first STUN and first TURN, so order matters.
- STUN listed before TURN caused aiortc to pick `turn:UDP/80` instead of `turns:TCP/443`.

## What worked
- Selecting a single `turns:TCP/443` (proxy-friendly) + one STUN server.
- Verifying raw TCP/TLS socket connectivity to the TURN endpoint from inside Docker.

## How to run
```
cp .env.example .env   # fill in METERED_API_KEY
pip install aiortc httpx python-dotenv
python test_turn.py
```
