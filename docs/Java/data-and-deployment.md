# Java 数据部署与切换任务

> 本文为旧库保留迁移的历史方案。当前已确认全新注册、区服和地图，新增 `monopoly_mine_` 表，不导入旧数据；旧库 baseline、旧文件搬迁及依赖同一五表的回滚方式不再适用。实施与发布以 [GameBackend monopoly 模块迁移升级方案](gamebackend-monopoly-upgrade-plan.md)为准，旧资料仅作历史系统运维参考。

本方案以单实例 Java 业务 API、独立 Node PeerServer、原 coturn、原 MySQL 和原文件 URL 为基础。Unity、权威对局和集群高可用均不在此次迁移范围。全部任务尚待实施，生产数据结构和实际部署值必须在 P0 核对，不能由开发机配置推定。

## 数据表迁移

源码中的 TypeORM 实体提供字段意图，真实数据库 DDL 才是存量迁移依据。以下 snake_case 表名是默认命名下的预期，须用实库 `SHOW CREATE TABLE` 和索引清单确认后固定 SQL。

| 实体与预期表 | 保留内容 | 迁移任务与校验 |
| --- | --- | --- |
| User / `user` | UUID、账号、昵称、旧 password/salt、角色、头像、颜色、在线时间、创作者限制与计数 | 源码 id+useraccount 复合主键；确认账号是否有单列唯一索引和重复数据。保留 create_time/last_active_time、nullable 限制，不以 Java 基本类型默认 0 覆盖 null |
| GameMap / `game_map` | 正式/候选/源地图 URL、hash、封面、作者、创作者、审核状态、整数发布版本和字符串内容版本、changelog | creatorId 外键 SET NULL，状态/创作者索引、JSON null/数组；不误发 pending 文件，不丢弃下架地图 |
| GameRecord / `game_record` | UUID、房间名、毫秒 duration、mapId/mapName、create_time/update_time | 源码 id+name 复合主键；名称非全局唯一；保持原过期记录口径和整数范围，旧数据不转换成秒 |
| MapKey / `map_key` | 原明文 Key、userId、吊销和创建/更新时间 | Key 和 userId 唯一；用户级联删除；旧编辑器 Key 不批量重发 |
| AdminAuditLog / `admin_audit_log` | 管理员/目标用户、action、detail、createdAt | 不随用户删除级联清除；原 action 值保留；不把 detail 当可公开日志 |

