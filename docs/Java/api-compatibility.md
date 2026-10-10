# Java 接口与客户端兼容清单

> 本文描述原 39 个接口及旧兼容方案。当前三端统一升级至 `/monopoly-api`、ACCOUNT／REALM 与 Result，以 [GameBackend monopoly 模块迁移升级方案](gamebackend-monopoly-upgrade-plan.md)中的接口映射和鉴权矩阵为准，不再要求兼容旧 token、旧登录加密或旧返回形态。

范围与排期见[任务总览](README.md)。本清单以现有 Express 挂载路径为准，路径不含反向代理的 `API_BASE_PREFIX`。共 **39 个业务接口**，另列健康检查、文件、后台静态服务和 PeerServer。

目标是保留现有三端可观察的业务契约，并对明确列出的缺陷进行配套修正。所有路由都需要正常、缺参数、权限不足和依赖故障样例；不能仅验证“HTTP 200 可访问”。以下“原认证”描述源码现状，不表示所有行为都应照搬。

## 请求与返回规则

| 契约 | 迁移要求 |
| --- | --- |
| 通常返回 | `{status, msg?, data?}`；HTTP 状态码与 status 一致，省略字段与 null 按旧样例处理 |
| JWT 请求头 | 现有两端会发送裸 `Authorization: <token>`；Java 同时兼容裸 token 和 `Bearer <token>` |
| API Key | `X-Api-Key`，与 JWT 分开认证；不能统一换成 Bearer 后要求编辑器改登录流程 |
| 房主租约 | opaque 字符串 `hostLeaseToken`，与用户 JWT 独立；不要在列表、错误和日志中返回它 |
| 分页与类型 | 默认 page=1、size=8；布尔值、数值、nullable 限制、统计 SQL count 等按采集样例确定 |
| 日期与时间 | 用户列表日期为既有格式；JWT exp/iat 修正为秒；房间时间、duration、heartbeatIntervalMs 为毫秒 |
| 请求重试 | GET join 会创建房间，不得缓存；创建/审核/重置 Key 等写操作不能被代理无条件重放 |
| 文件地址 | 原本地 `/static/...`、COS URL、API 前缀和域名继续有效；文件字节、地图加密方式不变 |
| 异常 | 不返回堆栈或内部凭证；将挂起/无结果的错误分支修成明确响应时写入差异记录 |

## 用户接口 14 项

原认证中“管理员”来自总中间件的默认保护，“登录”目前只有 `/user/info`。

| 编号 | 方法与路径 | 原认证与主要输入 | 返回和必须验收的行为 |
| --- | --- | --- | --- |
| U01 | GET `/user/is-admin` | 管理员；Authorization | `data.isAdmin=true`；缺 token 401，普通用户 403 |
| U02 | GET `/user/list` | 管理员；page/size、search、online/isAdmin/isCreator、排序参数 | `data={total,current,userList}`；用户名/账号搜索、字段排序白名单、mapCount、当日次数、可空限制、active mapKey；记录 Key 查看审计 |
| U03 | POST `/user/key` | 管理员；JSON userId | 要求用户为创作者；已有 active Key 为 409；返回 Key 数据 |
| U04 | POST `/user/key/reset` | 管理员；JSON userId | reset/upsert 后返回 Key；旧 Key 失效；原路由与 generate 的创作者检查不同，不可假定完全相同 |
| U05 | POST `/user/key/revoke` | 管理员；JSON userId | 返回吊销结果或 null；重复调用不重新生成 Key |
| U06 | POST `/user/key/reset-upload-count` | 管理员；JSON userId | `data.todayUploaded=0`，保留审计 |
| U07 | GET `/user/info` | 登录；Authorization | 用户安全信息；handler 虽支持 query token，但总中间件先要求 header，不能宣称 query-only 现已受支持 |
| U08 | GET `/user/encryption-key` | 公开 | `data` 为登录传输加密密钥的 64 位 hex 字符串；与 MAP_ENCRYPT_KEY 无关 |
| U09 | POST `/user/create` | 管理员；JSON useraccount/username/password/color/isAdmin/isCreator | password 是加密文本；目标返回安全 DTO，去除原实体泄露的 password/salt；首管理员引导见 C08 |
| U10 | POST `/user/update` | 管理员；JSON id 和可选用户/权限/限制字段 | 省略不改、null 清空、false 取消；取消创作者联动吊销 Key；密码为空/未传与真正修改分开处理 |
| U11 | DELETE `/user/delete` | 管理员；query id | 保留删除用户与地图关联结果的必要字段，脱敏用户；缺 id 改 400，不能复制原不返回响应分支；已发布地图保留解绑 |
| U12 | POST `/user/login` | 公开；JSON useraccount/password | `data={token,refreshToken}`；错误凭证/参数 400；限流 10 次/分钟；更新在线状态 |
| U13 | POST `/user/refresh-token` | 公开入口；JSON refreshToken 自身认证 | 返回新 token/refreshToken；缺参数 400、无效/到期/错误类型 401；必须查当前用户和权限 |
| U14 | POST `/user/register` | 公开；multipart avatar 和账号/昵称/加密密码/颜色 | avatar 必填，2 MiB；5 次/小时；失败清理临时/已上传文件；返回安全用户 DTO |

