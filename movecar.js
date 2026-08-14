/**
 * 车主挪车通知系统
 * Cloudflare Worker 实现企业微信消息推送
 */

// ==================== 配置 ====================
const config = {
  phoneNumber: typeof PHONE_NUMBER !== 'undefined' ? PHONE_NUMBER : '',
  corpId: typeof CORP_ID !== 'undefined' ? CORP_ID : '',
  corpSecret: typeof CORP_SECRET !== 'undefined' ? CORP_SECRET : '',
  touser: typeof USER !== 'undefined' ? USER : '',
  agentId: typeof AGENT_ID !== 'undefined' ? AGENT_ID : '',
  baseUrl: typeof BASE_URL !== 'undefined' ? BASE_URL : 'https://qyapi.weixin.qq.com',

  validate() {
    const required = ['corpId', 'corpSecret', 'touser', 'agentId'];
    const missing = required.filter(key => !this[key]);
    if (missing.length > 0) {
      throw new Error(`缺少必要的环境变量: ${missing.join(', ')}`);
    }
    return true;
  }
};

// ==================== 常量 ====================
const MAX_MESSAGE_LENGTH = 500; // 单条消息最大长度（企业微信文本上限 2048 字节，此处留余量）

// ==================== 频率限制（内存，按 isolate 隔离） ====================
// 说明：Cloudflare Workers 每个 isolate 内存独立，内存计数无法跨 isolate 共享，
// 因此只能防同 isolate 内的常规刷量，无法防分布式攻击。如需跨 isolate 强限制，
// 应改用 KV 绑定（本迭代未引入）。
const rateLimiter = {
  windowMs: 60 * 1000,
  max: 5,
  hits: new Map(),
  check(ip) {
    const now = Date.now();
    const arr = (this.hits.get(ip) || []).filter(t => now - t < this.windowMs);
    this.hits.set(ip, arr);
    if (arr.length >= this.max) return false;
    arr.push(now);
    this.hits.set(ip, arr);
    return true;
  }
};

// ==================== 响应工具 ====================
const ResponseUtils = {
  json(data, status = 200, headers = {}) {
    const defaultHeaders = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
    return new Response(JSON.stringify(data), { status, headers: { ...defaultHeaders, ...headers } });
  },

  html(content) {
    return new Response(content, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=300'
      }
    });
  },

  success(message = '操作成功') {
    return this.json({ success: true, message });
  },

  error(message, status = 500) {
    return this.json({ success: false, message }, status);
  }
};

// 北京时间格式化 YYYY-MM-DD HH:mm
function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date).replace(/\//g, '-');
}

