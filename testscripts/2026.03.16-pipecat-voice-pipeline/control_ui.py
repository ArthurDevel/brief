"""Control UI — injects speed/low-cut sliders above the pipecat dashboard."""

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
    display: flex; gap: 32px; align-items: center; justify-content: center;
    padding: 16px 24px; background: #16213e; border-bottom: 1px solid #0f3460;
  }
  .control-group { display: flex; align-items: center; gap: 12px; }
  label { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #a0a0b8; }
  input[type=range] { width: 180px; accent-color: #e94560; }
  .value { font-size: 14px; font-weight: 700; color: #e94560; min-width: 50px; }
  iframe { width: 100%; height: calc(100vh - 65px); border: none; }
</style>
</head>
<body>
  <div class="controls">
    <div class="control-group">
      <label>Speed</label>
      <input type="range" id="speed" min="1.0" max="2.5" step="0.1" value="SPEED_PLACEHOLDER">
      <span class="value" id="speed-val">SPEED_PLACEHOLDERx</span>
    </div>
    <div class="control-group">
      <label>Low-cut Hz</label>
      <input type="range" id="lowcut" min="0" max="500" step="10" value="LOWCUT_PLACEHOLDER">
      <span class="value" id="lowcut-val">LOWCUT_PLACEHOLDER Hz</span>
    </div>
  </div>
  <iframe src="/client/"></iframe>
<script>
  const speedEl = document.getElementById('speed');
  const lowcutEl = document.getElementById('lowcut');
  const speedVal = document.getElementById('speed-val');
  const lowcutVal = document.getElementById('lowcut-val');

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
  lowcutEl.addEventListener('input', e => {
    lowcutVal.textContent = e.target.value + ' Hz';
    update('highpass_cutoff', e.target.value);
  });
</script>
</body>
</html>"""


# ============================================================================
# ROUTE PATCHING
# ============================================================================

def patch_server_app(audio_config: dict):
    """Monkey-patch pipecat's server app to add control UI and config API."""
    import pipecat.runner.run as _pipecat_run

    _orig_create = _pipecat_run._create_server_app

    def _patched_create_server_app(args):
        app = _orig_create(args)

        # Remove the default "/" redirect so ours takes priority
        app.routes[:] = [r for r in app.routes if not (hasattr(r, "path") and r.path == "/")]

        @app.get("/", include_in_schema=False)
        async def control_page():
            html = CONTROL_HTML.replace(
                "SPEED_PLACEHOLDER", str(audio_config["speed"])
            ).replace(
                "LOWCUT_PLACEHOLDER", str(int(audio_config["highpass_cutoff"]))
            )
            return HTMLResponse(html)

        @app.get("/api/audio-config")
        async def get_audio_config():
            return JSONResponse(audio_config)

        @app.post("/api/audio-config")
        async def set_audio_config(request: Request):
            body = json.loads(await request.body())
            for key in ("speed", "highpass_cutoff"):
                if key in body:
                    audio_config[key] = float(body[key])
            logger.info(f"Audio config updated: {audio_config}")
            return JSONResponse(audio_config)

        return app

    _pipecat_run._create_server_app = _patched_create_server_app
