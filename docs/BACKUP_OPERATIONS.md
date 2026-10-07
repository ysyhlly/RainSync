# 每日备份、保留和恢复

目标是恢复点不超过 24 小时、完整应用恢复不超过 60 分钟。
定时器、备份成功或数据库导入成功均不能直接证明已经达到目标。
当前候选仍需真实库、密钥、设备和空缓存的完整恢复演练及计时报告。

## 安装前提与保管

使用 Linux、Python 3.11+、Node.js 24、systemd，以及匹配数据库的 PostgreSQL 17
客户端 `psql`/`pg_dump`/`pg_restore`/`createdb`。备份读取当前库；恢复只创建新库。
客户端通过预先授权的 loopback 连接访问 PostgreSQL；不把 URI 或密码写入命令行。
默认 Compose 不开放数据库宿主端口。如采用宿主备份客户端，安装负责人可在维护窗口
审查并选择 `deploy/backup-access.override.yaml`，它仅绑定 `127.0.0.1:54329`。
保持原项目名、环境文件和已部署 Compose 顺序，先检查 `config` 再应用；这是单独的实例变更。

数据库密文、应用恢复材料密文、各自的加密密钥至少分开保管。
源解密密钥及版本、实际配置、全部有效 Agent 凭据和已有 drained receipts 写入
私有 `materials.json`，不写入普通日志。每次配对/撤销设备、换源密钥、改配置后
更新这份输入；备份工具使用与 Server 启动相同的固定加密字段清单，
验证源、平台账号/OAuth/刷新凭据、仍有效的待处理扫码材料及所有有效设备凭据，
缺失、错误密钥或损坏密文即失败，验证不会记录明文。
材料检查和 `pg_dump --snapshot` 使用同一个持续持有的只读 PostgreSQL 快照，
分页查询也导入该快照；配对/撤销发生在快照之后不会产生跨时刻的数据库/材料组合。
快照建立前已提交的配对/撤销仍要求输入完全匹配，否则不创建完整集合。
manifest 的 `snapshot_started_at` 是恢复点起点，不能用加密完成时间替代。
客户端会话必须能保持快照至 dump 完成；失去快照或数据库检查失败时不记成功。
控制集群 peer token 等独立秘密按各自保管政策另存。
原媒体不在数据库/材料备份中；材料里必须说明其备份介质、恢复路径或可再生成策略。

`deploy/recovery-set.mjs` 的输入形状如下；占位符必须在私有文件中替换：

```json
{
  "schema_version": 1,
  "configuration": {"PUBLIC_ORIGIN":"https://your-origin.example","MEDIA_ROOT":"/media"},
  "source_key_version":"your-installed-key-version",
  "source_key":"REPLACE_WITH_CURRENT_BASE64_32_BYTE_SOURCE_KEY",
  "original_media_policy":"Describe original media backup custody and restore paths",
  "agents": []
}
```

`agents: []` 只适用于确实没有有效设备的库；否则每条包含 `id`、
`credential`（现存凭据 JSON）及 `drained_receipts`（现存 UUID 数组）。
不要自动重新配对或复活已经撤销的设备来满足检查。

## 人工安装每日任务

下面是供安装负责人审查后执行的示例。仓库不会自动创建账号、安装 timer、
改数据库端口或调整正在运行的服务。路径变更时同步修改 unit 和私有环境文件。

```sh
sudo useradd --system --home-dir /var/lib/rainsync-backup --shell /usr/sbin/nologin rainsync-backup
sudo install -d -m 0700 -o rainsync-backup -g rainsync-backup /srv/rainsync-backup/database /srv/rainsync-backup/materials /var/lib/rainsync-backup /etc/rainsync/backup-secrets
sudo install -m 0600 -o rainsync-backup -g rainsync-backup deploy/backup.env.example /etc/rainsync/backup.env
```

在负责人私有编辑器中设置 `backup.env` 的实际 loopback `DATABASE_URL`、
精确已安装源码 SHA、三个非嵌套目录、两个不同的原始 32 字节 key 文件路径
和材料 JSON 路径。源 key 与两把备份 key 不是同一种密钥。
两个备份 key 在私有目录中新建且长期保存，不在每次任务前重新生成：

```sh
sudo -u rainsync-backup python3 - <<'PY'
from pathlib import Path
import os
os.umask(0o077)
for name in ('database.key', 'material.key'):
    with (Path('/etc/rainsync/backup-secrets') / name).open('xb') as output:
        output.write(os.urandom(32))
PY
```

