# huaji OJ 腾讯云部署手册

本文记录 huaji OJ 当前已验证版本的生产部署方案。部署分支为 `huaji-oj`，`main` 用于跟踪 OI33 上游。

## 1. 推荐配置

- 腾讯云 CVM，x86_64，Debian 12。
- 4 核 4 GB 内存、至少 60 GB 系统盘，适合约 30 人同时使用。
- Hydro 使用单进程模式；同一台机器运行 HydroJudge，并将判题并发设为 2。
- 当前已验证版本：Node.js 24.18.0、Hydro 5.0.4、UI Default 4.58.4、HydroJudge 4.0.5、Sandbox 1.12.1。

不要直接升级 Hydro 或 UI。OI33 会扩展 Hydro 的内部页面和运行逻辑，升级前应先在测试机验证。

## 2. 上线前准备

腾讯云安全组只开放：

- TCP 80：HTTP，用于跳转 HTTPS 和签发证书。
- TCP 443：HTTPS。
- TCP 22：SSH，仅允许管理员固定公网 IP 访问。

不要向公网开放 8888、5050、27017、2019 等内部端口。

如果服务器位于中国大陆，域名需要完成腾讯云接入备案。服务器在中国香港或境外时，不需要中国大陆 ICP 接入备案。

## 3. 安装 Hydro

在全新的 Debian 12 服务器上，以具备 sudo 权限的账号执行 Hydro 官方安装脚本：

```bash
LANG=zh . <(curl https://hydro.ac/setup.sh)
```

安装完成后确认 Hydro、HydroJudge、MongoDB、PM2 和 Caddy 均正常运行。生产环境保持 Hydro 单进程，不使用 `pm2 -i` 启动多个实例。

## 4. 安装 huaji OJ 插件

建议将代码放在固定目录：

```bash
sudo mkdir -p /opt/huaji-oj
sudo chown "$USER":"$USER" /opt/huaji-oj
git clone --branch huaji-oj https://github.com/252259947/OI33.git /opt/huaji-oj/OI33
cd /opt/huaji-oj/OI33
yarn install --production
hydrooj addon add /opt/huaji-oj/OI33
pm2 restart hydrooj
```

安装后用 `pm2 status` 和 Hydro 日志确认插件启动成功。后续更新代码时在该目录拉取 `huaji-oj` 分支，安装依赖并重启 Hydro。

## 5. 迁移本地数据

本地数据包含账号、题库、提交记录、文件和 LLM API Key，备份文件必须加密传输，不得加入 Git 仓库。

在本地 WSL 的仓库目录之外执行：

```bash
mkdir -p ~/hydro-backups
cd ~/hydro-backups
hydrooj backup
```

确认备份文件大小正常后，将其通过 SSH 加密通道传到服务器，再在服务器上执行：

```bash
hydrooj restore /path/to/backup.archive.gz
pm2 restart hydrooj
```

迁移前先给云端空站做一次备份。不要在 MongoDB 运行时直接复制 `/data/db`。

## 6. 域名与 HTTPS

在阿里云 DNS 为 `huaji035.cn` 添加：

- 记录类型：A
- 主机记录：`oj`
- 记录值：腾讯云服务器公网 IPv4

Caddy 只代理本机 Hydro 端口，配置目标为 `127.0.0.1:8888`。域名解析生效且 80/443 已放行后，由 Caddy 自动申请 HTTPS 证书。最终在 Hydro 系统设置中将站点地址设为：

```text
https://oj.huaji035.cn/
```

## 7. 上线验收

- 首页、题库、训练、比赛、讨论和管理后台均可打开。
- 注册、登录、退出和学生账号权限正常。
- C++14、C++14 O2、C++20、C++20 O2 均能编译并判题。
- 自测、递交测评、提交记录和编辑器主题保存正常。
- LLM 分析功能可用，且密钥没有出现在网页源码、日志或 GitHub 中。
- 仅 80/443 对公网开放，内部端口无法从公网访问。
- `https://oj.huaji035.cn/` 证书有效，HTTP 会跳转到 HTTPS。

## 8. 回滚

每次更新前创建完整 Hydro 备份，并记录当前 Git 提交号。若更新异常，切回上一个已验证提交、重新安装生产依赖并重启 Hydro；涉及数据结构变更时，再恢复更新前的完整备份。
