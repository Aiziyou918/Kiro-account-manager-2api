# Kiro 账户管理器 (Fork)

<p align="center">
  <img src="Kiro-account-manager/resources/icon.png" width="128" height="128" alt="Kiro Logo">
</p>

<p align="center">
  <strong>一个功能强大的 Kiro IDE 多账号管理工具</strong>
</p>

<p align="center">
  支持多账号快速切换、自动 Token 刷新、分组标签管理、机器码管理等功能
</p>


## ✨ 新增功能 (Fork 版)

本分支在原版基础上增加了轻量级后台和反代功能：

- **本地 HTTP 代理**: 兼容 OpenAI/Claude 格式，提供 `/v1/chat/completions` (支持流式输出 stream), `/v1/messages`, 和 `/v1/models` 接口
- **负载均衡**: 支持账号轮询池，请求失败自动冷却，并在恢复后自动重新加入
- **可视化配置**: 支持在 UI 设置中配置代理端口和 API Key
- **无缝集成**: 复用现有的账号存储和自动刷新逻辑，网页端导入账号后主程序即时同步
- **Web 管理后台**: 提供功能丰富的 Web 界面 `/admin`，支持远程管理

### 🚀 快速开始

1. 启动应用。
2. 进入 **设置** 页面，启用 "Local API Proxy"，并设置端口和 API Key。
3. 调用代理接口示例：

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

### 🌐 Web 管理后台 (增强版)

- **访问地址**: `http://<server-ip>:<port>/admin`
- **数据看板 (Dashboard)**:
    - 实时展示总账号数、活跃账号、已封禁和即将过期账号统计
    - **额度统计**: 可视化展示总额度、已用额度、剩余额度及使用率进度条
- **自动化管理**:
    - **自动轮询**: 页面数据每 5 秒自动刷新，实时监控账号状态
    - **多语言支持**: 内置中/英双语切换
- **功能**:
    - 远程导入 OIDC 凭证（支持拖拽文件），主程序界面自动同步刷新
    - 远程删除无效账号
    - 在线修改代理配置（端口、API Key、开关）

---

## ✨ 功能特性

### 🔐 多账号管理
- 支持添加、编辑、删除多个 Kiro 账号
- 一键快速切换当前使用的账号
- 支持 Builder ID 和 Social（Google/GitHub）登录方式
- 批量导入导出账号数据

### 🔄 自动刷新
- Token 过期前自动刷新，保持登录状态
- Token 刷新后自动更新账户用量、订阅等信息
- 开启自动换号时，定期检查所有账户余额

### 📁 分组与标签
- 通过分组和标签灵活组织管理账号
- 多选账户批量设置分组/标签
- 一个账户只能属于一个分组，但可以有多个标签

### 🔑 机器码管理
- 修改设备标识符，防止账号关联封禁
- 切换账号时自动更换机器码
- 为每个账户分配唯一绑定的机器码
- 支持备份和恢复原始机器码

### 🔄 自动换号
- 余额不足时自动切换到其他可用账号
- 可配置余额阈值和检查间隔

### 🎨 个性化设置
- 21 种主题颜色可选（按色系分组显示）
- 深色/浅色模式切换
- 隐私模式隐藏敏感信息

### 🌐 代理支持
- 支持 HTTP/HTTPS/SOCKS5 代理
- 内置 Local API Proxy (OpenAI/Claude 兼容)
- 所有网络请求通过代理服务器

### 🔄 自动更新检测
- 自动检测 GitHub 最新版本
- 显示更新内容和下载文件列表
- 一键跳转到下载页面

---

## 📸 界面预览

### 主页
显示账号统计、当前使用账号详情、订阅信息和额度明细。

![主页](Kiro-account-manager/resources/主页.png)

### 账户管理
管理所有账号，支持搜索、筛选、批量操作，一键切换账号。

![账户管理](Kiro-account-manager/resources/账户管理.png)

### 机器码管理
管理设备标识符，防止账号关联封禁，支持备份恢复。

![机器码管理](Kiro-account-manager/resources/机器码管理.png)

### 设置
配置主题颜色、隐私模式、自动刷新、代理等选项。

![设置](Kiro-account-manager/resources/设置.png)

### 关于
查看版本信息、功能列表、技术栈和作者信息。

![关于](Kiro-account-manager/resources/关于.png)

---

## 📖 使用说明

### 添加账号

