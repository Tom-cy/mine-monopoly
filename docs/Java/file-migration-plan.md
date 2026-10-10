# Java 逐文件迁移清单

> 本文保留原 Node 文件职责及历史兼容验收项。当前实施以 [GameBackend monopoly 模块迁移升级方案](gamebackend-monopoly-upgrade-plan.md)为准，其中“原逐文件任务的重新归属”逐项覆盖 F01–F47。旧工程路径、旧表／密码／接口兼容要求已被新模块、新表、ACCOUNT／REALM 和 Result 方案替换；本文复选框不表示新方案已实现。

源码基线、范围和工期见[任务总览](README.md)。以下覆盖 `git ls-files apps/server` 的全部 **47 个文件**，其中 42 个是 TypeScript 文件。清单按职责编排，编号稳定用于任务追踪，不表示执行顺序。

**路径约定：**“目标”中的 Java 路径均相对于拟建的 `apps/server-java/src/main/java/com/minemonopoly/server/`；`resources/` 指拟建 `apps/server-java/src/main/resources/`。这些路径是实施方案，尚未创建。每项勾选前应补充实现提交和验收证据；“不迁移”表示无需生成对应 Java 类，旧文件待完整切换后再退役。

## 工程与入口

### F01 `.gitignore`

源文件：[apps/server/.gitignore](../../apps/server/.gitignore)。状态：[ ] 待替代。

- **目标：** `apps/server-java/.gitignore`。
- **实施：** 忽略 `target/`、本机 IDE 文件、日志、临时上传、私钥和本机配置；提交 Maven Wrapper 必需文件。运行数据使用外部持久化目录，不以 Git 忽略规则代替备份。
- **验收：** 构建、启动、上传后 `git status` 不出现运行数据或凭证；新机器可从仓库复现构建。

### F02 `README.md`

源文件：[apps/server/README.md](../../apps/server/README.md)。状态：[ ] 待重写。

- **目标：** `apps/server-java/README.md`，旧服务 README 加迁移说明。
- **实施：** 记录 Java 版本、构建启动、环境变量、数据库初始化、PeerServer/coturn 依赖、静态文件、接口兼容和回滚；删除新文档中对旧 README 所述未实际接入的 GameProcess、GameSocketServer 等能力的暗示。
- **验收：** 按文档可启动 API 并完成登录、上传和两人联机；清楚写明 Java 业务服务不执行对局规则。依赖 P9 联调结果。

### F03 `app.ts`

源文件：[apps/server/app.ts](../../apps/server/app.ts)。状态：[ ] 待拆分迁移。

- **目标：** `ServerApplication.java`、`config/WebConfig.java`、`config/SchedulerConfig.java`、`common/ApiExceptionHandler.java`、`user/UserPresenceJob.java`、`config/HealthController.java`；独立 PeerServer 和后台静态服务配置。
- **实施：** 接入五个路由模块，显式配置 CORS、可信代理、请求大小/超时和异常映射。登录保持 10 次/分钟、注册 5 次/小时，明确限流键与可信 IP 来源。每两分钟扫描在线状态，保留两分钟不活跃离线规则。
- **拆出：** `PeerServer({port: ICE_SERVER_PORT})` 独立部署并保持客户端路径；admin-dist、`/env.js` 和 SPA 回退交给静态服务，保留外部地址及前缀，不向浏览器注入后端全部配置。
- **修正：** 公开最小 `/health`，内部 readiness 检查 DB；原健康接口在鉴权后实际受管理员保护。数据库连接失败时退出，不仅记录日志。两项启动数据修正移到一次性迁移，禁止每次启动重新发布地图或恢复已取消的创作者标志。
- **验收：** 路由、跨域预检、正常/异常启动、超时、在线状态和三个外部入口可用；`/static` 只开放业务公开文件，不能访问日志或临时目录。Spring 超时不能只设置一个 socket 参数就视为覆盖全部 120 秒旧请求行为，需实测慢上传与下游超时。

### F04 `package.json`

源文件：[apps/server/package.json](../../apps/server/package.json)。状态：[ ] 待替代并拆出依赖。

- **目标：** `apps/server-java/pom.xml`、Maven Wrapper；拟建 `apps/peer-server/package.json` 和最小启动脚本。
- **实施：** Express/body-parser/CORS → MVC；角色中间件/JWT → Security；TypeORM/mysql2 → JDBC；multer → 上传处理；winston → Logback；COS Node SDK → Java SDK；axios → Java HTTP 客户端。不因存在依赖就迁移未使用的 `ws`、`node-vibrant` 等能力。
- **保留：** `peer` 从业务包拆出，先固定到项目当前验证过的实际解析版本，再独立处理升级。根目录客户端构建仍使用 pnpm，不可整体移除 Node 工具链。
- **验收：** `./mvnw verify`、Java 镜像构建、独立 Peer 服务启动；Java 运行时不安装整个前端 workspace。依赖 P1/P7。

### F05 `src/classes/RoomRouter.ts`

源文件：[apps/server/src/classes/RoomRouter.ts](../../apps/server/src/classes/RoomRouter.ts)。状态：[ ] 待确认不迁移。

- **目标：** 无对应 Java 类。
- **实施：** 这是旧 WebSocket 房间路由实现，当前主入口使用的是 `src/routers/room-router.ts`。再次确认构建入口和动态加载无引用后标记废弃，避免把旧协议误认为现网功能。
- **验收：** 当前 HTTP 房间流程和 PeerJS 联机均由 F25/P7 覆盖；迁移清单中不额外创建一个 WebSocket 对局网关。

### F06 `src/config/global.ts`

