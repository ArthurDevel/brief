#!/usr/bin/env python3
"""
Test script for Metered TURN server integration with aiortc.

Diagnoses WebRTC audio connectivity issues when the server runs behind
Docker/Traefik by validating each layer of the ICE/TURN stack:

- Fetching TURN credentials from the Metered API
- Selecting the best STUN and TURN servers (replicating our app logic)
- Raw socket connectivity to the TURN/STUN endpoints
- Full aiortc peer connection with TURN relay candidates

Usage:
    1. Create a .env file in this directory with: METERED_API_KEY=your_key
    2. pip install aiortc httpx python-dotenv
       (or activate the venv: source ../../apps/voice-pipeline/.venv/bin/activate)
    3. python test_turn.py
"""

import asyncio
import json
import os
import socket
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Load .env from the same directory as this script
SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR / ".env")

METERED_API_KEY = os.getenv("METERED_API_KEY")
METERED_CREDENTIALS_URL = "https://0x41.metered.live/api/v1/turn/credentials"

SOCKET_TIMEOUT_SECONDS = 5
ICE_TIMEOUT_SECONDS = 15


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def print_header(title: str) -> None:
    """Print a section header."""
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}\n")


def print_result(label: str, passed: bool) -> None:
    """Print PASS/FAIL for a test."""
    status = "PASS" if passed else "FAIL"
    print(f"  [{status}] {label}")


def select_ice_servers(raw_servers: list[dict]) -> tuple[dict | None, dict | None]:
    """
    Select the best STUN and TURN server from the Metered API response.

    aiortc only uses the first STUN and first TURN server, so we pick:
    - First STUN server found
    - Prefer TURNS over TCP on port 443; fall back to any TURN server

    @param raw_servers: List of server dicts from the Metered API.
    @return: Tuple of (stun_server, turn_server), either may be None.
    """
    stun_server = None
    turn_server = None
    for server in raw_servers:
        raw = server.get("urls") or server.get("url") or ""
        url = raw[0] if isinstance(raw, list) else raw
        if url.startswith("turns:") and "transport=tcp" in url:
            turn_server = server
        elif url.startswith("turn:") and not turn_server:
            turn_server = server
        elif url.startswith("stun:") and not stun_server:
            stun_server = server
    return stun_server, turn_server


def test_tcp_connectivity(host: str, port: int) -> bool:
    """
    Test TCP connectivity to a host:port.

    @param host: Hostname to connect to.
    @param port: Port number.
    @return: True if connection succeeded.
    """
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(SOCKET_TIMEOUT_SECONDS)
        sock.connect((host, port))
        sock.close()
        return True
    except (socket.timeout, socket.error, OSError) as e:
        print(f"    TCP connection to {host}:{port} failed: {e}")
        return False


def test_udp_connectivity(host: str, port: int) -> bool:
    """
    Test UDP connectivity to a host:port by sending a STUN binding request.

    @param host: Hostname to connect to.
    @param port: Port number.
    @return: True if we got a response back.
    """
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(SOCKET_TIMEOUT_SECONDS)
        # Minimal STUN binding request (RFC 5389)
        # Type: 0x0001 (Binding Request), Length: 0, Magic Cookie + Transaction ID
        stun_request = (
            b"\x00\x01"  # Message Type: Binding Request
            b"\x00\x00"  # Message Length: 0
            b"\x21\x12\xa4\x42"  # Magic Cookie
            b"\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c"  # Transaction ID
        )
        resolved = socket.gethostbyname(host)
        sock.sendto(stun_request, (resolved, port))
        data, _ = sock.recvfrom(1024)
        sock.close()
        return len(data) > 0
    except (socket.timeout, socket.error, OSError) as e:
        print(f"    UDP probe to {host}:{port} failed: {e}")
        return False


# ============================================================================
# MAIN TEST LOGIC
# ============================================================================

async def test_1_fetch_credentials() -> list[dict] | None:
    """Fetch TURN credentials from the Metered API and print them."""
    print_header("TEST 1: Fetch Metered API Credentials")

    if not METERED_API_KEY:
        print("  ERROR: METERED_API_KEY not found in .env file")
        print_result("Fetch credentials", False)
        return None

    print(f"  API Key: {METERED_API_KEY[:8]}...{METERED_API_KEY[-4:]}")

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
        print(f"  ERROR: Failed to fetch credentials: {e}")
        print_result("Fetch credentials", False)
        return None

    print(f"  Received {len(servers)} server(s):\n")
    for i, server in enumerate(servers):
        print(f"    [{i}] {json.dumps(server)}")

    print()
    print_result("Fetch credentials", len(servers) > 0)
    return servers


def test_2_server_selection(servers: list[dict]) -> tuple[dict | None, dict | None]:
    """Run server selection logic and verify TURNS/TCP/443 is chosen."""
    print_header("TEST 2: Server Selection Logic")

    stun, turn = select_ice_servers(servers)

    if stun:
        print(f"  Selected STUN: {json.dumps(stun)}")
    else:
        print("  Selected STUN: None")

    if turn:
        print(f"  Selected TURN: {json.dumps(turn)}")
    else:
        print("  Selected TURN: None")

    print()

    # Check that TURNS/TCP/443 was preferred
    turn_url = ""
    if turn:
        raw = turn.get("urls") or turn.get("url") or ""
        turn_url = raw[0] if isinstance(raw, list) else raw

    is_turns_tcp_443 = (
        turn_url.startswith("turns:")
        and "transport=tcp" in turn_url
        and ":443" in turn_url
    )

    print_result("STUN server selected", stun is not None)
    print_result("TURN server selected", turn is not None)
    print_result("TURNS/TCP/443 preferred", is_turns_tcp_443)

    return stun, turn


