# Twilio Browser Bridge

Standalone testscript bridge for a live phone-to-browser conversation.

- Your phone calls the Twilio number
- Twilio streams the call into this local test server
- Your browser opens the local page, picks up the call, and talks through your laptop mic and speakers

## Files

- `bridge_server.py`: FastAPI server with the Twilio and browser WebSocket bridge
- `static/index.html`: browser control page
- `static/app.js`: browser control logic and audio WebSocket client
- `static/pcm-capture-worklet.js`: mic capture worklet
- `static/pcm-player-worklet.js`: speaker playback worklet
- `start-server.sh`: main startup script that installs dependencies, starts the server, and cleans up on `Ctrl+C`
- `start_bridge.sh`: compatibility wrapper that forwards to `start-server.sh`

## Requirements

- Python 3.11+
- `cloudflared` if you want `--quick-tunnel`
- `jq` if you want automatic webhook configuration
- A Twilio voice phone number

## Setup

```bash
cd testscripts/2026.04.21-twilio-browser-bridge
cp .env.example .env
```

Fill in:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`

You can leave `PUBLIC_URL` empty if you start with `--quick-tunnel`.

## Run

### Option 1: quickest path

```bash
./start-server.sh --quick-tunnel
```

This does the following:

- creates the local virtualenv if needed
- installs the Python requirements
- starts a Cloudflare quick tunnel
- sets `PUBLIC_URL` from the tunnel URL
- updates the Twilio phone number webhook to `PUBLIC_URL/twilio/voice`
- starts the local bridge server

### Option 2: use your own public URL

Set `PUBLIC_URL` in `.env`, point your tunnel or reverse proxy there, then run:

```bash
./start-server.sh
```

`Ctrl+C` stops the local Python server and also kills the background tunnel process.

## Use

1. Open `http://localhost:8780` in your laptop browser.
2. Click `Connect browser audio`.
3. Call the configured Twilio number from your phone.
4. When the page shows the incoming call, click `Pick up call`.
5. Talk between your phone and your browser.
6. End the call from your phone, or click `Hang up`.

## Notes

- This bridge supports one browser client and one active phone call at a time.
- If the browser disconnects after pickup, the server ends the call.
- For the cleanest audio, use headphones on the browser side.