源文件：[apps/server/src/config/global.ts](../../apps/server/src/config/global.ts)。状态：[ ] 待替代。

- **目标：** `config/ServerProperties.java`、`config/TurnProperties.java`、`config/StorageProperties.java`、`resources/application.yml`。
- **实施：** 此文件主要被旧自调用工具使用，不照抄硬编码 URL。整理真正从 `@mine-monopoly/env` 读取的变量，类型化端口、秒/毫秒、存储路径、代理前缀、数据库及密钥；启动校验必填值和组合配置。
- **验收：** 缺关键配置立即失败；TURN_TTL 不发生字符串拼接；生产密钥不写入资源文件。配置对应表见数据部署文档。

## 数据访问与实体

### F07 `src/db/api/admin-audit-log.ts`

源文件：[apps/server/src/db/api/admin-audit-log.ts](../../apps/server/src/db/api/admin-audit-log.ts)。状态：[ ] 待迁移。

- **目标：** `audit/AdminAuditRepository.java`、`audit/AdminAuditService.java`。
- **实施：** 保留查看、生成、重置、吊销 Key 与重置上传计数的 action 值，以及 adminId、targetUserId、detail。Key 变更和审计写入同一 DB 事务；查询 Key 的审计单独记录，不在 detail 中重复保存明文 Key。
- **验收：** 各操作有且仅有预期日志，列表查询按原 page/search 记录上下文；用户删除后审计仍保留。依赖 F18、F27。

### F08 `src/db/api/game-map.ts`

源文件：[apps/server/src/db/api/game-map.ts](../../apps/server/src/db/api/game-map.ts)。状态：[ ] 待拆分迁移。

- **目标：** `map/GameMapRepository.java`、`map/MapQueryService.java`、`map/MapReviewService.java`、`map/MapOwnershipService.java`。
- **实施：** 显式 SQL 保留公开列表仅 published、官方/管理员创作者优先、version 排序；后台分页、状态筛选及 creator 字段使用 DTO。创作者配额计数包含所有状态。
- **状态事务：** 投稿设置 pending 文件与 reviewing；批准原子地提升发布文件、清空 pending、递增整数发布版本并追加非空 changelog；拒绝原因与状态同事务；下架/恢复不隐式改 `inuse`。绑定创作者、删除用户时保留 published 并解绑，其余状态删除。
- **注意：** `pendingVersion` 是字符串内容版本，`version` 是发布计数。`publishExistingInUseMaps` 移为受控一次性修正，不能让重启重新发布被下架/拒绝的地图；无调用的 `getActiveMapKeyOwnerMapCount` 不单独迁移。
- **验收：** 全状态转换表、越权、重复审核、旧文件保留、分页排序通过；同一地图并发审核不能重复递增或删掉新文件。数据库提交后的旧文件删除由 F38 接管。

### F09 `src/db/api/game-record.ts`

源文件：[apps/server/src/db/api/game-record.ts](../../apps/server/src/db/api/game-record.ts)。状态：[ ] 待迁移。

- **目标：** `room/GameRecordRepository.java`、`room/RoomExpiryService.java`。
- **实施：** 写入 roomId/name、毫秒 duration、mapId/mapName。记录目前来自房间 grace 结束后的过期处理，并不等于游戏完成结算；显式删除房间当前不写记录，基础迁移保持此口径。
- **验收：** 同房间过期扫描并发只触发一次写入；DB 失败保留可重试状态并告警，不能像未等待 Promise 一样丢弃失败。基础内存版只承诺本进程生命周期内去重，重启后的可靠补写属于可选持久化任务。依赖 F15、F25。

### F10 `src/db/api/map-key.ts`

源文件：[apps/server/src/db/api/map-key.ts](../../apps/server/src/db/api/map-key.ts)。状态：[ ] 待迁移。

- **目标：** `security/MapKeyRepository.java`、`security/MapKeyService.java`。
- **实施：** `SecureRandom` 生成 32 字节，编码为无填充 Base64URL，前缀 `mk_`；保留每用户唯一 Key、有效 Key 已存在时 409、reset upsert、revokedAt 语义。保留旧明文 Key，避免编辑器全部失效。
- **注意：** 旧 reset 路由没有和 generate 一样检查创作者；正式 API Key 使用时仍必须校验用户存在且是创作者，不能只看 Key 未吊销。是否统一 reset 的资格校验需要在接口差异记录中明确，不可无声改变。
- **验收：** 旧 Key 可用；重置后旧 Key 立即无效；并发生成受 DB 唯一约束保护；审计无遗漏。将 Key 改为不可逆哈希会改变后台查看功能，作为另一个功能任务处理。

### F11 `src/db/api/map-upload-counter.ts`

源文件：[apps/server/src/db/api/map-upload-counter.ts](../../apps/server/src/db/api/map-upload-counter.ts)。状态：[ ] 待迁移。

- **目标：** `map/UploadCounterRepository.java`、`map/UploadCounterService.java`。
- **实施：** 保留按配置业务时区日期清零、查询当日次数、成功投稿后递增、管理员重置。使用 SQL 原子更新/行锁避免读改写覆盖；文件上传期间不长期持有用户行锁。
- **边界：** 当前日限制是软限制，并发请求可能一起通过预检。基础迁移维持此产品语义，同时确保已成功上传的计数不丢；如要求严格上限，需新增预留/释放额度机制，单独评估，不把原子 increment 误称为严格限额。
- **验收：** 跨日、时区、重置与并发成功请求计数正确；失败不递增；计数写入失败有明确可观测记录。依赖 F17、F24。

