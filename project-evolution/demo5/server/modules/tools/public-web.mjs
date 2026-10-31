import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["168.63.129.16", 32], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["192.88.99.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) {
  blocked.addSubnet(address, prefix, "ipv4");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) blocked.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入完整的 http:// 或 https:// 网页地址。"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port ||
      (!host.includes(".") && !isIP(host)) || /(?:^|\.)(?:localhost|local|internal|test|invalid|onion)$/.test(host) ||
      (isIP(host) && !isPublicAddress(host))) throw new Error("只允许访问公开 HTTP/HTTPS 网站的标准端口，不能访问本机、内网或携带账号的地址。");
  url.hash = "";
  return url;
}

export async function publicTarget(value, resolve = lookup, { allowProxyFakeIp = false } = {}) {
  const url = publicUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  const fakeIp = item => /^198\.(18|19)\./.test(item.address);
  // 本地调试默认信任代理的 Fake-IP 映射；这不是生产级 SSRF 隔离。
  // 仅对 HTTPS 域名生效，保留 TLS 证书校验；直接输入保留 IP 仍由 publicUrl 拒绝。
  const trustProxy = allowProxyFakeIp && url.protocol === "https:" && !isIP(host);
  if (!trustProxy && addresses.some(fakeIp)) throw new Error("目标域名解析到代理 Fake-IP 非公网网段。严格模式或 HTTP 请求不接受此映射，请使用 HTTPS 或真实 IP 解析。");
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) && !(trustProxy && fakeIp(item)))) throw new Error("目标域名解析到非公网地址，已阻止访问。");
  return { url, addresses };
}

// DNS 检查后固定连接到检查过的 IP；每次重定向重新校验，不继承代理/认证/cookie。
export async function fetchPublic(value, { signal = AbortSignal.timeout(20000), resolve = lookup, request,
  maxBytes = 2 * 1024 * 1024, allowProxyFakeIp = process.env.NODE_ENV !== "production" } = {}) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const { url, addresses } = await publicTarget(value, resolve, { allowProxyFakeIp });
    signal.throwIfAborted();
    const response = await new Promise((accept, reject) => {
      const req = (request || (url.protocol === "https:" ? https.request : http.request))(url, {
        agent: false, signal,
        headers: { "user-agent": "KnowledgeAssistant/1.0", accept: "text/html,text/plain;q=0.9", "accept-encoding": "identity" },
        lookup(_host, options, callback) {
          const selected = addresses.filter(item => !options.family || item.family === options.family);
          if (!selected.length) return callback(new Error("目标没有可用的公网地址。"));
          callback(null, ...(options.all ? [selected] : [selected[0].address, selected[0].family]));
        }
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.destroy();
          if (!res.headers.location) return reject(new Error("网页重定向缺少目标地址。"));
          try { return accept({ redirect: new URL(res.headers.location, url).href }); }
          catch { return reject(new Error("网页重定向地址无效。")); }
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy(); return reject(new Error(`网页请求失败（HTTP ${res.statusCode}）；可能被网站限流或拒绝访问。`));
        }
        const type = res.headers["content-type"] || "";
        if (!/^(text\/(html|plain)|application\/xhtml\+xml)\b/i.test(type) || res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          res.destroy(); return reject(new Error("当前只读取未压缩的 HTML/纯文本网页，不支持 PDF、附件或此响应格式。"));
        }
        if (Number(res.headers["content-length"]) > maxBytes) { res.destroy(); return reject(new Error("网页超过 2 MiB 读取上限。")); }
        let size = 0;
        const chunks = [];
        res.on("error", reject);
        res.on("data", chunk => {
          size += chunk.length;
          if (size > maxBytes) res.destroy(new Error("网页超过 2 MiB 读取上限。"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const encoding = type.match(/charset=["']?([^\s;"']+)/i)?.[1] || "utf-8";
            accept({ url: url.href, contentType: type, text: new TextDecoder(encoding).decode(Buffer.concat(chunks)) });
          } catch { reject(new Error("网页字符编码不受支持。")); }
        });
      });
      req.on("error", reject);
      req.end();
    });
    if (!response.redirect) return response;
    value = response.redirect;
  }
  throw new Error("网页重定向次数过多，已停止访问。");
}
