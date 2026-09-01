# Local AI Quotation Adapter

The AI quotation workflow supports an Ollama-compatible server on loopback only.
This prevents the setting from becoming a generic server-side request proxy.

`SETUP.bat` runs `scripts/configure-ollama.js`. It detects Ollama in PATH or the
standard Windows installation directory, starts `ollama serve` if necessary,
selects an installed model (preferring `qwen3:4b`) and safely updates `.env`.
When no model is installed it attempts `ollama pull qwen3:4b`; failure leaves AI
disabled without blocking the main OS setup.

Configuration:

```ini
OLLAMA_ENABLED=true
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
```

The model receives only the text pasted by the signed-in user. It must return a
strict JSON draft. The server stores the result with `review_required`; the UI
requires customer selection and lets the user edit descriptions, quantity,
rate, discount and GST before saving. No AI result is automatically sent,
approved or converted into an invoice.

When disabled, unreachable, timed out or malformed, the API returns a real error
and does not create a quotation.