### F12 `src/db/api/user.ts`

源文件：[apps/server/src/db/api/user.ts](../../apps/server/src/db/api/user.ts)。状态：[ ] 待拆分迁移。

- **目标：** `user/UserRepository.java`、`user/UserService.java`、`user/UserQueryService.java`。
- **实施：** 保留账号 3–20 位字母/数字/下划线、昵称 1–20 位、解密后密码至少 6 位的验证；实现创建、更新、删除、列表、在线时间。DTO 区分字段省略和显式 null，布尔 false 不得当成“未传”。
- **联动：** 取消创作者时清空配额/上传限制并吊销 Key；开启时为空配额默认 1。删除用户的 Key、地图解绑/删除、用户删除使用事务，提交后再清理应删地图文件。
- **查询：** 保留搜索、筛选、排序白名单、默认分页 size=8、日期字符串及 nullable 限制；批量聚合 mapCount 和 Key 避免 N+1，但结果与旧 API 一致。不得把密码和 salt 放入创建/更新返回 DTO。
- **验收：** 权限变化立即生效；分页字段类型一致；事务任一步失败不留半删用户。`migrateCreatorFlags` 改为一次性迁移，不能每次启动恢复被管理员取消的创作者。

### F13 `src/db/dbConnecter.ts`

源文件：[apps/server/src/db/dbConnecter.ts](../../apps/server/src/db/dbConnecter.ts)。状态：[ ] 待替代。

- **目标：** `config/DataSourceConfig.java`、`resources/application.yml`、`resources/db/migration/`。
- **实施：** JDBC + Hikari，连接池初始可参照旧 max=20、连接建立 10 秒、连接获取 30 秒，再压测调整。旧代码实际固定 `database: monopoly`；切换为配置时先确认现网库名，不能误接另一空库。
- **迁移：** 读取真实 DDL、索引、外键、字符集、SQL 模式和时区；现库受控 Flyway baseline，空库走已审核建表迁移。禁止 Hibernate/其他工具自动 update/create，也不照抄 `synchronize: true`。
- **验收：** 空库与已有库两条路径均成功；对原库不产生意外改表；断连、池耗尽和事务回滚可定位。依赖 P0 数据快照。

### F14 `src/db/entities/GameMap.ts`

源文件：[apps/server/src/db/entities/GameMap.ts](../../apps/server/src/db/entities/GameMap.ts)。状态：[ ] 待迁移映射。

- **目标：** `map/GameMapRow.java`、`map/MapStatus.java`、`map/MapChangelogEntry.java`。
- **实施：** 保留 UUID、描述、作者、封面、发布/候选地图和源图 URL/hash、creatorId、inuse、审核状态/原因、两个不同版本字段及 JSON changelog。creator 删除时 SET NULL，字段长度/索引按真实 DDL。
- **验收：** null/空字符串、旧无 creator 地图、JSON null/空数组/已有记录均能读取；DTO 不直接序列化关联 User；原 URL 不重写。依赖 F08/F13。

### F15 `src/db/entities/GameRecord.ts`

源文件：[apps/server/src/db/entities/GameRecord.ts](../../apps/server/src/db/entities/GameRecord.ts)。状态：[ ] 待迁移映射。

- **目标：** `room/GameRecordRow.java`。
- **实施：** 源码同时标注 `id` 和 `name` 为主键，按实库确认复合主键；保留 `create_time`、`update_time`、nullable map 字段、整数毫秒 duration。使用 Java long 做计算，但入库仍受旧 INT 范围约束，超长房间溢出策略在 P0 明确；升级 BIGINT 属于显式 DDL 变更。
- **验收：** 旧记录和同名房间多条记录能读取；统计不误将毫秒当秒；不偷偷给 name 增加唯一约束。

### F16 `src/db/entities/MapKey.ts`

源文件：[apps/server/src/db/entities/MapKey.ts](../../apps/server/src/db/entities/MapKey.ts)。状态：[ ] 待迁移映射。

- **目标：** `security/MapKeyRow.java`。
- **实施：** 保留 UUID、userId 唯一约束、key 唯一约束、revokedAt/createdAt/updatedAt、用户删除级联；`key` 等列名使用方言正确引用。现数据是明文，不在本轮自动重置或哈希转换。
- **验收：** 时间和 null 字段兼容；唯一冲突被映射为明确业务错误；吊销记录不会被误当有效 Key。

### F17 `src/db/entities/User.ts`

源文件：[apps/server/src/db/entities/User.ts](../../apps/server/src/db/entities/User.ts)。状态：[ ] 待迁移映射。

- **目标：** `user/UserRow.java`、`user/UserProfileResponse.java`、`user/AdminuserResponse.java`、`user/AdminBootstrapService.java`。
- **实施：** 源码 `id` 和 `useraccount` 同为主键，不能假设账号单列唯一；保留原哈希、salt、头像、颜色、角色、在线信息、所有 nullable 限制、上传日计数以及时间列映射。检查已有重复账号后再决定是否新增唯一索引。
- **初始化：** 原 BeforeInsert 以“第一位用户”授予管理员且存在并发竞争。新空库采用显式初始化管理员任务；已有库不执行首用户自动提权。该引导行为变化记入 C08。
- **验收：** 原密码无需重设可登录；角色/限制的 null 与 false 不混淆；任何响应 DTO 无 password/salt；同时注册不产生多个意外管理员。

### F18 `src/db/entities/AdminAuditLog.ts`

源文件：[apps/server/src/db/entities/AdminAuditLog.ts](../../apps/server/src/db/entities/AdminAuditLog.ts)。状态：[ ] 待迁移映射。

