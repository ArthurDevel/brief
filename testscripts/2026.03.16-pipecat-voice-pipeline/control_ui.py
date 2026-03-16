"""
Control UI -- injects a speed slider and cost display above the pipecat dashboard.

Responsibilities:
- Monkey-patch pipecat's server app to add control routes
- Provide a banner with speed slider (left) and session cost display (right)
- Expose /api/session-costs endpoint for the banner to poll after disconnect
"""

import json

from fastapi.responses import HTMLResponse, JSONResponse
from loguru import logger
from starlette.requests import Request


# ============================================================================
# HTML TEMPLATE
# ============================================================================

CONTROL_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Voice Pipeline Control</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .controls {
    display: flex; gap: 32px; align-items: center; justify-content: space-between;
    padding: 16px 24px; background: #16213e; border-bottom: 1px solid #0f3460;
  }
  .control-group { display: flex; align-items: center; gap: 12px; }
  label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #a0a0b8; }
  input[type=range] { width: 180px; accent-color: #e94560; }
  .value { font-size: 14px; font-weight: 700; color: #e94560; min-width: 50px; }
  .cost-display { display: flex; align-items: center; gap: 16px; font-size: 13px; }
  .cost-display .cost-item { color: #a0a0b8; }
  .cost-display .cost-item .amount { color: #4ecca3; font-weight: 700; }
  .cost-display .cost-total { color: #e94560; font-weight: 700; font-size: 14px; }
  .cost-display .cost-pending { color: #a0a0b8; font-style: italic; }
  iframe { width: 100%; height: calc(100vh - 65px); border: none; }
</style>
</head>
<body>
  <div class="controls">
    <div class="control-group">
      <label>Speed</label>
      <input type="range" id="speed" min="1.0" max="1.5" step="0.1" value="SPEED_PLACEHOLDER">
      <span class="value" id="speed-val">SPEED_PLACEHOLDERx</span>
    </div>
    <div class="cost-display" id="cost-display">
      <span class="cost-pending">Costs: --</span>
    </div>
  </div>
  <iframe src="/client/"></iframe>
<script>
  const speedEl = document.getElementById('speed');
  const speedVal = document.getElementById('speed-val');
  const costDisplay = document.getElementById('cost-display');

  // Speed slider
  async function update(key, value) {
    await fetch('/api/audio-config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({[key]: parseFloat(value)}),
    });
  }

  speedEl.addEventListener('input', e => {
    speedVal.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
    update('speed', e.target.value);
  });

  // Cost polling — runs continuously, reacts to session changes
  let lastStatus = null;

  setInterval(async () => {
    try {
      const resp = await fetch('/api/session-costs');
      const data = await resp.json();

      if (data.status === 'pending') {
        if (lastStatus !== 'pending') {
          costDisplay.innerHTML = '<span class="cost-pending">Costs: calculating...</span>';
          lastStatus = 'pending';
        }
        return;
      }

      lastStatus = 'ready';
      costDisplay.innerHTML =
        '<span class="cost-item">LLM: <span class="amount">$' + data.llm.toFixed(4) + '</span></span>' +
        '<span class="cost-item">TTS: <span class="amount">$' + data.tts.toFixed(4) + '</span></span>' +
        '<span class="cost-item">STT: <span class="amount">$' + data.stt.toFixed(4) + '</span></span>' +
        '<span class="cost-total">Total: $' + data.total.toFixed(4) + '</span>' +
        '<span class="cost-item" style="margin-left:8px">≈ <span class="amount">$' + data.cost_per_min.toFixed(4) + '/min</span></span>';
    } catch (e) {}
  }, 2000);
</script>
</body>
</html>"""


# ============================================================================
# ROUTE PATCHING
# ============================================================================

def patch_server_app(shared_state: dict):
    """Monkey-patch pipecat's server app to add control UI, config API, and cost endpoint."""
    import pipecat.runner.run as _pipecat_run

    _orig_create = _pipecat_run._create_server_app

    def _patched_create_server_app(args):
        app = _orig_create(args)

        # Remove the default "/" redirect so ours takes priority
        app.routes[:] = [r for r in app.routes if not (hasattr(r, "path") and r.path == "/")]

        audio_config = shared_state["audio_config"]

        @app.get("/", include_in_schema=False)
        async def control_page():
            html = CONTROL_HTML.replace(
                "SPEED_PLACEHOLDER", str(audio_config["speed"])
            )
            return HTMLResponse(html)

        @app.get("/api/audio-config")
        async def get_audio_config():
            return JSONResponse(audio_config)

        @app.post("/api/audio-config")
        async def set_audio_config(request: Request):
            body = json.loads(await request.body())
            if "speed" in body:
                audio_config["speed"] = float(body["speed"])
            logger.info(f"Audio config updated: {audio_config}")
            return JSONResponse(audio_config)

        @app.get("/api/session-costs")
        async def get_session_costs():
            costs = shared_state.get("session_costs")
            if costs is None:
                return JSONResponse({"status": "pending"})
            return JSONResponse(costs)

        @app.post("/api/session-costs/reset")
        async def reset_session_costs():
            shared_state["session_costs"] = None
            return JSONResponse({"status": "reset"})

        return app

    _pipecat_run._create_server_app = _patched_create_server_app
