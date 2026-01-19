import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as http from 'http'
import * as https from 'https'
import { countTokens } from '@anthropic-ai/tokenizer'

const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
  AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_MODEL_NAME: 'claude-opus-4-5',
  AXIOS_TIMEOUT: 300000,
  USER_AGENT: 'KiroIDE',
  KIRO_VERSION: '0.7.5',
  CONTENT_TYPE_JSON: 'application/json',
  ACCEPT_JSON: 'application/json',
  AUTH_METHOD_SOCIAL: 'social',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
} as const

const FULL_MODEL_MAPPING: Record<string, string> = {
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-20251101': 'claude-opus-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-5-20250929': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-20250514': 'CLAUDE_SONNET_4_20250514_V1_0',
  'claude-3-7-sonnet-20250219': 'CLAUDE_3_7_SONNET_20250219_V1_0'
}

export const KIRO_MODELS = Object.keys(FULL_MODEL_MAPPING)
const MODEL_MAPPING = FULL_MODEL_MAPPING
const KIRO_AUTH_TOKEN_FILE = 'kiro-auth-token.json'

function generateMachineIdFromConfig(credentials: {
  uuid?: string
  profileArn?: string
  clientId?: string
}): string {
  const uniqueKey = credentials.uuid || credentials.profileArn || credentials.clientId || 'KIRO_DEFAULT_MACHINE'
  return crypto.createHash('sha256').update(uniqueKey).digest('hex')
}

function getSystemRuntimeInfo(): { osName: string; nodeVersion: string } {
  const osPlatform = os.platform()
  const osRelease = os.release()
  const nodeVersion = process.version.replace('v', '')

  let osName: string = osPlatform
  if (osPlatform === 'win32') osName = `windows#${osRelease}`
  else if (osPlatform === 'darwin') osName = `macos#${osRelease}`
  else osName = `${osPlatform}#${osRelease}`

  return { osName, nodeVersion }
}

function findMatchingBracket(text: string, startPos: number, openChar = '[', closeChar = ']'): number {
  if (!text || startPos >= text.length || text[startPos] !== openChar) {
    return -1
  }

  let bracketCount = 1
  let inString = false
  let escapeNext = false

  for (let i = startPos + 1; i < text.length; i++) {
    const char = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (char === '\\' && inString) {
      escapeNext = true
      continue
    }

    if (char === '"' && !escapeNext) {
      inString = !inString
      continue
    }

    if (!inString) {
      if (char === openChar) {
        bracketCount++
      } else if (char === closeChar) {
        bracketCount--
        if (bracketCount === 0) {
          return i
        }
      }
    }
  }
  return -1
}

function repairJson(jsonStr: string): string {
  let repaired = jsonStr
  repaired = repaired.replace(/,\s*([}\]])/g, '$1')
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":')
  repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"')
  return repaired
}

function parseSingleToolCall(toolCallText: string) {
  const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i
  const nameMatch = toolCallText.match(namePattern)

  if (!nameMatch) {
    return null
  }

  const functionName = nameMatch[1].trim()
  const argsStartMarker = 'with args:'
  const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase())

  if (argsStartPos === -1) {
    return null
  }

  const argsStart = argsStartPos + argsStartMarker.length
  const argsEnd = toolCallText.lastIndexOf(']')

  if (argsEnd <= argsStart) {
    return null
  }

  const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim()

  try {
    const repairedJson = repairJson(jsonCandidate)
    const argumentsObj = JSON.parse(repairedJson)

    if (typeof argumentsObj !== 'object' || argumentsObj === null) {
      return null
    }

    const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`
    return {
      id: toolCallId,
      type: 'function',
      function: {
        name: functionName,
        arguments: JSON.stringify(argumentsObj)
      }
    }
  } catch (e) {
    console.error(`Failed to parse tool call arguments: ${(e as Error).message}`, jsonCandidate)
    return null
  }
}

function parseBracketToolCalls(responseText: string) {
  if (!responseText || !responseText.includes('[Called')) {
    return null
  }

  const toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = []
  const callPositions: number[] = []
  let start = 0
  while (true) {
    const pos = responseText.indexOf('[Called', start)
    if (pos === -1) break
    callPositions.push(pos)
    start = pos + 1
  }

  for (const pos of callPositions) {
    const endPos = findMatchingBracket(responseText, pos, '[', ']')
    if (endPos === -1) continue
    const callText = responseText.substring(pos, endPos + 1)
    const toolCall = parseSingleToolCall(callText)
    if (toolCall) {
      toolCalls.push(toolCall)
    }
  }

  return toolCalls.length > 0 ? toolCalls : null
}

function deduplicateToolCalls(toolCalls: Array<{ function: { name: string; arguments: string } }>) {
  const seen = new Set<string>()
  const uniqueToolCalls: Array<{ function: { name: string; arguments: string } }> = []

  for (const tc of toolCalls) {
    const key = `${tc.function.name}-${tc.function.arguments}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueToolCalls.push(tc)
    }
  }
  return uniqueToolCalls
}