- **目标：** `audit/AdminAuditLogRow.java`。
- **实施：** 保留 UUID、可空管理员/目标用户 ID、action、detail、createdAt 与现有索引；不额外加用户删除级联外键，避免抹除审计历史。
- **验收：** 原日志可查询；删除管理员或目标用户后历史仍在；detail 不进入公开 API 或静态文件。依赖 F07。

## 类型与路由

### F19 `src/enums/bace.ts`

源文件：[apps/server/src/enums/bace.ts](../../apps/server/src/enums/bace.ts)。状态：[ ] 待按引用裁剪。

- **目标：** 只为仍在 HTTP 契约中使用的值定义领域常量；无逐文件对应类。
- **实施：** 确认旧 WebSocket 消息类型的引用关系；未接入现主入口的消息枚举不迁移。不得改动现客户端 PeerJS 对局消息枚举来配合本轮 API 改造。
- **验收：** 五个 Java Controller 不依赖历史游戏通信枚举；已有 HTTP 返回码和字段值按接口清单覆盖。

### F20 `src/enums/game.ts`

源文件：[apps/server/src/enums/game.ts](../../apps/server/src/enums/game.ts)。状态：[ ] 待确认不迁移。

- **目标：** 无对应 Java 游戏规则枚举。
- **实施：** 当前业务 API 不执行游戏规则，旧工具类型所用游戏枚举无需搬到 Java；地图文件仍作为不改变内容的资源保存。
- **验收：** 地图上传下载字节一致，Java 不新增 GameProcess、棋盘模拟或规则执行器。后续 Unity/权威对局重新设计类型。

### F21 `src/interfaces/bace.ts`

源文件：[apps/server/src/interfaces/bace.ts](../../apps/server/src/interfaces/bace.ts)。状态：[ ] 待拆解裁剪。

- **目标：** 必要的 `room/RoomSession.java`、`room/RoomResponse.java` 及用户 DTO；其余旧类型不迁移。
- **实施：** 以实际路由输入输出为准提取字段；不把游戏对象、场景对象或未用 import 对应的完整类型复制进 Java。区分数据库 User、登录主体、公开用户信息和房主提供的 hostId。
- **验收：** HTTP JSON 只含契约字段；房主传入 hostId 不自动成为登录用户身份；旧共享类型未迁移不会阻断三端构建。

### F22 `src/interfaces/res.ts`

源文件：[apps/server/src/interfaces/res.ts](../../apps/server/src/interfaces/res.ts)。状态：[ ] 待替代。

- **目标：** `common/ApiResponse.java`、`common/ApiExceptionHandler.java`，少数专用响应 DTO。
- **实施：** 支持 `{status,msg?,data?}`，保持 HTTP 状态和 JSON status 一致；Jackson 不应无意增加所有可选 null 字段。显式保留心跳空响应、random-public-room 的裸 `{roomId}`、room-list 的 `{data}` 和健康检查文本。
- **验收：** 不用全局 ResponseBodyAdvice 把全部接口再包一层；错误样例覆盖 400/401/403/404/409/410/413/422/429/500/502/504。

### F23 `src/routers/coturn-router.ts`

源文件：[apps/server/src/routers/coturn-router.ts](../../apps/server/src/routers/coturn-router.ts)。状态：[ ] 待迁移。

- **目标：** `statistics/CoturnController.java`、`statistics/CoturnMetricsService.java`、`statistics/CoturnMetricsResponse.java`。
- **实施：** 保持管理员接口，从配置地址读取 Prometheus 文本；5 秒超时。映射 udp/tcp/tls/dtls allocations 和总数、流量、processed/dropped、STUN 指标；保留响应字段，不能直接把原始全文返回后台。
- **验收：** 使用原样指标夹具检查标签和求和；缺失指标按原行为处理；上游非 200/网络异常为 502、超时为 504，响应体长度有界且连接可复用。不将指标端口直接暴露公网。

### F24 `src/routers/game-map.ts`

源文件：[apps/server/src/routers/game-map.ts](../../apps/server/src/routers/game-map.ts)。状态：[ ] 待拆分迁移。

- **目标：** `map/MapPublicController.java`、`map/MapAdminController.java`、`map/CreatorMapController.java`、`map/MapUploadService.java`、`map/MapReviewService.java` 及请求 DTO。
- **实施：** 覆盖全部 12 个接口。公开查询、管理员操作、X-Api-Key 投稿分开授权；保留 `game-map`、`source-map`、`cover-image` multipart 名称，以及 `server-map-id`/`serverMapId` 两个更新 ID。creator 上传要求 map/source，新建还要求 cover；管理 create/update 要求 map/cover。
- **业务：** 配额为空禁止投稿；超配额 413、日限制 429、单文件超限 413、扩展名错误 422；用户只能更新自己的非 reviewing 地图。管理直接发布与创作者审核流程分开，不能全部统一成同一套默认字段。
- **事务：** 协调文件上传、数据库写入、计数和成功后的旧文件清理。管理员 update 当前会递增发布版本、重置 inuse、清空 creatorId/sourceUrl/pendingUrl/pendingSourceUrl/pendingHash，并将 pendingVersion 设为本次入参，迁移必须有契约样例，不能按常规“部分更新”猜测实现。
- **验收：** 编辑器 API Key 查询→投稿→审核→客户端列表/下载完整闭环；失败不误删旧正式文件；重复/并发审核结果确定。依赖 F08、F11、F28、F33、F36–F43。

### F25 `src/routers/room-router.ts`