1. 点击「账户管理」进入账号列表页面
2. 点击右上角「+ 添加账号」按钮
3. 输入账号的 SSO Token 或 OIDC 凭证
4. 点击确认完成添加

### 切换账号

1. 在账户管理页面找到目标账号
2. 点击账号卡片上的电源图标即可切换
3. 切换后 Kiro IDE 将使用新账号

### 批量设置分组/标签

1. 在账户管理页面勾选多个账号
2. 点击「分组」或「标签」按钮
3. 在下拉菜单中选择要添加或移除的分组/标签

### 机器码管理

1. 点击左侧「机器码」进入管理页面
2. 首次使用会自动备份原始机器码
3. 点击「随机生成并应用」可更换新机器码
4. 如需恢复，点击「恢复原始」即可

> ⚠️ **注意**：修改机器码需要管理员权限，请以管理员身份运行应用

### 导入导出

- **导出**：设置 → 数据管理 → 导出，支持 JSON、TXT、CSV、剪贴板多种格式
- **导入**：设置 → 数据管理 → 导入，从 JSON 文件恢复账号数据

---

## 🛠️ 技术栈

- **框架**: Electron + React + TypeScript
- **状态管理**: Zustand
- **样式**: Tailwind CSS
- **构建工具**: Vite
- **图标**: Lucide React

---

## 💻 开发指南

### 环境要求

- Node.js >= 18
- npm >= 9

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建应用

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

### 构建多架构版本

```bash
# Windows 64位
npx electron-builder --win --x64

# Windows 32位
npx electron-builder --win --ia32

# Windows ARM64
npx electron-builder --win --arm64

# macOS Intel
npx electron-builder --mac --x64

# macOS Apple Silicon
npx electron-builder --mac --arm64

# Linux 64位
npx electron-builder --linux --x64

# Linux ARM64
npx electron-builder --linux --arm64
```

---

## 🚀 自动构建 (GitHub Actions)

项目配置了 GitHub Actions 工作流，支持自动构建所有平台和架构：

### 支持的平台

| 平台 | 架构 | 格式 |
|------|------|------|
| Windows | x64, ia32, arm64 | exe, zip |
| macOS | x64, arm64 | dmg, zip |
| Linux | x64, arm64, armv7l | AppImage, deb, snap |

### 触发方式

1. **推送标签**: 推送 `v*` 格式的标签时自动构建并发布
   ```bash
   git tag v1.1.0
   git push origin v1.1.0
   ```

2. **手动触发**: 在 GitHub Actions 页面手动运行工作流

---

## 📋 更新日志

### v1.2.9 (2025-12-17)
- 🔍 **批量检查修复**: 批量检查现在和单个检查效果一致，能正确检测封禁状态
- 📤 **导出格式增强**: TXT 和剪贴板导出在勾选「包含凭证」时可直接用于导入
- 🏢 **Teams 订阅支持**: 新增 Teams 订阅类型识别
- 🎨 **机器码页面美化**: 全新设计的机器码管理页面，新增统计卡片和优化布局
- 🎯 **主题色统一**: 机器码管理页面颜色跟随用户选择的主题色变化

### v1.2.5 (2025-12-09)
- 🎨 **主题系统升级**: 主题颜色从 13 个增加到 21 个，按色系分组显示
- 📊 **额度统计**: 主页新增总额度统计卡片，实时汇总所有账号用量
- 💾 **多格式导出**: 支持 JSON、TXT、CSV、剪贴板等多种导出格式
- 🔧 **机器码优化**: 新增搜索功能和最后修改时间显示
- 🐛 **修复**: 修复部分主题颜色切换无效的问题

### v1.1.0
- 新增机器码管理功能
- 新增批量设置分组/标签功能
- 优化自动刷新，同步更新账户信息
- 新增 13 种主题颜色
- 界面优化和 Bug 修复

### v1.0.0
- 初始版本发布
- 支持多账号管理和切换
- 支持自动 Token 刷新
- 支持分组和标签管理
- 支持隐私模式和代理设置

---

## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

## 👨‍💻 作者

- **GitHub**: [chaogei](https://github.com/chaogei)
- **项目主页**: [Kiro-account-manager](https://github.com/chaogei/Kiro-account-manager)

---

## 🙏 致谢

感谢所有使用和支持本项目的用户！

如果这个项目对你有帮助，欢迎 Star ⭐ 支持一下！
