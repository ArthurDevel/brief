#!/usr/bin/env python3
"""
Docker-based WebRTC TURN connectivity test.

Simulates the production environment (Docker container) to diagnose why ICE
stays at "checking" and never reaches "connected" when using Metered TURN servers.

Responsibilities:
- Fetch TURN credentials from the Metered API
- Test TURN allocation via aioice to verify relay candidates
- Test full peer-to-peer connection through TURN (data channel)
- Test audio track exchange through TURN

Usage:
    docker build -t turn-docker-test . && docker run --rm turn-docker-test
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

from aiortc import (  # pyright: ignore[reportMissingImports]
    RTCPeerConnection,
    RTCSessionDescription,
    RTCConfiguration,
    RTCIceServer,
    MediaStreamTrack,
)

# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR / ".env")

METERED_API_KEY = os.getenv("METERED_API_KEY")
METERED_CREDENTIALS_URL = "https://0x41.metered.live/api/v1/turn/credentials"

ICE_TIMEOUT_SECONDS = 30
TRACK_RECEIVE_TIMEOUT_SECONDS = 15
INCOMPLETE_OFFER_TIMEOUT_SECONDS = 15


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _print_header(title: str) -> None:
    """Print a section header."""
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}\n")


def _print_result(label: str, passed: bool) -> None:
    """Print PASS/FAIL for a test."""
    status = "PASS" if passed else "FAIL"
    print(f"  [{status}] {label}")


def _build_ice_servers(raw_servers: list[dict]) -> list[RTCIceServer]:
    """
    Convert the raw Metered API response into a list of RTCIceServer objects.
    Uses the same selection logic as production: picks the best STUN + best TURN.

    aiortc only uses the FIRST STUN and FIRST TURN server, so order matters.
    We prioritize TURNS/TCP on 443 (works through HTTP proxies like Traefik).

    @param raw_servers: List of server dicts from the Metered API.
    @return: List of RTCIceServer instances (1 STUN + 1 TURN).
    """
    stun_server: dict | None = None
    turn_server: dict | None = None

    for server in raw_servers:
        raw = server.get("urls") or server.get("url") or ""
        url: str = raw[0] if isinstance(raw, list) else raw

        # Prefer TURNS over TCP on 443 (works through any proxy)
        if url.startswith("turns:") and "transport=tcp" in url:
            turn_server = server
        # Fallback: any TURN server if no TURNS found yet
        elif url.startswith("turn:") and not turn_server:
            turn_server = server
        # Pick first STUN server
        elif url.startswith("stun:") and not stun_server:
            stun_server = server

    # Build RTCIceServer list -- TURN first so aioice picks it up
    ice_servers: list[RTCIceServer] = []
    for selected in [turn_server, stun_server]:
        if not selected:
            continue
        raw_urls = selected.get("urls") or selected.get("url")
        if not raw_urls:
            continue
        url_list: list[str] = [raw_urls] if isinstance(raw_urls, str) else raw_urls
        ice_servers.append(RTCIceServer(
            urls=url_list,
            username=selected.get("username", ""),
            credential=selected.get("credential", ""),
        ))

    return ice_servers


class _DummyAudioTrack(MediaStreamTrack):
    """
    A silent audio track that produces empty frames.
    Used to test audio track exchange without needing real audio input.
    """
    kind = "audio"

    def __init__(self):
        super().__init__()
        self._timestamp = 0

    async def recv(self):
        """Generate a silent audio frame."""
        from av import AudioFrame  # pyright: ignore[reportMissingImports]
        import numpy as np  # pyright: ignore[reportMissingImports]

        # Wait a bit to simulate real-time audio pacing
        await asyncio.sleep(0.02)

        # 960 samples at 48kHz = 20ms frame
        frame = AudioFrame(format="s16", layout="mono", samples=960)
        frame.sample_rate = 48000
        frame.pts = self._timestamp
        frame.time_base = "1/48000"
        self._timestamp += 960

        # Fill with silence
        for p in frame.planes:
            p.update(bytes(len(p)))

        return frame


async def _wait_for_ice_connected(
    pc1: RTCPeerConnection,
    pc2: RTCPeerConnection,
    label1: str,
    label2: str,
    timeout: int = ICE_TIMEOUT_SECONDS,
) -> bool:
    """
    Wait for either peer to reach ICE "connected" or "completed".
    Logs every state change.

    @param pc1: First peer connection.
    @param pc2: Second peer connection.
    @param label1: Label for pc1 in logs.
    @param label2: Label for pc2 in logs.
    @param timeout: Max seconds to wait.
    @return: True if connected, False if timed out.
    """
    connected_event = asyncio.Event()

    @pc1.on("iceconnectionstatechange")
    async def _on_pc1_ice():
        state = pc1.iceConnectionState
        print(f"    [{label1}] ICE connection state -> {state}")
        if state in ("connected", "completed"):
            connected_event.set()

    @pc2.on("iceconnectionstatechange")
    async def _on_pc2_ice():
        state = pc2.iceConnectionState
        print(f"    [{label2}] ICE connection state -> {state}")
        if state in ("connected", "completed"):
            connected_event.set()

    @pc1.on("icegatheringstatechange")
    async def _on_pc1_gather():
        print(f"    [{label1}] ICE gathering state -> {pc1.iceGatheringState}")

    @pc2.on("icegatheringstatechange")
    async def _on_pc2_gather():
        print(f"    [{label2}] ICE gathering state -> {pc2.iceGatheringState}")

    try:
        await asyncio.wait_for(connected_event.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        print(f"\n    TIMEOUT: ICE did not connect within {timeout}s")
        print(f"    [{label1}] final state: {pc1.iceConnectionState}")
        print(f"    [{label2}] final state: {pc2.iceConnectionState}")
        return False


# ============================================================================
# TEST 1: FETCH METERED CREDENTIALS
# ============================================================================

async def test_1_fetch_credentials() -> list[dict] | None:
    """
    Fetch TURN/STUN credentials from the Metered API.

    @return: List of server dicts, or None on failure.
    """
    _print_header("TEST 1: Fetch Metered Credentials")

    if not METERED_API_KEY:
        print("  ERROR: METERED_API_KEY not set in .env")
        _print_result("Fetch credentials", False)
        return None

    print(f"  API Key: {METERED_API_KEY[:8]}...{METERED_API_KEY[-4:]}")
    print(f"  URL: {METERED_CREDENTIALS_URL}")

    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                METERED_CREDENTIALS_URL,
                params={"apiKey": METERED_API_KEY},
                timeout=10.0,
            )
            response.raise_for_status()
            servers = response.json()
    except Exception as e:
        print(f"  ERROR: {e}")
        _print_result("Fetch credentials", False)
        return None

    print(f"  Received {len(servers)} server(s):\n")
    for i, server in enumerate(servers):
        print(f"    [{i}] {json.dumps(server)}")

    print()
    _print_result("Fetch credentials", len(servers) > 0)
    return servers


# ============================================================================
# TEST 2: TURN ALLOCATION (aioice)
# ============================================================================

async def test_2_turn_allocation(raw_servers: list[dict]) -> bool:
    """
    Use aioice to gather ICE candidates and check for relay candidates.
    This tests whether TURN allocation works at the lower level.

    @param raw_servers: Server dicts from the Metered API.
    @return: True if relay candidates were found.
    """
    _print_header("TEST 2: TURN Allocation (aioice)")

    from aioice import stun, turn  # pyright: ignore[reportMissingImports]
    from aiortc.rtcicetransport import connection_kwargs  # pyright: ignore[reportMissingImports]

    # Build RTCIceServer list
    ice_servers = _build_ice_servers(raw_servers)
    print(f"  ICE servers configured: {len(ice_servers)}")
    for s in ice_servers:
        print(f"    urls={s.urls}, username={s.username or '(none)'}")

    # Convert to aioice kwargs using aiortc's built-in converter
    kwargs = connection_kwargs(ice_servers)
    print(f"\n  aioice connection kwargs:")
    for key, val in kwargs.items():
        print(f"    {key} = {val}")

    # Create an aioice connection and gather candidates
    import aioice  # pyright: ignore[reportMissingImports]
    ice_connection = aioice.Connection(ice_controlling=True, **kwargs)

    print("\n  Gathering ICE candidates ...")
    await ice_connection.gather_candidates()

    candidates = ice_connection.local_candidates
    print(f"  Gathered {len(candidates)} candidate(s):\n")

    has_relay = False
    for c in candidates:
        ctype = c.type
        print(f"    type={ctype} host={c.host} port={c.port} transport={c.transport}")
        if ctype == "relay":
            has_relay = True

    await ice_connection.close()

    print()
    _print_result("Candidates gathered", len(candidates) > 0)
    _print_result("Relay (TURN) candidates found", has_relay)
    return has_relay


# ============================================================================
# TEST 3: PEER-TO-PEER CONNECTION THROUGH TURN (data channel)
# ============================================================================

async def test_3_peer_connection(raw_servers: list[dict]) -> bool:
    """
    Create two RTCPeerConnection instances, exchange SDP, and verify
    ICE reaches "connected" via TURN relay.

    @param raw_servers: Server dicts from the Metered API.
    @return: True if ICE connected.
    """
    _print_header("TEST 3: Peer-to-Peer Connection Through TURN")

    ice_servers = _build_ice_servers(raw_servers)
    config = RTCConfiguration(iceServers=ice_servers)

    client_pc = RTCPeerConnection(configuration=config)
    server_pc = RTCPeerConnection(configuration=config)

    # Track data channel connectivity
    dc_open_event = asyncio.Event()

    # Create data channel on the client side
    dc = client_pc.createDataChannel("test-channel")
    print("  Created data channel 'test-channel' on client peer")

    @dc.on("open")
    def _on_dc_open():
        print("    [client] Data channel opened")
        dc_open_event.set()

    @server_pc.on("datachannel")
    def _on_server_dc(channel):
        print(f"    [server] Received data channel: {channel.label}")

    # Exchange SDP offer/answer
    print("\n  Exchanging SDP offer/answer ...")

    offer = await client_pc.createOffer()
    print(f"    [client] Created offer (type={offer.type})")

    await client_pc.setLocalDescription(offer)
    print("    [client] Set local description")

    await server_pc.setRemoteDescription(client_pc.localDescription)
    print("    [server] Set remote description (client offer)")

    answer = await server_pc.createAnswer()
    print(f"    [server] Created answer (type={answer.type})")

    await server_pc.setLocalDescription(answer)
    print("    [server] Set local description")

    await client_pc.setRemoteDescription(server_pc.localDescription)
    print("    [client] Set remote description (server answer)")

    # Wait for ICE to connect
    print("\n  Waiting for ICE connection ...")
    connected = await _wait_for_ice_connected(
        client_pc, server_pc, "client", "server"
    )

    # Print final states
    print(f"\n  Final ICE states:")
    print(f"    [client] {client_pc.iceConnectionState}")
    print(f"    [server] {server_pc.iceConnectionState}")

    _print_result("ICE connected", connected)

    # Cleanup
    await client_pc.close()
    await server_pc.close()
    return connected


# ============================================================================
# TEST 4: AUDIO TRACK THROUGH TURN
# ============================================================================

async def test_4_audio_track(raw_servers: list[dict]) -> bool:
    """
    Same as Test 3 but adds an audio track. Verifies the remote peer
    receives the track.

    @param raw_servers: Server dicts from the Metered API.
    @return: True if the remote peer received the audio track and ICE connected.
    """
    _print_header("TEST 4: Audio Track Through TURN")

    ice_servers = _build_ice_servers(raw_servers)
    config = RTCConfiguration(iceServers=ice_servers)

    client_pc = RTCPeerConnection(configuration=config)
    server_pc = RTCPeerConnection(configuration=config)

    # Track whether the server received the audio track
    track_received_event = asyncio.Event()
    received_track_kind = None

    @server_pc.on("track")
    def _on_server_track(track):
        nonlocal received_track_kind
        received_track_kind = track.kind
        print(f"    [server] Received track: kind={track.kind}")
        track_received_event.set()

    # Add a dummy audio track on the client side
    audio_track = _DummyAudioTrack()
    client_pc.addTrack(audio_track)
    print("  Added dummy audio track to client peer")

    # Exchange SDP offer/answer
    print("\n  Exchanging SDP offer/answer ...")

    offer = await client_pc.createOffer()
    print(f"    [client] Created offer (type={offer.type})")

    await client_pc.setLocalDescription(offer)
    print("    [client] Set local description")

    await server_pc.setRemoteDescription(client_pc.localDescription)
    print("    [server] Set remote description (client offer)")

    answer = await server_pc.createAnswer()
    print(f"    [server] Created answer (type={answer.type})")

    await server_pc.setLocalDescription(answer)
    print("    [server] Set local description")

    await client_pc.setRemoteDescription(server_pc.localDescription)
    print("    [client] Set remote description (server answer)")

    # Wait for ICE to connect
    print("\n  Waiting for ICE connection ...")
    connected = await _wait_for_ice_connected(
        client_pc, server_pc, "client", "server"
    )

    # Wait for track to be received (only if ICE connected)
    track_received = False
    if connected:
        print("\n  Waiting for audio track to be received ...")
        try:
            await asyncio.wait_for(
                track_received_event.wait(), timeout=TRACK_RECEIVE_TIMEOUT_SECONDS
            )
            track_received = True
        except asyncio.TimeoutError:
            print(f"    TIMEOUT: Track not received within {TRACK_RECEIVE_TIMEOUT_SECONDS}s")

    # Print final states
    print(f"\n  Final ICE states:")
    print(f"    [client] {client_pc.iceConnectionState}")
    print(f"    [server] {server_pc.iceConnectionState}")

    _print_result("ICE connected", connected)
    _print_result("Audio track received", track_received and received_track_kind == "audio")

    # Cleanup
    audio_track.stop()
    await client_pc.close()
    await server_pc.close()
    return connected and track_received


# ============================================================================
# TEST 5: INCOMPLETE OFFER (reproduces the production bug)
# ============================================================================

async def test_5_incomplete_offer(raw_servers: list[dict]) -> bool:
    """
    Reproduce the production bug: browser sends offer BEFORE ICE gathering,
    so the SDP has zero candidates. The server gets an offer with no candidates,
    creates an answer with its own candidates, but has no remote candidates to
    check -- ICE stays at "checking" forever.

    In aiortc, setLocalDescription triggers gathering and blocks until complete.
    To simulate the browser behavior (sending before gathering), we:
    1. Call createOffer() to get the offer object (no candidates yet)
    2. Call setLocalDescription(offer) which gathers candidates and blocks
    3. Pass the ORIGINAL offer (pre-gathering, no candidates) to the server

    This test is EXPECTED TO FAIL (timeout) to prove the bug exists.

    @param raw_servers: Server dicts from the Metered API.
    @return: True if ICE connected (not expected).
    """
    _print_header("TEST 5: Incomplete Offer (reproduces production bug)")

    ice_servers = _build_ice_servers(raw_servers)
    config = RTCConfiguration(iceServers=ice_servers)

    client_pc = RTCPeerConnection(configuration=config)
    server_pc = RTCPeerConnection(configuration=config)

    # Add a dummy audio track to the client side
    audio_track = _DummyAudioTrack()
    client_pc.addTrack(audio_track)
    print("  Added dummy audio track to client peer")

    # Step 1: Create the offer (no candidates yet)
    offer = await client_pc.createOffer()
    print(f"    [client] Created offer (type={offer.type})")

    # Count candidates in the original offer (should be zero)
    original_candidate_count = offer.sdp.count("a=candidate:")
    print(f"    [client] Original offer has {original_candidate_count} ICE candidate(s)")

    # Step 2: Set local description (this triggers gathering and blocks)
    await client_pc.setLocalDescription(offer)
    print("    [client] Set local description (gathering complete)")

    # Count candidates after gathering (should have candidates now)
    gathered_candidate_count = client_pc.localDescription.sdp.count("a=candidate:")
    print(f"    [client] Gathered description has {gathered_candidate_count} ICE candidate(s)")

    # Step 3: Pass the ORIGINAL offer (no candidates) to the server
    # This is exactly what the browser does wrong -- sends createOffer() result
    # before gathering completes
    print("\n  Sending ORIGINAL offer (no candidates) to server ...")
    await server_pc.setRemoteDescription(offer)
    print("    [server] Set remote description (incomplete offer)")

    answer = await server_pc.createAnswer()
    print(f"    [server] Created answer (type={answer.type})")

    await server_pc.setLocalDescription(answer)
    print("    [server] Set local description")

    await client_pc.setRemoteDescription(server_pc.localDescription)
    print("    [client] Set remote description (server answer)")

    # Wait for ICE -- expected to FAIL
    print(f"\n  Waiting for ICE connection (timeout={INCOMPLETE_OFFER_TIMEOUT_SECONDS}s) ...")
    print("  (Expected to FAIL -- the offer had no candidates)")
    connected = await _wait_for_ice_connected(
        client_pc, server_pc, "client", "server",
        timeout=INCOMPLETE_OFFER_TIMEOUT_SECONDS,
    )

    # Print final states
    print(f"\n  Final ICE states:")
    print(f"    [client] {client_pc.iceConnectionState}")
    print(f"    [server] {server_pc.iceConnectionState}")

    if not connected:
        print("\n  WHY THIS FAILS: The offer SDP had no ICE candidates, so the")
        print("  server had no remote candidates to check against. ICE stays at")
        print("  'checking' forever. This is the production bug -- the browser")
        print("  sends createOffer().sdp immediately, before gathering completes.")

    # This test PASSES if the connection FAILS (proving the bug)
    bug_reproduced = not connected
    _print_result("Bug reproduced (ICE failed to connect)", bug_reproduced)

    # Cleanup
    audio_track.stop()
    await client_pc.close()
    await server_pc.close()
    return bug_reproduced


# ============================================================================
# TEST 6: COMPLETE OFFER (the fix)
# ============================================================================

async def test_6_complete_offer(raw_servers: list[dict]) -> bool:
    """
    The fix for the production bug: wait for ICE gathering to complete,
    then send the GATHERED localDescription (which has all candidates)
    to the server instead of the original offer.

    @param raw_servers: Server dicts from the Metered API.
    @return: True if ICE connected.
    """
    _print_header("TEST 6: Complete Offer (the fix)")

    ice_servers = _build_ice_servers(raw_servers)
    config = RTCConfiguration(iceServers=ice_servers)

    client_pc = RTCPeerConnection(configuration=config)
    server_pc = RTCPeerConnection(configuration=config)

    # Add a dummy audio track to the client side
    audio_track = _DummyAudioTrack()
    client_pc.addTrack(audio_track)
    print("  Added dummy audio track to client peer")

    # Step 1: Create the offer
    offer = await client_pc.createOffer()
    print(f"    [client] Created offer (type={offer.type})")

    # Step 2: Set local description (triggers gathering, blocks until complete)
    await client_pc.setLocalDescription(offer)
    print("    [client] Set local description (gathering complete)")

    # Step 3: Use the GATHERED localDescription (with candidates) for the server
    gathered_description = client_pc.localDescription
    candidate_count = gathered_description.sdp.count("a=candidate:")
    print(f"    [client] Gathered description has {candidate_count} ICE candidate(s)")

    print("\n  Sending GATHERED offer (with candidates) to server ...")
    await server_pc.setRemoteDescription(gathered_description)
    print("    [server] Set remote description (complete offer)")

    answer = await server_pc.createAnswer()
    print(f"    [server] Created answer (type={answer.type})")

    await server_pc.setLocalDescription(answer)
    print("    [server] Set local description")

    await client_pc.setRemoteDescription(server_pc.localDescription)
    print("    [client] Set remote description (server answer)")

    # Wait for ICE -- expected to PASS
    print("\n  Waiting for ICE connection ...")
    print("  (Expected to PASS -- the offer has all candidates)")
    connected = await _wait_for_ice_connected(
        client_pc, server_pc, "client", "server"
    )

    # Print final states
    print(f"\n  Final ICE states:")
    print(f"    [client] {client_pc.iceConnectionState}")
    print(f"    [server] {server_pc.iceConnectionState}")

    _print_result("ICE connected (fix works)", connected)

    # Cleanup
    audio_track.stop()
    await client_pc.close()
    await server_pc.close()
    return connected


# ============================================================================
# ENTRY POINT
# ============================================================================

async def main() -> None:
    """Run all six tests in order."""
    print("=" * 60)
    print("  WebRTC TURN Docker Connectivity Test")
    print(f"  Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"  Environment: Docker={os.path.exists('/.dockerenv')}")
    print("=" * 60)

    # Test 1: Fetch credentials
    raw_servers = await test_1_fetch_credentials()
    if raw_servers is None:
        print("\nAborting: could not fetch credentials.")
        sys.exit(1)

    # Test 2: TURN allocation
    has_relay = await test_2_turn_allocation(raw_servers)

    # Test 3: Peer-to-peer data channel
    peer_ok = await test_3_peer_connection(raw_servers)

    # Test 4: Audio track
    audio_ok = await test_4_audio_track(raw_servers)

    # Test 5: Incomplete offer (reproduces the bug)
    bug_reproduced = await test_5_incomplete_offer(raw_servers)

    # Test 6: Complete offer (the fix)
    fix_works = await test_6_complete_offer(raw_servers)

    # Summary
    _print_header("SUMMARY")
    _print_result("Test 1 - Fetch credentials", raw_servers is not None)
    _print_result("Test 2 - TURN allocation (relay candidates)", has_relay)
    _print_result("Test 3 - Peer connection (data channel)", peer_ok)
    _print_result("Test 4 - Audio track exchange", audio_ok)
    _print_result("Test 5 - Incomplete offer (bug reproduced)", bug_reproduced)
    _print_result("Test 6 - Complete offer (fix works)", fix_works)

    all_passed = all([raw_servers, has_relay, peer_ok, audio_ok, bug_reproduced, fix_works])
    print(f"\n  {'ALL TESTS PASSED' if all_passed else 'SOME TESTS FAILED'}")
    print()

    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    asyncio.run(main())