源文件：[apps/server/src/routers/room-router.ts](../../apps/server/src/routers/room-router.ts)。状态：[ ] 待拆分迁移。

- **目标：** `room/RoomController.java`、`room/RoomRegistry.java`、`room/RoomSession.java`、`room/RoomLeaseService.java`、`room/RoomExpiryJob.java`。
- **实施：** 迁移 10 个接口及 active/grace/closed/expired 状态；保留 TTL 30 秒、建议心跳 5 秒、grace 60 秒、closed/expired 保留 5 分钟、扫描 2 秒。保留 GET join 的创建行为、POST delete 的 query 参数和 sendBeacon 兼容。
- **并发：** 创建房间用原子创建；同房间租约检查、状态变化、epoch 递增、租约轮换串行完成。仅使用 ConcurrentHashMap 不足以保证多字段操作原子性；使用房间锁或串行执行器，并处理删除与重建的锁生命周期。
- **修正：** set-private/set-started 增加房主租约校验；room-list DTO 不返回租约。不存在的记录无法验证旧租约，reclaim 返回 410，客户端引导新建；不照搬旧实现“记录不存在即相信请求重建”的逻辑。需要跨重启恢复时实施单独的持久化扩展。
- **验收：** 两人同时创建、重复心跳、过期扫描与 reclaim 竞争、旧租约重放、关闭后重入、临界 30/90 秒、记录写入失败均覆盖；先保持原有效租约在 grace 内可续回。对局仍在房主 Worker 执行。依赖 F09/F45 及客户端两处状态修改适配。

### F26 `src/routers/statistics-router.ts`

源文件：[apps/server/src/routers/statistics-router.ts](../../apps/server/src/routers/statistics-router.ts)。状态：[ ] 待迁移。

- **目标：** `statistics/StatisticsController.java`、`statistics/StatisticsRepository.java`、`statistics/StatisticsService.java`。
- **实施：** 两个管理员接口，保留用户总数/在线/管理员/今日新增/7 日趋势，以及记录总数/今日/平均时长/趋势/地图和房间排行。明确 SQL DATE 与应用日期边界使用同一个业务时区，空桶补齐、排序稳定。
- **兼容：** avgDuration 为四舍五入的毫秒值；部分 SQL count 在原返回中是字符串，先采集三端依赖再确定 DTO，不因 Java long 改变既有契约。按原记录来源统计，不改名为已完成对局数。
- **验收：** 固定数据集、午夜边界、空库、null mapId 和同地图不同 mapName 的聚合结果一致；若修正原时区偏差，记录 C07 的预期差异。

### F27 `src/routers/user.ts`

源文件：[apps/server/src/routers/user.ts](../../apps/server/src/routers/user.ts)。状态：[ ] 待拆分迁移。

- **目标：** `user/AuthController.java`、`user/UserController.java`、`user/AdminuserController.java`、`security/MapKeyAdminController.java`、登录/注册/更新 DTO。
- **实施：** 覆盖 14 个接口，保持 `/user/encryption-key`、JSON 登录/刷新、multipart 注册与 query 删除参数；注册头像必填且 2 MiB，管理员创建不要求走注册上传路径。
- **返回：** 创建/更新/注册统一使用安全用户 DTO，不透出完整数据库实体；登录和刷新继续返回 token/refreshToken。info 必须实际通过请求头认证，不承诺旧 handler 的 query token 回退能绕过中间件。
- **修正：** 缺少 delete id 返回 400，不能继续悬挂请求；刷新查当前用户与权限；不存在/被删除用户不能借旧 refreshToken 恢复身份。限流、错误信息和加密缓存联动见接口文档。
- **验收：** 原账号密码、头像注册、分页/筛选、角色更新、Key 操作与删用户地图联动通过；公开/普通用户/管理员边界逐个验证。依赖 F07、F10–F12、F28、F31、F34–F35、F44。

## 认证与通用工具

### F28 `src/utils/api-key.ts`

源文件：[apps/server/src/utils/api-key.ts](../../apps/server/src/utils/api-key.ts)。状态：[ ] 待迁移。

- **目标：** `security/MapKeyAuthenticationFilter.java`、`security/CreatorPrincipal.java`。
- **实施：** 读取 X-Api-Key，检查 Key 未吊销、用户存在且 isCreator；将创作者身份和额度信息传入 Controller。与 JWT 认证分别实现，不让 API Key 调管理员接口，也不要求编辑器另传登录 token。
- **验收：** 缺失、未知、吊销、用户被删除/取消创作者均拒绝；有效 Key 仅能访问约定投稿接口；大文件在身份无效时尽早拒绝。

### F29 `src/utils/async-mission-queue/index.ts`

源文件：[apps/server/src/utils/async-mission-queue/index.ts](../../apps/server/src/utils/async-mission-queue/index.ts)。状态：[ ] 待确认不迁移。

- **目标：** 不创建全局 AsyncMissionQueue。
- **实施：** 当前只服务旧 RoomRouter。Java 房间串行化在 F25 内按房间设计，上传事务也不交给这个历史队列。
- **验收：** 引用核对确认无主入口依赖；不为翻译旧工具额外引入消息中间件。

### F30 `src/utils/fetch/user.ts`

源文件：[apps/server/src/utils/fetch/user.ts](../../apps/server/src/utils/fetch/user.ts)。状态：[ ] 待确认不迁移。

- **目标：** 如确有同进程用户查询需求，直接调用 `UserService`，不保留自调用 HTTP。
- **实施：** 旧工具将 token 放在 GET 请求体并访问旧配置 URL，与实际 header 鉴权不匹配，且没有当前业务调用；记录退役理由。
- **验收：** Java 应用不通过 HTTP 请求自己查询已验证用户，不引入无业务用途的 axios 替代层。