// 国家代码 → 中文名（常见情况）
const COUNTRY_CN = { CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾' };

// 组装通知页脚：时间 + 设备 + IP + 归属地/运营商(IP 衍生，故 IP 在前)
function buildFooter(deviceInfo, ip, geo) {
  const lines = [`📅 时间：${formatTime()}`];
  const dev = [deviceInfo && deviceInfo.os, deviceInfo && deviceInfo.browser]
    .filter(Boolean);
  if (dev.length) lines.push(`📱 设备：${dev.join(' · ')}`);
  if (ip && ip !== '未知IP') lines.push(`🌐 IP：${ip}`);
  if (geo) {
    const country = COUNTRY_CN[geo.country] || geo.country || '';
    const loc = [geo.region, geo.city].filter(Boolean).join(' ');
    const locStr = [country, loc].filter(Boolean).join(' ');
    if (locStr) lines.push(`📍 归属地：${locStr}`);
    if (geo.org) lines.push(`🏢 ${geo.org}`);
  }
  return `\n\n${lines.join('\n')}`;
}

// ==================== 企业微信 API ====================
class WeChatAPI {
  constructor(config) {
    this.config = config;
    this.tokenCache = { accessToken: null, expiresAt: 0 };
  }

  async getAccessToken() {
    if (this.tokenCache.accessToken && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    try {
      const url = `${this.config.baseUrl}/cgi-bin/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.corpSecret}`;
      const response = await this.fetchWithTimeout(url);
      const data = await response.json();

      if (data.errcode && data.errcode !== 0) {
        throw new Error(`获取 token 失败: ${data.errmsg} (${data.errcode})`);
      }
      if (!data.access_token) {
        throw new Error('获取 token 失败: 未返回 access_token');
      }

      this.tokenCache = {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 300) * 1000
      };

      return data.access_token;
    } catch (error) {
      // 仅记录详情，对外返回通用文案
      console.error('getAccessToken error:', error.message);
      throw new Error('通知服务暂时不可用');
    }
  }

  async sendTextMessage(content) {
    try {
      const accessToken = await this.getAccessToken();

      const messageData = {
        touser: this.config.touser,
        msgtype: 'text',
        agentid: this.config.agentId,
        text: { content: `🚗 挪车提醒：\n\n${content}` }
      };

      const url = `${this.config.baseUrl}/cgi-bin/message/send?access_token=${accessToken}`;
      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageData)
      });

      const result = await response.json();

      if (result.errcode !== 0) {
        console.error('WeChat send failed:', result.errmsg, result.errcode);
        throw new Error('通知发送失败，请稍后重试');
      }

      return { success: true, messageId: result.msgid };
    } catch (error) {
      console.error('sendTextMessage error:', error.message);
      return { success: false, message: '发送失败，请稍后重试' };
    }
  }

  async fetchWithTimeout(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(id);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      clearTimeout(id);
      if (error.name === 'AbortError') {
        throw new Error('请求超时，请稍后重试');
      }
      throw error;
    }
  }
}

// ==================== API 处理器 ====================
class APIHandler {
  constructor(weChatAPI) {
    this.weChat = weChatAPI;
  }

  async notifyOwner(ip = '', deviceInfo = null, geo = null) {
    const message = '您好，有人需要您挪车，请尽快处理，谢谢🙏';
    const result = await this.weChat.sendTextMessage(message + buildFooter(deviceInfo, ip, geo));
    return result.success ? ResponseUtils.success('已通知车主') : ResponseUtils.error(result.message);
  }

  async sendMessage(data, ip = '', geo = null) {
    if (!data.message || !data.message.trim()) {
      return ResponseUtils.error('信息不能为空', 400);
    }

    const message = data.message.trim();
    if (message.length > MAX_MESSAGE_LENGTH) {
      return ResponseUtils.error(`信息过长（最多 ${MAX_MESSAGE_LENGTH} 字）`, 400);
    }

    const fullMessage = `💬 访客信息：\n${message}` + buildFooter(data.deviceInfo, ip, geo);
    const result = await this.weChat.sendTextMessage(fullMessage);
    return result.success ? ResponseUtils.success('已发送') : ResponseUtils.error(result.message);
  }

  async healthCheck() {
    try {
      config.validate();
      return ResponseUtils.json({ status: 'ok', timestamp: Date.now() });
    } catch (error) {
      return ResponseUtils.error(error.message, 503);
    }
  }
}

