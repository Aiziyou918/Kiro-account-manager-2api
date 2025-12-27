# Kiro 账户管理器 v1.2.9 更新说明

## 新增功能
- **本地 API 代理服务**：内置 HTTP 服务，支持 OpenAI 兼容 `/v1/chat/completions` 和 Claude 兼容 `/v1/messages`
- **模型列表接口**：新增 `/v1/models` 返回可用模型列表
- **负载均衡与容错**：账号池轮询分配，请求失败自动下线并在冷却期后恢复
- **外网访问支持**：默认监听 `0.0.0.0`，局域网设备可直接访问
- **UI 配置**：设置页新增“本地 API 代理”开关、端口与 API Key 配置
- **Web 管理页**：`/admin` 提供轻量账号管理、代理开关与 OIDC 文件导入

## 配置说明
- **端口**：默认 `3001`，可在设置页修改
- **鉴权**：支持 `Authorization: Bearer <API_KEY>` 或 `x-api-key: <API_KEY>`
- **健康检查**：`/health` 返回服务状态
- **OIDC 导入**：管理页上传 `kiro-auth-token.json` + 同目录的 client 凭据 JSON

## 使用示例
```bash
# OpenAI 兼容
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model":"claude-opus-4-5","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Claude 兼容
curl http://127.0.0.1:3001/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model":"claude-opus-4-5","messages":[{"role":"user","content":[{"type":"text","text":"Hello"}]}],"stream":false}'

# 模型列表
curl http://127.0.0.1:3001/v1/models \
  -H "Authorization: Bearer <API_KEY>"
```