## 地图接口 12 项

| 编号 | 方法与路径 | 原认证与主要输入 | 返回和必须验收的行为 |
| --- | --- | --- | --- |
| M01 | GET `/game-map/key/info` | X-Api-Key | username、quota、used、uploadSizeLimit、dailyUploadLimit、todayUploaded；null 与默认显示语义一致 |
| M02 | GET `/game-map/status` | X-Api-Key；query mapId | 只允许本人地图，越权 403/不存在 404；status/rejectReason/version/changelog |
| M03 | POST `/game-map/key/upload` | X-Api-Key；multipart 见下文 | 新建/更新成功 `data.serverMapId`；reviewing 再提交 409；超配额 413、日限制 429、单文件超限 413、扩展名错误 422 |
| M04 | POST `/game-map/review` | 管理员；JSON mapId/action/reason | action=approve/reject/offline/online/delete；reject 要非空 reason；版本、changelog、pending 文件和旧文件清理符合状态规则 |
| M05 | POST `/game-map/bind-creator` | 管理员；JSON mapId/creatorId | 地图必须未绑定、用户必须是创作者；返回地图；不在本轮悄悄新增原来没有的绑定配额限制 |
| M06 | GET `/game-map/admin-list` | 管理员；page/size、creatorId、status | `data={total,current,gameMapList}`；状态白名单，status ASC/version DESC |
| M07 | POST `/game-map/create` | 管理员；multipart game-map/cover-image，name/author/version/hash 等 | 直接 published、整数发布版本 1、inuse=false、creator=null；不是创作者投稿流程 |
| M08 | POST `/game-map/update` | 管理员；multipart id、game-map/cover-image 等 | 发布版本+1；重置 inuse，清空 creatorId/sourceUrl/候选文件与 hash，pendingVersion 设为入参；保留历史 changelog；成功后清理被替换文件 |
| M09 | GET `/game-map/info` | 公开；query id | 仅 published 详情，不存在/未发布 404；creator 相关字段按现 DTO；公开 DTO 的字段裁剪另立兼容变更 |
| M10 | GET `/game-map/list` | 公开；page/size、inuse（字符串 true/false） | 仅 published；官方或管理员创作者优先，再按 version；分页结构保持 |
| M11 | POST `/game-map/set-use` | 管理员；JSON id/use | 改 inuse；缺记录原返回不完整，目标明确 404，纳入 C08 |
| M12 | DELETE `/game-map/delete` | 管理员；query id | 缺 id 400；删除地图并清理全部应删文件；不存在记录的错误映射以 P0 夹具明确 |

M03 的字段不能改名：`game-map` 和 `source-map` 必填，`cover-image` 新建必填、更新可选；文本包含 name、version、hash，description/changelog 可选。更新地图 ID 同时接受 `server-map-id` 和 `serverMapId`。三个文件字段各最多一个，game-map 支持 `.fpmap`/`.mmmap`，source-map 为 `.fpmap`，封面为 png/jpg/jpeg。

`version` 文本代表投稿内容版本，数据库整数 version 代表审批/发布计数。批准时只有非空更新说明才追加 changelog。待审版本文件与已发布文件必须分别管理；不能上传完成就先删旧发布文件。

## 房间接口 10 项