采用显式 JDBC 映射，Java Row 与外部 DTO 分离。Spring Boot 的数据库初始化支持 Flyway，但必须明确由一种机制管理结构，不能混用自动建表和版本化迁移。[Spring Boot 数据初始化](https://docs.spring.io/spring-boot/how-to/data-initialization.html)

### 数据任务清单

- [ ] DB01 导出脱敏 DDL、索引、外键、字符集、collation、MySQL 版本/SQL mode/时区；记录五表行数、状态分布、重复账号、孤立 creatorId 和 Key。
- [ ] DB02 明确现网实际库。源码连接器固定 `monopoly`，即使 env 配了另一个 MYSQL_DATABASE，也不能认为旧服务一直使用它。
- [ ] DB03 为现库设计受控 Flyway baseline：先校验 DDL 再建立版本历史；不默认对任何非空库自动 baseline。空库使用从确认结构生成的初始建表迁移。
- [ ] DB04 禁用所有自动 schema update/create。保留旧主键和 ID，不借语言迁移同时重构表设计。
- [ ] DB05 将 `publishExistingInUseMaps`、`migrateCreatorFlags` 改为一次性且有明确筛选条件的数据迁移。现库若已完成则跳过，不根据宽泛条件再次发布已拒绝/下架地图或重新开启创作者。
- [ ] DB06 定义事务：用户与 Key/地图解绑、Key 与审计、地图审核与 changelog/原因必须原子；外部存储删除放提交后并可重试。
- [ ] DB07 固定数据库和业务时间转换。统计今日/7 日、上传计数日界线、审计时间序列化在相同测试数据上验证；生产时区由实际运维配置决定。
- [ ] DB08 在克隆库对比 Node/Java 查询结果，验证新增/修改后旧版本仍能读取；回滚依赖向后兼容的数据格式。

### 本轮拟新增的清理任务表

为上传失败补偿和提交后旧文件清理增加 `storage_cleanup_task`（最终表名实施时定稿）。这是可靠文件管理的辅助表，不改变原五张业务表的 ID 或关系，工作量计入 P5。

建议字段：id、operationId、provider、objectKey、关联业务/上传标识、清理原因、status、attempts、nextAttemptAt、lastError、createdAt/updatedAt。对象 key 与原因组成适当幂等标识；错误内容必须脱敏。

- [ ] 上传前产生 operationId 与可恢复的对象计划；每个成功上传的对象可追踪。进程在上传成功、DB 提交前崩溃时，后续扫描能根据业务引用判断是否需要清理。
- [ ] 地图事务提交时同事务登记“旧文件待删”任务；回滚时旧文件仍保留，新增文件进入补偿。
- [ ] 清理任务重复执行安全，失败退避并告警；同 URL 被多记录引用或操作状态未确定时不自动删除。
- [ ] 回滚到 Node 后暂停 Java 清理 worker，先核对待办对象是否被 Node 新操作引用，再继续清理；不能让旧 worker 无条件删除正在使用的对象。

普通数据库事务不能撤回一次已经成功的 COS 上传。允许短暂孤儿文件、保证可恢复清理，比“任何失败立刻删掉所有相关文件”的实现更适合保留当前已发布资源。

### 可选的房间目录持久化

**此项不含在基础 24–38 人日中，另估 2–4 人日。** 若希望 API 进程重启后仍可验证旧房主租约，建议增加 `room_registry`，而不是继续无校验地相信不存在房间的 reclaim 请求。

| 子任务 | 具体方案 |
| --- | --- |
| 持久化字段 | roomId、独立 sessionId、hostId/hostName/hostPeerId、lease token hash、hostEpoch、status、isPrivate/isStarted、mapId/mapName、createTime/deleteTime/lastHeartTime/statusUpdatedAt、recordWritten |
| 校验和并发 | 只回传新签发明文租约，库内保存哈希；状态改变使用事务/版本条件，过期记录与 recordWritten 在同事务写入 |
| 重启恢复 | 按真实时间重算 active/grace/expired，不统一重置 TTL；保留关闭 tombstone 到期，禁止关闭房间被旧请求复活 |
| 心跳写入 | 评估每 5 秒每房一次写入的 DB 负载；若合并写，明确崩溃时可丢失的时间窗口与恢复语义 |
| 未知记录 | 无有效持久化记录仍拒绝 reclaim；不能凭 hostId/昵称重建身份；过期保留期之外由用户新建会话 |
| 验收 | Java 重启、DB 故障、重复扫描、旧 token 重放、房间 ID 重用、不重复写历史记录 |

持久化的是房间发现和租约，不是棋盘、资产、回合、脚本和玩家选择。该可选方案也不满足未来 Unity “手机房主退出后服务器继续运行对局”的完整需求。

## 配置兼容表

原键名可以在迁移期保留为环境变量，再映射到 Java `@ConfigurationProperties`。不要让前端构建读取整套生产后端环境。

| 原配置/配置组 | Java 或拆分服务的归属 | 处理要求 |
| --- | --- | --- |
| SERVER_PORT | Java API | 内外端口区分清楚；保持现有反代目的地址或一次性调整路由 |
| ICE_SERVER_PORT、ICE_BASE_PREFIX | 独立 PeerServer/反代 | 保留 PeerJS 所用 host/port/path，不改成业务 WebSocket 路由 |
| MONOPOLY_ADMIN_PORT、ADMIN_BASE_PREFIX | 后台静态服务/反代 | 保留后台深链接、env.js 与 API 基础地址 |
| PROTOCOL、MONOPOLY_DOMAIN、API_BASE_PREFIX | URL 生成与前端公开配置 | 本地文件 URL 按前缀模式或端口模式生成，避免双前缀/漏端口 |
| MYSQL_HOST/PORT/USERNAME/PASSWORD/DATABASE | Java 数据源 | 库名按现网核对；连接字符串和密码不进入浏览器或日志 |
| MYSQL_POOL_SIZE、MYSQL_ACQUIRE_TIMEOUT | Hikari 配置 | 初始参考 20 与 30000 ms，连接建立超时另设；压测后调整 |
| TURN_SECRET、TURN_TTL、TURN_URL、TURN_PORT、STUN_PORT | Java 凭证生成与 coturn | TTL 为秒、端口数值；共享 secret 一致；基础迁移不轮换密钥 |
| COTURN_METRICS_URL | Java 指标服务 | 默认服务名/9641 端口需实际可达；请求总超时 5 秒 |
| TC_ID、TC_KEY、TC_BUCKET_NAME、TC_REGION、COS_TIMEOUT | Java COS provider | 全部必需项齐全；超时单位 ms；部分配置应失败而不是静默本地回落 |
| AVATAR_STORAGE_PATH、GAME_MAP_STORAGE_PATH | 存储相对路径 | 示例文件之间默认路径可能不同，使用现网实际值；规范化后必须落在允许根目录 |
| MAP_ENCRYPT_KEY | 既有地图客户端/后台/构建流程所需 | 保持现有地图兼容，不当作登录 AES 密钥；只按当前明确需求注入公开配置，不扩大到全部 env |
| NODE_ENV | 原 Node/前端/Peer 服务 | Java 映射为显式 profile；不把 production 字符串直接当 Spring profile 的完整配置方案 |
| 拟新增 JWT_PRIVATE_KEY_PATH/PUBLIC_KEY_PATH | Java 签名密钥 | 持久化只读挂载，严格区分测试和生产，不进 Git/镜像；命名可调整 |
| 拟新增 LOGIN_ENCRYPTION_KEY、STORAGE_ROOT、UPLOAD_TEMP_DIR、APP_TIME_ZONE | Java 登录、存储、日期 | 登录 key 与 MAP_ENCRYPT_KEY 分离；暂存/日志在公开目录外；时区显式配置 |
| 拟新增上传总量/管理员单文件上限、清理重试参数 | Java 与反向代理 | 基于历史文件大小和实际负载设置；先确认对现有最大上传的兼容性 |

固定签名密钥提高的是跨 Java 重启的会话连续性，不能自动恢复旧 Node 内存 RSA 私钥。首次切换采用重新登录策略，并刷新浏览器缓存的登录加密密钥。

## 部署文件任务

| 已有文件 | 升级任务 | 验收 |
| --- | --- | --- |
| [docker/Dockerfile](../../docker/Dockerfile) | 迁移期保留旧镜像构建；新增 Java 构建/JRE runtime、最小 PeerServer runtime、独立后台静态镜像 | 镜像固定版本、非必要源码/密钥不进入 runtime；旧镜像仍可回滚 |
| [docker/docker-compose.yml](../../docker/docker-compose.yml) | 用迁移版 Compose 先并行验证，最终拆为 API/peer/admin；保留 MySQL 网络、coturn 可达性和端口映射 | 同机 staging 使用隔离端口/数据，正式切换只切路由，不同时启动两个正式写入方 |
| [docker/coturn/docker-compose.yml](../../docker/coturn/docker-compose.yml) | 继续独立部署，核对与主 Compose 是否为同一实例，避免重复启动抢端口 | Java 生成的凭证被当前实际实例接受 |
| [docker/coturn/turnserver.conf](../../docker/coturn/turnserver.conf) | 核对域名、external IP、TLS 证书、共享 secret 和指标配置；不重写为 Java | 外部网络实际完成 TURN 中继；证书和端口正常 |
| [.env.example](../../.env.example)、[docker/.env.example](../../docker/.env.example) | 增加 Java 密钥路径、存储根、业务时区、上传边界；保留原公开参数映射，去掉复制生产密钥的做法 | 两份示例与文档一致；按示例可启动隔离环境 |
| [package.json](../../package.json) | 新增 dev/build/test Java 和 PeerServer 的便利命令，保留旧 dev-server/build-server 直到切换完成 | 前端开发工作流继续可用；命令明确选择 Node 或 Java |
| [pnpm-workspace.yaml](../../pnpm-workspace.yaml)、[pnpm-lock.yaml](../../pnpm-lock.yaml) | 纳入新 peer 包；Java 用 Maven，不为其伪造 npm 服务依赖；最后再清理旧 server 依赖 | 三端与 peer 可冻结锁文件安装，Java 可独立构建 |
| [packages/env/src/vite-plugin-env.ts](../../packages/env/src/vite-plugin-env.ts) | 审查注入白名单，将 Java 后端 secrets 与前端 build env 分离；保留真正使用的地图配置 | 构建产物/env.js 无 DB 密码、私钥、TURN/COS secret |
| [.github/workflows/release.yml](../../.github/workflows/release.yml) | 保持既有客户端/编辑器发布；新增专用 server-java-ci 工作流 | Java verify、MySQL 集成验证和镜像检查独立触发，不破坏前端 tag 发布 |
| [README.md](../../README.md)、[apps/server/README.md](../../apps/server/README.md) | 实施完成后更新服务职责、端口与运行方式，链接本任务记录 | 不再把 PeerServer、后台静态端口都描述为 Java 进程的一部分 |

建议新增的 Nginx 配置要覆盖 API 前缀改写、上传大小与超时、Peer WebSocket Upgrade、后台 SPA 回退和旧静态 URL。先核对现网反向代理；仓库没有对应配置文件不意味着线上没有代理，不能直接替换未知规则。

coturn 保持专用服务；其 TURN REST 凭证使用共享密钥 HMAC 机制，Java 可兼容计算，不需要改造媒体/数据中继实现。[coturn 官方项目](https://github.com/coturn/coturn)

## 当前文件卷问题及搬迁任务

源码路径是相对 `./public`。现 Dockerfile 的 runtime `WORKDIR` 为 `/app`，因此通常写到 **`/app/public`**；Compose 却将 `server-public` 挂到 **`/app/apps/server/public`**。这是仓库配置层面的路径不一致，实际生产是否另有挂载或工作目录仍需现场核对。

- [ ] ST01 检查当前运行容器的 working directory、挂载和文件清单，同时统计 `/app/public`、`/app/apps/server/public` 与命名卷；不要在核对前重建旧容器。
- [ ] ST02 备份实际容器写层中的上传文件及已有卷，记录相对路径、大小、hash 和总数；确认备份可恢复，不能只备份一个可能为空的 volume。
- [ ] ST03 对照数据库全部 coverUrl/mapUrl/sourceUrl/pendingUrl/pendingSourceUrl/avatar，区分本地/COS/其他历史地址，生成缺失与重复引用清单。
- [ ] ST04 新持久化根按实际业务目录迁移；日志和 temp 分开放置；对于历史 URL 中已有目录前缀，保留映射而非要求批量修改数据库。
- [ ] ST05 停止上传写入后做最终增量同步并复核 hash；挂新卷后只验证，不立即删除旧容器/卷和备份。
- [ ] ST06 用旧 URL 下载头像、正式地图、候选地图/源文件所需资源；确认日志、暂存目录和私钥不可通过公开 URL 获取。

旧地图资源本轮按字节搬迁，不解密重加密，不修改脚本，不转 Unity 资源格式。

## 发布与回滚顺序

### 发布前

1. 完成接口夹具、真实 DDL、文件盘点与备份恢复演练；锁定 C01–C08 和 D2/D3 的最终选择。
2. Java 在隔离的数据库克隆和文件空间验证；写操作不能对生产做“双写比对”，审核、删除、reset Key 尤其禁止影子执行。
3. 部署向后兼容的前端适配。过渡期 JWT exp 同时识别两种单位；新增租约字段旧 Node 会忽略，但前端必须能获得当前租约；错误处理兼容新 410。
4. 单独验证 PeerServer 的协议和反代。原 PeerServer 与 API 在同一 Node 进程，停止旧进程也会终止信令连接，因此本轮发布包含维护窗口，不能宣称零中断。
5. 建立停止开房/停止上传的维护入口或运维开关，排空活跃房间；不能只停止接受 HTTP 请求而任由新 Peer 连接继续创建业务会话。

### 正式切换

1. 开启维护，确认房间排空与上传完成，暂停会写数据的管理操作；记录数据库与文件备份点。
2. 关闭旧 API 的写入方与定时任务；完成文件最终同步和已审核的 Flyway 迁移，保留旧镜像、配置、文件备份。
3. 启动固定密钥的 Java、独立 PeerServer 和后台静态服务；检查 readiness、路由、文件可读与内部指标。
4. 切换原公开域名/端口的反代目的地。用户重新登录，浏览器重新取得登录加密密钥；后台也执行同样检查。
5. 先验收登录、Key 投稿/审核、旧地图下载、两端联机与 TURN，再恢复开房和上传。
6. 观察一个预先确定的发布窗口，重点看 401/403、5xx、上传失败、清理积压、房间租约冲突和 DB 连接池。记录是否达到回滚条件。

### 回滚

出现大量无法登录、地图不可读、稳定的联机失败、数据不一致或不可控制的清理错误时，按实际阈值回滚；阈值在 P9 演练时基于现网基线确定。

1. 重新维护、停开新房/暂停上传和 Java 写入，排空或明确中止新产生的房间；保存故障日志与新增数据清单。
2. 暂停 Java 清理任务，核对已提交地图与文件，保持向后兼容的业务表。新增辅助表可以保留，不要求为退应用版本立刻删表。
3. 切回保存的 Node 镜像和对应静态/信令配置；注意旧镜像本身包含 PeerServer，不能与独立 Peer 服务同时抢原端口。
4. Node 会再次生成自己的 RSA/AES 密钥，用户再次登录；新版客户端的秒/毫秒兼容及密钥刷新策略要覆盖这条路径。
5. **不直接用切换前全库备份覆盖现库**：那会丢掉切换后合法注册、审核和上传。优先应用回滚；涉及数据损坏时，逐项恢复并对账新增记录和文件。
6. 旧 Node 启动会运行自动结构同步和两项数据修正。发布前须准备可回滚镜像/启动方式，关闭这些重复操作，否则“启动旧镜像”本身可能再次改表或改业务状态。

单实例内存房间基础版不承诺回滚时迁移活跃租约或维持对局发现。已建立的 P2P 数据连接是否继续存在取决于客户端和网络，不作为发布成功的保证。

## 验证与容量任务

| 层次 | 必须完成 | 通过依据 |
| --- | --- | --- |
| 加密/状态单元验证 | AES/HMAC/JWT/TURN、房间时钟边界、地图状态与额度 | 专用测试向量及确定性时钟；断言业务结果而不是照抄实现 |
| HTTP 契约 | 39 个接口、非统一 envelope、公开/用户/管理员/API Key/租约身份 | Node 脱敏样例与 Java 结果比较，差异只来自已登记 C 项 |
| MySQL 集成 | 复合主键、JSON、事务、唯一约束、时区、删除关联 | 兼容版本的真实 MySQL/Testcontainers，不能只用 H2 替代验证 |
| 上传故障 | 超限、断连、部分对象失败、DB 回滚、旧文件删除失败、重启恢复清理 | 正式资源可读、新孤儿可追踪、暂存可回收、积压有告警 |
| 房间并发 | 创建/心跳/关闭/reclaim/扫描竞争及旧租约重放 | 同一房间状态一致，epoch/租约唯一，记录无本进程重复 |
| 三端联调 | 游戏、后台、地图编辑器、独立 PeerServer 与 coturn | 完整业务脚本通过，实际直连和 TURN 路径都验证 |
| 负载验证 | 登录/列表、房间心跳、典型与最大上传、统计查询 | 先采集当前并发和延迟作为目标；观察 P95/P99、CPU/RSS、GC、连接池、临时盘和错误率 |

没有线上并发、文件尺寸分布和测试结果，不能承诺 Java 比 Node 快多少或一台机器能承载多少人。当前业务 API 的资源压力与 Peer/TURN 的数据流量要分别测量；Java API 迁移本身不会消除 TURN 带宽成本。

验收结果、实际工时和最终配置决策回填[任务总览](README.md)，逐文件完成状态回填[迁移清单](file-migration-plan.md)。
