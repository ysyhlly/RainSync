# 开发贡献指南

开发环境：Rust stable、Node.js 24、Docker Compose。媒体处理需要 FFmpeg/ffprobe，正式运行以 Linux 容器为目标。

提交前运行：

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo run -p protocol --example export
npm ci
npm test
npm run build
```

涉及协议、认证或数据库时，执行 `cargo build --workspace --locked` 和 `node tests/integration.mjs`。涉及浏览器时，执行 `npx playwright install chromium` 和 `npm run test:e2e`。

`tests/deployed-smoke.mjs`、远程媒体及 Jellyfin/Emby 验证脚本会修改测试实例的数据，只能针对独立开发实例运行；配置和前置条件见 [运维文档](docs/OPERATIONS.md)。

不要提交 `.env`、Agent 凭据、媒体、数据库备份、日志或签名播放地址。修改共享协议后同时提交生成的 TypeScript/Schema。测试报告应写明样本、环境及未验证范围，不把模拟或短期结果描述为正式验收。

交付或运维变更执行 `python3 tests/runtime-images.test.py`、
`python3 tests/backup-schedule.test.py` 和对应 Node 契约检查。
涉及启用模板或兼容边界时同步更新 [兼容矩阵](docs/COMPATIBILITY.md)、
[启用/回退](docs/ADVANCED_FEATURES.md)、[当前决策](docs/DECISIONS.md) 与
[变更记录](CHANGELOG.md)。文档链接须在源码分发中可读，审计报告缺失时说明范围，
不要把说明文件重新包装成已通过报告。漏洞按 [安全报告](SECURITY.md) 私密反馈。
