# Kiro Account Manager (Fork)

Manage Kiro accounts and expose a local, OpenAI/Claude-compatible proxy API with load balancing.

## Highlights
- Local HTTP proxy with `/v1/chat/completions`, `/v1/messages`, and `/v1/models`
- Round-robin account pool with cooldown on failures and automatic recovery
- UI configuration for proxy port and API key
- Uses existing account store and auto-refresh logic

## Quick Start
1. Run the app.
2. In Settings, enable "Local API Proxy", set port and API key.
3. Call the proxy:

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```
