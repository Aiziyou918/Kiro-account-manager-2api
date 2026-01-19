import http from 'http'
import { URL } from 'url'
import { KiroApiService, KIRO_MODELS, type KiroServiceConfig } from './claude-kiro'

// =========================================================================
// 支持的媒体类型
// =========================================================================

const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
]

const SUPPORTED_DOCUMENT_TYPES = [
  'application/pdf',
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/xml',
  'text/markdown',
  'text/x-python',
  'text/javascript',
  'application/json',
  'application/xml',
  'application/javascript'
]

const BASH_DESCRIPTION = "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.\n\nIMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location\n   - For example, before running \"mkdir foo/bar\", first use `ls foo` to check that \"foo\" exists and is the intended parent directory\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes (e.g., cd \"path with spaces/file.txt\")\n   - Examples of proper quoting:\n     - cd \"/Users/name/My Documents\" (correct)\n     - cd /Users/name/My Documents (incorrect - will fail)\n     - python \"/path/with spaces/script.py\" (correct)\n     - python /path/with spaces/script.py (incorrect - will fail)\n   - After ensuring proper quoting, execute the command.\n   - Capture the output of the command.\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), add enough context to clarify what it does.\n  - If the output exceeds 30000 characters, output will be truncated before being returned to you.\n  - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.\n  \n  - Avoid using Bash with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:\n    - File search: Use Glob (NOT find or ls)\n    - Content search: Use Grep (NOT grep or rg)\n    - Read files: Use Read (NOT cat/head/tail)\n    - Edit files: Use Edit (NOT sed/awk)\n    - Write files: Use Write (NOT echo >/cat <<EOF)\n    - Communication: Output text directly (NOT echo/printf)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run \"git status\" and \"git diff\", send a single message with two Bash tool calls in parallel.\n    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.\n    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)\n  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.\n    <good-example>\n    pytest /foo/bar/tests\n    </good-example>\n    <bad-example>\n    cd /foo/bar && pytest tests\n    </bad-example>\n\n# Committing changes with git\n\nOnly create commits when requested by the user. If unclear, ask first. When the user asks you to create a new git commit, follow these steps carefully:\n\nGit Safety Protocol:\n- NEVER update the git config\n- NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them\n- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it\n- NEVER run force push to main/master, warn the user if they request it\n- Avoid git commit --amend. ONLY use --amend when ALL conditions are met:\n  (1) User explicitly requested amend, OR commit SUCCEEDED but pre-commit hook auto-modified files that need including\n  (2) HEAD commit was created by you in this conversation (verify: git log -1 --format='%an %ae')\n  (3) Commit has NOT been pushed to remote (verify: git status shows \"Your branch is ahead\")\n- CRITICAL: If commit FAILED or was REJECTED by hook, NEVER amend - fix the issue and create a NEW commit\n- CRITICAL: If you already pushed to remote, NEVER amend unless user explicitly requests it (requires force push)\n- NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel, each using the Bash tool:\n  - Run a git status command to see all untracked files. IMPORTANT: Never use the -uall flag as it can cause memory issues on large repos.\n  - Run a git diff command to see both staged and unstaged changes that will be committed.\n  - Run a git log command to see recent commit messages, so that you can follow this repository's commit message style.\n2. Analyze all staged changes (both previously staged and newly added) and draft a commit message:\n  - Summarize the nature of the changes (eg. new feature, enhancement to an existing feature, bug fix, refactoring, test, docs, etc.). Ensure the message accurately reflects the changes and their purpose (i.e. \"add\" means a wholly new feature, \"update\" means an enhancement to an existing feature, \"fix\" means a bug fix, etc.).\n  - Do not commit files that likely contain secrets (.env, credentials.json, etc). Warn the user if they specifically request to commit those files\n  - Draft a concise (1-2 sentences) commit message that focuses on the \"why\" rather than the \"what\"\n  - Ensure it accurately reflects the changes and their purpose\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands:\n   - Add relevant untracked files to the staging area.\n   - Run git status after the commit completes to verify success.\n   Note: git status depends on the commit completing, so run it sequentially after the commit.\n4. If the commit fails due to pre-commit hook, fix the issue and create a NEW commit (see amend rules above)\n\nImportant notes:\n- NEVER run additional commands to read or explore code, besides git bash commands\n- NEVER use the TodoWrite or Task tools\n- DO NOT push to the remote repository unless the user explicitly asks you to do so\n- IMPORTANT: Never use git commands with the -i flag (like git rebase -i or git add -i) since they require interactive input which is not supported.\n- If there are no changes to commit (i.e., no untracked files and no modifications), do not create an empty commit\n- In order to ensure good formatting, ALWAYS pass the commit message via a HEREDOC, a la this example:\n<example>\ngit commit -m \"$(cat <<'EOF'\n   Commit message here.\n   EOF\n   )\"\n</example>\n\n# Creating pull requests\nUse the gh command via the Bash tool for ALL GitHub-related tasks including working with issues, pull requests, checks, and releases. If given a Github URL use the gh command to get the information needed.\n\nIMPORTANT: When the user asks you to create a pull request, follow these steps carefully:\n\n1. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following bash commands in parallel using the Bash tool, in order to understand the current state of the branch since it diverged from the main branch:\n   - Run a git status command to see all untracked files (never use -uall flag)\n   - Run a git diff command to see both staged and unstaged changes that will be committed\n   - Check if the current branch tracks a remote branch and is up to date with the remote, so you know if you need to push to the remote\n   - Run a git log command and `git diff [base-branch]...HEAD` to understand the full commit history for the current branch (from the time it diverged from the base branch)\n2. Analyze all changes that will be included in the pull request, making sure to look at all relevant commits (NOT just the latest commit, but ALL commits that will be included in the pull request!!!), and draft a pull request summary\n3. You can call multiple tools in a single response. When multiple independent pieces of information are requested and all commands are likely to succeed, run multiple tool calls in parallel for optimal performance. run the following commands in parallel:\n   - Create new branch if needed\n   - Push to remote with -u flag if needed\n   - Create PR using gh pr create with the format below. Use a HEREDOC to pass the body to ensure correct formatting.\n<example>\ngh pr create --title \"the pr title\" --body \"$(cat <<'EOF'\n## Summary\n<1-3 bullet points>\n\n## Test plan\n[Bulleted markdown checklist of TODOs for testing the pull request...]\nEOF\n)\"\n</example>\n\nImportant:\n- DO NOT use the TodoWrite or Task tools\n- Return the PR URL when you're done, so the user can see it\n\n# Other common operations\n- View comments on a Github PR: gh api repos/foo/bar/pulls/123/comments";
// =========================================================================
// Claude Code 工具过滤 - 简化 tool descriptions 以绕过 Kiro 检测
// =========================================================================

/**
 * 安全的工具描述映射表
 * Kiro 会检测 Claude Code 的超长 tool descriptions，这里提供简化版本
 */
const SAFE_TOOL_DESCRIPTIONS: Record<string, string> = {
  'Bash': BASH_DESCRIPTION
}

/**
 * 判断是否为支持的图片类型
 */
function isImageType(mediaType: string): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(mediaType)
}

/**
 * 判断是否为支持的文档类型
 */
function isDocumentType(mediaType: string): boolean {
  return SUPPORTED_DOCUMENT_TYPES.includes(mediaType)
}

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
  quotaExhaustedUntil?: number
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
  updateAccountStatus?: (id: string, updates: { status?: string; lastError?: string; quotaExhaustedUntil?: number | null }) => Promise<void>
  getAdminData?: () => Promise<{ accounts: Array<{ id: string; email: string; status?: string }>; proxy: { enabled: boolean; port: number; apiKeySet: boolean } }>
  setProxyConfig?: (config: { enabled: boolean; port: number; apiKey?: string }) => Promise<void>
  addAccountFromOidcFiles?: (tokenFile: Record<string, unknown>, clientFile: Record<string, unknown>) => Promise<{ id: string; email: string }>
  deleteAccount?: (id: string) => Promise<void>
  refreshUsageForAvailableAccounts?: () => Promise<{ updated: number; failed: number; total: number }>
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

// =========================================================================
// 多模态内容处理函数
// =========================================================================

/**
 * 将 OpenAI 格式的消息内容转换为 Claude 格式
 * 支持: text, image_url (仅 base64), image, file, document
 * 不支持: URL 图片（需客户端先转为 base64）
 */