def test_3_connectivity() -> None:
    """Test raw socket connectivity to the TURN and STUN endpoints."""
    print_header("TEST 3: TURN Server Connectivity")

    # TCP to TURNS relay on 443
    print("  Testing TCP to global.relay.metered.ca:443 ...")
    tcp_ok = test_tcp_connectivity("global.relay.metered.ca", 443)
    print_result("TCP global.relay.metered.ca:443", tcp_ok)

    print()

    # UDP to STUN on 80
    print("  Testing UDP STUN to stun.relay.metered.ca:80 ...")
    udp_ok = test_udp_connectivity("stun.relay.metered.ca", 80)
    print_result("UDP stun.relay.metered.ca:80", udp_ok)


async def test_4_aiortc_turn_allocation(
    stun: dict | None,
    turn: dict | None,
) -> None:
    """
    Create two aiortc peers, exchange offer/answer, and check that
    ICE reaches 'connected' or 'completed'. Prints ICE candidates
    and state transitions.

    @param stun: Selected STUN server dict (or None).
    @param turn: Selected TURN server dict (or None).
    """
    print_header("TEST 4: aiortc TURN Allocation Test")

    try:
        from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer  # pyright: ignore[reportMissingImports]
    except ImportError:
        print("  ERROR: aiortc is not installed. pip install aiortc")
        print_result("aiortc import", False)
        return

    # Build ICE server list
    ice_servers = []
    if stun:
        raw = stun.get("urls") or stun.get("url") or ""
        url = raw[0] if isinstance(raw, list) else raw
        ice_servers.append(RTCIceServer(urls=[url]))
        print(f"  ICE server (STUN): {url}")

    if turn:
        raw = turn.get("urls") or turn.get("url") or ""
        url = raw[0] if isinstance(raw, list) else raw
        username = turn.get("username", "")
        credential = turn.get("credential", "")
        ice_servers.append(
            RTCIceServer(urls=[url], username=username, credential=credential)
        )
        print(f"  ICE server (TURN): {url}")

    if not ice_servers:
        print("  ERROR: No ICE servers available")
        print_result("aiortc TURN allocation", False)
        return

    config = RTCConfiguration(iceServers=ice_servers)

    # Track state transitions and candidates
    browser_states: list[str] = []
    server_states: list[str] = []
    browser_candidates: list[str] = []
    server_candidates: list[str] = []

    browser_pc = RTCPeerConnection(configuration=config)
    server_pc = RTCPeerConnection(configuration=config)

    connected_event = asyncio.Event()

    @browser_pc.on("iceconnectionstatechange")
    async def on_browser_ice_state():
        state = browser_pc.iceConnectionState
        browser_states.append(state)
        print(f"  [browser] ICE state -> {state}")
        if state in ("connected", "completed"):
            connected_event.set()

    @server_pc.on("iceconnectionstatechange")
    async def on_server_ice_state():
        state = server_pc.iceConnectionState
        server_states.append(state)
        print(f"  [server]  ICE state -> {state}")
        if state in ("connected", "completed"):
            connected_event.set()

    @browser_pc.on("icecandidate")
    async def on_browser_candidate(candidate):
        if candidate:
            browser_candidates.append(str(candidate))

    @server_pc.on("icecandidate")
    async def on_server_candidate(candidate):
        if candidate:
            server_candidates.append(str(candidate))

    # Create data channel and exchange offer/answer
    print("\n  Creating data channel and exchanging offer/answer ...\n")
    browser_pc.createDataChannel("test")

    offer = await browser_pc.createOffer()
    await browser_pc.setLocalDescription(offer)
    await server_pc.setRemoteDescription(browser_pc.localDescription)

    answer = await server_pc.createAnswer()
    await server_pc.setLocalDescription(answer)
    await browser_pc.setRemoteDescription(server_pc.localDescription)

    # Wait for connection
    try:
        await asyncio.wait_for(connected_event.wait(), timeout=ICE_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        print(f"\n  TIMEOUT: ICE did not connect within {ICE_TIMEOUT_SECONDS}s")

    # Print gathered candidates
    print(f"\n  Browser ICE candidates ({len(browser_candidates)}):")
    for c in browser_candidates:
        print(f"    {c}")

    print(f"\n  Server ICE candidates ({len(server_candidates)}):")
    for c in server_candidates:
        print(f"    {c}")

    # Check for relay candidates (indicates TURN is working)
    all_candidates = browser_candidates + server_candidates
    has_relay = any("relay" in c.lower() or "typ relay" in c.lower() for c in all_candidates)

    print()
    final_browser = browser_pc.iceConnectionState
    final_server = server_pc.iceConnectionState
    is_connected = final_browser in ("connected", "completed") or final_server in ("connected", "completed")

    print_result("ICE connected", is_connected)
    print_result("Relay (TURN) candidates found", has_relay)

    # Cleanup
    await browser_pc.close()
    await server_pc.close()


# ============================================================================
# ENTRY POINT
# ============================================================================

async def main() -> None:
    """Run all tests sequentially."""
    print("Metered TURN Server Integration Test")
    print(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    # Test 1
    servers = await test_1_fetch_credentials()
    if servers is None:
        print("\nAborting: could not fetch credentials.")
        sys.exit(1)

    # Test 2
    stun, turn = test_2_server_selection(servers)

    # Test 3
    test_3_connectivity()

    # Test 4
    await test_4_aiortc_turn_allocation(stun, turn)

    print(f"\n{'=' * 60}")
    print("  DONE")
    print(f"{'=' * 60}\n")


if __name__ == "__main__":
    asyncio.run(main())
