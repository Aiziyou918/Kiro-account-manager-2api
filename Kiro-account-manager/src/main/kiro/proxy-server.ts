import http from 'http'
import { URL } from 'url'
import { KiroApiService, KIRO_MODELS, type KiroServiceConfig } from './claude-kiro'

type AccountCredentials = {
  accessToken: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresAt: number
  authMethod?: 'IdC' | 'social'
  provider?: 'BuilderId' | 'Github' | 'Google'
}

type Account = {
  id: string
  email: string
  credentials: AccountCredentials
  status?: string
  lastError?: string
}

type AccountData = {
  accounts?: Record<string, Account>
}

type RefreshResult = {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

type ProxyOptions = {
  port: number
  apiKey?: string
  cooldownMs: number
  refreshBeforeExpiryMs: number
  getAccountData: () => Promise<AccountData | null>
  refreshAccountToken: (account: Account) => Promise<RefreshResult>
  updateAccountCredentials: (id: string, creds: Partial<AccountCredentials>) => Promise<void>
  getAdminData?: () => Promise<{ accounts: Array<{ id: string; email: string; status?: string }>; proxy: { enabled: boolean; port: number; apiKeySet: boolean } }>
  setProxyConfig?: (config: { enabled: boolean; port: number; apiKey?: string }) => Promise<void>
  addAccountFromOidcFiles?: (tokenFile: Record<string, unknown>, clientFile: Record<string, unknown>) => Promise<{ id: string; email: string }>
  deleteAccount?: (id: string) => Promise<void>
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

const DEFAULT_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, x-api-key',
  'access-control-allow-methods': 'GET, POST, OPTIONS'
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, {
    ...DEFAULT_HEADERS,
    'content-type': 'application/json'
  })
  res.end(JSON.stringify(payload))
}

function isAuthorized(req: http.IncomingMessage, apiKey?: string) {
  if (!apiKey) return true
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const headerKey = (req.headers['x-api-key'] as string) || ''
  return token === apiKey || headerKey === apiKey
}

function normalizeTextContent(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('')
  }
  return ''
}

function claudeToOpenAIResponse(claudeMessage: any) {
  const text = normalizeTextContent(claudeMessage?.content ?? [])
  const promptTokens = claudeMessage?.usage?.input_tokens ?? 0
  const completionTokens = claudeMessage?.usage?.output_tokens ?? 0
  return {
    id: claudeMessage?.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: claudeMessage?.model ?? 'claude-opus-4-5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  }
}

function isTokenNearExpiry(expiresAt: number, refreshBeforeExpiryMs: number) {
  return expiresAt && Date.now() + refreshBeforeExpiryMs >= expiresAt
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function splitBuffer(buffer: Buffer, delimiter: Buffer) {
  const parts: Buffer[] = []
  let start = 0
  let index = buffer.indexOf(delimiter, start)
  while (index !== -1) {
    parts.push(buffer.slice(start, index))
    start = index + delimiter.length
    index = buffer.indexOf(delimiter, start)
  }
  parts.push(buffer.slice(start))
  return parts
}

function parseMultipart(body: Buffer, boundary: string) {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = splitBuffer(body, delimiter).slice(1, -1)
  const files: Record<string, { filename: string; content: Buffer; contentType: string }> = {}
  for (const part of parts) {
    const index = part.indexOf(Buffer.from('\r\n\r\n'))
    if (index === -1) continue
    const head = part.slice(0, index).toString('utf8')
    const content = part.slice(index + 4, part.length - 2)
    const nameMatch = /name="([^"]+)"/.exec(head)
    const filenameMatch = /filename="([^"]+)"/.exec(head)
    const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(head)
    if (!nameMatch || !filenameMatch) continue
    files[nameMatch[1]] = {
      filename: filenameMatch[1],
      content,
      contentType: contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream'
    }
  }
  return { files }
}