function convertOpenAIContentToClaude(content: any): any[] {
  if (!content) return []

  // 字符串直接转为 text 块
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content.trim() }] : []
  }

  if (!Array.isArray(content)) return []

  const claudeContent: any[] = []

  for (const item of content) {
    if (!item) continue

    switch (item.type) {
      case 'text':
        if (item.text?.trim()) {
          const textBlock: any = { type: 'text', text: item.text.trim() }
          // 支持缓存控制
          if (item.cache_control) {
            textBlock.cache_control = item.cache_control
          }
          claudeContent.push(textBlock)
        }
        break

      case 'image_url':
        if (item.image_url) {
          const imageUrl = typeof item.image_url === 'string'
            ? item.image_url
            : item.image_url.url

          if (imageUrl?.startsWith('data:')) {
            // Base64 格式: data:image/jpeg;base64,/9j/4AAQ...
            const [header, data] = imageUrl.split(',')
            const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
            const imageBlock: any = {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: data
              }
            }
            if (item.cache_control) {
              imageBlock.cache_control = item.cache_control
            }
            claudeContent.push(imageBlock)
          } else if (imageUrl) {
            // URL 格式不支持，提示用户转为 base64
            claudeContent.push({
              type: 'text',
              text: `[Error: URL images not supported. Please convert to base64 first: ${imageUrl}]`
            })
          }
        }
        break

      case 'image':
        // 已经是 Claude 格式，直接保留
        if (item.source) {
          claudeContent.push(item)
        }
        break

      case 'file':
      case 'document':
        // 文件/文档类型（PDF、文本等）
        if (item.file || item.source) {
          const fileData = item.file || item.source

          if (fileData.type === 'base64' || fileData.data) {
            const mediaType = fileData.media_type || fileData.mime_type || 'application/octet-stream'

            if (isImageType(mediaType)) {
              // 图片类型
              const imageBlock: any = {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: fileData.data
                }
              }
              if (item.cache_control) {
                imageBlock.cache_control = item.cache_control
              }
              claudeContent.push(imageBlock)
            } else if (isDocumentType(mediaType)) {
              // 文档类型（PDF、文本等）
              const docBlock: any = {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: fileData.data
                }
              }
              if (item.cache_control) {
                docBlock.cache_control = item.cache_control
              }
              claudeContent.push(docBlock)
            } else {
            claudeContent.push({
                type: 'text',
                text: `[Unsupported file type: ${mediaType}]`
              })
            }
          } else if (fileData.type === 'text' && (fileData.text || fileData.data)) {
            // 纯文本文档
            const docBlock: any = {
              type: 'document',
              source: {
                type: 'text',
                media_type: fileData.media_type || 'text/plain',
                data: fileData.text || fileData.data
              }
            }
            if (item.cache_control) {
              docBlock.cache_control = item.cache_control
            }
   claudeContent.push(docBlock)
          } else if (fileData.url) {
            // URL 格式不支持
            claudeContent.push({
              type: 'text',
              text: `[Error: URL files not supported. Please convert to base64 first: ${fileData.url}]`
            })
          }
        }
        break

      case 'input_audio':
        // 音频不支持
        claudeContent.push({ type: 'text', text: '[Error: Audio input not supported]' })
        break

      default:
        // 其他类型尝试提取 text
        if (item.text?.trim()) {
          claudeContent.push({ type: 'text', text: item.text.trim() })
        }
    }
  }

  return claudeContent
}

/**
 * 将 Claude 格式的消息内容转换为 OpenAI 格式
 * 支持: text, image, document, thinking, tool_use, tool_result
 */
