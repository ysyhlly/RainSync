# 媒体库分层浏览

媒体库默认先显示可访问片源，再逐级显示实际目录。文件与子目录可以共存，面包屑可返回任意父级。每页最多加载 24 项，目录的影片数量是数据库内全部可见后代的数量，不是当前影片页的数量。

- 本地目录和 NAS：使用索引中已存在的片源相对路径；不返回宿主绝对路径
- S3：使用该片源中已索引对象键的目录层级
- Jellyfin / Emby：新扫描保留明确的剧集、季 ID 与名称，按剧集和季分层。旧索引此前只保留封面元数据，需重新扫描才能获得上游剧集层级；缺少季信息时影片直接位于剧集下
- HTTP 或缺少分层信息的上游影片：直接位于片源下。不会依据文件名猜测电视剧、季或集
- 空目录没有已索引影片，因此不会显示

标题搜索仍通过原有 `/media` 接口跨全部可访问片源和目录进行；清除搜索会回到先前目录。播放、待播、重命名、预览继续使用同一媒体 ID 和原有授权流程。

## API

`GET /api/v1/media/browse?node=...&library_id=...&after=...&limit=24`

`node` 缺省表示片源根目录；`library_id` 可将结果限制在一个有浏览权限的媒体库；`after` 为上一页返回的游标。`limit` 限制为 1–100。

响应包含 `entries`、`breadcrumbs`、`node`、`next_cursor`、`total_media`。目录项类型为 `source` 或 `folder`，含 `id`、`name`、`media_count`；影片项类型为 `media`，含原有 `Media` 数据。目录 ID 是版本化的不透明导航令牌，仅含片源 UUID 与已规范化相对组件，不含片源配置、URL、凭据或宿主路径。令牌本身不授予权限。

每次请求在同一个只读数据库快照内计算数量、子目录和当前页影片。权限在聚合前过滤；私有媒体库、撤销 NAS、删除片源和失效授权均不能通过数量或令牌枚举。游标绑定媒体库与目录，按稳定目录键和媒体 UUID 排序。扫描后目录内容可自然变化；游标不承诺冻结整个浏览会话。

迁移 0085 为既有相对路径生成浏览字段，并为后续扫描、NAS 索引和元数据变更建立触发器。源内查询和目录组件有索引；前端不会加载全部目录的影片来重建树。运行时依赖 0086 的删除标记。

## 验证

- `npm test -- tests/library-hierarchy.test.ts tests/library-search-snapshot.test.ts`
- `node tests/media-hierarchy-migration.mjs`：全新隔离 PostgreSQL 的升级、路径规范化、权限聚合与分页
- `node tests/media-hierarchy-native.mjs`：最终 Server 的真实 HTTP/SQL、私有权限、游标绑定、重命名和删除标记
- `npx playwright test tests/browser/media-hierarchy.spec.ts`：真实 Vue + 桌面/移动端浏览器，合成 API 夹具

集成测试需要已有隔离环境配置和已构建 Server，不接受生产数据库地址。