function safeGetTextContent(message: any): string {
  if (message == null) return ''
  if (Array.isArray(message)) {
    return message
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('')
  }
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('')
  }
  return String(message.content || message)
}

export interface KiroServiceConfig {
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  authMethod?: string
  region?: string
  expiresAt?: string
  CRON_NEAR_MINUTES?: number
  KIRO_REFRESH_URL?: string
  KIRO_REFRESH_IDC_URL?: string
  KIRO_BASE_URL?: string
  KIRO_OAUTH_CREDS_FILE_PATH?: string
  KIRO_OAUTH_CREDS_BASE64?: string
  disableCredentialLoad?: boolean
  disableAutoRefresh?: boolean
  useSystemProxy?: boolean
  REQUEST_MAX_RETRIES?: number
  REQUEST_BASE_DELAY?: number
}

export class KiroApiService {
  config: KiroServiceConfig
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  authMethod?: string
  expiresAt?: string
  profileArn?: string
  region?: string
  uuid?: string
  baseUrl?: string
  amazonQUrl?: string
  refreshUrl?: string
  refreshIDCUrl?: string
  modelName: string
  axiosInstance: ReturnType<typeof axios.create> | null
  isInitialized: boolean
  useSystemProxy: boolean
  base64Creds: Record<string, unknown> | null
  credsFilePath?: string
  credPath: string
  disableCredentialLoad: boolean
  disableAutoRefresh: boolean

