# Mine Monopoly 游戏客户端

本目录是 monorepo 中的 Vue 3 / Vite 客户端，依赖 `../../packages` 的共享包。在线模式使用 `GameBackend/modules/monopoly` 提供的 Java 玩家接口和独立 PeerServer。

## 本机 Web 启动

使用 Node.js 24 和仓库指定的 pnpm。先在仓库根目录安装客户端及共享依赖：

```powershell
cd E:\games\mine-monopoly
pnpm install --frozen-lockfile --ignore-scripts --filter '@mine-monopoly/client...' --filter '@mine-monopoly/root'
Copy-Item apps/client/.env.example apps/client/.env.local
pnpm --filter @mine-monopoly/client dev
```

已有 `.env.local` 时直接编辑该文件。打开 **http://localhost:5173/**。默认 `dev` 启动 Web 模式；端口被占用时启动失败，不会悄悄换端口，避免 Peer Origin 不匹配。

启动前需要运行 Java SIT 服务和 PeerServer。当前默认配置为：

| 用途                  | 客户端请求路径        | 开发代理目标               |
| --------------------- | --------------------- | -------------------------- |
| 玩家 HTTP API         | `/monopoly-api`       | `https://192.168.1.3:7443` |
| Peer HTTP / WebSocket | `/monopoly-mine-peer` | `http://127.0.0.1:9003`    |
| 管理后台链接          | —                     | `http://localhost:7111`    |

Java HTTPS 开发代理用 `VITE_DEV_PROXY_CA_FILE` 指向公开 PEM 证书，默认位置是 `E:/games/GameBackend/tools/dev/classic-wss/local/classic-sit-server.pem`。更换地址或证书后同步修改 `.env.local` 并重启 Vite；证书必须包含后端地址，代理保留证书验证。

PeerServer 在 `GameBackend/modules/monopoly/peer-server` 中启动，使用已有 `start-sit.sh`，或 Windows 下在其目录运行 `pnpm start --origin http://localhost:5173`。详细部署参数见该目录 README。Origin 需与浏览器地址完整一致；`127.0.0.1`、局域网 IP 和 `localhost` 是不同 Origin，需要显式加入 PeerServer 的 `--origin` 参数。

## 登录和在线房间

注册使用 multipart 头像及账号资料；登录发送 Java 要求的 `useraccount/password`。ACCOUNT 凭据用于账号资料和区服列表，手动进入区服后取得 REALM 凭据，用于地图、房间和票据接口。玩家与现有 game-admin SYSTEM 登录使用各自原有入口。

游客只进入本地单人 / 派对模式。在线模式需有可用玩家账号、开放区服，以及该区服启用的正式地图。可在集成后的 game-admin 中配置区服、发布地图并启用区服地图，不自动创建测试账号、区服或地图。

房间号与 Java 房间资源 ID 分开使用。加入、创建和匹配使用 POST 及幂等请求号；新建时提交地图和人数，地图版本在创建时冻结。房主按租约与 epoch 就绪 / 保活；成员按实际 Peer ID 取得单次票据，房主向 Java 消费校验后允许游戏消息。Peer key `monopoly-mine` 只是公开协议标识。

房间响应必须包含冻结对象的 `mapUrl/mapHash`。客户端校验 SHA-256，并拒绝缺失资源或下载被篡改的地图；地图更新后已有房间继续使用原版本。需要重新编译并重启包含这些字段的 Java 服务。

ACCOUNT 刷新凭据轮换在当前标签页合并请求，并在支持 Web Locks 的浏览器中跨标签页互斥；Realm 失效时重新选择区服。切服、退出和离房释放原会话。既有关闭的后台自动初始化 / 定时任务配置继续保持关闭。

## 配置和构建

公共配置见 `.env.example`。这里只加载客户端目录的 Vite 环境文件。服务签名密钥、数据库密码、TURN 静态凭据不进入客户端配置。`VITE_MAP_ENCRYPT_KEY` 仅为现有 `.mmmap` 产品文件格式的可选解码参数；使用加密地图时需与发布端格式一致，浏览器可见，不能作为鉴权秘密。

Web 部署使用 HTTPS，反向代理 `/monopoly-api` 到 Java、`/monopoly-mine-peer` 到 PeerServer 并支持 WebSocket；`VITE_API_BASE_URL` 与 `VITE_PEER_SERVER_URL` 使用同源路径。`.env.example` 是本机开发模板，复制为 `.env.local` 使用；线上 Web 配置单独维护在 `.env.web`，其中 `VITE_WEB_BASE_PATH=/play/` 与当前生产 NGINX 对齐，部署需为前端路由提供 index.html 回退。