| 编号 | 方法与路径 | 原认证与主要输入 | 返回和必须验收的行为 |
| --- | --- | --- | --- |
| R01 | GET `/room-router/join` | 公开；query roomId；可选 Authorization | roomId 非空且最长 12；新房返回 needCreate=true、空 hostPeerId、租约/epoch/心跳与 iceServers；已有可用房 needCreate=false；房主未 ready 202；关闭/过期 410 |
| R02 | POST `/room-router/emit-host` | 房主租约；JSON roomId/hostPeerId/hostName/hostId/hostLeaseToken | active/grace 下验证租约，设置 hostPeerId 并递增 hostEpoch；无效租约 409；恢复 active |
| R03 | POST `/room-router/delete` | 房主租约；**query** roomId/hostLeaseToken | 保留 sendBeacon 的无 JSON body 调用；不存在可幂等 200；无效租约 409；关闭后清空 peer |
| R04 | POST `/room-router/reclaim-host` | JSON roomId/hostId/hostName/hostPeerId 均必填，已存在记录还必须匹配 hostLeaseToken | active 拒绝；grace/expired 验证旧租约后轮换 token、递增 epoch；closed 拒绝；**缺目录记录的原不校验重建分支改为 410** |
| R05 | GET `/room-router/status` | 公开；query roomId | `data={status,hostEpoch}`；无记录返回 expired、epoch=0，保持旧查询形态 |
| R06 | GET `/room-router/heart` | 房主租约；query roomId/hostLeaseToken | 成功 **200 空响应体**；不存在/租约无效等 409；grace 内可续回 active |
| R07 | GET `/room-router/room-list` | 管理员 | **裸 `{data:[...]}`**；active 且 peer ready；当前包含私密房，hostPeerId 掩为 null；目标去除意外泄露的 hostLeaseToken |
| R08 | GET `/room-router/random-public-room` | 公开 | **裸 `{roomId:"..."}`**；active/public/not-started/peer-ready；无匹配 roomId 为空字符串 |
| R09 | POST `/room-router/set-private` | 原为公开无租约；JSON roomId/isPrivate | 目标新增 hostLeaseToken 验证；保留成功 `data={roomId,isPrivate}`；客户端需要配套 |
| R10 | POST `/room-router/set-started` | 原为公开无租约；JSON roomId/isStarted/mapId/mapName | 目标新增 hostLeaseToken；开始时记录地图元数据；结束仍是房间目录状态，不等于服务器完成游戏结算 |

R01 的无 token/无效 token 当前按游客返回 STUN；登录用户可获得动态 TURN 凭证。基础迁移保持游客能力，不强制所有玩家先登录。R04 的租约字段是授权凭证，hostId/hostName 本身不是身份证明。

## 统计与 coturn 接口 3 项

| 编号 | 方法与路径 | 原认证 | 返回和必须验收的行为 |
| --- | --- | --- | --- |
| S01 | GET `/statistics/users` | 管理员 | totalUsers/onlineUsers/adminusers/newUsersToday/trend，7 日趋势与日期边界 |
| S02 | GET `/statistics/games` | 管理员 | totalGames/todayGames/avgDuration/trend/topMaps/topRoomIds；平均毫秒四舍五入；排行字段类型按旧结果 |
| T01 | GET `/coturn/metrics` | 管理员 | 分协议 allocations/总数、流量、丢包/处理、STUN 指标；超时 504，网络或上游错误 502 |

## 额外入口与明确不新增的接口

| 入口 | 任务 |
| --- | --- |
| GET `/health` | plain `OK`；目标允许匿名健康检查，详细依赖状态放内部 readiness |
| `/static/**` | 保留历史公开上传 URL；图片和地图 Content-Type、下载/HEAD 行为按现调用验证；禁止日志和临时目录被访问 |
| 管理后台 `/env.js` | 保留浏览器所需公开白名单、API/ADMIN 前缀；不得把 DB、RSA、COS、TURN 密钥全量暴露 |
| 后台 SPA 入口/回退 | 原独立后台端口和对外前缀保持，深链接刷新可用，index 注入与缓存策略一致 |
| PeerServer HTTP/WebSocket | 独立 Node 服务继续接受原 PeerJS 1.5.5 客户端；验证 path、ID 分配、心跳、断线重连及代理 Upgrade |
| coturn STUN/TURN | 继续运行原服务，Java 负责签临时凭证和读指标；不实现 Java STUN/TURN 替代 |

旧白名单或客户端遗留代码提及的 `/user/public-key`、`/user/get-login-code`、`/user/get-code-state`、`/upload/avatar` 没有对应当前有效路由，不计入 39 个接口，也不凭名称新增功能。

