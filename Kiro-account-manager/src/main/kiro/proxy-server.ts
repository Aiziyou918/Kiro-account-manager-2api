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
      @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
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
        if(!state.locked) loadData();
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
         }, 500);
      }

      function logout() {
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

      async function loadData() {
        try {
            const res = await fetch('/admin/data', { headers: headers() });
            if (!res.ok) {
                 if (res.status === 401) alert('API Key Invalid or Missing / API 密钥无效或丢失');
                 return;
            }
            const data = await res.json();
            
            // Only update inputs if not currently focused (to avoid typing interruptions if auto-refresh)
            if(document.activeElement !== document.getElementById('proxyPort')) {
                 document.getElementById('proxyEnabled').checked = !!data.proxy.enabled;
                 document.getElementById('proxyPort').value = data.proxy.port || 3001;
            }
            
            const tbody = document.querySelector('#accountsTable tbody');
            tbody.innerHTML = '';
            
            if (data.accounts.length === 0) {
               tbody.innerHTML = '<tr><td colspan="3" class="muted" style="text-align: center; padding: 2rem;">' + t('noAccounts') + '</td></tr>';
            } else {
                data.accounts.forEach(acc => {
                  const tr = document.createElement('tr');
                  tr.innerHTML = \`
                    <td><div style="font-weight: 500">\${acc.email || 'Unknown'}</div><div class="muted" style="font-size: 0.75rem">\${acc.id}</div></td>
                    <td><span class="status-badge">\${acc.status || 'Active'}</span></td>
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
        } catch (e) {
            console.error(e);
        }
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
