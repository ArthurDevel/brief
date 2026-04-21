# WhatsApp Emulator

Dev-only browser caller for the WhatsApp voice agent flow.

## What it does

- Validates a caller phone number against `user_settings.whatsapp_phone`
- Creates a LiveKit room and dispatches the existing WhatsApp agent
- Joins the room in the browser with microphone audio
- Plays the agent audio back through the browser
- Sends emulator text messages through the existing WhatsApp webhook endpoint
- Shows outbound WhatsApp replies and typing state in a local inbox

## Local run

```bash
cd apps/whatsapp-emulator
cp .env.example .env
pnpm install
pnpm dev
```

Open `http://localhost:3030`.
