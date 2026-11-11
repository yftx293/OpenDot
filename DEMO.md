# 本地 Demo 免登录

默认关闭。只有 `MINICLAW_DEMO_OPEN=true` 时，从本机回环地址访问的未登录请求才会自动得到一个管理员会话。打开 `http://127.0.0.1:3000/` 时，`/api/auth/me` 直接返回该管理员，AuthGuard 不会把浏览器送到 `/login`。

这个开关只影响 Web Cookie 会话。`/api/cloud-runtime` 的 HMAC，以及 Worker 到 Authority 的签名校验，都不读取演示会话。

## 环境变量

| 变量                           | 默认            | 说明                                                        |
| ------------------------------ | --------------- | ----------------------------------------------------------- |
| `MINICLAW_DEMO_OPEN`           | 未设置（关闭）  | 只有精确等于 `true` 才开启                                  |
| `MINICLAW_DEMO_ADMIN_USERNAME` | `admin`         | 用户表为空时用来创建演示管理员                              |
| `MINICLAW_DEMO_ADMIN_PASSWORD` | `miniclaw-demo` | 同上，至少 8 位。已有管理员时不会重置密码                   |
| `PROVIDER_SETUP_SKIPPED`       | 未设置          | 没有 `system-settings.json` 时，`true` 会跳过 Provider 引导 |
| `TRUST_PROXY`                  | `false`         | 见下文                                                      |

`PROVIDER_SETUP_SKIPPED` 和系统设置里的 `providerSetupSkipped` 是同一项。已经在 Web 里保存过系统设置时，以文件为准，环境变量不会覆盖它。

## 谁能免登录

直接连到进程的 TCP 对端必须是 `127.0.0.1`、`::1`，或 IPv4 映射的 `::ffff:127.0.0.1`。

- `TRUST_PROXY` 未开启时，忽略 `X-Forwarded-For` 和 `X-Real-IP`。对端是回环就放行。
- `TRUST_PROXY=true` 时，对端仍必须是回环（本机反向代理），并且转发出来的客户端地址也必须是回环。公网用户即使经过本机 nginx，也不会拿到演示会话。
- 非回环对端自行带上 `X-Forwarded-For: 127.0.0.1` 无效。

如果进程前面有反向代理，又没有设置 `TRUST_PROXY=true`，远端用户在进程看来就是回环连接，会进入演示会话。对外服务不要开启 `MINICLAW_DEMO_OPEN`。

## 管理员账号

用户写入与 `npm run reset:admin` / `node dist/reset-admin.js` 共用同一套创建字段。

- 已有 active admin：沿用最早创建的那个，不改密码，也不撤销现有会话。
- 用户表为空：创建上面的默认管理员，并建立 Home 工作区。
- 有用户但没有 active admin：不自动提权，也不会免登录。

演示模式关闭后，自动创建的账号和口令仍然留在数据库里。把这个数据目录拿到其他机器上之前，先改掉密码或删掉该用户。

已有有效登录 Cookie 时不会被换成演示管理员。退出登录后，只要演示模式还开着，下一次回环访问会再次签入。

## 示例

```bash
MINICLAW_DEMO_OPEN=true PROVIDER_SETUP_SKIPPED=true npm start
```

然后打开 http://127.0.0.1:3000/ 。