function renderAdminPage() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kiro Account Manager - Admin</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; background: #0b0f14; color: #e6edf3; }
      h1 { margin: 0 0 16px; }
      .card { background: #111826; border: 1px solid #1f2937; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
      label { display: block; margin: 8px 0 4px; }
      input, button { padding: 8px; border-radius: 6px; border: 1px solid #374151; background: #0f172a; color: #e6edf3; }
      button { cursor: pointer; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td { text-align: left; padding: 8px; border-bottom: 1px solid #1f2937; }
      .row { display: flex; gap: 12px; flex-wrap: wrap; }
      .row > div { flex: 1 1 220px; }
      .muted { color: #9ca3af; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>Kiro Account Manager - Admin</h1>
    <div class="card">
      <h2>API Key</h2>
      <div class="row">
        <div>
          <label>API Key (optional)</label>
          <input id="apiKey" type="password" placeholder="Leave empty if no auth" />
          <div class="muted">Used for admin actions if proxy API key is set.</div>
        </div>
        <div style="align-self:end;">
          <button onclick="saveKey()">Save</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Proxy Config</h2>
      <div class="row">
        <div>
          <label>Enabled</label>
          <input id="proxyEnabled" type="checkbox" />
        </div>
        <div>
          <label>Port</label>
          <input id="proxyPort" type="number" min="1" max="65535" />
        </div>
        <div>
          <label>API Key</label>
          <input id="proxyApiKey" type="password" placeholder="Optional" />
        </div>
        <div style="align-self:end;">
          <button onclick="updateProxy()">Apply</button>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>Accounts</h2>
      <table id="accountsTable">
        <thead>
          <tr><th>Email</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="card">
      <h2>Import OIDC Account</h2>
      <form id="importForm">
        <label>kiro-auth-token.json</label>
        <input type="file" name="tokenFile" accept=".json" />
        <label>Client credentials JSON (same folder)</label>
        <input type="file" name="clientFile" accept=".json" />
        <div style="margin-top:12px;">
          <button type="submit">Import</button>
        </div>
      </form>
      <div id="importResult" class="muted"></div>
    </div>
    <script>
      const apiKeyInput = document.getElementById('apiKey');
      apiKeyInput.value = localStorage.getItem('adminApiKey') || '';
      function saveKey() {
        localStorage.setItem('adminApiKey', apiKeyInput.value || '');
        alert('Saved');
      }
      function headers() {
        const key = localStorage.getItem('adminApiKey');
        return key ? { 'Authorization': 'Bearer ' + key } : {};
      }
      async function loadData() {
        const res = await fetch('/admin/data', { headers: headers() });
        if (!res.ok) return;
        const data = await res.json();
        document.getElementById('proxyEnabled').checked = !!data.proxy.enabled;
        document.getElementById('proxyPort').value = data.proxy.port || 3001;
        document.getElementById('proxyApiKey').value = '';
        const tbody = document.querySelector('#accountsTable tbody');
        tbody.innerHTML = '';
        data.accounts.forEach(acc => {
          const tr = document.createElement('tr');
          tr.innerHTML = '<td>' + (acc.email || 'unknown') + '</td><td>' + (acc.status || '') + '</td><td><button data-id=\"' + acc.id + '\">Delete</button></td>';
          tr.querySelector('button').onclick = async () => {
            await fetch('/admin/account?id=' + encodeURIComponent(acc.id), { method: 'DELETE', headers: headers() });
            await loadData();
          };
          tbody.appendChild(tr);
        });
      }
      async function updateProxy() {
        const payload = {
          enabled: document.getElementById('proxyEnabled').checked,
          port: parseInt(document.getElementById('proxyPort').value, 10),
          apiKey: document.getElementById('proxyApiKey').value
        };
        await fetch('/admin/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(payload) });
        await loadData();
      }
      document.getElementById('importForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const data = new FormData(form);
        const res = await fetch('/admin/account', { method: 'POST', headers: headers(), body: data });
        const text = await res.text();
        document.getElementById('importResult').textContent = text;
        await loadData();
      });
      loadData();
    </script>
  </body>
</html>`;
}

export function startKiroProxyServer(options: ProxyOptions) {
  const {
    port,
    apiKey,
    cooldownMs,
    refreshBeforeExpiryMs,
    getAccountData,
    refreshAccountToken,
    updateAccountCredentials,
    logger = console
  } = options

  const disabledUntil = new Map<string, number>()
  let rrIndex = 0

  const server = http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', DEFAULT_HEADERS['access-control-allow-origin'])
    res.setHeader('access-control-allow-headers', DEFAULT_HEADERS['access-control-allow-headers'])
    res.setHeader('access-control-allow-methods', DEFAULT_HEADERS['access-control-allow-methods'])

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderAdminPage())
      return
    }
    if (req.method === 'GET' && url.pathname === '/admin/data') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      const adminData = options.getAdminData ? await options.getAdminData() : { accounts: [], proxy: { enabled: true, port, apiKeySet: Boolean(apiKey) } }
      return sendJson(res, 200, adminData)
    }
    if (req.method === 'POST' && url.pathname === '/admin/proxy') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      const payload = await parseBody(req)
      if (options.setProxyConfig) {
        await options.setProxyConfig(payload)
      }
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/admin/account') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      if (!options.addAccountFromOidcFiles) {
        return sendJson(res, 400, { error: 'Import not supported' })
      }
      const contentType = req.headers['content-type'] || ''
      const match = /boundary=(.+)$/i.exec(contentType)
      if (!match) {
        return sendJson(res, 400, { error: 'Missing multipart boundary' })
      }
      const buffers: Buffer[] = []
      req.on('data', (chunk) => buffers.push(chunk))
      req.on('end', async () => {
        try {
          const body = Buffer.concat(buffers)
          const { files } = parseMultipart(body, match[1])
          if (!files.tokenFile || !files.clientFile) {
            return sendJson(res, 400, { error: 'Missing files' })
          }
          const tokenJson = JSON.parse(files.tokenFile.content.toString('utf8'))
          const clientJson = JSON.parse(files.clientFile.content.toString('utf8'))
          const result = await options.addAccountFromOidcFiles(tokenJson, clientJson)
          sendJson(res, 200, { ok: true, account: result })
        } catch (error: any) {
          sendJson(res, 500, { error: error.message || 'Import failed' })
        }
      })
      return
    }
    if (req.method === 'DELETE' && url.pathname === '/admin/account') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      if (!options.deleteAccount) {
        return sendJson(res, 400, { error: 'Delete not supported' })
      }
      const id = url.searchParams.get('id')
      if (!id) {
        return sendJson(res, 400, { error: 'Missing id' })
      }
      await options.deleteAccount(id)
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      const data = KIRO_MODELS.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'kiro'
      }))
      return sendJson(res, 200, { object: 'list', data })
    }

    if (req.method !== 'POST') {
      return sendJson(res, 404, { error: 'Not found' })
    }

    if (!isAuthorized(req, apiKey)) {
      return sendJson(res, 401, { error: 'Unauthorized' })
    }

    let requestBody: any
    try {
      requestBody = await parseBody(req)
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' })
    }

    const isOpenAI = url.pathname === '/v1/chat/completions'
    const isClaude = url.pathname === '/v1/messages'
    if (!isOpenAI && !isClaude) {
      return sendJson(res, 404, { error: 'Unsupported endpoint' })
    }

    const accountData = await getAccountData()
    const accounts = Object.entries(accountData?.accounts ?? {})
      .map(([, account]) => account)
      .filter((account) => account.credentials?.refreshToken)

    if (accounts.length === 0) {
      return sendJson(res, 503, { error: 'No accounts available' })
    }

    const now = Date.now()
    const eligible = accounts.filter((account) => {
      const disabled = disabledUntil.get(account.id)
      if (!disabled) return true
      if (disabled <= now) {
        disabledUntil.delete(account.id)
        return true
      }
      return false
    })

    if (eligible.length === 0) {
      return sendJson(res, 503, { error: 'No healthy accounts available' })
    }

    let lastError: string | undefined
    for (let attempt = 0; attempt < eligible.length; attempt++) {
      const account = eligible[rrIndex % eligible.length]
      rrIndex = (rrIndex + 1) % eligible.length

      const creds = account.credentials
      try {
        if (!creds.accessToken || isTokenNearExpiry(creds.expiresAt, refreshBeforeExpiryMs)) {
          const refreshed = await refreshAccountToken(account)
          if (!refreshed.accessToken) {
            throw new Error('Refresh returned no access token')
          }
          const updated: Partial<AccountCredentials> = {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken ?? creds.refreshToken,
            expiresAt: Date.now() + (refreshed.expiresIn ?? 3600) * 1000
          }
          Object.assign(creds, updated)
          await updateAccountCredentials(account.id, updated)
        }

        const kiroConfig: KiroServiceConfig = {
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          authMethod: creds.authMethod,
          region: creds.region || 'us-east-1',
          expiresAt: new Date(creds.expiresAt).toISOString(),
          disableCredentialLoad: true,
          disableAutoRefresh: true
        }

        const kiroService = new KiroApiService(kiroConfig)
        const model = requestBody?.model || 'claude-opus-4-5'

        if (requestBody?.stream) {
          if (isClaude) {
            res.writeHead(200, {
              ...DEFAULT_HEADERS,
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive'
            })
            for await (const chunk of kiroService.generateContentStream(model, requestBody)) {
              const eventType = chunk?.type || 'message'
              res.write(`event: ${eventType}\n`)
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            res.end()
            return
          }

          const claudeMessage = await kiroService.generateContent(model, requestBody)
          const openai = claudeToOpenAIResponse(claudeMessage)
          res.writeHead(200, {
            ...DEFAULT_HEADERS,
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive'
          })
          res.write(`data: ${JSON.stringify(openai)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        const result = await kiroService.generateContent(model, requestBody)
        if (isOpenAI) {
          return sendJson(res, 200, claudeToOpenAIResponse(result))
        }
        return sendJson(res, 200, result)
      } catch (error: any) {
        lastError = error?.message || String(error)
        disabledUntil.set(account.id, Date.now() + cooldownMs)
        logger.warn(`[Proxy] Account ${account.email} failed, cooldown ${cooldownMs}ms: ${lastError}`)
      }
    }

    return sendJson(res, 502, { error: lastError || 'Upstream failure' })
  })

  server.listen(port, '0.0.0.0', () => {
    logger.log(`[Proxy] Kiro API proxy listening on http://0.0.0.0:${port}`)
  })

  return server
}