Vite 不会自动读取 `.env.example`。`dev` 使用 development 模式和本机 `.env.local`；`build:web` 使用 web 模式，加载 `.env` / `.env.local` 后再加载 `.env.web` / `.env.web.local`（如存在），模式专用文件中的同名配置覆盖本机值，终端环境变量优先级最高。`.env.web` 显式配置线上地址、访问前缀和地图格式参数，无需修改 `.env.local`。当前脚本不会加载 `.env.prod` 或 `.env.production`；`web` 模式名称仍对应 Vite 的生产构建。修改客户端配置后需重新打包，重载 NGINX 不会改变已经生成的前端配置。

`VITE_BACKEND_URL`、`VITE_DEV_PROXY_CA_FILE` 和 `VITE_PEER_PROXY_TARGET` 只配置 Vite 本机开发代理；线上请求由 NGINX 转发，不需要把 Java `7011` 或 PeerServer `9003` 端口写入浏览器地址。`VITE_GAME_ADMIN_URL` 是本机管理后台链接，当前 `game.conf` 没有生产管理后台静态入口。

```powershell
pnpm --filter @mine-monopoly/client check
pnpm --filter @mine-monopoly/client build:web
```

Web 必须使用 `build:web`，它运行 `vite build --mode web`；`build` / `build:electron` 会执行 Electron 桌面打包。仓库根目录的 `build-client` 也调用桌面 `build`，不能用作 Web 发布命令。

生产域名 `game.iskaola.com` 使用 `/play/` 入口。仓库内 `.env.web` 已配置对应前缀和同源服务路径，直接运行上面的 `build:web` 即可；也可在构建前用终端变量显式覆盖（PowerShell）：

```powershell
$env:VITE_WEB_BASE_PATH = "/play/"
$env:VITE_API_BASE_URL = "/monopoly-api"
$env:VITE_PEER_SERVER_URL = "/monopoly-mine-peer"
pnpm --filter @mine-monopoly/client build:web
```

将 `apps/client/dist/frontend/` 内全部文件上传到服务器 `/var/www/game/play/`，替换原 Unity 产物。Nginx 使用 `GameBackend/docker-prod/deploy/nginx/conf.d/game.conf`，页面路由回退到 `/play/index.html`，缺失静态资源返回 404。

PeerServer 的生产启动参数必须包含 `--origin https://game.iskaola.com`（不带 `/play`）。当前服务监听 `127.0.0.1:9003`，Nginx 需运行于同一宿主机，或使用 Linux Docker host 网络；普通 bridge 容器内的 `127.0.0.1` 无法访问宿主机 PeerServer。容器部署还需挂载 `/var/www/game`。

在服务器将配置安装到 Nginx 实际加载的 `conf.d/game.conf` 后，执行：

```sh
nginx -t && nginx -s reload
curl -I https://game.iskaola.com/play
curl -I https://game.iskaola.com/play/
curl -I https://game.iskaola.com/play/login
curl -i https://game.iskaola.com/monopoly-mine-peer/monopoly-mine/id
```

预期依次为跳转至 `/play/`、HTML 页面、前端路由 HTML、Peer ID。最后还需在浏览器确认信令 WebSocket 返回 101；HTTP 检查不能代替 WebSocket 和实际对局验证。Java 的 `application.yml` 与 `application-prod.yml` 保持现有配置。

产物在 `apps/client/dist/frontend`。Electron 使用 `dev:electron` / `build:electron`；以上 Web 安装步骤跳过依赖安装脚本，需要 Electron 时再按桌面环境安装其运行时。Electron / Capacitor 原生发布应显式配置绝对 HTTPS API 和 Peer URL，浏览器开发代理不随打包产物一起发布。本次验证范围是 Web。

## 协议回归

```powershell
node --test apps/client/src/utils/auth/session.test.mjs
node apps/client/scripts/test-room-api.cjs
node --test apps/client/src/core/network/tests/peer-protocol.test.cjs
```

这些检查覆盖真实 Axios 拦截器、凭据隔离 / 刷新竞态、房间请求契约、冻结地图 / 完整性、退出补偿和 Peer 准入。浏览器验证中的登录与选服使用测试数据；真实跨设备、跨公网 WebRTC / TURN 对局需在准备好账号、区服、地图后联调。

## 目录

- `src/utils/api`：Java HTTP 接口及 DTO 适配。
- `src/utils/auth`：ACCOUNT / REALM 会话与切服、退出。
- `src/core/network`：Peer 准入、连接生命周期和重连。
- `src/core/monopoly-host`、`src/core/worker`：房主协调与既有游戏规则。
- `src/utils/file`：地图下载、校验与解析。
- `src/views/login`、`src/views/room_router`、`src/views/room`：登录、区服、大厅和房间界面。