  constructor(config: KiroServiceConfig) {
    this.config = config
    this.isInitialized = false
    this.useSystemProxy = config.useSystemProxy ?? true
    this.disableCredentialLoad = config.disableCredentialLoad ?? false
    this.disableAutoRefresh = config.disableAutoRefresh ?? false
    this.base64Creds = null
    this.credPath = path.join(os.homedir(), '.aws', 'sso', 'cache')

    if (config.KIRO_OAUTH_CREDS_BASE64) {
      try {
        const decoded = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8')
        this.base64Creds = JSON.parse(decoded)
        console.info('[Kiro] Successfully decoded Base64 credentials in constructor.')
      } catch (error) {
        console.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${(error as Error).message}`)
      }
    } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
      this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH
    }

    this.accessToken = config.accessToken
    this.refreshToken = config.refreshToken
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.authMethod = config.authMethod
    this.region = config.region
    this.expiresAt = config.expiresAt

    this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME
    this.axiosInstance = null
  }

  async initialize() {
    if (this.isInitialized) return
    console.log('[Kiro] Initializing Kiro API Service...')
    await this.initializeAuth()
    const machineId = generateMachineIdFromConfig({
      uuid: this.uuid,
      profileArn: this.profileArn,
      clientId: this.clientId
    })
    const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION
    const { osName, nodeVersion } = getSystemRuntimeInfo()

    const httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
    })
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
    })

    const axiosConfig = {
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
      httpAgent,
      httpsAgent,
      headers: {
        'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
        Accept: KIRO_CONSTANTS.ACCEPT_JSON,
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
        'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
        Connection: 'close'
      }
    }

    if (!this.useSystemProxy) {
      ;(axiosConfig as { proxy?: boolean }).proxy = false
    }

    this.axiosInstance = axios.create(axiosConfig)
    this.isInitialized = true
  }

  async initializeAuth(forceRefresh = false) {
    const hasAccessToken = Boolean(this.accessToken)

    const loadCredentialsFromFile = async (filePath: string) => {
      try {
        const fileContent = await fs.readFile(filePath, 'utf8')
        return JSON.parse(fileContent)
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          console.debug(`[Kiro Auth] Credential file not found: ${filePath}`)
        } else if (error instanceof SyntaxError) {
          console.warn(`[Kiro Auth] Failed to parse JSON from ${filePath}: ${error.message}`)
        } else {
          console.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`)
        }
        return null
      }
    }

    const saveCredentialsToFile = async (filePath: string, newData: Record<string, unknown>) => {
      try {
        let existingData = {}
        try {
          const fileContent = await fs.readFile(filePath, 'utf8')
          existingData = JSON.parse(fileContent)
        } catch (readError: any) {
          if (readError.code === 'ENOENT') {
            console.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`)
          } else {
            console.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`)
          }
        }
        const mergedData = { ...existingData, ...newData }
        await fs.writeFile(filePath, JSON.stringify(mergedData, null, 2), 'utf8')
        console.info(`[Kiro Auth] Updated token file: ${filePath}`)
      } catch (error: any) {
        console.error(`[Kiro Auth] Failed to write token to file ${filePath}: ${error.message}`)
      }
    }

    try {
      let mergedCredentials: Record<string, unknown> = {}

      if (this.base64Creds) {
        Object.assign(mergedCredentials, this.base64Creds)
        console.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).')
        this.base64Creds = null
      }

      if (!this.disableCredentialLoad) {
        const targetFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE)
        const dirPath = path.dirname(targetFilePath)
        const targetFileName = path.basename(targetFilePath)

        console.debug(`[Kiro Auth] Attempting to load credentials from directory: ${dirPath}`)

        try {
          const targetCredentials = await loadCredentialsFromFile(targetFilePath)
          if (targetCredentials) {
            Object.assign(mergedCredentials, targetCredentials)
            console.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`)
          }

          const files = await fs.readdir(dirPath)
          for (const file of files) {
            if (file.endsWith('.json') && file !== targetFileName) {
              const filePath = path.join(dirPath, file)
              const credentials = await loadCredentialsFromFile(filePath)
              if (credentials) {
                ;(credentials as { expiresAt?: string }).expiresAt = (mergedCredentials as { expiresAt?: string })
                  .expiresAt
                Object.assign(mergedCredentials, credentials)
                console.debug(`[Kiro Auth] Loaded Client credentials from ${file}`)
              }
            }
          }
        } catch (error: any) {
          console.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`)
        }
      }

      const merged = mergedCredentials as Record<string, string>
      this.accessToken = this.accessToken || merged.accessToken
      this.refreshToken = this.refreshToken || merged.refreshToken
      this.clientId = this.clientId || merged.clientId
      this.clientSecret = this.clientSecret || merged.clientSecret
      this.authMethod = this.authMethod || merged.authMethod
      this.expiresAt = this.expiresAt || merged.expiresAt
      this.profileArn = this.profileArn || merged.profileArn
      this.region = this.region || merged.region

      if (!this.region) {
        console.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.')
        this.region = 'us-east-1'
      }

      this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace(
        '{{region}}',
        this.region
      )
      this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace(
        '{{region}}',
        this.region
      )
      this.baseUrl = (this.config.KIRO_BASE_URL || KIRO_CONSTANTS.BASE_URL).replace('{{region}}', this.region)
      this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL.replace('{{region}}', this.region)
    } catch (error: any) {
      console.warn(`[Kiro Auth] Error during credential loading: ${error.message}`)
    }

    if (hasAccessToken && !forceRefresh) {
      console.debug('[Kiro Auth] Access token already available and not forced refresh.')
      return
    }

    if (forceRefresh || (!this.accessToken && this.refreshToken)) {
      if (!this.refreshToken) {
        throw new Error('No refresh token available to refresh access token.')
      }
      if (!this.axiosInstance) {
        throw new Error('Kiro axios instance not initialized for refresh.')
      }
      try {
        const requestBody: Record<string, string> = {
          refreshToken: this.refreshToken
        }

        let refreshUrl = this.refreshUrl
        if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
          refreshUrl = this.refreshIDCUrl
          requestBody.clientId = this.clientId || ''
          requestBody.clientSecret = this.clientSecret || ''
          requestBody.grantType = 'refresh_token'
        }
        const response = await this.axiosInstance.post(refreshUrl || '', requestBody)
        console.log('[Kiro Auth] Token refresh response: ok')

        if (response.data && response.data.accessToken) {
          this.accessToken = response.data.accessToken
          this.refreshToken = response.data.refreshToken
          this.profileArn = response.data.profileArn
          const expiresIn = response.data.expiresIn
          const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
          this.expiresAt = expiresAt
          console.info('[Kiro Auth] Access token refreshed successfully')

          const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE)
          const updatedTokenData: Record<string, unknown> = {
            accessToken: this.accessToken,
            refreshToken: this.refreshToken,
            expiresAt: expiresAt
          }
          if (this.profileArn) {
            updatedTokenData.profileArn = this.profileArn
          }
          if (!this.disableCredentialLoad) {
            await saveCredentialsToFile(tokenFilePath, updatedTokenData)
          }
        } else {
          throw new Error('Invalid refresh response: Missing accessToken')
        }
      } catch (error: any) {
        console.error('[Kiro Auth] Token refresh failed:', error.message)
        throw new Error(`Token refresh failed: ${error.message}`)
      }
    }

    if (!this.accessToken) {
      throw new Error('No access token available after initialization and refresh attempts.')
    }
  }

  buildCodewhispererRequest(messages: any[], model: string, tools: any[] | null = null, inSystemPrompt: any = null) {
    const conversationId = uuidv4()
    const systemPrompt = safeGetTextContent(inSystemPrompt)
    const processedMessages = messages

    if (processedMessages.length === 0) {
      throw new Error('No user messages found')
    }

    const lastMessage = processedMessages[processedMessages.length - 1]
    if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
      if (lastMessage.content?.[0]?.type === 'text' && lastMessage.content?.[0]?.text === '{') {
        processedMessages.pop()
      }
    }

    const mergedMessages: any[] = []
    for (let i = 0; i < processedMessages.length; i++) {
      const currentMsg = processedMessages[i]
      if (mergedMessages.length === 0) {
        mergedMessages.push(currentMsg)
      } else {
        const lastMsg = mergedMessages[mergedMessages.length - 1]
        if (currentMsg.role === lastMsg.role) {
          if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
            lastMsg.content.push(...currentMsg.content)
          } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
            lastMsg.content += '\n' + currentMsg.content
          } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
            lastMsg.content.push({ type: 'text', text: currentMsg.content })
          } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
            lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content]
          }
        } else {
          mergedMessages.push(currentMsg)
        }
      }
    }

    processedMessages.length = 0
    processedMessages.push(...mergedMessages)

    const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName]

    let toolsContext: any = {}
    if (tools && Array.isArray(tools) && tools.length > 0) {
      toolsContext = {
        tools: tools.map((tool) => ({
          toolSpecification: {
            name: tool.name || tool.function?.name,
            description: tool.description || tool.function?.description || '',
            inputSchema: { json: tool.input_schema || tool.function?.parameters || {} }
          }
        }))
      }
    }

    const history: any[] = []
    let startIndex = 0

    if (systemPrompt) {
      if (processedMessages[0].role === 'user') {
        const firstUserContent = safeGetTextContent(processedMessages[0])
        history.push({
          userInputMessage: {
            content: `${systemPrompt}

${firstUserContent}`,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
        startIndex = 1
      } else {
        history.push({
          userInputMessage: {
            content: systemPrompt,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
      }
    }

    for (let i = startIndex; i < processedMessages.length - 1; i++) {
      const message = processedMessages[i]
      if (message.role === 'user') {
        const userInputMessage: any = {
          content: '',
          modelId: codewhispererModel,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
        const images: any[] = []
        const toolResults: any[] = []

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text') {
              userInputMessage.content += part.text
            } else if (part.type === 'tool_result') {
              toolResults.push({
                content: [{ text: safeGetTextContent(part.content) }],
                status: 'success',
                toolUseId: part.tool_use_id
              })
            } else if (part.type === 'image') {
              images.push({
                format: part.source.media_type.split('/')[1],
                source: { bytes: part.source.data }
              })
            }
          }
        } else {
          userInputMessage.content = safeGetTextContent(message)
        }

        if (images.length > 0) {
          userInputMessage.images = images
        }

        if (toolResults.length > 0) {
          const uniqueToolResults: any[] = []
          const seenIds = new Set()
          for (const tr of toolResults) {
            if (!seenIds.has(tr.toolUseId)) {
              seenIds.add(tr.toolUseId)
              uniqueToolResults.push(tr)
            }
          }
          userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults }
        }

        history.push({ userInputMessage })
      } else if (message.role === 'assistant') {
        const assistantResponseMessage: any = { content: '' }
        const toolUses: any[] = []

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === 'text') {
              assistantResponseMessage.content += part.text
            } else if (part.type === 'tool_use') {
              toolUses.push({
                input: part.input,
                name: part.name,
                toolUseId: part.id
              })
            }
          }
        } else {
          assistantResponseMessage.content = safeGetTextContent(message)
        }

        if (toolUses.length > 0) {
          assistantResponseMessage.toolUses = toolUses
        }

        history.push({ assistantResponseMessage })
      }
    }

    let currentMessage = processedMessages[processedMessages.length - 1]
    let currentContent = ''
    const currentToolResults: any[] = []
    const currentToolUses: any[] = []
    const currentImages: any[] = []

    if (currentMessage.role === 'assistant') {
      const assistantResponseMessage: any = { content: '', toolUses: [] }
      if (Array.isArray(currentMessage.content)) {
        for (const part of currentMessage.content) {
          if (part.type === 'text') {
            assistantResponseMessage.content += part.text
          } else if (part.type === 'tool_use') {
            assistantResponseMessage.toolUses.push({
              input: part.input,
              name: part.name,
              toolUseId: part.id
            })
          }
        }
      } else {
        assistantResponseMessage.content = safeGetTextContent(currentMessage)
      }
      if (assistantResponseMessage.toolUses.length === 0) {
        delete assistantResponseMessage.toolUses
      }
      history.push({ assistantResponseMessage })
      currentContent = 'Continue'
    } else {
      if (history.length > 0) {
        const lastHistoryItem = history[history.length - 1]
        if (!lastHistoryItem.assistantResponseMessage) {
          history.push({
            assistantResponseMessage: {
              content: 'Continue'
            }
          })
        }
      }

      if (Array.isArray(currentMessage.content)) {
        for (const part of currentMessage.content) {
          if (part.type === 'text') {
            currentContent += part.text
          } else if (part.type === 'tool_result') {
            currentToolResults.push({
              content: [{ text: safeGetTextContent(part.content) }],
              status: 'success',
              toolUseId: part.tool_use_id
            })
          } else if (part.type === 'tool_use') {
            currentToolUses.push({
              input: part.input,
              name: part.name,
              toolUseId: part.id
            })
          } else if (part.type === 'image') {
            currentImages.push({
              format: part.source.media_type.split('/')[1],
              source: { bytes: part.source.data }
            })
          }
        }
      } else {
        currentContent = safeGetTextContent(currentMessage)
      }

      if (!currentContent) {
        currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue'
      }
    }

    const request: any = {
      conversationState: {
        chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
        conversationId,
        currentMessage: {}
      }
    }

    if (history.length > 0) {
      request.conversationState.history = history
    }

    const userInputMessage: any = {
      content: currentContent,
      modelId: codewhispererModel,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
    }

    if (currentImages.length > 0) {
      userInputMessage.images = currentImages
    }

    const userInputMessageContext: any = {}
    if (currentToolResults.length > 0) {
      const uniqueToolResults: any[] = []
      const seenToolUseIds = new Set()
      for (const tr of currentToolResults) {
        if (!seenToolUseIds.has(tr.toolUseId)) {
          seenToolUseIds.add(tr.toolUseId)
          uniqueToolResults.push(tr)
        }
      }
      userInputMessageContext.toolResults = uniqueToolResults
    }
    if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
      userInputMessageContext.tools = toolsContext.tools
    }
    if (Object.keys(userInputMessageContext).length > 0) {
      userInputMessage.userInputMessageContext = userInputMessageContext
    }

    request.conversationState.currentMessage.userInputMessage = userInputMessage

    if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
      request.profileArn = this.profileArn
    }

    return request
  }

  parseEventStreamChunk(rawData: any) {
    const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData)
    let fullContent = ''
    const toolCalls: any[] = []
    let currentToolCallDict: any = null

    const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g
    const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs

    let matches = [...rawStr.matchAll(sseEventRegex)]
    if (matches.length === 0) {
      matches = [...rawStr.matchAll(legacyEventRegex)]
    }

    for (const match of matches) {
      const potentialJsonBlock = match[1]
      if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
        continue
      }

      let searchPos = 0
      while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
        const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim()
        try {
          const eventData: any = JSON.parse(jsonCandidate)

          if (eventData.name && eventData.toolUseId) {
            if (!currentToolCallDict) {
              currentToolCallDict = {
                id: eventData.toolUseId,
                type: 'function',
                function: {
                  name: eventData.name,
                  arguments: ''
                }
              }
            }
            if (eventData.input) {
              currentToolCallDict.function.arguments += eventData.input
            }
            if (eventData.stop) {
              try {
                const args = JSON.parse(currentToolCallDict.function.arguments)
                currentToolCallDict.function.arguments = JSON.stringify(args)
              } catch {
                console.warn('[Kiro] Tool call arguments not valid JSON')
              }
              toolCalls.push(currentToolCallDict)
              currentToolCallDict = null
            }
          } else if (!eventData.followupPrompt && eventData.content) {
            let decodedContent = eventData.content
            decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n')
            fullContent += decodedContent
          }
          break
        } catch {
          continue
        }
      }
    }

    if (currentToolCallDict) {
      toolCalls.push(currentToolCallDict)
    }

    const bracketToolCalls = parseBracketToolCalls(fullContent)
    if (bracketToolCalls) {
      toolCalls.push(...bracketToolCalls)
    }

    return { content: fullContent, toolCalls }
  }

  _processApiResponse(response: any) {
    const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data)

    const parsedFromEvents = this.parseEventStreamChunk(rawResponseText)
    let fullResponseText = parsedFromEvents.content
    const allToolCalls = [...parsedFromEvents.toolCalls]

    const rawBracketToolCalls = parseBracketToolCalls(rawResponseText)
    if (rawBracketToolCalls) {
      allToolCalls.push(...rawBracketToolCalls)
    }

    const uniqueToolCalls = deduplicateToolCalls(allToolCalls)

    if (uniqueToolCalls.length > 0) {
      for (const tc of uniqueToolCalls) {
        const funcName = tc.function.name
        const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*?(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs')
        fullResponseText = fullResponseText.replace(pattern, '')
      }
      fullResponseText = fullResponseText.replace(/\s+/g, ' ').trim()
    }

    return { responseText: fullResponseText, toolCalls: uniqueToolCalls }
  }

  estimateInputTokens(requestBody: any): number {
    let totalTokens = 0
    if (requestBody.system) {
      const systemText = safeGetTextContent(requestBody.system)
      totalTokens += this.countTextTokens(systemText)
    }
    if (requestBody.messages && Array.isArray(requestBody.messages)) {
      for (const message of requestBody.messages) {
        if (message.content) {
          const contentText = safeGetTextContent(message)
          totalTokens += this.countTextTokens(contentText)
        }
      }
    }
    if (requestBody.tools && Array.isArray(requestBody.tools)) {
      totalTokens += this.countTextTokens(JSON.stringify(requestBody.tools))
    }
    return totalTokens
  }

  async callApi(method: string, model: string, body: any, isRetry = false, retryCount = 0): Promise<string> {
    if (!this.isInitialized) await this.initialize()

    const requestData = this.buildCodewhispererRequest(body.messages, model, body.tools, body.system)
    const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl

    try {
      const token = this.accessToken
      const headers = {
        Authorization: `Bearer ${token}`,
        'amz-sdk-invocation-id': uuidv4()
      }
      const response = await (this.axiosInstance as ReturnType<typeof axios.create>).request({
        method,
        url: requestUrl,
        data: requestData,
        headers
      })
      return response.data
    } catch (error: any) {
      if (error.response?.status === 403 && !isRetry) {
        console.log('[Kiro] Received 403. Attempting token refresh and retrying...')
        try {
          await this.initializeAuth(true)
        } catch (refreshError: any) {
          console.error('[Kiro] Token refresh failed during 403 retry:', refreshError.message)
          throw refreshError
        }
        return this.callApi(method, model, body, true, retryCount)
      }

      const maxRetries = 3
      if (
        (error.response?.status === 429 || error.response?.status >= 500) &&
        retryCount < maxRetries
      ) {
        const delay = 1000 * Math.pow(2, retryCount)
        await new Promise((resolve) => setTimeout(resolve, delay))
        return this.callApi(method, model, body, isRetry, retryCount + 1)
      }
      throw error
    }
  }

  async generateContent(model: string, requestBody: any) {
    if (!this.isInitialized) await this.initialize()
    if (!this.disableAutoRefresh && this.isExpiryDateNear()) {
      await this.initializeAuth(true)
    }

    const finalModel = MODEL_MAPPING[model] ? model : this.modelName
    const inputTokens = this.estimateInputTokens(requestBody)
    const response = await this.callApi('POST', finalModel, requestBody)
    const { responseText, toolCalls } = this._processApiResponse(response)
    return this.buildClaudeResponse(responseText, false, 'assistant', model, toolCalls, inputTokens)
  }



  parseAwsEventStreamBuffer(buffer: string) {
    const events: Array<{ type: string; data?: any }> = []
    let remaining = buffer
    let searchStart = 0

    while (true) {
      const contentStart = remaining.indexOf('{"content":', searchStart)
      const nameStart = remaining.indexOf('{"name":', searchStart)
      const followupStart = remaining.indexOf('{"followupPrompt":', searchStart)
      const inputStart = remaining.indexOf('{"input":', searchStart)
      const stopStart = remaining.indexOf('{"stop":', searchStart)

      const candidates = [contentStart, nameStart, followupStart, inputStart, stopStart].filter((pos) => pos >= 0)
      if (candidates.length === 0) break

      const jsonStart = Math.min(...candidates)
      if (jsonStart < 0) break

      let braceCount = 0
      let jsonEnd = -1
      let inString = false
      let escapeNext = false

      for (let i = jsonStart; i < remaining.length; i++) {
        const char = remaining[i]

        if (escapeNext) {
          escapeNext = false
          continue
        }

        if (char === '\\') {
          escapeNext = true
          continue
        }

        if (char === '"') {
          inString = !inString
          continue
        }

        if (!inString) {
          if (char === '{') {
            braceCount++
          } else if (char === '}') {
            braceCount--
            if (braceCount === 0) {
              jsonEnd = i
              break
            }
          }
        }
      }

      if (jsonEnd < 0) {
        remaining = remaining.substring(jsonStart)
        break
      }

      const jsonStr = remaining.substring(jsonStart, jsonEnd + 1)
      try {
        const parsed = JSON.parse(jsonStr)
        if (parsed.content !== undefined && !parsed.followupPrompt) {
          events.push({ type: 'content', data: parsed.content })
        } else if (parsed.name && parsed.toolUseId) {
          events.push({
            type: 'toolUse',
            data: {
              name: parsed.name,
              toolUseId: parsed.toolUseId,
              input: parsed.input || '',
              stop: parsed.stop || false
            }
          })
        } else if (parsed.input !== undefined && !parsed.name) {
          events.push({
            type: 'toolUseInput',
            data: {
              input: parsed.input
            }
          })
        } else if (parsed.stop !== undefined) {
          events.push({
            type: 'toolUseStop',
            data: {
              stop: parsed.stop
            }
          })
        }
      } catch {
        // ignore parse errors
      }

      searchStart = jsonEnd + 1
      if (searchStart >= remaining.length) {
        remaining = ''
        break
      }
    }

    if (searchStart > 0 && remaining.length > 0) {
      remaining = remaining.substring(searchStart)
    }

    return { events, remaining }
  }

  async *streamApiReal(method: string, model: string, body: any, isRetry = false, retryCount = 0) {
    if (!this.isInitialized) await this.initialize()
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1000

    const requestData = this.buildCodewhispererRequest(body.messages, model, body.tools, body.system)

    const token = this.accessToken
    const headers = {
      Authorization: `Bearer ${token}`,
      'amz-sdk-invocation-id': uuidv4()
    }

    const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl

    let stream: any = null
    try {
      const response = await (this.axiosInstance as ReturnType<typeof axios.create>).request({
        method,
        url: requestUrl,
        data: requestData,
        headers,
        responseType: 'stream'
      })

      stream = response.data
      let buffer = ''
      let lastContentEvent: string | null = null

      for await (const chunk of stream) {
        buffer += chunk.toString()

        const { events, remaining } = this.parseAwsEventStreamBuffer(buffer)
        buffer = remaining

        for (const event of events) {
          if (event.type === 'content' && event.data) {
            if (lastContentEvent === event.data) {
              continue
            }
            lastContentEvent = event.data
            yield { type: 'content', content: event.data }
          } else if (event.type === 'toolUse') {
            yield { type: 'toolUse', toolUse: event.data }
          } else if (event.type === 'toolUseInput') {
            yield { type: 'toolUseInput', input: event.data?.input }
          } else if (event.type === 'toolUseStop') {
            yield { type: 'toolUseStop', stop: event.data?.stop }
          }
        }
      }
    } catch (error: any) {
      if (stream && typeof stream.destroy === 'function') {
        stream.destroy()
      }

      if (error.response?.status === 403 && !isRetry) {
        console.log('[Kiro] Received 403 in stream. Attempting token refresh and retrying...')
        await this.initializeAuth(true)
        yield* this.streamApiReal(method, model, body, true, retryCount)
        return
      }

      if (error.response?.status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount)
        console.log(`[Kiro] Received 429 in stream. Retrying in ${delay}ms...`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1)
        return
      }

      console.error('[Kiro] Stream API call failed:', error.message)
      throw error
    } finally {
      if (stream && typeof stream.destroy === 'function') {
        stream.destroy()
      }
    }
  }

  async *generateContentStream(model: string, requestBody: any) {
    if (!this.isInitialized) await this.initialize()
    if (!this.disableAutoRefresh && this.isExpiryDateNear()) {
      await this.initializeAuth(true)
    }

    const finalModel = MODEL_MAPPING[model] ? model : this.modelName
    const inputTokens = this.estimateInputTokens(requestBody)
    const messageId = uuidv4()

    let totalContent = ''
    const toolCalls: Array<{ toolUseId: string; name: string; input: any }> = []
    let currentToolCall: { toolUseId: string; name: string; input: string } | null = null
    let streamStarted = false

    for await (const event of this.streamApiReal('POST', finalModel, requestBody)) {
      if (!streamStarted) {
        streamStarted = true
        yield {
          type: 'message_start',
          message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            model: model,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
            content: []
          }
        }
        yield {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        }
      }

      if (event.type === 'content' && event.content) {
        totalContent += event.content
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: event.content }
        }
      } else if (event.type === 'toolUse') {
        const tc = event.toolUse
        if (tc?.name && tc?.toolUseId) {
          if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
            currentToolCall.input += tc.input || ''
          } else {
            if (currentToolCall) {
              try {
                currentToolCall.input = JSON.parse(currentToolCall.input)
              } catch {
                // keep raw input
              }
              toolCalls.push(currentToolCall as any)
            }
            currentToolCall = {
              toolUseId: tc.toolUseId,
              name: tc.name,
              input: tc.input || ''
            }
          }
          if (tc.stop) {
            try {
              currentToolCall.input = JSON.parse(currentToolCall.input)
            } catch {
              // keep raw input
            }
            toolCalls.push(currentToolCall as any)
            currentToolCall = null
          }
        }
      } else if (event.type === 'toolUseInput') {
        if (currentToolCall) {
          currentToolCall.input += event.input || ''
        }
      } else if (event.type === 'toolUseStop') {
        if (currentToolCall && event.stop) {
          try {
            currentToolCall.input = JSON.parse(currentToolCall.input)
          } catch {
            // keep raw input
          }
          toolCalls.push(currentToolCall as any)
          currentToolCall = null
        }
      }
    }

    if (currentToolCall) {
      try {
        currentToolCall.input = JSON.parse(currentToolCall.input)
      } catch {
        // keep raw input
      }
      toolCalls.push(currentToolCall as any)
      currentToolCall = null
    }

    const bracketToolCalls = parseBracketToolCalls(totalContent)
    if (bracketToolCalls && bracketToolCalls.length > 0) {
      for (const btc of bracketToolCalls) {
        toolCalls.push({
          toolUseId: btc.id || `tool_${uuidv4()}`,
          name: btc.function.name,
          input: JSON.parse(btc.function.arguments || '{}')
        })
      }
    }

    yield { type: 'content_block_stop', index: 0 }

    if (toolCalls.length > 0) {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const blockIndex = i + 1

        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: tc.toolUseId || `tool_${uuidv4()}`,
            name: tc.name,
            input: {}
          }
        }

        yield {
          type: 'content_block_delta',
          index: blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {})
          }
        }

        yield { type: 'content_block_stop', index: blockIndex }
      }
    }

    let outputTokens = this.countTextTokens(totalContent)
    for (const tc of toolCalls) {
      outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}))
    }

    yield {
      type: 'message_delta',
      delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn' },
      usage: { output_tokens: outputTokens }
    }

    yield { type: 'message_stop' }
  }


  buildClaudeResponse(
    content: string,
    isStream = false,
    role = 'assistant',
    model: string,
    toolCalls: any[] | null = null,
    inputTokens = 0
  ) {
    const messageId = uuidv4()
    const contentArray = [
      {
        type: 'text',
        text: content
      }
    ]

    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        contentArray.push({
          type: 'tool_use',
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments)
        } as any)
      }
    }

    const outputTokens = this.countTextTokens(content)

    if (isStream) {
      return {
        id: messageId,
        type: 'message',
        role: role,
        model: model,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        },
        content: contentArray
      }
    }

    return {
      id: messageId,
      type: 'message',
      role: role,
      model: model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      },
      content: contentArray
    }
  }

  countTextTokens(text: string): number {
    try {
      return countTokens(text)
    } catch (error: any) {
      const avgCharsPerToken = 4
      return Math.ceil(text.length / avgCharsPerToken)
    }
  }

  calculateInputTokens(requestBody: any): number {
    const systemPrompt = safeGetTextContent(requestBody.system)
    let totalTokens = this.countTextTokens(systemPrompt)

    if (Array.isArray(requestBody.messages)) {
      for (const msg of requestBody.messages) {
        const text = safeGetTextContent(msg)
        totalTokens += this.countTextTokens(text)
      }
    }

    if (Array.isArray(requestBody.tools)) {
      totalTokens += this.countTextTokens(JSON.stringify(requestBody.tools))
    }

    return totalTokens
  }

  isExpiryDateNear(): boolean {
    try {
      if (!this.expiresAt) return false
      const expirationTime = new Date(this.expiresAt)
      const currentTime = new Date()
      const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000
      const thresholdTime = new Date(currentTime.getTime() + cronNearMinutesInMillis)
      return expirationTime.getTime() <= thresholdTime.getTime()
    } catch (error: any) {
      console.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`)
      return false
    }
  }

  async getUsageLimits() {
    if (!this.isInitialized) await this.initialize()

    if (!this.disableAutoRefresh && this.isExpiryDateNear()) {
      await this.initializeAuth(true)
    }

    const resourceType = 'AGENTIC_REQUEST'
    const usageLimitsUrl = KIRO_CONSTANTS.USAGE_LIMITS_URL.replace('{{region}}', this.region || 'us-east-1')
    const params = new URLSearchParams({
      isEmailRequired: 'true',
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
      resourceType: resourceType
    })
    if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
      params.append('profileArn', this.profileArn)
    }
    const fullUrl = `${usageLimitsUrl}?${params.toString()}`

    const machineId = generateMachineIdFromConfig({
      uuid: this.uuid,
      profileArn: this.profileArn,
      clientId: this.clientId
    })
    const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION
    const { osName, nodeVersion } = getSystemRuntimeInfo()

    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
      'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
      'amz-sdk-invocation-id': uuidv4(),
      'amz-sdk-request': 'attempt=1; max=1',
      Connection: 'close'
    }

    try {
      const response = await (this.axiosInstance as ReturnType<typeof axios.create>).get(fullUrl, { headers })
      return response.data
    } catch (error: any) {
      if (error.response?.status === 403) {
        try {
          await this.initializeAuth(true)
          headers.Authorization = `Bearer ${this.accessToken}`
          headers['amz-sdk-invocation-id'] = uuidv4()
          const retryResponse = await (this.axiosInstance as ReturnType<typeof axios.create>).get(fullUrl, {
            headers
          })
          return retryResponse.data
        } catch (refreshError: any) {
          throw refreshError
        }
      }
      throw error
    }
  }
}