### F31 `src/utils/index.ts`

源文件：[apps/server/src/utils/index.ts](../../apps/server/src/utils/index.ts)。状态：[ ] 待拆分裁剪。

- **目标：** `security/PasswordTransportCipher.java`、`security/LegacyPasswordHasher.java`、`common/RandomIdGenerator.java`、必要的颜色工具。
- **实施：** AES-256-GCM 解密 Base64(iv 12 字节 + 密文 + 16 字节 tag)，密钥是 64 位 hex 解码后的 32 字节；HMAC-SHA512 的 salt 使用其字符串 UTF-8 字节而非 hex 解码，输出小写 hex。新盐用安全随机数生成，旧盐不修改。
- **裁剪：** 未使用的 `getImageMainColor`、`getItemTypes`、`getProperties` 不迁移，避免带入图像算法或游戏规则依赖；随机文件名使用 SecureRandom，保留扩展名。
- **验收：** 固定测试密钥/IV/中文密码的 Node→Java 向量通过；错误 tag 拒绝；旧数据库密码可以验证。公开传输密钥不能被描述为替代 HTTPS 的安全保证。

### F32 `src/utils/logger/index.ts`

源文件：[apps/server/src/utils/logger/index.ts](../../apps/server/src/utils/logger/index.ts)。状态：[ ] 待替代。

- **目标：** `resources/logback-spring.xml`、请求关联 ID Filter。
- **实施：** 日志默认 stdout 或独立日志目录，按级别和轮转策略管理；原 `public/logs` 位于公开 static 目录下，迁移时移出公开资源范围。屏蔽 Authorization、API Key、hostLeaseToken、密码、COS 凭证和临时 TURN credential。
- **验收：** 登录、上传失败、房间过期、COS/DB 异常可按请求定位；HTTP 无法下载日志；请求 query 中的租约同样脱敏。

### F33 `src/utils/map-upload-limit.ts`

源文件：[apps/server/src/utils/map-upload-limit.ts](../../apps/server/src/utils/map-upload-limit.ts)。状态：[ ] 待迁移。

- **目标：** `map/CreatorUploadPolicy.java`。
- **实施：** nullable 用户限制回落到默认 50 MiB/文件、3 次/天，保持 1024² 字节换算；区分 mapQuota、单文件大小和日次数，不能把三项合成一个限制。
- **验收：** 默认、自定义、null、非法值及边界值；接口返回 limit/used/quota 的单位与字段一致。依赖 F11/F24/F42。

### F34 `src/utils/role-validation.ts`

源文件：[apps/server/src/utils/role-validation.ts](../../apps/server/src/utils/role-validation.ts)。状态：[ ] 待替代。

- **目标：** `config/SecurityConfig.java`、`security/LegacyAuthorizationResolver.java`、`user/UserPresenceService.java`。
- **实施：** 按 HTTP 方法+路径建立公开、登录、管理员、API Key、租约权限矩阵；兼容裸 token 和 Bearer，访问接口验证 access 类型。在线写库节流 30 秒；后台两分钟离线扫描与此一致。
- **注意：** Ignore 清单出现的 `/upload/avatar`、`/user/public-key`、`get-code-state`、`get-login-code` 并没有对应有效路由，不能据此新增接口。API Key 路由只是跳过用户 JWT，仍需 F28 认证。
- **验收：** 权限矩阵全覆盖；跨域预检无需登录；refreshToken 不可调用业务接口；普通用户不可访问 room-list、statistics、coturn。后台角色撤销采用当前用户记录验证，不能永久相信旧 isAdmin claim。

### F35 `src/utils/rsakey.ts`

源文件：[apps/server/src/utils/rsakey.ts](../../apps/server/src/utils/rsakey.ts)。状态：[ ] 待替代。

- **目标：** `security/SigningKeyProvider.java`、`security/PasswordTransportKeyProvider.java`。
- **实施：** 读取受控持久化 RSA 私钥 PKCS8/公钥 SPKI，开发可显式生成测试密钥；登录传输 AES 密钥单独管理。与地图 `MAP_ENCRYPT_KEY`、TURN_SECRET、COS 凭证分开配置，重启不默认全部轮换。
- **验收：** Java 重启后自己签发的有效 token 可验证；启动检查私钥格式及 AES 长度；不把私钥打印或打进镜像。旧 Node 令牌迁移默认重新登录，浏览器缓存的登录加密密钥必须重新获取。

## 文件存储

### F36 `src/utils/storage/cos-provider.ts`

源文件：[apps/server/src/utils/storage/cos-provider.ts](../../apps/server/src/utils/storage/cos-provider.ts)。状态：[ ] 待迁移。

- **目标：** `storage/CosStorageProvider.java`。
- **实施：** 使用腾讯 COS Java SDK，保留 bucket/region、对象路径、公开 URL 和 HTTPS 形式；初始按原 60 秒超时、5 MiB 分片阈值评估，实际 SDK 参数需分别映射。共享可关闭的 SDK 客户端，应用停止释放资源。
- **验收：** 单/多文件上传返回顺序一致；分片失败不残留未完成上传；批量删除检查逐对象结果，不能仅以 HTTP 200 当成全部成功；权限/网络失败触发 F38 补偿。用测试桶验证，不在生产桶做破坏性测试。

### F37 `src/utils/storage/factory.ts`

源文件：[apps/server/src/utils/storage/factory.ts](../../apps/server/src/utils/storage/factory.ts)。状态：[ ] 待替代。

