# nginx 限流 + fail2ban（生产安全层）

## 文件与安装位置

| 文件 | 安装位置 |
|---|---|
| `ratelimit.conf` | `/etc/nginx/conf.d/ratelimit.conf`（http 层 zone） |
| `treening-site.conf` | `/etc/nginx/sites-enabled/treening`（server 块含限流 location） |
| `filter-treening-scan.conf` | `/etc/fail2ban/filter.d/treening-scan.conf` |
| `filter-treening-http.conf` | `/etc/fail2ban/filter.d/treening-http.conf` |
| `jail.local` | `/etc/fail2ban/jail.local` |

## 行为

- **nginx 限流**（应用层之前的粗筛）：
  - `/api/auth/`：10r/m + burst 10 → 登录/注册防爆破
  - `/api/`：240r/m + burst 60 → 挡扫描器循环，不误伤学习轮询（轮询 ~1.4r/s）
- **fail2ban**（基于 access.log 的事后封禁）：
  - `treening-scan`：扫描特征（wp-login/.env/.git/actuator 等）300s 内 3 次 → 封 24h
  - `treening-http-429`：60s 内 10 个 429 → 封 1h

## 操作

```bash
nginx -t && systemctl reload nginx          # 改 nginx 配置后
fail2ban-client status                      # 查看全部 jail
fail2ban-client status treening-scan        # 查看某 jail 的封禁
fail2ban-client set treening-scan unbanip <IP>   # 误封解禁
```

## 验证记录（2026-08-11）

- auth 限流：连打 15 次 `/api/auth/login`，第 12 个起 429 ✓
- filter regex：`fail2ban-regex` 对真实 access.log 匹配 4 个 429、扫描样例 2 个 ✓
- ban/unban：`set banip 203.0.113.99` → iptables REJECT 出现 → `unbanip` 后移除 ✓
