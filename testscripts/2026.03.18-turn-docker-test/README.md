# TURN Docker Test

## Goal
Reproduce and fix the production WebRTC bug: voice calls connect (signaling works) but no audio flows. ICE stays at "checking" and the watchdog kills the pipeline after 10s. Server runs behind Docker/Traefik on Coolify.

## What didn't work
- **Test 5 (Incomplete Offer)**: Simulates the browser bug -- sends `offer.sdp` from `createOffer()` which has zero ICE candidates. The server gets an offer with no candidates and has nothing to connect to. In production this caused ICE to stay at "checking" forever. (In the test both peers share a Docker network so it still connects -- the bug only manifests when client and server are on different networks.)

## What worked
- **Test 1**: Fetching Metered TURN credentials via API.
- **Test 2**: TURN allocation via aioice -- confirms relay candidates are generated with `turns:TCP/443`.
- **Test 3**: Peer-to-peer data channel through TURN.
- **Test 4**: Audio track exchange through TURN.
- **Test 6 (Complete Offer)**: The fix -- sends `localDescription.sdp` (after ICE gathering completes) which includes relay candidates. Server can now reach the client through TURN.

## The fix
Browser must wait for `iceGatheringState === "complete"` then send `peerConnection.localDescription` (not the original `offer` object) so the SDP contains TURN relay candidates.

## How to run
```
cp .env.example .env   # fill in METERED_API_KEY
docker build -t turn-docker-test .
docker run --rm turn-docker-test
```