准备好 `materials.json` 后确认它和两个 key、环境文件均为 scheduler 用户所有、
权限 0600，目录权限 0700。模板的 `ProtectSystem=strict` 只允许三个备份目录写入，
原库、媒体、源码与 secrets 不需要向该任务开放写入权限。

```sh
sudo install -m 0644 deploy/backup-daily.service deploy/backup-daily.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/backup-daily.service /etc/systemd/system/backup-daily.timer
sudo systemctl daemon-reload
sudo systemctl start backup-daily.service
sudo systemctl status backup-daily.service
sudo systemctl enable --now backup-daily.timer
systemctl list-timers backup-daily.timer
```

每天 02:00 UTC（北京时间 10:00）执行；`Persistent=true` 在关机错过时间后补一次。
并发锁禁止备份与保留同时执行；任务超时/失败不创建完整成功 receipt，也不触发保留删除。
备份输出到两个独立目录下相同时间/UUID 名称的子目录，成功 receipt 写入 state 目录，
不记录 URI、密钥或材料内容。失败留下的未完成目录不会自动清理，应先检查原因。
先完成一次成功任务再启用 timer，随后接入现有监控的失败告警和超过 24 小时无成功备份告警。

## 保留、异地副本与状态

默认本机保留 14 天完整备份，且始终保留最近两份成功集合。
每份成功数据库/材料密文与 manifest 应复制到独立故障域，key 经不同渠道保管。
建议异地每周至少一份保留 8 周、每月一份保留 12 个月；按实例容量与法规调整，
异地介质的保留由该介质负责。先核对副本摘要和可用性，再应用本地保留。
定时任务不执行异地上传或自动删除。

不在 shell 中 `source` 私有环境文件。以下临时 systemd 任务继承私有文件，
命令行仅含路径，不含数据库 URI：

```sh
sudo systemd-run --wait --collect --uid=rainsync-backup --property=EnvironmentFile=/etc/rainsync/backup.env --property=UMask=0077 /usr/bin/python3 /opt/rainsync/source/deploy/backup-schedule.py status
sudo systemd-run --wait --collect --uid=rainsync-backup --property=EnvironmentFile=/etc/rainsync/backup.env --property=UMask=0077 /usr/bin/python3 /opt/rainsync/source/deploy/backup-schedule.py prune
```

`status` 超过 24 小时返回非零；`prune` 默认只列候选。
确认异地副本后，对同一命令加 `prune --apply` 才删除。
驱动仅删除自己完整 receipt 绑定的、摘要匹配且无链接/额外文件的四个固定文件及空目录；
不递归清理未知目录、失败集合或其他备份。
这些命令会核对 archive SHA-256，耗时与保留数据量相关；不应高频轮询。

## 恢复与验收

停止向隔离验证环境写入；在 loopback 独立 PostgreSQL 的维护数据库 `postgres` 上，
使用私有临时环境文件提供 `DATABASE_URL`、`RAINSYNC_BACKUP_KEY_FILE`、
`RAINSYNC_MATERIAL_KEY_FILE`。它不能指向生产应用库。
选择同名且 manifest 配对的数据库/材料目录，输出目录必须不存在：

```sh
node deploy/recovery-set.mjs restore --database=/private/selected-database-set --materials=/private/selected-material-set --output=/private/new-recovery-output
```

该命令要在继承上述私有环境的终端或临时 unit 中运行，不能把 URI 拼到参数里。
它先验证摘要和密文，再创建随机新库、空缓存、独立配置与设备材料；
不覆盖现有库/缓存/凭据。对冻结候选执行迁移校验与隔离升级，再启动恢复实例。
逐项验证登录、私人源解密与授权、真实播放/seek/停止、Agent 重新连接和撤销状态。
用错误备份 key 验证失败且未创建数据库；用错误源 key 验证明确报错而非显示空媒体库。

记录事故时刻、备份快照起点、密文/制品/源码摘要、恢复开始和结束、数据库大小、
媒体恢复策略及每项应用结果。RPO 采用最后有效快照起点至事故时刻，
RTO 采用开始恢复至完整应用验证结束；要求分别 ≤24h、≤60min。
只有这一真实演练通过才能关闭恢复门槛。保留失败集合及报告，
需要清理随机恢复库时由负责人按其明确名称另行处理，工具不自动删除。
