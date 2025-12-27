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