## 必须明确发布的兼容修正

| 编号 | 现状及目标 | 配套与验收 |
| --- | --- | --- |
| C01 JWT 时间和类型 | 现 `exp=Date.now()+duration` 是毫秒；改标准秒级；访问/刷新令牌分别验证 | 游戏端与后台改 `exp*1000` 或有期限的双格式判断；401 只刷新一次；测试真实过期；发布后重新登录 |
| C02 登录加密密钥缓存 | Node 每次启动生成 AES 密钥，浏览器缓存可能过期；Java 密钥持久化管理 | 两端登录前获取当前密钥或遇到密钥失效刷新一次再重加密；不得无限重试错误密码；不改地图密钥 |
| C03 敏感字段 | 原部分用户接口直接返回实体，room-list 展开内存对象 | 安全用户 DTO 去除 password/salt；房间列表去除租约；后台不依赖这些字段；Key 查看功能保留管理员授权和审计 |
| C04 房间写权限 | set-private/set-started 未校验租约；reclaim 无记录即重建 | 两处写请求及调用点传租约；未知记录 reclaim 返回 410 并引导新建；需要跨重启恢复则追加持久化方案 |
| C05 数据启动行为 | `synchronize:true` 且每次启动做创作者/地图修正 | Flyway 显式迁移，修正仅一次并限定数据范围；重启不得改变人为下架或角色设置 |
| C06 存储边界 | temp/log 与公开根目录混用，部分 COS 配置会退回 local，同扩展文件可能重名 | 公开目录白名单、私有暂存/日志、唯一对象名、部分配置失败；管理上传硬上限先基于历史文件定值；原业务文件 URL 保留 |
| C07 健康与日期 | health 在管理员鉴权后，统计混用应用/SQL 日期 | 公开最小健康检查；显式业务时区；统计差异用固定数据集解释，不能直接套开发机时区 |
| C08 错误与空库初始化 | 缺 user delete id 挂起、set-use 空结果、首次注册隐式管理员 | 明确 400/404；已有库不改变管理员；新库走显式管理员初始化。其余错误码先保持，再逐项记录获接受的差异 |