// ==================== HTML 页面 ====================
const HTMLPage = {
  generate() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>挪车提醒</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', sans-serif;
      background: #ededed;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .card {
      background: #ffffff;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      padding: 24px;
      width: 100%;
      max-width: 400px;
      animation: fadeIn 0.3s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .icon {
      text-align: center;
      font-size: 48px;
      margin-bottom: 16px;
    }

    .header {
      text-align: center;
      margin-bottom: 24px;
    }

    .header h1 {
      font-size: 18px;
      font-weight: 500;
      color: #1a1a1a;
      margin-bottom: 8px;
    }

    .header p {
      font-size: 14px;
      color: #999999;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 20px;
    }

    .btn {
      width: 100%;
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 500;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background-color 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn:active:not(:disabled) {
      transform: scale(0.98);
    }

    .btn-primary {
      background-color: #07c160;
      color: white;
    }

    .btn-primary:active:not(:disabled) {
      background-color: #06ae56;
    }

    .btn-secondary {
      background-color: #f2f2f2;
      color: #1a1a1a;
    }

    .btn-secondary:active:not(:disabled) {
      background-color: #e5e5e5;
    }

    .divider {
      height: 1px;
      background: #eeeeee;
      margin: 20px 0;
    }

    .message-section {
      margin-bottom: 8px;
    }

    .label {
      font-size: 14px;
      font-weight: 500;
      color: #1a1a1a;
      margin-bottom: 8px;
      display: block;
    }

    textarea {
      width: 100%;
      padding: 10px 12px;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-family: inherit;
      resize: none;
      outline: none;
      min-height: 80px;
      transition: background-color 0.2s;
      background: #f5f5f5;
    }

    textarea:focus {
      background: #eeeeee;
    }

    textarea::placeholder {
      color: #aaa;
    }

    .toast {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 12px 24px;
      border-radius: 6px;
      font-size: 15px;
      font-weight: 500;
      color: white;
      display: none;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.75);
      animation: toastIn 0.2s ease-out;
    }

    @keyframes toastIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    @media (max-width: 480px) {
      .card { padding: 32px 24px; }
      .toast { left: 20px; right: 20px; transform: translateY(-50%); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🚗</div>
      <div class="header">
        <h1>抱歉，挡到您了</h1>
        <p>请点下方按钮通知车主挪车</p>
      </div>

    <div class="actions">
        <button class="btn btn-primary" id="notifyBtn" onclick="app.notifyOwner()">
          <span>👆</span>
          <span>一键通知挪车</span>
        </button>
      ${config.phoneNumber ? `
      <button class="btn btn-secondary" id="callBtn" onclick="app.callOwner()">
        <span>📞</span>
        <span>拨打车主电话</span>
      </button>
      ` : ''}
    </div>

    <div class="divider"></div>

    <div class="message-section">
        <label class="label">给车主发信息</label>
        <textarea id="messageContent" placeholder="请输入信息（最多 ${MAX_MESSAGE_LENGTH} 字）" maxlength="${MAX_MESSAGE_LENGTH}"></textarea>
        <button class="btn btn-primary" id="sendBtn" onclick="app.sendMessage()" style="margin-top: 12px;">
          <span>发送</span>
        </button>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    const app = {
      ownerPhone: ${JSON.stringify(config.phoneNumber)},

      setLoading(btn, loading) {
        btn.disabled = loading;
        const originalHtml = btn.getAttribute('data-original') || btn.innerHTML;
        if (loading) {
          btn.setAttribute('data-original', originalHtml);
          btn.innerHTML = '<div class="spinner"></div><span>发送中...</span>';
        } else {
          btn.innerHTML = originalHtml;
        }
      },

      showToast(msg, isSuccess) {
        const toast = document.getElementById('toast');
        toast.textContent = msg;
        toast.style.display = 'block';
        setTimeout(() => toast.style.display = 'none', 3000);
      },

      async notifyOwner() {
        this.setLoading(document.getElementById('notifyBtn'), true);
        try {
          const deviceInfo = this.getDeviceInfo();
          const res = await fetch('/notify-owner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceInfo })
          });
          const data = await res.json();
          this.showToast(data.message || '提醒已发送', data.success);
        } catch (e) {
          this.showToast('发送失败', false);
        } finally {
          this.setLoading(document.getElementById('notifyBtn'), false);
        }
      },

      callOwner() {
        if (!this.ownerPhone) {
          this.showToast('车主未留电话', false);
          return;
        }
        if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
          window.location.href = 'tel:' + this.ownerPhone;
        } else {
          this.showToast('请用手机拨打：' + this.ownerPhone, false);
        }
      },

      async sendMessage() {
        const msg = document.getElementById('messageContent').value.trim();
        if (!msg) {
          this.showToast('信息不能为空', false);
          return;
        }
        this.setLoading(document.getElementById('sendBtn'), true);
        try {
          const deviceInfo = this.getDeviceInfo();
          const res = await fetch('/send-message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, deviceInfo })
          });
          const data = await res.json();
          if (data.success) {
            this.showToast('消息已发送', true);
            document.getElementById('messageContent').value = '';
          } else {
            this.showToast(data.message || '发送失败', false);
          }
        } catch (e) {
          this.showToast('发送失败', false);
        } finally {
          this.setLoading(document.getElementById('sendBtn'), false);
        }
      },

      getDeviceInfo() {
        const ua = navigator.userAgent;
        let os = '未知系统';
        let browser = '未知浏览器';

        // 检测操作系统
        if (/Windows/.test(ua)) os = 'Windows';
        else if (/Mac OS X/.test(ua)) os = 'macOS';
        else if (/Linux/.test(ua)) os = 'Linux';
        else if (/Android/.test(ua)) os = 'Android';
        else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';

        // 检测浏览器
        if (/Chrome/.test(ua) && !/Edge|OPR/.test(ua)) browser = 'Chrome';
        else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
        else if (/Firefox/.test(ua)) browser = 'Firefox';
        else if (/Edge/.test(ua)) browser = 'Edge';
        else if (/MicroMessenger/.test(ua)) browser = '微信';

        return {
          os: os,
          browser: browser,
          userAgent: ua
        };
      }
    };
  </script>