- **目标：** `config/StorageConfig.java`、`config/StorageProperties.java`。
- **实施：** 明确 local/cos 模式，保留旧“四项 COS 必填配置齐全才用 COS”的迁移映射；部分 COS 配置不再悄悄退回本地，应启动失败说明缺项。
- **验收：** 本地、完整 COS、部分 COS 配置三个场景结果确定；切换存储不会批量改写原地图 URL，历史混合 URL 的清理按所属存储分派。

### F38 `src/utils/storage/file-cleanup.ts`

源文件：[apps/server/src/utils/storage/file-cleanup.ts](../../apps/server/src/utils/storage/file-cleanup.ts)。状态：[ ] 待重构。

- **目标：** `storage/UploadWorkspace.java`、`storage/UploadCompensationService.java`、`storage/OrphanCleanupJob.java`。
- **实施：** 追踪临时原名、重命名后文件、已成功上传对象；逐个登记成功结果，部分失败可回收。DB 提交前失败只删本次新文件，提交后再清理被替换旧文件；不得把“上传函数已返回”当成整个业务提交成功。
- **可靠性：** 删除失败写入可重试清理记录，建议用新增 storage_cleanup_task 表并有退避、次数和告警；按对象所有权及 URL→key 规则删除，避免把别的地图文件当孤儿。目录扫描只处理可证明过期的临时文件，不按时间直接清理全部正式资源。
- **验收：** 第 2 个上传失败、DB 写入失败、旧文件删除失败、临时文件重命名失败、进程重启后清理任务恢复；已发布旧地图始终可下载。storage_cleanup_task 是本轮拟新增运维辅助表，见数据文档。

### F39 `src/utils/storage/file-validation.ts`

源文件：[apps/server/src/utils/storage/file-validation.ts](../../apps/server/src/utils/storage/file-validation.ts)。状态：[ ] 待迁移并修正命名。

- **目标：** `storage/UploadValidator.java`、`storage/StorageObjectNamer.java`。
- **实施：** 按字段保留扩展名规则：游戏地图支持 `.fpmap`/`.mmmap`，源地图 `.fpmap`，封面 png/jpg/jpeg；统一小写后判断。路径只由受控随机名和白名单扩展名组成，不接受客户端路径。
- **修正：** 旧多个文件可用同一 basename，当 game-map 与 source-map 都是 `.fpmap` 时存在同名覆盖风险；按文件角色或独立随机名生成唯一目标路径。URL 对客户端是非透明值，返回新地址即可，不改文件内容。
- **验收：** 大小写扩展、路径穿越名、重复扩展名、缺文件及未知字段均覆盖；avatar 的规则按注册路由另验，不能误用地图校验。内容级额外格式校验如改变可接受文件范围，另记录兼容差异。

### F40 `src/utils/storage/index.ts`

源文件：[apps/server/src/utils/storage/index.ts](../../apps/server/src/utils/storage/index.ts)。状态：[ ] 待替代。

- **目标：** `storage/StorageService.java` 和 Spring Bean 依赖注入。
- **实施：** Node barrel export 无需逐行迁移；整理调用边界，让 Controller 不直接依赖 COS 或本地实现，所有上传/删除统一经过策略和补偿流程。
- **验收：** 本地和 COS 可用相同服务契约替换；没有路由绕过文件清理或自行拼对象删除路径。

### F41 `src/utils/storage/local-provider.ts`

源文件：[apps/server/src/utils/storage/local-provider.ts](../../apps/server/src/utils/storage/local-provider.ts)。状态：[ ] 待迁移。

- **目标：** `storage/LocalStorageProvider.java`、公开资源映射配置。
- **实施：** 明确持久化根路径，URL 兼容 PROTOCOL、域名、API_BASE_PREFIX/端口及 `/static/`。临时文件与目标不在同一文件系统时支持复制后安全删除，不能假定 rename 永远可用。
- **删除：** 规范化路径后检查仍在允许目录内；对旧 URL 提取存储相对路径须限定本站来源。缺失文件可幂等处理，真实权限/IO 失败进入重试。
- **验收：** 容器重建后文件仍在；已有 URL、中文/空格文件编码、路径前缀、上传下载和删除可用；仅公开允许的上传目录，日志和暂存不可访问。切换前确认旧 `/app/public` 的实际内容。

### F42 `src/utils/storage/multer-config.ts`

源文件：[apps/server/src/utils/storage/multer-config.ts](../../apps/server/src/utils/storage/multer-config.ts)。状态：[ ] 待重新实现。

- **目标：** `config/MultipartConfig.java`、`storage/MultipartUploadReader.java`、上传校验 Filter/Resolver。
- **实施：** 注册 avatar 2 MiB；创作者单文件限制动态读取用户配置，默认 50 MiB；地图三字段各最多一个。设置总请求上限时考虑多个文件及 multipart 开销，不能把 50 MiB 单文件额度误设成整个请求上限。
- **关键差异：** Spring 默认 multipart 解析可能先于 Controller 发生；先完成 API Key 身份读取，再采用经过验证的延迟/流式解析或全局硬上限加逐文件计数。只在 Controller 中比较 MultipartFile.getSize 并不能限制前置暂存消耗。
- **管理员：** 旧管理员地图上传没有明确单文件上限。新服务应配置可运维的硬上限，并在 P0 根据最大历史文件确认；不得偷偷套用创作者 50 MiB 限制。
- **验收：** 实际流式发送到边界与超限，内存/磁盘占用受控，断连立即清理；413/422 与编辑器解析一致，代理层上限和 Java 上限匹配。

### F43 `src/utils/storage/types.ts`