function convertClaudeContentToOpenAI(content: any): any {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const openaiContent: any[] = []

  for (const block of content) {
    if (!block) continue

    switch (block.type) {
      case 'text':
        if (block.text) {
          openaiContent.push({ type: 'text', text: block.text })
        }
        break

      case 'thinking':
        // 思考内容转为 reasoning_content（部分客户端支持）
        if (block.thinking) {
          openaiContent.push({ type: 'text', text: `<thinking>\n${block.thinking}\n</thinking>` })
        }
        break

      case 'image':
        if (block.source?.type === 'base64') {
          openaiContent.push({
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`
            }
          })
        }
        break

      case 'document':
        // 文档类型转为文件引用提示
        if (block.source) {
          openaiContent.push({
            type: 'text',
            text: `[Document: ${block.source.media_type}]`
          })
        }
        break

      case 'tool_use':
        // 工具调用在 OpenAI 中是单独的字段，这里转为文本提示
        openaiContent.push({
          type: 'text',
          text: `[Tool use: ${block.name}]`
        })
        break

      case 'tool_result':
        openaiContent.push({
          type: 'text',
          text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        })
        break

      default:
        if (block.text) {
          openaiContent.push({ type: 'text', text: block.text })
        }
    }
  }

  // 如果只有一个文本块，返回纯字符串
  if (openaiContent.length === 1 && openaiContent[0].type === 'text') {
    return openaiContent[0].text
  }

  return openaiContent.length > 0 ? openaiContent : ''
}

/**
 * 将 OpenAI 格式的请求转换为 Claude 格式
 * 支持: 消息转换、工具调用、缓存控制、思考模式
 */
// @ts-ignore - Function kept for potential future use
function convertOpenAIRequestToClaude(openaiRequest: any): any {
  const messages = openaiRequest.messages || []
  const claudeMessages: any[] = []
  let systemContent: any = ''
  let systemCacheControl: any = null

  for (const message of messages) {
    const role = message.role

    // 处理系统消息
    if (role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : normalizeTextContent(message.content)
      systemContent += (systemContent ? '\n' : '') + text
      // 保留缓存控制
      if (message.cache_control) {
        systemCacheControl = message.cache_control
      }
      continue
    }

    // 处理工具结果消息
    if (role === 'tool') {
      const toolResult: any = {
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content
      }
      if (message.cache_control) {
        toolResult.cache_control = message.cache_control
      }
      claudeMessages.push({
        role: 'user',
        content: [toolResult]
      })
      continue
    }

    // 处理助手的工具调用消息
    if (role === 'assistant' && message.tool_calls?.length) {
      const toolUseBlocks = message.tool_calls
        .filter((tc: any) => tc?.function?.name) // 过滤无效的工具调用
        .map((tc: any) => {
          let input = {}
          if (typeof tc.function.arguments === 'string') {
            try {
              input = JSON.parse(tc.function.arguments)
            } catch {
              // JSON 解析失败，使用空对象
              input = {}
            }
          } else {
            input = tc.function.arguments || {}
          }
          return {
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input
          }
        })
      if (toolUseBlocks.length > 0) {
        claudeMessages.push({ role: 'assistant', content: toolUseBlocks })
      }
      continue
    }

    // 普通消息
    const claudeRole = role === 'assistant' ? 'assistant' : 'user'
    const claudeContent = convertOpenAIContentToClaude(message.content)

    if (claudeContent.length > 0) {
      claudeMessages.push({ role: claudeRole, content: claudeContent })
    }
  }

  // 合并相邻相同角色的消息
  const mergedMessages: any[] = []
  for (const msg of claudeMessages) {
    if (mergedMessages.length === 0) {
      mergedMessages.push(msg)
    } else {
      const lastMsg = mergedMessages[mergedMessages.length - 1]
      if (lastMsg.role === msg.role) {
        lastMsg.content = lastMsg.content.concat(msg.content)
      } else {
        mergedMessages.push(msg)
      }
    }
  }

  const claudeRequest: any = {
    model: openaiRequest.model,
    messages: mergedMessages,
    max_tokens: openaiRequest.max_tokens || 4096,
    stream: openaiRequest.stream
  }

  // 系统消息（支持缓存控制）
  if (systemContent) {
    if (systemCacheControl) {
      claudeRequest.system = [{
        type: 'text',
        text: systemContent,
        cache_control: systemCacheControl
      }]
    } else {
      claudeRequest.system = systemContent
    }
  }

  if (openaiRequest.temperature !== undefined) {
    claudeRequest.temperature = openaiRequest.temperature
  }

  if (openaiRequest.top_p !== undefined) {
    claudeRequest.top_p = openaiRequest.top_p
  }

  // 思考模式支持
  // OpenAI 兼容格式: thinking_budget 或 reasoning_effort
  // Claude 格式: thinking: { type: "enabled", budget_tokens: N }
  if (openaiRequest.thinking_budget || openaiRequest.reasoning_effort) {
    let budgetTokens = openaiRequest.thinking_budget

    // reasoning_effort 映射 (low/medium/high)
    if (!budgetTokens && openaiRequest.reasoning_effort) {
      const effortMapping: Record<string, number> = {
        low: 5000,
        medium: 10000,
        high: 20000
      }
      budgetTokens = effortMapping[openaiRequest.reasoning_effort] || 10000
    }

    claudeRequest.thinking = {
      type: 'enabled',
      budget_tokens: budgetTokens
    }
  } else if (openaiRequest.thinking) {
    // 直接传递 Claude 格式的 thinking 参数
    claudeRequest.thinking = openaiRequest.thinking
  }

  // 转换工具定义
  if (openaiRequest.tools?.length) {
    claudeRequest.tools = openaiRequest.tools
      .filter((t: any) => t?.function?.name) // 过滤掉无效的工具定义
      .map((t: any) => {
        const tool: any = {
          name: t.function.name,
          description: t.function.description || '',
          input_schema: t.function.parameters || { type: 'object', properties: {} }
        }
        // 工具级别的缓存控制
        if (t.cache_control) {
          tool.cache_control = t.cache_control
        }
        return tool
      })

    // 转换 tool_choice
    if (openaiRequest.tool_choice) {
      if (typeof openaiRequest.tool_choice === 'string') {
        const mapping: Record<string, string> = { auto: 'auto', none: 'none', required: 'any' }
        claudeRequest.tool_choice = { type: mapping[openaiRequest.tool_choice] || 'auto' }
      } else if (openaiRequest.tool_choice.function) {
        claudeRequest.tool_choice = { type: 'tool', name: openaiRequest.tool_choice.function.name }
      }
    } else {
      // 默认设置为 auto
      claudeRequest.tool_choice = { type: 'auto' }
    }
  }

  return claudeRequest
}

function estimateTokenCount(requestBody: any): number {
  let totalChars = 0
  if (requestBody?.system) {
    totalChars += normalizeTextContent(requestBody.system).length
  }
  if (Array.isArray(requestBody?.messages)) {
    for (const message of requestBody.messages) {
      totalChars += normalizeTextContent(message?.content ?? message).length
    }
  }
  if (Array.isArray(requestBody?.tools)) {
    totalChars += JSON.stringify(requestBody.tools).length
  }
  return Math.ceil(totalChars / 4)
}

function buildContextWarning(tokenEstimate: number): string | null {
  if (tokenEstimate >= 190000) {
    return 'Context length is very large and may exceed limits. Consider compacting or starting a new chat.'
  }
  if (tokenEstimate >= 170000) {
    return 'Context is near the limit. Consider compacting or starting a new chat soon.'
  }
  return null
}

function claudeToOpenAIResponse(claudeMessage: any) {
  const promptTokens = claudeMessage?.usage?.input_tokens ?? 0
  const completionTokens = claudeMessage?.usage?.output_tokens ?? 0

  // 检查是否包含工具调用或思考内容
  const content = claudeMessage?.content ?? []
  const hasToolUse = Array.isArray(content) && content.some((block: any) => block?.type === 'tool_use')
  const hasThinking = Array.isArray(content) && content.some((block: any) => block?.type === 'thinking')

  const message: any = {
    role: 'assistant',
    content: null
  }

  if (hasToolUse) {
    // 处理包含工具调用的响应
    const toolCalls: any[] = []
    let textContent = ''
    let thinkingContent = ''

    for (const block of content) {
      if (!block) continue

      if (block.type === 'text') {
        textContent += block.text || ''
      } else if (block.type === 'thinking') {
        thinkingContent += block.thinking || ''
      } else if (block.type === 'tool_use') {
        // OpenAI 格式：id 必须以 "call_" 开头
        const toolId = block.id?.startsWith('call_') ? block.id : `call_${block.id || `${block.name}_${Date.now()}`}`
        toolCalls.push({
          id: toolId,
          type: 'function',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input || {})
          }
        })
      }
    }

    message.content = textContent || null
    if (thinkingContent) {
      message.reasoning_content = thinkingContent
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
    }
  } else if (hasThinking) {
    // 处理包含思考内容的响应
    let textContent = ''
    let thinkingContent = ''

    for (const block of content) {
      if (!block) continue

      if (block.type === 'text') {
        textContent += block.text || ''
      } else if (block.type === 'thinking') {
        thinkingContent += block.thinking || ''
      }
    }

    message.content = textContent || null
    if (thinkingContent) {
      message.reasoning_content = thinkingContent
    }
  } else {
    // 处理普通响应（可能包含图片）
    const openaiContent = convertClaudeContentToOpenAI(content)
    message.content = openaiContent
  }

  // 映射 finish_reason
  let finishReason = 'stop'
  if (claudeMessage?.stop_reason === 'end_turn') {
    finishReason = 'stop'
  } else if (claudeMessage?.stop_reason === 'max_tokens') {
    finishReason = 'length'
  } else if (claudeMessage?.stop_reason === 'tool_use') {
    finishReason = 'tool_calls'
  } else if (claudeMessage?.stop_reason) {
    finishReason = claudeMessage.stop_reason
  }

  return {
    id: claudeMessage?.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: claudeMessage?.model ?? 'claude-opus-4-5',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: {
        cached_tokens: claudeMessage?.usage?.cache_read_input_tokens || 0
      }
    }
  }
}

/**
 * 构建 OpenAI 流式响应块
 */
function buildOpenAIStreamChunk(
  id: string,
  model: string,
  created: number,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage?: any
) {
  const chunk: any = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  }
  if (usage) chunk.usage = usage
  return chunk
}


function convertClaudeStreamChunkToOpenAIChunks(
  claudeChunk: any,
  model: string,
  openaiId: string,
  created: number
) {
  if (!claudeChunk) return []

  const chunkId = openaiId || `chatcmpl_${Date.now()}`
  const timestamp = created || Math.floor(Date.now() / 1000)

  const buildChunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: any) => {
    const chunk: any = {
      id: chunkId,
      object: 'chat.completion.chunk',
      created: timestamp,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason
        }
      ]
    }
    if (usage) chunk.usage = usage
    return chunk
  }

  if (claudeChunk.type === 'message_start') {
    const usage = claudeChunk.message?.usage
    const usagePayload = usage
      ? {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: 0,
        total_tokens: usage.input_tokens || 0,
        cached_tokens: usage.cache_read_input_tokens || 0,
        prompt_tokens_details: {
          cached_tokens: usage.cache_read_input_tokens || 0
        }
      }
      : undefined

    return [buildChunk({ role: 'assistant', content: '' }, null, usagePayload)]
  }

  if (claudeChunk.type === 'content_block_start') {
    const contentBlock = claudeChunk.content_block
    if (contentBlock?.type === 'tool_use') {
      // OpenAI 格式要求：id 必须以 "call_" 开头
      const toolId = contentBlock.id?.startsWith('call_')
        ? contentBlock.id
        : `call_${contentBlock.id || `${contentBlock.name}_${Date.now()}`}`
      return [
        buildChunk(
          {
            tool_calls: [
              {
                index: claudeChunk.index || 0,
                id: toolId,
                type: 'function',
                function: {
                  name: contentBlock.name,
                  arguments: ''
                }
              }
            ]
          },
          null
        )
      ]
    }

    return [buildChunk({ content: '' }, null)]
  }

  if (claudeChunk.type === 'content_block_delta') {
    const delta = claudeChunk.delta
    if (delta?.type === 'text_delta') {
      return [buildChunk({ content: delta.text || '' }, null)]
    }
    if (delta?.type === 'thinking_delta') {
      return [buildChunk({ reasoning_content: delta.thinking || '' }, null)]
    }
    if (delta?.type === 'input_json_delta') {
      return [
        buildChunk(
          {
            tool_calls: [
              {
                index: claudeChunk.index || 0,
                function: {
                  arguments: delta.partial_json || ''
                }
              }
            ]
          },
          null
        )
      ]
    }
  }

  if (claudeChunk.type === 'content_block_stop') {
    return [buildChunk({}, null)]
  }

  if (claudeChunk.type === 'message_delta') {
    const stopReason = claudeChunk.delta?.stop_reason
    const finishReason =
      stopReason === 'end_turn'
        ? 'stop'
        : stopReason === 'max_tokens'
          ? 'length'
          : stopReason === 'tool_use'
            ? 'tool_calls'
            : stopReason || 'stop'

    const usage = claudeChunk.usage
    const usagePayload = usage
      ? {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
        cached_tokens: usage.cache_read_input_tokens || 0,
        prompt_tokens_details: {
          cached_tokens: usage.cache_read_input_tokens || 0
        }
      }
      : undefined

    return [buildChunk({}, finishReason, usagePayload)]
  }

  if (claudeChunk.type === 'message_stop') {
    return [buildChunk({}, 'stop')]
  }

  if (typeof claudeChunk === 'string') {
    return [buildChunk({ content: claudeChunk }, null)]
  }

  return []
}

/**
 * 过滤并简化 Claude Code 的工具定义
 * 
 * Kiro API 会检测 tools 中的超长 description，尤其是包含
 * "Git Safety Protocol"、"Claude Code" 等特征文本的工具。
 * 此函数将这些敏感的 description 替换为简短版本。
 * 
 * @param body 请求体
 * @returns 处理后的请求体
 */
function sanitizeClaudeCodeTools(body: any): any {
  if (!body.tools?.length) return body
  
  // 检测是否有包含 "Claude Code" 特征的工具需要替换
  const needsReplacement = body.tools.some((t: any) => 
    t.name in SAFE_TOOL_DESCRIPTIONS && 
    t.description?.includes('Claude Code')
  )
  
  if (!needsReplacement) return body
  
  // 只替换那些包含 "Claude Code" 的工具
  return {
    ...body,
    tools: body.tools.map((tool: any) => {
      const optimizedDesc = SAFE_TOOL_DESCRIPTIONS[tool.name]
      if (optimizedDesc && tool.description?.includes('Claude Code')) {
        return { ...tool, description: optimizedDesc }
      }
      return tool
    })
  }
}

function isTokenNearExpiry(expiresAt: number, refreshBeforeExpiryMs: number) {
  return expiresAt && Date.now() + refreshBeforeExpiryMs >= expiresAt
}

function getNextMonthStartMs(now = Date.now()) {
  const date = new Date(now)
  return new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0).getTime()
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
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kiro Admin Portal</title>
    <style>
      :root {
        --bg: #ffffff;
        --surface: #ffffff;
        --surface-2: #f8fafc;
        --text: #0f172a;
        --text-secondary: #64748b;
        --border: #e2e8f0;
        --primary: #4f46e5;
        --primary-hover: #4338ca;
        --primary-fg: #ffffff;
        --danger: #ef4444;
        --radius: 12px;
        --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.05);
        --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      }

      [data-theme='dark'] {
        --bg: #000000;
        --surface: #0a0a0a;
        --surface-2: #171717;
        --text: #ffffff;
        --text-secondary: #a1a1aa;
        --border: #27272a;
        --primary: #6366f1;
        --primary-hover: #818cf8;
        --primary-fg: #ffffff;
        --shadow: 0 10px 15px -3px rgb(0 0 0 / 0.5);
      }

      * { box-sizing: border-box; transition: background-color 0.2s, border-color 0.2s, color 0.1s; }
      
      body {
        font-family: var(--font-sans);
        margin: 0;
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        line-height: 1.5;
      }

      /* Lock Screen */
      #auth-screen {
        position: fixed;
        inset: 0;
        background: var(--bg);
        z-index: 100;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
      }
      
      .auth-container {
        width: 100%;
        max-width: 360px;
        padding: 2rem;
        text-align: center;
        animation: fadeIn 0.5s ease-out;
      }

      .logo-icon {
        width: 64px;
        height: 64px;
        background: var(--primary);
        border-radius: 18px;
        margin: 0 auto 1.5rem;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 28px;
        box-shadow: 0 10px 20px -5px var(--primary);
        background: linear-gradient(135deg, var(--primary), var(--primary-hover));
      }

      /* Main Layout */
      #main-content { display: none; margin: 0 auto; width: 100%; max-width: 900px; padding: 2rem 1rem; }
      
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 2rem;
        padding-bottom: 1rem;
        border-bottom: 1px solid var(--border);
      }
      
      .title { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.025em; }

      /* Components */
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 1.5rem;
        margin-bottom: 1.5rem;
        box-shadow: var(--shadow);
      }
      
      .card h2 {
        font-size: 1.1rem;
        font-weight: 600;
        margin: 0 0 1.25rem 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
      
      .form-group { margin-bottom: 1rem; }
      .form-group label { display: block; font-size: 0.875rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 0.375rem; }
      
      input[type="text"], input[type="password"], input[type="number"] {
        width: 100%;
        padding: 0.625rem 0.875rem;
        background: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        font-size: 0.9rem;
        outline: none;
      }
      input:focus {
        border-color: var(--primary);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent);
      }

      /* Custom File Buffer */
      .file-input-wrapper {
        position: relative;
        display: flex;
        gap: 0.5rem;
        align-items: center;
      }
      .file-input-wrapper input[type="file"] {
        position: absolute;
        width: 0.1px;
        height: 0.1px;
        opacity: 0;
        overflow: hidden;
        z-index: -1;
      }
      .file-label {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.625rem 1rem;
        font-size: 0.875rem;
        font-weight: 500;
        border-radius: 8px;
        cursor: pointer;
        background: var(--surface-2);
        border: 1px solid var(--border);
        color: var(--text);
        transition: all 0.2s;
        flex-shrink: 0;
      }
      .file-label:hover {
        background: color-mix(in srgb, var(--surface-2) 90%, black);
        border-color: var(--text-secondary);
      }
      .file-name {
        font-size: 0.875rem;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.625rem 1.25rem;
        font-size: 0.875rem;
        font-weight: 500;
        border-radius: 8px;
        cursor: pointer;
        border: 1px solid transparent;
        transition: all 0.2s;
        gap: 0.5rem;
      }
      
      .btn-primary {
        background: var(--primary);
        color: var(--primary-fg);
        box-shadow: 0 2px 4px rgb(0 0 0 / 0.1);
      }
      .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
      
      .btn-ghost {
        background: transparent;
        color: var(--text-secondary);
        border: 1px solid var(--border);
      }
      .btn-ghost:hover { background: var(--surface-2); color: var(--text); }
      
      .btn-danger {
        background: transparent;
        color: var(--danger);
        border: 1px solid color-mix(in srgb, var(--danger) 20%, transparent);
      }
      .btn-danger:hover { background: color-mix(in srgb, var(--danger) 10%, transparent); }

      /* Table */
      .table-wrapper { overflow-x: auto; border-radius: 8px; border: 1px solid var(--border); }
      table { width: 100%; border-collapse: collapse; text-align: left; }
      th {
        background: var(--surface-2);
        padding: 0.75rem 1rem;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-secondary);
        border-bottom: 1px solid var(--border);
      }
      td { padding: 0.875rem 1rem; border-bottom: 1px solid var(--border); font-size: 0.875rem; }
      tr:last-child td { border-bottom: none; }
      tr:hover td { background: var(--surface-2); }
      
      .status-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 99px;
        font-size: 0.75rem;
        font-weight: 500;
        background: color-mix(in srgb, var(--primary) 10%, transparent);
        color: var(--primary);
      }

      /* Helpers */
      .muted { color: var(--text-secondary); font-size: 0.875rem; }
      .flex-end { display: flex; justify-content: flex-end; gap: 0.5rem; }
      .animate-shake { animation: shake 0.4s cubic-bezier(.36,.07,.19,.97) both; }
      
      @keyframes shake { 10%, 90% { transform: translate3d(-1px, 0, 0); } 20%, 80% { transform: translate3d(2px, 0, 0); } 30%, 50%, 70% { transform: translate3d(-4px, 0, 0); } 40%, 60% { transform: translate3d(4px, 0, 0); } }
      @keyframes shake { 10%, 90% { transform: translate3d(-1px, 0, 0); } 20%, 80% { transform: translate3d(2px, 0, 0); } 30%, 50%, 70% { transform: translate3d(-4px, 0, 0); } 40%, 60% { transform: translate3d(4px, 0, 0); } }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

      /* Dashboard Specifics */
      .stat-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        padding: 1.5rem;
        display: flex;
        align-items: center;
        gap: 1rem;
        transition: transform 0.2s;
      }
      .stat-card:hover { transform: translateY(-2px); }
      .stat-icon {
        width: 48px;
        height: 48px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.5rem;
        flex-shrink: 0;
      }
      .stat-content { display: flex; flex-direction: column; }
      .stat-value { font-size: 1.5rem; font-weight: 700; line-height: 1.2; }
      .stat-label { font-size: 0.875rem; color: var(--text-secondary); }

      .progress-bar-bg {
        width: 100%;
        height: 8px;
        background: var(--surface-2);
        border-radius: 99px;
        overflow: hidden;
        margin-top: 0.5rem;
      }
      .progress-bar-fill {
        height: 100%;
        background: var(--primary);
        border-radius: 99px;
        transition: width 0.5s ease-out;
      }
    </style>
  </head>
  <body>
    <!-- Auth Screen -->
    <div id="auth-screen">
      <div class="auth-container">
        <div class="logo-icon">🛡️</div>
        <h2 id="auth-title" style="font-size: 1.5rem; margin-bottom: 0.5rem; font-weight: 700;">Account Locked</h2>
        <p id="auth-subtitle" class="muted" style="margin-bottom: 2rem;">Please enter your password to continue</p>
        
        <form onsubmit="handleAuth(event)">
            <div class="form-group">
                <input type="password" id="auth-password" placeholder="Enter Password" autofocus />
            </div>
            <button class="btn btn-primary" style="width: 100%" data-i18n="accessPortal">Access Portal</button>
        </form>
        <p id="auth-hint" class="muted" style="margin-top: 1rem; font-size: 0.75rem; opacity: 0.7;">Default: admin</p>
      </div>
    </div>

    <!-- Main Content -->
    <div id="main-content">
      <div class="header">
        <div class="flex items-center gap-3">
             <div class="logo-icon" style="width: 40px; height: 40px; border-radius: 10px; font-size: 20px; margin: 0;">⚡</div>
             <div>
                 <h1 class="title">Admin Portal</h1>
                 <div class="muted" style="font-size: 0.8rem;">Kiro Account Manager</div>
             </div>
        </div>
        <div class="flex-end">
          <button class="btn btn-ghost" onclick="toggleLang()" id="lang-btn" title="Switch Language" style="font-weight: 600;">
             ZH
          </button>
          <button class="btn btn-ghost" onclick="toggleTheme()" id="theme-btn" title="Toggle Theme">
             🌗
          </button>
          <button class="btn btn-danger" onclick="logout()">
             <span style="font-size: 1.1em">🔒</span> <span data-i18n="lock">Lock</span>
          </button>
        </div>
      </div>

      <div id="dashboard-grid" class="grid" style="grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-bottom: 2rem;">
        <!-- Dynamically populated -->
      </div>
      
      <div class="card" id="credit-stats-card" style="display: none;">
         <h2 style="margin-bottom: 1.5rem;">
            <span style="background: var(--surface-2); padding: 6px; border-radius: 8px; display: inline-flex;">📊</span> 
            <span data-i18n="creditStats">Credit Statistics</span>
            <span id="credit-stats-subtitle" class="muted" style="font-size: 0.8rem; font-weight: 400; margin-left: 0.5rem;">(based on active accounts)</span>
            <button class="btn btn-ghost" id="refresh-usage-btn" onclick="refreshUsage()" data-i18n="refreshUsage" style="margin-left: auto;">
              Refresh Usage
            </button>
         </h2>
         <div class="grid" style="gap: 2rem;">
            <div style="background: var(--surface-2); padding: 1.25rem; border-radius: 12px;">
                <div class="flex items-center gap-2 mb-2" style="color: var(--primary);">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                    <span style="font-size: 0.9rem; font-weight: 600;" data-i18n="totalLimit">Total Limit</span>
                </div>
                <div id="dash-total-limit" style="font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em;">0</div>
            </div>
            
            <div style="background: var(--surface-2); padding: 1.25rem; border-radius: 12px;">
                <div class="flex items-center gap-2 mb-2" style="color: #f59e0b;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    <span style="font-size: 0.9rem; font-weight: 600;" data-i18n="used">Used</span>
                </div>
                <div id="dash-used" style="font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em;">0</div>
            </div>

            <div style="background: var(--surface-2); padding: 1.25rem; border-radius: 12px;">
                <div class="flex items-center gap-2 mb-2" style="color: #10b981;">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                    <span style="font-size: 0.9rem; font-weight: 600;" data-i18n="remaining">Remaining</span>
                </div>
                <div id="dash-remaining" style="font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em; color: #10b981;">0</div>
            </div>

             <div style="background: var(--surface-2); padding: 1.25rem; border-radius: 12px;">
                <div class="flex items-center gap-2 mb-2" style="color: #8b5cf6;">
                     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/></svg>
                    <span style="font-size: 0.9rem; font-weight: 600;" data-i18n="usageRate">Usage Rate</span>
                </div>
                <div id="dash-rate" style="font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em;">0%</div>
            </div>
         </div>
         
         <div style="margin-top: 1.5rem;">
            <div class="flex justify-between" style="font-size: 0.8rem; margin-bottom: 0.5rem;">
                <span class="muted" data-i18n="overallProgress">Overall Usage Progress</span>
                <span id="dash-progress-text" class="muted">0 / 0</span>
            </div>
            <div class="progress-bar-bg">
                <div id="dash-progress-bar" class="progress-bar-fill" style="width: 0%"></div>
            </div>
         </div>
      </div>

      <div class="card">
        <h2 data-i18n="apiConfig">🔑 API Configuration</h2>
        <div class="grid">
          <div class="form-group" style="grid-column: 1 / -1;">
            <label data-i18n="adminKey">Admin Access Key</label>
            <div style="display: flex; gap: 0.5rem;">
               <input id="apiKey" type="password" placeholder="Access token for API operations" />
               <button class="btn btn-primary" onclick="saveKey()" data-i18n="save">Save</button>
            </div>
            <p class="muted" style="margin-top: 0.5rem;" data-i18n="adminKeyDesc">This key is used to authenticate requests between this dashboard and the proxy.</p>
          </div>
        </div>
      </div>

      <div class="card">
        <h2 data-i18n="proxySettings">🌐 Proxy Settings</h2>
        <div class="grid">
           <div class="form-group">
              <label data-i18n="status">Status</label>
              <div style="display: flex; align-items: center; gap: 0.75rem; min-height: 42px;">
                  <label class="switch" style="margin: 0; display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                      <input id="proxyEnabled" type="checkbox" style="width: auto; margin: 0;">
                      <span data-i18n="enableProxy">Enable Proxy Server</span>
                  </label>
              </div>
           </div>
           <div class="form-group">
              <label data-i18n="port">Port</label>
              <input id="proxyPort" type="number" min="1" max="65535" />
           </div>
           <div class="form-group">
              <label data-i18n="proxyKey">Proxy API Key (Optional)</label>
              <input id="proxyApiKey" type="password" placeholder="Optional protection" />
           </div>
        </div>
        <div class="flex-end" style="margin-top: 1rem;">
           <button class="btn btn-primary" onclick="updateProxy()" data-i18n="applySettings">Apply Settings</button>
        </div>
      </div>

      <div class="card">
        <h2 data-i18n="accounts">👥 Active Accounts</h2>
        <div class="table-wrapper">
            <table id="accountsTable">
              <thead>
                <tr><th data-i18n="email">Email</th><th data-i18n="status">Status</th><th data-i18n="actions">Actions</th></tr>
              </thead>
              <tbody></tbody>
            </table>
        </div>
      </div>

      <div class="card">
        <h2 data-i18n="importAccount">📤 Import Account</h2>
        <form id="importForm" style="display: grid; gap: 1rem;">
           <div class="grid">
               <div class="form-group">
                 <label data-i18n="tokenFile">Token File (kiro-auth-token.json)</label>
                 <div class="file-input-wrapper">
                    <label for="tokenFile" class="file-label" data-i18n="chooseFile">Choose File</label>
                    <input type="file" id="tokenFile" name="tokenFile" accept=".json" required onchange="updateFileLabel(this)" />
                    <span class="file-name" data-i18n="noFileChosen">No file chosen</span>
                 </div>
               </div>
               <div class="form-group">
                 <label data-i18n="clientFile">Client File (client-identifier.json)</label>
                 <div class="file-input-wrapper">
                    <label for="clientFile" class="file-label" data-i18n="chooseFile">Choose File</label>
                    <input type="file" id="clientFile" name="clientFile" accept=".json" required onchange="updateFileLabel(this)" />
                    <span class="file-name" data-i18n="noFileChosen">No file chosen</span>
                 </div>
               </div>
           </div>
           <div class="flex-end">
              <button type="submit" class="btn btn-ghost" style="border-color: var(--primary); color: var(--primary);" data-i18n="importJson">
                 📥 Import JSON
              </button>
           </div>
        </form>
        <div id="importResult" class="muted" style="margin-top: 1rem;"></div>
      </div>
    </div>

    <script>
      // Translations
      const i18n = {
        en: {
          lockTitle: "Account Locked",
          lockSubtitle: "Please enter your password to continue",
          setupTitle: "Setup Password",
          setupSubtitle: "Create a password to secure this portal",
          inputPass: "Enter Password",
          createPass: "Create new password",
          accessPortal: "Access Portal",
          welcomeBack: "Welcome Back",
          authHint: "Default: admin",
          
          apiConfig: "🔑 API Configuration",
          adminKey: "Admin Access Key",
          adminKeyDesc: "This key is used to authenticate requests between this dashboard and the proxy.",
          save: "Save",
          saved: "Saved!",
          
          proxySettings: "🌐 Proxy Settings",
          status: "Status",
          enableProxy: "Enable Proxy Server",
          port: "Port",
          proxyKey: "Proxy API Key (Optional)",
          applySettings: "Apply Settings",
          updating: "Updating...",
          settingsApplied: "Settings Applied",
          errorUpdating: "Error updating settings",
          
          accounts: "👥 Active Accounts",
          email: "Email",
          actions: "Actions",
          remove: "Remove",
          confirmDelete: "Are you sure you want to delete this account?",
          noAccounts: "No accounts found",
          
          importAccount: "📤 Import Account",
          tokenFile: "Token File (kiro-auth-token.json)",
          clientFile: "Client File (client-identifier.json)",
          chooseFile: "Choose File",
          noFileChosen: "No file chosen",
          importJson: "📥 Import JSON",
          importing: "Importing...",
          uploadFailed: "Upload failed",
          successAdded: "Success! Added",
          
          successAdded: "Success! Added",

          dashboard: "📊 Dashboard",
          totalAccounts: "Total Accounts",
          activeAccounts: "Active",
          totalLimit: "Total Limit",
          totalUsage: "Total Usage",

          creditStats: "Credit Statistics",
          refreshUsage: "Refresh Usage",
          refreshingUsage: "Refreshing...",
          refreshUsageDone: "Usage Refreshed",
          refreshUsageFailed: "Failed to refresh usage",
          used: "Used",
          remaining: "Remaining",
          usageRate: "Usage Rate",
          overallProgress: "Overall Usage Progress",
          
          banned: "Banned",
          expiringSoon: "Expiring Soon",
          
          lock: "Lock"
        },
        zh: {
          lockTitle: "账户已锁定",
          lockSubtitle: "请输入密码以继续访问",
          setupTitle: "设置密码",
          setupSubtitle: "请创建一个密码来保护此后台",
          inputPass: "输入密码",
          createPass: "创建新密码",
          accessPortal: "进入后台",
          welcomeBack: "欢迎回来",
          authHint: "默认密码: admin",
          
          apiConfig: "🔑 API 配置",
          adminKey: "管理员访问密钥",
          adminKeyDesc: "此密钥用于验证仪表板与代理服务之间的请求。",
          save: "保存",
          saved: "已保存!",
          
          proxySettings: "🌐 代理设置",
          status: "状态",
          enableProxy: "启用代理服务器",
          port: "端口",
          proxyKey: "代理 API 密钥 (可选)",
          applySettings: "应用设置",
          updating: "更新中...",
          settingsApplied: "设置已应用",
          errorUpdating: "更新设置失败",
          
          accounts: "👥 活跃账号",
          email: "邮箱",
          actions: "操作",
          remove: "删除",
          confirmDelete: "确定要删除这个账号吗？",
          noAccounts: "暂无账号",
          
          importAccount: "📤 导入账号",
          tokenFile: "Token 文件 (kiro-auth-token.json)",
          clientFile: "客户端文件 (client-identifier.json)",
          chooseFile: "选择文件",
          noFileChosen: "未选择文件",
          importJson: "📥 导入 JSON",
          importing: "导入中...",
          uploadFailed: "上传失败",
          successAdded: "成功！已添加",
          
          successAdded: "成功！已添加",

          dashboard: "📊 数据概览",
          totalAccounts: "总账号数",
          activeAccounts: "可用账号",
          totalLimit: "总额度",
          totalUsage: "已用额度",

          creditStats: "额度统计",
          refreshUsage: "刷新用量",
          refreshingUsage: "刷新中...",
          refreshUsageDone: "用量已更新",
          refreshUsageFailed: "刷新失败",
          used: "已使用",
          remaining: "剩余额度",
          usageRate: "使用率",
          overallProgress: "总体使用进度",

          banned: "已封禁",
          expiringSoon: "即将过期",
          
          lock: "锁定"
        }
      };

      // State
      const state = {
        theme: localStorage.getItem('theme') || 'light',
        lang: localStorage.getItem('lang') || 'zh', // Default to Chinese as user requested
        locked: true,
        password: localStorage.getItem('admin_password') || null
      };

      // I18n Helper
      function t(key) {
        return i18n[state.lang][key] || key;
      }

      function applyLanguage() {
        document.documentElement.lang = state.lang;
        document.getElementById('lang-btn').textContent = state.lang === 'en' ? '中' : 'EN';
        
        // Update simple texts
        document.querySelectorAll('[data-i18n]').forEach(el => {
           const key = el.getAttribute('data-i18n');
           if(i18n[state.lang][key]) {
               el.textContent = i18n[state.lang][key];
           }
        });

        // Update Auth Screen
        const authTitle = document.getElementById('auth-title');
        const authSubtitle = document.getElementById('auth-subtitle');
        const authInput = document.getElementById('auth-password');
        const authHint = document.getElementById('auth-hint');
        
        if (!state.password) {
            authTitle.textContent = t('setupTitle');
            authSubtitle.textContent = t('setupSubtitle');
            authInput.placeholder = t('createPass');
        } else if (state.locked) {
            authTitle.textContent = t('welcomeBack'); // or t('lockTitle')
            authSubtitle.textContent = t('lockSubtitle');
            authInput.placeholder = t('inputPass');
        }
        authHint.textContent = t('authHint');
        
        // Refresh dynamic content like tables
        if(!state.locked) {
             loadData();
             startPolling();
         }
      }

      function toggleLang() {
        state.lang = state.lang === 'en' ? 'zh' : 'en';
        localStorage.setItem('lang', state.lang);
        applyLanguage();
      }

      // Utils
      function updateFileLabel(input) {
        const span = input.parentElement.querySelector('.file-name');
        if (input.files && input.files.length > 0) {
            span.textContent = input.files[0].name;
            span.style.color = 'var(--text)';
        } else {
            span.textContent = t('noFileChosen');
            span.style.color = 'var(--text-secondary)';
        }
      }

      // Theme Management
      function applyTheme() {
         document.documentElement.setAttribute('data-theme', state.theme);
      }
      
      function toggleTheme() {
         state.theme = state.theme === 'dark' ? 'light' : 'dark';
         localStorage.setItem('theme', state.theme);
         applyTheme();
      }

      // Auth Management
      const authScreen = document.getElementById('auth-screen');
      const mainContent = document.getElementById('main-content');
      const authInput = document.getElementById('auth-password');

      function initAuth() {
         applyTheme();
         applyLanguage();
         if (!state.password) {
            document.getElementById('auth-hint').style.display = 'none';
         }
      }

      function handleAuth(e) {
         e.preventDefault();
         const input = authInput.value;
         
         if (!state.password) {
             if (input.length < 4) {
                 alert('Password/密码 must be at least 4 characters');
                 return;
             }
             state.password = input;
             localStorage.setItem('admin_password', input);
             unlock();
         } else {
             if (input === state.password) {
                 unlock();
             } else {
                 authInput.parentElement.classList.add('animate-shake');
                 setTimeout(() => authInput.parentElement.classList.remove('animate-shake'), 500);
                 authInput.value = '';
             }
         }
      }

      function unlock() {
         state.locked = false;
         authScreen.style.opacity = '0';
         setTimeout(() => {
             authScreen.style.display = 'none';
             mainContent.style.display = 'block';
             loadData();
             startPolling();
         }, 500);
       }

       let pollInterval;
       function startPolling() {
           if(pollInterval) clearInterval(pollInterval);
           pollInterval = setInterval(() => {
               if(!state.locked && document.visibilityState === 'visible') {
                   loadData(true); // true = silent update (don't clear table)
               }
           }, 5000);
       }

       function logout() {
           clearInterval(pollInterval);
           state.locked = true;
          authScreen.style.display = 'flex';
          authScreen.style.opacity = '1';
          mainContent.style.display = 'none';
          authInput.value = '';
          applyLanguage(); // Reset text to lock screen state
      }

      // Admin Logic
      const apiKeyInput = document.getElementById('apiKey');
      apiKeyInput.value = localStorage.getItem('adminApiKey') || '';

      function saveKey() {
        localStorage.setItem('adminApiKey', apiKeyInput.value || '');
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = t('saved');
        setTimeout(() => btn.textContent = originalText, 2000);
      }

      function headers() {
        const key = localStorage.getItem('adminApiKey');
        return key ? { 'Authorization': 'Bearer ' + key } : {};
      }

      async function loadData(silent = false) {
        try {
            const res = await fetch('/admin/data', { headers: headers() });
            if (!res.ok) {
                 if (res.status === 401) {
                    alert('API Key Invalid or Missing / API 密钥无效或丢失');
                    clearInterval(pollInterval);
                 }
                 return;
            }
            const data = await res.json();
            
            // Only update inputs if not currently focused (to avoid typing interruptions if auto-refresh)
            if(document.activeElement !== document.getElementById('proxyPort') && document.activeElement !== document.getElementById('apiKey')) {
                 document.getElementById('proxyEnabled').checked = !!data.proxy.enabled;
                 document.getElementById('proxyPort').value = data.proxy.port || 3001;
                 document.getElementById('proxyApiKey').value = data.proxy.apiKey || '';
            }
            
            const tbody = document.querySelector('#accountsTable tbody');
            
            if (data.accounts.length === 0) {
               if(tbody.innerHTML === '' || !silent)
                  tbody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align: center; padding: 2rem;">' + t('noAccounts') + '</td></tr>';
            } else {
                 if(!silent) tbody.innerHTML = ''; 
                 else {
                    tbody.innerHTML = ''; // For simplicity, rebuild. Ideally use diffing.
                 }
                 
                 data.accounts.forEach(acc => {
                        const tr = document.createElement('tr');
                        
                        // Determine status color
                        let statusColor = 'var(--primary)';
                        if(acc.status === 'error' || acc.status === 'disabled' || acc.status === 'expired') statusColor = 'var(--danger)';
                        else if(acc.status === 'validating') statusColor = 'var(--text-secondary)';
                        
                        const limit = acc.usage?.limit ?? 0;
                        const current = acc.usage?.current ?? 0;
                        const percent = limit > 0 ? Math.round((current / limit) * 100) : 0;
                        
                        tr.innerHTML = \`
                         <td>
                           <div style="font-weight: 500">\${acc.email || 'Unknown'}</div>
                           <div class="muted" style="font-size: 0.75rem">\${acc.id}</div>
                         </td>
                         <td>
                           <span class="status-badge" style="background: color-mix(in srgb, \${statusColor} 10%, transparent); color: \${statusColor}">
                              \${acc.status || 'Active'}
                           </span>
                           <div class="muted" style="font-size: 0.75rem; margin-top: 4px;">
                              \${current} / \${limit} (\${percent}%)
                           </div>
                         </td>
                         <td><button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem" data-id="\${acc.id}">\${t('remove')}</button></td>
                        \`;
                        tr.querySelector('button').onclick = async () => {
                          if(!confirm(t('confirmDelete'))) return;
                          await fetch('/admin/account?id=' + encodeURIComponent(acc.id), { method: 'DELETE', headers: headers() });
                          await loadData();
                        };
                        tbody.appendChild(tr);
                      });
            }
            
            updateDashboard(data.accounts);
            
        } catch (e) {
            console.error(e);
        }
      }

      function updateDashboard(accounts) {
        if (!accounts) return;
        
        const total = accounts.length;
        const active = accounts.filter(a => !a.status || a.status === 'active' || a.status === 'Active').length;
        const banned = accounts.filter(a => a.status === 'error' || a.status === 'disabled').length;
        const expiring = accounts.filter(a => a.status === 'expired').length;

        
        const grid = document.getElementById('dashboard-grid');
        grid.innerHTML = \`
            <div class="stat-card" style="border-left: 4px solid var(--primary);">
                <div class="stat-icon" style="background: color-mix(in srgb, var(--primary) 10%, transparent); color: var(--primary);">
                    👥
                </div>
                <div class="stat-content">
                    <span class="stat-value">\${total}</span>
                    <span class="stat-label">\${t('totalAccounts')}</span>
                </div>
            </div>
            <div class="stat-card" style="border-left: 4px solid #10b981;">
                <div class="stat-icon" style="background: color-mix(in srgb, #10b981 10%, transparent); color: #10b981;">
                    ✅
                </div>
                <div class="stat-content">
                    <span class="stat-value">\${active}</span>
                    <span class="stat-label">\${t('activeAccounts')}</span>
                </div>
            </div>
             <div class="stat-card" style="border-left: 4px solid #ef4444;">
                <div class="stat-icon" style="background: color-mix(in srgb, #ef4444 10%, transparent); color: #ef4444;">
                    ⚠️
                </div>
                <div class="stat-content">
                    <span class="stat-value">\${banned}</span>
                    <span class="stat-label">\${t('banned')}</span>
                </div>
            </div>
             <div class="stat-card" style="border-left: 4px solid #f59e0b;">
                <div class="stat-icon" style="background: color-mix(in srgb, #f59e0b 10%, transparent); color: #f59e0b;">
                    🕒
                </div>
                <div class="stat-content">
                    <span class="stat-value">\${expiring}</span>
                    <span class="stat-label">\${t('expiringSoon')}</span>
                </div>
            </div>
        \`;
        
        // Detailed Credit Stats
        let totalLimit = 0;
        let totalUsage = 0;
        
        accounts.forEach(acc => {
           if (acc.status !== 'error' && acc.status !== 'disabled') {
               totalLimit += (acc.usage?.limit ?? 0);
               totalUsage += (acc.usage?.current ?? 0);
           }
        });
        
        const remaining = totalLimit - totalUsage;
        const rate = totalLimit > 0 ? (totalUsage / totalLimit * 100) : 0;
        
        document.getElementById('credit-stats-card').style.display = 'block';
        document.getElementById('dash-total-limit').textContent = totalLimit.toLocaleString();
        document.getElementById('dash-used').textContent = totalUsage.toLocaleString();
        document.getElementById('dash-remaining').textContent = remaining.toLocaleString();
        document.getElementById('dash-rate').textContent = rate.toFixed(1) + '%';
        
        document.getElementById('dash-progress-text').textContent = \`\${totalUsage.toLocaleString()} / \${totalLimit.toLocaleString()}\`;
        document.getElementById('dash-progress-bar').style.width = Math.min(rate, 100) + '%';
        
        if (rate > 90) document.getElementById('dash-progress-bar').style.background = '#ef4444';
        else if (rate > 70) document.getElementById('dash-progress-bar').style.background = '#f59e0b';
        else document.getElementById('dash-progress-bar').style.background = 'var(--primary)';
      }

      async function refreshUsage() {
        const btn = document.getElementById('refresh-usage-btn');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = t('refreshingUsage');
        try {
          const res = await fetch('/admin/usage/refresh', { method: 'POST', headers: headers() });
          const result = await res.json();
          if (!res.ok) {
            throw new Error(result?.error || 'Failed');
          }
          await loadData();
          btn.textContent = t('refreshUsageDone');
        } catch (e) {
          alert(t('refreshUsageFailed'));
          btn.textContent = t('refreshUsage');
        }
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = t('refreshUsage');
        }, 1500);
      }

      async function updateProxy() {
        const payload = {
          enabled: document.getElementById('proxyEnabled').checked,
          port: parseInt(document.getElementById('proxyPort').value, 10),
          apiKey: document.getElementById('proxyApiKey').value
        };
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = t('updating');
        
        try {
            await fetch('/admin/proxy', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers() }, body: JSON.stringify(payload) });
            await loadData();
            btn.textContent = t('settingsApplied');
        } catch(e) {
            alert(t('errorUpdating'));
            btn.textContent = t('applySettings');
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = t('applySettings'); }, 2000);
      }

      document.getElementById('importForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const form = e.target;
        const btn = form.querySelector('button[type="submit"]');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = t('importing');
        
        const data = new FormData(form);
        try {
            const res = await fetch('/admin/account', { method: 'POST', headers: headers(), body: data });
            const result = await res.json();
             document.getElementById('importResult').innerHTML = result.error ? 
                \`<span style="color: var(--danger)">Error: \${result.error}</span>\` : 
                \`<span style="color: var(--primary)">\${t('successAdded')} \${result.account.email}</span>\`;
            if (result.ok) {
                form.reset();
                // Reset file labels
                form.querySelectorAll('.file-name').forEach(span => {
                    span.textContent = t('noFileChosen');
                    span.style.color = 'var(--text-secondary)';
                });
                await loadData();
            }
        } catch (e) {
            document.getElementById('importResult').textContent = t('uploadFailed');
        }
        btn.disabled = false;
        btn.textContent = originalText;
      });

      // Init
      initAuth();
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
    if (req.method === 'POST' && url.pathname === '/admin/usage/refresh') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      if (!options.refreshUsageForAvailableAccounts) {
        return sendJson(res, 400, { error: 'Refresh usage not supported' })
      }
      const result = await options.refreshUsageForAvailableAccounts()
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (req.method === 'POST' && url.pathname === '/admin/account') {
      if (!isAuthorized(req, apiKey)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
      const addAccountFn = options.addAccountFromOidcFiles
      if (!addAccountFn) {
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
          const result = await addAccountFn(tokenJson, clientJson)
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
    const tokenEstimate = estimateTokenCount(requestBody)
    const contextWarning = buildContextWarning(tokenEstimate)

    const isOpenAI = url.pathname === '/v1/chat/completions'
    const isClaude = url.pathname === '/v1/messages'
    if (!isOpenAI && !isClaude) {
      return sendJson(res, 404, { error: 'Unsupported endpoint' })
    }

    // Kiro API 支持 OpenAI 格式，直接使用原始请求体
    // 只对 Claude 端点进行过滤处理
    let apiRequestBody = requestBody

    if (!isOpenAI) {
      // Claude 端点：过滤 Claude Code 特征，防止 Kiro 检测
      apiRequestBody = sanitizeClaudeCodeTools(requestBody)
    }

    const accountData = await getAccountData()
    const accounts = Object.entries(accountData?.accounts ?? {})
      .map(([, account]) => account)
      .filter((account) => account.credentials?.refreshToken)

    if (accounts.length === 0) {
      return sendJson(res, 503, { error: 'No accounts available' })
    }

    const now = Date.now()
    const eligible: Account[] = []
    for (const account of accounts) {
      const disabled = disabledUntil.get(account.id)
      if (disabled && disabled > now) {
        continue
      }
      if (disabled && disabled <= now) {
        disabledUntil.delete(account.id)
      }
      if (account.status === 'quota_exhausted' && account.quotaExhaustedUntil) {
        if (account.quotaExhaustedUntil > now) {
          continue
        }
        account.status = 'active'
        account.quotaExhaustedUntil = undefined
        if (options.updateAccountStatus) {
          await options.updateAccountStatus(account.id, {
            status: 'active',
            quotaExhaustedUntil: null,
            lastError: ''
          })
        }
      }
      eligible.push(account)
    }

    if (eligible.length === 0) {
      return sendJson(res, 503, { error: 'No healthy accounts available' })
    }

    let streamStarted = false
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

        // apiRequestBody 已准备好，直接使用

        if (requestBody?.stream) {
          if (isClaude) {
            for await (const chunk of kiroService.generateContentStream(model, apiRequestBody)) {
              if (!streamStarted) {
                res.writeHead(200, {
                  ...DEFAULT_HEADERS,
                  'content-type': 'text/event-stream',
                  'cache-control': 'no-cache',
                  connection: 'keep-alive'
                })
                streamStarted = true
                if (contextWarning) {
                  res.write(`event: warning\n`)
                  res.write(`data: ${JSON.stringify({ message: contextWarning, tokenEstimate })}\n\n`)
                }
              }
              const eventType = chunk?.type || 'message'
              res.write(`event: ${eventType}\n`)
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
            if (streamStarted) {
              res.end()
            }
            return
          }

          const created = Math.floor(Date.now() / 1000)
          let openaiId = `chatcmpl_${Date.now()}`

          for await (const chunk of kiroService.generateContentStream(model, apiRequestBody)) {
            if (!chunk) continue
            if (!streamStarted) {
              res.writeHead(200, {
                ...DEFAULT_HEADERS,
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive'
              })
              streamStarted = true
              if (contextWarning) {
                res.write(
                  `data: ${JSON.stringify(
                    buildOpenAIStreamChunk(openaiId, model, created, { role: 'assistant' }, null)
                  )}\n\n`
                )
                res.write(
                  `data: ${JSON.stringify(
                    buildOpenAIStreamChunk(openaiId, model, created, { content: `[Warning] ${contextWarning}` }, null)
                  )}\n\n`
                )
              }
            }
            if (chunk.type === 'message_start' && chunk.message?.id) {
              openaiId = chunk.message.id
            }
            const openaiChunks = convertClaudeStreamChunkToOpenAIChunks(chunk, model, openaiId, created)
            if (!openaiChunks || openaiChunks.length === 0) continue
            for (const openaiChunk of openaiChunks) {
              res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`)
            }
          }

          if (streamStarted) {
            res.write('data: [DONE]\n\n')
            res.end()
          }
          return
        }

        const result = await kiroService.generateContent(model, apiRequestBody)
        if (isOpenAI) {
          const payload: any = claudeToOpenAIResponse(result)
          if (contextWarning) payload.warning = contextWarning
          return sendJson(res, 200, payload)
        }
        const payload = contextWarning ? { ...result, warning: contextWarning } : result
        return sendJson(res, 200, payload)
      } catch (error: any) {
        lastError = error?.message || String(error)
        const statusCode = error?.response?.status

        // 第二道防线：区分错误类型，保护号池
        // 无 statusCode 表示本地错误（网络超时、连接失败等），不是账号问题
        // 这种情况不应该冷却账号，直接返回错误
        if (statusCode === undefined) {
          logger.warn(`[Proxy] Local error (not account issue): ${lastError}`)
          if (streamStarted || res.headersSent) {
            if (!res.writableEnded) {
              res.end()
            }
            return
          }
          return sendJson(res, 502, { error: lastError || 'Upstream connection failed' })
        }

        // 400：请求格式被 API 拒绝，不是账号问题，不冷却账号
        if (statusCode === 400) {
          const errPayload: any = { error: lastError || 'Bad Request' }
          if (contextWarning) {
            errPayload.warning = contextWarning
            errPayload.tokenEstimate = tokenEstimate
          }
          logger.warn(`[Proxy] Request rejected (400): ${lastError}`)
          if (streamStarted || res.headersSent) {
            if (!res.writableEnded) {
              res.end()
            }
            return
          }
          return sendJson(res, 400, errPayload)
        }

        // 402：额度不足，冷却至下月
        if (statusCode === 402) {
          const resetAt = getNextMonthStartMs()
          disabledUntil.set(account.id, resetAt)
          account.status = 'quota_exhausted'
          account.quotaExhaustedUntil = resetAt
          if (options.updateAccountStatus) {
            await options.updateAccountStatus(account.id, {
              status: 'quota_exhausted',
              quotaExhaustedUntil: resetAt,
              lastError
            })
          }
          logger.warn(
            `[Proxy] Account ${account.email} quota exhausted, disabled until ${new Date(resetAt).toISOString()}`
          )
        } else {
          // 其他 API 错误（401、403、429、500等）：账号问题，进入冷却期，继续尝试下一个账号
          disabledUntil.set(account.id, Date.now() + cooldownMs)
          logger.warn(`[Proxy] Account ${account.email} failed (${statusCode}), cooldown ${cooldownMs}ms: ${lastError}`)
        }
        if (streamStarted || res.headersSent) {
          if (!res.writableEnded) {
            res.end()
          }
          return
        }
      }
    }

    if (!res.headersSent) {
      return sendJson(res, 502, { error: lastError || 'Upstream failure' })
    }
  })

  server.listen(port, '0.0.0.0', () => {
    logger.log(`[Proxy] Kiro API proxy listening on http://0.0.0.0:${port}`)
  })

  return server
}
