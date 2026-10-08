# 双架构运行制品

`.github/workflows/runtime-images.yml` 在受限部署分支构建三个运行镜像，分别使用
amd64 的 `ubuntu-24.04` 和 arm64 的 `ubuntu-24.04-arm` 原生 runner。
runner 标签依据 [GitHub 官方 runner 列表](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)。
每个包独立包含 `runtime-images.tar.gz`、`manifest.json`、`SHA256SUMS`；不推送注册表，
不部署服务。arm64 标签带 `-arm64` 后缀，可与原 amd64 标签共存。

新包 schema 2 记录精确源码 SHA、Git tree、Cargo/npm 锁文件和 Dockerfile SHA-256，
并把这份绑定摘要写入后台/Web 镜像标签。打包前要求干净的精确 checkout，
打包后核对镜像配置/物理层/来源标签；实际运行离线 Server/Worker 契约、
FFmpeg 编码/解码/探测和 Web 配置检查，记录 FFmpeg 包版本及完整版本输出摘要。
验证仍接受原 amd64 schema 1，不替旧包虚构新增构建证明。

日常 Dockerfile 的基础标签和 apt 索引仍会变化，schema 2 的
`build_kind: development-measured` / `runtime_acceptance: false` 明确保留这个限制。
它记录实际构建身份，不提供固定上游输入的可重建正式发布承诺。

在干净的候选 checkout、对应架构的本地 Docker daemon 上，可复现工作流：

```sh
EXPECTED_SOURCE_SHA=$(git rev-parse HEAD)
PLATFORM=linux/arm64
TAG_SUFFIX=-arm64
SOURCE_BINDING_FILE=/absolute/private-output/source-binding.json
ARTIFACT_DIRECTORY=/absolute/private-output/new-arm64-bundle
python3 deploy/runtime-images.py source --source "$EXPECTED_SOURCE_SHA" > "$SOURCE_BINDING_FILE"
SOURCE_BINDING_SHA=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["label_sha256"])' "$SOURCE_BINDING_FILE")
docker build --platform "$PLATFORM" --pull --label "org.opencontainers.image.revision=$EXPECTED_SOURCE_SHA" --label "org.rainsync.runtime-source-binding=$SOURCE_BINDING_SHA" -f deploy/Dockerfile -t "rainsync-backend:$EXPECTED_SOURCE_SHA$TAG_SUFFIX" .
docker build --platform "$PLATFORM" --pull --label "org.opencontainers.image.revision=$EXPECTED_SOURCE_SHA" --label "org.rainsync.runtime-source-binding=$SOURCE_BINDING_SHA" -f deploy/Dockerfile.web -t "rainsync-web:$EXPECTED_SOURCE_SHA$TAG_SUFFIX" .
docker pull --platform "$PLATFORM" postgres:17
docker tag postgres:17 "rainsync-postgres:17-$EXPECTED_SOURCE_SHA$TAG_SUFFIX"
python3 deploy/runtime-images.py package --source "$EXPECTED_SOURCE_SHA" --platform "$PLATFORM" --directory "$ARTIFACT_DIRECTORY"
python3 deploy/runtime-images.py verify --source "$EXPECTED_SOURCE_SHA" --platform "$PLATFORM" --directory "$ARTIFACT_DIRECTORY"
```

amd64 使用 `PLATFORM=linux/amd64`、`TAG_SUFFIX=`；原验证命令不加 `--platform` 仍默认 amd64。
校验成功后由安装负责人手动 `docker load`，追加验证 `--daemon` 测量已加载镜像；
`verify` 本身不加载、拉取、启动服务或读密钥。安装顺序见 [运维](OPERATIONS.md)。

正式固定构建继续使用 `deploy/release-lock.mjs` 和 `.release` Dockerfile。
锁必须提供两种架构下实际测得的 rust/debian/node/caddy/postgres digest，
真实 Debian snapshot、精确 FFmpeg/CA 包版本，以及冻结候选完整/生产源码摘要。
这些值不能从示例拼造。从选定候选 checkout 生成冻结目录：

```sh
node scripts/validation-candidate.mjs --id=your-final-candidate
node scripts/validation-candidate.mjs --verify=your-final-candidate
```

输出位于 `.runtime/validation-candidates/your-final-candidate/`，包含
`candidate.json` 和 sibling `source/`。从其中的实际 manifest 摘要填写锁，
保持冻结目录不变；在各架构用 `docker pull --platform linux/arm64` 拉取锁中的
精确 digest（amd64 对应更改 platform），然后从该 `source/` 目录执行：

```sh
node deploy/release-lock.mjs verify-inputs --lock=/private/release-lock.json --arch=arm64
node deploy/release-lock.mjs build --lock=/private/release-lock.json --arch=arm64 --target=backend --tag=rainsync-release:arm64 --output=/private/new-backend-build.json
node deploy/release-lock.mjs build --lock=/private/release-lock.json --arch=arm64 --target=web --tag=rainsync-release-web:arm64 --output=/private/new-web-build.json
```

对 amd64 重复同样步骤并保存原始 build binding。后续 `measure` 必须传原始 `--binding`；
单独贴来源标签或重测任意镜像不能补成冻结源码构建证据。
日常 bundle 工具目前仅接受日常源码绑定，不能把固定发布镜像套进 schema 2 的
development 标签后宣称已完成正式发布。两条路线的发布台账必须保留各自的真实证据。
CI 构建成功也不关闭 arm64 真机核心播放、Agent、恢复和最终候选长时验收。