JWT 的 `exp` 是秒级 NumericDate，现有毫秒值会让服务端过期校验明显偏离预期。这不是简单替换 JWT 库就会自动兼容的差异。[jsonwebtoken 官方过期说明](https://github.com/auth0/node-jsonwebtoken#token-expiration-exp-claim)

## 跨语言加密验收向量

测试只使用专用样例密钥和脱敏账号，不能把真实数据库密码、私钥、API Key 加入 fixtures。

| 对象 | 必须固定的字节和算法 | 验收 |
| --- | --- | --- |
| 登录加密 | Base64 解码后为 IV 12 字节、ciphertext、tag 16 字节；AES-256-GCM；64 hex 字符解码为 32 字节 key；UTF-8 明文 | JS 加密→Java 解密；中文/符号；tag 篡改、截断拒绝；Java `AES/GCM/NoPadding` 的 tag 长度是 128 bit |
| 原密码 hash | HMAC-SHA512；key 为 salt 字符串的 UTF-8 字节，**不是**将 salt 当 hex 解码；输出小写 hex | 多个旧格式样例验证一致；错误密码不匹配；无需用户重置密码 |
| JWT | RS256；userId/isAdmin/type；access 30 分钟、refresh 7 天；iat/exp 秒 | 到期前/后、错误算法、错误类型、删除用户和降权；原 Node 内存密钥不在数据库中，默认不承诺旧 token 继续有效 |
| TURN | `${Unix秒到期}:${userId}`；TURN_SECRET UTF-8；HMAC-SHA1→标准 Base64 | 固定时钟结果完全一致，随后实测 coturn 接受并成功中继；游客仅 STUN |

## 现有客户端与共享文件任务

下列是服务端迁移所需配套，不是重写客户端。实际编码前再查调用关系，避免遗漏经由公共工具触发的行为。

| 文件 | 任务 | 验收关联 |
| --- | --- | --- |
| [游戏端 API 拦截器](../../apps/client/src/utils/api/index.ts) | 修正 exp 单位、限制 401 刷新重试次数、并发刷新协调、刷新后读取最新 token；保留裸 Authorization 兼容 | C01，U07/U12/U13 |
| [后台 Axios 拦截器](../../apps/admin/src/utils/axios/index.ts) | 同步秒级 exp 和一次刷新策略，保证管理员降权后不能继续操作 | C01，所有管理员接口 |
| [游戏端登录加密](../../apps/client/src/utils/encryption.ts) | 更新 encryption-key 缓存失效策略，固定 GCM 字节格式 | C02，U08/U12/U14 |
| [后台登录工具](../../apps/admin/src/utils/auth.ts) | 同步密钥刷新/重加密，不混淆 MAP_ENCRYPT_KEY | C02 |
| [房间 API](../../apps/client/src/utils/api/room-router.ts) | setRoomPrivate/setRoomStarted 增加租约参数；保持 delete query/sendBeacon；处理未知记录 reclaim 的 410 | C04，R03/R04/R09/R10 |
| [房间隐私设置调用](../../apps/client/src/views/room/components/online-room/online-room.vue) | 从现有房主状态取得租约，传入 setRoomPrivate；非房主不能触发写操作 | R09 |
| [房主心跳与恢复](../../apps/client/src/core/monopoly-host/MonopolyHost.ts) | 处理 reclaim 的 410 为终止自动恢复，给出重新建房入口；租约轮换后所有房主写请求读取最新值，避免缓存旧租约 | C04，R04/R09/R10 |
| [房主网络管理](../../apps/client/src/core/network/WebRtcSessionManager.ts) | 向需要房主操作的 UI/Room 提供受控调用入口；不把租约广播给普通玩家 | C04 |
| [房主 Room](../../apps/client/src/core/monopoly-host/Room.ts) | 两处开始/结束时的 setRoomStarted 传入有效租约；不把游戏规则搬到 Java | R10 |
| [编辑器地图上传](../../apps/map-editor/src/utils/map-upload.ts) | 优先保持原字段、X-Api-Key、XHR 进度和错误解析；核对 413/422/429/null 限制，不主动重写上传协议 | M01–M03 |
| [共享数据库类型](../../packages/types/interfaces/game/db.ts) | 根据安全 DTO 和可选字段校准 User/MapKey/地图/审计相关实际类型；保留两类 version；不复制全部游戏协议到 Java | C03、M04/M07/M08 |
| `apps/client/src/utils/api/{auth,user,map}.ts` | 核对参数与返回；只有契约变化时修改 | 用户与公开地图 |
| `apps/admin/src/utils/api/{auth,user,game-map,room-list,statistics,coturn}.ts` | 核对 payload、日期和统计数字类型；不根据遗留函数补造不存在的登录码接口 | 管理端全部流程 |
| [环境变量读取](../../packages/env/src/index.ts) 与 `packages/env` 的 Vite 配置注入 | 核对前缀、端口、公开配置白名单；后端 secret 与前端构建环境隔离 | 额外入口、C06 |

当前 reclaim 调用位于 MonopolyHost.sendHeartbeat；连续失败只提示“正在尝试恢复”。改为区分可重试的网络失败和终止恢复的 410，并由会话管理层提供重新建房流程；不能仅让 HTTP 工具抛出异常。

## 最小业务验收脚本

1. 原账号登录，访问个人资料，token 到期自动刷新；修改密码、取消管理员/创作者、删除用户后权限立即符合预期。
2. 管理员建立创作者、设置配额、生成 Key；编辑器查询额度、上传地图和源文件，后台批准后游戏客户端可下载进入地图。
3. 同地图更新、拒绝、再次投稿、批准、下架、恢复、删除；逐步检查发布文件和 pending 文件，故障注入不影响旧版本下载。
4. 两端同时进入同一房间，仅一个成为房主；设置公开、随机匹配、开始游戏、正常关闭；租约失效/轮换/重放有确定行为。
5. 分别验证直连与必须 TURN 的两端联机，原 PeerJS 无需升级；API 服务重启后的限制与 D2/D3 选择一致。
6. 注册头像、边界大小、无效 Key 的大请求、COS 部分失败、DB 失败和旧文件删除失败均有正确返回与清理证据。
7. 管理端统计与存量数据集一致，coturn 指标不可用时正确显示失败；健康检查不依赖管理员登录。

P0 保存预期，后续保存 Java 结果和差异；用隔离数据库/存储环境分别运行 Node 和 Java，避免把包含写操作的契约测试同时打到生产数据。