源文件：[apps/server/src/utils/storage/types.ts](../../apps/server/src/utils/storage/types.ts)。状态：[ ] 待迁移设计。

- **目标：** `storage/StorageProvider.java`、`storage/UploadSource.java`、`storage/StoredObject.java`。
- **实施：** 定义 upload、按输入顺序 uploadMany、幂等 delete；对象结果除公开 URL 外保存 provider/key 和本次上传所有权，供可靠补偿使用；内部路径不放进外部 DTO。
- **验收：** 两实现通过同一套契约；部分成功可识别具体对象，不依赖 URL 猜测全部上下文。依赖 F36/F41。

## 令牌与构建尾项

### F44 `src/utils/token.ts`

源文件：[apps/server/src/utils/token.ts](../../apps/server/src/utils/token.ts)。状态：[ ] 待迁移并修正时间单位。

- **目标：** `security/JwtService.java`、`security/AccessTokenValidator.java`、`security/RefreshTokenService.java`。
- **实施：** RS256，保留 userId/isAdmin/type claim，access 30 分钟、refresh 7 天；`iat`/`exp` 使用秒，业务 Java 用 Instant。访问接口只接受 access，刷新接口只接受 refresh，并查用户仍存在及最新权限。
- **联动：** 两端统一秒级过期计算，可用有期限的 ms/秒兼容转换帮助滚动发布；裸 Authorization 保持兼容。401 最多刷新一次且并发请求共用刷新结果，避免递归重试。未计划建设完整 refreshToken 会话库或刷新令牌轮换，此类登录增强另评估。
- **验收：** 真正到期拒绝、篡改/错误算法拒绝、错误类型拒绝、角色撤销和删除用户生效；跨 Java 重启验证成功。旧内存密钥不可得时明确重新登录，不承诺无感会话迁移。

### F45 `src/utils/turn-credentials.ts`

源文件：[apps/server/src/utils/turn-credentials.ts](../../apps/server/src/utils/turn-credentials.ts)。状态：[ ] 待迁移。

- **目标：** `room/TurnCredentialService.java`、`room/IceServerResponse.java`。
- **实施：** username 为 `Unix秒到期时间:userId`，credential 为以 TURN_SECRET 作 UTF-8 key 的 HMAC-SHA1 结果标准 Base64；TTL 配置为秒。保持 STUN、TLS TCP TURN、UDP TURN 三种 URL 格式，游客仅返回 STUN。
- **验收：** 固定时钟与测试 secret 的 Node/Java 结果逐字节一致；实际 coturn 接受凭证，过期后拒绝；登录用户与游客返回结构一致于旧契约；日志不打印 credential。

### F46 `tsconfig.json`

源文件：[apps/server/tsconfig.json](../../apps/server/tsconfig.json)。状态：[ ] 待替代。

- **目标：** Maven compiler 配置、Java 包结构、测试编译配置。
- **实施：** TS 路径别名和 ESM 配置不机械对应到 Java；固定 release=21、UTF-8，明确测试/资源目录。TypeScript 检查继续覆盖三个现有前端和新拆出的 PeerServer。
- **验收：** 干净环境可编译，中文错误/文件名无编码变化；迁移期间 Node 旧工程仍能构建和回滚。

### F47 `yarn.lock`

源文件：[apps/server/yarn.lock](../../apps/server/yarn.lock)。状态：[ ] 待退役。

- **目标：** Java 依赖固定在 POM/BOM 与 Wrapper；PeerServer 依赖由现行 pnpm workspace 锁定。
- **实施：** 此文件是历史 Yarn 锁，不作为 Maven 转换输入。先核对根 pnpm-lock 的当前实际依赖；正式切换且回滚观察期结束后再清理旧服务器依赖与此文件。
- **验收：** CI 可复现 Java 和 Peer 构建；清理未导致客户端/编辑器依赖丢失；旧版本镜像与 Git tag 可用于回滚。

## 拟新增文件与原文件之外的交付

| 新文件或文件组 | 目的 | 对应阶段 |
| --- | --- | --- |
| `apps/server-java/pom.xml`、Maven Wrapper、Java 源码/资源/测试 | 新服务实施载体 | P1–P8 |
| `src/test/.../LegacyCryptoCompatibilityTest.java` | AES、密码 HMAC、JWT、TURN 固定向量 | P3/P7 |
| `src/test/.../ApiContractTest.java` 与脱敏 fixtures | 39 个接口的状态/JSON/字段类型 | P0/P3–P8 |
| `src/test/.../MapUploadIntegrationTest.java`、`RoomLeaseConcurrencyTest.java` | 文件补偿、审核事务、房间竞争 | P5–P7 |
| `src/main/resources/db/migration/` | 现库 baseline 之后的显式迁移、辅助清理表、一次性数据修正 | P2/P5 |
| `apps/peer-server/` | 提取最小 PeerServer 运行服务并固定版本 | P7 |
| `docker/Dockerfile.java`、`Dockerfile.peer`、`Dockerfile.admin` | 分离 Java API、信令、静态后台 | P9 |
| `docker/nginx/java-server.conf`、迁移版 Compose | 保留外部 URL、WebSocket 转发、上传上限和持久化卷 | P9 |
| `.github/workflows/server-java-ci.yml` | Java 构建、MySQL 集成测试与镜像检查 | P1/P9 |

外部已有文件的具体配合任务见[接口兼容清单](api-compatibility.md#现有客户端与共享文件任务)和[部署任务](data-and-deployment.md#部署文件任务)。新文件命名可在实现时调整，但原 47 项职责和验收不能遗漏。