</body>
</html>`;
  }
};

// ==================== 请求处理器 ====================
class RequestHandler {
  constructor() {
    this.weChat = new WeChatAPI(config);
    this.api = new APIHandler(this.weChat);
  }

  getGeo(request) {
    const cf = request.cf;
    if (!cf) return null;
    return {
      country: cf.country || '',
      region: cf.region || '',
      city: cf.city || '',
      org: cf.asOrganization || ''
    };
  }

  async handle(request) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;
      const method = request.method;

      // 获取客户端 IP
      const ip = request.headers.get('CF-Connecting-IP') ||
                 request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
                 request.headers.get('X-Real-IP') ||
                 '未知IP';

      // 获取客户端地理位置（request.cf 仅在请求经过 Cloudflare 边缘时存在）
      const geo = this.getGeo(request);

      // CORS 预检
      if (method === 'OPTIONS') {
        return ResponseUtils.success();
      }

      // API 路由
      if (pathname === '/notify-owner') {
        if (method !== 'POST') return ResponseUtils.error('方法不允许', 405);
        config.validate();
        if (!rateLimiter.check(ip)) return ResponseUtils.error('操作太频繁，请稍后再试', 429);
        let data;
        try {
          data = await request.json();
        } catch {
          return ResponseUtils.error('请求格式错误', 400);
        }
        return await this.api.notifyOwner(ip, data.deviceInfo, geo);
      }

      if (pathname === '/send-message') {
        if (method !== 'POST') return ResponseUtils.error('方法不允许', 405);
        config.validate();
        if (!rateLimiter.check(ip)) return ResponseUtils.error('操作太频繁，请稍后再试', 429);
        let data;
        try {
          data = await request.json();
        } catch {
          return ResponseUtils.error('请求格式错误', 400);
        }
        return await this.api.sendMessage(data, ip, geo);
      }

      if (pathname === '/health' && method === 'GET') {
        return await this.api.healthCheck();
      }

      // 默认：GET 返回 HTML 页面，其他方法返回 404
      if (method === 'GET') {
        return ResponseUtils.html(HTMLPage.generate());
      }
      return ResponseUtils.error('Not Found', 404);

    } catch (error) {
      // 对外不暴露内部错误细节
      console.error('Request error:', error);
      return ResponseUtils.error('服务器内部错误', 500);
    }
  }
}

// ==================== Worker 入口 ====================
const handler = new RequestHandler();

addEventListener('fetch', event => {
  event.respondWith(handler.handle(event.request));
});
